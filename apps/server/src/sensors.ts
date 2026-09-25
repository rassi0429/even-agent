import { randomUUID } from 'node:crypto';
import { WebSocket } from 'ws';
import {
  sensorAckSchema,
  sensorFrameSchema,
  sensorStoppedSchema,
  type Sensor,
  type SensorRequest,
  type SensorCommand,
} from '@even-agent/protocol';

type Result = { status: number; body: Record<string, unknown> };
type Active = {
  streamId: string;
  request: SensorRequest;
  state: 'starting' | 'running';
  expiresAt: number;
  sequence: number;
  timer: ReturnType<typeof setTimeout>;
};
type Pending = {
  command: SensorCommand;
  timer: ReturnType<typeof setTimeout>;
  resolve: (value: Result) => void;
};
type Session = {
  id: string;
  socket: WebSocket;
  supported: boolean;
  available: boolean;
  streams: Map<Sensor, Active>;
  pending: Map<string, Pending>;
  window: number;
  bytes: number;
};

export class SensorHub {
  private sessions = new Map<string, Session>();
  private subscribers = new Set<WebSocket>();
  constructor(private readonly now: () => number) {}
  add(id: string, socket: WebSocket) {
    this.sessions.set(id, {
      id,
      socket,
      supported: false,
      available: false,
      streams: new Map(),
      pending: new Map(),
      window: this.now(),
      bytes: 0,
    });
  }
  available(id: string, available: boolean) {
    const session = this.sessions.get(id);
    if (!session) return;
    session.available = available;
    session.supported ||= available;
    if (!available)
      for (const active of [...session.streams.values()])
        void this.stop(session, { ...active.request, action: 'stop' });
  }
  remove(id: string) {
    const session = this.sessions.get(id);
    if (!session) return;
    for (const active of session.streams.values()) {
      clearTimeout(active.timer);
      this.publish({
        type: 'streamStopped',
        sessionId: id,
        streamId: active.streamId,
        sensor: active.request.sensor,
        reason: 'disconnect',
        confirmed: false,
      });
    }
    for (const pending of session.pending.values()) {
      clearTimeout(pending.timer);
      pending.resolve({ status: 503, body: { error: 'Device disconnected' } });
    }
    this.sessions.delete(id);
  }
  list() {
    return {
      version: 1,
      sessions: [...this.sessions.values()]
        .filter((s) => s.available || s.streams.size)
        .map((s) => ({
          sessionId: s.id,
          available: s.available,
          streams: [...s.streams.values()].map(
            ({ streamId, request, state, expiresAt }) => ({
              streamId,
              sensor: request.sensor,
              state,
              expiresAt,
            }),
          ),
        })),
    };
  }
  subscribe(socket: WebSocket) {
    this.subscribers.add(socket);
    socket.on('error', () => socket.terminate());
    socket.on('close', () => this.subscribers.delete(socket));
    socket.send(
      JSON.stringify({
        type: 'streamHello',
        ...this.list(),
        audioFormat: { encoding: 's16le', sampleRate: 16000, channels: 1 },
        imuFormat: 'SDK raw x/y/z; units and reference frame unspecified',
      }),
    );
  }
  async command(request: SensorRequest): Promise<Result> {
    const candidates = [...this.sessions.values()].filter(
      (s) =>
        s.supported &&
        (request.sessionId ? s.id === request.sessionId : s.available),
    );
    if (candidates.length !== 1)
      return {
        status: 409,
        body: {
          error: candidates.length
            ? 'Multiple clients; specify sessionId'
            : 'No compatible G2 client connected',
        },
      };
    const session = candidates[0]!;
    if (request.action === 'stop') return this.stop(session, request);
    if (!session.available)
      return { status: 409, body: { error: 'Device is not connected' } };
    if (
      session.streams.has(request.sensor) ||
      [...session.pending.values()].some(
        (p) => p.command.request.sensor === request.sensor,
      )
    )
      return {
        status: 409,
        body: { error: 'Sensor already active or command pending' },
      };
    const streamId = randomUUID();
    const active: Active = {
      streamId,
      request,
      state: 'starting',
      expiresAt: this.now() + request.durationSeconds * 1000,
      sequence: -1,
      timer: setTimeout(() => {
        void this.stop(session, { ...request, action: 'stop' });
      }, request.durationSeconds * 1000),
    };
    session.streams.set(request.sensor, active);
    const result = await this.dispatch(session, {
      type: 'sensorCommand',
      id: randomUUID(),
      streamId,
      request,
    });
    if (result.status !== 200 && session.streams.get(request.sensor) === active)
      void this.stop(session, { ...request, action: 'stop' });
    return result;
  }
  private async stop(
    session: Session,
    request: SensorRequest,
  ): Promise<Result> {
    const active = session.streams.get(request.sensor);
    if (active) {
      clearTimeout(active.timer);
      session.streams.delete(request.sensor);
    }
    for (const [id, pending] of session.pending)
      if (pending.command.request.sensor === request.sensor) {
        clearTimeout(pending.timer);
        session.pending.delete(id);
        pending.resolve({
          status: 409,
          body: { error: 'Command cancelled by stop' },
        });
      }
    const streamId = active?.streamId ?? randomUUID();
    const result = await this.dispatch(session, {
      type: 'sensorCommand',
      id: randomUUID(),
      streamId,
      request: { ...request, action: 'stop' },
    });
    this.publish({
      type: 'streamStopped',
      sessionId: session.id,
      streamId,
      sensor: request.sensor,
      reason: 'stopped',
      confirmed: result.status === 200,
    });
    return result;
  }
  private dispatch(session: Session, command: SensorCommand): Promise<Result> {
    if (
      !this.sessions.has(session.id) ||
      session.socket.readyState !== WebSocket.OPEN
    )
      return Promise.resolve({
        status: 503,
        body: { error: 'Device disconnected' },
      });
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        session.pending.delete(command.id);
        resolve({
          status: 504,
          body: {
            commandId: command.id,
            error: 'Device acknowledgement timeout; stop requested',
          },
        });
      }, 8000);
      session.pending.set(command.id, { command, timer, resolve });
      session.socket.send(JSON.stringify(command), (error) => {
        if (error) session.socket.terminate();
      });
    });
  }
  receive(id: string, payload: unknown, bytes: number): boolean {
    const session = this.sessions.get(id);
    if (!session) return false;
    const ack = sensorAckSchema.safeParse(payload);
    if (ack.success) {
      const pending = session.pending.get(ack.data.id);
      if (!pending) return true;
      clearTimeout(pending.timer);
      session.pending.delete(ack.data.id);
      const active = session.streams.get(pending.command.request.sensor);
      if (
        ack.data.ok &&
        pending.command.request.action === 'start' &&
        active?.streamId === pending.command.streamId
      )
        active.state = 'running';
      const body = {
        commandId: ack.data.id,
        streamId: pending.command.streamId,
        sessionId: id,
        ok: ack.data.ok,
        action: pending.command.request.action,
        ...(ack.data.error ? { error: ack.data.error } : {}),
      };
      pending.resolve({ status: ack.data.ok ? 200 : 502, body });
      this.publish({ type: 'commandResult', ...body });
      return true;
    }
    const stopped = sensorStoppedSchema.safeParse(payload);
    if (stopped.success) {
      const active = session.streams.get(stopped.data.sensor);
      if (active?.streamId === stopped.data.streamId) {
        clearTimeout(active.timer);
        session.streams.delete(stopped.data.sensor);
        this.publish({ ...stopped.data, type: 'streamStopped', sessionId: id });
      }
      return true;
    }
    const frame = sensorFrameSchema.safeParse(payload);
    if (!frame.success) return false;
    const data = frame.data;
    const active = session.streams.get(data.sensor);
    if (
      !active ||
      active.state !== 'running' ||
      active.streamId !== data.streamId ||
      this.now() >= active.expiresAt ||
      data.sequence <= active.sequence
    )
      return true;
    if (this.now() - session.window >= 1000) {
      session.window = this.now();
      session.bytes = 0;
    }
    session.bytes += bytes;
    if (session.bytes > 256 * 1024) return true;
    if (data.sensor === 'audio') {
      const length = Buffer.from(data.pcmBase64, 'base64').length;
      if (
        !length ||
        length > 16384 ||
        length % 2 ||
        active.request.sensor !== 'audio' ||
        data.source !== active.request.source
      )
        return true;
    }
    active.sequence = data.sequence;
    this.publish({ ...data, sessionId: id, receivedAt: this.now() });
    return true;
  }
  private publish(data: unknown) {
    const payload = JSON.stringify(data);
    for (const socket of this.subscribers) {
      if (socket.readyState !== WebSocket.OPEN) continue;
      if (socket.bufferedAmount > 256 * 1024) {
        socket.terminate();
        continue;
      }
      socket.send(payload, (error) => {
        if (error) socket.terminate();
      });
    }
  }
  close() {
    for (const id of this.sessions.keys()) this.remove(id);
    for (const socket of this.subscribers) socket.terminate();
  }
}
