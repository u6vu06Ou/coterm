// Cell-built selection text (terminal-selection-text.ts).
//
// The bug this kills: copy used to ride on terminal.getSelection(), whose row
// trimming counts program-painted spaces. Agent TUIs (Claude Code / Codex) fill
// every row to the pane width, so pasted text carried a run of blanks at each
// row end — and soft-wrapped rows glued those blanks straight into the middle of
// a path. Rules under test: every row right-trimmed, wrapped neighbours joined
// with no separator/indent, real boundaries kept as "\n", wide CJK tails
// emitting nothing.
import { describe, expect, it } from "vitest";
import {
  selectionTextFromRows,
  type SelectionTextCell,
  type SelectionTextRow,
} from "../../src/renderer/src/components/terminal-selection-text";

const cell = (chars: string, width = 1): SelectionTextCell => ({ chars, width });
const narrow = (s: string): SelectionTextCell[] => [...s].map((ch) => cell(ch));
// A wide char is a width-2 lead plus an invisible width-0 tail.
const wide = (ch: string): SelectionTextCell[] => [cell(ch, 2), cell("", 0)];
const blank = (n: number): SelectionTextCell[] => Array.from({ length: n }, () => cell("", 1));
const spaces = (n: number): SelectionTextCell[] => Array.from({ length: n }, () => cell(" "));

function row(
  cells: SelectionTextCell[],
  opts: { startX?: number; endX?: number; soft?: boolean; hard?: boolean } = {},
): SelectionTextRow {
  return {
    cells,
    startX: opts.startX ?? 0,
    endX: opts.endX ?? cells.length,
    softWrapsNext: opts.soft ?? false,
    hardWrapsNext: opts.hard ?? false,
  };
}

describe("selectionTextFromRows — row padding", () => {
  it("drops spaces a TUI painted full-width to clear the row", () => {
    const padded = [...narrow("hello world"), ...spaces(29)];
    expect(selectionTextFromRows([row(padded)])).toBe("hello world");
  });

  it("drops unwritten null cells too", () => {
    const padded = [...narrow("totals: 42"), ...blank(30)];
    expect(selectionTextFromRows([row(padded)])).toBe("totals: 42");
  });

  it("keeps interior runs of spaces (column alignment is content)", () => {
    expect(selectionTextFromRows([row(narrow("a    b"), { endX: 6 })])).toBe("a    b");
  });

  it("applies the padding trim on EVERY row, not just the last", () => {
    const first = [...narrow("first"), ...spaces(5)];
    const second = [...narrow("second"), ...spaces(4)];
    expect(selectionTextFromRows([row(first), row(second)])).toBe("first\nsecond");
  });
});

describe("selectionTextFromRows — wraps", () => {
  it("joins a soft-wrapped row tight (the terminal only breaks full rows)", () => {
    // 40 columns: the path fills the row except its last 3 cells, which the
    // terminal may not use for a further path character.
    const first = [...narrow("D:\\workspace\\MY_RESEARCH\\research\\OBSE"), ...spaces(0)];
    const second = [...narrow("RVATORY_20261022.html")];
    expect(selectionTextFromRows([row(first, { soft: true }), row(second)])).toBe(
      "D:\\workspace\\MY_RESEARCH\\research\\OBSE" + "RVATORY_20261022.html",
    );
  });

  it("keeps a word separator that sits at a soft wrap", () => {
    // The space before the break is real content: it is where the row ran out.
    const first = narrow("a".repeat(39) + " ");
    const second = narrow("bar");
    expect(selectionTextFromRows([row(first, { soft: true }), row(second)])).toBe("a".repeat(39) + " bar");
  });

  it("keeps the continuation's own indent at a soft wrap", () => {
    const first = narrow("a".repeat(40));
    const second = [...spaces(2), ...narrow("indented")];
    expect(selectionTextFromRows([row(first, { soft: true }), row(second)])).toBe("a".repeat(40) + "  indented");
  });

  it("joins a TUI hard wrap the same way", () => {
    const first = [...narrow("https://example.com/reports/2026/oct/"), ...spaces(1)];
    const second = [...narrow("43/full.html — done"), ...spaces(6)];
    expect(selectionTextFromRows([row(first, { hard: true }), row(second)])).toBe(
      "https://example.com/reports/2026/oct/43/full.html — done",
    );
  });

  it("strips the continuation row's TUI indent on a HARD wrap", () => {
    const first = [...narrow("● a paragraph the TUI wrapped itself"), ...spaces(2)];
    const second = [...spaces(2), ...narrow("continuation text"), ...spaces(9)];
    expect(selectionTextFromRows([row(first, { hard: true }), row(second)])).toBe(
      "● a paragraph the TUI wrapped itselfcontinuation text",
    );
  });

  it("keeps the continuation row's leading spaces on a SOFT wrap (real content)", () => {
    // The terminal broke a full row at a cell boundary — the next row's spaces
    // are indented content, not TUI layout.
    const first = [...narrow("a".repeat(40))];
    const second = [...spaces(4), ...narrow("indented code")];
    expect(selectionTextFromRows([row(first, { soft: true }), row(second)])).toBe(
      "a".repeat(40) + "    indented code",
    );
  });

  it("keeps the indent of a row that starts a new logical line", () => {
    const second = [...spaces(2), ...narrow("nested code"), ...spaces(4)];
    expect(selectionTextFromRows([row(narrow("parent")), row(second)])).toBe("parent\n  nested code");
  });

  it("keeps a real newline at every non-wrapped boundary", () => {
    const a = [...narrow("line one"), ...spaces(9)];
    const b = [...narrow("line two"), ...spaces(9)];
    const c = [...narrow("line three"), ...spaces(5)];
    expect(selectionTextFromRows([row(a), row(b), row(c)])).toBe("line one\nline two\nline three");
  });

  it("chains a three-row wrap", () => {
    expect(
      selectionTextFromRows([
        row(narrow("aaa"), { soft: true }),
        row(narrow("bbb"), { hard: true }),
        row(narrow("ccc")),
      ]),
    ).toBe("aaabbbccc");
  });

  it("a boundary that is both flagged still joins once", () => {
    expect(selectionTextFromRows([row(narrow("x"), { soft: true, hard: true }), row(narrow("y"))])).toBe("xy");
  });

  it("empty row list → empty string", () => {
    expect(selectionTextFromRows([])).toBe("");
  });
});

