import { describe, expect, it } from "vitest";
import { remainingQuota, staleAgeDays, usageLevel, usedQuota, USAGE_STALE_AFTER_MS } from "../../src/renderer/src/components/usage-hud-logic";

// Display contract (mirrors the Claude Code app): the bar shows USED quota,
// filling up as it is spent. Colour: <=60 cool, <=85 warn, >85 crit.
describe("usage HUD used quota", () => {
  it.each([
    [0, 0, "cool"],
    [43, 43, "cool"],
    [60, 60, "cool"],
    [61, 61, "warn"],
    [85, 85, "warn"],
    [86, 86, "crit"],
    [100, 100, "crit"],
  ] as const)("used %s -> clamped %s (%s)", (raw, used, level) => {
    expect(usedQuota(raw)).toBe(used);
    expect(usageLevel(used)).toBe(level);
  });

  it("clamps provider anomalies and preserves missing data", () => {
    expect(usedQuota(-8)).toBe(0);
    expect(usedQuota(108)).toBe(100);
    expect(usedQuota(null)).toBeNull();
    expect(usedQuota(Number.NaN)).toBeNull();
    expect(usageLevel(null)).toBe("none");
  });

  // remainingQuota survives only for the tooltip ("used X%, N% remaining").
  it("keeps remainingQuota for the tooltip", () => {
    expect(remainingQuota(43)).toBe(57);
    expect(remainingQuota(-8)).toBe(100);
    expect(remainingQuota(108)).toBe(0);
    expect(remainingQuota(null)).toBeNull();
    expect(remainingQuota(Number.NaN)).toBeNull();
  });
});

// #90/#92 honesty rule: a frozen source file must not keep printing its last
// number as if it were current quota. Measured on this machine, the Claude
// usage cache sat 7 weeks at 60% because only a real account session writes it.
describe("usage HUD stale detection", () => {
  const DAY = 24 * 60 * 60 * 1000;
  const now = 1_700_000_000_000;

  it("reports whole days for a slot past the 7-day window", () => {
    expect(staleAgeDays(now - 8 * DAY, now)).toBe(8);
    expect(staleAgeDays(now - 49 * DAY, now)).toBe(49);
  });

  it("treats a fresh slot as not stale (nothing to warn about)", () => {
    expect(staleAgeDays(now - 1 * DAY, now)).toBeNull();
    expect(staleAgeDays(now, now)).toBeNull();
    // Exactly at the boundary is not yet stale — off-by-one would flap daily.
    expect(staleAgeDays(now - USAGE_STALE_AFTER_MS, now)).toBeNull();
  });

  it("does not invent staleness for an unknown timestamp", () => {
    expect(staleAgeDays(null, now)).toBeNull();
    expect(staleAgeDays(undefined, now)).toBeNull();
    expect(staleAgeDays(Number.NaN, now)).toBeNull();
  });
});
