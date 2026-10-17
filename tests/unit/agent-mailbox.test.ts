import { describe, expect, it } from "vitest";
import { AppEventBus } from "../../src/main/core/event-bus";
import {
  AgentMailbox,
  MAIL_MESSAGE_MAX_CHARS,
  MAIL_PAIR_PAUSE_THRESHOLD,
  MAIL_TTL_MS,
  profilePrefix,
  sanitizeMailText,
  type MailboxTerminalContext,
} from "../../src/main/core/agent-mailbox";
import type { PtyState } from "../../src/shared/types";

const ESC = String.fromCharCode(27);
const BEL = String.fromCharCode(7);
const C1_OSC = String.fromCharCode(157);
const C1_ST = String.fromCharCode(156);

interface Harness {
  events: AppEventBus;
  mailbox: AgentMailbox;
  states: Map<string, PtyState>;
  screenRuleIds: Map<string, string>;
  contexts: Map<string, MailboxTerminalContext>;
  delivered: Array<{ terminalId: string; data: string }>;
  pausedPairs: Array<[string, string]>;
  advance: (ms: number) => void;
}

function makeHarness(): Harness {
  let now = 1_700_000_000_000;
  const events = new AppEventBus();
  const pausedPairs: Array<[string, string]> = [];
  const mailbox = new AgentMailbox({
    events,
    now: () => now,
    onPairPaused: (a, b) => pausedPairs.push([a, b]),
  });
  const states = new Map<string, PtyState>();
  const screenRuleIds = new Map<string, string>();
  const contexts = new Map<string, MailboxTerminalContext>();
  const delivered: Array<{ terminalId: string; data: string }> = [];
  mailbox.bind({
    getState: (id) => states.get(id) ?? null,
    getScreenRuleId: (id) => screenRuleIds.get(id) ?? null,
    getContext: (id) => contexts.get(id) ?? null,
    deliver: (id, data) => {
      delivered.push({ terminalId: id, data });
      return true;
    },
  });
  return { events, mailbox, states, screenRuleIds, contexts, delivered, pausedPairs, advance: (ms) => (now += ms) };
}

function idle(harness: Harness, terminalId: string): void {
  harness.states.set(terminalId, "done");
}

describe("profilePrefix", () => {
  it("derives the family from the first token of a profile id", () => {
    expect(profilePrefix("claude")).toBe("claude");
    expect(profilePrefix("claude-local-long")).toBe("claude");
    expect(profilePrefix("codex-local-main")).toBe("codex");
    expect(profilePrefix("codex:team")).toBe("codex");
    expect(profilePrefix("GLM 5!")).toBe("glm5");
    expect(profilePrefix(null)).toBe("pane");
    expect(profilePrefix("***")).toBe("pane");
  });
});

describe("sanitizeMailText", () => {
  it("strips ANSI CSI colour escapes", () => {
    expect(sanitizeMailText(`${ESC}[31mred${ESC}[0m plain`)).toBe("red plain");
  });

  it("strips OSC sequences terminated by BEL or ST", () => {
    expect(sanitizeMailText(`${ESC}]8;;http://example${BEL}click${ESC}]8;;${BEL}`)).toBe("click");
    expect(sanitizeMailText(`${ESC}]0;title${ESC}\\rest`)).toBe("rest");
  });

  it("strips 8-bit C1 OSC/DCS blocks", () => {
    expect(sanitizeMailText(`${C1_OSC}evil${C1_ST}safe`)).toBe("safe");
    expect(sanitizeMailText(`${C1_OSC}unterminated`)).toBe("");
  });

  it("flattens newlines, tabs and control chars to single spaces", () => {
    expect(sanitizeMailText("a\nb\tc\r\nd" + String.fromCharCode(1))).toBe("a b c d");
  });

  it("keeps CJK and emoji intact", () => {
    expect(sanitizeMailText("測試全綠 ✓ OK")).toBe("測試全綠 ✓ OK");
  });

  it("caps at 500 characters", () => {
    const out = sanitizeMailText("x".repeat(MAIL_MESSAGE_MAX_CHARS + 100));
    expect([...out].length).toBe(MAIL_MESSAGE_MAX_CHARS);
  });

  it("returns empty string for control-only input", () => {
    expect(sanitizeMailText(` ${ESC} \n\t`)).toBe("");
  });
});

