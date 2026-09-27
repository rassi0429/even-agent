import { DatabaseSync } from 'node:sqlite';
import { open, readdir, readFile, stat } from 'node:fs/promises';
import { join, basename, win32 } from 'node:path';
import { homedir } from 'node:os';
import { codexActivity, claudeActivity } from './agent-activity.js';

export type AgentStatus =
  'running' | 'waiting' | 'done' | 'failed' | 'stopped' | 'unknown';
export interface AgentTask {
  id: string;
  agent: 'Codex' | 'Claude';
  surface: string;
  project: string;
  status: AgentStatus;
  updatedAt: number;
  activity?: string;
}
export interface AgentSnapshot {
  tasks: AgentTask[];
  sources: { codex: string; claude: string; claudeCloud?: string };
  observedAt: number;
}
type RecordValue = Record<string, unknown>;
function record(value: unknown): RecordValue {
  return value && typeof value === 'object' ? (value as RecordValue) : {};
}
function text(value: unknown): string {
  return typeof value === 'string' ? value : '';
}
function time(value: unknown): number {
  if (typeof value === 'number') return value < 1e12 ? value * 1000 : value;
  return typeof value === 'string' ? Date.parse(value) || 0 : 0;
}
export function projectName(cwd: unknown): string {
  return (win32.basename(text(cwd).replace(/[\\/]+$/, '')) || 'task')
    .replace(/\s+/g, ' ')
    .slice(0, 80);
}
const DONE_VISIBLE_MS = 15 * 60_000;
const STALE_MS = 180_000;
const MAX_AGE_MS = 30 * 60_000;
export function visibleTask(
  task: AgentTask,
  now: number,
): AgentTask | undefined {
  if (!task.updatedAt || task.updatedAt > now + 60_000) return;
  const age = now - task.updatedAt;
  if (task.status !== 'running' || age > STALE_MS) {
    task = { ...task };
    delete task.activity;
  }
  if (task.status === 'done') return age < DONE_VISIBLE_MS ? task : undefined;
  if (task.status === 'stopped') return age < 120_000 ? task : undefined;
  if (age > MAX_AGE_MS) return;
  return age > STALE_MS ? { ...task, status: 'unknown' } : task;
}

// Read only a bounded tail; ignore incomplete JSON lines.
export async function readTail(
  path: string,
  maxBytes = 256 * 1024,
): Promise<unknown[]> {
  const file = await open(path, 'r');
  try {
    const { size } = await file.stat();
    const start = Math.max(0, size - maxBytes);
    const buffer = Buffer.alloc(Math.min(size, maxBytes));
    const { bytesRead } = await file.read(buffer, 0, buffer.length, start);
    const lines = buffer.subarray(0, bytesRead).toString('utf8').split('\n');
    if (start) lines.shift();
    return lines.flatMap((line) => {
      try {
        return [JSON.parse(line)];
      } catch {
        return [];
      }
    });
  } finally {
    await file.close();
  }
}

export function parseClaudeEvents(
  events: unknown[],
  fallbackId: string,
  surface: string,
): AgentTask | undefined {
  let task: AgentTask | undefined;
  for (const value of events) {
    const event = record(value);
    if (event.isSidechain === true) continue;
    const timestamp = time(event.timestamp);
    if (!timestamp || (task && timestamp < task.updatedAt)) continue;
    const message = record(event.message);
    const blocks = Array.isArray(message.content)
      ? message.content.map(record)
      : [];
    let status: AgentStatus | undefined;
    if (event.type === 'assistant') {
      if (
        message.stop_reason === 'end_turn' ||
        message.stop_reason === 'stop_sequence'
      )
        status = 'done';
      else if (
        blocks.some(
          (block) =>
            block.type === 'tool_use' && block.name === 'AskUserQuestion',
        )
      )
        status = 'waiting';
      else status = 'running';
    } else if (event.type === 'user') status = 'running';
    else if (event.type === 'result')
      status = event.is_error === true ? 'failed' : 'done';
    // Housekeeping, queue entries and imported file mtimes are not activity.
    if (!status) continue;
    const toolResult =
      event.type === 'user' &&
      blocks.some((block) => block.type === 'tool_result');
    const activity =
      status === 'running'
        ? event.type === 'assistant'
          ? (claudeActivity(message) ?? task?.activity)
          : toolResult
            ? task?.activity
            : undefined
        : undefined;
    task = {
      id: text(event.sessionId) || fallbackId,
      agent: 'Claude',
      surface,
      project: event.cwd ? projectName(event.cwd) : task?.project || 'task',
      status,
      updatedAt: timestamp,
      ...(activity ? { activity } : {}),
    };
  }
  return task;
}

