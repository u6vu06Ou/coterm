// Background-agents lamp tests — synthetic fixtures authored from Coterm's own
// ConPTY observations (the green-lamp bug: a pane waiting on N background
// agents shows an idle-looking prompt, so the quiet heuristic filed "done").
// No third-party fixtures are copied.

import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AppEventBus } from "../../src/main/core/event-bus";
import { PtyManager } from "../../src/main/terminal/pty-manager";
import {
  evaluate,
  hasBackgroundWorkSignal,
  type BufferSnapshot,
} from "../../src/main/terminal/agent-detection";
import { bundledClaudeCodeManifest } from "../../src/main/terminal/agent-detection/manifests/claude-code";
import { bundledCodexManifest } from "../../src/main/terminal/agent-detection/manifests/codex";
import type { JevVerifier, JevVerdictResult } from "../../src/main/terminal/jev-verifier";

// The parked-on-background-agents screen (main agent idle-prompted while 8
// subagents run). Authored synthetically from the reported bug frame.
const WAITING_SCREEN = [
  "✻ Waiting for 8 background agents to finish",
  "❯ ▌",
  "  Opus 5.5 (1M context) | .../work/my-project | 215k/1000k (22%) | proxy",
  "  ⏵⏵ bypass permissions on · 14 shells, 1 monitor",
  "",
  "● main",
  "○ alpha-mate   正在檢查 scan1 進度          14m 15s · ↓ 172.5k tokens",
  "○ beta-mate  Verifying break-even ...     13m 55s · ↓ 79.9k tokens",
  "○ alpha-mate   ...                          14m 1s · ↓ 106.1k tokens",
  "↓ 4 more",
].join("\n");

const WAITING_SCREEN_HIDDEN_MESSAGES =
  "✻ Waiting for 9 background agents to finish · 6 messages hidden\n❯ ▌\n  ⏵⏵ bypass permissions on · 3 shells";

// Minimal screen: only teammate rows remain near the bottom.
const TEAM_ROWS_ONLY = [
  "● main",
  "○ alpha-mate   Checking progress              14m 15s · ↓ 172.5k tokens",
  "○ beta-mate  Verifying break-even           13m 55s · ↓ 79.9k tokens",
  "↓ 4 more",
].join("\n");

// Minimal screen: only the shells/monitors status line remains.
const SHELLS_STATUS_ONLY = "❯ ▌\n  ⏵⏵ bypass permissions on · 2 shells, 1 monitor";

describe("hasBackgroundWorkSignal — pure predicate on bounded screen text", () => {
  it("matches the parked waiting screen", () => {
    expect(hasBackgroundWorkSignal(WAITING_SCREEN)).toBe(true);
  });

  it("matches the '· N messages hidden' variant", () => {
    expect(hasBackgroundWorkSignal(WAITING_SCREEN_HIDDEN_MESSAGES)).toBe(true);
  });

  it("matches teammate rows with live elapsed/token counters", () => {
    expect(hasBackgroundWorkSignal(TEAM_ROWS_ONLY)).toBe(true);
  });

  it("does not treat long-lived background shells/monitors as busy", () => {
    expect(hasBackgroundWorkSignal(SHELLS_STATUS_ONLY)).toBe(false);
  });

  it("does not match a plain idle prompt with no background counts", () => {
    const idle = "❯ ▌\n  ⏵⏵ bypass permissions on\n  Opus 5.5 (1M context) | 22% | proxy";
    expect(hasBackgroundWorkSignal(idle)).toBe(false);
  });

  it("does not match ordinary streaming output", () => {
    expect(hasBackgroundWorkSignal("Let me check the log files...\nworking")).toBe(false);
  });

  it("does not match agent prose mentioning background agents", () => {
    // No "to finish" tail, no counters: prose must stay dark.
    const prose = "I am now waiting for 2 background agents before I summarize.";
    expect(hasBackgroundWorkSignal(prose)).toBe(false);
  });

  it("null / empty input is false", () => {
    expect(hasBackgroundWorkSignal(null)).toBe(false);
    expect(hasBackgroundWorkSignal("")).toBe(false);
  });
});

