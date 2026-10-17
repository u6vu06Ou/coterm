// Turn-rail tick layout — pure math so the DOM overlay stays dumb.
// One tick per user turn, positioned proportionally inside the scroll range;
// ticks closer than the smallest hit area merge into one clickable cluster.

export interface TurnTickInput {
  // Index of the user message in the displayed list (keepFinalTurnOutputs is
  // always applied — 僅結論 is not a toggle).
  index: number;
  // Offset of the message top inside the scroll container's content.
  offset: number;
}

export interface TurnTick {
  firstIndex: number;
  lastIndex: number;
  // 0..1 position within the scrollable range.
  pos: number;
}

// Minimum relative gap below which two ticks visually overlap and merge.
export const TURN_RAIL_MIN_GAP = 0.02;

// Minimum clickable height of one tick in px; ticks closer than this in rail
// pixels would swallow each other's taps, so they cluster. Rail height ≈
// the scroll container's clientHeight, hence the px→fraction conversion.
export const TURN_RAIL_MIN_HIT_PX = 28;

export function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

export function layoutTurnTicks(
  entries: TurnTickInput[],
  scrollHeight: number,
  clientHeight: number,
  minGap: number = TURN_RAIL_MIN_GAP,
): TurnTick[] {
  const maxScroll = scrollHeight - clientHeight;
  if (!Number.isFinite(maxScroll) || maxScroll <= 0 || entries.length === 0) return [];
  const ticks: TurnTick[] = [];
  for (const entry of entries) {
    if (!Number.isFinite(entry.offset) || entry.index < 0) continue;
    const pos = clamp01(entry.offset / maxScroll);
    const last = ticks[ticks.length - 1];
    if (last && pos - last.pos < minGap) {
      // Cluster: same visual tick, tapping jumps to the first turn in it.
      last.lastIndex = entry.index;
    } else {
      ticks.push({ firstIndex: entry.index, lastIndex: entry.index, pos });
    }
  }
  return ticks;
}

// Which tick is active for a scroll position: the last tick at or above the
// current scroll fraction. Returns -1 when nothing is usable.
export function activeTurnTick(
  ticks: TurnTick[],
  scrollTop: number,
  scrollHeight: number,
  clientHeight: number,
): number {
  const maxScroll = scrollHeight - clientHeight;
  if (!Number.isFinite(maxScroll) || maxScroll <= 0 || ticks.length === 0) return -1;
  const fraction = clamp01(scrollTop / maxScroll);
  for (let i = ticks.length - 1; i >= 0; i--) {
    if (fraction + 1e-6 >= ticks[i]!.pos) return i;
  }
  return 0;
}

// Shallow compare so a no-op ResizeObserver callback doesn't re-render.
export function ticksEqual(a: TurnTick[], b: TurnTick[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((tick, i) => {
    const other = b[i]!;
    return tick.firstIndex === other.firstIndex
      && tick.lastIndex === other.lastIndex
      && Math.abs(tick.pos - other.pos) < 0.001;
  });
}
