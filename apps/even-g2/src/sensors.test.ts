import { afterEach, expect, it, vi } from 'vitest';
import { once } from 'node:events';
import { WebSocket } from 'ws';
import {
  AudioEvent,
  AudioInputSource,
  DeviceConnectType,
  OsEventTypeList,
  EventSourceType,
} from '@evenrealities/even_hub_sdk';
import type { SensorCommand, SensorUpMessage } from '@even-agent/protocol';
import { SensorController } from './sensors.js';
import { DisplaySync } from './sync.js';
import { deviceReport } from './device.js';
import { deviceEvents } from './device-events.js';
import { createServer } from '../../server/src/app.js';
import { DeviceEventLog } from '../../server/src/device-events.js';
import { SensorHub } from '../../server/src/sensors.js';

afterEach(() => vi.useRealTimers());
const command = (
  sensor: 'audio' | 'imu',
  durationSeconds = 60,
): SensorCommand => ({
  type: 'sensorCommand',
  id: crypto.randomUUID(),
  streamId: crypto.randomUUID(),
  request:
    sensor === 'audio'
      ? { sensor, action: 'start', source: 'glasses', durationSeconds }
      : { sensor, action: 'start', reportFrq: 500, durationSeconds },
});
const audioEvent = () => ({
  audioEvent: new AudioEvent({
    audioPcm: new Uint8Array([1, 0, 255, 127]),
    source: AudioInputSource.Glasses,
  }),
});

it('rejects native capture failure and does not forward data from a failed start', async () => {
  const bridge = {
    audioControl: vi.fn(async (enabled: boolean) => !enabled),
    imuControl: vi.fn(async () => true),
  };
  const messages: SensorUpMessage[] = [];
  const controller = new SensorController(
    bridge,
    () => true,
    (message) => {
      messages.push(message);
      return true;
    },
  );
  await controller.command(command('audio'));
  controller.onEvent(audioEvent());
  expect(messages).toContainEqual(
    expect.objectContaining({ type: 'sensorAck', ok: false }),
  );
  expect(messages.some((message) => message.type === 'sensorFrame')).toBe(
    false,
  );
  expect(bridge.audioControl).toHaveBeenLastCalledWith(false);
  bridge.audioControl.mockClear();
  const stop = command('audio');
  stop.request.action = 'stop';
  await controller.command(stop);
  expect(bridge.audioControl).toHaveBeenCalledWith(false);
});

it('requires a target for multiple devices, binds ACKs to the correct socket and stops unacknowledged starts', async () => {
  vi.useFakeTimers();
  const hub = new SensorHub(Date.now);
  const sent: SensorCommand[] = [];
  const socket = {
    readyState: WebSocket.OPEN,
    send: (data: string, callback: () => void) => {
      sent.push(JSON.parse(data));
      callback();
    },
  } as unknown as WebSocket;
  const first = crypto.randomUUID();
  const second = crypto.randomUUID();
  hub.add(first, socket);
  hub.add(second, socket);
  hub.available(first, true);
  hub.available(second, true);
  const request = command('audio').request;
  expect((await hub.command(request)).status).toBe(409);
  const pending = hub.command({ ...request, sessionId: first });
  hub.receive(second, { type: 'sensorAck', id: sent[0]!.id, ok: true }, 100);
  await vi.advanceTimersByTimeAsync(8001);
  expect((await pending).status).toBe(504);
  expect(sent.at(-1)?.request.action).toBe('stop');
  expect(hub.list().sessions[0]?.streams).toHaveLength(0);
  hub.close();
});

