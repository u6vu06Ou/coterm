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
// Scope/safety gates: in the alternate screen (fullscreen Claude Code / Codex)
// only a selection on the caret's own row — those TUIs park the real cursor on
// their input caret but wrap long input themselves; in the NORMAL buffer only selections fully inside the logical line group containing
// the live cursor (scrollback selections refuse the translation — the caller
// then only clears the highlight and sends NOTHING to the PTY), and a total
// keystroke budget of MAX_EDIT_CHARS. Hard-newline multi-line input
// (Shift+Enter) is NOT one wrapped group, so cross-line selections there
// fall back to clear-only — documented, never wrong-deleting.

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
  /** True while the terminal sits in the alternate screen. */
  altScreen: boolean;
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
  let gStart = cy;
  let gEnd = cy;
  if (input.altScreen) {
    // Fullscreen agent TUIs (Claude Code, Codex) park the real cursor on their
    // input caret but wrap long input themselves — no isWrapped rows, plus
    // prompt/indent cells on every row. Only the caret's own row maps cleanly
    // to characters, so a selection on that row is translated; anything that
    // crosses rows stays clear-only.
    if (selection.start.y !== cursor.y || selection.end.y !== cursor.y) return null;
  } else {
    // Wrapped group containing the live cursor = the editable input line.
    while (gStart > 0 && rows[gStart]!.isWrapped) gStart -= 1;
    if (rows[gStart]!.isWrapped) return null; // group starts above the given window
    while (gEnd + 1 < rows.length && rows[gEnd + 1]!.isWrapped) gEnd += 1;
  }

  const selStartRow = selection.start.y - baseY;
  const selEndRow = selection.end.y - baseY;
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
