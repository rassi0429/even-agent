import { expect, it } from 'vitest';
import { displaySchema, emptyState } from '@even-agent/protocol';
import { AgentDisplayOrder } from './agent-order.js';
import { composeAgentDisplay } from './display.js';
import type { AgentTask } from './agents.js';

const now = 1790311200000;
const task = (
  id: string,
  status: AgentTask['status'] = 'running',
): AgentTask => ({
  id,
  project: id,
  agent: 'Codex',
  surface: 'local',
  status,
  updatedAt: now,
  activity: `${id}のメッセージ`,
});

it('keeps running order across updates, input reshuffles, discoveries and brief source failures', () => {
  const order = new AgentDisplayOrder();
  const a = task('alpha'),
    b = task('beta');
  const ids = (tasks: AgentTask[], time = now) =>
    order.sort(tasks, time).map((t) => t.id);
  expect(ids([b, a])).toEqual(['alpha', 'beta']);
  expect(ids([{ ...b, updatedAt: now + 10_000 }, a], now + 10_000)).toEqual([
    'alpha',
    'beta',
  ]);
  expect(ids([task('aardvark'), b, a])).toEqual(['alpha', 'beta', 'aardvark']);
  expect(ids([])).toEqual([]);
  expect(ids([b, a])).toEqual(['alpha', 'beta']);
  expect(ids([b, a, task('waiting', 'waiting')])).toEqual([
    'waiting',
    'alpha',
    'beta',
  ]);
});

it('retains completion in place with its last message for exactly one minute, then packs it below running tasks', () => {
  const order = new AgentDisplayOrder();
  const a = task('alpha'),
    b = task('beta');
  const render = (tasks: AgentTask[], time: number) =>
    displaySchema.parse(
      composeAgentDisplay(
        emptyState(),
        { tasks, observedAt: time, sources: { codex: 'ok', claude: 'ok' } },
        new Date(time),
        undefined,
        undefined,
        order,
      ),
    );
  const body = (display: ReturnType<typeof render>) =>
    display.pages.flatMap((p) =>
      p.scene!.elements.filter(
        (e) => e.type === 'text' && /^(running|column)-/.test(e.id),
      ),
    );
  render([a, b], now);
  const finished = {
    ...a,
    status: 'done' as const,
    updatedAt: now + 1000,
    activity: '修正が完了しました',
  };
  for (const elapsed of [0, 59_999]) {
    const display = render([b, finished], finished.updatedAt + elapsed);
    expect(body(display)[0]).toMatchObject({
      width: 524,
      text: 'alpha  修正が完了しました\nbeta  betaのメッセージ',
    });
    expect(display.pages[0]!.iconRows?.map((r) => r.icon)).toEqual([
      'done',
      'running',
    ]);
  }
  const expired = render([b, finished], finished.updatedAt + 60_000);
  expect(body(expired)[0]).toMatchObject({
    width: 524,
    text: 'beta  betaのメッセージ',
  });
  expect(body(expired)[1]).toMatchObject({ width: 236, text: 'alpha' });
  expect(JSON.stringify(expired)).not.toContain('修正が完了しました');
  const resumed = render(
    [b, { ...a, updatedAt: now + 62_000, activity: '次の作業' }],
    now + 62_000,
  );
  expect(body(resumed)[0]).toMatchObject({
    text: 'alpha  次の作業\nbeta  betaのメッセージ',
  });
});
