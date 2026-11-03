// Wiring-level regression for selection-aware delete (2026-11-03 workstream):
// the 53 planner-only tests proved the translation math; they did NOT prove
// the TerminalDock input assembly (window walk + far-away precheck) delivers
// a usable plan on a REALISTIC long wrapped input, or that a selection over
// program output produces NO keystrokes at all (never send backspaces into a
// running CLI). Both paths run here against the exact production functions
// (buildSelectionEditInput -> planSelectionEdit) with a fake terminal.
import { describe, expect, it } from "vitest";
import {
  buildSelectionEditInput,
  MAX_SELECTION_EDIT_WINDOW_ROWS,
  planSelectionEdit,
  type SelectionCellLike,
  type SelectionEditTerminalLike,
} from "../../src/renderer/src/components/terminal-selection-edit";

interface FakeRow { cells: SelectionCellLike[]; isWrapped: boolean }

/** Characters -> cell list; wide chars (CJK/emoji) get a width-0 tail cell. */
function cellsOf(text: string): SelectionCellLike[] {
  const wide = /^[\u2e80-\u9fff\u{1f300}-\u{1faff}\u{20000}-\u{2fa1f}$]/u;
  const cells: SelectionCellLike[] = [];
  for (const ch of Array.from(text)) {
    if (wide.test(ch)) {
      cells.push({ chars: ch, width: 2 });
      cells.push({ chars: "", width: 0 });
    } else {
      cells.push({ chars: ch, width: 1 });
    }
  }
  return cells;
}

/** Pack cells into terminal rows of `cols`; rows after the first continue the logical line. */
function wrapRows(cells: readonly SelectionCellLike[], cols: number): FakeRow[] {
  const rows: FakeRow[] = [];
  let used = 0;
  let current: SelectionCellLike[] = [];
  for (const cell of cells) {
    if (used + cell.width > cols) {
      rows.push({ cells: current, isWrapped: rows.length > 0 });
      current = [];
      used = 0;
    }
    current.push(cell);
    used += cell.width;
  }
  rows.push({ cells: current, isWrapped: rows.length > 0 });
  return rows;
}

function fakeTerminal(opts: {
  rows: FakeRow[];
  cursorRow: number;
  cursorX: number;
  selection: { start: { x: number; y: number }; end: { x: number; y: number } } | null;
  blankRowsBefore?: number;
  altScreen?: boolean;
}): SelectionEditTerminalLike {
  const lead: FakeRow[] = Array.from({ length: opts.blankRowsBefore ?? 0 }, () => ({
    cells: [{ chars: "o", width: 1 }],
    isWrapped: false,
  }));
  const rows = [...lead, ...opts.rows];
  return {
    hasSelection: () => opts.selection !== null,
    getSelectionPosition: () => opts.selection ?? undefined,
    buffer: {
      length: rows.length,
      cursorX: opts.cursorX,
      cursorY: opts.cursorRow,
      baseY: 0,
      type: opts.altScreen ? "alternate" : "normal",
    },
    readRowCells: (row) => rows[row]?.cells ?? null,
    isRowWrapped: (row) => rows[row]?.isWrapped ?? false,
  };
}

const BS = "\b";
const ARROW_LEFT = "\x1b[D";

