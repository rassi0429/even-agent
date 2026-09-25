import {
  EventSourceType,
  OsEventTypeList,
  type EvenHubEvent,
} from '@evenrealities/even_hub_sdk';
import { deviceEventSchema, type DeviceEvent } from '@even-agent/protocol';

const kinds: Partial<Record<OsEventTypeList, DeviceEvent['kind']>> = {
  [OsEventTypeList.CLICK_EVENT]: 'tap',
  [OsEventTypeList.DOUBLE_CLICK_EVENT]: 'double-tap',
  [OsEventTypeList.SCROLL_TOP_EVENT]: 'scroll-top',
  [OsEventTypeList.SCROLL_BOTTOM_EVENT]: 'scroll-bottom',
  [OsEventTypeList.LONG_PRESS_EVENT]: 'long-press',
  [OsEventTypeList.LONG_PRESS_RELEASE_EVENT]: 'long-press-release',
  [OsEventTypeList.FOREGROUND_ENTER_EVENT]: 'overlay-open',
  [OsEventTypeList.FOREGROUND_EXIT_EVENT]: 'overlay-close',
  [OsEventTypeList.SYSTEM_EXIT_EVENT]: 'exit',
  [OsEventTypeList.ABNORMAL_EXIT_EVENT]: 'abnormal-exit',
};

export function deviceEvents(event: EvenHubEvent): DeviceEvent[] {
  const result: DeviceEvent[] = [];
  for (const [channel, data] of [
    ['system', event.sysEvent],
    ['text', event.textEvent],
    ['list', event.listEvent],
  ] as const) {
    if (!data) continue;
    // Protobuf omits enum zero (CLICK). IMU-only payloads must never become taps.
    if ('imuData' in data && data.imuData) continue;
    const kind = kinds[data.eventType ?? OsEventTypeList.CLICK_EVENT];
    if (!kind) continue;
    const source = 'eventSource' in data ? data.eventSource : undefined;
    const parsed = deviceEventSchema.safeParse({
      kind,
      channel,
      source:
        source === EventSourceType.TOUCH_EVENT_FROM_GLASSES_L
          ? 'left-temple'
          : source === EventSourceType.TOUCH_EVENT_FROM_GLASSES_R
            ? 'right-temple'
            : source === EventSourceType.TOUCH_EVENT_FROM_RING
              ? 'ring'
              : 'unknown',
      ...('containerID' in data && data.containerID != null
        ? { containerId: data.containerID }
        : {}),
      ...('currentSelectItemIndex' in data &&
      data.currentSelectItemIndex != null
        ? { itemIndex: data.currentSelectItemIndex }
        : {}),
    });
    if (parsed.success) result.push(parsed.data);
  }
  return result;
}
