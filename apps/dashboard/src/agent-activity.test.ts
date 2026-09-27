import { expect, it } from 'vitest';
import {
  activityText,
  claudeActivity,
  codexActivity,
} from './agent-activity.js';
import { parseClaudeEvents, visibleTask } from './agents.js';

it('extracts visible speech/tool labels and never exposes reasoning, tool arguments or output', () => {
  expect(
    codexActivity({
      type: 'agentMessage',
      phase: 'commentary',
      text: 'テストを実行します',
    }),
  ).toBe('テストを実行します');
  expect(
    codexActivity({ type: 'agentMessage', phase: 'analysis', text: 'PRIVATE' }),
  ).toBeUndefined();
  expect(codexActivity({ type: 'reasoning', text: 'PRIVATE' })).toBeUndefined();
  expect(
    codexActivity({
      type: 'commandExecution',
      status: 'inProgress',
      command: 'secret command',
      aggregatedOutput: 'PRIVATE',
    }),
  ).toBe('コマンド実行中');
  expect(
    codexActivity({
      type: 'fileChange',
      path: 'C:/work/src/app.ts',
      diff: 'PRIVATE',
    }),
  ).toBe('ファイル編集: app.ts');
  expect(
    claudeActivity({
      content: [
        { type: 'thinking', thinking: 'PRIVATE' },
        { type: 'text', text: '修正しています' },
      ],
    }),
  ).toBe('修正しています');
  expect(
    claudeActivity({
      content: [
        {
          type: 'tool_use',
          name: 'Read',
          input: { file_path: 'C:/private/src/test.ts', content: 'PRIVATE' },
        },
      ],
    }),
  ).toBe('ファイル読取: test.ts');
  expect(
    claudeActivity({
      content: [
        { type: 'tool_use', name: 'Bash', input: { command: 'PRIVATE' } },
      ],
    }),
  ).toBe('コマンド実行');
});
it('bounds excerpts and removes common credentials, URLs and terminal controls', () => {
  const result = activityText(
    'api_key=abc password="secret words" Bearer 123456 sk-test-secret https://example.test/?token=xxx\nnext\u001b[31m',
  )!;
  expect(result).not.toMatch(
    /abc|secret words|123456|sk-test-secret|example.test|xxx|\n/,
  );
  expect(result).toContain('[redacted]');
  expect(activityText('あ'.repeat(4000))).toHaveLength(160);
});
it('keeps tool activity across tool results and clears it on a new turn, completion or stale status', () => {
  const now = Date.now();
  const event = (type: string, message: unknown, offset: number) => ({
    type,
    message,
    timestamp: new Date(now + offset).toISOString(),
    sessionId: 'session',
    cwd: 'C:/work/project',
  });
  const speech = event(
    'assistant',
    { content: [{ type: 'text', text: 'ファイルを確認します' }] },
    0,
  );
  const tool = event(
    'assistant',
    {
      content: [
        { type: 'tool_use', name: 'Read', input: { file_path: 'src/app.ts' } },
      ],
    },
    1,
  );
  const result = event(
    'user',
    { content: [{ type: 'tool_result', content: 'PRIVATE OUTPUT' }] },
    2,
  );
  const events = [speech, tool, result];
  const task = parseClaudeEvents(events, 'session', 'Code')!;
  expect(task.activity).toBe('ファイル読取: app.ts');
  expect(JSON.stringify(task)).not.toContain('PRIVATE');
  expect(
    parseClaudeEvents(
      [...events, event('user', { content: 'PRIVATE PROMPT' }, 3)],
      'session',
      'Code',
    )?.activity,
  ).toBeUndefined();
  expect(
    parseClaudeEvents(
      [
        ...events,
        event('assistant', { content: '最終回答', stop_reason: 'end_turn' }, 4),
      ],
      'session',
      'Code',
    )?.activity,
  ).toBeUndefined();
  expect(visibleTask(task, now + 200000)).toMatchObject({ status: 'unknown' });
  expect(visibleTask(task, now + 200000)?.activity).toBeUndefined();
});
