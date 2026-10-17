import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { AppEventBus } from "../../src/main/core/event-bus";
import { matchAgentFallbackAttention, PtyManager } from "../../src/main/terminal/pty-manager";
import type { PtyStateChanged } from "@shared/types";

// setPtyState is platform-independent. Insert the smallest managed-terminal
// fixture directly so a unit test never races node-pty's asynchronous ConPTY
// connection/teardown; real shell behavior is covered by integration tests.
describe("PtyManager.setPtyState chokepoint", () => {
  let manager: PtyManager;
  let events: AppEventBus;

  beforeEach(() => {
    events = new AppEventBus();
    manager = new PtyManager(events);
  });

  function create(): string {
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
        status: "exited",
        startedAt: new Date().toISOString(),
        closedAt: new Date().toISOString(),
        lastExitCode: 0,
        isAgent: true,
        agentProfile: "claude-local-main",
        ownedByAgentApi: false,
        pid: 0,
        nativeSessionId: null,
        worktreeId: null,
      },
      process: { kill: () => undefined },
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
    });
    return id;
  }

  it("is idempotent: same state does not re-emit", () => {
    const id = create();
    const emitted: PtyStateChanged[] = [];
    events.on("ptyStateChanged", (c) => emitted.push(c));
    manager.setPtyState(id, "running", "heuristic");
    manager.setPtyState(id, "running", "heuristic");
    expect(emitted).toHaveLength(1);
    expect(emitted[0]!.state).toBe("running");
  });

  it("heuristic may NOT overwrite an attention state", () => {
    const id = create();
    const emitted: PtyStateChanged[] = [];
    events.on("ptyStateChanged", (c) => emitted.push(c));
    // Enter attention via OSC (reliable source).
    manager.setPtyState(id, "approval_required", "osc");
    // Heuristic tries to clobber it back to running — must be refused.
    manager.setPtyState(id, "running", "heuristic");
    expect(manager.getPtyState(id)).toBe("approval_required");
    expect(emitted.filter((c) => c.state === "running")).toHaveLength(0);
  });

  it("agent-only fallback may enter attention through the heuristic source", () => {
    const id = create();
    manager.setPtyState(id, "running", "heuristic");
    manager.setPtyState(id, "waiting_input", "heuristic");
    expect(manager.getPtyState(id)).toBe("waiting_input");
  });

  it("broker/provider may clear an attention state", () => {
    const id = create();
    manager.setPtyState(id, "blocked", "osc");
    expect(manager.getPtyState(id)).toBe("blocked");
    manager.setPtyState(id, "running", "broker");
    expect(manager.getPtyState(id)).toBe("running");
  });

  it("same-state richer signal upgrades the owning source without duplicating state", () => {
    const id = create();
    const emitted: PtyStateChanged[] = [];
    events.on("ptyStateChanged", (c) => emitted.push(c));
    manager.setPtyState(id, "blocked", "screen");
    manager.setPtyState(id, "blocked", "provider");
    expect(manager.getPtyState(id)).toBe("blocked");
    expect(manager.getPtyStateSource(id)).toBe("provider");
    expect(emitted.map((change) => change.source)).toEqual(["screen", "provider"]);
  });

  it("emits previousState + source metadata only (no prompt/command)", () => {
    const id = create();
    const emitted: PtyStateChanged[] = [];
    events.on("ptyStateChanged", (c) => emitted.push(c));
    manager.setPtyState(id, "waiting_input", "provider");
    expect(emitted).toHaveLength(1);
    const first = emitted[0]!;
    const keys = Object.keys(first).sort();
    expect(keys).toEqual(["previousState", "projectId", "source", "state", "terminalId"]);
    expect(first.source).toBe("provider");
  });

  it("setPtyState on an unknown terminal is a no-op (no throw)", () => {
    expect(() => manager.setPtyState("nonexistent", "running", "heuristic")).not.toThrow();
  });
});

describe("agent attention fallback classifier", () => {
  it("recognizes explicit terminal prompts", () => {
    expect(matchAgentFallbackAttention("Do you want to allow this?\n")).toBe("approval");
    expect(matchAgentFallbackAttention("Blocked: waiting for lock\n")).toBe("blocked");
  });

  it("never classifies screen text as error (issue #25 — exit code owns error)", () => {
    expect(matchAgentFallbackAttention("Error: provider disconnected\n")).toBeNull();
    expect(matchAgentFallbackAttention("Fatal: out of memory\n")).toBeNull();
  });

  it("does not match ordinary prose or source-code strings", () => {
    expect(matchAgentFallbackAttention("I will allow the caller to handle errors.\n")).toBeNull();
    expect(matchAgentFallbackAttention('const text = "Error: provider disconnected";\n')).toBeNull();
    expect(matchAgentFallbackAttention("function handleError() { return true; }\n")).toBeNull();
  });
});
