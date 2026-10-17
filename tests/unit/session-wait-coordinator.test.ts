// Unit tests for SessionWaitCoordinator (issue #4).
// Fake timers + a fake event bus drive every outcome deterministically.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import {
  SessionWaitCoordinator,
  WAIT_DEFAULT_TIMEOUT_SECONDS,
  WAIT_MAX_TIMEOUT_SECONDS,
  WAIT_MIN_TIMEOUT_SECONDS,
} from "../../src/main/core/session-wait-coordinator";
import type { AppEventBus } from "../../src/main/core/event-bus";
import type { PtyState, PtyStateChanged } from "../../src/shared/types";

interface FakeBus extends AppEventBus {
  emitState(change: PtyStateChanged): void;
  emitExit(terminalId: string, projectId: string, exitCode: number): void;
  emitData(terminalId: string, data: string, opts?: { replace?: boolean }): void;
}

function makeBus(): FakeBus {
  const bus = new EventEmitter() as unknown as FakeBus & EventEmitter;
  bus.emitState = (change) => bus.emit("ptyStateChanged", change);
  bus.emitExit = (terminalId, projectId, exitCode) =>
    bus.emit("terminalExit", { terminalId, projectId, exitCode });
  bus.emitData = (terminalId, data, opts) =>
    bus.emit("terminalData", { terminalId, projectId: PID, data, revision: 1, ...(opts ?? {}) });
  return bus as FakeBus;
}

function makeCoordinator(opts: {
  bus: FakeBus;
  states: Map<string, PtyState | null>;
  now?: () => number;
  scheduleTimer?: (cb: () => void, ms: number) => NodeJS.Timeout;
  clearTimer?: (handle: NodeJS.Timeout) => void;
}) {
  return new SessionWaitCoordinator({
    events: opts.bus as unknown as AppEventBus,
    readState: (id) => opts.states.get(id) ?? null,
    ...(opts.now ? { now: opts.now } : {}),
    ...(opts.scheduleTimer ? { scheduleTimer: opts.scheduleTimer } : {}),
    ...(opts.clearTimer ? { clearTimer: opts.clearTimer } : {}),
  });
}

const TID = "11111111-1111-4111-8111-111111111111";
const PID = "22222222-2222-4222-8222-222222222222";

