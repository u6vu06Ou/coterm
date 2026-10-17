import { describe, expect, it } from "vitest";
import { getProcessMemory } from "../../src/main/core/logger";

describe("getProcessMemory", () => {
  it("returns numeric byte fields for rss, heapUsed, heapTotal, external", () => {
    const snap = getProcessMemory();
    expect(typeof snap.rss).toBe("number");
    expect(typeof snap.heapUsed).toBe("number");
    expect(typeof snap.heapTotal).toBe("number");
    expect(typeof snap.external).toBe("number");
    // Values are bytes — should be non-negative and finite.
    for (const v of [snap.rss, snap.heapUsed, snap.heapTotal, snap.external]) {
      expect(Number.isFinite(v)).toBe(true);
      expect(v).toBeGreaterThanOrEqual(0);
    }
  });

  it("heapUsed never exceeds heapTotal", () => {
    const snap = getProcessMemory();
    expect(snap.heapUsed).toBeLessThanOrEqual(snap.heapTotal);
  });
});
