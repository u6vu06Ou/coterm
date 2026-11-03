// Selection-aware delete/replace for CLI input lines.
//
// Why this exists: xterm's mouse selection is purely visual — it has no
// connection to the CLI's own editing cursor. Coterm used to answer
// Backspace/Delete over a selection with N raw backspaces, which erase text
// at the CLI cursor (usually the END of the prompt), not the highlighted
// range — the user-visible bug "what I selected ≠ what got deleted".
//
// The fix planned here: translate the key into a keystroke sequence the CLI
// understands — move the CLI cursor onto the selection end with arrow keys
// (Left/Right only; Up/Down would recall history in readline), then erase
// exactly the selected characters one by one. Typing a printable character
// over a selection replaces it (same plan, with the char appended).
//
// Counting rules that make this correct:
// - Arrow keys move the CLI cursor by CHARACTER, never by terminal cell —
//   a wide CJK char occupies 2 cells but needs exactly 1 arrow / 1 backspace.
// - A soft-wrapped input line is ONE logical line across several buffer rows
//   (IBufferLine.isWrapped); offsets are computed on the joined text, so a
//   selection spanning wrapped rows still maps to a character span.
// - The selection end coordinate from xterm is EXCLUSIVE (one cell past the
//   last highlighted cell — SelectionService.ts: mouse coords land on the end
//   cell and translateBufferLineToString treats endCol as exclusive), which
//   matches "characters before cell x" arithmetic directly.
// - A row that soft-wraps may end with ONE untouched cell when a 2-cell char
//   did not fit (signalled by the next row starting with a width-2 cell);
//   that gap exists only in cell space and must not count as a character.
// - Trailing untouched cells on the group's last row are padding, not input.
//
// Scope/safety gates: the editable input line is the logical line holding the
// live cursor — soft-wrapped (isWrapped) rows in the NORMAL buffer, where
// inline Claude Code / Codex actually run, and (in the alternate screen) rows
// joined by the TUI's own hard-wrap signal, since fullscreen TUIs wrap their
// input themselves. A selection reaching outside that line refuses the
// translation — the caller then only clears the highlight and sends NOTHING to
// the PTY — as does a group whose top continues above the given window, and a
// total keystroke budget of MAX_EDIT_CHARS. Hard-newline multi-line input
// (Shift+Enter) is NOT one wrapped group, so cross-line selections there fall
// back to clear-only — documented, never wrong-deleting.

import { rowHardWrapsInto } from "./terminal-links";

export interface SelectionCellLike {
  /** IBufferCell.getChars(); "" for an untouched or wide-tail cell. */
  chars: string;
  /** IBufferCell.getWidth(): 0 = invisible tail of a wide char, 1 normal, 2 wide lead. */
  width: number;
}

export interface SelectionEditRow {
  cells: readonly SelectionCellLike[];
  /** xterm semantic: true when THIS row continues the previous row's logical line. */
  isWrapped: boolean;
}

export interface SelectionCellPoint {
  /** 0-based cell column. */
  x: number;
  /** Absolute buffer row; subtract baseY before indexing into rows. */
  y: number;
}

export interface SelectionEditInput {
  /** Consecutive buffer rows; must contain the cursor's whole wrapped group. */
  rows: readonly SelectionEditRow[];
  /** Absolute buffer row of rows[0]. */
  baseY: number;
  /** Live CLI cursor (cell coords, absolute buffer row). */
  cursor: SelectionCellPoint;
  /** Selection range in buffer order; end.x is EXCLUSIVE. */
  selection: { start: SelectionCellPoint; end: SelectionCellPoint };
  /** Terminal columns; enables the TUI hard-wrap join in the alternate screen. */
  cols?: number;
  /** True while the terminal sits in the alternate screen. */
  altScreen: boolean;
}

