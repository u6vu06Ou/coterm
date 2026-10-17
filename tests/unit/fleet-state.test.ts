import { describe, expect, it } from "vitest";
import {
  computeFleetCounts,
  nextAttentionTerminal,
  nextAttentionTerminalInBucket,
  attentionBucketFor,
  fleetBucketFor,
  ATTENTION_NAV_ORDER,
  EMPTY_FLEET_COUNTS,
  FLEET_BUCKETS,
  type FleetTile,
} from "../../src/renderer/src/components/fleet-state";
import type { PtyState } from "../../src/shared/types";

const T1 = "11111111-1111-4111-8111-111111111111";
const T2 = "22222222-2222-4222-8222-222222222222";
const T3 = "33333333-3333-4333-8333-333333333333";
const T4 = "44444444-4444-4444-8444-444444444444";
const T5 = "55555555-5555-4555-8555-555555555555";

function tile(terminalId: string, isAgent: boolean): FleetTile {
  return { terminalId, isAgent };
}

describe("fleetBucketFor — all seven canonical states + idle", () => {
  it("maps each canonical PtyState to its fleet bucket for agent tiles", () => {
    expect(fleetBucketFor(true, "starting")).toBe("starting");
    expect(fleetBucketFor(true, "running")).toBe("running");
    expect(fleetBucketFor(true, "waiting_input")).toBe("needYou");
    expect(fleetBucketFor(true, "approval_required")).toBe("needYou");
    expect(fleetBucketFor(true, "blocked")).toBe("blocked");
    expect(fleetBucketFor(true, "done")).toBe("done");
    expect(fleetBucketFor(true, "error")).toBe("error");
  });

  it("non-agent tiles are Idle regardless of state", () => {
    expect(fleetBucketFor(false, "running")).toBe("idle");
    expect(fleetBucketFor(false, "error")).toBe("idle");
    expect(fleetBucketFor(false, null)).toBe("idle");
  });

  it("agent tiles with no state are Idle", () => {
    expect(fleetBucketFor(true, null)).toBe("idle");
    expect(fleetBucketFor(true, undefined)).toBe("idle");
  });
});

describe("computeFleetCounts — seven labeled buckets", () => {
  it("empty tile list → all-zero counts", () => {
    expect(computeFleetCounts([], {})).toEqual(EMPTY_FLEET_COUNTS);
  });

  it("total equals the number of visible dock tiles (not the state map size)", () => {
    const tiles = [tile(T1, true), tile(T2, true), tile(T3, false)];
    const states: Record<string, PtyState> = { [T1]: "running", [T2]: "error" };
    const counts = computeFleetCounts(tiles, states);
    expect(counts.total).toBe(3);
  });

  it("stale state for terminals not in the layout is NOT counted", () => {
    const tiles = [tile(T1, true)]; // only T1 is visible
    const states: Record<string, PtyState> = {
      [T1]: "running",
      [T2]: "error", // T2 is closed / not in layout — must be ignored
      [T3]: "blocked",
    };
    const counts = computeFleetCounts(tiles, states);
    expect(counts.total).toBe(1);
    expect(counts.running).toBe(1);
    expect(counts.error).toBe(0);
    expect(counts.blocked).toBe(0);
  });

  it("counts each of the seven buckets correctly", () => {
    const tiles = [
      tile(T1, true), // starting
      tile(T2, true), // running
      tile(T3, true), // waiting_input → needYou
      tile(T4, true), // approval_required → needYou
      tile(T5, true), // blocked
    ];
    const states: Record<string, PtyState> = {
      [T1]: "starting",
      [T2]: "running",
      [T3]: "waiting_input",
      [T4]: "approval_required",
      [T5]: "blocked",
    };
    const counts = computeFleetCounts(tiles, states);
    expect(counts.starting).toBe(1);
    expect(counts.running).toBe(1);
    expect(counts.needYou).toBe(2);
    expect(counts.blocked).toBe(1);
    expect(counts.error).toBe(0);
    expect(counts.done).toBe(0);
    expect(counts.idle).toBe(0);
  });

  it("non-agent tiles and agent tiles with no state count as Idle", () => {
    const tiles = [
      tile(T1, false), // non-agent → idle
      tile(T2, true),  // agent, no state → idle
      tile(T3, true),  // agent, done
    ];
    const states: Record<string, PtyState> = { [T3]: "done" };
    const counts = computeFleetCounts(tiles, states);
    expect(counts.idle).toBe(2);
    expect(counts.done).toBe(1);
  });

  it("does not store counters — recomputes from the inputs every call", () => {
    const tiles = [tile(T1, true)];
    const states: Record<string, PtyState> = { [T1]: "running" };
    const first = computeFleetCounts(tiles, states);
    expect(first.running).toBe(1);
    // Mutate the source map and recompute — the selector has no cached state.
    states[T2] = "error";
    const second = computeFleetCounts(tiles, states);
    expect(second.running).toBe(1);
    expect(second.error).toBe(0); // T2 not in tiles → ignored
    expect(second.total).toBe(1);
  });

  it("FLEET_BUCKETS has exactly the seven labeled buckets in order", () => {
    expect([...FLEET_BUCKETS]).toEqual([
      "starting",
      "running",
      "needYou",
      "blocked",
      "error",
      "done",
      "idle",
    ]);
  });
});

