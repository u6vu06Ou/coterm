import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CLAUDE_KEEPALIVE_INTERVAL_MS,
  CODEX_KEEPALIVE_INTERVAL_MS,
  CLAUDE_KEEPALIVE_PROMPT,
  CODEX_KEEPALIVE_PROMPT,
  ClaudeKeepaliveManager,
  readLastClaudeTurnAt,
  updatePendingInput,
} from "../../src/main/terminal/claude-keepalive";

describe("ClaudeKeepaliveManager", () => {
  let idle: boolean;
  let writes: Array<{ terminalId: string; data: string }>;
  let manager: ClaudeKeepaliveManager;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-18T00:00:00.000Z"));
    idle = true;
    writes = [];
    manager = new ClaudeKeepaliveManager(2, {
      canInject: () => idle,
      inject: (terminalId, data) => {
        writes.push({ terminalId, data });
        return true;
      },
    });
  });

  afterEach(() => {
    manager.dispose();
    vi.useRealTimers();
  });

  it("pings only the official Claude launch profile after 55 minutes", () => {
    manager.trackTerminal("official", "claude-official");
    manager.trackTerminal("glm", "claude-local-main");
    vi.advanceTimersByTime(CLAUDE_KEEPALIVE_INTERVAL_MS);
    expect(writes).toEqual([
      { terminalId: "official", data: `${CLAUDE_KEEPALIVE_PROMPT}\r` },
    ]);
  });

  it("uses terminal output for the idle clock without extending the human lifetime", () => {
    manager.trackTerminal("official", "claude-official");
    vi.advanceTimersByTime(CLAUDE_KEEPALIVE_INTERVAL_MS - 60_000);
    manager.recordOutput("official");
    vi.advanceTimersByTime(60_000);
    expect(writes).toHaveLength(0);
    vi.advanceTimersByTime(CLAUDE_KEEPALIVE_INTERVAL_MS - 60_000);
    expect(writes).toHaveLength(1);

    // The 2h lifetime still expires from the original human/open activity.
    vi.advanceTimersByTime(CLAUDE_KEEPALIVE_INTERVAL_MS);
    expect(writes).toHaveLength(1);
  });

  it("resets the lifetime and idle deadline on real human input", () => {
    manager.trackTerminal("official", "claude-official");
    vi.advanceTimersByTime(50 * 60 * 1_000);
    manager.recordHumanInput("official", "hello\r");
    // A submitted line is answered — its output is the real model-turn signal
    // driving the #91 freshness clock (gap at the next tick is 55m ≤ TTL).
    manager.recordOutput("official");
    vi.advanceTimersByTime(5 * 60 * 1_000);
    expect(writes).toHaveLength(0);
    vi.advanceTimersByTime(50 * 60 * 1_000);
    expect(writes).toHaveLength(1);
  });

  it("does not let automated terminal input extend the hard lifetime", () => {
    manager.trackTerminal("official", "claude-official");
    vi.advanceTimersByTime(50 * 60 * 1_000);
    manager.recordAutomatedInput("official", "status\r");
    // The injected command answers immediately — output, like in production.
    manager.recordOutput("official");
    vi.advanceTimersByTime(CLAUDE_KEEPALIVE_INTERVAL_MS);
    expect(writes).toHaveLength(1);
    vi.advanceTimersByTime(CLAUDE_KEEPALIVE_INTERVAL_MS);
    expect(writes).toHaveLength(1);
  });

  it("skips busy and dirty-input rounds, and stays paused while the cache is dead (#91)", () => {
    manager.trackTerminal("official", "claude-official");
    manager.recordHumanInput("official", "draft");
    vi.advanceTimersByTime(CLAUDE_KEEPALIVE_INTERVAL_MS);
    expect(writes).toHaveLength(0);

    manager.recordHumanInput("official", "\x15");
    idle = false;
    vi.advanceTimersByTime(CLAUDE_KEEPALIVE_INTERVAL_MS);
    expect(writes).toHaveLength(0);
    // The pane could not accept a ping for 110 minutes: the cache is past its
    // 60-minute TTL, so the window is marked cooled instead of pinging.
    expect(manager.listStates().find((s) => s.terminalId === "official")?.cooled).toBe(true);

    // Human comes back and talks; the answer's output re-warms the clock and
    // the next interval resumes the ping.
    manager.recordHumanInput("official", "run\r");
    manager.recordOutput("official");
    idle = true;
    vi.advanceTimersByTime(CLAUDE_KEEPALIVE_INTERVAL_MS);
    expect(writes).toHaveLength(1);
    expect(manager.listStates().find((s) => s.terminalId === "official")?.cooled).toBe(false);
  });

  it("clears the timer when a terminal closes", () => {
    manager.trackTerminal("official", "claude-official");
    manager.remove("official");
    vi.advanceTimersByTime(4 * CLAUDE_KEEPALIVE_INTERVAL_MS);
    expect(writes).toHaveLength(0);
  });

  it("does not send a third ping in a 2h window", () => {
    manager.trackTerminal("official", "claude-official");
    vi.advanceTimersByTime(CLAUDE_KEEPALIVE_INTERVAL_MS);
    expect(writes).toHaveLength(1);
    vi.advanceTimersByTime(CLAUDE_KEEPALIVE_INTERVAL_MS);
    expect(writes).toHaveLength(2);
    vi.advanceTimersByTime(CLAUDE_KEEPALIVE_INTERVAL_MS);
    expect(writes).toHaveLength(2);
  });

  it("stops and restarts timers when the global setting changes", () => {
    manager.trackTerminal("official", "claude-official");
    manager.setHours(0);
    vi.advanceTimersByTime(CLAUDE_KEEPALIVE_INTERVAL_MS);
    expect(writes).toHaveLength(0);
    manager.setHours(4);
    // Re-enabling on a live pane: recent output keeps the clock fresh, so the
    // resumed schedule still pings on cadence.
    manager.recordOutput("official");
    vi.advanceTimersByTime(CLAUDE_KEEPALIVE_INTERVAL_MS);
    expect(writes).toHaveLength(1);
  });

  it("pings official codex windows on the tighter 25-minute cadence", () => {
    manager.trackTerminal("codex", "codex-official");
    vi.advanceTimersByTime(CODEX_KEEPALIVE_INTERVAL_MS);
    expect(writes).toEqual([
      { terminalId: "codex", data: `${CODEX_KEEPALIVE_PROMPT}\r` },
    ]);
    // Claude's 55-minute clock is untouched: a codex window fires roughly
    // twice per claude interval, matching the 30-minute codex cache TTL.
    vi.advanceTimersByTime(CODEX_KEEPALIVE_INTERVAL_MS);
    expect(writes).toHaveLength(2);
  });

  it("leaves free codex profiles alone", () => {
    manager.trackTerminal("glmCodex", "codex-local-main");
    vi.advanceTimersByTime(4 * CLAUDE_KEEPALIVE_INTERVAL_MS);
    expect(writes).toHaveLength(0);
  });

  it("per-window override protects a terminal even when the global setting is off", () => {
    manager.setHours(0);
    manager.trackTerminal("official", "claude-official");
    vi.advanceTimersByTime(CLAUDE_KEEPALIVE_INTERVAL_MS);
    expect(writes).toHaveLength(0);

    const state = manager.setOverrideHours("official", 3);
    expect(state).toMatchObject({ terminalId: "official", overrideHours: 3, effectiveHours: 3, eligible: true, cooled: false });
    // The user just clicked the header of a live pane — it is rendering
    // output, and output is the freshness signal (#91).
    manager.recordOutput("official");
    vi.advanceTimersByTime(CLAUDE_KEEPALIVE_INTERVAL_MS);
    expect(writes).toHaveLength(1);
    vi.advanceTimersByTime(2 * CLAUDE_KEEPALIVE_INTERVAL_MS);
    expect(writes).toHaveLength(3);
    // 3h override: the fourth interval would fall outside the window.
    vi.advanceTimersByTime(CLAUDE_KEEPALIVE_INTERVAL_MS);
    expect(writes).toHaveLength(3);
  });

  it("override null returns the window to the global setting", () => {
    manager.setOverrideHours("official", 8);
    const state = manager.setOverrideHours("official", null);
    expect(state).toMatchObject({ overrideHours: null, effectiveHours: 2 });
  });

  it("clamps override hours into 0..8", () => {
    manager.trackTerminal("official", "claude-official");
    expect(manager.setOverrideHours("official", 99).overrideHours).toBe(8);
    expect(manager.setOverrideHours("official", -4).overrideHours).toBe(0);
    expect(manager.listStates().find((s) => s.terminalId === "official")?.eligible).toBe(false);
  });

  it("override anchors the protection window at the click, not at the old activity", () => {
    manager.trackTerminal("official", "claude-official");
    // Two hours of silence — only minutes left in the original 2h window.
    vi.advanceTimersByTime(2 * 60 * 60 * 1_000 - 5 * 60 * 1_000);
    const before = writes.length;
    manager.setOverrideHours("official", 2);
    vi.advanceTimersByTime(CLAUDE_KEEPALIVE_INTERVAL_MS);
    expect(writes.length - before).toBe(1);
    vi.advanceTimersByTime(CLAUDE_KEEPALIVE_INTERVAL_MS);
    expect(writes.length - before).toBe(2);
  });
});