/**
 * Buffer-row window the caller must read for planSelectionEdit. Starting from
 * the selection and the cursor, expands up/down while rows continue a wrapped
 * group (row at `top` isWrapped = the group started above), so the planner
 * always sees the cursor's WHOLE logical line. Without the upward walk a
 * selection inside a long soft-wrapped input line sat outside the old fixed
 * 8-row window and the press degraded to clear-only — the user's remaining
 * "selected text, Backspace, nothing happened" case.
 *
 * Expansion is double-bounded (MAX_WINDOW_ROWS) so a huge wrapped run can
 * never turn one keypress into a full-buffer walk; when the bound truncates
 * the group the planner's "top cut off" gate refuses and the caller falls
 * back to clear-only — safe, never wrong-deleting.
 */
export const MAX_SELECTION_EDIT_WINDOW_ROWS = 512;

export interface SelectionEditWindowInput {
  /** Total rows in the active buffer. */
  bufferLength: number;
  /** Absolute row of the live CLI cursor. */
  cursorY: number;
  /** Selection bounds, any order. */
  selectionStartY: number;
  selectionEndY: number;
  /** True when row y continues the previous row's logical line. */
  isWrappedAt(row: number): boolean;
  /** Extra rows to leave above/below the group (context for the planner). */
  margin?: number;
}

export function resolveSelectionEditWindow(input: SelectionEditWindowInput): { top: number; bottom: number } | null {
  const margin = input.margin ?? 2;
  const selTop = Math.min(input.selectionStartY, input.selectionEndY);
  const selBottom = Math.max(input.selectionStartY, input.selectionEndY);
  if (selTop < 0 || selBottom >= input.bufferLength) return null;
  if (input.cursorY < 0 || input.cursorY >= input.bufferLength) return null;
  let top = Math.min(selTop, input.cursorY);
  let bottom = Math.max(selBottom, input.cursorY);
  // Walk the group boundaries out first; the margin lands OUTSIDE the group
  // so the planner still sees rows[0].isWrapped === false on a complete group.
  while (top > 0 && input.isWrappedAt(top) && bottom - top < MAX_SELECTION_EDIT_WINDOW_ROWS) top -= 1;
  while (bottom + 1 < input.bufferLength && input.isWrappedAt(bottom + 1) && bottom - top < MAX_SELECTION_EDIT_WINDOW_ROWS) bottom += 1;
  top = Math.max(0, top - margin);
  bottom = Math.min(input.bufferLength - 1, bottom + margin);
  // Hard bound on what the caller will allocate cells for. A selection
  // spanning more than MAX rows on its own (e.g. a full-buffer drag with the
  // cursor nearby) never enters the while guards, so the span check has to be
  // final and include the margin — otherwise "bounded" would not hold and one
  // keypress could read tens of thousands of buffer rows.
  if (bottom - top + 1 > MAX_SELECTION_EDIT_WINDOW_ROWS + 2 * margin) return null;
  return { top, bottom };
}


/**
 * Minimal structural view of the live xterm instance the wiring needs. The
 * adapter lives in TerminalDock (cell reads via IBufferLine/getNullCell);
 * everything else — window resolution, far-away precheck, row assembly — is
 * here so unit tests drive the EXACT production path, including the >8-row
 * wrapped-input window walk and the scrollback clear-only refusal.
 */
export interface SelectionEditTerminalLike {
  hasSelection(): boolean;
  getSelectionPosition(): { start: { x: number; y: number }; end: { x: number; y: number } } | undefined;
  buffer: {
    length: number;
    cursorX: number;
    cursorY: number;
    baseY: number;
    type: string; // "normal" | "alternate"
  };
  /** All cells of one absolute buffer row; null when the row vanished mid-read. */
  readRowCells(row: number): SelectionCellLike[] | null;
  isRowWrapped(row: number): boolean;
}

