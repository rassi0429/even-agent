import { afterEach, expect, it, vi } from 'vitest';
import {
  DeviceConnectType,
  DeviceInfo,
  DeviceModel,
  DeviceStatus,
} from '@evenrealities/even_hub_sdk';
import { deviceReport, DeviceReporter } from './device.js';
import { DisplaySync } from './sync.js';
import { createServer } from '../../server/src/app.js';
afterEach(() => vi.useRealTimers());
const status = (batteryLevel?: number) =>
  new DeviceStatus({
    sn: 'PRIVATE-SERIAL',
    connectType: DeviceConnectType.Connected,
    batteryLevel,
  });
it('keeps unknown different from zero, rejects invalid values and excludes identity', () => {
  expect(deviceReport(status(0)).batteryLevel).toBe(0);
  expect(
    deviceReport({ connectType: DeviceConnectType.Connected }).batteryLevel,
  ).toBeNull();
  // SDK constructors default omitted battery/charging to 0/false.
  // A genuine SDK zero is preserved; we cannot recover omitted native fields.
  for (const level of [-1, 101, NaN, 12.5])
    expect(deviceReport(status(level)).batteryLevel).toBeNull();
  expect(
    deviceReport(
      new DeviceStatus({
        sn: 'PRIVATE-SERIAL',
        connectType: DeviceConnectType.Disconnected,
        batteryLevel: 80,
      }),
    ).batteryLevel,
  ).toBeNull();
  expect(JSON.stringify(deviceReport(status(75)))).not.toContain(
    'PRIVATE-SERIAL',
  );
});
it('reads G2 initially, filters ring events, polls and stops reporting after disposal', async () => {
  vi.useFakeTimers();
  let event!: (status: DeviceStatus) => void;
  let launch!: (source: 'appMenu' | 'glassesMenu') => void;
  const unsubscribeLaunch = vi.fn();
  const unsubscribe = vi.fn();
  const send = vi.fn();
  const info = new DeviceInfo({
    sn: 'PRIVATE-SERIAL',
    model: DeviceModel.G2,
    status: status(75),
  });
  const bridge = {
    onLaunchSource: vi.fn((fn) => {
      launch = fn;
      return unsubscribeLaunch;
    }),
    getDeviceInfo: vi.fn(async () => info),
    onDeviceStatusChanged: vi.fn((fn) => {
      event = fn;
      return unsubscribe;
    }),
  };
  const reporter = new DeviceReporter(bridge, send);
  reporter.start();
  await vi.advanceTimersByTimeAsync(0);
  expect(send).toHaveBeenLastCalledWith({
    model: 'g2',
    connected: true,
    batteryLevel: 75,
    isCharging: false,
    connectionState: 'connected',
    isWearing: false,
    isInCase: false,
    launchSource: null,
    controlVersion: 1,
  });
  event(
    new DeviceStatus({
      sn: 'RING',
      batteryLevel: 20,
      connectType: DeviceConnectType.Connected,
    }),
  );
  expect(send).toHaveBeenCalledTimes(1);
  launch('glassesMenu');
  expect(send).toHaveBeenLastCalledWith(
    expect.objectContaining({ launchSource: 'glassesMenu' }),
  );
  event(
    new DeviceStatus({
      sn: 'PRIVATE-SERIAL',
      batteryLevel: 74,
      isCharging: true,
      isWearing: true,
      isInCase: false,
      connectType: DeviceConnectType.Connected,
    }),
  );
  expect(send).toHaveBeenLastCalledWith(
    expect.objectContaining({
      batteryLevel: 74,
      isCharging: true,
      isWearing: true,
      isInCase: false,
    }),
  );
  await vi.advanceTimersByTimeAsync(30_000);
  expect(bridge.getDeviceInfo).toHaveBeenCalledTimes(2);
  reporter.stop();
  const count = send.mock.calls.length;
  await vi.advanceTimersByTimeAsync(60_000);
  event(status(50));
  expect(send).toHaveBeenCalledTimes(count);
  expect(unsubscribe).toHaveBeenCalledTimes(1);
  expect(unsubscribeLaunch).toHaveBeenCalledTimes(1);
});
it('transmits current telemetry through reconnect, expires it and removes it on close without changing custom screens', async () => {
  let now = 100000;
  const server = await createServer({
    now: () => now,
  });
  const url = await server.listen({ host: '127.0.0.1', port: 0 });
  let online = false;
  const client = new DisplaySync(
    url,
    () => {},
    (value) => {
      online = value;
    },
  );
  const read = async () => (await server.inject('/api/device')).json();
  try {
    client.reportDevice(deviceReport(status(75)));
    client.start();
    await expect.poll(async () => (await read()).device?.batteryLevel).toBe(75);
    for (const socket of server.websocketServer.clients) socket.terminate();
    await expect.poll(() => online).toBe(false);
    await expect.poll(async () => (await read()).device).toBeNull();
    now += 2000;
    await expect.poll(() => online, { timeout: 4000 }).toBe(true);
    await expect.poll(async () => (await read()).device?.batteryLevel).toBe(75);
    now += 90_001;
    expect((await read()).device).toBeNull();
    client.reportDevice(deviceReport(status(0)));
    await expect.poll(async () => (await read()).device?.batteryLevel).toBe(0);
    client.reportDevice({
      model: 'g2',
      connected: false,
      batteryLevel: null,
      isCharging: null,
    });
    await expect.poll(async () => (await read()).device).toBeNull();
    const custom = {
      pages: [
        {
          id: 'custom',
          content: 'Custom',
          offlineContent: 'Offline',
          scene: {
            elements: [
              {
                type: 'text',
                id: 'text',
                x: 0,
                y: 0,
                width: 576,
                height: 100,
                text: 'Custom',
              },
            ],
          },
        },
      ],
    };
    expect(
      (
        await server.inject({
          method: 'PUT',
          url: '/api/screen',
          payload: custom,
        })
      ).statusCode,
    ).toBe(200);
    now += 2000;
    client.reportDevice(deviceReport(status(80)));
    await expect.poll(async () => (await read()).device?.batteryLevel).toBe(80);
    expect((await server.inject('/api/display')).json().pages[0].content).toBe(
      'Custom',
    );
    client.stop();
    await expect.poll(async () => (await read()).device).toBeNull();
  } finally {
    client.stop();
    await server.close();
  }
});