describe("ClaudeKeepaliveManager freshness guard (#91)", () => {
  /** Live value the probe reports; tests move it forward as turns happen. */
  let turnAt: number | null | undefined;
  let idle: boolean;
  let writes: Array<{ terminalId: string; data: string }>;
  let deferred: Array<(value: number | null | undefined) => void>;
  let probeMode: "value" | "deferred" | "throw";
  let manager: ClaudeKeepaliveManager;
  const T0 = new Date("2026-07-18T00:00:00.000Z").getTime();

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(T0);
    turnAt = T0;
    idle = true;
    writes = [];
    deferred = [];
    probeMode = "value";
    manager = new ClaudeKeepaliveManager(2, {
      canInject: () => idle,
      inject: (terminalId, data) => {
        writes.push({ terminalId, data });
        return true;
      },
      lastModelTurnAt: () => {
        if (probeMode === "deferred") {
          return new Promise((resolve) => deferred.push(resolve));
        }
        if (probeMode === "throw") {
          return Promise.reject(new Error("unreadable transcript"));
        }
        return turnAt;
      },
    });
  });

  afterEach(() => {
    manager.dispose();
    vi.useRealTimers();
  });

  it("FRESH branch: a turn inside the TTL injects and stays uncooled", async () => {
    manager.trackTerminal("official", "claude-official");
    // Last model turn 10 minutes into the window — 45 min before the tick.
    turnAt = T0 + 10 * 60 * 1_000;
    await vi.advanceTimersByTimeAsync(CLAUDE_KEEPALIVE_INTERVAL_MS);
    expect(writes).toEqual([
      { terminalId: "official", data: `${CLAUDE_KEEPALIVE_PROMPT}\r` },
    ]);
    expect(manager.listStates().find((s) => s.terminalId === "official")?.cooled).toBe(false);
  });

  it("COLD branch: a turn past the TTL skips the ping and marks the window cooled", async () => {
    manager.trackTerminal("official", "claude-official");
    // Session was resumed with its last turn already old: at the first tick
    // the gap is 75 minutes > 60-minute TTL — a ping would be a full-price
    // cold reload (#91), so the guard skips it instead of pretending.
    turnAt = T0 - 20 * 60 * 1_000;
    await vi.advanceTimersByTimeAsync(CLAUDE_KEEPALIVE_INTERVAL_MS);
    expect(writes).toHaveLength(0);
    const state = manager.listStates().find((s) => s.terminalId === "official");
    expect(state?.cooled).toBe(true);
    expect(state?.eligible).toBe(true);

    // It keeps evaluating every interval and stays paused while cold…
    await vi.advanceTimersByTimeAsync(CLAUDE_KEEPALIVE_INTERVAL_MS);
    expect(writes).toHaveLength(0);

    // …until the human comes back and talks: the marker clears immediately…
    manager.recordHumanInput("official", "hi\r");
    expect(manager.listStates().find((s) => s.terminalId === "official")?.cooled).toBe(false);
    // …and the next interval sees the answer's fresh turn and resumes pinging.
    // Human typed at T0+110m; the answer lands a minute later.
    turnAt = T0 + 111 * 60 * 1_000;
    await vi.advanceTimersByTimeAsync(CLAUDE_KEEPALIVE_INTERVAL_MS);
    expect(writes).toHaveLength(1);
  });

  it("NO_DATA branch: a pane with no model turns on record is never pinged", async () => {
    turnAt = null;
    manager.trackTerminal("official", "claude-official");
    await vi.advanceTimersByTimeAsync(2 * CLAUDE_KEEPALIVE_INTERVAL_MS);
    expect(writes).toHaveLength(0);
    expect(manager.listStates().find((s) => s.terminalId === "official")?.cooled).toBe(true);
  });

  it("per-profile TTL: codex cools after 30 silent minutes while claude still counts fresh", async () => {
    manager.trackTerminal("codex", "codex-official");
    manager.trackTerminal("official", "claude-official");
    // Codex tick at 25m: gap 25 ≤ its 30-minute TTL — fresh ping.
    await vi.advanceTimersByTimeAsync(CODEX_KEEPALIVE_INTERVAL_MS);
    expect(writes).toHaveLength(1);
    // Codex ticks again at 50m with a 50-minute gap > 30-minute TTL → cold,
    // no ping; claude at 55m has a 55-minute gap, still inside its 60-minute
    // TTL → ping.
    await vi.advanceTimersByTimeAsync(CLAUDE_KEEPALIVE_INTERVAL_MS - CODEX_KEEPALIVE_INTERVAL_MS);
    expect(writes).toHaveLength(2);
    expect(writes.map((w) => w.terminalId)).toEqual(["codex", "official"]);
    const states = manager.listStates();
    expect(states.find((s) => s.terminalId === "codex")?.cooled).toBe(true);
    expect(states.find((s) => s.terminalId === "official")?.cooled).toBe(false);
  });

  it("a stale probe resolution never injects after the entry was rescheduled", async () => {
    probeMode = "deferred";
    manager.trackTerminal("official", "claude-official");
    await vi.advanceTimersByTimeAsync(CLAUDE_KEEPALIVE_INTERVAL_MS);
    expect(deferred).toHaveLength(1);

    // Human types while the transcript probe is still in flight — the entry
    // is re-armed and the late answer must be dropped, not injected.
    manager.recordHumanInput("official", "back\r");
    deferred.shift()?.(Date.now());
    await vi.advanceTimersByTimeAsync(0);
    expect(writes).toHaveLength(0);

    // The honestly re-probed next interval does ping (fresh turn just now).
    await vi.advanceTimersByTimeAsync(CLAUDE_KEEPALIVE_INTERVAL_MS);
    expect(deferred).toHaveLength(1);
    deferred.shift()?.(Date.now());
    await vi.advanceTimersByTimeAsync(0);
    expect(writes).toHaveLength(1);
  });

  it("an undefined probe answer falls back to the manager's PTY-output clock", async () => {
    turnAt = undefined;
    manager.trackTerminal("codex", "codex-official");
    // Fallback clock started at tracking time: 25-minute gap ≤ 30-minute TTL.
    await vi.advanceTimersByTimeAsync(CODEX_KEEPALIVE_INTERVAL_MS);
    expect(writes).toHaveLength(1);
    expect(manager.listStates().find((s) => s.terminalId === "codex")?.cooled).toBe(false);
  });

  it("a rejecting probe skips the round without touching the cooled flag", async () => {
    probeMode = "throw";
    manager.trackTerminal("official", "claude-official");
    await vi.advanceTimersByTimeAsync(CLAUDE_KEEPALIVE_INTERVAL_MS);
    expect(writes).toHaveLength(0);
    expect(manager.listStates().find((s) => s.terminalId === "official")?.cooled).toBe(false);

    // Next interval retries; a recovered probe answers fresh and pings.
    probeMode = "value";
    turnAt = T0 + 60 * 60 * 1_000;
    await vi.advanceTimersByTimeAsync(CLAUDE_KEEPALIVE_INTERVAL_MS);
    expect(writes).toHaveLength(1);
  });
});

