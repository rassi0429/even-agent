import type { Scene, SceneElement } from '@even-agent/protocol';
import { iconStrip, ICON_WIDTH, FRAME_MS } from './agent-icons.js';
import {
  agentFlow,
  LABEL_X,
  COLUMN_WIDTH,
  FLOW_LINE_HEIGHT,
  flowLines,
  flowGroups,
  type AgentDisplayRow,
} from './agent-flow.js';
import {
  headerUsageFrames,
  usageText,
  windowRemaining,
} from './header-usage.js';
import type { UsageSnapshot } from './usage.js';
const frameCache = new Map<string, string[][]>();
// Lower-left also holds the summary's inline status icons; text stays native.
// Four images cover the full screen while eight animation frames stay below 1 MiB.
const tiles = [
  { x: 0, y: 0, width: 288, height: 144 },
  { x: 288, y: 0, width: 288, height: 144 },
  { x: 0, y: 144, width: 168, height: 144 },
  { x: 288, y: 144, width: ICON_WIDTH, height: 144 },
];
function frames(
  entries: ReturnType<typeof agentFlow>,
  top: number,
  header: ReturnType<typeof headerUsageFrames> | undefined,
  footer: boolean,
  online: boolean,
) {
  const key = JSON.stringify([
    entries.map(({ row, x, line }) => [
      row.icon,
      row.agent,
      x,
      line,
      row.summary ? row.summary.running > 0 : null,
    ]),
    top,
    !!header,
    footer,
    online,
  ]);
  const cached = frameCache.get(key);
  if (cached) return cached;
  const moving = online && entries.some((e) => e.row.icon === 'running');
  const result = tiles.map(() => [] as string[]);
  for (let frame = 0; frame < (moving ? 8 : 1); frame++) {
    const pixels = tiles.map((t) => new Uint8Array(t.width * t.height));
    const pixel = (x: number, y: number, level: number) => {
      const tileIndex = (y >= 144 ? 2 : 0) + Math.floor(x / 288);
      const tile = tiles[tileIndex]!;
      if (
        x < tile.x ||
        x >= tile.x + tile.width ||
        y < tile.y ||
        y >= tile.y + tile.height
      )
        return;
      pixels[tileIndex]![(y - tile.y) * tile.width + x - tile.x] = level;
    };
    if (header) {
      header.frames.forEach((data, half) => {
        for (let i = 0; i < data.length; i++)
          pixel(
            half * 288 + (i % 288),
            Math.floor(i / 288),
            parseInt(data[i]!, 16),
          );
      });
    } else {
      for (let x = 0; x < 576; x++) pixel(x, footer ? 66 : 38, 8);
    }
    for (const entry of entries) {
      if (entry.row.summary) {
        for (const [icon, left] of [
          [entry.row.summary.running ? 'running' : 'unknown', 68],
          ['done', 144],
        ] as const) {
          const strip = iconStrip(
            [{ text: '', icon, agent: 'none' }],
            0,
            frame,
            online,
          );
          for (let y = 0; y < FLOW_LINE_HEIGHT; y++)
            for (let x = 0; x < 24; x++) {
              const src = y * ICON_WIDTH + x;
              pixel(
                left + x,
                top + entry.line * FLOW_LINE_HEIGHT + y,
                (strip[src >> 1]! >> (src % 2 === 0 ? 4 : 0)) & 15,
              );
            }
        }
        continue;
      }
      const icon = iconStrip([entry.row], 0, frame, online);
      for (let y = 0; y < FLOW_LINE_HEIGHT; y++)
        for (let x = 0; x < ICON_WIDTH; x++) {
          const src = y * ICON_WIDTH + x;
          pixel(
            entry.x + x,
            top + entry.line * FLOW_LINE_HEIGHT + y,
            (icon[src >> 1]! >> (src % 2 === 0 ? 4 : 0)) & 15,
          );
        }
    }
    pixels.forEach((data, tileIndex) => {
      const packed = new Uint8Array(data.length / 2);
      for (let i = 0; i < data.length; i += 2)
        packed[i / 2] = (data[i]! << 4) | data[i + 1]!;
      result[tileIndex]!.push(Buffer.from(packed).toString('hex'));
    });
  }
  if (frameCache.size >= 16) frameCache.delete(frameCache.keys().next().value!);
  frameCache.set(key, result);
  return result;
}
// Application-specific presentation lives on the PC. The client receives only generic elements.
export function agentScene(
  rows: AgentDisplayRow[],
  footer: string,
  online = true,
  clock = ' ',
  usage?: UsageSnapshot,
  middle?: string,
): Scene {
  const entries = agentFlow(rows);
  const lines = flowLines(entries);
  const height = lines * FLOW_LINE_HEIGHT;
  const top = 288 - height;
  const header = usage ? headerUsageFrames(!!footer, online) : undefined;
  const bitmaps = frames(entries, top, header, !!footer, online);
  const elements: SceneElement[] = tiles.map((tile, index) => ({
    type: 'image',
    id: index < 2 ? `header-rule-${index}` : `icons-${index - 2}`,
    ...tile,
    frames: bitmaps[index]!,
    frameMs: FRAME_MS,
    loop: true,
  }));
  elements.push({
    type: 'text',
    id: 'clock',
    x: 0,
    y: 0,
    width: usage ? 300 : 576,
    height: footer ? 64 : 36,
    text: footer ? `${clock}\n${footer}` : clock,
    padding: 4,
    border: 0,
    brightness: 4,
  });
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
    ] as const)
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
  if (middle)
    elements.push({
      type: 'text',
      id: 'nebi-middle',
      x: 8,
      y: 48,
      width: 560,
      height: 90,
      text: middle,
      padding: 0,
      border: 0,
      brightness: 4,
    });
  for (const [index, block] of flowGroups(entries).entries()) {
    const first = block[0]!;
    if (first.row.summary) {
      const counts = first.row.summary;
      for (const [name, x, width, text] of [
        ['name', 0, 64, 'agent'],
        ['running', 96, 44, String(counts.running)],
        [
          'done',
          172,
          404,
          [String(counts.done), counts.other].filter(Boolean).join(' '),
        ],
      ] as const)
        elements.push({
          type: 'text',
          id: `summary-${name}`,
          x,
          y: top + first.line * FLOW_LINE_HEIGHT,
          width,
          height: FLOW_LINE_HEIGHT,
          text,
          padding: 0,
          border: 0,
          brightness: 4,
        });
      continue;
    }
    const blockLines = block.at(-1)!.line - first.line + 1;
    for (let column = 0; column < (first.wide ? 1 : 2); column++) {
      const group = block.filter((e) => e.x === column * COLUMN_WIDTH);
      if (!group.length) continue;
      const content = Array<string>(blockLines).fill(' ');
      for (const entry of group) content[entry.line - first.line] = entry.label;
      elements.push({
        type: 'text',
        id: first.wide ? `running-${index}` : `column-${column}-${index}`,
        x: column * COLUMN_WIDTH + LABEL_X,
        y: top + first.line * FLOW_LINE_HEIGHT,
        width: (first.wide ? 576 : COLUMN_WIDTH) - LABEL_X,
        height: blockLines * FLOW_LINE_HEIGHT,
        text: content.join('\n'),
        padding: 0,
        border: 0,
        brightness: 4,
      });
    }
  }
  return { elements };
}
