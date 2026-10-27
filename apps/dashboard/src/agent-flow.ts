import { getTextWidth, pxTruncate } from '@evenrealities/pretext';
import type { DisplayIconRow } from '@even-agent/protocol';

export const COLUMN_WIDTH = 288;
export const LABEL_X = 52;
export const FLOW_LINE_HEIGHT = 27;
export const MAX_FLOW_LINES = 8;
const LABEL_SLACK = 4;
const RUNNING_NAME_WIDTH = 144;
const DETAIL_SEPARATOR = '  ';
export type AgentDisplayRow = DisplayIconRow & {
  detail?: string;
  wide?: boolean;
  summary?: { running: number; done: number; other: string };
};
function title(text: string, width: number) {
  const suffix = text.match(/ #[^\s]{1,4}$/)?.[0] ?? '';
  return getTextWidth(text) <= width
    ? text
    : pxTruncate(
        text.slice(0, suffix ? -suffix.length : undefined),
        width - getTextWidth(suffix),
      ) + suffix;
}
export function agentFlow(rows: AgentDisplayRow[]) {
  let line = 0;
  let column = 0;
  return rows.map((row) => {
    const wide = row.wide || row.icon === 'running';
    if (wide && column) {
      line++;
      column = 0;
    }
    const x = wide ? 0 : column * COLUMN_WIDTH;
    const width = wide ? 576 : COLUMN_WIDTH;
    const maxTextWidth = width - LABEL_X - LABEL_SLACK;
    const activity =
      row.detail || (row.icon === 'running' ? '処理中…' : undefined);
    const text = title(
      row.text,
      wide && activity ? RUNNING_NAME_WIDTH : maxTextWidth,
    );
    const detail =
      wide && activity
        ? pxTruncate(
            activity,
            maxTextWidth - getTextWidth(text + DETAIL_SEPARATOR),
          )
        : undefined;
    const label = detail ? text + DETAIL_SEPARATOR + detail : text;
    const entry = {
      row,
      text,
      detail,
      label,
      wide,
      span: 1,
      x,
      line,
      width,
      textWidth: width - LABEL_X,
    };
    if (wide || column === 1) {
      line++;
      column = 0;
    } else column = 1;
    return entry;
  });
}
export function flowLines(entries: ReturnType<typeof agentFlow>) {
  return Math.max(0, ...entries.map((entry) => entry.line + 1));
}
// Keep each block disjoint so native text backgrounds never obscure another row.
export function flowGroups(entries: ReturnType<typeof agentFlow>) {
  const groups: ReturnType<typeof agentFlow>[] = [];
  for (const entry of entries) {
    let group = groups.at(-1);
    if (
      !group ||
      group[0]!.wide !== entry.wide ||
      entry.row.summary ||
      group[0]!.row.summary
    ) {
      group = [];
      groups.push(group);
    }
    group.push(entry);
  }
  return groups;
}
export function agentFlowPages(
  rows: AgentDisplayRow[],
  limits = { lines: MAX_FLOW_LINES, textContainers: 5 },
): AgentDisplayRow[][] {
  const pages: AgentDisplayRow[][] = [[]];
  for (const row of rows) {
    let page = pages.at(-1)!;
    const entries = agentFlow([...page, row]);
    const textContainers = flowGroups(entries).reduce(
      (sum, group) =>
        sum +
        (group[0]!.row.summary
          ? 3
          : group.some((e) => e.x === COLUMN_WIDTH)
            ? 2
            : 1),
      0,
    );
    // Five body text containers remain after the three header labels.
    if (
      flowLines(entries) > limits.lines ||
      textContainers > limits.textContainers
    ) {
      page = [];
      pages.push(page);
    }
    page.push(row);
  }
  return pages;
}
