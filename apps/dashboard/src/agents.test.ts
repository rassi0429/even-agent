import { afterEach, expect, it } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { emptyState, displaySchema } from '@even-agent/protocol';
import {
  LocalAgentMonitor,
  parseClaudeEvents,
  readTail,
  visibleTask,
  type AgentSnapshot,
  type AgentTask,
} from './agents.js';
import { composeAgentDisplay } from './display.js';

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(
    dirs.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});
const now = 1790311200000;
const task: AgentTask = {
  id: 'one',
  agent: 'Claude',
  surface: 'Code',
  project: 'project',
  status: 'running',
  updatedAt: now,
};
const event = (type: string, message: unknown, timestamp = now) => ({
  type,
  message,
  timestamp: new Date(timestamp).toISOString(),
  cwd: 'C:\\work\\project',
  sessionId: 'one',
});

it('uses Claude event time rather than file mtime and never emits message content', () => {
  const events = [
    event('user', { content: 'PRIVATE PROMPT' }, now - 1000),
    event('assistant', {
      content: [
        {
          type: 'tool_use',
          name: 'AskUserQuestion',
          input: { question: 'PRIVATE QUESTION' },
        },
      ],
      stop_reason: 'tool_use',
    }),
  ];
  const waiting = parseClaudeEvents(events, 'fallback', 'Code')!;
  expect(waiting.status).toBe('waiting');
  expect(JSON.stringify(waiting)).not.toContain('PRIVATE');
  const running = parseClaudeEvents(
    [
      ...events,
      event(
        'user',
        { content: [{ type: 'tool_result', content: 'answer' }] },
        now + 1000,
      ),
    ],
    'fallback',
    'Code',
  )!;
  expect(running.status).toBe('running');
  const done = parseClaudeEvents(
    [
      ...events,
      event(
        'assistant',
        { stop_reason: 'end_turn', content: 'PRIVATE OUTPUT' },
        now + 2000,
      ),
      {
        type: 'queue-operation',
        timestamp: new Date(now + 9000).toISOString(),
      },
    ],
    'fallback',
    'Code',
  )!;
  expect(done.status).toBe('done');
  expect(done.updatedAt).toBe(now + 2000);
  expect(visibleTask(done, done.updatedAt + 899_999)?.status).toBe('done');
  expect(visibleTask(done, done.updatedAt + 900_000)).toBeUndefined();
  expect(visibleTask(task, now + 200_000)?.status).toBe('unknown');
  expect(visibleTask(task, now + 1_900_000)).toBeUndefined();
});

it('reads incomplete and bounded transcript tails without failing', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'even-tail-'));
  dirs.push(dir);
  const path = join(dir, 'events.jsonl');
  await writeFile(
    path,
    `${'x'.repeat(1024)}\n${JSON.stringify(event('assistant', { stop_reason: 'end_turn' }))}\n{"incomplete":`,
  );
  const events = await readTail(path, 512);
  expect(events).toHaveLength(1);
  expect(parseClaudeEvents(events, 'fallback', 'Code')?.status).toBe('done');
});

