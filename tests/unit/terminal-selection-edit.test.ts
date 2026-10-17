// Selection-aware delete/replace planner (terminal-selection-edit.ts).
// Pure-function contract: buffer rows + cursor/selection CELL coordinates in,
// PTY keystroke sequence (or safe null) out. The bug this kills: Backspace
// over a mouse selection used to erase at the CLI's own cursor ("what I
// selected ≠ what got deleted"); the plan moves the CLI cursor onto the
// selection end with Left/Right arrows (never Up/Down — history recall) and
// erases exactly the highlighted characters.
import { describe, expect, it } from "vitest";
import {
  planSelectionEdit,
  type SelectionCellLike,
  type SelectionEditInput,
  type SelectionEditRow,
} from "../../src/renderer/src/components/terminal-selection-edit";

const L = "\x1b[D";
const R = "\x1b[C";
const BS = "\b";

function mkRow(
  text: string,
  opts: { wrapped?: boolean; wideChars?: string; pad?: number } = {},
): SelectionEditRow {
  const wide = new Set(Array.from(opts.wideChars ?? ""));
  const cells: SelectionCellLike[] = [];
  for (const ch of Array.from(text)) {
    if (wide.has(ch)) {
      cells.push({ chars: ch, width: 2 });
      cells.push({ chars: "", width: 0 }); // invisible tail cell
    } else {
      cells.push({ chars: ch, width: 1 });
    }
  }
  for (let i = 0; i < (opts.pad ?? 0); i += 1) cells.push({ chars: "", width: 1 });
  return { cells, isWrapped: opts.wrapped ?? false };
}

function geom(partial: Partial<SelectionEditInput> & Pick<SelectionEditInput, "rows" | "cursor" | "selection">): SelectionEditInput {
  return { baseY: 0, altScreen: false, ...partial };
}

describe("planSelectionEdit — single-line input", () => {
  const row = mkRow("❯ hello world"); // 13 cells: ❯ ␠ h e l l o ␠ w o r l d

  it("selection ending at the cursor erases exactly the highlighted chars", () => {
    const plan = planSelectionEdit(
      geom({ rows: [row], cursor: { x: 13, y: 0 }, selection: { start: { x: 8, y: 0 }, end: { x: 13, y: 0 } } }),
      "backspace",
    );
    expect(plan).not.toBeNull();
    expect(plan!.deletedChars).toBe(5); // "world"
    expect(plan!.sequence).toBe(BS.repeat(5)); // cursor already on the end — no arrows
  });

  it("selection before the cursor moves left onto its end first", () => {
    const plan = planSelectionEdit(
      geom({ rows: [row], cursor: { x: 13, y: 0 }, selection: { start: { x: 2, y: 0 }, end: { x: 7, y: 0 } } }),
      "delete",
    );
    expect(plan!.deletedChars).toBe(5); // "hello"
    expect(plan!.sequence).toBe(L.repeat(6) + BS.repeat(5));
  });

  it("selection after the cursor moves right onto its end", () => {
    const plan = planSelectionEdit(
      geom({ rows: [row], cursor: { x: 2, y: 0 }, selection: { start: { x: 8, y: 0 }, end: { x: 13, y: 0 } } }),
      "backspace",
    );
    expect(plan!.sequence).toBe(R.repeat(11) + BS.repeat(5));
  });

  it("a typed character replaces the selection (moves + erases + inserts)", () => {
    const plan = planSelectionEdit(
      geom({ rows: [row], cursor: { x: 13, y: 0 }, selection: { start: { x: 8, y: 0 }, end: { x: 13, y: 0 } } }),
      { char: "X" },
    );
    expect(plan!.deletedChars).toBe(5);
    expect(plan!.sequence).toBe(BS.repeat(5) + "X");
  });

  it("a reversed drag normalizes to the same plan", () => {
    const forward = planSelectionEdit(
      geom({ rows: [row], cursor: { x: 13, y: 0 }, selection: { start: { x: 8, y: 0 }, end: { x: 13, y: 0 } } }),
      "backspace",
    );
    const reversed = planSelectionEdit(
      geom({ rows: [row], cursor: { x: 13, y: 0 }, selection: { start: { x: 13, y: 0 }, end: { x: 8, y: 0 } } }),
      "backspace",
    );
    expect(reversed).toEqual(forward);
  });

  it("prompt glyphs covered by the drag count as chars but the plan stays bounded", () => {
    // Dragging over "❯ h" — the prompt itself is not editable CLI input, so
    // the CLI clamps the extra moves/backspaces into no-ops; the plan must
    // stay a plain bounded sequence (never something exotic).
    const plan = planSelectionEdit(
      geom({ rows: [row], cursor: { x: 7, y: 0 }, selection: { start: { x: 0, y: 0 }, end: { x: 3, y: 0 } } }),
      "backspace",
    );
    expect(plan!.deletedChars).toBe(3);
    expect(plan!.sequence).toBe(L.repeat(4) + BS.repeat(3));
  });
});