describe("readLastClaudeTurnAt (#91 probe)", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "coterm-keepalive-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const usageRecord = (timestamp: string, extra: Record<string, unknown> = {}) =>
    JSON.stringify({
      timestamp,
      message: { role: "assistant", usage: { input_tokens: 1, output_tokens: 1 } },
      ...extra,
    });

  it("returns the newest usage record's timestamp, skipping sidechains and noise", async () => {
    const file = join(dir, "s.jsonl");
    const lines = [
      usageRecord("2026-09-21T08:00:00.000Z"),
      JSON.stringify({ timestamp: "2026-09-21T09:00:00.000Z", message: { role: "user" } }),
      usageRecord("2026-09-21T09:30:00.000Z", { isSidechain: true }),
      "not-json-at-all",
      "",
    ];
    await writeFile(file, lines.join("\n"));
    expect(await readLastClaudeTurnAt(file)).toBe(Date.parse("2026-09-21T08:00:00.000Z"));
  });

  it("returns null when the file has no usage record or does not exist", async () => {
    const file = join(dir, "empty.jsonl");
    await writeFile(file, JSON.stringify({ timestamp: "2026-09-21T08:00:00.000Z", message: { role: "user" } }));
    expect(await readLastClaudeTurnAt(file)).toBeNull();
    expect(await readLastClaudeTurnAt(join(dir, "missing.jsonl"))).toBeNull();
  });

  it("ignores usage records older than the 64 KB tail window", async () => {
    const file = join(dir, "long.jsonl");
    const padding = JSON.stringify({ message: { role: "assistant", text: "x".repeat(70_000) } });
    await writeFile(file, [usageRecord("2026-09-21T08:00:00.000Z"), padding].join("\n"));
    expect(await readLastClaudeTurnAt(file)).toBeNull();
  });
});

describe("updatePendingInput", () => {
  it("tracks printable text, backspace, submit, and ignores cursor escapes", () => {
    expect(updatePendingInput("", "abc\x7f")).toBe("ab");
    expect(updatePendingInput("ab", "\x1b[A")).toBe("ab");
    expect(updatePendingInput("ab", "\r")).toBe("");
  });
});
