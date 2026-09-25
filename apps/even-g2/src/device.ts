import {
  DeviceConnectType,
  DeviceModel,
  type DeviceStatus,
  type EvenAppBridge,
  type LaunchSource,
} from '@evenrealities/even_hub_sdk';
import type { DeviceTelemetry } from '@even-agent/protocol';

export function deviceReport(
  status: Pick<
    DeviceStatus,
    'connectType' | 'batteryLevel' | 'isCharging' | 'isWearing' | 'isInCase'
  >,
): DeviceTelemetry {
  const connected = status.connectType === DeviceConnectType.Connected;
  const level = status.batteryLevel;
  return {
    model: 'g2',
    connected,
    connectionState: Object.values(DeviceConnectType).includes(
      status.connectType,
    )
      ? status.connectType
      : null,
    batteryLevel:
      connected &&
      typeof level === 'number' &&
      Number.isInteger(level) &&
      level >= 0 &&
      level <= 100
        ? level
        : null,
    isCharging:
      connected && typeof status.isCharging === 'boolean'
        ? status.isCharging
        : null,
    isWearing:
      connected && typeof status.isWearing === 'boolean'
        ? status.isWearing
        : null,
    isInCase:
      connected && typeof status.isInCase === 'boolean'
        ? status.isInCase
        : null,
  };
}
// Local identity is used only to filter ring/other-device events. Never transmitted.
export class DeviceReporter {
  private sn?: string;
  private status?: DeviceStatus;
  private stopped = false;
  private reading = false;
  private generation = 0;
  private timer?: ReturnType<typeof setInterval>;
  private unsubscribe?: () => void;
  private unsubscribeLaunch?: () => void;
  private launchSource: LaunchSource | null = null;
  constructor(
    private readonly bridge: Pick<
      EvenAppBridge,
      'getDeviceInfo' | 'onDeviceStatusChanged' | 'onLaunchSource'
    >,
    private readonly send: (report: DeviceTelemetry) => void,
  ) {}
  start() {
    this.unsubscribeLaunch = this.bridge.onLaunchSource((source) => {
      if (this.stopped) return;
      this.launchSource = source;
      if (this.status) this.report(this.status);
    });
    this.unsubscribe = this.bridge.onDeviceStatusChanged((status) => {
      if (this.stopped) return;
      if (!this.sn) {
        void this.refresh();
        return;
      }
      if (status.sn !== this.sn) return;
      this.generation++;
      this.status = {
        ...this.status,
        ...Object.fromEntries(
          Object.entries(status).filter(([, v]) => v !== undefined),
        ),
      } as DeviceStatus;
      this.report(this.status);
    });
    void this.refresh();
    this.timer = setInterval(() => {
      void this.refresh();
    }, 30_000);
  }
  async refresh() {
    if (this.stopped || this.reading) return;
    this.reading = true;
    const generation = this.generation;
    try {
      const info = await this.bridge.getDeviceInfo();
      if (this.stopped || generation !== this.generation) return;
      if (info?.model === DeviceModel.G2 && info.sn) {
        this.sn = info.sn;
        this.status = info.status;
        this.report(info.status);
      } else this.clear();
    } catch {
      if (!this.stopped && generation === this.generation) this.clear();
    } finally {
      this.reading = false;
    }
  }
  private clear() {
    if (this.sn)
      this.send({
        model: 'g2',
        connected: false,
        batteryLevel: null,
        isCharging: null,
        connectionState: null,
        isWearing: null,
        isInCase: null,
        launchSource: this.launchSource,
      });
    this.sn = undefined;
    this.status = undefined;
  }
  private report(status: DeviceStatus) {
    this.send({
      ...deviceReport(status),
      launchSource: this.launchSource,
      controlVersion: 1,
    });
  }
  stop() {
    this.stopped = true;
    clearInterval(this.timer);
    this.unsubscribe?.();
    this.unsubscribeLaunch?.();
  }
}
