import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AppEventBus } from "../../src/main/core/event-bus";
import { PtyManager } from "../../src/main/terminal/pty-manager";
import type { PtyState } from "@shared/schema";

/**
 * #50: writeWhenShellReady holds a launch command while the shell is still
 * "starting" (booting pwsh can swallow the trailing Enter), flushes once the
 * first prompt flips the canonical state, preserves queue order, and never
 * drops the write on timeout.
 */
describe("PtyManager.writeWhenShellReady", () => {
  let manager: PtyManager;

  beforeEach(() => {
    vi.useFakeTimers();
    manager = new PtyManager(new AppEventBus());
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function fixture(state: PtyState): { id: string; writes: string[]; setState: (s: PtyState) => void } {
    const id = randomUUID();
    const writes: string[] = [];
    const managed = {
      info: {
        id,
        projectId: "00000000-0000-4000-8000-000000000000",
        profile: "pwsh",
        title: "pwsh",
        cwd: "D:\\fixture",
        cols: 100,
        rows: 28,
        status: "running",
        startedAt: new Date().toISOString(),
        closedAt: null,
        lastExitCode: null,
        isAgent: false,
        agentProfile: null,
        ownedByAgentApi: false,
        pid: 0,
        nativeSessionId: null,
        worktreeId: null,
        contextUsage: null,
      },
      process: { write: (data: string) => writes.push(data), kill: () => undefined },
      ptyState: state,
      ptyStateSource: "process",
    };
    (manager as unknown as { terminals: Map<string, unknown> }).terminals.set(id, managed);
    return { id, writes, setState: (s) => { managed.ptyState = s; } };
  }

  it("holds the write while starting and flushes on first prompt", () => {
    const { id, writes, setState } = fixture("starting");
    manager.writeWhenShellReady(id, "codex ...\r", "automation");
    vi.advanceTimersByTime(500);
    expect(writes).toEqual([]);
    setState("done"); // OSC 633;A prompt
    vi.advanceTimersByTime(100);
    expect(writes).toEqual(["codex ...\r"]);
  });

  it("writes immediately once the shell already showed a prompt", () => {
    const { id, writes } = fixture("done");
    manager.writeWhenShellReady(id, "claude\r", "automation");
    vi.advanceTimersByTime(100);
    expect(writes).toEqual(["claude\r"]);
  });

  it("still accepts input for attention states (answers are inputs)", () => {
    const { id, writes } = fixture("waiting_input");
    manager.writeWhenShellReady(id, "y\r", "automation");
    vi.advanceTimersByTime(100);
    expect(writes).toEqual(["y\r"]);
  });

  it("preserves queue order for back-to-back gated writes", () => {
    const { id, writes, setState } = fixture("starting");
    manager.writeWhenShellReady(id, "first\r", "automation");
    manager.writeWhenShellReady(id, "second\r", "automation");
    setState("done");
    vi.advanceTimersByTime(100);
    expect(writes).toEqual(["first\r", "second\r"]);
  });

  it("flushes on timeout rather than dropping the launch command", () => {
    const { id, writes } = fixture("starting");
    manager.writeWhenShellReady(id, "codex ...\r", "automation", 1_000);
    vi.advanceTimersByTime(1_100);
    expect(writes).toEqual(["codex ...\r"]);
  });
});
