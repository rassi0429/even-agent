import {
  sections,
  type DashboardState,
  type DisplayState,
  type DisplayIconRow,
  type DeviceTelemetry,
} from '@even-agent/protocol';
import type { AgentSnapshot, AgentStatus } from './agents.js';
import { agentScene } from './agent-scene.js';
import { agentFlowPages } from './agent-flow.js';

const dateTimeFormatter = new Intl.DateTimeFormat('ja-JP', {
  timeZone: 'Asia/Tokyo',
  year: 'numeric',
  month: 'numeric',
  day: 'numeric',
  weekday: 'short',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});
function dashboardClock(now: Date): string {
  const parts = Object.fromEntries(
    dateTimeFormatter.formatToParts(now).map((p) => [p.type, p.value]),
  );
  return `${parts.year}/${parts.month}/${parts.day} ${parts.weekday} ${parts.hour}:${parts.minute}`;
}

// Conservative character-unit budget, not a firmware font measurement.
// Non-ASCII glyphs count double; full content remains available through REST.
export function clip(value: string, budget: number): string {
  const clean = value.replace(/\s+/gu, ' ').trim();
  let width = 0;
  let result = '';
  for (const char of clean) {
    const units = char.codePointAt(0)! > 127 ? 2 : 1;
    if (width + units > budget - 3) return result + '...';
    width += units;
    result += char;
  }
  return result;
}
export function pagesFor(state: DashboardState): string[] {
  // At most one item from each section per page; every item is reachable.
  const total = Math.max(
    1,
    ...sections.map((section) => state[section].length),
  );
  return Array.from({ length: total }, (_, index) =>
    sections
      .map((section) => {
        const item = state[section][index];
        if (!item) return `${section.toUpperCase()}\n-`;
        const marker = item.priority === 'high' ? '! ' : '';
        const title = clip(marker + item.title, 44);
        const detail = clip(item.description || item.source, 44);
        return `${section.toUpperCase()}  ${index + 1}/${state[section].length}\n${title}\n${detail}`;
      })
      .join('\n'),
  );
}
export function composeDisplay(
  state: DashboardState,
  now = new Date(),
): DisplayState {
  const pages = pagesFor(state);
  const clock = now.toLocaleTimeString('en-GB', {
    hour: '2-digit',
    minute: '2-digit',
  });
  return {
    version: 1,
    updatedAt: state.updatedAt,
    generatedAt: now.getTime(),
    pages: pages.map((content, index) => ({
      id: `page-${index}`,
      content: `${clock}  LIVE  ${index + 1}/${pages.length}\n${content}`,
      offlineContent: `${clock}  OFFLINE  ${index + 1}/${pages.length}\n${content}`,
    })),
  };
}

export function composeAgentDisplay(
  state: DashboardState,
  snapshot: AgentSnapshot,
  now = new Date(),
  device?: DeviceTelemetry,
): DisplayState {
  const labels: Record<AgentStatus, string> = {
    running: '実行',
    waiting: '確認待ち',
    done: '応答完了',
    failed: '失敗',
    stopped: '停止',
    unknown: '更新なし',
  };
  const rank: Record<AgentStatus, number> = {
    waiting: 0,
    failed: 1,
    running: 2,
    unknown: 3,
    stopped: 4,
    done: 5,
  };
  const tasks = [...snapshot.tasks].sort(
    (a, b) =>
      rank[a.status] - rank[b.status] ||
      b.updatedAt - a.updatedAt ||
      a.id.localeCompare(b.id),
  );
  const iconRows: DisplayIconRow[] = [];
  const rows = tasks.map((task) => {
    const duplicates =
      tasks.filter(
        (other) => other.agent === task.agent && other.project === task.project,
      ).length > 1;
    const suffix = duplicates ? ` #${task.id.slice(-4)}` : '';
    iconRows.push({
      text:
        clip(
          `${task.surface === 'Cloud' ? '雲 ' : ''}${task.project}`,
          40 - suffix.length,
        ) + suffix,
      icon: task.status,
      agent: task.agent === 'Codex' ? 'codex' : 'claude',
    });
    return (
      clip(
        `${task.agent}${task.surface === 'Cloud' ? '雲' : ''} ${labels[task.status]} ${task.project}`,
        44 - suffix.length,
      ) + suffix
    );
  });
  for (const agent of ['Codex', 'Claude'] as const) {
    const source = snapshot.sources[agent === 'Codex' ? 'codex' : 'claude'];
    if (source !== 'ok') {
      rows.push(`${agent} 取得できません`);
      iconRows.push({
        text: '取得できません',
        icon: 'failed',
        agent: agent === 'Codex' ? 'codex' : 'claude',
      });
    }
  }
  const cloudSource = snapshot.sources.claudeCloud;
  if (cloudSource && cloudSource !== 'ok') {
    rows.push(
      cloudSource === 'auth-required'
        ? 'Claude雲 認証更新が必要'
        : cloudSource === 'checking'
          ? 'Claude雲 接続中'
          : 'Claude雲 取得できません',
    );
    iconRows.push({
      text: rows.at(-1)!.replace('Claude雲', '雲'),
      icon: cloudSource === 'checking' ? 'unknown' : 'waiting',
      agent: 'claude',
    });
  }
  for (const section of sections) {
    for (const item of state[section]) {
      rows.push(
        clip(`${item.priority === 'high' ? '! ' : ''}${item.title}`, 44),
      );
      iconRows.push({
        text: clip(item.title, 40),
        icon: item.priority === 'high' ? 'waiting' : 'none',
        agent: 'none',
      });
    }
  }
  const battery =
    device?.connected && device.batteryLevel !== null
      ? `   G2 ${device.batteryLevel}%${device.isCharging ? ' +' : ''}`
      : '';
  const clock = dashboardClock(now) + battery;
  const pages = agentFlowPages(iconRows);
  const total = pages.length;
  let offset = 0;
  return {
    version: 1,
    updatedAt: state.updatedAt,
    generatedAt: now.getTime(),
    pages: Array.from({ length: total }, (_, index) => {
      const pageRows = pages[index]!;
      const body = rows.slice(offset, offset + pageRows.length).join('\n');
      offset += pageRows.length;
      const pageNumber = total > 1 ? `\n${index + 1}/${total}` : '';
      const footer = total > 1 ? `${index + 1}/${total}` : '';
      return {
        id: `page-${index}`,
        content: [clock, body + pageNumber].filter(Boolean).join('\n'),
        offlineContent: `${clock}\nOFFLINE\n${body}${pageNumber}`.trimEnd(),
        iconRows: pageRows.length ? pageRows : undefined,
        footer,
        scene: agentScene(pageRows, footer, true, clock),
        offlineScene: agentScene(
          pageRows,
          `OFFLINE ${footer}`.trim(),
          false,
          clock,
        ),
      };
    }),
  };
}
