import { describe, expect, it } from "vitest";
import { calculateRemoteRows } from "../../src/renderer/src/components/terminal-remote-rows";

describe("remote terminal row sizing", () => {
  it("keeps remote rows equal to the PTY for full-screen TUIs", () => {
    expect(calculateRemoteRows({
      fallbackRows: 29,
    })).toBe(29);
  });

  it("normalizes a malformed PTY row count to one", () => {
    expect(calculateRemoteRows({
      fallbackRows: 0,
    })).toBe(1);
  });
});
