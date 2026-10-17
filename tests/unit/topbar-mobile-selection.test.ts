import { describe, expect, it } from "vitest";
import { shouldSendMobileTileSelection } from "../../src/renderer/src/components/topbar-logic";

describe("mobile PTY slot selection", () => {
  it("sends only a real selection change and suppresses duplicate taps while pending", () => {
    expect(shouldSendMobileTileSelection("term-2", "term-1", null)).toBe(true);
    expect(shouldSendMobileTileSelection("term-1", "term-1", null)).toBe(false);
    expect(shouldSendMobileTileSelection("term-2", "term-1", "term-2")).toBe(false);
  });
});
