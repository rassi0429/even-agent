import { randomUUID } from 'node:crypto';
import type { DeviceEvent } from '@even-agent/protocol';

// A short diagnostic feed, not a durable queue for commands or automation.
export class DeviceEventLog {
  readonly instanceId = randomUUID();
  private sequence = 0;
  private events: {
    sequence: number;
    sessionId: string;
    observedAt: number;
    data: DeviceEvent;
  }[] = [];
  constructor(private readonly now: () => number) {}
  append(sessionId: string, data: DeviceEvent) {
    this.events.push({
      sequence: ++this.sequence,
      sessionId,
      observedAt: this.now(),
      data,
    });
    this.prune();
  }
  read(after = 0) {
    this.prune();
    return {
      instanceId: this.instanceId,
      cursor: this.sequence,
      oldestSequence: this.events[0]?.sequence ?? null,
      events: this.events.filter((event) => event.sequence > after),
    };
  }
  private prune() {
    this.events = this.events
      .filter((event) => this.now() - event.observedAt < 300_000)
      .slice(-100);
  }
}
