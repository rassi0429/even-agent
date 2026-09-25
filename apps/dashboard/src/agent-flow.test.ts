import { expect, it } from 'vitest';
import { getTextWidth } from '@evenrealities/pretext';
import { sceneSchema, type DisplayIconRow } from '@even-agent/protocol';
import { agentFlow, agentFlowPages } from './agent-flow.js';
import { agentScene } from './agent-scene.js';

const row = (text: string): DisplayIconRow => ({
  text,
  icon: 'running',
  agent: 'codex',
});
it('flows complete tasks left-to-right, wraps to another bottom-aligned line and retains readable labels', () => {
  const rows = [
    row('even-agent'),
    row('launcher'),
    row('日本語プロジェクト'.repeat(3)),
  ];
  const entries = agentFlow(rows);
  expect(entries[0]!.line).toBe(0);
  expect(entries[1]!.line).toBe(0);
  expect(entries[1]!.x).toBeGreaterThan(entries[0]!.x + entries[0]!.width);
  expect(entries[2]!.line).toBe(1);
  expect(entries[2]!.x).toBe(0);
  const scene = sceneSchema.parse(agentScene(rows, ''));
  const labels = scene.elements.filter(
    (e) => e.type === 'text' && e.id.startsWith('row-'),
  );
  expect(labels.map((e) => e.y)).toEqual([232, 232, 260]);
  for (const entry of entries) {
    expect(entry.x + entry.width).toBeLessThanOrEqual(576);
    expect(getTextWidth(entry.text)).toBeLessThan(entry.textWidth);
  }
});

it('keeps all entries across pages within native container and image limits, including offline frames', () => {
  const rows = Array.from({ length: 35 }, (_, i) =>
    row((i % 2 ? '長い名前'.repeat(30) : 'a') + ` #${i}`),
  );
  const pages = agentFlowPages(rows);
  expect(pages.flat()).toEqual(rows);
  for (const page of pages)
    for (const online of [true, false]) {
      const scene = sceneSchema.parse(
        agentScene(page, online ? '1/5' : 'OFFLINE', online),
      );
      expect(
        scene.elements.filter((e) => e.type === 'text').length,
      ).toBeLessThanOrEqual(8);
      expect(
        scene.elements.filter((e) => e.type === 'image').length,
      ).toBeLessThanOrEqual(4);
      const entries = agentFlow(page);
      expect(entries.at(-1)!.line).toBeLessThan(5);
      for (const [index, entry] of entries.entries())
        expect(entry.text.endsWith(page[index]!.text.match(/ #\d+$/)![0])).toBe(
          true,
        );
    }
});