describe("planSelectionEdit — CJK wide chars count as 1 char per 2 cells", () => {
  // ❯ ␠ 你(2) 好(4) 世(6) 界(8) a(10) b(11) — 13 cells, 8 characters.
  const row = mkRow("❯ 你好世界ab", { wideChars: "你好世界" });

  it("selecting 世界 moves the CLI cursor by characters, not cells", () => {
    const plan = planSelectionEdit(
      geom({ rows: [row], cursor: { x: 13, y: 0 }, selection: { start: { x: 6, y: 0 }, end: { x: 10, y: 0 } } }),
      "backspace",
    );
    expect(plan!.deletedChars).toBe(2); // 世 + 界
    expect(plan!.sequence).toBe(L.repeat(2) + BS.repeat(2)); // cursor 8 chars in; sel end at 6
  });

  it("selecting everything after the prompt needs 6 backspaces, not 11 cells", () => {
    const plan = planSelectionEdit(
      geom({ rows: [row], cursor: { x: 13, y: 0 }, selection: { start: { x: 2, y: 0 }, end: { x: 13, y: 0 } } }),
      "backspace",
    );
    expect(plan!.deletedChars).toBe(6);
    expect(plan!.sequence).toBe(BS.repeat(6));
  });
});

describe("planSelectionEdit — soft-wrapped input lines", () => {
  // cols = 10: "❯ abcdefgh" fills row 0, "ijkl" wraps onto row 1 (padded).
  const row0 = mkRow("❯ abcdefgh");
  const row1 = mkRow("ijkl", { wrapped: true, pad: 6 });
  const cursor = { x: 4, y: 1 }; // right after "l"

  it("a selection crossing the wrap erases the joined character span", () => {
    const plan = planSelectionEdit(
      geom({ rows: [row0, row1], cursor, selection: { start: { x: 8, y: 0 }, end: { x: 2, y: 1 } } }),
      "backspace",
    );
    expect(plan!.deletedChars).toBe(4); // "ghij"
    expect(plan!.sequence).toBe(L.repeat(2) + BS.repeat(4)); // cursor offset 14, selEnd 12
  });

  it("row padding never counts as characters", () => {
    const plan = planSelectionEdit(
      geom({ rows: [row0, row1], cursor, selection: { start: { x: 0, y: 1 }, end: { x: 4, y: 1 } } }),
      "backspace",
    );
    expect(plan!.deletedChars).toBe(4); // exactly "ijkl", not 4+6 padding cells
    expect(plan!.sequence).toBe(BS.repeat(4));
  });

  it("a wide char straddling the wrap leaves no phantom char in the gap cell", () => {
    // 9 content cells + 1 unfittable blank gap (好 needs 2 cells) then wrap.
    const g0 = mkRow("❯ abcdefg", { pad: 1 });
    const g1 = mkRow("好xy", { wrapped: true, wideChars: "好" });
    const plan = planSelectionEdit(
      geom({ rows: [g0, g1], cursor: { x: 4, y: 1 }, selection: { start: { x: 0, y: 1 }, end: { x: 2, y: 1 } } }),
      "backspace",
    );
    expect(plan!.deletedChars).toBe(1); // just 好 — the gap cell is not a char
    expect(plan!.sequence).toBe(L.repeat(2) + BS.repeat(1)); // offsets 12→10
  });
});

describe("planSelectionEdit — refuses unsafe translations (caller falls back)", () => {
  const promptRow = mkRow("❯ hello");
  const outRow = mkRow("previous output");

  it("selection in scrollback output (not the input group) → null", () => {
    expect(
      planSelectionEdit(
        geom({ rows: [outRow, promptRow], cursor: { x: 7, y: 1 }, selection: { start: { x: 0, y: 0 }, end: { x: 8, y: 0 } } }),
        "backspace",
      ),
    ).toBeNull();
  });

  it("selection spanning scrollback into the input → null", () => {
    expect(
      planSelectionEdit(
        geom({ rows: [outRow, promptRow], cursor: { x: 7, y: 1 }, selection: { start: { x: 3, y: 0 }, end: { x: 4, y: 1 } } }),
        "backspace",
      ),
    ).toBeNull();
  });

  it("alternate screen (fullscreen TUI owns its cursor) → null", () => {
    expect(
      planSelectionEdit(
        geom({ rows: [promptRow], cursor: { x: 7, y: 0 }, selection: { start: { x: 2, y: 0 }, end: { x: 4, y: 0 } }, altScreen: true }),
        "backspace",
      ),
    ).toBeNull();
  });

  it("zero-length selection → null", () => {
    expect(
      planSelectionEdit(
        geom({ rows: [promptRow], cursor: { x: 7, y: 0 }, selection: { start: { x: 4, y: 0 }, end: { x: 4, y: 0 } } }),
        "backspace",
      ),
    ).toBeNull();
  });

  it("input group continues above the readable window → null", () => {
    const rows = [mkRow("abcdefgh", { wrapped: true }), mkRow("ij", { wrapped: true })];
    expect(
      planSelectionEdit(
        geom({ rows, cursor: { x: 2, y: 1 }, selection: { start: { x: 0, y: 1 }, end: { x: 2, y: 1 } } }),
        "backspace",
      ),
    ).toBeNull();
  });

  it("cursor outside the given rows → null", () => {
    expect(
      planSelectionEdit(
        geom({ rows: [promptRow], cursor: { x: 1, y: 5 }, selection: { start: { x: 2, y: 0 }, end: { x: 4, y: 0 } } }),
        "backspace",
      ),
    ).toBeNull();
  });

  it("selection beyond the keystroke budget → null (no megabyte paste to PTY)", () => {
    const big = mkRow("a".repeat(5000));
    expect(
      planSelectionEdit(
        geom({ rows: [big], cursor: { x: 5000, y: 0 }, selection: { start: { x: 0, y: 0 }, end: { x: 5000, y: 0 } } }),
        "backspace",
      ),
    ).toBeNull();
  });
});
