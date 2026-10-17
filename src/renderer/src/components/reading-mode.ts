/**
 * 閱讀模式 (reading mode, 1.5.44) — pure slot bookkeeping + layout presets.
 *
 * Renderer-local only (zustand, in-memory): entering hides the dock grid and
 * shows preset layout slots (default: two side-by-side); the user drags open
 * session rows from the left sidebar project area into them. The main-owned
 * DockLayout is NEVER touched, so exiting the mode restores the exact original
 * layout with zero ghosting, and a restart simply comes back in normal mode
 * (the slot bookkeeping stays in-memory; only the chosen PRESET persists via
 * the settings patch route).
 *
 * Slot rules (locked 2026-09-22, spec 5乙; generalized 2026-10-02 to presets):
 *  - up to MAX_READING_SLOTS indexed slots, laid out by the chosen preset
 *  - dropping onto an occupied slot REPLACES its occupant
 *  - dragging a terminal that already sits in another slot SWAPS the two;
 *    slots hidden by the current preset keep their sessions (re-shown when
 *    the preset switches back)
 *  - a terminal that leaves the dock (killed / zombie-reclaimed) is pruned
 *    from its slot automatically
 */

/** Slot index (0-based), stable across preset switches. */
export type ReadingSlotKey = number;

/** Slot bookkeeping: ordered ids, null = empty. Renderer-local only. */
export type ReadingSlots = (string | null)[];

/** Upper bound on reading slots (matches the largest preset). */
export const MAX_READING_SLOTS = 6;

export const EMPTY_READING_SLOTS: ReadingSlots = [null, null];

/** Place terminalId at slot `index`, applying swap/replace rules. */
export function placeInReadingSlot(
  slots: ReadingSlots,
  index: ReadingSlotKey,
  terminalId: string,
): ReadingSlots {
  if (index < 0 || index >= MAX_READING_SLOTS) return slots;
  const from = slots.indexOf(terminalId);
  // Same slot, same terminal — identity.
  if (from === index) return slots;
  const width = Math.max(slots.length, index + 1, from + 1);
  const next = slots.slice(0, width);
  while (next.length < width) next.push(null);
  if (from !== -1) {
    // Dragging a slotted terminal across swaps the two slots. `slots[index]`
    // may be a null (dropping a visible slot's terminal onto a slot that was
    // empty before this drag) — ?? null keeps the types honest.
    next[index] = terminalId;
    next[from] = slots[index] ?? null;
  } else {
    // Drop on an empty slot fills it; drop on an occupied slot replaces
    // its occupant (the displaced id drops out of the grid).
    next[index] = terminalId;
  }
  return next;
}

/** Drop every slot entry whose terminal is no longer a live dock tile. */
export function pruneReadingSlots(
  slots: ReadingSlots,
  tileIds: ReadonlySet<string>,
): ReadingSlots {
  let changed = false;
  const next = slots.map((id) => {
    const keep = id !== null && tileIds.has(id) ? id : null;
    if (keep !== id) changed = true;
    return keep;
  });
  return changed ? next : slots;
}

// ---------------------------------------------------------------------------
// Layout presets — one-click buttons that draw the grid shape. Slot order
// indexes are shared across presets: preset switches never reorder placed
// sessions, and extras beyond the visible slot count stay in state.
// ---------------------------------------------------------------------------

export type ReadingPresetId =
  | "1-full"
  | "2-halves"
  | "2-stacked"
  | "3-left-big"
  | "4-left-big-tri"
  | "4-grid"
  | "6-grid";

/** 1-based CSS-grid box for one slot: column/row start + span. */
export interface ReadingSlotBox {
  col: number;
  colSpan: number;
  row: number;
  rowSpan: number;
}

export interface ReadingPreset {
  id: ReadingPresetId;
  cols: string;
  rows: string;
  boxes: ReadingSlotBox[];
  /** Language-neutral button tooltip (cell-count shape), no i18n dependency. */
  label: string;
}

export const DEFAULT_READING_PRESET_ID: ReadingPresetId = "2-halves";

/**
 * Fill order follows slot index (0 = first box). `4-left-big-tri` is the
 * requested 4-up: big left pane + one wide right-top + a bottom-right pair.
 */
export const READING_PRESETS: ReadingPreset[] = [
  {
    id: "1-full",
    cols: "1fr",
    rows: "1fr",
    boxes: [{ col: 1, colSpan: 1, row: 1, rowSpan: 1 }],
    label: "1",
  },
  {
    id: "2-halves",
    cols: "1fr 1fr",
    rows: "1fr",
    boxes: [
      { col: 1, colSpan: 1, row: 1, rowSpan: 1 },
      { col: 2, colSpan: 1, row: 1, rowSpan: 1 },
    ],
    label: "1×2",
  },
  {
    id: "2-stacked",
    cols: "1fr",
    rows: "1fr 1fr",
    boxes: [
      { col: 1, colSpan: 1, row: 1, rowSpan: 1 },
      { col: 1, colSpan: 1, row: 2, rowSpan: 1 },
    ],
    label: "2×1",
  },
  {
    id: "3-left-big",
    cols: "1fr 1fr",
    rows: "1fr 1fr",
    boxes: [
      { col: 1, colSpan: 1, row: 1, rowSpan: 2 },
      { col: 2, colSpan: 1, row: 1, rowSpan: 1 },
      { col: 2, colSpan: 1, row: 2, rowSpan: 1 },
    ],
    label: "3",
  },
  {
    id: "4-left-big-tri",
    cols: "2fr 1fr 1fr",
    rows: "1fr 1fr",
    boxes: [
      { col: 1, colSpan: 1, row: 1, rowSpan: 2 },
      { col: 2, colSpan: 2, row: 1, rowSpan: 1 },
      { col: 2, colSpan: 1, row: 2, rowSpan: 1 },
      { col: 3, colSpan: 1, row: 2, rowSpan: 1 },
    ],
    label: "4 (L)",
  },
  {
    id: "4-grid",
    cols: "1fr 1fr",
    rows: "1fr 1fr",
    boxes: [
      { col: 1, colSpan: 1, row: 1, rowSpan: 1 },
      { col: 2, colSpan: 1, row: 1, rowSpan: 1 },
      { col: 1, colSpan: 1, row: 2, rowSpan: 1 },
      { col: 2, colSpan: 1, row: 2, rowSpan: 1 },
    ],
    label: "2×2",
  },
  {
    id: "6-grid",
    cols: "1fr 1fr 1fr",
    rows: "1fr 1fr",
    boxes: [
      { col: 1, colSpan: 1, row: 1, rowSpan: 1 },
      { col: 2, colSpan: 1, row: 1, rowSpan: 1 },
      { col: 3, colSpan: 1, row: 1, rowSpan: 1 },
      { col: 1, colSpan: 1, row: 2, rowSpan: 1 },
      { col: 2, colSpan: 1, row: 2, rowSpan: 1 },
      { col: 3, colSpan: 1, row: 2, rowSpan: 1 },
    ],
    label: "3×2",
  },
];

/** Stable slot label for DOM data-attributes ("left"/"right" for the legacy pair). */
export function readingSlotName(index: number): string {
  return index === 0 ? "left" : index === 1 ? "right" : `slot-${index + 1}`;
}
