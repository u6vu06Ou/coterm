// Selection-shape detection for the cell-accurate copy path (terminal-copy.ts).
//
// getSelection() has two shapes and the public API does not say which produced
// the text: NORMAL is a text run (whole middle rows) and COLUMN is an Alt+drag
// rectangle (one column span on every row). Guessing wrong is user-visible —
// it pastes whole rows for a rectangle or a rectangle for a text run — so the
// mode is scored against the legacy chunks instead.
import { describe, expect, it } from "vitest";
import { isColumnMode, rowCellsText } from "../../src/renderer/src/components/terminal-copy";

describe("rowCellsText", () => {
  it("skips wide-char tails and right-trims padding", () => {
    const cells = [{ chars: "你", width: 2 }, { chars: "", width: 0 }, { chars: "", width: 1 }, { chars: "", width: 1 }];
    expect(rowCellsText(cells)).toBe("你");
  });

  it("honours the requested column span", () => {
    const cells = [..."abcdef"].map((ch) => ({ chars: ch, width: 1 }));
    expect(rowCellsText(cells, 2, 5)).toBe("cde");
  });
});

describe("isColumnMode", () => {
  it("recognises a rectangle (every chunk is the same narrow span)", () => {
    expect(isColumnMode("ab\ncd\nef", ["abcdef", "abcdef", "abcdef"], ["ab", "cd", "ef"])).toBe(true);
  });

  it("recognises a text run (chunks are whole rows)", () => {
    // Normal mode: middle row whole, first/last partial but matching the run.
    expect(isColumnMode("bcd\nabcdef\ncd", ["bcd", "abcdef", "cd"], ["bc", "ab", "cd"])).toBe(false);
  });

  it("two-row rectangle wins over the normal hypothesis", () => {
    expect(isColumnMode("ab\ncd", ["abcdef", "abcdef"], ["ab", "cd"])).toBe(true);
  });

  it("chunk count mismatch → not column mode", () => {
    expect(isColumnMode("a\nb\nc", ["a", "b"], ["a", "b"])).toBe(false);
  });

  it("single row → not column mode (shapes coincide)", () => {
    expect(isColumnMode("abc", ["abcdef"], ["abc"])).toBe(false);
  });
});