describe("handle allocation", () => {
  it("gives agent panes family handles starting at 1 per family", () => {
    const h = makeHarness();
    const a = h.mailbox.onSpawn({ terminalId: "tA", isAgent: true, agentProfile: "claude" });
    const b = h.mailbox.onSpawn({ terminalId: "tB", isAgent: true, agentProfile: "claude" });
    const c = h.mailbox.onSpawn({ terminalId: "tC", isAgent: true, agentProfile: "codex" });
    expect(a.handle).toBe("claude-1");
    expect(b.handle).toBe("claude-2");
    expect(c.handle).toBe("codex-1");
    h.mailbox.dispose();
  });

  it("never reuses a number after the owning pane exits", () => {
    const h = makeHarness();
    h.mailbox.onSpawn({ terminalId: "tA", isAgent: true, agentProfile: "claude" });
    h.mailbox.onSpawn({ terminalId: "tB", isAgent: true, agentProfile: "claude" });
    h.mailbox.release("tA");
    const c = h.mailbox.onSpawn({ terminalId: "tC", isAgent: true, agentProfile: "claude" });
    expect(c.handle).toBe("claude-3");
    h.mailbox.dispose();
  });

  it("numbers stay monotonic even after every pane of the family exits", () => {
    const h = makeHarness();
    h.mailbox.onSpawn({ terminalId: "tA", isAgent: true, agentProfile: "claude" });
    h.mailbox.onSpawn({ terminalId: "tB", isAgent: true, agentProfile: "claude" });
    h.mailbox.release("tA");
    h.mailbox.release("tB");
    const c = h.mailbox.onSpawn({ terminalId: "tC", isAgent: true, agentProfile: "claude" });
    expect(c.handle).toBe("claude-3");
    // Mail to a closed handle is gone, never silently re-addressed to the
    // pane that took the recycled number.
    expect(h.mailbox.send("tC", "@claude-1", "anyone there?")).toEqual({ ok: false, code: "unknown_target" });
    h.mailbox.dispose();
  });

  it("injects the mail env into every PTY, handle only for agent panes", () => {
    const h = makeHarness();
    h.mailbox.setBaseUrl("http://127.0.0.1:43127");
    const agent = h.mailbox.onSpawn({ terminalId: "tA", isAgent: true, agentProfile: "claude" });
    const shell = h.mailbox.onSpawn({ terminalId: "tS", isAgent: false, agentProfile: null });
    expect(agent.env.COTERM_MAIL_TOKEN).toMatch(/^[0-9a-f]{48}$/);
    expect(agent.env.COTERM_TERMINAL_ID).toBe("tA");
    expect(agent.env.COTERM_MAIL_URL).toBe("http://127.0.0.1:43127/api/v1/mail");
    expect(agent.env.COTERM_AGENT_HANDLE).toBe("claude-1");
    expect(shell.handle).toBeNull();
    expect(shell.env.COTERM_AGENT_HANDLE).toBeUndefined();
    expect(shell.env.COTERM_MAIL_TOKEN).toMatch(/^[0-9a-f]{48}$/);
    h.mailbox.dispose();
  });

  it("returns no mail URL env before setBaseUrl", () => {
    const h = makeHarness();
    const a = h.mailbox.onSpawn({ terminalId: "tA", isAgent: true, agentProfile: "claude" });
    expect(a.env.COTERM_MAIL_URL).toBeUndefined();
    h.mailbox.dispose();
  });

  it("assigns a handle to a paste-launched agent at markAgent, idempotently", () => {
    const h = makeHarness();
    h.mailbox.onSpawn({ terminalId: "tS", isAgent: false, agentProfile: null });
    expect(h.mailbox.onMarkedAgent({ terminalId: "tS", agentProfile: "claude" })).toBe("claude-1");
    expect(h.mailbox.onMarkedAgent({ terminalId: "tS", agentProfile: "claude" })).toBe("claude-1");
    expect(h.mailbox.onMarkedAgent({ terminalId: "t-missing", agentProfile: "claude" })).toBeNull();
    h.mailbox.dispose();
  });
});

describe("authenticate", () => {
  it("resolves a pane token and rejects anything else", () => {
    const h = makeHarness();
    const a = h.mailbox.onSpawn({ terminalId: "tA", isAgent: true, agentProfile: "claude" });
    const b = h.mailbox.onSpawn({ terminalId: "tB", isAgent: true, agentProfile: "codex" });
    expect(h.mailbox.authenticate(a.env.COTERM_MAIL_TOKEN)?.terminalId).toBe("tA");
    expect(h.mailbox.authenticate(b.env.COTERM_MAIL_TOKEN)?.terminalId).toBe("tB");
    expect(h.mailbox.authenticate("0123456789abcdef0123456789abcdef0123456789abcdef")).toBeNull();
    expect(h.mailbox.authenticate("")).toBeNull();
    expect(h.mailbox.authenticate(null)).toBeNull();
    h.mailbox.dispose();
  });

  it("a released pane's token stops working", () => {
    const h = makeHarness();
    const a = h.mailbox.onSpawn({ terminalId: "tA", isAgent: true, agentProfile: "claude" });
    h.mailbox.release("tA");
    expect(h.mailbox.authenticate(a.env.COTERM_MAIL_TOKEN)).toBeNull();
    h.mailbox.dispose();
  });
});

