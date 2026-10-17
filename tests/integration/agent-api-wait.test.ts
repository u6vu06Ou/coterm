// Integration tests for the Agent API session wait endpoint (issue #4).
// Drives the real HTTP server with a wired SessionWaitCoordinator and a fake
// event bus. The coordinator's timer is injected so we can control timeouts
// without freezing Node's real I/O timers (which fetch needs).

import { afterEach, describe, expect, it } from "vitest";
import { EventEmitter } from "node:events";
import { startWebServer, type RunningWebServer } from "../../src/main/web/web-server";
import { SessionWaitCoordinator } from "../../src/main/core/session-wait-coordinator";
import type { AppEventBus } from "../../src/main/core/event-bus";
import type { PtyState, PtyStateChanged, TerminalInfo } from "../../src/shared/types";

const TID = "11111111-1111-4111-8111-111111111111";
const PID = "22222222-2222-4222-8222-222222222222";

function makeBus() {
  const bus = new EventEmitter();
  return {
    bus: bus as unknown as AppEventBus,
    listenerCount: (event: string) => bus.listenerCount(event),
    emitState: (change: PtyStateChanged) => bus.emit("ptyStateChanged", change),
    emitExit: (terminalId: string, projectId: string, exitCode: number) =>
      bus.emit("terminalExit", { terminalId, projectId, exitCode }),
    emitData: (terminalId: string, data: string, opts: { replace?: boolean } = {}) =>
      bus.emit("terminalData", { terminalId, projectId: PID, data, revision: 1, ...opts }),
  };
}

function makeTerminal(overrides: Partial<TerminalInfo> = {}): TerminalInfo {
  return {
    id: TID,
    projectId: PID,
    profile: "pwsh",
    title: "Agent",
    cwd: "D:\\Coterm",
    cols: 100,
    rows: 28,
    status: "running",
    startedAt: "2026-07-20T00:00:00.000Z",
    closedAt: null,
    lastExitCode: null,
    isAgent: true,
    agentProfile: "claude-local-main",
    ownedByAgentApi: true,
    pid: 0,
    nativeSessionId: null,
    worktreeId: null,
    contextUsage: null,
    ...overrides,
  };
}

/** A controllable injected timer for the coordinator. Fires only when ticked. */
class FakeTimerHandle {
  fired = false;
  constructor(public cb: () => void, public ms: number) {}
}
class FakeTimerScheduler {
  readonly handles: FakeTimerHandle[] = [];
  scheduleTimer = (cb: () => void, ms: number): NodeJS.Timeout => {
    const handle = new FakeTimerHandle(cb, ms);
    this.handles.push(handle);
    return handle as unknown as NodeJS.Timeout;
  };
  clearTimer = (handle: NodeJS.Timeout): void => {
    const idx = this.handles.indexOf(handle as unknown as FakeTimerHandle);
    if (idx >= 0) this.handles.splice(idx, 1);
  };
  fireOldest(): boolean {
    const handle = this.handles.shift();
    if (!handle) return false;
    handle.fired = true;
    handle.cb();
    return true;
  }
  fireMs(ms: number): boolean {
    const idx = this.handles.findIndex((h) => h.ms === ms);
    if (idx < 0) return false;
    const [handle] = this.handles.splice(idx, 1);
    handle!.fired = true;
    handle!.cb();
    return true;
  }
  count(): number {
    return this.handles.length;
  }
}