it('reads current Codex turns and Claude Code/Cowork files without modifying their stores', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'even-agents-'));
  dirs.push(dir);
  const codex = join(dir, 'codex');
  await mkdir(codex);
  const db = new DatabaseSync(join(codex, 'state_5.sqlite'));
  db.exec(
    'CREATE TABLE threads(id TEXT,cwd TEXT,archived INTEGER,agent_path TEXT,updated_at INTEGER)',
  );
  db.prepare('INSERT INTO threads VALUES(?,?,0,NULL,?)').run(
    'thread',
    'C:\\work\\codex-project',
    now / 1000,
  );
  db.close();
  const history = new DatabaseSync(join(codex, 'thread_history_1.sqlite'));
  history.exec(
    'CREATE TABLE thread_turns(thread_id TEXT,turn_id TEXT,status TEXT,started_at INTEGER,completed_at INTEGER,rollout_ordinal INTEGER); CREATE TABLE thread_items(thread_id TEXT,turn_id TEXT,created_at_ms INTEGER,item_json TEXT,item_type TEXT,rollout_ordinal INTEGER)',
  );
  history
    .prepare('INSERT INTO thread_turns VALUES(?,?,?,?,NULL,1)')
    .run('thread', 'turn', 'inProgress', now / 1000);
  history.prepare('INSERT INTO thread_items VALUES(?,?,?,?,?,?)').run(
    'thread',
    'turn',
    now,
    JSON.stringify({
      type: 'agentMessage',
      phase: 'commentary',
      text: 'テストを確認しています',
    }),
    'agentMessage',
    1,
  );
  history
    .prepare('INSERT INTO thread_items VALUES(?,?,?,?,?,?)')
    .run(
      'thread',
      'turn',
      now,
      JSON.stringify({ type: 'reasoning', text: 'PRIVATE REASONING' }),
      'reasoning',
      2,
    );
  history.close();
  const cli = join(dir, 'claude');
  const desktop = join(dir, 'desktop');
  const cowork = join(
    desktop,
    'local-agent-mode-sessions/account/org/local_session/.claude',
  );
  for (const home of [cli, cowork]) {
    const folder = join(home, 'projects/project');
    await mkdir(folder, { recursive: true });
    await writeFile(
      join(folder, 'session.jsonl'),
      JSON.stringify({
        ...event('user', { content: 'private' }),
        sessionId: home === cli ? 'cli' : 'cowork',
      }) + '\n',
    );
  }
  const monitor = new LocalAgentMonitor(
    { codexHome: codex, claudeHomes: [cli], claudeDesktopRoots: [desktop] },
    () => now,
  );
  const first = await monitor.read();
  expect(first.sources).toEqual({ codex: 'ok', claude: 'ok' });
  expect(first.tasks.find((t) => t.agent === 'Codex')?.activity).toBe(
    'テストを確認しています',
  );
  expect(JSON.stringify(first)).not.toContain('PRIVATE REASONING');
  expect(first.tasks.map((t) => t.surface).sort()).toEqual([
    'Code',
    'Cowork',
    'local',
  ]);
  // Reopening a historical file must not make an old session live.
  await writeFile(
    join(cli, 'projects/project/session.jsonl'),
    JSON.stringify(
      event('assistant', { stop_reason: 'end_turn' }, now - 900_000),
    ) + '\n',
  );
  const next = await monitor.read();
  expect(next.tasks.filter((t) => t.agent === 'Claude')).toHaveLength(1);
  const verify = new DatabaseSync(join(codex, 'state_5.sqlite'), {
    readOnly: true,
  });
  expect(
    verify.prepare('SELECT count(*) AS count FROM threads').get()?.count,
  ).toBe(1);
  verify.close();
});

it('isolates source failures and explicitly reports unavailable Codex data', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'even-missing-'));
  dirs.push(dir);
  const monitor = new LocalAgentMonitor(
    { codexHome: dir, claudeHomes: [], claudeDesktopRoots: [] },
    () => now,
  );
  const snapshot = await monitor.read();
  expect(snapshot.sources.codex).toBe('unavailable');
  expect(snapshot.tasks).toEqual([]);
});

it('fits one-line tasks into pages, prioritizes attention, and preserves all tasks', () => {
  const snapshot: AgentSnapshot = {
    observedAt: now,
    sources: { codex: 'ok', claude: 'ok' },
    tasks: Array.from({ length: 20 }, (_, i) => ({
      ...task,
      id: `task-${i}`,
      project: `${i}日本語`.repeat(30),
      status: i === 19 ? 'waiting' : 'running',
    })),
  };
  const display = displaySchema.parse(
    composeAgentDisplay(emptyState(), snapshot, new Date(now)),
  );
  expect(display.pages).toHaveLength(3);
  expect(
    display.pages.flatMap((page) =>
      page.scene!.elements.flatMap((e) =>
        e.type === 'text' && /^(column|running)-/.test(e.id)
          ? e.text
              .split('\n')
              .filter((line) => line.trim() && line !== '処理中…')
          : [],
      ),
    ),
  ).toHaveLength(20);
  expect(display.pages[0]?.content.split('\n')[1]).toContain('確認待ち');
  for (const page of display.pages) {
    expect(page.content.split('\n')[0]).toBe('2026/9/25 金 13:40');
    expect(page.content).not.toMatch(/LIVE|NOW|SOON|WAITING|稼働記録なし/);
    const taskRows = page.scene!.elements.filter((e) =>
      e.id.startsWith('column-'),
    );
    for (const column of taskRows) {
      expect(column.y + column.height).toBeLessThanOrEqual(288);
      expect(column.y).toBeGreaterThan(66);
    }
    expect(page.offlineContent.split('\n').length).toBeLessThanOrEqual(19);
    expect(Buffer.byteLength(page.offlineContent)).toBeLessThan(1000);
  }
});
