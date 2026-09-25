import { AGENT_SPRITES } from './agent-icons.js';
import type { UsageValue } from './usage.js';

export function usageText(value: number | null) {
  return value === null ? '--%' : `${value}%`;
}
export function windowRemaining(value: UsageValue, minutes: number) {
  const window = value.windows.find((w) => w.minutes === minutes);
  return value.status === 'ok' && window
    ? Math.floor(100 - window.usedPercent)
    : null;
}
// Only icons and the rule are rasterized; all header labels use native text.
export function headerUsageFrames(footer: boolean, online: boolean) {
  const height = footer ? 84 : 56;
  const buffers = [
    Array<string>(288 * height).fill('0'),
    Array<string>(288 * height).fill('0'),
  ];
  const pixel = (x: number, y: number, value: string) => {
    buffers[Math.floor(x / 288)]![y * 288 + (x % 288)] = value;
  };
  for (let x = 0; x < 576; x++) pixel(x, footer ? 66 : 38, '8');
  for (const [provider, x] of [
    ['claude', 306],
    ['codex', 492],
  ] as const) {
    // Center the emblem in the native 28px text line, below its 4px padding.
    const iconTop = 4 + Math.floor((28 - AGENT_SPRITES[provider].length) / 2);
    AGENT_SPRITES[provider].forEach((row, y) =>
      [...row].forEach((bit, dx) => {
        if (bit === '1') pixel(x + dx, y + iconTop, online ? 'f' : '6');
      }),
    );
  }
  return { height, frames: buffers.map((pixels) => pixels.join('')) };
}