it('normalizes passive events, preserves input origin and excludes raw sensor/user payloads', () => {
  expect(
    deviceEvents({
      sysEvent: {
        eventType: OsEventTypeList.LONG_PRESS_EVENT,
        eventSource: EventSourceType.TOUCH_EVENT_FROM_RING,
      },
    } as never),
  ).toEqual([{ kind: 'long-press', channel: 'system', source: 'ring' }]);
  expect(
    deviceEvents({ textEvent: { containerID: 2 } } as never)[0],
  ).toMatchObject({ kind: 'tap', containerId: 2 });
  expect(deviceEvents(audioEvent())).toEqual([]);
  expect(
    deviceEvents({ sysEvent: { imuData: { x: 1, y: 2, z: 3 } } } as never),
  ).toEqual([]);
  let now = 0;
  const log = new DeviceEventLog(() => now);
  for (let i = 0; i < 105; i++)
    log.append('session', { kind: 'tap', channel: 'text', source: 'unknown' });
  expect(log.read().events).toHaveLength(100);
  expect(log.read(104).events).toHaveLength(1);
  now = 300001;
  expect(log.read().events).toHaveLength(0);
  expect(log.read().cursor).toBe(105);
});

it('starts only on commands, closes late native starts after disconnect and expires capture locally', async () => {
  vi.useFakeTimers();
  let resolveEnable!: (value: boolean) => void;
  const bridge = {
    audioControl: vi.fn((enabled: boolean) =>
      enabled
        ? new Promise<boolean>((resolve) => {
            resolveEnable = resolve;
          })
        : Promise.resolve(true),
    ),
    imuControl: vi.fn(async () => true),
  };
  const messages: SensorUpMessage[] = [];
  const controller = new SensorController(
    bridge,
    () => true,
    (message) => {
      messages.push(message);
      return true;
    },
  );
  controller.onEvent(audioEvent());
  expect(bridge.audioControl).not.toHaveBeenCalled();
  const starting = controller.command(command('audio'));
  await vi.advanceTimersByTimeAsync(0);
  controller.stopAll();
  await vi.advanceTimersByTimeAsync(0);
  resolveEnable(true);
  await starting;
  await vi.advanceTimersByTimeAsync(0);
  expect(bridge.audioControl).toHaveBeenLastCalledWith(false);
  controller.onEvent(audioEvent());
  expect(messages.some((message) => message.type === 'sensorFrame')).toBe(
    false,
  );
  await controller.command(command('imu', 1));
  expect(bridge.imuControl).toHaveBeenLastCalledWith(true, 500);
  await vi.advanceTimersByTimeAsync(1001);
  expect(bridge.imuControl).toHaveBeenLastCalledWith(false);
  expect(messages).toContainEqual(
    expect.objectContaining({
      type: 'sensorStopped',
      sensor: 'imu',
      reason: 'expired',
      confirmed: true,
    }),
  );
});

