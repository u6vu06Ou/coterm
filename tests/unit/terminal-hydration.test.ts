import { describe, expect, it } from "vitest";
import { TerminalHydrationCoordinator } from "../../src/renderer/src/components/terminal-hydration";

describe("TerminalHydrationCoordinator", () => {
  it("applies a delayed empty-to-non-empty snapshot exactly once", () => {
    const hydration = new TerminalHydrationCoordinator();

    expect(hydration.acceptSnapshot({ ready: false, revision: 0, data: "" })).toEqual({ kind: "none" });
    expect(hydration.acceptSnapshot({ ready: true, revision: 4, data: "history" })).toEqual({
      kind: "replace",
      snapshot: "history",
      trailing: "",
      revision: 4,
    });
    expect(hydration.acceptSnapshot({ ready: true, revision: 4, data: "history" })).toEqual({ kind: "none" });
  });

  it("distinguishes a ready empty snapshot from a snapshot that has not arrived", () => {
    const hydration = new TerminalHydrationCoordinator();
    expect(hydration.acceptSnapshot({ ready: true, revision: 0, data: "" })).toEqual({
      kind: "replace",
      snapshot: "",
      trailing: "",
      revision: 0,
    });
  });

  it("keeps only live chunks newer than the authoritative snapshot", () => {
    const hydration = new TerminalHydrationCoordinator();
    expect(hydration.acceptLive({ revision: 2, data: "already-in-snapshot" })).toEqual({ kind: "buffer" });
    expect(hydration.acceptLive({ revision: 3, data: "after-snapshot" })).toEqual({ kind: "buffer" });

    expect(hydration.acceptSnapshot({ ready: true, revision: 2, data: "history" })).toEqual({
      kind: "replace",
      snapshot: "history",
      trailing: "after-snapshot",
      revision: 3,
    });
    expect(hydration.acceptLive({ revision: 4, data: "live" })).toEqual({
      kind: "append",
      data: "live",
      revision: 4,
    });
  });

  it("ignores replayed live chunks and stale reconnect snapshots", () => {
    const hydration = new TerminalHydrationCoordinator();
    hydration.acceptSnapshot({ ready: true, revision: 8, data: "history" });
    expect(hydration.acceptLive({ revision: 8, data: "duplicate" })).toEqual({ kind: "none" });
    expect(hydration.acceptSnapshot({ ready: true, revision: 7, data: "stale" })).toEqual({ kind: "none" });
  });

  it("rejects malformed live revisions and permits an explicit redraw", () => {
    const hydration = new TerminalHydrationCoordinator();
    expect(hydration.acceptLive({ revision: -1, data: "bad" })).toEqual({ kind: "none" });
    expect(hydration.acceptLive({ revision: 1.5, data: "bad" })).toEqual({ kind: "none" });
    expect(hydration.acceptLive({ revision: 1, data: "" })).toEqual({ kind: "none" });
    hydration.acceptSnapshot({ ready: true, revision: 2, data: "history" });
    expect(hydration.acceptSnapshot({
      ready: true,
      revision: 2,
      data: "redraw",
      force: true,
    })).toEqual({ kind: "replace", snapshot: "redraw", trailing: "", revision: 2 });
  });
});