describe("send delivery", () => {
  function pair(h: Harness): { a: ReturnType<AgentMailbox["onSpawn"]>; b: ReturnType<AgentMailbox["onSpawn"]> } {
    const a = h.mailbox.onSpawn({ terminalId: "tA", isAgent: true, agentProfile: "claude" });
    const b = h.mailbox.onSpawn({ terminalId: "tB", isAgent: true, agentProfile: "codex" });
    return { a, b };
  }

  it("writes one line + Enter when the target is done", () => {
    const h = makeHarness();
    pair(h);
    idle(h, "tB");
    const outcome = h.mailbox.send("tA", "@codex-1", "tests green");
    expect(outcome).toEqual({ ok: true, status: "delivered", to: "codex-1" });
    expect(h.delivered).toEqual([{ terminalId: "tB", data: "[@claude-1] tests green\r" }]);
    h.mailbox.dispose();
  });

  it("delivers immediately while the target is busy working", () => {
    const h = makeHarness();
    pair(h);
    h.states.set("tB", "running");
    const outcome = h.mailbox.send("tA", "codex-1", "mid-turn note");
    expect(outcome).toEqual({ ok: true, status: "delivered", to: "codex-1" });
    expect(h.delivered).toEqual([{ terminalId: "tB", data: "[@claude-1] mid-turn note\r" }]);
    h.mailbox.dispose();
  });

  it("queues while an approval prompt is showing and flushes FIFO when it clears", () => {
    const h = makeHarness();
    pair(h);
    h.states.set("tB", "approval_required");
    expect(h.mailbox.send("tA", "codex-1", "one")).toMatchObject({ ok: true, status: "queued", to: "codex-1" });
    expect(h.delivered).toEqual([]);
    // The approval is answered and the agent resumes work — no idle wait needed.
    h.states.set("tB", "running");
    h.events.emit("ptyStateChanged", {
      terminalId: "tB",
      projectId: "p",
      state: "running",
      previousState: "approval_required",
      source: "screen",
    });
    expect(h.delivered).toEqual([{ terminalId: "tB", data: "[@claude-1] one\r" }]);
    h.mailbox.dispose();
  });

  it("queues while the target is starting, blocked or errored", () => {
    for (const state of ["starting", "blocked", "error"] as const) {
      const h = makeHarness();
      pair(h);
      h.states.set("tB", state);
      expect(h.mailbox.send("tA", "codex-1", "patience")).toMatchObject({ ok: true, status: "queued" });
      expect(h.delivered).toEqual([]);
      h.mailbox.dispose();
    }
  });

  it("holds mail while a screen-source menu/picker rule owns waiting_input and flushes on refresh once the rule clears", () => {
    const h = makeHarness();
    pair(h);
    h.states.set("tB", "waiting_input");
    // Same state the picker/menu rules report — typed input could answer the dialog.
    h.screenRuleIds.set("tB", "claude_waiting_input");
    expect(h.mailbox.send("tA", "codex-1", "pick a card")).toMatchObject({ ok: true, status: "queued" });
    expect(h.delivered).toEqual([]);
    // Menu closed: the state is still waiting_input (no transition event), but the
    // matched rule changed — the mailbox refresh nudge flushes the queue.
    h.screenRuleIds.set("tB", "claude_done_prompt");
    h.mailbox.refresh("tB");
    expect(h.delivered).toEqual([{ terminalId: "tB", data: "[@claude-1] pick a card\r" }]);
    h.mailbox.dispose();
  });

  it("delivers to waiting_input when no menu rule is attached", () => {
    const h = makeHarness();
    pair(h);
    h.states.set("tB", "waiting_input");
    h.screenRuleIds.set("tB", "claude_done_prompt");
    expect(h.mailbox.send("tA", "codex-1", "still waiting")).toMatchObject({ ok: true, status: "delivered" });
    h.mailbox.dispose();
  });

  it("coalesces multiple queued messages from the same sender into one line", () => {
    const h = makeHarness();
    pair(h);
    h.mailbox.onSpawn({ terminalId: "tC", isAgent: true, agentProfile: "gemini" });
    h.states.set("tB", "approval_required");
    h.mailbox.send("tA", "codex-1", "one");
    h.mailbox.send("tC", "codex-1", "from the third pane");
    h.mailbox.send("tA", "codex-1", "two");
    h.states.set("tB", "done");
    h.events.emit("ptyStateChanged", {
      terminalId: "tB",
      projectId: "p",
      state: "done",
      previousState: "approval_required",
      source: "screen",
    });
    expect(h.delivered).toEqual([
      { terminalId: "tB", data: "[@claude-1] one | two\r" },
      { terminalId: "tB", data: "[@gemini-1] from the third pane\r" },
    ]);
    h.mailbox.dispose();
  });

  it("drops messages older than the TTL and reports the loss to the sender", () => {
    const h = makeHarness();
    pair(h);
    h.states.set("tB", "blocked");
    h.mailbox.send("tA", "codex-1", "stale news");
    h.advance(MAIL_TTL_MS + 1_000);
    h.states.set("tB", "done");
    h.events.emit("ptyStateChanged", {
      terminalId: "tB",
      projectId: "p",
      state: "done",
      previousState: "blocked",
      source: "screen",
    });
    expect(h.delivered).toEqual([]);
    expect(h.mailbox.takeNotices("tA")).toEqual(["1 message to codex-1 dropped (ttl)."]);
    h.mailbox.dispose();
  });

  it("drops queued mail when the target exits and tells the sender on the next call", () => {
    const h = makeHarness();
    pair(h);
    h.states.set("tB", "approval_required");
    h.mailbox.send("tA", "codex-1", "did you see this");
    h.events.emit("terminalExit", { terminalId: "tB", projectId: "p", exitCode: 0 });
    expect(h.mailbox.send("tA", "codex-1", "hello?")).toEqual({ ok: false, code: "unknown_target" });
    expect(h.mailbox.takeNotices("tA")).toEqual(["1 message to codex-1 dropped (target exited)."]);
    h.mailbox.dispose();
  });

  it("rejects self-mail, unknown handles and empty text", () => {
    const h = makeHarness();
    pair(h);
    expect(h.mailbox.send("tA", "@claude-1", "talking to myself")).toEqual({ ok: false, code: "self_send" });
    expect(h.mailbox.send("tA", "@nobody-9", "hello")).toEqual({ ok: false, code: "unknown_target" });
    expect(h.mailbox.send("tA", "@codex-1", `${ESC}[31m`)).toEqual({ ok: false, code: "empty_message" });
    expect(h.mailbox.send("t-not-registered", "@codex-1", "hi")).toEqual({ ok: false, code: "unknown_target" });
    h.mailbox.dispose();
  });

  it("normalizes handles: @prefix, case and whitespace are ignored", () => {
    const h = makeHarness();
    pair(h);
    idle(h, "tB");
    expect(h.mailbox.send("tA", " @CODEX-1 ", "hi")).toMatchObject({ ok: true, status: "delivered", to: "codex-1" });
    h.mailbox.dispose();
  });
});