export function buildSelectionEditInput(terminal: SelectionEditTerminalLike): SelectionEditInput | null {
  const pos = terminal.getSelectionPosition();
  if (!pos || !terminal.hasSelection()) return null;
  const buf = terminal.buffer;
  // getSelectionPosition() is absolute; cursorY is viewport-relative, so the
  // live cursor lands at baseY + cursorY in the same space.
  const cursor = { x: buf.cursorX, y: buf.baseY + buf.cursorY };
  const selTop = Math.min(pos.start.y, pos.end.y);
  const selBottom = Math.max(pos.start.y, pos.end.y);
  // Cheap pre-check before any cell allocation: a selection entirely far away
  // from the cursor (scrollback) is refused by the planner anyway.
  if (selBottom < cursor.y - MAX_SELECTION_EDIT_WINDOW_ROWS || selTop > cursor.y + MAX_SELECTION_EDIT_WINDOW_ROWS) return null;
  const range = resolveSelectionEditWindow({
    bufferLength: buf.length,
    cursorY: cursor.y,
    selectionStartY: pos.start.y,
    selectionEndY: pos.end.y,
    isWrappedAt: (row) => terminal.isRowWrapped(row),
  });
  if (!range) return null;
  const rows: SelectionEditRow[] = [];
  for (let y = range.top; y <= range.bottom; y += 1) {
    const cells = terminal.readRowCells(y);
    if (!cells) return null;
    rows.push({ cells, isWrapped: terminal.isRowWrapped(y) });
  }
  return {
    rows,
    baseY: range.top,
    cursor,
    selection: { start: pos.start, end: pos.end },
    altScreen: buf.type === "alternate",
  };
}
export type SelectionEditKey = "backspace" | "delete" | { char: string };

export interface SelectionEditPlan {
  /** Bytes to write to the PTY: arrow moves, backspaces, optional typed char. */
  sequence: string;
  /** How many characters the plan erases from the input line. */
  deletedChars: number;
}

// Same arrow sequences the Alt+click caret mover proves in production, and
// the same erase byte the Ctrl+A bulk path already sends.
const ARROW_LEFT = "\x1b[D";
const ARROW_RIGHT = "\x1b[C";
const ERASE = "\b";
const MAX_EDIT_CHARS = 4096;

interface FlatChar {
  /** Cell column where this character starts. */
  col: number;
  /** Index into input.rows. */
  row: number;
  /** Characters written in the lead cell ("" = untouched blank). */
  ch: string;
  width: number;
  blank: boolean;
}

/**
 * Join the rows of one wrapped group into a flat character list. Trims the
 * two artifacts that exist only in cell space: the single wrap-gap blank on
 * continuation rows (wide char did not fit) and ALL trailing blanks of the
 * group's last row (line padding). Everything else counts as one character
 * per entry — the same counting a readline-style CLI cursor uses.
 */
function flattenGroup(rows: readonly SelectionEditRow[], gStart: number, gEnd: number): FlatChar[] {
  const flat: FlatChar[] = [];
  for (let i = gStart; i <= gEnd; i += 1) {
    const row = rows[i]!;
    const entries: FlatChar[] = [];
    let col = 0;
    for (const cell of row.cells) {
      if (cell.width === 0) continue; // invisible second half of a wide char
      const blank = cell.chars.length === 0;
      entries.push({ ch: blank ? " " : cell.chars, width: cell.width, blank, col, row: i });
      col += cell.width;
    }
    const next = rows[i + 1];
    if (i < gEnd) {
      // Wrap-gap: drop at most one trailing blank, only under the wide-lead signal.
      if (
        entries.length > 0 &&
        entries[entries.length - 1]!.blank &&
        next !== undefined &&
        next.isWrapped &&
        next.cells.length > 0 &&
        next.cells[0]!.width === 2
      ) {
        entries.pop();
      }
    } else {
      // Last row of the group: every trailing blank is right-side padding.
      while (entries.length > 0 && entries[entries.length - 1]!.blank) entries.pop();
    }
    flat.push(...entries);
  }
  return flat;
}

/** Characters left of cell x on row rowIdx, plus every char of earlier rows. */
function charOffset(flat: readonly FlatChar[], rowIdx: number, x: number): number {
  let n = 0;
  for (const e of flat) {
    if (e.row < rowIdx) n += 1;
    else if (e.row === rowIdx && e.col < x) n += 1;
  }
  return n;
}