describe("screen rules — background work beats the idle prompt", () => {
  const snap = (text: string): BufferSnapshot => ({ lines: text.split("\n"), title: "" });

  it("claude-code: waiting screen → running (not done)", () => {
    const result = evaluate(snap(WAITING_SCREEN), bundledClaudeCodeManifest);
    expect(result?.state).toBe("running");
    expect(result?.ruleId).toMatch(/^claude_bg_/);
  });

  it("claude-code: '> ' prompt + teammate rows in view → running wins over done", () => {
    // The prompt is drawn on every frame; counters must veto it.
    const screen = `${TEAM_ROWS_ONLY}\n> `;
    const result = evaluate(snap(screen), bundledClaudeCodeManifest);
    expect(result?.ruleId).toBe("claude_bg_team_rows");
    expect(result?.state).toBe("running");
  });

  it("claude-code: plain '> ' prompt still → done (regression)", () => {
    const result = evaluate(snap("> "), bundledClaudeCodeManifest);
    expect(result?.ruleId).toBe("claude_done_prompt");
    expect(result?.state).toBe("done");
  });

  it("codex: waiting line → running", () => {
    const result = evaluate(snap("Waiting for 3 teammates to finish\ncodex> "), bundledCodexManifest);
    expect(result?.state).toBe("running");
    expect(result?.ruleId).toBe("codex_bg_agents_waiting");
  });

  it("codex: token-counter status rows veto the codex> prompt", () => {
    const screen = "(14m 15s · ↓ 172.5k tokens)\ncodex> ";
    const result = evaluate(snap(screen), bundledCodexManifest);
    expect(result?.state).toBe("running");
    expect(result?.ruleId).toBe("codex_bg_token_counters");
  });

  it("codex: plain 'codex> ' prompt still → done (regression)", () => {
    const result = evaluate(snap("codex> "), bundledCodexManifest);
    expect(result?.ruleId).toBe("codex_done_prompt");
    expect(result?.state).toBe("done");
  });
});

describe("pty-manager quiet debounce — background signal overrides quiet→done", () => {
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

  function createFixture(m: PtyManager = manager, agentProfile = "claude-local-main"): string {
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
    m.markAgent(id, agentProfile);
    return id;
  }

  /** Feed one chunk through BOTH real paths: engine ingest + activity/quiet. */
  function feed(terminalId: string, data: string, m: PtyManager = manager): void {
    const internals = m as unknown as {
      agentDetection: { ingest(id: string, chunk: string): void };
      _detectPtyState(t: unknown, data: string): void;
      terminals: Map<string, unknown>;
    };
    const terminal = internals.terminals.get(terminalId);
    internals.agentDetection.ingest(terminalId, data);
    internals._detectPtyState(terminal, data);
  }

  it("waiting screen: quiet for minutes stays running, then done after the block clears", async () => {
    const id = createFixture();
    feed(id, WAITING_SCREEN.replaceAll("\n", "\r\n"));
    // Engine coalesce (50ms): screen rule files running; quiet timer is armed.
    await vi.advanceTimersByTimeAsync(60);
    expect(manager.getPtyState(id)).toBe("running");

    // No output for a long while — several quiet windows elapse. The pane
    // must never fall to done while the background block is on screen.
    for (let i = 0; i < 4; i++) {
      await vi.advanceTimersByTimeAsync(2_600);
      expect(manager.getPtyState(id)).toBe("running");
    }

    // Background agents finish → Claude Code repaints: the block is gone and
    // a plain prompt remains. The next quiet window must file done once.
    feed(id, "\x1b[2J\x1b[H> ");
    await vi.advanceTimersByTimeAsync(2_600);
    expect(manager.getPtyState(id)).toBe("done");
  });

  it("background signal beats a confident Jev waiting_input verdict", async () => {
    const bus = new AppEventBus();
    const mockJev: Pick<JevVerifier, "isEnabled" | "classifyQuietScreen"> = {
      isEnabled: () => true,
      classifyQuietScreen: async (): Promise<JevVerdictResult | null> => ({
        verdict: "waiting_input",
        confidence: 0.99,
      }),
    };
    const jevManager = new PtyManager(bus, 2, undefined, { jevVerifier: mockJev });
    await jevManager.startAgentDetection();
    try {
      const id = createFixture(jevManager);
      // A submitted turn arms the dirty-input gate; Jev would normally file
      // attention here — concrete background evidence must win instead.
      jevManager.write(id, "watch the fleet\r", "human");
      feed(id, WAITING_SCREEN_HIDDEN_MESSAGES.replaceAll("\n", "\r\n"), jevManager);
      await vi.advanceTimersByTimeAsync(2_600);
      expect(jevManager.getPtyState(id)).toBe("running");
      // And it stays that way across repeated quiet windows.
      await vi.advanceTimersByTimeAsync(2_600);
      expect(jevManager.getPtyState(id)).toBe("running");
    } finally {
      jevManager.dispose();
    }
  });
});
