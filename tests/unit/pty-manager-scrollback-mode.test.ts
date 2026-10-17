// PtyManager scrollbackMode accessors + byte-replay regression freezes
// (issue #13 / AT-138).
//
// Fixture-managed terminals are inserted directly (same pattern as
// pty-manager-setstate.test.ts) so the tests stay unit-fast and never race
// node-pty's ConPTY lifecycle.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AppEventBus } from "../../src/main/core/event-bus";
import { PtyManager, SCROLLBACK_MAX_CHARS } from "../../src/main/terminal/pty-manager";
import { DecModeTracker } from "../../src/main/terminal/dec-modes";
import type { TerminalInfo } from "@shared/types";

const PROJECT_ID = "00000000-0000-4000-8000-000000000000";

function fixtureInfo(id: string): TerminalInfo {
  return {
    id,
    projectId: PROJECT_ID,
    profile: "pwsh",
    title: "agent",
    cwd: "D:\\fixture",
    cols: 100,
    rows: 28,
    status: "running",
    startedAt: "2026-08-02T00:00:00.000Z",
    closedAt: null,
    lastExitCode: null,
    isAgent: true,
    agentProfile: "claude-local-main",
    ownedByAgentApi: false,
    pid: 0,
    nativeSessionId: null,
    worktreeId: null,
    contextUsage: null,
  };
}

function insertTerminal(manager: PtyManager, id: string, parts: { scrollback: string[]; decModes: DecModeTracker }): void {
  const terminals = (manager as unknown as { terminals: Map<string, unknown> }).terminals;
  terminals.set(id, {
    info: fixtureInfo(id),
    process: { kill: () => undefined },
    resizeTimer: null,
    scrollback: parts.scrollback,
    scrollbackLength: parts.scrollback.reduce((n, chunk) => n + chunk.length, 0),
    decModes: parts.decModes,
    outputRevision: 0,
    dataDisposer: null,
    exitDisposer: null,
    ptyState: "running",
    ptyStateSource: "process",
    titleBuffer: "",
    oscCarry: "",
    shellCwd: "D:\\fixture",
    lifecycle: null,
    lastCommand: null,
    quietTimer: null,
    contextUsage: null,
  });
}

describe("PtyManager getScrollbackMode + snapshots preamble freeze", () => {
  let manager: PtyManager;

  beforeEach(() => {
    manager = new PtyManager(new AppEventBus());
  });

  it("mode bytes evicted from a full 2M ring are still reconstructed by the preamble", () => {
    const decModes = new DecModeTracker();
    // Early in the session the TUI enables alt screen + SGR mouse...
    decModes.ingest("\x1b[?1049h\x1b[?1006h");
    // ...then a session's worth of repaint traffic truncates the ring from the
    // front, so the raw chunks no longer contain either mode sequence.
    const ringContent = "█".repeat(SCROLLBACK_MAX_CHARS);
    expect(ringContent).not.toContain("\x1b[?1049h");
    insertTerminal(manager, "t1", { scrollback: [ringContent], decModes });

    const snapshot = manager.snapshots(PROJECT_ID)[0]!;
    // Hydrate path stays byte-replayable: preamble first, ring content after.
    expect(snapshot.scrollback.startsWith("\x1b[?1006h\x1b[?1049h")).toBe(true);
    expect(snapshot.scrollback.endsWith(ringContent)).toBe(true);
    expect(manager.getScrollbackMode("t1")).toBe("alternate-screen");
  });

  it("plain shell (no modes tracked) snapshots byte-identically and reports normal", () => {
    insertTerminal(manager, "t1", {
      scrollback: ["first chunk\r\n", "second chunk"],
      decModes: new DecModeTracker(),
    });
    const snapshot = manager.snapshots(PROJECT_ID)[0]!;
    expect(snapshot.scrollback).toBe("first chunk\r\nsecond chunk");
    expect(manager.getScrollbackMode("t1")).toBe("normal");
    // Untracked by the detection engine → no screen cache.
    expect(manager.getScreenSnapshot("t1")).toBeNull();
  });

  it("exiting the alternate screen flips the mode back to normal", () => {
    const decModes = new DecModeTracker();
    decModes.ingest("\x1b[?1049h");
    insertTerminal(manager, "t1", { scrollback: ["x"], decModes });
    expect(manager.getScrollbackMode("t1")).toBe("alternate-screen");
    decModes.ingest("\x1b[?1049l");
    expect(manager.getScrollbackMode("t1")).toBe("normal");
  });

  it("unknown terminals report null mode", () => {
    expect(manager.getScrollbackMode("does-not-exist")).toBeNull();
  });
});

describe("PtyManager getScreenSnapshot wiring", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("reads the detection engine cache (bounded), never the VT buffer directly", async () => {
    const manager = new PtyManager(new AppEventBus());
    await manager.startAgentDetection();
    const engine = (manager as unknown as {
      agentDetection: {
        trackTerminal(input: { terminalId: string; agentProfile: string; cols: number; rows: number }): void;
        ingest(terminalId: string, data: string): void;
      };
    }).agentDetection;
    engine.trackTerminal({ terminalId: "t1", agentProfile: "claude-local-main", cols: 80, rows: 24 });
    engine.ingest("t1", "\x1b[?1049h");
    engine.ingest("t1", "\x1b[2J\x1b[HSCREEN CACHE MARKER");
    // xterm write pump (0ms) + engine coalesce window (50ms).
    await vi.advanceTimersByTimeAsync(60);
    expect(manager.getScreenSnapshot("t1")).toContain("SCREEN CACHE MARKER");
    manager.dispose();
  });
});