describe("Agent API session wait endpoint", () => {
  let server: RunningWebServer | undefined;
  let bus: ReturnType<typeof makeBus>;
  let coord: SessionWaitCoordinator;
  let states: Map<string, PtyState | null>;
  let scheduler: FakeTimerScheduler;
  let explanationCalls: string[];
  let layout: { tiles: Array<{ terminalId: string; projectId: string; weight: number }>; selectedTerminalId: string | null; rows: number[]; cols: number[][]; ptyCols: number; ptyRows: number };

  afterEach(async () => {
    coord?.shutdown();
    await server?.close();
    server = undefined;
  });

  async function start(overrides: { terminals?: TerminalInfo[]; state?: PtyState | null; noCoordinator?: boolean; enabled?: boolean } = {}) {
    bus = makeBus();
    const terminal = overrides.terminals ?? [makeTerminal()];
    const initialState = overrides.state ?? "running";
    states = new Map<string, PtyState | null>(terminal.map((item) => [item.id, initialState]));
    explanationCalls = [];
    scheduler = new FakeTimerScheduler();
    coord = new SessionWaitCoordinator({
      events: bus.bus,
      readState: (id) => states.get(id) ?? null,
      scheduleTimer: scheduler.scheduleTimer,
      clearTimer: scheduler.clearTimer,
    });
    layout = {
      tiles: terminal.map((t) => ({ terminalId: t.id, projectId: t.projectId, weight: 1 })),
      selectedTerminalId: terminal[0]?.id ?? null,
      rows: [1],
      cols: [terminal.map(() => 1)],
      ptyCols: 100,
      ptyRows: 28,
    };
    const enabled = overrides.enabled ?? true;
    server = await startWebServer({
      port: 0,
      allowedOrigin: "https://coterm.example.com",
      verifyAccess: () => Promise.reject(new Error("agent path should bypass access")),
      getSettings: () => ({ agentApi: { enabled, token: "secret" } }) as never,
      operations: {
        getDockLayout: () => layout,
        listTerminals: () => terminal,
        getAgentStateExplanation: (id: unknown) => {
          const terminalId = String(id);
          explanationCalls.push(terminalId);
          const state = states.get(terminalId) ?? null;
          if (state === null) return null;
          return {
            canonicalState: state,
            authoritativeSource: "osc",
            agentProfile: "claude-local-main",
            matchedRuleId: "osc.lifecycle",
            fallbackReason: null,
            evaluatedRegion: "whole_recent",
            gateSummary: null,
            manifestVersion: "test-v1",
            evaluatedAt: "2026-07-20T00:00:00.000Z",
          };
        },
      },
      ...(overrides.noCoordinator ? {} : { waitCoordinator: coord }),
    });
    return `http://127.0.0.1:${server.port}`;
  }

  function headers() {
    return { authorization: "Bearer secret" };
  }

  /** Wait on coordinator state instead of assuming a fixed HTTP scheduling delay. */
  async function waitForPending(expected: number): Promise<void> {
    const deadline = Date.now() + 5_000;
    while (coord.pendingTotal() !== expected && Date.now() < deadline) {
      await new Promise<void>((resolve) => setTimeout(resolve, 10));
    }
    expect(coord.pendingTotal()).toBe(expected);
  }

  // --- 400 validation ---

  it("returns 400 when state is missing", async () => {
    const base = await start();
    const res = await fetch(`${base}/api/v1/agent/session/${TID}/wait?timeout=60`, { headers: headers() });
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe("MISSING_STATE");
  });

  it("returns 400 when state is invalid", async () => {
    const base = await start();
    const res = await fetch(`${base}/api/v1/agent/session/${TID}/wait?state=bogus`, { headers: headers() });
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe("INVALID_STATE");
  });

  it.each(["0", "301", "1.5", "nope"])("returns 400 when timeout=%s is outside the seconds contract", async (timeout) => {
    const base = await start();
    const res = await fetch(`${base}/api/v1/agent/session/${TID}/wait?state=running&timeout=${timeout}`, { headers: headers() });
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe("INVALID_TIMEOUT");
  });

  it("returns 400 when stopOn contains an invalid state", async () => {
    const base = await start();
    const res = await fetch(`${base}/api/v1/agent/session/${TID}/wait?state=running&stopOn=done,bogus`, { headers: headers() });
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe("INVALID_STOPON");
  });

  // --- issue #61: match / staleAfterSec validation ---

  it("returns 400 when match is not a valid regular expression", async () => {
    const base = await start();
    const res = await fetch(`${base}/api/v1/agent/session/${TID}/wait?match=${encodeURIComponent("(unclosed")}`, { headers: headers() });
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe("INVALID_MATCH");
  });

  it("returns 400 when match is empty", async () => {
    const base = await start();
    const res = await fetch(`${base}/api/v1/agent/session/${TID}/wait?match=`, { headers: headers() });
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe("INVALID_MATCH");
  });

  it.each(["0", "301", "1.5", "nope"])("returns 400 when staleAfterSec=%s is outside the seconds contract", async (stale) => {
    const base = await start();
    const res = await fetch(`${base}/api/v1/agent/session/${TID}/wait?staleAfterSec=${stale}`, { headers: headers() });
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe("INVALID_STALE_AFTER");
  });

  // --- issue #61: match / stale outcomes ---

  it("resolves 'match' (no state param) when new output hits the regex", async () => {
    const base = await start({ state: "running" });
    const promise = fetch(`${base}/api/v1/agent/session/${TID}/wait?match=${encodeURIComponent("^DONE\\b")}&timeout=10`, { headers: headers() });
    await waitForPending(1);
    bus.emitData(TID, "working...\r\nDONE ok.md written\r\n");
    const res = await promise;
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.result).toMatchObject({
      outcome: "match",
      targetState: null,
      match: { line: "DONE ok.md written", offset: 12 },
    });
    expect(coord.pendingTotal()).toBe(0);
    expect(scheduler.count()).toBe(0);
  });

  it("resolves 'match' even when state is also given — first condition wins", async () => {
    const base = await start({ state: "running" });
    const promise = fetch(`${base}/api/v1/agent/session/${TID}/wait?state=done&match=${encodeURIComponent("^DONE\\b")}&timeout=10`, { headers: headers() });
    await waitForPending(1);
    bus.emitData(TID, "DONE\r\n");
    const res = await promise;
    const body = await res.json();
    expect(body.result.outcome).toBe("match");
    expect(body.result.targetState).toBe("done");
  });

  it("resolves 'stale' after staleAfterSec without scrollback growth (injected timer)", async () => {
    const base = await start({ state: "running" });
    const promise = fetch(`${base}/api/v1/agent/session/${TID}/wait?staleAfterSec=5&timeout=30`, { headers: headers() });
    await waitForPending(1);
    // Timeout timer (30s) and stale timer (5s) are both armed; fire the stale one.
    expect(scheduler.fireMs(5000)).toBe(true);
    const res = await promise;
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.result).toMatchObject({ outcome: "stale", targetState: null });
    expect(scheduler.count()).toBe(0);
  });

  it("stale clock re-arms on scrollback growth", async () => {
    const base = await start({ state: "running" });
    const promise = fetch(`${base}/api/v1/agent/session/${TID}/wait?staleAfterSec=5&timeout=30`, { headers: headers() });
    await waitForPending(1);
    // Growth re-arms: the old stale timer is replaced by a fresh one.
    bus.emitData(TID, "still working\r\n");
    expect(coord.pendingTotal()).toBe(1);
    expect(scheduler.fireMs(5000)).toBe(true);
    const res = await promise;
    expect((await res.json()).result.outcome).toBe("stale");
  });

  // --- 404 ---

  it("returns 404 when the terminal is not in the dock", async () => {
    const base = await start({ terminals: [] });
    const other = "99999999-9999-4999-8999-999999999999";
    const res = await fetch(`${base}/api/v1/agent/session/${other}/wait?state=running`, { headers: headers() });
    expect(res.status).toBe(404);
  });

  it("returns 404 when the wait coordinator is not wired", async () => {
    const base = await start({ noCoordinator: true });
    const res = await fetch(`${base}/api/v1/agent/session/${TID}/wait?state=running`, { headers: headers() });
    expect(res.status).toBe(404);
  });

  it("is hidden (404) when the agent API is disabled", async () => {
    const base = await start({ enabled: false });
    const res = await fetch(`${base}/api/v1/agent/session/${TID}/wait?state=running`, { headers: headers() });
    expect(res.status).toBe(404);
  });

  it("requires a bearer token (401 without)", async () => {
    const base = await start();
    const res = await fetch(`${base}/api/v1/agent/session/${TID}/wait?state=running`);
    expect(res.status).toBe(401);
  });

  // --- Outcomes ---

  it("fast-path resolves matched when the terminal is already in the target state", async () => {
    const base = await start({ state: "approval_required" });
    const res = await fetch(`${base}/api/v1/agent/session/${TID}/wait?state=approval_required&timeout=60`, { headers: headers() });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.result).toMatchObject({
      sessionId: TID,
      targetState: "approval_required",
      state: "approval_required",
      outcome: "matched",
      explanation: {
        canonicalState: "approval_required",
        authoritativeSource: "osc",
      },
    });
    expect(body.result.observedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(explanationCalls).toEqual([TID]);
  });

  it("resolves matched when a ptyStateChanged event fires the target (explicit stopOn)", async () => {
    const base = await start({ state: "running" });
    // stopOn excludes "running" so the wait actually waits.
    const promise = fetch(`${base}/api/v1/agent/session/${TID}/wait?state=approval_required&stopOn=done,error&timeout=5`, { headers: headers() });
    await waitForPending(1);
    expect(coord.pendingTotal()).toBe(1);
    states.set(TID, "approval_required");
    bus.emitState({ terminalId: TID, projectId: PID, state: "approval_required", previousState: "running", source: "osc" });
    const res = await promise;
    expect(res.status).toBe(200);
    expect((await res.json()).result.outcome).toBe("matched");
    expect(scheduler.count()).toBe(0);
  });

  it("resolves timeout when no event fires (injected timer)", async () => {
    const base = await start({ state: "running" });
    const promise = fetch(`${base}/api/v1/agent/session/${TID}/wait?state=approval_required&stopOn=done,error&timeout=1`, { headers: headers() });
    await waitForPending(1);
    expect(scheduler.count()).toBe(1);
    expect(scheduler.handles[0]?.ms).toBe(1000);
    scheduler.fireOldest();
    const res = await promise;
    expect(res.status).toBe(200);
    expect((await res.json()).result.outcome).toBe("timeout");
  });

  it("resolves closed when terminalExit fires", async () => {
    const base = await start({ state: "running" });
    const promise = fetch(`${base}/api/v1/agent/session/${TID}/wait?state=approval_required&stopOn=done,error&timeout=5`, { headers: headers() });
    await waitForPending(1);
    states.set(TID, null);
    bus.emitExit(TID, PID, 0);
    const res = await promise;
    expect(res.status).toBe(200);
    expect((await res.json()).result.outcome).toBe("closed");
    expect(scheduler.count()).toBe(0);
  });

  it("resolves interrupted when the HTTP connection is aborted (caller cancel)", async () => {
    const base = await start({ state: "running" });
    const controller = new AbortController();
    const promise = fetch(`${base}/api/v1/agent/session/${TID}/wait?state=approval_required&stopOn=done,error&timeout=5`, {
      headers: headers(),
      signal: controller.signal,
    });
    await waitForPending(1);
    controller.abort();
    await expect(promise).rejects.toThrow();
    // The request "close" event fires asynchronously after the abort.
    await waitForPending(0);
    expect(coord.pendingTotal()).toBe(0);
    expect(scheduler.count()).toBe(0);
  });

  it("default stopOn interrupts only the four attention states and excludes target", async () => {
    const base = await start({ state: "running" });
    const pending = fetch(`${base}/api/v1/agent/session/${TID}/wait?state=done&timeout=5`, { headers: headers() });
    await waitForPending(1);
    expect(coord.pendingTotal()).toBe(1);
    states.set(TID, "waiting_input");
    bus.emitState({ terminalId: TID, projectId: PID, state: "waiting_input", previousState: "running", source: "osc" });
    const res = await pending;
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.result.outcome).toBe("interrupted");
    expect(body.result.state).toBe("waiting_input");
  });

  it("default stopOn removes the target state instead of interrupting it", async () => {
    const base = await start({ state: "running" });
    const pending = fetch(`${base}/api/v1/agent/session/${TID}/wait?state=approval_required&timeout=5`, { headers: headers() });
    await waitForPending(1);
    states.set(TID, "approval_required");
    bus.emitState({ terminalId: TID, projectId: PID, state: "approval_required", previousState: "running", source: "osc" });
    const res = await pending;
    expect((await res.json()).result.outcome).toBe("matched");
  });

  it("uses the 60 second default when timeout is omitted", async () => {
    const base = await start({ state: "running" });
    const pending = fetch(`${base}/api/v1/agent/session/${TID}/wait?state=done&stopOn=error`, { headers: headers() });
    await waitForPending(1);
    expect(scheduler.handles[0]?.ms).toBe(60_000);
    coord.shutdown();
    expect((await (await pending).json()).result.outcome).toBe("shutdown");
  });

  it("explicit stopOn overrides the default: non-stopOn state does not interrupt", async () => {
    const base = await start({ state: "running" });
    // stopOn=error only: entering "done" should NOT interrupt.
    const promise = fetch(`${base}/api/v1/agent/session/${TID}/wait?state=approval_required&stopOn=error&timeout=5`, { headers: headers() });
    await waitForPending(1);
    states.set(TID, "done");
    bus.emitState({ terminalId: TID, projectId: PID, state: "done", previousState: "running", source: "process" });
    // Still pending — fire the injected timeout.
    scheduler.fireOldest();
    const res = await promise;
    expect((await res.json()).result.outcome).toBe("timeout");
  });

  // --- 429 limits ---

  it("returns 429 when per-session limit (4) is exceeded", async () => {
    const base = await start({ state: "running" });
    const pending: Promise<Response>[] = [];
    for (let i = 0; i < 4; i += 1) {
      pending.push(fetch(`${base}/api/v1/agent/session/${TID}/wait?state=approval_required&stopOn=done,error&timeout=10`, { headers: headers() }));
    }
    await waitForPending(4);
    const fifth = await fetch(`${base}/api/v1/agent/session/${TID}/wait?state=approval_required&stopOn=done,error&timeout=10`, { headers: headers() });
    expect(fifth.status).toBe(429);
    const body = await fifth.json();
    expect(body.error.code).toBe("WAIT_LIMIT_EXCEEDED");
    expect(body.limits.perSessionMax).toBe(4);
    expect(body.limits.globalMax).toBe(32);
    coord.shutdown();
    for (const p of pending) await p.catch(() => undefined);
  });

  it("returns 429 when the global limit (32) is exceeded", async () => {
    const terminals: TerminalInfo[] = [];
    for (let i = 0; i < 33; i += 1) {
      terminals.push(makeTerminal({ id: `00000000-0000-4000-8000-${i.toString().padStart(12, "0")}` }));
    }
    const base = await start({ terminals, state: "running" });
    const pending: Promise<Response>[] = [];
    for (let i = 0; i < 32; i += 1) {
      const id = terminals[i]!.id;
      pending.push(fetch(`${base}/api/v1/agent/session/${id}/wait?state=approval_required&stopOn=done,error&timeout=10`, { headers: headers() }));
    }
    await waitForPending(32);
    expect(bus.listenerCount("ptyStateChanged")).toBe(1);
    expect(bus.listenerCount("terminalExit")).toBe(1);
    const extra = terminals[32]!.id;
    const res = await fetch(`${base}/api/v1/agent/session/${extra}/wait?state=approval_required&stopOn=done,error&timeout=10`, { headers: headers() });
    expect(res.status).toBe(429);
    expect((await res.json()).error.code).toBe("WAIT_LIMIT_EXCEEDED");
    coord.shutdown();
    expect(bus.listenerCount("ptyStateChanged")).toBe(0);
    expect(bus.listenerCount("terminalExit")).toBe(0);
    for (const p of pending) await p.catch(() => undefined);
  });

  it("resolves existing waits on shutdown and rejects new waits with 503", async () => {
    const base = await start({ state: "running" });
    const pending = fetch(`${base}/api/v1/agent/session/${TID}/wait?state=done&stopOn=error&timeout=10`, { headers: headers() });
    await waitForPending(1);
    expect(coord.pendingTotal()).toBe(1);
    coord.shutdown();
    const first = await pending;
    expect(first.status).toBe(200);
    expect((await first.json()).result.outcome).toBe("shutdown");
    expect(coord.pendingTotal()).toBe(0);
    expect(scheduler.count()).toBe(0);

    const next = await fetch(`${base}/api/v1/agent/session/${TID}/wait?state=done`, { headers: headers() });
    expect(next.status).toBe(503);
    expect((await next.json()).error.code).toBe("WAIT_SHUTDOWN");
  });

  // --- Leaks ---

  it("no listener leak: pending count returns to 0 after a matched resolution", async () => {
    const base = await start({ state: "running" });
    const promise = fetch(`${base}/api/v1/agent/session/${TID}/wait?state=approval_required&stopOn=done,error&timeout=5`, { headers: headers() });
    await waitForPending(1);
    expect(coord.pendingTotal()).toBe(1);
    states.set(TID, "approval_required");
    bus.emitState({ terminalId: TID, projectId: PID, state: "approval_required", previousState: "running", source: "osc" });
    await promise;
    expect(coord.pendingTotal()).toBe(0);
    expect(scheduler.count()).toBe(0);
    expect(bus.listenerCount("ptyStateChanged")).toBe(1);
    expect(bus.listenerCount("terminalExit")).toBe(1);
  });

  it("no listener leak: pending count returns to 0 after timeout", async () => {
    const base = await start({ state: "running" });
    const promise = fetch(`${base}/api/v1/agent/session/${TID}/wait?state=approval_required&stopOn=done,error&timeout=1`, { headers: headers() });
    await waitForPending(1);
    expect(coord.pendingTotal()).toBe(1);
    scheduler.fireOldest();
    await promise;
    expect(coord.pendingTotal()).toBe(0);
    expect(scheduler.count()).toBe(0);
    expect(bus.listenerCount("ptyStateChanged")).toBe(1);
    expect(bus.listenerCount("terminalExit")).toBe(1);
    // A late event must not throw.
    expect(() =>
      bus.emitState({ terminalId: TID, projectId: PID, state: "approval_required", previousState: "running", source: "osc" }),
    ).not.toThrow();
  });

  it("independent waits on different terminals do not interfere", async () => {
    const tA = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const tB = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    const terminals = [makeTerminal({ id: tA }), makeTerminal({ id: tB })];
    const base = await start({ terminals, state: "running" });
    const promiseA = fetch(`${base}/api/v1/agent/session/${tA}/wait?state=approval_required&stopOn=done,error&timeout=5`, { headers: headers() });
    const promiseB = fetch(`${base}/api/v1/agent/session/${tB}/wait?state=done&stopOn=error&timeout=5`, { headers: headers() });
    await waitForPending(2);
    // Resolve A only.
    states.set(tA, "approval_required");
    bus.emitState({ terminalId: tA, projectId: PID, state: "approval_required", previousState: "running", source: "osc" });
    const aRes = await promiseA;
    expect((await aRes.json()).result.outcome).toBe("matched");
    // B still pending.
    expect(coord.pendingFor(tB)).toBe(1);
    states.set(tB, "done");
    bus.emitState({ terminalId: tB, projectId: PID, state: "done", previousState: "running", source: "process" });
    const bRes = await promiseB;
    expect((await bRes.json()).result.outcome).toBe("matched");
  });
});
