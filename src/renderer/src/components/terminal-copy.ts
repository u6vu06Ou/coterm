// Selection → clipboard text, cell-accurate (Ink-style TUI rows and CJK text).
//
// xterm's getSelection() emits whole rows and only trims against a "trimmed
// length" that counts program-painted spaces, so a TUI that pads each row to
// the pane width leaks a run of blanks into the paste. Here we read the buffer
// cells of the selected span ourselves and let selectionTextFromRows rebuild
// the text: row padding gone, soft/hard wrapped rows glued without separator,
// real line breaks kept, wide CJK tails emitting nothing.
//
// Buffer access lives here; the text rules are pure (terminal-selection-text.ts,
// unit-tested). Any bookkeeping mismatch falls back to the legacy text.

import type { Terminal } from "@xterm/xterm";
import { rowHardWrapsInto, type TerminalCellLike } from "./terminal-links";
import { selectionTextFromRows, type SelectionTextRow } from "./terminal-selection-text";

const TRAILING_BLANKS = /[ \t\u00a0]+$/u;

/** One row's cells as text (wide tails skipped, blank cell = space, right-trimmed). */
export function rowCellsText(cells: readonly TerminalCellLike[], startX = 0, endX = cells.length): string {
  let text = "";
  for (let x = Math.max(0, startX); x < Math.min(endX, cells.length); ) {
    const cell = cells[x];
    if (!cell) break;
    if (cell.width !== 0) text += cell.chars.length > 0 ? cell.chars : " ";
    x += Math.max(1, cell.width);
  }
  return text.replace(TRAILING_BLANKS, "");
}

// Which selection shape produced a legacy getSelection() string. xterm has two:
// NORMAL (a text run: first row from the start column to the row end, whole
// middle rows, last row up to the end column) and COLUMN (Alt+drag rectangle:
// the same column span on every row). The public API does not expose the mode,
// so score both hypotheses against the legacy chunks — the producing mode
// matches them exactly, and picking wrong would paste whole rows for a
// rectangle (or a rectangle for a text run).
export function isColumnMode(legacy: string, normalTexts: readonly string[], columnTexts: readonly string[]): boolean {
  const chunks = legacy.split(/\r?\n/).map((line) => line.replace(TRAILING_BLANKS, ""));
  if (chunks.length !== normalTexts.length || normalTexts.length < 2) return false;  let normal = 0;
  let column = 0;
  for (let i = 0; i < chunks.length; i += 1) {
    const chunk = chunks[i] ?? "";
    if (chunk === normalTexts[i]) normal += 1;
    if (chunk === columnTexts[i]) column += 1;
  }
  return column > normal;
}

export function cellAccurateSelectionText(terminal: Terminal): string {
  const text = terminal.getSelection();
  if (!text) return text;
  const pos = terminal.getSelectionPosition();
  // A malformed/empty range can never improve on the legacy string.
  if (!pos || pos.end.y < pos.start.y) return text;
  const buffer = terminal.buffer.active;
  // A selection whose end sits at column 0 of a later row highlights nothing
  // there; including that row would paste a blank trailing line.
  const endY = pos.end.y > pos.start.y && pos.end.x === 0 ? pos.end.y - 1 : pos.end.y;
  const scratch = buffer.getNullCell();
  // Whole rows: hard-wrap detection needs the full row width, and the row
  // builder right-trims the unselected padding away anyway.
  const readCells = (y: number): TerminalCellLike[] | null => {
    const line = buffer.getLine(y);
    if (!line) return null;
    const cells: TerminalCellLike[] = [];
    for (let x = 0; x < line.length; x += 1) {
      const cell = line.getCell(x, scratch);
      if (!cell) break;
      cells.push({ chars: cell.getChars(), width: cell.getWidth() });
    }
    return cells;
  };
  const cellsByRow: TerminalCellLike[][] = [];
  for (let y = pos.start.y; y <= endY; y += 1) {
    const cells = readCells(y);
    if (!cells) return text;
    cellsByRow.push(cells);
  }

  // Column mode swaps the two x bounds independently of the rows.
  const lowerX = Math.min(pos.start.x, pos.end.x);
  const upperX = Math.max(pos.start.x, pos.end.x);
  const last = cellsByRow.length - 1;
  const normalSpan = (i: number): { startX: number; endX: number } => ({
    startX: i === 0 ? pos.start.x : 0,
    endX: i === last ? (endY === pos.end.y ? pos.end.x : cellsByRow[i]!.length) : cellsByRow[i]!.length,
  });
  const columnMode = isColumnMode(
    text,
    cellsByRow.map((cells, i) => {
      const span = normalSpan(i);
      return rowCellsText(cells, span.startX, span.endX);
    }),
    cellsByRow.map((cells) => rowCellsText(cells, lowerX, upperX)),
  );

  const rows: SelectionTextRow[] = cellsByRow.map((cells, i) => {
    const span = columnMode ? { startX: lowerX, endX: upperX } : normalSpan(i);
    const y = pos.start.y + i;
    const nextIsWrapped = i < last ? (buffer.getLine(y + 1)?.isWrapped ?? false) : false;
    return {
      cells,
      startX: span.startX,
      endX: span.endX,
      softWrapsNext: !columnMode && nextIsWrapped,
      hardWrapsNext:
        !columnMode && i < last && !nextIsWrapped ? rowHardWrapsInto(cells, cellsByRow[i + 1], terminal.cols) : false,
    };
  });
  // Consistency gate: the legacy chunk count must equal chunks implied by the
  // soft-wrap bookkeeping (one per row, minus one per soft-joined boundary).
  // A mismatch means an exotic range neither hypothesis explains; the rebuilt
  // text could then drop or invent characters, so fall back to the legacy text.
  const expectedChunks = rows.reduce((n, _, i) => (i > 0 && rows[i - 1]!.softWrapsNext ? n : n + 1), 0);
  if (!columnMode && text.split(/\r?\n/).length !== expectedChunks) return text;
  return selectionTextFromRows(rows);
}
