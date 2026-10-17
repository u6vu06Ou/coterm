// Tests for the agent done-toast decision logic (src/main/notify/agent-done-toast.ts).
// Pure decision function + title composition + the notifier class with fake
// deps (no electron import anywhere in this file, so it runs in plain vitest).
// Settle windows use vitest fake timers against the real defaults.

import { describe, expect, it, vi } from "vitest";
import { AppEventBus } from "../../src/main/core/event-bus";
import {
  AgentDoneToastNotifier,
  ATTENTION_SETTLE_MS,
  DEFAULT_AGENT_TOAST_TIMINGS,
  DONE_MIN_GAP_MS,
  DONE_SETTLE_MS,
  MIN_WORKING_SPAN_MS,
  TOAST_COOLDOWN_MS,
  agentToastTitle,
  decideAgentToast,
  isToastCandidate,
  type AgentToastShowInput,
  type ToastTitleInfo,
} from "../../src/main/notify/agent-done-toast";
import type { PtyStateChanged } from "@shared/types";

const BASE = {
  isEnabled: true,
  windowFocused: false,
  isSelected: false,
  ownedByAgentApi: false,
  turnNotified: false,
  lastNotifyAt: null,
  lastDoneToastAt: null,
  workingSpanMs: null,
  doneToastFired: false,
  userTurn: true,
  now: 1_000_000,
  timings: DEFAULT_AGENT_TOAST_TIMINGS,
};

describe("isToastCandidate", () => {
  it("accepts only working → done/attention edges", () => {
    expect(isToastCandidate("running", "done")).toBe(true);
    expect(isToastCandidate("starting", "done")).toBe(true);
    expect(isToastCandidate("running", "waiting_input")).toBe(true);
    expect(isToastCandidate("running", "approval_required")).toBe(true);
    expect(isToastCandidate("running", "blocked")).toBe(true);
    expect(isToastCandidate("running", "error")).toBe(true);
    expect(isToastCandidate(null, "done")).toBe(false); // spawn/hydrate
    expect(isToastCandidate(null, "running")).toBe(false);
    expect(isToastCandidate("done", "done")).toBe(false);
    expect(isToastCandidate("running", "running")).toBe(false); // source upgrade
    expect(isToastCandidate("done", "blocked")).toBe(false);
  });
});