it('commands and relays audio/IMU end to end, protects capture, and never replays streams on reconnect', async () => {
  const server = await createServer({ apiToken: 'test-token' });
  const url = await server.listen({ host: '127.0.0.1', port: 0 });
  const frames: Record<string, unknown>[] = [];
  const subscriber = new WebSocket(
    url.replace('http:', 'ws:') + '/ws/device/stream',
    { headers: { Authorization: 'Bearer test-token' } },
  );
  subscriber.on('message', (raw) => frames.push(JSON.parse(String(raw))));
  const bridge = {
    audioControl: vi.fn(async (enabled: boolean) => {
      void enabled;
      return true;
    }),
    imuControl: vi.fn(async (enabled: boolean) => {
      void enabled;
      return true;
    }),
  };
  let online = false;
  const client = new DisplaySync(
    url,
    () => {},
    (value) => {
      online = value;
    },
  );
  const controller = new SensorController(
    bridge,
    () => online,
    (message) => client.sendSensor(message),
  );
  client.onSensorCommand = (cmd) => {
    void controller.command(cmd);
  };
  client.onSensorDisconnect = () => controller.stopAll();
  const post = (payload: unknown) =>
    server.inject({
      method: 'POST',
      url: '/api/device/commands',
      headers: { authorization: 'Bearer test-token' },
      payload: payload as never,
    });
  try {
    await once(subscriber, 'open');
    expect(
      (
        await server.inject({
          method: 'POST',
          url: '/api/device/commands',
          payload: { sensor: 'audio', action: 'start' },
        })
      ).statusCode,
    ).toBe(401);
    expect((await server.inject('/ws/device/stream')).statusCode).toBe(401);
    expect(
      (await post({ sensor: 'imu', action: 'start', reportFrq: 123 }))
        .statusCode,
    ).toBe(400);
    expect((await post({ sensor: 'audio', action: 'start' })).statusCode).toBe(
      409,
    );
    client.reportDevice({
      ...deviceReport({
        connectType: DeviceConnectType.Connected,
        batteryLevel: 70,
        isWearing: true,
        isInCase: false,
      }),
      controlVersion: 1,
    });
    client.start();
    await expect
      .poll(
        async () =>
          (await server.inject('/api/device/streams')).json().sessions.length,
      )
      .toBe(1);
    expect(bridge.audioControl).not.toHaveBeenCalled();
    const audio = await post({
      sensor: 'audio',
      action: 'start',
      durationSeconds: 60,
    });
    expect(audio.statusCode).toBe(200);
    expect((await post({ sensor: 'audio', action: 'start' })).statusCode).toBe(
      409,
    );
    expect(
      (
        await post({
          sensor: 'imu',
          action: 'start',
          reportFrq: 500,
          durationSeconds: 1,
        })
      ).statusCode,
    ).toBe(200);
    controller.onEvent(audioEvent());
    controller.onEvent({
      sysEvent: {
        eventType: OsEventTypeList.IMU_DATA_REPORT,
        imuData: { x: 1, y: 2, z: 3 },
      },
    } as never);
    await expect
      .poll(() => frames.filter((f) => f.type === 'sensorFrame').length)
      .toBe(2);
    expect(
      frames.find((f) => f.type === 'sensorFrame' && f.sensor === 'audio')
        ?.pcmBase64,
    ).toBe('AQD/fw==');
    expect(
      frames.find((f) => f.type === 'sensorFrame' && f.sensor === 'imu'),
    ).toMatchObject({ x: 1, y: 2, z: 3 });
    await expect
      .poll(
        () => bridge.imuControl.mock.calls.some((args) => args[0] === false),
        { timeout: 2500 },
      )
      .toBe(true);
    expect((await post({ sensor: 'audio', action: 'stop' })).statusCode).toBe(
      200,
    );
    const count = frames.filter((f) => f.type === 'sensorFrame').length;
    controller.onEvent(audioEvent());
    // Even a forged late frame with the old stream ID must be discarded by PC.
    client.sendSensor({
      type: 'sensorFrame',
      sensor: 'audio',
      streamId: audio.json().streamId,
      sequence: 999,
      pcmBase64: 'AQD/fw==',
      source: 'glasses',
      direction: null,
      speakerRole: 'unknown',
    });
    client.reportEvent({ kind: 'tap', channel: 'text', source: 'unknown' });
    await expect
      .poll(
        async () =>
          (await server.inject('/api/device/events')).json().events.length,
      )
      .toBe(1);
    expect(frames.filter((f) => f.type === 'sensorFrame')).toHaveLength(count);
    expect((await post({ sensor: 'audio', action: 'start' })).statusCode).toBe(
      200,
    );
    client.start(); // Explicit transport restart must stop capture, without replaying start.
    await expect
      .poll(
        () =>
          bridge.audioControl.mock.calls.filter((args) => args[0] === false)
            .length,
      )
      .toBeGreaterThanOrEqual(2);
    await expect
      .poll(
        async () =>
          (await server.inject('/api/device/streams')).json().sessions[0]
            ?.streams.length,
      )
      .toBe(0);
    expect(
      bridge.audioControl.mock.calls.filter((args) => args[0] === true),
    ).toHaveLength(2);
  } finally {
    client.stop();
    subscriber.terminate();
    await server.close();
  }
});
