import { describe, expect, it } from "vitest";
import {
  joinHardWrappedSelection,
  rowHardWrapsInto,
  type SelectionRowSignals,
  type TerminalCellLike,
} from "../../src/renderer/src/components/terminal-links";

const COLS = 40;
const cell = (chars: string, width: number): TerminalCellLike => ({ chars, width });
const narrowCells = (s: string): TerminalCellLike[] => [...s].map((ch) => cell(ch, 1));
// A wide char is a width-2 cell followed by an invisible width-0 tail.
const wideCells = (ch: string): TerminalCellLike[] => [cell(ch, 2), cell("", 0)];
// Pad a cell list out with `count` unwritten (null) buffer cells.
const padNull = (cells: TerminalCellLike[], count: number): TerminalCellLike[] =>
  count > 0 ? [...cells, ...Array.from({ length: count }, () => cell("", 1))] : cells;
// Pad with WRITTEN spaces (a TUI that paints the row full-width to clear it).
const padSpaces = (cells: TerminalCellLike[], count: number): TerminalCellLike[] =>
  count > 0 ? [...cells, ...Array.from({ length: count }, () => cell(" ", 1))] : cells;

const widthOf = (cells: TerminalCellLike[]): number => cells.reduce((sum, c) => sum + c.width, 0);

const rows = (...entries: Partial<SelectionRowSignals>[]): SelectionRowSignals[] =>
  entries.map((e) => ({ softWrapsNext: false, hardWrapsNext: false, ...e }));

describe("rowHardWrapsInto (TUI hard-wrap detection)", () => {
  it("joins a row whose content fills the last column", () => {
    const full = narrowCells("a".repeat(COLS));
    expect(rowHardWrapsInto(padNull(full, 0), narrowCells("continues"), COLS)).toBe(true);
  });

  it("joins when a wide char leaves the final cell unwritten (cols - 1)", () => {
    // 39 narrow cells occupy columns 0..38; the last column sits unwritten
    // because a following wide char did not fit and moved to the next row.
    // Real (non-padding) content reaches cols - 1, which still counts as full.
    const content = narrowCells("x".repeat(COLS - 1));
    expect(rowHardWrapsInto(padNull(content, 1), narrowCells("rest"), COLS)).toBe(true);
  });

  it("does not join a row that ends short of the edge", () => {
    const short = narrowCells("short line");
    expect(rowHardWrapsInto(padNull(short, COLS - 10), narrowCells("next"), COLS)).toBe(false);
  });

  it("ignores full-width whitespace padding a TUI painted to clear the row", () => {
    const padded = padSpaces(narrowCells("painted row"), COLS - 11);
    expect(widthOf(padded)).toBe(COLS);
    expect(rowHardWrapsInto(padded, narrowCells("next"), COLS)).toBe(false);
  });

  it("does not join box-drawing borders that fill the width by design", () => {
    const border = narrowCells(`╭${"─".repeat(COLS - 2)}╮`);
    expect(rowHardWrapsInto(border, narrowCells("│ inside"), COLS)).toBe(false);
    // Interior row ends with the right border at the last column, too.
    const interior = narrowCells(`│ content${" ".repeat(COLS - 11)}│`);
    expect(rowHardWrapsInto(interior, narrowCells("╰ bottom"), COLS)).toBe(false);
  });

  it("does not join when the next row starts with box-drawing chrome", () => {
    const full = narrowCells("z".repeat(COLS));
    expect(rowHardWrapsInto(full, narrowCells("│ next interior row"), COLS)).toBe(false);
  });

  it("does not join into an empty or all-blank next row", () => {
    const full = narrowCells("q".repeat(COLS));
    expect(rowHardWrapsInto(full, padNull([], COLS), COLS)).toBe(false);
    expect(rowHardWrapsInto(full, padSpaces([], COLS), COLS)).toBe(false);
    expect(rowHardWrapsInto(full, undefined, COLS)).toBe(false);
  });

  it("counts wide CJK content toward the fill", () => {
    // "入口：" = 3 wide chars = 6 columns; fill the rest with narrow chars.
    const content = [...wideCells("入"), ...wideCells("口"), ...wideCells("："), ...narrowCells("a".repeat(COLS - 6))];
    expect(rowHardWrapsInto(content, narrowCells("continuation"), COLS)).toBe(true);
  });
});

describe("joinHardWrappedSelection (copy across hard wraps)", () => {
  it("joins a hard-wrapped path with a CJK prefix without newline or spaces", () => {
    // The user repro: 網站新入口：D:\...\OBSE / RVATORY_20261022.html.
    const first = "網站新入口：D:\\workspace\\trade\\MY_RESEARCH\\research\\strategy_observatory_20261021\\OBSE";
    const second = "RVATORY_20261022.html";
    const joined = joinHardWrappedSelection(
      `${first}\r\n${second}`,
      rows({ hardWrapsNext: true }, {}),
    );
    expect(joined).toBe(`${first}${second}`);
  });

  it("joins a hard-wrapped URL", () => {
    const first = "report at https://example.com/reports/observatory/2026/october/week";
    const second = "43/full.html — done";
    const joined = joinHardWrappedSelection(`${first}\n${second}`, rows({ hardWrapsNext: true }, {}));
    expect(joined).toBe(`${first}${second}`);
  });

  it("keeps the newline between two ordinary short lines", () => {
    const joined = joinHardWrappedSelection("first line\nsecond line", rows({}, {}));
    expect(joined).toBe("first line\nsecond line");
  });

  it("strips padding spaces at the wrap point and indent on the continuation", () => {
    const joined = joinHardWrappedSelection(
      "  D:\\proj\\out_very_long_name_part   \n    one.html",
      rows({ hardWrapsNext: true }, {}),
    );
    expect(joined).toBe("  D:\\proj\\out_very_long_name_partone.html");
  });

  it("leaves non-joined chunks byte-identical, including trailing padding", () => {
    // A following cleanTerminalCopy pass owns the trailing-space trim; the join
    // helper must not pre-trim rows that keep their newline.
    const joined = joinHardWrappedSelection("plain text   \nnext", rows({}, {}));
    expect(joined).toBe("plain text   \nnext");
  });

  it("chains a three-row hard wrap", () => {
    const joined = joinHardWrappedSelection(
      "aaa\nbbb\nccc",
      rows({ hardWrapsNext: true }, { hardWrapsNext: true }, {}),
    );
    expect(joined).toBe("aaabbbccc");
  });

  it("does not touch soft-wrapped rows (xterm already joined them)", () => {
    // First row soft-wraps into the second: getSelection text has no newline
    // between them; only the hard boundary before the third row is decided here.
    const joined = joinHardWrappedSelection(
      "softpartonesoftpartwo\nlast",
      rows({ softWrapsNext: true, hardWrapsNext: true }, { hardWrapsNext: false }, {}),
    );
    expect(joined).toBe("softpartonesoftpartwo\nlast");
  });

  it("returns null when chunk and row bookkeeping disagree (caller falls back)", () => {
    // Column-mode selections emit one chunk per row even across wraps.
    expect(joinHardWrappedSelection("a\nb", rows({ softWrapsNext: true }, {}))).toBeNull();
    expect(joinHardWrappedSelection("a\nb\nc", rows({}, {}))).toBeNull();
  });

  it("joins over NBSP padding left by the NBSP-to-space post-trim conversion", () => {
    const joined = joinHardWrappedSelection(
      "D:\\long\\path_segment \nnext_part.html",
      rows({ hardWrapsNext: true }, {}),
    );
    expect(joined).toBe("D:\\long\\path_segmentnext_part.html");
  });
});