describe("SessionWaitCoordinator", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("fast-path resolves matched when the terminal is already in the target state", async () => {
    const bus = makeBus();
    const states = new Map<string, PtyState | null>([[TID, "approval_required"]]);
    const coord = makeCoordinator({ bus, states });
    const result = await coord.waitFor({
      terminalId: TID,
      targetState: "approval_required",
      stopOn: new Set(["done", "error"]),
      timeoutMs: 1000,
    });
    expect(result).toMatchObject({
      outcome: "matched",
      sessionId: TID,
      targetState: "approval_required",
      state: "approval_required",
    });
    expect(result.observedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(coord.pendingTotal()).toBe(0);
  });

  it("fast-path resolves interrupted when the terminal is already in a stop state", async () => {
    const bus = makeBus();
    const states = new Map<string, PtyState | null>([[TID, "error"]]);
    const coord = makeCoordinator({ bus, states });
    const result = await coord.waitFor({
      terminalId: TID,
      targetState: "approval_required",
      stopOn: new Set(["error", "done"]),
      timeoutMs: 1000,
    });
    expect(result.outcome).toBe("interrupted");
    expect(result.state).toBe("error");
  });

  it("resolves matched when a ptyStateChanged event fires the target", async () => {
    const bus = makeBus();
    const states = new Map<string, PtyState | null>([[TID, "running"]]);
    const coord = makeCoordinator({ bus, states });
    const promise = coord.waitFor({
      terminalId: TID,
      targetState: "approval_required",
      stopOn: new Set(["done", "error"]),
      timeoutMs: 5000,
    });
    // Transition running -> approval_required.
    states.set(TID, "approval_required");
    bus.emitState({ terminalId: TID, projectId: PID, state: "approval_required", previousState: "running", source: "osc" });
    const result = await promise;
    expect(result).toMatchObject({ outcome: "matched", state: "approval_required" });
    expect(coord.pendingFor(TID)).toBe(0);
  });

  it("resolves interrupted when a stop state fires", async () => {
    const bus = makeBus();
    const states = new Map<string, PtyState | null>([[TID, "running"]]);
    const coord = makeCoordinator({ bus, states });
    const promise = coord.waitFor({
      terminalId: TID,
      targetState: "approval_required",
      stopOn: new Set(["done", "error"]),
      timeoutMs: 5000,
    });
    states.set(TID, "error");
    bus.emitState({ terminalId: TID, projectId: PID, state: "error", previousState: "running", source: "process" });
    const result = await promise;
    expect(result.outcome).toBe("interrupted");
    expect(result.state).toBe("error");
  });

  it("resolves timeout when no event fires before the deadline", async () => {
    const bus = makeBus();
    const states = new Map<string, PtyState | null>([[TID, "running"]]);
    const coord = makeCoordinator({ bus, states });
    const promise = coord.waitFor({
      terminalId: TID,
      targetState: "approval_required",
      stopOn: new Set(["done"]),
      timeoutMs: 3000,
    });
    vi.advanceTimersByTime(3001);
    const result = await promise;
    expect(result.outcome).toBe("timeout");
    expect(coord.pendingTotal()).toBe(0);
  });

  it("resolves closed when terminalExit fires for the terminal", async () => {
    const bus = makeBus();
    const states = new Map<string, PtyState | null>([[TID, "running"]]);
    const coord = makeCoordinator({ bus, states });
    const promise = coord.waitFor({
      terminalId: TID,
      targetState: "approval_required",
      stopOn: new Set(["done"]),
      timeoutMs: 5000,
    });
    states.set(TID, null);
    bus.emitExit(TID, PID, 0);
    const result = await promise;
    expect(result).toMatchObject({ outcome: "closed", state: null });
  });

  it("resolves interrupted when the abort signal fires", async () => {
    const bus = makeBus();
    const states = new Map<string, PtyState | null>([[TID, "running"]]);
    const coord = makeCoordinator({ bus, states });
    const controller = new AbortController();
    const promise = coord.waitFor({
      terminalId: TID,
      targetState: "approval_required",
      stopOn: new Set(["done"]),
      timeoutMs: 5000,
      abortSignal: controller.signal,
    });
    controller.abort();
    const result = await promise;
    expect(result.outcome).toBe("interrupted");
  });

  it("cleans up when the abort signal was already aborted", async () => {
    const bus = makeBus();
    const states = new Map<string, PtyState | null>([[TID, "running"]]);
    const coord = makeCoordinator({ bus, states });
    const controller = new AbortController();
    controller.abort();
    const result = await coord.waitFor({
      terminalId: TID,
      targetState: "done",
      stopOn: new Set(["error"]),
      timeoutMs: 5000,
      abortSignal: controller.signal,
    });
    expect(result.outcome).toBe("interrupted");
    expect(coord.pendingTotal()).toBe(0);
  });

  it("lost-wakeup: a transition between fast-path and subscribe is caught by the recheck", async () => {
    const bus = makeBus();
    // readState returns "running" on the first call (fast path), then
    // "approval_required" on the recheck — simulating a transition that
    // happened between subscribe and recheck.
    let calls = 0;
    const coord = new SessionWaitCoordinator({
      events: bus as unknown as AppEventBus,
      readState: () => {
        calls += 1;
        return calls === 1 ? "running" : "approval_required";
      },
    });
    const result = await coord.waitFor({
      terminalId: TID,
      targetState: "approval_required",
      stopOn: new Set(["done"]),
      timeoutMs: 5000,
    });
    expect(result.outcome).toBe("matched");
    expect(result.state).toBe("approval_required");
  });

  it("shutdown resolves all pending waits with outcome shutdown", async () => {
    const bus = makeBus();
    const states = new Map<string, PtyState | null>([[TID, "running"]]);
    const coord = makeCoordinator({ bus, states });
    const promise = coord.waitFor({
      terminalId: TID,
      targetState: "approval_required",
      stopOn: new Set(["done"]),
      timeoutMs: 5000,
    });
    coord.shutdown();
    const result = await promise;
    expect(result.outcome).toBe("shutdown");
    expect(coord.pendingTotal()).toBe(0);
    expect(bus.listenerCount("ptyStateChanged")).toBe(0);
    expect(bus.listenerCount("terminalExit")).toBe(0);
    expect(coord.isShutdown()).toBe(true);
  });

  it("a new wait after shutdown resolves shutdown without listeners or timers", async () => {
    const bus = makeBus();
    const states = new Map<string, PtyState | null>([[TID, "running"]]);
    const scheduled = vi.fn((cb: () => void, ms: number) => setTimeout(cb, ms));
    const coord = makeCoordinator({ bus, states, scheduleTimer: scheduled });
    coord.shutdown();
    const result = await coord.waitFor({
      terminalId: TID,
      targetState: "done",
      stopOn: new Set(["error"]),
      timeoutMs: 5000,
    });
    expect(result.outcome).toBe("shutdown");
    expect(scheduled).not.toHaveBeenCalled();
    expect(coord.pendingTotal()).toBe(0);
  });

  it("per-session limit: 4 concurrent waits, 5th rejected via wouldExceedLimits", async () => {
    const bus = makeBus();
    const states = new Map<string, PtyState | null>([[TID, "running"]]);
    const coord = makeCoordinator({ bus, states });
    for (let i = 0; i < 4; i += 1) {
      void coord.waitFor({
        terminalId: TID,
        targetState: "approval_required",
        stopOn: new Set(["done"]),
        timeoutMs: 10_000,
      });
    }
    expect(coord.pendingFor(TID)).toBe(4);
    expect(coord.wouldExceedLimits(TID)).toBe(true);
    coord.shutdown();
  });

  it("global limit: 32 concurrent waits across terminals, 33rd rejected", async () => {
    const bus = makeBus();
    const states = new Map<string, PtyState | null>();
    const coord = makeCoordinator({ bus, states });
    for (let i = 0; i < 32; i += 1) {
      const id = `00000000-0000-4000-8000-${i.toString().padStart(12, "0")}`;
      states.set(id, "running");
      void coord.waitFor({
        terminalId: id,
        targetState: "approval_required",
        stopOn: new Set(["done"]),
        timeoutMs: 10_000,
      });
    }
    expect(coord.pendingTotal()).toBe(32);
    // The coordinator, not each wait, owns the EventEmitter listeners.
    expect(bus.listenerCount("ptyStateChanged")).toBe(1);
    expect(bus.listenerCount("terminalExit")).toBe(1);
    const extra = "00000000-0000-4000-8000-000000000032";
    states.set(extra, "running");
    expect(coord.wouldExceedLimits(extra)).toBe(true);
    coord.shutdown();
  });

  it("independent waits on different terminals do not interfere", async () => {
    const bus = makeBus();
    const states = new Map<string, PtyState | null>([
      ["aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", "running"],
      ["bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", "running"],
    ]);
    const coord = makeCoordinator({ bus, states });
    const a = coord.waitFor({
      terminalId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      targetState: "approval_required",
      stopOn: new Set(["done"]),
      timeoutMs: 5000,
    });
    const b = coord.waitFor({
      terminalId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      targetState: "done",
      stopOn: new Set(["error"]),
      timeoutMs: 5000,
    });
    // Resolve A only.
    states.set("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", "approval_required");
    bus.emitState({
      terminalId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      projectId: PID,
      state: "approval_required",
      previousState: "running",
      source: "osc",
    });
    const aResult = await a;
    expect(aResult.outcome).toBe("matched");
    // B is still pending.
    expect(coord.pendingFor("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb")).toBe(1);
    states.set("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", "done");
    bus.emitState({
      terminalId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      projectId: PID,
      state: "done",
      previousState: "running",
      source: "process",
    });
    const bResult = await b;
    expect(bResult.outcome).toBe("matched");
    expect(bResult.state).toBe("done");
  });

  it("no interval polling: the timer is armed exactly once and only fires on timeout", async () => {
    const bus = makeBus();
    const states = new Map<string, PtyState | null>([[TID, "running"]]);
    const scheduled = vi.fn((cb: () => void, ms: number) => setTimeout(cb, ms));
    const cleared = vi.fn((h: NodeJS.Timeout) => clearTimeout(h));
    const coord = makeCoordinator({ bus, states, scheduleTimer: scheduled, clearTimer: cleared });
    const promise = coord.waitFor({
      terminalId: TID,
      targetState: "approval_required",
      stopOn: new Set(["done"]),
      timeoutMs: 2000,
    });
    expect(scheduled).toHaveBeenCalledTimes(1);
    // Resolve via event before the timer fires.
    states.set(TID, "approval_required");
    bus.emitState({ terminalId: TID, projectId: PID, state: "approval_required", previousState: "running", source: "osc" });
    const result = await promise;
    expect(result.outcome).toBe("matched");
    // Timer was cleared on resolve (no leak).
    expect(cleared).toHaveBeenCalledTimes(1);
  });

  it("cleanup on timeout: fixed listeners remain and pending map is emptied", async () => {
    const bus = makeBus();
    const states = new Map<string, PtyState | null>([[TID, "running"]]);
    const coord = makeCoordinator({ bus, states });
    const promise = coord.waitFor({
      terminalId: TID,
      targetState: "approval_required",
      stopOn: new Set(["done"]),
      timeoutMs: 1000,
    });
    expect(coord.pendingFor(TID)).toBe(1);
    vi.advanceTimersByTime(1001);
    await promise;
    expect(coord.pendingFor(TID)).toBe(0);
    expect(bus.listenerCount("ptyStateChanged")).toBe(1);
    expect(bus.listenerCount("terminalExit")).toBe(1);
    // A late event must not throw or revive the completed wait.
    expect(() =>
      bus.emitState({ terminalId: TID, projectId: PID, state: "approval_required", previousState: "running", source: "osc" }),
    ).not.toThrow();
  });

  it("exports the HTTP timeout contract in seconds", () => {
    expect(WAIT_DEFAULT_TIMEOUT_SECONDS).toBe(60);
    expect(WAIT_MIN_TIMEOUT_SECONDS).toBe(1);
    expect(WAIT_MAX_TIMEOUT_SECONDS).toBe(300);
  });

  // --- issue #61: content-marker match ---

  it("match: resolves 'match' with line/offset when new output hits the regex", async () => {
    const bus = makeBus();
    const states = new Map<string, PtyState | null>([[TID, "running"]]);
    const coord = makeCoordinator({ bus, states });
    const promise = coord.waitFor({
      terminalId: TID,
      stopOn: new Set(["error"]),
      timeoutMs: 10_000,
      match: /^DONE\b/m,
    });
    expect(coord.pendingFor(TID)).toBe(1);
    bus.emitData(TID, "working...\r\n");
    bus.emitData(TID, "DONE ok.md written\r\n");
    const result = await promise;
    expect(result).toMatchObject({ outcome: "match", targetState: null, state: "running" });
    expect(result.match).toEqual({ line: "DONE ok.md written", offset: 12 });
    expect(coord.pendingFor(TID)).toBe(0);
  });

  it("match: only new output is scanned — existing scrollback is not consulted", async () => {
    const bus = makeBus();
    const states = new Map<string, PtyState | null>([[TID, "running"]]);
    const coord = makeCoordinator({ bus, states });
    const promise = coord.waitFor({
      terminalId: TID,
      stopOn: new Set(["error"]),
      timeoutMs: 2000,
      match: /^DONE\b/m,
    });
    // No data event ever arrives: the wait times out instead of matching.
    vi.advanceTimersByTime(2001);
    expect((await promise).outcome).toBe("timeout");
  });

  it("match: combines with state/stopOn — the first condition to fire wins", async () => {
    const bus = makeBus();
    const states = new Map<string, PtyState | null>([[TID, "running"]]);
    const coord = makeCoordinator({ bus, states });
    const a = coord.waitFor({
      terminalId: TID,
      targetState: "done",
      stopOn: new Set(["error"]),
      timeoutMs: 10_000,
      match: /^DONE\b/m,
    });
    // Regex wins when it hits first.
    bus.emitData(TID, "DONE\r\n");
    expect((await a).outcome).toBe("match");

    // A stop state wins when it fires first.
    const b = coord.waitFor({
      terminalId: TID,
      targetState: "done",
      stopOn: new Set(["error"]),
      timeoutMs: 10_000,
      match: /^DONE\b/m,
    });
    states.set(TID, "error");
    bus.emitState({ terminalId: TID, projectId: PID, state: "error", previousState: "running", source: "process" });
    expect((await b).outcome).toBe("interrupted");
  });

  it("match: a replace event rebuilds the scan buffer", async () => {
    const bus = makeBus();
    const states = new Map<string, PtyState | null>([[TID, "running"]]);
    const coord = makeCoordinator({ bus, states });
    const promise = coord.waitFor({
      terminalId: TID,
      stopOn: new Set(["error"]),
      timeoutMs: 10_000,
      match: /AB/,
    });
    bus.emitData(TID, "A");
    bus.emitData(TID, "B", { replace: true });
    // The replaced buffer holds only "B" — "AB" across the old chunk is gone.
    expect(coord.pendingFor(TID)).toBe(1);
    bus.emitData(TID, "AB");
    const result = await promise;
    expect(result.outcome).toBe("match");
    expect(result.match).toEqual({ line: "BAB", offset: 1 });
  });

  // --- issue #61: staleness detection ---

  it("stale: resolves 'stale' after staleAfterMs without scrollback growth", async () => {
    const bus = makeBus();
    const states = new Map<string, PtyState | null>([[TID, "running"]]);
    const coord = makeCoordinator({ bus, states });
    const promise = coord.waitFor({
      terminalId: TID,
      stopOn: new Set(["error"]),
      timeoutMs: 60_000,
      staleAfterMs: 5000,
    });
    vi.advanceTimersByTime(5001);
    const result = await promise;
    expect(result).toMatchObject({ outcome: "stale", targetState: null, state: "running" });
    expect(coord.pendingFor(TID)).toBe(0);
  });

  it("stale: scrollback growth re-arms the stale clock", async () => {
    const bus = makeBus();
    const states = new Map<string, PtyState | null>([[TID, "running"]]);
    const coord = makeCoordinator({ bus, states });
    const promise = coord.waitFor({
      terminalId: TID,
      stopOn: new Set(["error"]),
      timeoutMs: 60_000,
      staleAfterMs: 5000,
    });
    vi.advanceTimersByTime(4000);
    bus.emitData(TID, "more output");
    vi.advanceTimersByTime(4000);
    // 8s elapsed but only 4s since the last growth — still pending.
    expect(coord.pendingFor(TID)).toBe(1);
    vi.advanceTimersByTime(1001);
    expect((await promise).outcome).toBe("stale");
  });

  it("stale: combines with state — a state match before the deadline wins", async () => {
    const bus = makeBus();
    const states = new Map<string, PtyState | null>([[TID, "running"]]);
    const coord = makeCoordinator({ bus, states });
    const promise = coord.waitFor({
      terminalId: TID,
      targetState: "done",
      stopOn: new Set(["error"]),
      timeoutMs: 60_000,
      staleAfterMs: 5000,
    });
    states.set(TID, "done");
    bus.emitState({ terminalId: TID, projectId: PID, state: "done", previousState: "running", source: "osc" });
    expect((await promise).outcome).toBe("matched");
  });

  it("shutdown removes the terminalData listener too", () => {
    const bus = makeBus();
    const states = new Map<string, PtyState | null>([[TID, "running"]]);
    const coord = makeCoordinator({ bus, states });
    expect(bus.listenerCount("terminalData")).toBe(1);
    coord.shutdown();
    expect(bus.listenerCount("terminalData")).toBe(0);
  });
});
