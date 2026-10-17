import { describe, expect, it } from "vitest";
import { tileHydrationKey } from "../../src/renderer/src/components/terminal-dock-hydration-key";

describe("tileHydrationKey", () => {
  it("returns equal keys for equal content with different array identity", () => {
    const a = [
      { terminalId: "t1", projectId: "p1" },
      { terminalId: "t2", projectId: "p1" },
      { terminalId: "t3", projectId: "p2" },
    ];
    // JSON.parse produces a brand-new array + objects with identical content,
    // exactly like the WebSocket dockLayout broadcast path.
    const b = JSON.parse(JSON.stringify(a)) as typeof a;

    expect(b).not.toBe(a);
    expect(b[0]).not.toBe(a[0]);
    expect(tileHydrationKey(b)).toBe(tileHydrationKey(a));
  });

  it("changes when a terminal is added", () => {
    const before = [
      { terminalId: "t1", projectId: "p1" },
      { terminalId: "t2", projectId: "p1" },
    ];
    const after = [
      { terminalId: "t1", projectId: "p1" },
      { terminalId: "t2", projectId: "p1" },
      { terminalId: "t3", projectId: "p2" },
    ];
    expect(tileHydrationKey(after)).not.toBe(tileHydrationKey(before));
  });

  it("changes when a terminal is removed", () => {
    const before = [
      { terminalId: "t1", projectId: "p1" },
      { terminalId: "t2", projectId: "p1" },
    ];
    const after = [{ terminalId: "t1", projectId: "p1" }];
    expect(tileHydrationKey(after)).not.toBe(tileHydrationKey(before));
  });

  it("changes when a tile's projectId differs", () => {
    const before = [{ terminalId: "t1", projectId: "p1" }];
    const after = [{ terminalId: "t1", projectId: "p2" }];
    expect(tileHydrationKey(after)).not.toBe(tileHydrationKey(before));
  });

  it("is stable across repeated calls on the same array", () => {
    const tiles = [{ terminalId: "t1", projectId: "p1" }];
    expect(tileHydrationKey(tiles)).toBe(tileHydrationKey(tiles));
  });
});
