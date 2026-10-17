import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AppEventBus } from "../../src/main/core/event-bus";
import { PtyManager } from "../../src/main/terminal/pty-manager";
import type { JevVerifier, JevVerdictResult } from "../../src/main/terminal/jev-verifier";
import { isAttentionState } from "../../src/shared/pty-state";
import type { PtyStateChanged } from "@shared/types";

/**
 * Deterministic fake-timer tests for the agent quiet-debounce + title-not-running
 * behavior. Drives the private _detectPtyState path by inserting a managed
 * terminal fixture (no real PTY) and feeding synthetic data chunks, exactly
 * like pty-manager-setstate.test.ts.
 */
describe("PtyManager agent lamp state machine", () => {
  let events: AppEventBus;
  let manager: PtyManager;

  beforeEach(() => {
    vi.useFakeTimers();
    events = new AppEventBus();
    manager = new PtyManager(events);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function create(
    agentProfile: string | null = "claude-official",
    m: PtyManager = manager,
  ): string {
    const id = randomUUID();
    const terminals = (m as unknown as { terminals: Map<string, unknown> }).terminals;
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
        isAgent: true,
        agentProfile,
        ownedByAgentApi: false,
        pid: 0,
        nativeSessionId: null,
        worktreeId: null,
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
    });
    return id;
  }

  function feed(id: string, data: string, m: PtyManager = manager): void {
    const terminals = (m as unknown as { terminals: Map<string, unknown> }).terminals;
    const t = terminals.get(id);
    (m as unknown as { _detectPtyState: (t: unknown, data: string) => void })._detectPtyState(t, data);
  }

  /**
   * Mock Jev second opinion (contract: Pick<JevVerifier, "isEnabled" |
   * "classifyQuietScreen">): enabled, and always confidently "waiting_input" —
   * the production false-positive shape on an idle home prompt.
   */
  function makeMockJevManager(): {
    bus: AppEventBus;
    mgr: PtyManager;
  } {
    const bus = new AppEventBus();
    const mockJev: Pick<JevVerifier, "isEnabled" | "classifyQuietScreen"> = {
      isEnabled: () => true,
      classifyQuietScreen: async (): Promise<JevVerdictResult | null> => ({
        verdict: "waiting_input",
        confidence: 0.95,
      }),
    };
    return { bus, mgr: new PtyManager(bus, 2, undefined, { jevVerifier: mockJev }) };
  }

  it("an OSC 0 title alone does NOT start running", () => {
    const id = create();
    const emitted: PtyStateChanged[] = [];
    events.on("ptyStateChanged", (c) => emitted.push(c));
    // A bare title sequence (the shell/agent re-emits this every prompt render).
    feed(id, "\x1b]0;Claude Code\x07");
    expect(manager.getPtyState(id)).toBe("starting");
    expect(emitted.filter((c) => c.state === "running")).toHaveLength(0);
  });

  it("ANSI cursor movement alone does NOT start running", () => {
    const id = create();
    feed(id, "\x1b[2K\x1b[1G");
    expect(manager.getPtyState(id)).toBe("starting");
  });

  it("agent data activity → running, then quiet debounce → done", () => {
    const id = create();
    const emitted: PtyStateChanged[] = [];
    events.on("ptyStateChanged", (c) => emitted.push(c));
    feed(id, "thinking...\n");
    expect(manager.getPtyState(id)).toBe("running");
    // Quiet for longer than the debounce → falls back to done.
    vi.advanceTimersByTime(2_501);
    expect(manager.getPtyState(id)).toBe("done");
  });

  it("continued output keeps the lamp running (debounce re-armed)", () => {
    const id = create();
    feed(id, "chunk-1\n");
    expect(manager.getPtyState(id)).toBe("running");
    // Within the debounce window, more output arrives → deadline pushed forward.
    vi.advanceTimersByTime(1_500);
    feed(id, "chunk-2\n");
    vi.advanceTimersByTime(2_000); // would have fired if not re-armed
    expect(manager.getPtyState(id)).toBe("running");
    // Now go truly quiet past the window.
    vi.advanceTimersByTime(1_000);
    expect(manager.getPtyState(id)).toBe("done");
  });

  it("attention state is NOT cleared by the quiet debounce", () => {
    const id = create();
    feed(id, "working\n");
    expect(manager.getPtyState(id)).toBe("running");
    // Enter attention via OSC (reliable source).
    manager.setPtyState(id, "approval_required", "osc");
    // Output continues (the agent may print context around the prompt).
    feed(id, "Do you want to allow this?\n");
    // Wait past the debounce — attention must survive.
    vi.advanceTimersByTime(5_000);
    expect(manager.getPtyState(id)).toBe("approval_required");
  });

  it("error state is NOT cleared by the quiet debounce", () => {
    const id = create();
    feed(id, "working\n");
    manager.setPtyState(id, "error", "osc");
    feed(id, "more output\n");
    vi.advanceTimersByTime(5_000);
    expect(manager.getPtyState(id)).toBe("error");
  });

  it("output activity retracts a screen/heuristic-filed error (issue #25)", () => {
    const id = create();
    feed(id, "working\n");
    manager.setPtyState(id, "error", "screen");
    expect(manager.getPtyState(id)).toBe("error");
    // The agent kept streaming — the screen verdict was a false positive.
    feed(id, "compilation succeeded\n");
    expect(manager.getPtyState(id)).toBe("running");
    expect(manager.getPtyStateSource(id)).toBe("heuristic");
  });

  it("output activity cannot retract a hard-sourced error", () => {
    const id = create();
    feed(id, "working\n");
    manager.setPtyState(id, "error", "provider");
    feed(id, "more output\n");
    vi.advanceTimersByTime(5_000);
    expect(manager.getPtyState(id)).toBe("error");
  });

  it.each(["heuristic", "screen", "osc", "broker", "provider", "process"] as const)(
    "human Enter clears approval/input from %s → running",
    (source) => {
      const id = create();
      manager.setPtyState(id, "approval_required", source);
      manager.write(id, "\r", "human");
      expect(manager.getPtyState(id)).toBe("running");
    },
  );

  it("Enter submission clears attention → running", () => {
    const id = create();
    feed(id, "working\n");
    manager.setPtyState(id, "approval_required", "osc");
    expect(manager.getPtyState(id)).toBe("approval_required");
    // User presses Enter (submits their approval decision).
    manager.write(id, "\r");
    expect(manager.getPtyState(id)).toBe("running");
  });

  it.each(["screen", "heuristic"] as const)("human Enter clears %s choice-blocked", (source) => {
    const id = create();
    manager.setPtyState(id, "blocked", source);
    manager.write(id, "\r", "human");
    expect(manager.getPtyState(id)).toBe("running");
  });

  it.each(["broker", "provider", "process"] as const)("human Enter preserves %s hard blocked", (source) => {
    const id = create();
    manager.setPtyState(id, "blocked", source);
    manager.write(id, "\r", "human");
    expect(manager.getPtyState(id)).toBe("blocked");
  });

  it("typing, paste without Enter, and soft newline do not acknowledge", () => {
    const id = create();
    manager.setPtyState(id, "waiting_input", "screen");
    manager.write(id, "typed", "human");
    manager.write(id, "pasted text", "human");
    manager.write(id, "\x1b[200~line one\r\nline two\x1b[201~", "human");
    manager.write(id, "\n", "human");
    expect(manager.getPtyState(id)).toBe("waiting_input");
  });

  it('single-shot draft + Enter ("yes\\r") from human acknowledges', () => {
    const id = create();
    manager.setPtyState(id, "approval_required", "osc");
    manager.write(id, "yes\r", "human");
    expect(manager.getPtyState(id)).toBe("running");
  });

  it('single-shot draft + Enter ("yes\\r") from automation acknowledges', () => {
    const id = create();
    manager.setPtyState(id, "approval_required", "osc");
    manager.write(id, "yes\r", "automation");
    expect(manager.getPtyState(id)).toBe("running");
  });

  it("multiline paste ending in CR does NOT acknowledge", () => {
    const id = create();
    manager.setPtyState(id, "approval_required", "osc");
    manager.write(id, "line1\r\nline2\r", "human");
    expect(manager.getPtyState(id)).toBe("approval_required");
  });

  it("Enter does NOT clear an error state", () => {
    const id = create();
    manager.setPtyState(id, "error", "osc");
    manager.write(id, "\r");
    expect(manager.getPtyState(id)).toBe("error");
  });

  it.each(["screen", "heuristic"] as const)("human Enter clears %s-filed error (issue #25)", (source) => {
    const id = create();
    manager.setPtyState(id, "error", source);
    manager.write(id, "yes\r", "human");
    expect(manager.getPtyState(id)).toBe("running");
  });

  it.each(["provider", "process"] as const)("human Enter preserves %s-filed error", (source) => {
    const id = create();
    manager.setPtyState(id, "error", source);
    manager.write(id, "yes\r", "human");
    expect(manager.getPtyState(id)).toBe("error");
  });

  it("Enter does NOT clear a blocked state", () => {
    const id = create();
    manager.setPtyState(id, "blocked", "osc");
    manager.write(id, "\r");
    expect(manager.getPtyState(id)).toBe("blocked");
  });

  it("unknown Agent profile keeps the ANSI-wrapped fallback path (after a submitted turn)", () => {
    const id = create("unknown-agent");
    // Dirty-input gate (2026-09-27): submit a HUMAN turn first — a non-empty
    // single-shot draft arms awaitingReply; the prompt-kind fallback then fires.
    manager.write(id, "2\r", "human");
    feed(id, "\x1b[33mEnter to select an option\x1b[0m\n");
    expect(manager.getPtyState(id)).toBe("waiting_input");
  });

  // --- Dirty-input gate (2026-09-27 fresh-idle false attention) -----------

  it("fresh idle session + confident Jev waiting_input does NOT raise attention", async () => {
    const { bus, mgr } = makeMockJevManager();
    const emitted: PtyStateChanged[] = [];
    bus.on("ptyStateChanged", (c) => emitted.push(c));
    const id = create(undefined, mgr);
    // Startup banner counts as agent activity → running + quiet timer armed.
    feed(id, "Kimi for Coding · skills loaded\n", mgr);
    expect(mgr.getPtyState(id)).toBe("running");
    // Past the debounce Jev sees the idle home prompt and (in production)
    // returns a confident "waiting_input". With no user-submitted turn pending,
    // the gate ends the turn dark instead. Async: flush the consult microtasks.
    await vi.advanceTimersByTimeAsync(2_501);
    expect(mgr.getPtyState(id)).toBe("done");
    expect(emitted.filter((c) => c.state === "waiting_input" || c.state === "approval_required")).toHaveLength(0);
  });

  it("user submits prompt → agent output → quiet → Jev files attention", async () => {
    const { bus, mgr } = makeMockJevManager();
    const emitted: PtyStateChanged[] = [];
    bus.on("ptyStateChanged", (c) => emitted.push(c));
    const id = create(undefined, mgr);
    // Human single-shot Enter with a non-empty draft submits a turn.
    mgr.write(id, "explain the build error\r", "human");
    // Agent streams a reply → running, quiet timer re-armed.
    feed(id, "Let me check the log files...\n", mgr);
    expect(mgr.getPtyState(id)).toBe("running");
    // Reply goes quiet; Jev confidently reads a question to the user.
    await vi.advanceTimersByTimeAsync(2_501);
    expect(mgr.getPtyState(id)).toBe("waiting_input");
    expect(emitted.at(-1)?.state).toBe("waiting_input");
    expect(emitted.at(-1)?.source).toBe("jev");
  });

  it("bare-Enter acknowledgement consumes the turn: quiet + Jev does not re-fire", async () => {
    const { bus, mgr } = makeMockJevManager();
    const emitted: PtyStateChanged[] = [];
    bus.on("ptyStateChanged", (c) => emitted.push(c));
    const id = create(undefined, mgr);
    mgr.write(id, "fix the test\r", "human");
    feed(id, "working on it...\n", mgr);
    await vi.advanceTimersByTimeAsync(2_501);
    expect(mgr.getPtyState(id)).toBe("waiting_input");
    // User answers with a bare Enter → attention cleared, turn consumed.
    mgr.write(id, "\r", "human");
    expect(mgr.getPtyState(id)).toBe("running");
    // The agent keeps streaming; another quiet streak must end dark.
    feed(id, "done, summary printed\n", mgr);
    await vi.advanceTimersByTimeAsync(2_501);
    expect(mgr.getPtyState(id)).toBe("done");
    expect(emitted.filter((c) => c.state === "waiting_input")).toHaveLength(1);
  });

  it("automation (Agent API) Enters never arm the dirty-input gate", () => {
    const { mgr } = makeMockJevManager();
    const id = create(undefined, mgr);
    mgr.write(id, "fix the test\r", "automation");
    feed(id, "Enter to select an option\n", mgr);
    // The unknown-profile per-chunk heuristic may light running; the gate only
    // forbids attention filing from an unarmed (automation-only) window.
    expect(isAttentionState(mgr.getPtyState(id))).toBe(false);
  });

  it("kill clears the quiet timer (no late done transition)", () => {
    const id = create();
    feed(id, "working\n");
    expect(manager.getPtyState(id)).toBe("running");
    manager.kill(id);
    // Advance past the debounce — the terminal is gone, so no state change.
    const emitted: PtyStateChanged[] = [];
    events.on("ptyStateChanged", (c) => emitted.push(c));
    vi.advanceTimersByTime(5_000);
    expect(emitted).toHaveLength(0);
  });

  it("non-agent shell: PS prompt → done (prompt lifecycle still works)", () => {
    const id = randomUUID();
    const terminals = (manager as unknown as { terminals: Map<string, unknown> }).terminals;
    terminals.set(id, {
      info: {
        id,
        projectId: "00000000-0000-4000-8000-000000000000",
        profile: "pwsh",
        title: "pwsh",
        cwd: "D:\\fixture",
        cols: 100, rows: 28, status: "running",
        startedAt: new Date().toISOString(), closedAt: null, lastExitCode: null,
        isAgent: false, agentProfile: null, ownedByAgentApi: false, pid: 0,
        nativeSessionId: null, worktreeId: null,
      },
      process: { kill: () => undefined, write: () => undefined }, resizeTimer: null, scrollback: "",
      dataDisposer: null, exitDisposer: null, ptyState: "starting", titleBuffer: "",
      ptyStateSource: "process",
      oscCarry: "", shellCwd: "D:\\fixture", lifecycle: null, lastCommand: null,
      quietTimer: null,
    });
    feed(id, "PS D:\\fixture>");
    expect(manager.getPtyState(id)).toBe("done");
  });
});