describe("decideAgentToast", () => {
  it("never toasts attention states (owner rule 2026-10-15: only a finished main-agent turn)", () => {
    for (const next of ["waiting_input", "approval_required", "error"] as const) {
      expect(decideAgentToast({ ...BASE, previous: "running", next }).notify).toBe(false);
    }
  });

  it("drops a done the user did not start (restored session, sub-agent, background task)", () => {
    const decision = decideAgentToast({ ...BASE, userTurn: false, previous: "running", next: "done" });
    expect(decision).toMatchObject({ notify: false, reason: "no-user-turn" });
  });

  it("notifies on working → done", () => {
    const decision = decideAgentToast({ ...BASE, previous: "running", next: "done" });
    expect(decision).toEqual({ notify: true, kind: "done", reason: "notify" });
  });

  it("never notifies on spawn/hydrate (previous=null)", () => {
    const decision = decideAgentToast({ ...BASE, previous: null, next: "done" });
    expect(decision).toEqual({ notify: false, kind: null, reason: "not-from-working" });
  });

  it("never notifies on same-state source upgrades", () => {
    const decision = decideAgentToast({ ...BASE, previous: "running", next: "running" });
    expect(decision).toEqual({ notify: false, kind: null, reason: "not-from-working" });
  });

  it("never notifies for an agent-owned (sub-agent) pane", () => {
    for (const next of ["done", "waiting_input"] as const) {
      const decision = decideAgentToast({
        ...BASE,
        ownedByAgentApi: true,
        previous: "running",
        next,
      });
      expect(decision).toEqual({ notify: false, kind: null, reason: "agent-owned" });
    }
  });

  it("skips done when a short wake-up follows a previous done toast (never re-arms)", () => {
    const decision = decideAgentToast({
      ...BASE,
      previous: "running",
      next: "done",
      doneToastFired: true,
      workingSpanMs: MIN_WORKING_SPAN_MS - 1,
    });
    expect(decision).toEqual({ notify: false, kind: null, reason: "short-working" });
    // Unknown span counts as unverified and is suppressed too…
    const unknown = decideAgentToast({
      ...BASE,
      previous: "running",
      next: "done",
      doneToastFired: true,
      workingSpanMs: null,
    });
    expect(unknown).toEqual({ notify: false, kind: null, reason: "short-working" });
    // …but only once a done toast actually fired — a fresh pane still toasts.
    const fresh = decideAgentToast({
      ...BASE,
      previous: "running",
      next: "done",
      doneToastFired: false,
      workingSpanMs: 1_000,
    });
    expect(fresh).toEqual({ notify: true, kind: "done", reason: "notify" });
  });

  it("lets a meaningful working stretch (≥20s) count as a new done turn", () => {
    const decision = decideAgentToast({
      ...BASE,
      previous: "running",
      next: "done",
      doneToastFired: true,
      workingSpanMs: MIN_WORKING_SPAN_MS,
    });
    expect(decision).toEqual({ notify: true, kind: "done", reason: "notify" });
  });

  it("enforces the per-terminal minimum gap between done toasts", () => {
    const within = decideAgentToast({
      ...BASE,
      previous: "running",
      next: "done",
      doneToastFired: true,
      workingSpanMs: MIN_WORKING_SPAN_MS,
      lastDoneToastAt: BASE.now - (DONE_MIN_GAP_MS - 1),
      lastNotifyAt: BASE.now - DONE_MIN_GAP_MS,
    });
    expect(within).toEqual({ notify: false, kind: null, reason: "done-gap" });
    const past = decideAgentToast({
      ...BASE,
      previous: "running",
      next: "done",
      doneToastFired: true,
      workingSpanMs: MIN_WORKING_SPAN_MS,
      lastDoneToastAt: BASE.now - DONE_MIN_GAP_MS,
      lastNotifyAt: BASE.now - DONE_MIN_GAP_MS,
    });
    expect(past).toEqual({ notify: true, kind: "done", reason: "notify" });
  });

  it("documents check order: cooldown wins over focused-selected", () => {
    const decision = decideAgentToast({
      ...BASE,
      previous: "running",
      next: "done",
      lastNotifyAt: BASE.now - 1_000,
      windowFocused: true,
      isSelected: true,
    });
    expect(decision).toEqual({ notify: false, kind: null, reason: "cooldown" });
  });

  it("documents check order: done-gap wins over focused-selected", () => {
    const decision = decideAgentToast({
      ...BASE,
      previous: "running",
      next: "done",
      doneToastFired: true,
      workingSpanMs: MIN_WORKING_SPAN_MS,
      lastDoneToastAt: BASE.now - 1_000,
      windowFocused: true,
      isSelected: true,
    });
    expect(decision).toEqual({ notify: false, kind: null, reason: "done-gap" });
  });

  it("skips when already notified this turn", () => {
    const decision = decideAgentToast({
      ...BASE,
      previous: "running",
      next: "done",
      turnNotified: true,
      windowFocused: true,
    });
    expect(decision).toEqual({ notify: false, kind: null, reason: "already-notified" });
  });

  it("applies the per-terminal cooldown (last ACTUAL toast)", () => {
    const within = decideAgentToast({
      ...BASE,
      previous: "running",
      next: "done",
      lastNotifyAt: BASE.now - (TOAST_COOLDOWN_MS - 1),
    });
    expect(within).toEqual({ notify: false, kind: null, reason: "cooldown" });
    const at = decideAgentToast({
      ...BASE,
      previous: "running",
      next: "done",
      lastNotifyAt: BASE.now - TOAST_COOLDOWN_MS,
    });
    expect(at).toEqual({ notify: true, kind: "done", reason: "notify" });
  });

  it("skips when the window is focused and the pane is selected", () => {
    const decision = decideAgentToast({
      ...BASE,
      previous: "running",
      next: "done",
      windowFocused: true,
      isSelected: true,
    });
    expect(decision).toEqual({ notify: false, kind: null, reason: "focused-selected" });
  });

  it("notifies when focused but a different pane is selected", () => {
    const decision = decideAgentToast({
      ...BASE,
      previous: "running",
      next: "done",
      windowFocused: true,
      isSelected: false,
    });
    expect(decision.notify).toBe(true);
  });

  it("notifies when selected but the window is not focused", () => {
    const decision = decideAgentToast({
      ...BASE,
      previous: "running",
      next: "done",
      windowFocused: false,
      isSelected: true,
    });
    expect(decision.notify).toBe(true);
  });

  it("never notifies when the setting is off", () => {
    for (const next of ["done", "waiting_input", "error"] as const) {
      const decision = decideAgentToast({
        ...BASE,
        isEnabled: false,
        previous: "running",
        next,
      });
      expect(decision).toEqual({ notify: false, kind: null, reason: "disabled" });
    }
  });
});

