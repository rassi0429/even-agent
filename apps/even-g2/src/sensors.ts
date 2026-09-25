import {
  AudioInputSource,
  OsEventTypeList,
  type EvenAppBridge,
  type EvenHubEvent,
} from '@evenrealities/even_hub_sdk';
import type {
  Sensor,
  SensorCommand,
  SensorUpMessage,
} from '@even-agent/protocol';

type Active = {
  command: SensorCommand;
  sequence: number;
  running: boolean;
  timer: ReturnType<typeof setTimeout>;
};
const deadline = async <T>(work: Promise<T>): Promise<T> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('SDK timeout')), 5000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
};

export class SensorController {
  private active = new Map<Sensor, Active>();
  private uncertain = new Set<Sensor>();
  private enabling = new Set<Sensor>();
  private disabling = new Map<Sensor, Promise<boolean>>();
  constructor(
    private readonly bridge: Pick<EvenAppBridge, 'audioControl' | 'imuControl'>,
    private readonly ready: () => boolean,
    private readonly send: (message: SensorUpMessage) => boolean,
  ) {}
  async command(command: SensorCommand) {
    const request = command.request;
    try {
      if (request.action === 'stop') {
        const confirmed = await this.stop(request.sensor, 'stopped');
        this.send({
          type: 'sensorAck',
          id: command.id,
          ok: confirmed,
          ...(!confirmed ? { error: 'Native stop not confirmed' } : {}),
        });
        return;
      }
      if (!this.ready())
        throw new Error('G2 startup or device connection is not ready');
      if (this.active.has(request.sensor) || this.enabling.has(request.sensor))
        throw new Error('Sensor already active or SDK start pending');
      if (
        this.uncertain.has(request.sensor) &&
        !(await this.disable(request.sensor))
      )
        throw new Error('Previous native stop not confirmed');
      if (
        !this.ready() ||
        this.active.has(request.sensor) ||
        this.enabling.has(request.sensor)
      )
        throw new Error('Sensor start cancelled while waiting for native stop');
      const state: Active = {
        command,
        sequence: 0,
        running: false,
        timer: setTimeout(() => {
          void this.stop(request.sensor, 'expired');
        }, request.durationSeconds * 1000),
      };
      this.active.set(request.sensor, state);
      this.enabling.add(request.sensor);
      this.uncertain.add(request.sensor);
      const work = Promise.resolve().then(() =>
        request.sensor === 'audio'
          ? this.bridge.audioControl(
              true,
              request.source === 'phone'
                ? AudioInputSource.Phone
                : AudioInputSource.Glasses,
            )
          : this.bridge.imuControl(true, request.reportFrq),
      );
      // A late native success after timeout/disconnect must be closed again.
      void work.then(
        () => {
          this.enabling.delete(request.sensor);
          if (this.active.get(request.sensor) !== state)
            void (async () => {
              await this.disabling.get(request.sensor);
              await this.disable(request.sensor);
            })();
        },
        () => {
          this.enabling.delete(request.sensor);
        },
      );
      const ok = await deadline(work);
      if (!ok || this.active.get(request.sensor) !== state || !this.ready())
        throw new Error('SDK rejected or cancelled sensor start');
      state.running = true;
      this.send({ type: 'sensorAck', id: command.id, ok: true });
    } catch (error) {
      // Never stop a different command's already-running stream.
      if (this.active.get(request.sensor)?.command.id === command.id)
        await this.stop(request.sensor, 'error');
      this.send({
        type: 'sensorAck',
        id: command.id,
        ok: false,
        error: String(error).slice(0, 160),
      });
    }
  }
  stopAll(reason: 'disconnect' | 'device-disconnected' = 'disconnect') {
    for (const sensor of new Set([...this.active.keys(), ...this.uncertain]))
      void this.stop(sensor, reason);
  }
  private disable(sensor: Sensor): Promise<boolean> {
    const pending = this.disabling.get(sensor);
    if (pending) return pending;
    const work = this.disableNative(sensor).finally(() =>
      this.disabling.delete(sensor),
    );
    this.disabling.set(sensor, work);
    return work;
  }
  private async disableNative(sensor: Sensor) {
    try {
      const ok = await deadline(
        Promise.resolve().then(() =>
          sensor === 'audio'
            ? this.bridge.audioControl(false)
            : this.bridge.imuControl(false),
        ),
      );
      if (ok && !this.enabling.has(sensor)) {
        this.uncertain.delete(sensor);
        return true;
      }
    } catch {
      /* SDK unavailable: don't claim that hardware has stopped. */
    }
    return false;
  }
  private async stop(
    sensor: Sensor,
    reason:
      'expired' | 'disconnect' | 'device-disconnected' | 'stopped' | 'error',
  ) {
    const state = this.active.get(sensor);
    this.active.delete(sensor); // Stop forwarding immediately, before native acknowledgement.
    clearTimeout(state?.timer);
    // Explicit stop also closes a native sensor left over from a prior WebView.
    if (reason === 'stopped') this.uncertain.add(sensor);
    const confirmed =
      !this.uncertain.has(sensor) || (await this.disable(sensor));
    if (state)
      this.send({
        type: 'sensorStopped',
        streamId: state.command.streamId,
        sensor,
        reason,
        confirmed,
      });
    return confirmed;
  }
  onEvent(event: EvenHubEvent) {
    const audio = this.active.get('audio');
    const payload = event.audioEvent;
    if (
      audio?.running &&
      payload &&
      audio.command.request.sensor === 'audio' &&
      payload.source === audio.command.request.source
    ) {
      const pcm = payload.audioPcm;
      if (pcm.length % 2 === 0)
        for (let offset = 0; offset < pcm.length; offset += 16384) {
          const chunk = pcm.subarray(offset, offset + 16384);
          this.send({
            type: 'sensorFrame',
            sensor: 'audio',
            streamId: audio.command.streamId,
            sequence: audio.sequence++,
            pcmBase64: btoa(String.fromCharCode(...chunk)),
            source: payload.source,
            direction: payload.direction,
            speakerRole: payload.speakerRole,
          });
        }
    }
    const imu = this.active.get('imu');
    const data = event.sysEvent?.imuData;
    if (
      imu?.running &&
      event.sysEvent?.eventType === OsEventTypeList.IMU_DATA_REPORT &&
      data &&
      [data.x, data.y, data.z].every(
        (v) => typeof v === 'number' && Number.isFinite(v),
      )
    )
      this.send({
        type: 'sensorFrame',
        sensor: 'imu',
        streamId: imu.command.streamId,
        sequence: imu.sequence++,
        x: data.x!,
        y: data.y!,
        z: data.z!,
      });
  }
}
