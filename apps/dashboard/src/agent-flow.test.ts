import { expect, it } from 'vitest';
import { getTextWidth, measureTextWrap } from '@evenrealities/pretext';
import {
  sceneSchema,
  displaySchema,
  emptyState,
  type DisplayIconRow,
} from '@even-agent/protocol';
import {
  agentFlow,
  agentFlowPages,
  flowLines,
  type AgentDisplayRow,
} from './agent-flow.js';
import { agentScene } from './agent-scene.js';
import { composeAgentDisplay } from './display.js';

const row = (text: string): DisplayIconRow => ({
  text,
  icon: 'done',
  agent: 'codex',
});
it('reserves three full-width running rows beside the summary, Nebi and quota header even under overflow', () => {
  const now = new Date();
  const base = {
    agent: 'Codex' as const,
    surface: 'local',
    updatedAt: now.getTime(),
  };
  const usage = {
    status: 'ok' as const,
    remainingPercent: 80,
    windows: [],
    observedAt: now.getTime(),
  };
  for (const count of [1, 2, 3, 4, 8]) {
    const display = displaySchema.parse(
      composeAgentDisplay(
        emptyState(),
        {
          sources: { codex: 'ok', claude: 'ok' },
          observedAt: now.getTime(),
          tasks: [
            {
              ...base,
              id: 'summary',
              project: 'kokoa-agent',
              status: 'running',
            },
            ...Array.from({ length: 6 }, (_, i) => ({
              ...base,
              id: `waiting-${i}`,
              project: `waiting-${i}`,
              status: 'waiting' as const,
            })),
            ...Array.from({ length: count }, (_, i) => ({
              ...base,
              id: `active-${i}`,
              project: `active-${i}`,
              status: 'running' as const,
              agent: i % 2 ? ('Claude' as const) : ('Codex' as const),
              activity: '作業の進捗メッセージ',
            })),
            {
              ...base,
              id: 'completed',
              project: 'completed',
              status: 'done',
              activity: '完了直後の回答',
            },
          ],
        },
        now,
        undefined,
        { codex: usage, claude: usage },
        undefined,
        { online: 'Nebiのお知らせ', offline: '配信停止' },
      ),
    );
    expect(display.pages).toHaveLength(1);
    const page = display.pages[0]!;
    const active = page.iconRows!.filter(
      (r) => r.agent !== 'none' && r.icon === 'running',
    );
    expect(active).toHaveLength(Math.min(3, count));
    expect(page.iconRows).toHaveLength(5);
    expect(page.iconRows!.at(-1)!.text).toBe(`Agent +${count + 4}件`);
    for (const scene of [page.scene!, page.offlineScene!]) {
      const text = scene.elements.filter((e) => e.type === 'text');
      expect(text.length).toBeLessThanOrEqual(8);
      expect(text.some((e) => e.id === 'nebi-middle')).toBe(true);
      expect(text.filter((e) => e.id.startsWith('summary-'))).toHaveLength(3);
      const body = text.find((e) => e.id.startsWith('running-'))!;
      expect(body.width).toBe(524);
      expect(body.y).toBeGreaterThanOrEqual(144);
      expect(body.y + body.height).toBe(288);
      expect(measureTextWrap(body.text, body.width).height).toBeLessThanOrEqual(
        body.height,
      );
      for (const entry of active)
        expect(body.text).toContain(`${entry.text}  作業の進捗メッセージ`);
      expect(body.text).not.toMatch(/Agent \+\d+件 {2}処理中/);
    }
  }
});
it('keeps the quiet middle empty even when many agents overflow', () => {
  const display = composeAgentDisplay(
    emptyState(),
    {
      observedAt: Date.now(),
      sources: { codex: 'ok', claude: 'ok' },
      tasks: Array.from({ length: 20 }, (_, i) => ({
        id: `quiet-${i}`,
        agent: 'Codex' as const,
        surface: 'Code',
        project: `project-${i}`,
        status: 'done' as const,
        updatedAt: Date.now(),
      })),
    },
    new Date(),
    undefined,
    undefined,
    undefined,
    { online: '', offline: '配信停止' },
  );
  expect(display.pages).toHaveLength(1);
  const scene = display.pages[0]!.scene!;
  expect(scene.elements.some((e) => e.id === 'nebi-middle')).toBe(false);
  const overflow = scene.elements.find(
    (e) => e.type === 'text' && e.text.includes('Agent +'),
  )!;
  expect(overflow.y).toBeGreaterThanOrEqual(144);
  expect(sceneSchema.safeParse(scene).success).toBe(true);
});
it('keeps Nebi and agents on one page with agents confined to the lower half', () => {
  const now = new Date();
  const value = {
    status: 'ok' as const,
    remainingPercent: 80,
    windows: [],
    observedAt: now.getTime(),
  };
  const display = displaySchema.parse(
    composeAgentDisplay(
      emptyState(),
      {
        observedAt: now.getTime(),
        sources: { codex: 'ok', claude: 'ok' },
        tasks: Array.from({ length: 20 }, (_, i) => ({
          id: `test-${i}`,
          agent: 'Codex' as const,
          surface: 'Code',
          project: `project-${i}`,
          status: i % 3 === 0 ? ('running' as const) : ('done' as const),
          updatedAt: now.getTime() - 60_000,
        })),
      },
      now,
      undefined,
      { claude: value, codex: value },
      undefined,
      {
        online:
          'Nebi 09/27 17:30 / 他2件\nTODO 段ボールをまとめる\nTODO 明日の準備',
        offline: 'Nebi OFFLINE\n更新待ち\n最終取得 17:30',
      },
    ),
  );
  expect(display.pages).toHaveLength(1);
  expect(display.pages[0]!.content).toContain('Agent +');
  for (const scene of [
    display.pages[0]!.scene!,
    display.pages[0]!.offlineScene!,
  ]) {
    expect(sceneSchema.safeParse(scene).success).toBe(true);
    for (const element of scene.elements) {
      if (element.type !== 'text') continue;
      if (/^(running|column)-/.test(element.id))
        expect(element.y).toBeGreaterThanOrEqual(144);
      if (element.id === 'nebi-middle') {
        expect(element.y).toBeGreaterThanOrEqual(40);
        expect(element.y + element.height).toBeLessThanOrEqual(144);
        expect(
          measureTextWrap(element.text, element.width).height,
        ).toBeLessThanOrEqual(element.height);
      }
    }
  }
});
it('transports all tasks in 16-entry pages without exceeding legacy iconRows limits', () => {
  for (const count of [0, 1, 8, 9, 16, 17, 33]) {
    const display = displaySchema.parse(
      composeAgentDisplay(emptyState(), {
        observedAt: Date.now(),
        sources: { codex: 'ok', claude: 'ok' },
        tasks: Array.from({ length: count }, (_, i) => ({
          id: `task-${i}`,
          agent: 'Codex' as const,
          surface: 'Code',
          project: `project-${i}`,
          status: 'done' as const,
          updatedAt: Date.now() - 60_000,
        })),
      }),
    );
    expect(display.pages.length).toBe(Math.max(1, Math.ceil(count / 16)));
    const labels = display.pages.flatMap((page) =>
      page.scene!.elements.flatMap((e) =>
        e.type === 'text' && e.id.startsWith('column-')
          ? e.text.split('\n').filter((line) => line.trim())
          : [],
      ),
    );
    expect(labels.length).toBe(count);
    expect(new Set(labels).size).toBe(count);
    for (let i = 0; i < count; i++) expect(labels).toContain(`project-${i}`);
  }
});
it('packs tasks into bottom-aligned native text columns and retains readable labels', () => {
  const rows = [
    row('even-agent'),
    row('launcher'),
    row('日本語プロジェクト'.repeat(3)),
  ];
  const entries = agentFlow(rows);
  expect(entries[0]!.line).toBe(0);
  expect(entries[1]!.line).toBe(0);
  expect(entries[1]!.x).toBe(entries[0]!.x + entries[0]!.width);
  expect(entries[2]!.line).toBe(1);
  expect(entries[2]!.x).toBe(0);
  const scene = sceneSchema.parse(agentScene(rows, ''));
  const labels = scene.elements.filter(
    (e) => e.type === 'text' && e.id.startsWith('column-'),
  );
  expect(labels.map((e) => e.y)).toEqual([234, 234]);
  expect(labels[0]).toMatchObject({
    text: `${entries[0]!.text}\n${entries[2]!.text}`,
  });
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
  expect(pages.map((page) => page.length)).toEqual([16, 16, 3]);
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
      expect(entries.at(-1)!.line).toBeLessThan(8);
      for (const element of scene.elements) {
        if (element.type === 'text' && element.id.startsWith('column-')) {
          expect(element.y).toBeGreaterThan(66);
          expect(element.y + element.height).toBe(288);
          expect(
            measureTextWrap(element.text, element.width).height,
          ).toBeLessThanOrEqual(element.height);
        }
      }
      const pixels = scene.elements
        .filter((e) => e.type === 'image')
        .reduce(
          (sum, e) => sum + e.frames.reduce((n, f) => n + f.length, 0),
          0,
        );
      expect(pixels).toBeLessThanOrEqual(1024 * 1024);
      for (const [index, entry] of entries.entries())
        expect(entry.text.endsWith(page[index]!.text.match(/ #\d+$/)![0])).toBe(
          true,
        );
    }
});

it('gives running tasks a full-width single line while retaining compact pairs and native limits', () => {
  for (const mode of ['running', 'mixed'] as const) {
    const rows: AgentDisplayRow[] = Array.from({ length: 35 }, (_, i) => ({
      ...row(`task-${i}`),
      icon: mode === 'running' || i % 3 === 0 ? 'running' : 'done',
      detail: `detail-${i}`,
    }));
    const pages = agentFlowPages(rows);
    expect(pages.flat()).toEqual(rows);
    if (mode === 'running')
      expect(pages.map((page) => page.length)).toEqual([8, 8, 8, 8, 3]);
    for (const page of pages) {
      const entries = agentFlow(page);
      expect(flowLines(entries)).toBeLessThanOrEqual(8);
      const scene = sceneSchema.parse(agentScene(page, '1/5'));
      for (const entry of entries) {
        const y = 288 - flowLines(entries) * 27 + entry.line * 27;
        const column = scene.elements.find(
          (e) =>
            e.type === 'text' &&
            e.id.startsWith(
              entry.wide ? 'running-' : `column-${entry.x / 288}-`,
            ) &&
            e.y <= y &&
            e.y + e.height > y,
        )!;
        if (column.type !== 'text') throw new Error('Expected native text');
        const lines = column.text.split('\n');
        expect(lines[(y - column.y) / 27]).toBe(entry.label);
        if (entry.row.icon === 'running') {
          expect(entry.x).toBe(0);
          expect(column.width).toBe(524);
          expect(entry.label).toContain(entry.row.detail);
          expect(getTextWidth(entry.text)).toBeLessThanOrEqual(144);
        } else expect(column.text).not.toContain(entry.row.detail!);
        expect(
          measureTextWrap(column.text, column.width).height,
        ).toBeLessThanOrEqual(column.height);
        expect(column.y).toBeGreaterThan(66);
      }
      expect(
        scene.elements.filter((e) => e.type === 'text').length,
      ).toBeLessThanOrEqual(8);
      const body = scene.elements.filter(
        (e) => e.type === 'text' && /^(running|column)-/.test(e.id),
      );
      for (const [i, a] of body.entries())
        for (const b of body.slice(i + 1))
          expect(
            a.x >= b.x + b.width ||
              b.x >= a.x + a.width ||
              a.y >= b.y + b.height ||
              b.y >= a.y + a.height,
          ).toBe(true);
    }
  }
});
