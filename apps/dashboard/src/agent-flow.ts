import { getTextWidth, pxTruncate } from '@evenrealities/pretext';
import type { DisplayIconRow } from '@even-agent/protocol';

const WIDTH = 576;
export const LABEL_X = 52;
const GAP = 20;
const LABEL_SLACK = 4;
export const MAX_FLOW_LINES = 5; // Two image tiles can cover at most 144px vertically.
export function agentFlow(rows: DisplayIconRow[]) {
  let x = 0;
  let line = 0;
  return rows.map((row) => {
    const maxTextWidth = WIDTH - LABEL_X - LABEL_SLACK;
    const suffix = row.text.match(/ #[^\s]{1,4}$/)?.[0] ?? '';
    const text =
      getTextWidth(row.text) <= maxTextWidth
        ? row.text
        : pxTruncate(
            row.text.slice(0, suffix ? -suffix.length : undefined),
            maxTextWidth - getTextWidth(suffix),
          ) + suffix;
    const textWidth = Math.max(1, getTextWidth(text)) + LABEL_SLACK;
    const width = LABEL_X + textWidth;
    if (x && x + width > WIDTH) {
      x = 0;
      line++;
    }
    const entry = { row, text, x, line, width, textWidth };
    x += width + GAP;
    return entry;
  });
}

export function agentFlowPages(rows: DisplayIconRow[]): DisplayIconRow[][] {
  const pages: DisplayIconRow[][] = [[]];
  for (const row of rows) {
    let page = pages.at(-1)!;
    if (
      page.length >= 7 ||
      agentFlow([...page, row]).at(-1)!.line >= MAX_FLOW_LINES
    ) {
      page = [];
      pages.push(page);
    }
    page.push(row);
  }
  return pages;
}
