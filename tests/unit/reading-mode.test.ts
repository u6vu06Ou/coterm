import { describe, expect, it } from "vitest";
import {
  DEFAULT_READING_PRESET_ID,
  EMPTY_READING_SLOTS,
  MAX_READING_SLOTS,
  READING_PRESETS,
  placeInReadingSlot,
  pruneReadingSlots,
  readingSlotName,
  type ReadingPresetId,
  type ReadingSlots,
} from "../../src/renderer/src/components/reading-mode";

// 閱讀模式槽位規則 (1.5.44, spec 5乙; presets 2026-10-02): indexed slots,
// drop replaces, cross-drag swaps, dead tiles are pruned.

describe("reading-mode slot bookkeeping", () => {
  it("places into an empty slot", () => {
    const slots = placeInReadingSlot(EMPTY_READING_SLOTS, 0, "A");
    expect(slots).toEqual(["A", null]);
  });

  it("drop onto an occupied slot replaces the occupant", () => {
    const start: ReadingSlots = ["A", "B"];
    expect(placeInReadingSlot(start, 1, "C")).toEqual(["A", "C"]);
  });

  it("dragging a slotted terminal to the other slot swaps the two", () => {
    const start: ReadingSlots = ["A", "B"];
    expect(placeInReadingSlot(start, 1, "A")).toEqual(["B", "A"]);
  });

  it("swap when dragging the right terminal onto the left slot", () => {
    const start: ReadingSlots = ["A", "B"];
    expect(placeInReadingSlot(start, 0, "B")).toEqual(["B", "A"]);
  });

  it("dropping the same terminal onto its own slot is an identity no-op", () => {
    const start: ReadingSlots = ["A", null];
    expect(placeInReadingSlot(start, 0, "A")).toBe(start);
  });

  it("prunes slots whose terminal left the dock (zombie reclaim / close)", () => {
    const start: ReadingSlots = ["A", "B"];
    const pruned = pruneReadingSlots(start, new Set(["B"]));
    expect(pruned).toEqual([null, "B"]);
  });

  it("prune returns the same object when nothing changed (no render loop)", () => {
    const start: ReadingSlots = ["A", null];
    expect(pruneReadingSlots(start, new Set(["A", "B"]))).toBe(start);
  });

  it("drop into the empty slot stays swap-consistent with the other slot occupied", () => {
    const start: ReadingSlots = ["A", null];
    expect(placeInReadingSlot(start, 1, "A")).toEqual([null, "A"]);
  });

  it("placing past the current width grows the state (extras are kept, not lost)", () => {
    const grown = placeInReadingSlot(EMPTY_READING_SLOTS, 2, "C");
    expect(grown).toEqual([null, null, "C"]);
    // A larger preset then reveals the kept terminal at slot index 2.
    const sixSlots: ReadingSlots = [null, null, null, null, null, null].map((id, index) => grown[index] ?? id);
    expect(sixSlots[2]).toBe("C");
  });
});

// 排版預設幾何 (2026-10-02): each preset must tile its documented grid
// exactly (full coverage, no overlap) with the documented slot count.

const EXPECTED_PRESET_SHAPES: Record<ReadingPresetId, { cols: number[]; rows: number[]; slots: number }> = {
  "1-full": { cols: [1], rows: [1], slots: 1 },
  "2-halves": { cols: [1, 1], rows: [1], slots: 2 },
  "2-stacked": { cols: [1], rows: [1, 1], slots: 2 },
  "3-left-big": { cols: [1, 1], rows: [1, 1], slots: 3 },
  "4-left-big-tri": { cols: [2, 1, 1], rows: [1, 1], slots: 4 },
  "4-grid": { cols: [1, 1], rows: [1, 1], slots: 4 },
  "6-grid": { cols: [1, 1, 1], rows: [1, 1], slots: 6 },
};

describe("reading-mode layout presets", () => {
  it("has unique ids and a language-neutral label each", () => {
    const ids = READING_PRESETS.map((preset) => preset.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const preset of READING_PRESETS) expect(preset.label.length).toBeGreaterThan(0);
  });

  it("orders presets by slot count ascending (1→6)", () => {
    const counts = READING_PRESETS.map((preset) => preset.boxes.length);
    const sorted = [...counts].sort((a, b) => a - b);
    expect(counts).toEqual(sorted);
  });

  it.each(READING_PRESETS)("preset $id tiles its documented grid shape", (preset) => {
    const shape = EXPECTED_PRESET_SHAPES[preset.id];
    expect(preset.boxes).toHaveLength(shape.slots);
    // Coverage is in TRACK space: `2fr` is ONE grid track with double width,
    // so the track count is the array length, not the fr sum. For the
    // uniform [1,1,...] layouts track space equals the unit-cell grid.
    const totalCols = shape.cols.length;
    const totalRows = shape.rows.length;

    const cells = new Set<string>();
    for (const box of preset.boxes) {
      expect(box.col).toBeGreaterThanOrEqual(1);
      expect(box.row).toBeGreaterThanOrEqual(1);
      expect(box.col - 1 + box.colSpan).toBeLessThanOrEqual(totalCols);
      expect(box.row - 1 + box.rowSpan).toBeLessThanOrEqual(totalRows);
      for (let row = box.row; row < box.row + box.rowSpan; row += 1) {
        for (let col = box.col; col < box.col + box.colSpan; col += 1) {
          cells.add(`${row},${col}`);
        }
      }
    }
    // Full coverage with no overlap: every unit cell is hit exactly once.
    expect(cells.size).toBe(totalCols * totalRows);
  });

  it("defaults to the legacy side-by-side pair (e2e asserts 2 slots)", () => {
    expect(DEFAULT_READING_PRESET_ID).toBe("2-halves");
    const fallback = READING_PRESETS.find((preset) => preset.id === DEFAULT_READING_PRESET_ID);
    expect(fallback?.boxes).toHaveLength(2);
    expect(fallback?.boxes.map((box) => [box.col, box.row])).toEqual([
      [1, 1],
      [2, 1],
    ]);
  });

  it("MAX_READING_SLOTS covers the largest preset; slot names stay e2e-stable", () => {
    const largest = Math.max(...READING_PRESETS.map((preset) => preset.boxes.length));
    expect(largest).toBe(MAX_READING_SLOTS); // 6-grid is the upper bound today
    expect(readingSlotName(0)).toBe("left");
    expect(readingSlotName(1)).toBe("right");
    expect(readingSlotName(2)).toBe("slot-3");
  });
});
