import {
  recentCompletion,
  type AgentTask,
  type AgentStatus,
} from './agents.js';

const rank: Record<AgentStatus, number> = {
  waiting: 0,
  failed: 1,
  running: 2,
  unknown: 3,
  stopped: 4,
  done: 5,
};
const key = (task: AgentTask) => `${task.agent}/${task.surface}/${task.id}`;

// One instance per dashboard: messages and polling order never change task order.
export class AgentDisplayOrder {
  private entries = new Map<string, { order: number; lastSeen: number }>();
  private sequence = 0;

  sort(tasks: AgentTask[], now: number): AgentTask[] {
    for (const [id, entry] of this.entries)
      if (now - entry.lastSeen > 30 * 60_000) this.entries.delete(id);
    // Deterministic initial ordering; newly discovered tasks join after existing ones.
    for (const task of [...tasks].sort((a, b) =>
      key(a).localeCompare(key(b)),
    )) {
      const id = key(task);
      const entry = this.entries.get(id);
      if (entry) entry.lastSeen = now;
      else this.entries.set(id, { order: this.sequence++, lastSeen: now });
    }
    const priority = (task: AgentTask) =>
      recentCompletion(task, now) ? rank.running : rank[task.status];
    return [...tasks].sort(
      (a, b) =>
        priority(a) - priority(b) ||
        this.entries.get(key(a))!.order - this.entries.get(key(b))!.order,
    );
  }
}
