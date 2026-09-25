import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { emptyState } from '@even-agent/protocol';
import {
  ClaudeCloudMonitor,
  CombinedAgentMonitor,
  parseCloudSessions,
} from './claude-cloud.js';
import { composeAgentDisplay } from './display.js';

const now = 1790311200000;
const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(
    dirs.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});
const session = (extra = {}) => ({
  id: 'cloud-one',
  status: 'active',
  worker_status: 'running',
  environment_kind: 'anthropic_cloud',
  last_event_at: new Date(now - 600_000).toISOString(),
  title: 'PRIVATE PROMPT',
  config: {
    sources: [
      { type: 'git_repository', url: 'https://github.com/owner/launcher.git' },
    ],
  },
  ...extra,
});
async function credentials(expiresAt = now + 3600_000) {
  const dir = await mkdtemp(join(tmpdir(), 'g2-cloud-'));
  dirs.push(dir);
  const path = join(dir, 'credentials.json');
  await writeFile(
    path,
    JSON.stringify({
      claudeAiOauth: {
        accessToken: 'TEST-TOKEN',
        refreshToken: 'TEST-REFRESH',
        expiresAt,
      },
    }),
  );
  return path;
}

it('maps cloud states without duplicating local bridge sessions or reviving old completion', () => {
  const tasks = parseCloudSessions(
    {
      data: [
        session(),
        session({ id: 'wait', worker_status: 'requires_action' }),
        session({
          id: 'done',
          worker_status: 'idle',
          last_event_at: new Date(now).toISOString(),
        }),
        session({
          id: 'old-done',
          worker_status: 'idle',
          last_event_at: new Date(now - 900_000).toISOString(),
        }),
        session({ id: 'local', environment_kind: 'bridge' }),
        session({ id: 'archived', status: 'archived' }),
        session({ id: 'future-status', worker_status: 'new-state' }),
        session({
          id: 'failed',
          status: 'failed',
          last_event_at: new Date(now).toISOString(),
        }),
      ],
    },
    now,
  );
  expect(tasks.map((t) => [t.id, t.status])).toEqual([
    ['cloud-one', 'running'],
    ['wait', 'waiting'],
    ['done', 'done'],
    ['future-status', 'unknown'],
    ['failed', 'failed'],
  ]);
  expect(
    tasks.every((t) => t.project === 'launcher' && t.surface === 'Cloud'),
  ).toBe(true);
  expect(JSON.stringify(tasks)).not.toMatch(/PRIVATE|github|owner/);
  expect(() => parseCloudSessions({}, now)).toThrow('invalid-schema');
});

it('uses fixed-origin read-only auth, caches for 30 seconds, and ages terminal rows', async () => {
  let clock = now;
  const request = vi.fn<typeof fetch>().mockResolvedValue(
    new Response(
      JSON.stringify({
        data: [
          session({
            worker_status: 'idle',
            last_event_at: new Date(now).toISOString(),
          }),
        ],
      }),
    ),
  );
  const cloud = new ClaudeCloudMonitor(
    await credentials(),
    request,
    () => clock,
  );
  await Promise.all([cloud.refresh(), cloud.refresh()]);
  expect(request).toHaveBeenCalledTimes(1);
  expect(request.mock.calls[0]![0]).toBe(
    'https://api.anthropic.com/v1/code/sessions?limit=100',
  );
  expect(request.mock.calls[0]![1]).toMatchObject({
    method: 'GET',
    redirect: 'error',
    headers: { Authorization: 'Bearer TEST-TOKEN' },
  });
  expect(cloud.snapshot().source).toBe('ok');
  expect(JSON.stringify(cloud.snapshot())).not.toMatch(/TEST-|PRIVATE/);
  clock += 29_999;
  await cloud.refresh();
  expect(request).toHaveBeenCalledTimes(1);
  clock = now + 899_999;
  expect(cloud.snapshot().tasks).toHaveLength(1);
  clock = now + 900_000;
  expect(cloud.snapshot().tasks).toEqual([]);
});

it('clears old running state on failures, reports auth expiry, and backs off rate limits', async () => {
  let clock = now;
  const request = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(new Response(JSON.stringify({ data: [session()] })))
    .mockResolvedValueOnce(new Response('PRIVATE ERROR', { status: 401 }))
    .mockResolvedValueOnce(new Response('', { status: 429 }));
  const cloud = new ClaudeCloudMonitor(
    await credentials(),
    request,
    () => clock,
  );
  await cloud.refresh();
  expect(cloud.snapshot().tasks).toHaveLength(1);
  clock += 30_000;
  await cloud.refresh();
  expect(cloud.snapshot()).toEqual({ source: 'auth-required', tasks: [] });
  clock += 30_000;
  await cloud.refresh();
  expect(cloud.snapshot().source).toBe('rate-limited');
  clock += 30_000;
  await cloud.refresh();
  expect(request).toHaveBeenCalledTimes(3);
  const expired = new ClaudeCloudMonitor(
    await credentials(now - 1),
    request,
    () => now,
  );
  await expired.refresh();
  expect(expired.snapshot().source).toBe('auth-required');
  expect(request).toHaveBeenCalledTimes(3);
});

it('keeps local polling responsive during cloud I/O and labels cloud rows', async () => {
  let resolve!: (value: Response) => void;
  const request = vi.fn<typeof fetch>(
    () =>
      new Promise<Response>((r) => {
        resolve = r;
      }),
  );
  const cloud = new ClaudeCloudMonitor(await credentials(), request, () => now);
  const local = {
    read: async () => ({
      tasks: [],
      sources: { codex: 'ok', claude: 'ok' },
      observedAt: now,
    }),
  };
  const monitor = new CombinedAgentMonitor(local, cloud);
  expect((await monitor.read()).sources.claudeCloud).toBe('checking');
  await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(1));
  resolve(new Response(JSON.stringify({ data: [session()] })));
  await cloud.refresh();
  const snapshot = await monitor.read();
  expect(snapshot.tasks).toHaveLength(1);
  const display = composeAgentDisplay(emptyState(), snapshot, new Date(now));
  expect(display.pages[0]!.content).toContain('Claude雲 実行 launcher');
});
