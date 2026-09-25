import {
  OsEventTypeList,
  type EvenHubEvent,
} from '@evenrealities/even_hub_sdk';

export function inputAction(
  event: EvenHubEvent,
): 'exit' | 'stop' | 'overlay-open' | 'overlay-close' | 'next' | null {
  const kind = (envelope?: { eventType?: OsEventTypeList }) =>
    envelope ? (envelope.eventType ?? OsEventTypeList.CLICK_EVENT) : null;
  const sys = kind(event.sysEvent);
  const text = kind(event.textEvent);
  if (
    [sys, text].includes(OsEventTypeList.SYSTEM_EXIT_EVENT) ||
    [sys, text].includes(OsEventTypeList.ABNORMAL_EXIT_EVENT)
  )
    return 'stop';
  if ([sys, text].includes(OsEventTypeList.DOUBLE_CLICK_EVENT)) return 'exit';
  // Foreground means the glasses' system overlay, not the phone WebView.
  // https://hub.evenrealities.com/docs/build/contextual-menu
  if (sys === OsEventTypeList.FOREGROUND_ENTER_EVENT) return 'overlay-open';
  if (sys === OsEventTypeList.FOREGROUND_EXIT_EVENT) return 'overlay-close';
  if ([sys, text].includes(OsEventTypeList.CLICK_EVENT)) return 'next';
  // Scrolling stays with firmware; tap changes dashboard pages.
  return null;
}