describe("attentionBucketFor", () => {
  it("maps error → error, blocked → blocked, input/approval → needYou", () => {
    expect(attentionBucketFor(true, "error")).toBe("error");
    expect(attentionBucketFor(true, "blocked")).toBe("blocked");
    expect(attentionBucketFor(true, "waiting_input")).toBe("needYou");
    expect(attentionBucketFor(true, "approval_required")).toBe("needYou");
  });

  it("returns null for non-attention states and non-agent tiles", () => {
    expect(attentionBucketFor(true, "running")).toBeNull();
    expect(attentionBucketFor(true, "starting")).toBeNull();
    expect(attentionBucketFor(true, "done")).toBeNull();
    expect(attentionBucketFor(true, null)).toBeNull();
    expect(attentionBucketFor(false, "error")).toBeNull();
  });
});

describe("nextAttentionTerminal — cyclic Error → Blocked → Need-you", () => {
  it("returns null when no attention terminals exist", () => {
    const tiles = [tile(T1, true), tile(T2, true)];
    const states: Record<string, PtyState> = { [T1]: "running", [T2]: "done" };
    expect(nextAttentionTerminal(tiles, states, T1)).toBeNull();
  });

  it("returns null for an empty tile list", () => {
    expect(nextAttentionTerminal([], {}, null)).toBeNull();
  });

  it("starts at the first error terminal when current is not attention", () => {
    const tiles = [tile(T1, true), tile(T2, true), tile(T3, true)];
    const states: Record<string, PtyState> = {
      [T1]: "running",
      [T2]: "error",
      [T3]: "blocked",
    };
    expect(nextAttentionTerminal(tiles, states, T1)).toBe(T2);
  });

  it("advances through the flattened list: error → blocked → need-you", () => {
    const tiles = [tile(T1, true), tile(T2, true), tile(T3, true)];
    const states: Record<string, PtyState> = {
      [T1]: "error",
      [T2]: "blocked",
      [T3]: "waiting_input",
    };
    // Current is T1 (error) → next in flattened list is T2 (blocked).
    expect(nextAttentionTerminal(tiles, states, T1)).toBe(T2);
    // Current is T2 (blocked) → next is T3 (need-you).
    expect(nextAttentionTerminal(tiles, states, T2)).toBe(T3);
    // Current is T3 (need-you) → wraps to T1 (error).
    expect(nextAttentionTerminal(tiles, states, T3)).toBe(T1);
  });

  it("consecutive clicks advance within a bucket, never stuck", () => {
    const tiles = [tile(T1, true), tile(T2, true), tile(T3, true)];
    const states: Record<string, PtyState> = {
      [T1]: "error",
      [T2]: "error",
      [T3]: "error",
    };
    // Three errors in dock order T1, T2, T3. Consecutive clicks cycle through.
    expect(nextAttentionTerminal(tiles, states, T1)).toBe(T2);
    expect(nextAttentionTerminal(tiles, states, T2)).toBe(T3);
    expect(nextAttentionTerminal(tiles, states, T3)).toBe(T1);
  });

  it("only one attention terminal total → returns itself", () => {
    const tiles = [tile(T1, true), tile(T2, true)];
    const states: Record<string, PtyState> = { [T1]: "running", [T2]: "error" };
    expect(nextAttentionTerminal(tiles, states, T2)).toBe(T2);
    expect(nextAttentionTerminal(tiles, states, T1)).toBe(T2);
    expect(nextAttentionTerminal(tiles, states, null)).toBe(T2);
  });

  it("respects dock layout order within a bucket", () => {
    const tiles = [tile(T2, true), tile(T1, true)]; // T2 before T1 in layout
    const states: Record<string, PtyState> = { [T1]: "error", [T2]: "error" };
    // No current selection → first error in dock layout order = T2.
    expect(nextAttentionTerminal(tiles, states, null)).toBe(T2);
  });

  it("is deterministic — same inputs always produce the same output", () => {
    const tiles = [tile(T1, true), tile(T2, true), tile(T3, true), tile(T4, true)];
    const states: Record<string, PtyState> = {
      [T1]: "error",
      [T2]: "blocked",
      [T3]: "waiting_input",
      [T4]: "approval_required",
    };
    const a = nextAttentionTerminal(tiles, states, null);
    const b = nextAttentionTerminal(tiles, states, null);
    expect(a).toBe(b);
    expect(a).toBe(T1); // first error in dock order
  });

  it("ATTENTION_NAV_ORDER is Error → Blocked → Need-you", () => {
    expect([...ATTENTION_NAV_ORDER]).toEqual(["error", "blocked", "needYou"]);
  });
});

