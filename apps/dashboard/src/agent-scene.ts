import type { DisplayIconRow, Scene, SceneElement } from '@even-agent/protocol';
import { iconStrip, ICON_WIDTH, ROW_HEIGHT, FRAME_MS } from './agent-icons.js';
import { agentFlow, LABEL_X } from './agent-flow.js';
import {
  headerUsageFrames,
  usageText,
  windowRemaining,
} from './header-usage.js';
import type { UsageSnapshot } from './usage.js';
const frameCache = new Map<string, string[]>();
// Two 288px tiles span the full canvas; 20px is the native minimum image height.
const ruleFrame = '0'.repeat(288 * 2) + '8'.repeat(288) + '0'.repeat(288 * 17);
function frames(
  entries: ReturnType<typeof agentFlow>,
  tile: { x: number; width: number },
  height: number,
  online: boolean,
) {
  const key = JSON.stringify([
    entries.map(({ row, x, line }) => [row.icon, row.agent, x, line]),
    tile,
    height,
    online,
  ]);
  const cached = frameCache.get(key);
  if (cached) return cached;
  const moving = online && entries.some((e) => e.row.icon === 'running');
  const result = Array.from({ length: moving ? 8 : 1 }, (_, frame) => {
    const data = new Uint8Array((tile.width * height) / 2);
    for (const entry of entries) {
      const icon = iconStrip([entry.row], 0, frame, online);
      for (let y = 0; y < ROW_HEIGHT; y++)
        for (let x = 0; x < ICON_WIDTH; x++) {
          const tileX = entry.x + x - tile.x;
          if (tileX < 0 || tileX >= tile.width) continue;
          const src = y * ICON_WIDTH + x;
          const pixel = (icon[src >> 1]! >> (src % 2 === 0 ? 4 : 0)) & 15;
          const dst = (entry.line * ROW_HEIGHT + y) * tile.width + tileX;
          data[dst >> 1]! |= pixel << (dst % 2 === 0 ? 4 : 0);
        }
    }
    return Buffer.from(data).toString('hex');
  });
  if (frameCache.size >= 64) frameCache.delete(frameCache.keys().next().value!);
  frameCache.set(key, result);
  return result;
}
// Application-specific presentation lives on the PC. The client receives only generic elements.
export function agentScene(
  rows: DisplayIconRow[],
  footer: string,
  online = true,
  clock = ' ',
  usage?: UsageSnapshot,
): Scene {
  const entries = agentFlow(rows);
  const height = entries.length ? (entries.at(-1)!.line + 1) * ROW_HEIGHT : 0;
  const top = 288 - height;
  const elements: SceneElement[] = [
    {
      type: 'text',
      id: 'clock',
      x: 0,
      y: 0,
      width: usage ? 300 : 576,
      // G2 needs a 28px line box in addition to vertical padding.
      height: usage ? (footer ? 64 : 36) : 56,
      text: footer ? `${clock}\n${footer}` : clock,
      padding: 4,
      border: 0,
      brightness: 4,
    },
  ];
  if (usage) {
    for (const [provider, x, width, text] of [
      [
        'claude',
        326,
        166,
        `5H ${usageText(online ? windowRemaining(usage.claude, 300) : null)} W ${usageText(online ? windowRemaining(usage.claude, 10080) : null)}`,
      ],
      [
        'codex',
        512,
        64,
        usageText(online ? usage.codex.remainingPercent : null),
      ],
    ] as const) {
      elements.push({
        type: 'text',
        id: `usage-${provider}`,
        x,
        y: 0,
        width,
        height: 36,
        text,
        padding: 4,
        border: 0,
        brightness: 4,
      });
    }
  }
  for (let half = 0; entries.length && half < 2; half++) {
    const start = half * 288;
    const end = start + 288;
    const group = entries.filter((e) => e.x < end && e.x + ICON_WIDTH > start);
    if (!group.length) continue;
    const left = Math.max(start, Math.min(...group.map((e) => e.x)));
    const right = Math.min(
      end,
      Math.max(...group.map((e) => e.x + ICON_WIDTH)),
    );
    const width = Math.max(20, Math.ceil((right - left) / 2) * 2);
    const tile = { x: Math.min(left, end - width), width };
    elements.push({
      type: 'image',
      id: `icons-${half}`,
      x: tile.x,
      y: top,
      width: tile.width,
      height,
      frames: frames(group, tile, height, online),
      frameMs: FRAME_MS,
      loop: true,
    });
  }
  elements.push(
    ...entries.map((entry, index): SceneElement => ({
      type: 'text',
      id: `row-${index}`,
      x: entry.x + LABEL_X,
      y: top + entry.line * ROW_HEIGHT,
      // Let the label use the inter-item gap, or all remaining space at line end.
      // Its container still ends before the next icon and cannot cover it.
      width:
        (entries[index + 1]?.line === entry.line
          ? entries[index + 1]!.x
          : 576) -
        entry.x -
        LABEL_X,
      height: ROW_HEIGHT,
      text: entry.text,
      padding: 0,
      border: 0,
      brightness: 4,
    })),
  );
  const header = usage ? headerUsageFrames(!!footer, online) : undefined;
  const rules: SceneElement[] = [];
  for (let half = 0; half < 2; half++)
    rules.push({
      type: 'image',
      id: `header-rule-${half}`,
      x: half * 288,
      y: header ? 0 : footer ? 60 : 32,
      width: 288,
      height: header?.height ?? 20,
      frames: [header?.frames[half] ?? ruleFrame],
      frameMs: FRAME_MS,
      loop: false,
    });
  // Header bitmaps are behind the native text; label bounds exclude the icons.
  return {
    elements: header ? [...rules, ...elements] : [...elements, ...rules],
  };
}