describe("agentToastTitle", () => {
  function titleInfo(overrides: Partial<ToastTitleInfo> = {}): ToastTitleInfo {
    return {
      isAgent: true,
      profile: "pwsh",
      cwd: "D:\\work\\repo",
      title: "Claude Code",
      agentSummaryTitle: "修好登入流程",
      ownedByAgentApi: false,
      agentHandle: "claude-1",
      ...overrides,
    };
  }

  it("prefers the agent summary title and appends the mail handle", () => {
    expect(agentToastTitle(titleInfo())).toBe("修好登入流程 · claude-1");
  });

  it("appends the handle only when one exists", () => {
    expect(agentToastTitle(titleInfo({ agentHandle: null }))).toBe("修好登入流程");
  });

  it("rejects placeholder / shell-executable titles, falls back to cwd", () => {
    expect(agentToastTitle(titleInfo({ agentSummaryTitle: null, agentHandle: null }))).toBe("repo");
    expect(
      agentToastTitle(titleInfo({ agentSummaryTitle: null, title: "C:\\Program Files\\PowerShell\\7\\pwsh.exe", agentHandle: null })),
    ).toBe("repo");
    // …and the mail handle still appends to the fallback title.
    expect(agentToastTitle(titleInfo({ agentSummaryTitle: null }))).toBe("repo · claude-1");
  });

  it("skips a bare-Claude-Code title even in different case", () => {
    expect(
      agentToastTitle(titleInfo({ agentSummaryTitle: null, title: "claude code", agentHandle: null })),
    ).toBe("repo");
  });

  it("plain shells always show the cwd basename", () => {
    expect(
      agentToastTitle(titleInfo({ isAgent: false, agentSummaryTitle: "x", agentHandle: null })),
    ).toBe("repo");
  });

  it("returns the cwd leaf for pwsh profiles with no summary, trimming trailing slashes", () => {
    expect(
      agentToastTitle(titleInfo({ profile: "pwsh", agentSummaryTitle: null, cwd: "D:\\Coterm\\", agentHandle: null })),
    ).toBe("Coterm");
  });

  it("returns null for null info / no cwd and no usable title", () => {
    expect(agentToastTitle(null)).toBeNull();
    expect(
      agentToastTitle(titleInfo({ cwd: "", agentSummaryTitle: null, title: "Claude Code" })),
    ).toBeNull();
  });
});

// Microtask-only flush: works under both real and vitest fake timers
// (setImmediate is faked by default and would never fire on its own).
async function flush(): Promise<void> {
  for (let i = 0; i < 6; i += 1) {
    await Promise.resolve();
  }
}

