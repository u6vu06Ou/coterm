// Hard-wrap-aware selection copy (Ink-style TUI rows are not isWrapped).
//
// xterm's getSelection() joins rows with a real newline unless the next row is
// isWrapped, so a path the TUI hard-wrapped across rows pastes broken. This
// adapter pairs the raw selection text with per-row buffer signals
// (rowHardWrapsInto) and lets joinHardWrappedSelection rebuild the text with
// the false newlines — and their padding/indent — removed. Buffer access lives
// here; the join decision itself is pure (terminal-links.ts, unit-tested).
// Any bookkeeping mismatch falls back to the legacy text unchanged.

import type { Terminal } from "@xterm/xterm";
import {
  joinHardWrappedSelection,
  rowHardWrapsInto,
  type SelectionRowSignals,
  type TerminalCellLike,
} from "./terminal-links";

export function hardWrapAwareSelectionText(terminal: Terminal): string {
  const text = terminal.getSelection();
  if (!text || !/[\r\n]/.test(text)) return text;
  const pos = terminal.getSelectionPosition();
  if (!pos) return text;
  // Narrow belt-and-braces: a malformed/empty range can never improve on the
  // legacy string, so leave it untouched.
  if (pos.end.y < pos.start.y) return text;
  const buffer = terminal.buffer.active;
  const scratch = buffer.getNullCell();
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
  const rows: SelectionRowSignals[] = [];
  for (let y = pos.start.y; y <= pos.end.y; y += 1) {
    const cells = readCells(y);
    if (!cells) return text;
    const nextIsWrapped = y < pos.end.y ? (buffer.getLine(y + 1)?.isWrapped ?? false) : false;
    rows.push({
      softWrapsNext: nextIsWrapped,
      hardWrapsNext:
        y < pos.end.y && !nextIsWrapped
          ? rowHardWrapsInto(cells, readCells(y + 1) ?? undefined, terminal.cols)
          : false,
    });
  }
  return joinHardWrappedSelection(text, rows) ?? text;
}