function normalizeOrder(selection: SelectionEditInput["selection"]): SelectionEditInput["selection"] {
  const { start, end } = selection;
  if (end.y < start.y || (end.y === start.y && end.x < start.x)) {
    return { start: end, end: start };
  }
  return selection;
}

/**
 * Plans the PTY keystroke sequence that makes Backspace/Delete (or a typed
 * character) operate on the VISUAL selection instead of the CLI cursor.
 * Returns null when the translation is not safe; the caller then falls back
 * to clearing the highlight only (never wrong-deleting).
 */
export function planSelectionEdit(input: SelectionEditInput, key: SelectionEditKey): SelectionEditPlan | null {
  const { rows, baseY, cursor } = input;
  const selection = normalizeOrder(input.selection);
  if (selection.start.y === selection.end.y && selection.start.x === selection.end.x) return null;

  const cy = cursor.y - baseY;
  if (cy < 0 || cy >= rows.length) return null;
  const selStartRow = selection.start.y - baseY;
  const selEndRow = selection.end.y - baseY;
  if (selStartRow < 0 || selEndRow >= rows.length) return null;
  // The editable input line = the logical line containing the live CLI cursor.
  // It applies in BOTH buffers: Claude Code and Codex usually run INLINE (normal
  // buffer) and let the terminal soft-wrap their input, so an alt-screen-only
  // rule never fired there. Containment is what keeps this safe — a selection
  // reaching outside the cursor's own input line still falls back to clear-only.
  let gStart = cy;
  let gEnd = cy;
  while (gStart > 0 && rows[gStart]!.isWrapped) gStart -= 1;
  // Only a group whose TOP is cut off by the window is unusable; the walk still
  // reaches the true start of every group the window holds in full.
  if (gStart === 0 && rows[0]!.isWrapped) return null;
  while (gEnd + 1 < rows.length && rows[gEnd + 1]!.isWrapped) gEnd += 1;
  if (input.altScreen) {
    // A fullscreen TUI wraps its input ITSELF (hard wrap — isWrapped stays
    // false) and parks its caret on the input, with status/box rows right next
    // to it. So the group is also grown over the rows the selection actually
    // reaches, and only while the hard-wrap heuristic still holds; the group
    // never grows past the selection, so the offsets stay anchored on it.
    const cols = input.cols;
    if (cols !== undefined) {
      while (
        gStart > selStartRow &&
        gStart > 0 &&
        rowHardWrapsInto(rows[gStart - 1]!.cells, rows[gStart]!.cells, cols)
      ) {
        gStart -= 1;
      }
      while (
        gEnd < selEndRow &&
        gEnd + 1 < rows.length &&
        rowHardWrapsInto(rows[gEnd]!.cells, rows[gEnd + 1]!.cells, cols)
      ) {
        gEnd += 1;
      }
    }
    // No wrap signal at all: the caret row alone stays the input line.
  }

  if (selStartRow < gStart || selEndRow > gEnd) return null;

  const flat = flattenGroup(rows, gStart, gEnd);
  const selStart = charOffset(flat, selStartRow, selection.start.x);
  const selEnd = charOffset(flat, selEndRow, selection.end.x);
  const cur = charOffset(flat, cy, cursor.x);
  const deleted = selEnd - selStart;
  if (deleted <= 0) return null;

  // Move onto the selection END, then erase backwards = [selStart, selEnd).
  const lefts = Math.max(0, cur - selEnd);
  const rights = Math.max(0, selEnd - cur);
  if (lefts + rights + deleted > MAX_EDIT_CHARS) return null;

  let sequence = ARROW_LEFT.repeat(lefts) + ARROW_RIGHT.repeat(rights) + ERASE.repeat(deleted);
  if (typeof key === "object") sequence += key.char;
  return { sequence, deletedChars: deleted };
}
