import {
  sections,
  type DashboardState,
  type DisplayState,
  type DeviceTelemetry,
} from '@even-agent/protocol';
import {
  recentCompletion,
  type AgentSnapshot,
  type AgentStatus,
} from './agents.js';
import { AgentDisplayOrder } from './agent-order.js';
import { isKokoaAgent, kokoaAgentSummary } from './agent-summary.js';
import { agentScene } from './agent-scene.js';
import { agentFlowPages, type AgentDisplayRow } from './agent-flow.js';
import type { UsageSnapshot } from './usage.js';
import { usageText, windowRemaining } from './header-usage.js';

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
  usage?: UsageSnapshot,
  order = new AgentDisplayOrder(),
  nebi?: { online: string; offline: string },
): DisplayState {
  const labels: Record<AgentStatus, string> = {
    running: '実行',
    waiting: '確認待ち',
    done: '応答完了',
    failed: '失敗',
    stopped: '停止',
    unknown: '更新なし',
  };
  const summary = kokoaAgentSummary(snapshot.tasks);
  const tasks = order.sort(
    snapshot.tasks.filter((task) => !isKokoaAgent(task)),
    now.getTime(),
  );
  const iconRows: AgentDisplayRow[] = [];
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
      ...(task.status === 'running' || recentCompletion(task, now.getTime())
        ? {
            wide: true,
            detail:
              task.activity ||
              (task.status === 'done' ? '応答完了' : '処理中…'),
          }
        : {}),
    });
    return (
      clip(
        `${task.agent}${task.surface === 'Cloud' ? '雲' : ''} ${labels[task.status]} ${task.project}`,
        44 - suffix.length,
      ) + suffix
    );
  });
  if (summary) {
    iconRows.unshift(summary.row);
    rows.unshift(summary.text);
  }
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
  const usageFallback = usage
    ? `Claude 5H ${usageText(windowRemaining(usage.claude, 300))} W ${usageText(windowRemaining(usage.claude, 10080))}   Codex ${usageText(usage.codex.remainingPercent)}`
    : '';
  const fallbackLabels = new Map(iconRows.map((row, i) => [row, rows[i]!]));
  let pages: AgentDisplayRow[][];
  if (nebi) {
    // Five lower-screen lines: summary + three protected running tasks + overflow.
    // Uniform full-width rows share one text container after the three summary labels.
    const capacity = iconRows.length > 5 ? 4 : 5;
    const selected = new Set(iconRows.filter((row) => row.summary));
    for (const row of iconRows
      .filter((row) => !row.summary && row.icon === 'running')
      .slice(0, 3))
      selected.add(row);
    for (const row of iconRows) {
      if (selected.size >= capacity) break;
      selected.add(row);
    }
    const page = iconRows
      .filter((row) => selected.has(row))
      .map((row) => {
        const fullRow = { ...row, wide: true };
        fallbackLabels.set(fullRow, fallbackLabels.get(row)!);
        return fullRow;
      });
    const hidden = iconRows.length - page.length;
    if (hidden > 0)
      page.push({
        text: `Agent +${hidden}件`,
        icon: 'none',
        agent: 'none',
        wide: true,
      });
    pages = [page];
  } else pages = agentFlowPages(iconRows);
  const middle = nebi?.online || undefined;
  const total = pages.length;
  return {
    version: 1,
    updatedAt: state.updatedAt,
    generatedAt: now.getTime(),
    pages: Array.from({ length: total }, (_, index) => {
      const pageRows = pages[index]!;
      const body = pageRows
        .map((row) => {
          const label = fallbackLabels.get(row) ?? row.text;
          return row.wide && row.detail && !row.summary
            ? `${label}  ${row.detail}`
            : label;
        })
        // A dense page must still fit the fallback SDK's 999 UTF-8 byte limit.
        .map((row) => clip(row, 26))
        .join('\n');
      const pageNumber = total > 1 ? `\n${index + 1}/${total}` : '';
      const footer = total > 1 ? `${index + 1}/${total}` : '';
      return {
        id: `page-${index}`,
        content: [clock, usageFallback, middle, body + pageNumber]
          .filter(Boolean)
          .join('\n'),
        offlineContent:
          `${clock}\nOFFLINE\n${nebi ? nebi.offline + '\n' : ''}${body}${pageNumber}`.trimEnd(),
        // Legacy iconRows supports eight entries; scene + content carry the full page.
        iconRows:
          pageRows.length && pageRows.length <= 8
            ? pageRows.map((row) => ({
                text: row.text,
                icon: row.icon,
                agent: row.agent,
              }))
            : undefined,
        footer,
        scene: agentScene(pageRows, footer, true, clock, usage, middle),
        offlineScene: agentScene(
          pageRows,
          nebi ? '' : `OFFLINE ${footer}`.trim(),
          false,
          clock,
          usage,
          nebi?.offline,
        ),
      };
    }),
  };
}
