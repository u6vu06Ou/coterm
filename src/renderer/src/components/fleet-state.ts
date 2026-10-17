import type { PtyState } from "@shared/types";
import { ATTENTION_STATES } from "@shared/pty-state";

/**
 * A dock tile descriptor for fleet projection. Only the fields the projection
 * needs: the terminal id and whether the tile is an agent tile (non-agent
 * shells count as Idle regardless of any stale state).
 */
export interface FleetTile {
  terminalId: string;
  isAgent: boolean;
}

export type FleetCounts = {
  total: number;
  starting: number;
  running: number;
  needYou: number;
  blocked: number;
  error: number;
  done: number;
  idle: number;
};

export const EMPTY_FLEET_COUNTS: FleetCounts = {
  total: 0,
  starting: 0,
  running: 0,
  needYou: 0,
  blocked: 0,
  error: 0,
  done: 0,
  idle: 0,
};

/** Seven labeled fleet buckets in display order. */
export const FLEET_BUCKETS = [
  "starting",
  "running",
  "needYou",
  "blocked",
  "error",
  "done",
  "idle",
] as const;
export type FleetBucket = (typeof FLEET_BUCKETS)[number];

/**
 * Map a (isAgent, state) pair to its fleet bucket. Non-agent tiles or tiles
 * with no state → "idle". This is the single source of truth for bucket
 * assignment used by both counts and navigation.
 */
export function fleetBucketFor(
  isAgent: boolean,
  state: PtyState | null | undefined,
): FleetBucket {
  if (!isAgent || !state) return "idle";
  switch (state) {
    case "starting":
      return "starting";
    case "running":
      return "running";
    case "waiting_input":
    case "approval_required":
      return "needYou";
    case "blocked":
      return "blocked";
    case "error":
      return "error";
    case "done":
      return "done";
    default:
      return "idle";
  }
}

/**
 * Pure projection from the visible dock tile list + canonical PtyState map to
 * the seven labeled fleet counts. Selectors must NOT store counters — every
 * consumer recomputes from the inputs so stale counts can never drift.
 *
 * total = number of visible dock tiles (NOT the state map size). Stale state
 * for terminals no longer in the layout is ignored. Non-agent tiles or tiles
 * with no state count as Idle.
 */
export function computeFleetCounts(
  tiles: FleetTile[],
  states: Record<string, PtyState>,
): FleetCounts {
  const counts: FleetCounts = { ...EMPTY_FLEET_COUNTS };
  for (const tile of tiles) {
    counts.total += 1;
    const bucket = fleetBucketFor(tile.isAgent, states[tile.terminalId] ?? null);
    counts[bucket] += 1;
  }
  return counts;
}

/** Attention navigation cycle order: Error → Blocked → Need-you. */
export const ATTENTION_NAV_ORDER = ["error", "blocked", "needYou"] as const;
export type AttentionNavBucket = (typeof ATTENTION_NAV_ORDER)[number];

/** The three attention buckets that the cycle button navigates through. */
export const ATTENTION_NAV_BUCKETS: ReadonlySet<FleetBucket> = new Set(ATTENTION_NAV_ORDER);

export function attentionBucketFor(
  isAgent: boolean,
  state: PtyState | null | undefined,
): AttentionNavBucket | null {
  const bucket = fleetBucketFor(isAgent, state);
  return ATTENTION_NAV_BUCKETS.has(bucket) ? (bucket as AttentionNavBucket) : null;
}

/**
 * Deterministic cyclic attention navigation. Given the current selected
 * terminalId, the ordered tile list (dock layout order), and the canonical
 * state map, returns the next terminalId in the Error → Blocked → Need-you
 * cycle.
 *
 * Semantics (Round 2):
 * - Build a flattened list of attention terminals grouped by bucket (Error,
 *   then Blocked, then Need-you), each group in dock layout order.
 * - If the current selection is an attention terminal, the next is the
 *   following entry in the flattened list (wrapping). This means consecutive
 *   clicks always advance — never stuck — UNLESS there is exactly one
 *   attention terminal total, in which case it returns itself.
 * - If the current selection is not an attention terminal, start at the first
 *   attention terminal in the flattened list.
 * - Returns null when no attention terminal exists.
 *
 * Pure + deterministic: same inputs → same output. No stored cursor.
 */
export function nextAttentionTerminal(
  tiles: FleetTile[],
  states: Record<string, PtyState>,
  currentSelectedId: string | null,
): string | null {
  if (tiles.length === 0) return null;
  // Flattened attention list: Error group, then Blocked, then Need-you; each
  // group preserves dock layout order.
  const flattened: string[] = [];
  for (const bucket of ATTENTION_NAV_ORDER) {
    for (const tile of tiles) {
      if (attentionBucketFor(tile.isAgent, states[tile.terminalId] ?? null) === bucket) {
        flattened.push(tile.terminalId);
      }
    }
  }
  if (flattened.length === 0) return null;
  if (flattened.length === 1) return flattened[0] ?? null;
  if (currentSelectedId) {
    const idx = flattened.indexOf(currentSelectedId);
    if (idx !== -1) return flattened[(idx + 1) % flattened.length] ?? null;
  }
  return flattened[0] ?? null;
}

/** Re-export for tests/consumers that want the canonical attention set. */
export { ATTENTION_STATES };

/**
 * Find the first attention terminal in a specific bucket (Error/Blocked/Need-
 * you), in dock layout order. If the current selection is already in that
 * bucket, advance to the next terminal in that bucket (wrapping). Returns null
 * if the bucket is empty. Used by the per-bucket mobile navigation buttons.
 *
 * Pure + deterministic: same inputs → same output. No stored cursor.
 */
export function nextAttentionTerminalInBucket(
  tiles: FleetTile[],
  states: Record<string, PtyState>,
  bucket: AttentionNavBucket,
  currentSelectedId: string | null,
): string | null {
  const ids: string[] = [];
  for (const tile of tiles) {
    if (attentionBucketFor(tile.isAgent, states[tile.terminalId] ?? null) === bucket) {
      ids.push(tile.terminalId);
    }
  }
  if (ids.length === 0) return null;
  if (ids.length === 1) return ids[0] ?? null;
  if (currentSelectedId) {
    const idx = ids.indexOf(currentSelectedId);
    if (idx !== -1) return ids[(idx + 1) % ids.length] ?? null;
  }
  return ids[0] ?? null;
}