describe("plain-shell senders", () => {
  it("lazily become pane-1 and the number is not reused after exit", () => {
    const h = makeHarness();
    h.mailbox.onSpawn({ terminalId: "tB", isAgent: true, agentProfile: "codex" });
    idle(h, "tB");
    h.mailbox.onSpawn({ terminalId: "tS", isAgent: false, agentProfile: null });
    h.mailbox.send("tS", "codex-1", "hi from a plain shell");
    expect(h.delivered[0]).toEqual({ terminalId: "tB", data: "[@pane-1] hi from a plain shell\r" });
    expect(h.mailbox.who("tS").selfHandle).toBe("pane-1");
    h.mailbox.release("tS");
    h.mailbox.onSpawn({ terminalId: "tS2", isAgent: false, agentProfile: null });
    h.mailbox.send("tS2", "codex-1", "again");
    expect(h.delivered[1]).toEqual({ terminalId: "tB", data: "[@pane-2] again\r" });
    h.mailbox.dispose();
  });
});

describe("abuse guards", () => {
  it("rate-limits a sender to 10 messages per minute", () => {
    const h = makeHarness();
    h.mailbox.onSpawn({ terminalId: "tA", isAgent: true, agentProfile: "claude" });
    h.mailbox.onSpawn({ terminalId: "tB", isAgent: true, agentProfile: "codex" });
    h.states.set("tB", "running");
    for (let i = 0; i < 10; i += 1) {
      expect(h.mailbox.send("tA", "codex-1", `msg ${i}`)).toMatchObject({ ok: true });
    }
    expect(h.mailbox.send("tA", "codex-1", "one too many")).toEqual({ ok: false, code: "rate_limited" });
    h.advance(61_000);
    expect(h.mailbox.send("tA", "codex-1", "after the window")).toMatchObject({ ok: true });
    h.mailbox.dispose();
  });

  it("pauses a chatty pane pair, raises onPairPaused once, then auto-unpauses after a quiet window", () => {
    const h = makeHarness();
    h.mailbox.onSpawn({ terminalId: "tA", isAgent: true, agentProfile: "claude" });
    h.mailbox.onSpawn({ terminalId: "tB", isAgent: true, agentProfile: "codex" });
    h.states.set("tB", "running");
    h.states.set("tA", "running");
    // Alternate senders so neither hits the 10/min rate limit; every 11 sends
    // jump the fake clock over a fresh minute. 21 pair messages trips the guard.
    let sent = 0;
    let last: unknown;
    for (let i = 0; i <= MAIL_PAIR_PAUSE_THRESHOLD; i += 1) {
      if (i > 0 && i % 10 === 0) h.advance(61_000);
      last = h.mailbox.send(i % 2 === 0 ? "tA" : "tB", i % 2 === 0 ? "codex-1" : "claude-1", `ping ${i}`);
      expect(last).toMatchObject({ ok: true });
      sent = i;
    }
    expect(sent).toBe(MAIL_PAIR_PAUSE_THRESHOLD); // 21 sends, 0..20
    expect(h.pausedPairs).toHaveLength(1);
    // Next send in either direction bounces.
    h.advance(61_000); // fresh rate window, still inside the 10-min pair window
    expect(h.mailbox.send("tA", "codex-1", "still chatting")).toEqual({ ok: false, code: "pair_paused" });
    expect(h.mailbox.send("tB", "claude-1", "still chatting")).toEqual({ ok: false, code: "pair_paused" });
    expect(h.pausedPairs).toHaveLength(1); // callback fired only on the crossing
    // A full quiet window later the pair talks again.
    h.advance(10 * 60_000 + 61_000);
    expect(h.mailbox.send("tA", "codex-1", "calm again")).toMatchObject({ ok: true });
    h.mailbox.dispose();
  });

  it("keeps one pair paused without affecting others", () => {
    const h = makeHarness();
    h.mailbox.onSpawn({ terminalId: "tA", isAgent: true, agentProfile: "claude" });
    h.mailbox.onSpawn({ terminalId: "tB", isAgent: true, agentProfile: "codex" });
    h.mailbox.onSpawn({ terminalId: "tC", isAgent: true, agentProfile: "gemini" });
    h.states.set("tB", "running");
    h.states.set("tC", "running");
    for (let i = 0; i <= MAIL_PAIR_PAUSE_THRESHOLD; i += 1) {
      if (i > 0 && i % 10 === 0) h.advance(61_000);
      h.mailbox.send(i % 2 === 0 ? "tA" : "tB", i % 2 === 0 ? "codex-1" : "claude-1", `ping ${i}`);
    }
    h.advance(61_000);
    expect(h.mailbox.send("tA", "codex-1", "x")).toEqual({ ok: false, code: "pair_paused" });
    expect(h.mailbox.send("tA", "gemini-1", "different partner")).toMatchObject({ ok: true });
    h.mailbox.dispose();
  });
});

describe("who", () => {
  it("lists handled panes sorted by handle with state + cwd basename, and surfaces notices", () => {
    const h = makeHarness();
    h.mailbox.onSpawn({ terminalId: "tA", isAgent: true, agentProfile: "claude" });
    h.mailbox.onSpawn({ terminalId: "tB", isAgent: true, agentProfile: "codex" });
    h.mailbox.onSpawn({ terminalId: "tS", isAgent: false, agentProfile: null });
    h.states.set("tA", "done");
    h.contexts.set("tA", { agentProfile: "claude", cwd: "D:\\Coterm", projectId: "p" });
    h.contexts.set("tB", { agentProfile: "codex", cwd: "D:\\work\\proj", projectId: "p" });
    const first = h.mailbox.who("tA");
    expect(first.selfHandle).toBe("claude-1");
    expect(first.rows).toEqual([
      { handle: "claude-1", profile: "claude", state: "done", cwd: "Coterm" },
      { handle: "codex-1", profile: "codex", state: "unknown", cwd: "proj" },
    ]);
    h.mailbox.dispose();
  });
});
