import { describe, expect, it } from "vitest";
import { canApplySearchGeneration } from "../../src/renderer/src/components/search-generation";

describe("canApplySearchGeneration", () => {
  it("rejects an older rapid-input result after the query generation advances", () => {
    expect(canApplySearchGeneration(1, 2, false)).toBe(false);
    expect(canApplySearchGeneration(2, 2, false)).toBe(true);
  });

  it("rejects results after effect cancellation", () => {
    expect(canApplySearchGeneration(3, 3, true)).toBe(false);
  });
});