async function directories(path: string): Promise<string[]> {
  try {
    return (await readdir(path, { withFileTypes: true }))
      .filter((e) => e.isDirectory() && !e.isSymbolicLink())
      .map((e) => join(path, e.name));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
}
async function files(path: string, suffix: string): Promise<string[]> {
  try {
    return (await readdir(path, { withFileTypes: true }))
      .filter((e) => e.isFile() && e.name.endsWith(suffix))
      .map((e) => join(path, e.name));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
}

export interface MonitorPaths {
  codexHome: string;
  claudeHomes: string[];
  claudeDesktopRoots: string[];
}
export async function defaultMonitorPaths(): Promise<MonitorPaths> {
  const home = homedir();
  const roots: string[] = [];
  if (process.env.APPDATA) roots.push(join(process.env.APPDATA, 'Claude'));
  if (process.env.LOCALAPPDATA) {
    for (const path of await directories(
      join(process.env.LOCALAPPDATA, 'Packages'),
    )) {
      if (basename(path).startsWith('Claude_'))
        roots.push(join(path, 'LocalCache/Roaming/Claude'));
    }
  }
  return {
    codexHome: process.env.CODEX_HOME || join(home, '.codex'),
    claudeHomes: [process.env.CLAUDE_CONFIG_DIR || join(home, '.claude')],
    claudeDesktopRoots: roots,
  };
}

export class LocalAgentMonitor {
  private cache = new Map<
    string,
    { size: number; mtime: number; task?: AgentTask }
  >();
  constructor(
    private readonly paths: MonitorPaths,
    private readonly now = Date.now,
  ) {}

  private async codex(): Promise<AgentTask[]> {
    // Private local schema: fail visibly if the installed app changes it.
    const statePath = join(this.paths.codexHome, 'state_5.sqlite');
    const historyPath = join(this.paths.codexHome, 'thread_history_1.sqlite');
    await stat(statePath);
    await stat(historyPath);
    const state = new DatabaseSync(statePath, { readOnly: true });
    let history: DatabaseSync | undefined;
    try {
      history = new DatabaseSync(historyPath, { readOnly: true });
      state.exec('PRAGMA query_only=ON; PRAGMA busy_timeout=100');
      history.exec('PRAGMA query_only=ON; PRAGMA busy_timeout=100');
      const rows = state
        .prepare(
          'SELECT id,cwd FROM threads WHERE archived=0 AND agent_path IS NULL ORDER BY updated_at DESC LIMIT 100',
        )
        .all();
      const turnQuery = history.prepare(
        'SELECT turn_id,status,started_at,completed_at FROM thread_turns WHERE thread_id=? ORDER BY rollout_ordinal DESC LIMIT 1',
      );
      const activityQuery = history.prepare(
        'SELECT MAX(created_at_ms) AS latest FROM thread_items WHERE thread_id=? AND turn_id=?',
      );
      // Select only visible message text and tool labels, never reasoning, arguments or output.
      const columns = history.prepare('PRAGMA table_info(thread_items)').all();
      const detailQuery =
        columns.some((column) => column.name === 'item_json') &&
        columns.some((column) => column.name === 'item_type')
          ? history.prepare(`SELECT item_type AS type,
            json_extract(item_json, '$.phase') AS phase,
            CASE WHEN item_type='agentMessage' AND json_extract(item_json,'$.phase') IN ('commentary','final')
              THEN substr(json_extract(item_json,'$.text'),1,4000) END AS text,
            json_extract(item_json,'$.tool') AS tool,
            json_extract(item_json,'$.status') AS status,
            json_extract(item_json,'$.changes[0].path') AS path
          FROM thread_items WHERE thread_id=? AND turn_id=? AND json_valid(item_json)
            AND item_type IN ('agentMessage','commandExecution','fileChange','webSearch','imageView','mcpToolCall','dynamicToolCall')
          ORDER BY created_at_ms DESC, rollout_ordinal DESC LIMIT 12`)
          : undefined;
      const result: AgentTask[] = [];
      for (const row of rows) {
        const turn = turnQuery.get(row.id!);
        if (!turn) continue;
        const statuses: Record<string, AgentStatus> = {
          inProgress: 'running',
          completed: 'done',
          failed: 'failed',
          interrupted: 'stopped',
        };
        const activity = activityQuery.get(row.id!, turn.turn_id!);
        const task = visibleTask(
          {
            id: String(row.id),
            agent: 'Codex',
            surface: 'local',
            project: projectName(row.cwd),
            status: statuses[String(turn.status)] || 'unknown',
            updatedAt: turn.completed_at
              ? time(turn.completed_at)
              : Math.max(time(turn.started_at), Number(activity?.latest || 0)),
          },
          this.now(),
        );
        if (task?.status === 'running' && detailQuery) {
          for (const item of detailQuery.all(row.id!, turn.turn_id!)) {
            const detail = codexActivity(item);
            if (detail) {
              task.activity = detail;
              break;
            }
          }
        }
        if (task) result.push(task);
      }
      return result;
    } finally {
      history?.close();
      state.close();
    }
  }

  private async claude(): Promise<AgentTask[]> {
    const homes = this.paths.claudeHomes.map((path) => ({
      path,
      surface: 'Code',
    }));
    // Cowork stores host-visible transcripts inside each session's .claude.
    // Traverse only the known account/org/session levels, never uploads or VM disks.
    for (const root of this.paths.claudeDesktopRoots) {
      for (const account of await directories(
        join(root, 'local-agent-mode-sessions'),
      )) {
        for (const org of await directories(account)) {
          for (const session of await directories(org)) {
            if (basename(session).startsWith('local_'))
              homes.push({ path: join(session, '.claude'), surface: 'Cowork' });
          }
        }
      }
    }
    const candidates: {
      path: string;
      surface: string;
      size: number;
      mtime: number;
    }[] = [];
    const tasks = new Map<string, AgentTask>();
    for (const home of homes) {
      for (const project of await directories(join(home.path, 'projects'))) {
        // Main sessions only. Subagent transcripts live one level deeper.
        for (const path of await files(project, '.jsonl')) {
          const info = await stat(path);
          if (info.mtimeMs < this.now() - MAX_AGE_MS) continue;
          candidates.push({
            path,
            surface: home.surface,
            size: info.size,
            mtime: info.mtimeMs,
          });
        }
      }
    }
    candidates.sort((a, b) => b.mtime - a.mtime);
    const seen = new Set<string>();
    for (const file of candidates.slice(0, 100)) {
      seen.add(file.path);
      let entry = this.cache.get(file.path);
      if (!entry || entry.size !== file.size || entry.mtime !== file.mtime) {
        entry = {
          ...file,
          task: parseClaudeEvents(
            await readTail(file.path),
            basename(file.path, '.jsonl'),
            file.surface,
          ),
        };
        this.cache.set(file.path, entry);
      }
      const task = entry.task && visibleTask(entry.task, this.now());
      if (
        task &&
        (!tasks.has(task.id) || tasks.get(task.id)!.updatedAt < task.updatedAt)
      )
        tasks.set(task.id, task);
    }
    for (const key of this.cache.keys())
      if (!seen.has(key)) this.cache.delete(key);
    // Recent session metadata adds explicit CLI status without parsing conversation text.
    for (const home of homes) {
      for (const path of await files(join(home.path, 'sessions'), '.json')) {
        let info: RecordValue;
        try {
          info = record(JSON.parse(await readFile(path, 'utf8')));
        } catch (error) {
          if (
            error instanceof SyntaxError ||
            (error as NodeJS.ErrnoException).code === 'ENOENT'
          )
            continue;
          throw error;
        }
        if (
          typeof info.pid !== 'number' ||
          !Number.isInteger(info.pid) ||
          info.pid <= 0 ||
          !text(info.sessionId)
        )
          continue;
        // A newly opened idle CLI has not necessarily completed a response.
        if (info.status === 'idle') continue;
        try {
          process.kill(info.pid, 0);
        } catch {
          continue;
        }
        const updatedAt = time(info.statusUpdatedAt || info.updatedAt);
        const statuses: Record<string, AgentStatus> = {
          running: 'running',
          busy: 'running',
          idle: 'done',
          waiting: 'waiting',
        };
        const task = visibleTask(
          {
            id: text(info.sessionId),
            agent: 'Claude',
            surface: home.surface,
            project: projectName(info.cwd),
            status: statuses[text(info.status)] || 'unknown',
            updatedAt,
          },
          this.now(),
        );
        if (
          task &&
          (!tasks.has(task.id) ||
            tasks.get(task.id)!.updatedAt <= task.updatedAt)
        )
          tasks.set(task.id, {
            ...task,
            ...(task.status === 'running' &&
            tasks.get(task.id)?.status === 'running' &&
            tasks.get(task.id)?.activity
              ? { activity: tasks.get(task.id)!.activity }
              : {}),
          });
      }
    }
    return [...tasks.values()];
  }

  async read(): Promise<AgentSnapshot> {
    const results = await Promise.allSettled([this.codex(), this.claude()]);
    const snapshot: AgentSnapshot = {
      tasks: [],
      sources: { codex: 'ok', claude: 'ok' },
      observedAt: this.now(),
    };
    for (const [index, key] of (['codex', 'claude'] as const).entries()) {
      const result = results[index]!;
      if (result.status === 'fulfilled') snapshot.tasks.push(...result.value);
      else
        snapshot.sources[key] =
          (result.reason as NodeJS.ErrnoException)?.code === 'ENOENT'
            ? 'unavailable'
            : 'read-error';
    }
    return snapshot;
  }
}
