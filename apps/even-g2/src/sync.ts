import {
  displayMessageSchema,
  displaySchema,
  type DisplayState,
  type DeviceTelemetry,
  type DeviceEvent,
  sensorCommandSchema,
  type SensorCommand,
  type SensorUpMessage,
} from '@even-agent/protocol';

export class DisplaySync {
  onSensorCommand?: (command: SensorCommand) => void;
  onSensorDisconnect?: () => void;
  private socket?: WebSocket;
  private retry?: ReturnType<typeof setTimeout>;
  private timeout?: ReturnType<typeof setTimeout>;
  private abort?: AbortController;
  private stopped = true;
  private attempt = 0;
  private generation = 0;
  private deviceReport?: { data: DeviceTelemetry; time: number };
  constructor(
    private readonly url: string,
    private readonly onState: (state: DisplayState) => void,
    private readonly onStatus: (online: boolean, message: string) => void,
  ) {}

  start() {
    this.stop();
    this.stopped = false;
    this.attempt = 0;
    void this.connect();
  }
  reportDevice(data: DeviceTelemetry) {
    this.deviceReport = { data, time: Date.now() };
    this.sendDevice();
  }
  reportEvent(data: DeviceEvent) {
    // Transient input is never replayed after reconnect or queued while offline.
    if (
      this.stopped ||
      this.socket?.readyState !== WebSocket.OPEN ||
      this.socket.bufferedAmount > 64 * 1024
    )
      return;
    try {
      this.socket.send(JSON.stringify({ type: 'deviceEvent', data }));
    } catch {
      /* Best effort. The next user action is independent. */
    }
  }
  sendSensor(message: SensorUpMessage) {
    if (
      this.stopped ||
      this.socket?.readyState !== WebSocket.OPEN ||
      this.socket.bufferedAmount > 64 * 1024
    )
      return false;
    try {
      this.socket.send(JSON.stringify(message));
      return true;
    } catch {
      return false;
    }
  }
  private sendDevice() {
    if (
      this.stopped ||
      !this.deviceReport ||
      Date.now() - this.deviceReport.time > 60_000 ||
      this.socket?.readyState !== WebSocket.OPEN
    )
      return;
    try {
      this.socket.send(
        JSON.stringify({ type: 'deviceStatus', data: this.deviceReport.data }),
      );
    } catch {
      /* Reconnect will send a recent report again. */
    }
  }
  stop() {
    this.onSensorDisconnect?.();
    this.stopped = true;
    this.generation++;
    clearTimeout(this.retry);
    clearTimeout(this.timeout);
    this.abort?.abort();
    if (this.socket) {
      this.socket.onopen = null;
      this.socket.onclose = null;
      this.socket.onerror = null;
      this.socket.onmessage = null;
      this.socket.close();
      this.socket = undefined;
    }
  }
  private async connect() {
    if (this.stopped) return;
    const generation = ++this.generation;
    const current = () => !this.stopped && generation === this.generation;
    this.onStatus(false, 'Connecting');
    const controller = new AbortController();
    this.abort = controller;
    const requestTimeout = setTimeout(() => controller.abort(), 8000);
    try {
      const response = await fetch(new URL('/api/display', this.url), {
        signal: controller.signal,
        cache: 'no-store',
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const state = displaySchema.parse(await response.json());
      if (current()) this.onState(state);
    } catch {
      if (current()) this.onStatus(false, 'REST unavailable; trying WebSocket');
    } finally {
      clearTimeout(requestTimeout);
    }
    if (!current()) return;
    const wsUrl = new URL('/ws/display', this.url);
    wsUrl.protocol = wsUrl.protocol === 'https:' ? 'wss:' : 'ws:';
    let socket: WebSocket;
    try {
      socket = new WebSocket(wsUrl);
    } catch {
      this.schedule();
      return;
    }
    this.socket = socket;
    const disconnect = (code = 4000, reason = 'Display unavailable') => {
      if (!current()) return;
      // A broken transport may never deliver close. Invalidate its callbacks
      // and presentation now instead of waiting for the closing handshake.
      this.generation++;
      clearTimeout(this.timeout);
      socket.onopen = null;
      socket.onmessage = null;
      socket.onerror = null;
      socket.onclose = null;
      this.socket = undefined;
      this.onSensorDisconnect?.();
      this.schedule();
      try {
        socket.close(code, reason);
      } catch {
        /* The detached transport cannot make the display live again. */
      }
    };
    socket.onopen = () => {
      if (current()) this.sendDevice();
    };
    // A socket is usable only after its initial authoritative snapshot.
    this.timeout = setTimeout(
      () => disconnect(4000, 'Initial snapshot timeout'),
      10000,
    );
    socket.onmessage = (event) => {
      if (!current()) return;
      try {
        const payload: unknown = JSON.parse(String(event.data));
        const command = sensorCommandSchema.safeParse(payload);
        if (command.success) {
          this.onSensorCommand?.(command.data);
          return;
        }
        const message = displayMessageSchema.parse(payload);
        clearTimeout(this.timeout);
        // TCP may remain alive while a suspended WebView stops receiving data.
        this.timeout = setTimeout(
          () => disconnect(4000, 'Snapshot timeout'),
          45000,
        );
        this.attempt = 0;
        this.onState(message.data);
        this.onStatus(true, 'Live');
      } catch {
        this.onStatus(false, 'Invalid server state');
        disconnect(4002, 'Invalid state');
      }
    };
    socket.onerror = () => disconnect();
    socket.onclose = () => disconnect();
  }
  private schedule() {
    if (this.stopped) return;
    const delay =
      Math.min(30000, 1000 * 2 ** Math.min(this.attempt++, 5)) +
      Math.random() * 250;
    this.onStatus(false, `Offline; retry in ${Math.ceil(delay / 1000)}s`);
    this.retry = setTimeout(() => {
      void this.connect();
    }, delay);
  }
}
