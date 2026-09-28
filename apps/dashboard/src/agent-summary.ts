import type { AgentTask, AgentStatus } from './agents.js';

export const isKokoaAgent = (task: AgentTask) =>
  task.project.toLowerCase() === 'kokoa-agent';

// Count the monitor's visible sessions, preserving its completion/staleness windows.
export function kokoaAgentSummary(tasks: AgentTask[]) {
  const grouped = tasks.filter(isKokoaAgent);
  if (!grouped.length) return;
  const counts: Record<AgentStatus, number> = {
    running: 0,
    done: 0,
    waiting: 0,
    failed: 0,
    stopped: 0,
    unknown: 0,
  };
  for (const task of grouped) counts[task.status]++;
  const detail = [
    `実行${counts.running}`,
    `完了${counts.done}`,
    ...(counts.waiting ? [`確認${counts.waiting}`] : []),
    ...(counts.failed ? [`失敗${counts.failed}`] : []),
    ...(counts.stopped ? [`停止${counts.stopped}`] : []),
    ...(counts.unknown ? [`不明${counts.unknown}`] : []),
  ].join(' ');
  const icon = counts.running
    ? 'running'
    : counts.waiting
      ? 'waiting'
      : counts.failed
        ? 'failed'
        : counts.unknown
          ? 'unknown'
          : counts.stopped
            ? 'stopped'
            : 'done';
  return {
    text: `agent ${detail}`,
    row: {
      text: 'agent',
      detail,
      wide: true,
      icon,
      agent: 'none',
      summary: {
        running: counts.running,
        done: counts.done,
        other: detail.split(' ').slice(2).join(' '),
      },
    } as const,
  };
}