describe("AgentDoneToastNotifier", () => {
  function makeNotifier(
    overrides: {
      selected?: string | null;
      focused?: boolean;
      enabled?: boolean;
      ownedByAgentApi?: boolean;
      /** Last user Enter; defaults to "just now" (every settle is a fresh user turn). */
      lastSubmitAt?: (terminalId: string) => number | null;
      /** Null for a terminal id = the terminal no longer exists (closed). */
      getTerminal?: (terminalId: string) => ToastTitleInfo | null;
    } = {},
  ) {
    const events = new AppEventBus();
    const toasts: AgentToastShowInput[] = [];
    const focusCalls: string[] = [];
    let focused = overrides.focused ?? false;
    const notifier = new AgentDoneToastNotifier({
      events,
      getTerminal:
        overrides.getTerminal ??
        ((id) => ({
          isAgent: true,
          profile: "pwsh" as const,
          cwd: "D:\\work\\repo",
          title: "Claude Code",
          agentSummaryTitle: "修好登入流程",
          ownedByAgentApi: overrides.ownedByAgentApi ?? false,
          agentHandle: `claude-${id}`,
        })),
      isEnabled: () => overrides.enabled ?? true,
      isWindowFocused: () => focused,
      getSelectedTerminalId: async () => overrides.selected ?? null,
      getLastHumanSubmitAt: overrides.lastSubmitAt ?? (() => Date.now()),
      showToast: (input) => {
        toasts.push(input);
      },
      focusAndSelect: (terminalId) => {
        focusCalls.push(terminalId);
      },
    });
    const emit = (change: Partial<PtyStateChanged> & Pick<PtyStateChanged, "state" | "previousState">) => {
      events.emit("ptyStateChanged", {
        terminalId: "t1",
        projectId: "p1",
        source: "process" as const,
        ...change,
      });
    };
    const close = (): void => {
      events.emit("terminalListChanged", { projectId: "p1" });
    };
    return { notifier, toasts, focusCalls, emit, close, setFocused: (v: boolean) => { focused = v; } };
  }

  it("fires the done toast only after the settle window (12s of stable done)", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    try {
      const { toasts, emit } = makeNotifier();
      emit({ previousState: "running", state: "done" });
      await flush();
      expect(toasts).toHaveLength(0);
      // Same-state bursts while done keep the original settle timer.
      emit({ previousState: "done", state: "done" });
      vi.advanceTimersByTime(DONE_SETTLE_MS - 1_000);
      await flush();
      expect(toasts).toHaveLength(0);
      vi.advanceTimersByTime(1_000);
      await flush();
      expect(toasts).toEqual([
        { terminalId: "t1", title: "修好登入流程 · claude-t1", body: "完成了" },
      ]);
      // done→done bursts after the toast are not working edges — nothing more.
      emit({ previousState: "done", state: "done" });
      vi.advanceTimersByTime(5 * DONE_MIN_GAP_MS);
      await flush();
      expect(toasts).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("cancels the settle wait when the pane flips back to working before it fires", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    try {
      const { toasts, emit } = makeNotifier();
      // working → done → working inside the window (sub-agent finished its
      // step / the next step began) must never toast…
      emit({ previousState: "running", state: "done" });
      vi.advanceTimersByTime(5_000);
      emit({ previousState: "done", state: "running" });
      vi.advanceTimersByTime(10 * DONE_SETTLE_MS);
      await flush();
      expect(toasts).toHaveLength(0);
      // …while a later genuinely-finished turn still does.
      emit({ previousState: "running", state: "done" });
      vi.advanceTimersByTime(DONE_SETTLE_MS);
      await flush();
      expect(toasts).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("never toasts for an agent-owned (sub-agent) pane", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    try {
      const { toasts, emit } = makeNotifier({ ownedByAgentApi: true });
      emit({ previousState: "running", state: "done" });
      vi.advanceTimersByTime(DONE_SETTLE_MS);
      await flush();
      expect(toasts).toHaveLength(0);
      emit({ previousState: "running", state: "waiting_input" });
      vi.advanceTimersByTime(ATTENTION_SETTLE_MS);
      await flush();
      expect(toasts).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("dispose cancels every pending settle wait", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    try {
      const { notifier, toasts, emit } = makeNotifier();
      emit({ previousState: "running", state: "waiting_input" });
      notifier.dispose();
      vi.advanceTimersByTime(10 * DONE_SETTLE_MS);
      await flush();
      expect(toasts).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("a closed terminal's pending settle wait is cancelled", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    try {
      const { toasts, emit, close } = makeNotifier({
        getTerminal: () => null, // pane closed → gone from the terminal list
      });
      emit({ previousState: "running", state: "done" });
      await flush();
      close(); // terminalListChanged → reconcile purges the pending wait
      vi.advanceTimersByTime(10 * DONE_SETTLE_MS);
      await flush();
      expect(toasts).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("suppresses when the window is focused and the pane is selected; notifies when the user looks away", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    try {
      const { toasts, emit, setFocused } = makeNotifier({ selected: "t1", focused: true });
      emit({ previousState: "running", state: "done" });
      vi.advanceTimersByTime(DONE_SETTLE_MS);
      await flush();
      expect(toasts).toHaveLength(0);
      emit({ previousState: "done", state: "running" });
      vi.advanceTimersByTime(MIN_WORKING_SPAN_MS + DONE_MIN_GAP_MS);
      setFocused(false);
      emit({ previousState: "running", state: "done" });
      vi.advanceTimersByTime(DONE_SETTLE_MS);
      await flush();
      expect(toasts).toEqual([{ terminalId: "t1", title: "修好登入流程 · claude-t1", body: "完成了" }]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("restored session: the launch Enter typed before the agent was idle never toasts", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    try {
      const launchEnter = Date.now() - 5_000; // +agent / resume command Enter
      const { toasts, emit } = makeNotifier({ lastSubmitAt: () => launchEnter });
      emit({ previousState: "starting", state: "done" });
      vi.advanceTimersByTime(DONE_SETTLE_MS);
      await flush();
      emit({ previousState: "done", state: "running" });
      vi.advanceTimersByTime(MIN_WORKING_SPAN_MS + DONE_MIN_GAP_MS);
      emit({ previousState: "running", state: "done" });
      vi.advanceTimersByTime(DONE_SETTLE_MS);
      await flush();
      expect(toasts).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("one user Enter buys at most one done toast; background finishes without a new Enter stay silent", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    try {
      let submit: number | null = null;
      const { toasts, emit } = makeNotifier({ lastSubmitAt: () => submit });
      emit({ previousState: null, state: "done" }); // agent idle at its prompt
      vi.advanceTimersByTime(1_000);
      submit = Date.now(); // user sends a message
      emit({ previousState: "done", state: "running" });
      vi.advanceTimersByTime(MIN_WORKING_SPAN_MS);
      emit({ previousState: "running", state: "done" });
      vi.advanceTimersByTime(DONE_SETTLE_MS);
      await flush();
      expect(toasts).toHaveLength(1);
      // A sub-agent / background task wakes the pane later — no new Enter.
      vi.advanceTimersByTime(DONE_MIN_GAP_MS);
      emit({ previousState: "done", state: "running" });
      vi.advanceTimersByTime(MIN_WORKING_SPAN_MS);
      emit({ previousState: "running", state: "done" });
      vi.advanceTimersByTime(DONE_SETTLE_MS);
      await flush();
      expect(toasts).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("sub-agent spam guard: short wake-ups past every gap never toast; ≥20s stretches do", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    try {
      const { toasts, emit } = makeNotifier();
      // Toast 1 at t=12s (fresh pane — no previous done toast, no span gate).
      emit({ previousState: "running", state: "done" });
      vi.advanceTimersByTime(DONE_SETTLE_MS);
      await flush();
      expect(toasts).toHaveLength(1);
      // lastDoneToastAt = 12s from here on.

      // (1) done-gap: a genuine ≥20s stretch whose fire lands inside the 60s
      // gap is held — the reason is the gap, NOT the span.
      emit({ previousState: "done", state: "running" }); // t=12s, workingSince=12s
      vi.advanceTimersByTime(22_000); // t=34s
      emit({ previousState: "running", state: "done" }); // span 22s; fire at t=46s
      vi.advanceTimersByTime(DONE_SETTLE_MS);
      await flush();
      expect(toasts).toHaveLength(1); // 46−12=34s < 60s → done-gap

      // (2) first short wake-up: fire at t=61s → still inside the 60s gap.
      emit({ previousState: "done", state: "running" }); // t=46s, workingSince=46s
      vi.advanceTimersByTime(3_000); // t=49s
      emit({ previousState: "running", state: "done" }); // span 3s; fire at t=61s
      vi.advanceTimersByTime(DONE_SETTLE_MS);
      await flush();
      expect(toasts).toHaveLength(1); // 61−12=49s < 60s → done-gap

      // (3) second short wake-up far past every gap: fire at t=76s (gap
      // 76−12=64s ≥ 60s) but the stretch was only 3s → short-working holds.
      emit({ previousState: "done", state: "running" }); // t=61s, workingSince=61s
      vi.advanceTimersByTime(3_000); // t=64s
      emit({ previousState: "running", state: "done" }); // span 3s; fire at t=76s
      vi.advanceTimersByTime(DONE_SETTLE_MS);
      await flush();
      expect(toasts).toHaveLength(1); // short-working (3s < 20s)

      // (4) a meaningful stretch (≥20s) past every gap counts as a new turn.
      emit({ previousState: "done", state: "running" }); // t=76s, workingSince=76s
      vi.advanceTimersByTime(25_000); // t=101s
      emit({ previousState: "running", state: "done" }); // span 25s; fire at t=113s
      vi.advanceTimersByTime(DONE_SETTLE_MS);
      await flush();
      expect(toasts).toHaveLength(2); // gap 101s ≥ 60s, span 25s ≥ 20s → toast 2
    } finally {
      vi.useRealTimers();
    }
  });

  it("isolated done min-gap: two genuine ≥20s turns back-to-back hold the second", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    try {
      const { toasts, emit } = makeNotifier();
      emit({ previousState: "running", state: "done" });
      vi.advanceTimersByTime(DONE_SETTLE_MS); // t=12s → toast 1
      await flush();
      expect(toasts).toHaveLength(1);

      emit({ previousState: "done", state: "running" }); // t=12s
      vi.advanceTimersByTime(MIN_WORKING_SPAN_MS); // t=32s
      emit({ previousState: "running", state: "done" }); // span 20s; fire at t=44s
      vi.advanceTimersByTime(DONE_SETTLE_MS);
      await flush();
      expect(toasts).toHaveLength(1); // 44−12=32s < 60s → held

      emit({ previousState: "done", state: "running" }); // t=44s
      vi.advanceTimersByTime(DONE_MIN_GAP_MS + MIN_WORKING_SPAN_MS); // t=124s
      emit({ previousState: "running", state: "done" }); // span 80s; fire at t=136s
      vi.advanceTimersByTime(DONE_SETTLE_MS);
      await flush();
      expect(toasts).toHaveLength(2); // 136−12=124s ≥ 60s → toast 2
    } finally {
      vi.useRealTimers();
    }
  });

  it("respects the disabled setting; no settle wait is armed", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    try {
      const { toasts, emit } = makeNotifier({ enabled: false });
      emit({ previousState: "running", state: "done" });
      vi.advanceTimersByTime(10 * DONE_SETTLE_MS);
      await flush();
      expect(toasts).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("delegates toast clicks to focusAndSelect", () => {
    const { notifier, focusCalls } = makeNotifier();
    notifier.handleToastClick("t1");
    expect(focusCalls).toEqual(["t1"]);
  });
});
