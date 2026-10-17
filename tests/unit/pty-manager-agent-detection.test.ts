import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AppEventBus } from "../../src/main/core/event-bus";
import { PtyManager } from "../../src/main/terminal/pty-manager";
import type { PtyStateChanged } from "@shared/types";

describe("PtyManager main-owned Agent detector integration", () => {
  let events: AppEventBus;
  let manager: PtyManager;

  beforeEach(async () => {
    vi.useFakeTimers();
    events = new AppEventBus();
    manager = new PtyManager(events);
    await manager.startAgentDetection();
  });

  afterEach(() => {
    manager.dispose();
    vi.useRealTimers();
  });

  function createFixture(): string {
    const id = randomUUID();
    const terminals = (manager as unknown as { terminals: Map<string, unknown> }).terminals;
    terminals.set(id, {
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
      process: { kill: () => undefined, write: () => undefined },
      resizeTimer: null,
      scrollback: "",
      dataDisposer: null,
      exitDisposer: null,
      ptyState: "starting",
      ptyStateSource: "process",
      titleBuffer: "",
      oscCarry: "",
      shellCwd: "D:\\fixture",
      lifecycle: null,
      lastCommand: null,
      quietTimer: null,
      contextUsage: null,
    });
    manager.markAgent(id, "claude-local-main");
    return id;
  }

  function ingest(terminalId: string, data: string): void {
    const detection = (manager as unknown as {
      agentDetection: { ingest(id: string, chunk: string): void };
    }).agentDetection;
    detection.ingest(terminalId, data);
  }

  it("routes screen candidates through the chokepoint and retriggers after human acknowledgement", async () => {
    const id = createFixture();
    const changes: PtyStateChanged[] = [];
    events.on("ptyStateChanged", (event) => changes.push(event));
    const panel = "────────\nDo you want to run this?\nYes  No\nesc to cancel";

    ingest(id, panel);
    await vi.advanceTimersByTimeAsync(60);
    expect(manager.getPtyState(id)).toBe("approval_required");
    expect(manager.getPtyStateSource(id)).toBe("screen");
    expect(manager.getAgentStateExplanation(id)).toMatchObject({
      canonicalState: "approval_required",
      authoritativeSource: "screen",
      agentProfile: "claude-local-main",
      matchedRuleId: "claude_approval_panel",
      fallbackReason: null,
    });

    manager.write(id, "\r", "human");
    expect(manager.getPtyState(id)).toBe("running");
    expect(manager.getAgentStateExplanation(id)).toMatchObject({
      canonicalState: "running",
      authoritativeSource: "process",
      matchedRuleId: null,
      fallbackReason: "process:running",
    });

    // Clear the live viewport so the engine observes a no-match between two
    // identical prompts; the next prompt must be treated as new attention.
    ingest(id, "\x1b[2J\x1b[Hordinary output");
    await vi.advanceTimersByTimeAsync(60);
    ingest(id, `\x1b[2J\x1b[H${panel}`);
    await vi.advanceTimersByTimeAsync(60);

    expect(manager.getPtyState(id)).toBe("approval_required");
    expect(changes.filter((event) => (
      event.state === "approval_required" && event.source === "screen"
    ))).toHaveLength(2);
  });

  it("returns null instead of fabricating an explanation for a missing terminal", () => {
    expect(manager.getAgentStateExplanation(randomUUID())).toBeNull();
  });
});
