import { expect, it } from 'vitest';
import { emptyState, displaySchema } from '@even-agent/protocol';
import { composeAgentDisplay } from './display.js';
import { kokoaAgentSummary } from './agent-summary.js';
import type { AgentTask } from './agents.js';

it('combines only kokoa-agent sessions across providers into one G2 row', () => {
  const now = new Date();
  const tasks: AgentTask[] = Array.from({ length: 8 }, (_, i) => ({
    id: `nebi-${i}`,
    agent: i % 2 ? 'Claude' : 'Codex',
    surface: 'Code',
    project: 'kokoa-agent',
    status: i < 3 ? 'running' : 'done',
    updatedAt: now.getTime(),
    activity: 'individual activity',
  }));
  tasks.push({ ...tasks[0]!, id: 'other', project: 'even-agent' });
  const display = displaySchema.parse(
    composeAgentDisplay(
      emptyState(),
      {
        tasks,
        sources: { codex: 'ok', claude: 'ok' },
        observedAt: now.getTime(),
      },
      now,
    ),
  );
  const page = display.pages[0]!;
  expect(page.iconRows).toHaveLength(2);
  const labels = page.scene!.elements.flatMap((e) =>
    e.type === 'text' ? [e.text] : [],
  );
  expect(labels.join('\n')).toContain('agent  💪3 ✅5');
  expect(labels.join('\n')).toContain('even-agent  individual activity');
  expect(labels.join('\n')).not.toContain('kokoa-agent');
  expect(page.content).toContain('agent 💪3 ✅5');
  expect(page.content.match(/💪3/g)).toHaveLength(1);
  expect(kokoaAgentSummary([tasks.at(-1)!])).toBeUndefined();
  expect(
    kokoaAgentSummary([
      { ...tasks[0]!, status: 'unknown' },
      { ...tasks[1]!, status: 'failed' },
    ])?.text,
  ).toBe('agent 💪0 ✅0 失敗1 不明1');
});