describe("selectionTextFromRows — wide CJK chars", () => {
  it("omits the unwritten last column when a wide glyph wraps to the next row", () => {
    expect(selectionTextFromRows([
      row([...narrow("abc"), ...blank(1)], { soft: true }),
      row(wide("中")),
    ])).toBe("abc中");
  });

  it("emits a wide char once and its invisible tail as nothing", () => {
    const cells = [...wide("入"), ...wide("口"), ...wide("："), ...narrow("D:\\x"), ...spaces(4)];
    expect(selectionTextFromRows([row(cells)])).toBe("入口：D:\\x");
  });

  it("includes the wide char when the range starts on its tail cell", () => {
    const cells = [...narrow("ab"), ...wide("你"), ...narrow("cd")];
    expect(selectionTextFromRows([row(cells, { startX: 3 })])).toBe("你cd");
  });

  it("includes the wide char when the range ends on its lead cell", () => {
    const cells = [...narrow("ab"), ...wide("你"), ...narrow("cd")];
    expect(selectionTextFromRows([row(cells, { startX: 0, endX: 3 })])).toBe("ab你");
  });

  it("a wide char never turns into a space, even at a wrap boundary", () => {
    const first = [...narrow("abc"), ...wide("好"), ...spaces(2)];
    const second = [...wide("世"), ...narrow("x")];
    // A soft-wrapped row keeps its edge blanks (they are content), and the wide
    // tail cells still emit nothing.
    expect(selectionTextFromRows([row(first, { soft: true }), row(second)])).toBe("abc好  世x");
  });

  it("a wide char alone at a wrap boundary glues without a space", () => {
    const first = [...narrow("abc"), ...wide("好")];
    const second = [...narrow("x")];
    expect(selectionTextFromRows([row(first, { soft: true }), row(second)])).toBe("abc好x");
  });

  it("a wide-char-only selection is not mistaken for padding", () => {
    const cells = [...wide("中"), ...wide("文"), ...spaces(3)];
    expect(selectionTextFromRows([row(cells)])).toBe("中文");
  });
});

describe("selectionTextFromRows — range boundaries", () => {
  it("a zero-width last row adds no trailing newline", () => {
    // getSelectionPosition() can report end.x 0 one row below the last selected
    // row; that row contributes nothing, so no blank line may follow.
    const first = narrow("done");
    const empty: SelectionTextCell[] = [];
    expect(selectionTextFromRows([row(first), row(empty)])).toBe("done");
  });

  it("respects startX/endX (end exclusive)", () => {
    const cells = [...narrow("prefix: value")];
    expect(selectionTextFromRows([row(cells, { startX: 8, endX: 13 })])).toBe("value");
  });

  it("clamps an endX past the cell list", () => {
    expect(selectionTextFromRows([row(narrow("abc"), { endX: 99 })])).toBe("abc");
  });

  it("a selection of only padding collapses to empty", () => {
    expect(selectionTextFromRows([row([...narrow("done"), ...spaces(10)], { startX: 4 })])).toBe("");
  });

  it("NBSP padding is trimmed as well as plain spaces", () => {
    const cells = [...narrow("a\u00a0b"), ...spaces(3)];
    expect(selectionTextFromRows([row(cells)])).toBe("a\u00a0b");
  });
});