describe("selection edit wiring (buildSelectionEditInput + planSelectionEdit)", () => {
  it("deletes a fully-selected >8-row mixed CJK/emoji/ascii input line (was: fixed 8-row window refused)", () => {
    // ~26 chars at cols=10 -> 13 wrapped rows, well beyond the old WINDOW=8.
    const typed = "ab你好cdef🙂🙂ghijklmnop🙂qr🙂你好你好".repeat(3); // ~84 chars -> 12+ rows at cols=10
    const rows = wrapRows(cellsOf(typed), 10);
    expect(rows.length).toBeGreaterThan(8);
    const last = rows[rows.length - 1]!;
    const cursorX = last.cells.reduce((sum, cell) => sum + cell.width, 0);
    const terminal = fakeTerminal({
      rows,
      cursorRow: rows.length - 1,
      cursorX,
      // xterm end.x is EXCLUSIVE: select from the first cell to one past the last.
      selection: { start: { x: 0, y: 0 }, end: { x: cursorX, y: rows.length - 1 } },
    });
    const input = buildSelectionEditInput(terminal);
    expect(input).not.toBeNull();
    const plan = planSelectionEdit(input!, "backspace");
    expect(plan).not.toBeNull();
    expect(plan!.deletedChars).toBe(Array.from(typed).length);
    // Cursor == selection end: pure backspaces, no arrow moves.
    expect(plan!.sequence).toBe(BS.repeat(plan!.deletedChars));
  });

  it("moves the CLI cursor with Left arrows only when it sits past the selection", () => {
    const typed = "hello terminal world again";
    const rows = wrapRows(cellsOf(typed), 10);
    const last = rows[rows.length - 1]!;
    const cursorX = last.cells.reduce((sum, cell) => sum + cell.width, 0);
    const terminal = fakeTerminal({
      rows,
      cursorRow: rows.length - 1,
      cursorX,
      // Select just the first row (first 10 chars).
      selection: { start: { x: 0, y: 0 }, end: { x: 10, y: 0 } },
    });
    const input = buildSelectionEditInput(terminal);
    const plan = planSelectionEdit(input!, "backspace");
    expect(plan).not.toBeNull();
    expect(plan!.deletedChars).toBe(10);
    const arrowCount = (plan!.sequence.match(/\x1b\[D/g) ?? []).length;
    expect(arrowCount).toBe(Array.from(typed).length - 10);
    expect(plan!.sequence.startsWith(ARROW_LEFT)).toBe(true);
  });

  it("returns null for a scrollback selection far from the cursor (output is never edited)", () => {
    const rows = wrapRows(cellsOf("some typed input"), 10);
    const terminal = fakeTerminal({
      rows,
      cursorRow: 600 + rows.length - 1,
      cursorX: 1,
      blankRowsBefore: 600,
      selection: { start: { x: 0, y: 10 }, end: { x: 8, y: 12 } }, // old output
    });
    expect(buildSelectionEditInput(terminal)).toBeNull();
  });

  it("refuses a selection on nearby OUTPUT rows the running program owns", () => {
    // Previous command output directly above the live input line: inside any
    // window, but outside the cursor-owning logical line -> no plan -> the
    // caller only clears the highlight and sends NOTHING to the PTY.
    const output = [
      { cells: cellsOf("previous command output one"), isWrapped: false },
      { cells: cellsOf("previous command output two"), isWrapped: false },
    ];
    const inputLine = wrapRows(cellsOf("x"), 10); // cursor line, 1 row
    const rows = [...output, ...inputLine];
    const terminal = fakeTerminal({
      rows,
      cursorRow: rows.length - 1,
      cursorX: 1,
      selection: { start: { x: 2, y: 0 }, end: { x: 20, y: 1 } },
    });
    const input = buildSelectionEditInput(terminal);
    expect(input).not.toBeNull();
    // Containment gate: selection outside the cursor group -> null plan.
    expect(planSelectionEdit(input!, "backspace")).toBeNull();
    expect(planSelectionEdit(input!, { char: "q" })).toBeNull();
  });

  it("keeps the walk bounded by MAX_SELECTION_EDIT_WINDOW_ROWS and refuses safely", () => {
    // A wrapped input group far beyond the window budget (600 rows here) with
    // a selection only in its tail: the upward walk stops at the cap, the top
    // of the group is cut off, and the planner top-gate must REFUSE (caller
    // falls back to clear-only) rather than ever wrong-deleting.
    const typed = "x".repeat(6000);
    const huge = wrapRows(cellsOf(typed), 10); // 600 wrapped rows
    const last = huge[huge.length - 1]!;
    const cursorX = last.cells.reduce((sum, cell) => sum + cell.width, 0);
    const terminal = fakeTerminal({
      rows: huge,
      cursorRow: huge.length - 1,
      cursorX,
      selection: { start: { x: 0, y: huge.length - 4 }, end: { x: cursorX, y: huge.length - 1 } },
    });
    const input = buildSelectionEditInput(terminal);
    expect(input).not.toBeNull();
    expect(input!.rows.length).toBeLessThanOrEqual(MAX_SELECTION_EDIT_WINDOW_ROWS + 6);
    expect(planSelectionEdit(input!, "backspace")).toBeNull();
  });
it("refuses a >MAX-rows selection with the cursor inside it — final length bound, zero cell reads", () => {
    // The distance precheck passes (cursor sits mid-selection), so only the
    // final window-length bound can refuse this; without it the caller would
    // allocate cells for 1000 rows on a single keypress.
    const rows: FakeRow[] = Array.from({ length: 1000 }, () => ({
      cells: [{ chars: "o", width: 1 }],
      isWrapped: false,
    }));
    let cellReads = 0;
    const terminal = fakeTerminal({
      rows,
      cursorRow: 500,
      cursorX: 1,
      selection: { start: { x: 0, y: 0 }, end: { x: 1, y: 999 } },
    });
    const original = terminal.readRowCells.bind(terminal);
    terminal.readRowCells = (row) => {
      cellReads += 1;
      return original(row);
    };
    expect(buildSelectionEditInput(terminal)).toBeNull();
    expect(cellReads).toBe(0);
  });
});