describe("nextAttentionTerminalInBucket — per-bucket navigation", () => {
  it("returns null when the bucket is empty", () => {
    const tiles = [tile(T1, true)];
    const states: Record<string, PtyState> = { [T1]: "running" };
    expect(nextAttentionTerminalInBucket(tiles, states, "error", null)).toBeNull();
  });

  it("returns the first terminal in the bucket when current is not in it", () => {
    const tiles = [tile(T1, true), tile(T2, true)];
    const states: Record<string, PtyState> = { [T1]: "error", [T2]: "blocked" };
    expect(nextAttentionTerminalInBucket(tiles, states, "error", T2)).toBe(T1);
  });

  it("advances within the bucket on consecutive clicks", () => {
    const tiles = [tile(T1, true), tile(T2, true), tile(T3, true)];
    const states: Record<string, PtyState> = {
      [T1]: "error",
      [T2]: "error",
      [T3]: "error",
    };
    expect(nextAttentionTerminalInBucket(tiles, states, "error", T1)).toBe(T2);
    expect(nextAttentionTerminalInBucket(tiles, states, "error", T2)).toBe(T3);
    expect(nextAttentionTerminalInBucket(tiles, states, "error", T3)).toBe(T1);
  });

  it("only one terminal in the bucket → returns itself", () => {
    const tiles = [tile(T1, true), tile(T2, true)];
    const states: Record<string, PtyState> = { [T1]: "running", [T2]: "error" };
    expect(nextAttentionTerminalInBucket(tiles, states, "error", T2)).toBe(T2);
    expect(nextAttentionTerminalInBucket(tiles, states, "error", null)).toBe(T2);
  });

  it("does not cross into other buckets", () => {
    const tiles = [tile(T1, true), tile(T2, true)];
    const states: Record<string, PtyState> = { [T1]: "error", [T2]: "blocked" };
    // error bucket only has T1; current is T1 → wraps to T1 (stays in bucket).
    expect(nextAttentionTerminalInBucket(tiles, states, "error", T1)).toBe(T1);
  });
});
