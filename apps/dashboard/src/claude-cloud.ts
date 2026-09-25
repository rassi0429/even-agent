import { readFile } from 'node:fs/promises';
import type { AgentSnapshot, AgentStatus, AgentTask } from './agents.js';

type ObjectValue = Record<string, unknown>;
const object = (value: unknown): ObjectValue =>
  value && typeof value === 'object' ? (value as ObjectValue) : {};
const string = (value: unknown): string =>
  typeof value === 'string' ? value : '';
const END_VISIBLE_MS = 120_000;
const DONE_VISIBLE_MS = 15 * 60_000;

// Private endpoint used by Claude Code 2.1.269. Only metadata GETs are issued.
const ENDPOINT = 'https://api.anthropic.com/v1/code/sessions?limit=100';
export function parseCloudSessions(value: unknown, now: number): AgentTask[] {
  const data = object(value).data;
  if (!Array.isArray(data)) throw new Error('invalid-schema');
  return data.flatMap((value): AgentTask[] => {
    const session = object(value);
    if (
      session.environment_kind !== 'anthropic_cloud' ||
      session.status === 'archived' ||
      !string(session.id)
    )
      return [];
    const statuses: Record<string, AgentStatus> = {
      running: 'running',
      requires_action: 'waiting',
      idle: 'done',
      failed: 'failed',
      stopped: 'stopped',
    };
    const status =
      session.status === 'failed'
        ? 'failed'
        : statuses[string(session.worker_status)] || 'unknown';
    const updatedAt = Date.parse(string(session.last_event_at));
    if (!Number.isFinite(updatedAt) || updatedAt > now + 60_000) return [];
    if (
      ['done', 'stopped', 'failed'].includes(status) &&
      now - updatedAt >= (status === 'done' ? DONE_VISIBLE_MS : END_VISIBLE_MS)
    )
      return [];
    const sources = object(session.config).sources;
    const source = Array.isArray(sources)
      ? sources.map(object).find((s) => s.type === 'git_repository')
      : undefined;
    let project = 'task';
    try {
      const url = new URL(string(source?.url));
      project = decodeURIComponent(
        url.pathname.split('/').filter(Boolean).pop() || 'task',
      )
        .replace(/\.git$/, '')
        .replace(/\s+/g, ' ')
        .slice(0, 80);
    } catch {
      /* No repository: never substitute the conversation title. */
    }
    return [
      {
        id: string(session.id),
        agent: 'Claude',
        surface: 'Cloud',
        project,
        status,
        updatedAt,
      },
    ];
  });
}

interface CloudState {
  tasks: AgentTask[];
  source: string;
}
export class ClaudeCloudMonitor {
  private state: CloudState = { tasks: [], source: 'checking' };
  private nextRead = 0;
  private pending?: Promise<void>;
  constructor(
    private readonly credentialsPath: string,
    private readonly request: typeof fetch = fetch,
    private readonly now = Date.now,
  ) {}

  snapshot(): CloudState {
    return {
      ...this.state,
      tasks: this.state.tasks.filter(
        (task) =>
          !['done', 'stopped', 'failed'].includes(task.status) ||
          this.now() - task.updatedAt <
            (task.status === 'done' ? DONE_VISIBLE_MS : END_VISIBLE_MS),
      ),
    };
  }

  // Single flight + cache; local monitoring does not wait on network I/O.
  refresh(): Promise<void> {
    if (this.pending) return this.pending;
    if (this.now() < this.nextRead) return Promise.resolve();
    this.nextRead = this.now() + 30_000;
    this.pending = this.collect().finally(() => {
      this.pending = undefined;
    });
    return this.pending;
  }

  private async collect(): Promise<void> {
    try {
      const credentials = object(
        JSON.parse(await readFile(this.credentialsPath, 'utf8')),
      );
      const oauth = object(credentials.claudeAiOauth);
      const token = string(oauth.accessToken);
      if (
        !token ||
        (typeof oauth.expiresAt === 'number' && oauth.expiresAt <= this.now())
      ) {
        this.state = { tasks: [], source: 'auth-required' };
        return;
      }
      const response = await this.request(ENDPOINT, {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${token}`,
          'anthropic-version': '2023-06-01',
        },
        redirect: 'error',
        signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok) {
        const source = [401, 403].includes(response.status)
          ? 'auth-required'
          : response.status === 429
            ? 'rate-limited'
            : 'read-error';
        if (response.status === 429) this.nextRead = this.now() + 300_000;
        this.state = { tasks: [], source };
        return;
      }
      this.state = {
        tasks: parseCloudSessions(await response.json(), this.now()),
        source: 'ok',
      };
    } catch {
      // Do not expose response bodies, credentials or exception text to logs/API.
      this.state = { tasks: [], source: 'read-error' };
    }
  }
}

export class CombinedAgentMonitor {
  constructor(
    private readonly local: { read(): Promise<AgentSnapshot> },
    private readonly cloud: ClaudeCloudMonitor,
  ) {}
  async read(): Promise<AgentSnapshot> {
    void this.cloud.refresh();
    const local = await this.local.read();
    const cloud = this.cloud.snapshot();
    return {
      ...local,
      tasks: [...local.tasks, ...cloud.tasks],
      sources: { ...local.sources, claudeCloud: cloud.source },
    };
  }
}
