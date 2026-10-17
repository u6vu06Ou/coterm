import { describe, expect, it } from "vitest";
import {
  AGENT_CPU_BUDGET_PERCENT,
  AGENT_RAM_BUDGET_BYTES,
  CPU_HEADROOM_PERCENT,
  RAM_HEADROOM_PERCENT,
  estimateAgentCapacity,
} from "../../src/shared/resource-estimate";

const GIB = 1024 * 1024 * 1024;

describe("resource-estimate constants (documented heuristic)", () => {
  it("pins the budget numbers the docs promise", () => {
    expect(AGENT_RAM_BUDGET_BYTES).toBeCloseTo(0.6 * GIB, 0);
    expect(AGENT_CPU_BUDGET_PERCENT).toBe(8);
    expect(CPU_HEADROOM_PERCENT).toBe(25);
    expect(RAM_HEADROOM_PERCENT).toBe(20);
  });
});

describe("estimateAgentCapacity", () => {
  it("idle machine: tiles are the only cap", () => {
    const result = estimateAgentCapacity({
      cpuPercent: 5, memUsedBytes: 4 * GIB, memTotalBytes: 32 * GIB,
      openTerminals: 2, maxTiles: 12,
    });
    // RAM: floor((25.6 - 4) / 0.6) = 36; CPU: floor((75 - 5) / 8) = 8; tiles: 10.
    expect(result.memCapacity).toBe(36);
    expect(result.cpuCapacity).toBe(8);
    expect(result.freeTiles).toBe(10);
    expect(result.recommendedMaxNewAgents).toBe(8);
    expect(result.limitedBy).toBe("cpu");
    expect(result.memPercent).toBe(13);
  });

  it("saturated machine returns 0 (the soft-limit toast case)", () => {
    const result = estimateAgentCapacity({
      cpuPercent: 92, memUsedBytes: 88 * 0.32 * GIB, memTotalBytes: 32 * GIB,
      openTerminals: 5, maxTiles: 12,
    });
    expect(result.recommendedMaxNewAgents).toBe(0);
    expect(result.limitedBy).toBe("cpu");
  });

  it("RAM-only saturation also returns 0", () => {
    const result = estimateAgentCapacity({
      cpuPercent: 10, memUsedBytes: 26 * GIB, memTotalBytes: 32 * GIB,
      openTerminals: 1, maxTiles: 12,
    });
    // 25.6 - 26 < 0 → no RAM budget left.
    expect(result.recommendedMaxNewAgents).toBe(0);
    expect(result.limitedBy).toBe("memory");
    expect(result.memPercent).toBe(81);
  });

  it("full dock clamps to 0 free tiles", () => {
    const result = estimateAgentCapacity({
      cpuPercent: 2, memUsedBytes: 2 * GIB, memTotalBytes: 32 * GIB,
      openTerminals: 12, maxTiles: 12,
    });
    expect(result.freeTiles).toBe(0);
    expect(result.recommendedMaxNewAgents).toBe(0);
    expect(result.limitedBy).toBe("tiles");
  });

  it("never exceeds free tiles even on a huge idle machine", () => {
    const result = estimateAgentCapacity({
      cpuPercent: 0, memUsedBytes: 0, memTotalBytes: 1024 * GIB,
      openTerminals: 9, maxTiles: 12,
    });
    expect(result.recommendedMaxNewAgents).toBe(3);
    expect(result.limitedBy).toBe("tiles");
  });

  it("cpuPercent null skips the CPU constraint instead of guessing", () => {
    const result = estimateAgentCapacity({
      cpuPercent: null, memUsedBytes: 4 * GIB, memTotalBytes: 32 * GIB,
      openTerminals: 0, maxTiles: 12,
    });
    // RAM capacity 36, so the tile cap (12) binds.
    expect(result.recommendedMaxNewAgents).toBe(12);
    expect(result.limitedBy).toBe("tiles");
  });

  it("unknown memory (total 0) reports 0 without warning-worthy certainty", () => {
    const result = estimateAgentCapacity({
      cpuPercent: 3, memUsedBytes: 0, memTotalBytes: 0,
      openTerminals: 0, maxTiles: 12,
    });
    expect(result.memCapacity).toBe(0);
    expect(result.memPercent).toBe(0);
    expect(result.recommendedMaxNewAgents).toBe(0);
    expect(result.limitedBy).toBe("memory");
  });

  it("tolerates garbage input (negatives, fractional tile counts)", () => {
    const result = estimateAgentCapacity({
      cpuPercent: -4, memUsedBytes: -5, memTotalBytes: 8 * GIB,
      openTerminals: -2.7, maxTiles: 12,
    });
    expect(result.freeTiles).toBe(12);
    expect(result.recommendedMaxNewAgents).toBeGreaterThanOrEqual(0);
    expect(result.recommendedMaxNewAgents).toBeLessThanOrEqual(12);
  });

  it("partial load: one budget below the tile count wins", () => {
    // CPU 50 → free budget 25 → 3 panes; RAM idle; tiles 11 free.
    const result = estimateAgentCapacity({
      cpuPercent: 50, memUsedBytes: 2 * GIB, memTotalBytes: 32 * GIB,
      openTerminals: 1, maxTiles: 12,
    });
    expect(result.recommendedMaxNewAgents).toBe(3);
    expect(result.limitedBy).toBe("cpu");
  });
});
