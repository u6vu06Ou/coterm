// Phase 3 (§8): AgentApiStateService — event-driven, metadata-only world state
// + deterministic fast intents. Proves:
//   - updates arrive via events (no polling; the module has no timers besides
//     the burst-coalescing setTimeout, asserted via fake timers)
//   - derived display states follow the §8.1 table (incl. done→idle threshold)
//   - attention ordering is approval_required → waiting_input → error → blocked
//   - fast intents answer from the snapshot only (no transcript/LLM deps)
//   - event bursts coalesce but the last state always wins
//   - 8-pane rollup p95 < 100 ms
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { performance } from "node:perf_hooks";
import { AppEventBus } from "../../src/main/core/event-bus";
import type { PtyState, PtyStateChanged, DockLayout, AttentionNotification } from "../../src/shared/types";
import {
  AgentApiStateService,
  classifyAgentApiFastIntent,
  type AgentApiTerminalSource,
  type AgentApiAttentionSource,
  type AgentApiDockSource,
  type AgentApiProjectSource,
} from "../../src/main/core/agentapi-state-service";

const PROJECT = "69bf5cf4-f48a-46d8-8c65-a77f049e07e8";
const startedAt = new Date("2026-08-04T00:00:00.000Z").toISOString();

interface FakeTerminal {
  id: string;
  state: PtyState;
  title: string;
  mode: "normal" | "alternate-screen";
  source: PtyStateChanged["source"];
}

function makeSource(terminals: FakeTerminal[]): AgentApiTerminalSource {
  return {
    dashboardSnapshot: () =>
      terminals.map((t) => ({
        info: {
          id: t.id,
          projectId: PROJECT,
          title: t.title,
          status: "running" as const,
          agentProfile: "codex-local-big",
          startedAt,
        },
        ptyState: t.state,
      })),
    getPtyStateSource: (id) => terminals.find((t) => t.id === id)?.source ?? null,
    getScrollbackMode: (id) => terminals.find((t) => t.id === id)?.mode ?? null,
  };
}

function makeAttention(initial: AttentionNotification[] = []) {
  let notifications = [...initial];
  const listeners = new Set<(n: AttentionNotification) => void>();
  const source: AgentApiAttentionSource = {
    list: () => notifications.filter((n) => !n.resolvedAt),
    onAttentionChanged: (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
  };
  return {
    source,
    file(notification: AttentionNotification) {
      notifications.push(notification);
      listeners.forEach((listener) => listener(notification));
    },
    resolve(id: string) {
      const target = notifications.find((n) => n.id === id);
      if (target) {
        notifications = notifications.filter((n) => n.id !== id);
        listeners.forEach((listener) => listener({ ...target, resolvedAt: new Date().toISOString() }));
      }
    },
  };
}

function makeDock(selectedTerminalId: string | null, tileIds: string[] = []) {
  const listeners = new Set<(layout: DockLayout) => void>();
  let currentTiles = tileIds.length ? tileIds : ["t1"];
  const layout = (): DockLayout => ({
    tiles: currentTiles.map((terminalId) => ({
      terminalId,
      projectId: PROJECT,
      weight: 1,
      agentProfile: null,
    })),
    selectedTerminalId,
    exclusiveTerminalId: null,
    rows: [1],
    cols: [[1]],
    ptyCols: 100,
    ptyRows: 28,
  });
  const source: AgentApiDockSource = {
    getDockLayout: async () => layout(),
    onLayoutChanged: (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
  };
  return {
    source,
    emit(nextSelected: string | null, nextTiles?: string[]) {
      selectedTerminalId = nextSelected;
      if (nextTiles) currentTiles = nextTiles;
      listeners.forEach((listener) => listener(layout()));
    },
  };
}

const projects: AgentApiProjectSource = {
  listProjects: () => [{ id: PROJECT, name: "coterm" }],
};

function stateEvent(terminalId: string, state: PtyState, source: PtyStateChanged["source"] = "osc"): PtyStateChanged {
  return { terminalId, projectId: PROJECT, state, previousState: null, source };
}

function attentionNotification(terminalId: string, id: string): AttentionNotification {
  return {
    id,
    terminalId,
    projectId: PROJECT,
    state: "approval_required",
    source: "osc",
    createdAt: new Date().toISOString(),
    resolvedAt: null,
  } as AttentionNotification;
}

describe("AgentApiStateService (Phase 3)", () => {
  let nowMs: number;
  let events: AppEventBus;

  beforeEach(() => {
    nowMs = Date.parse("2026-08-04T01:00:00.000Z");
    events = new AppEventBus();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  async function boot(terminals: FakeTerminal[], opts: { attention?: AttentionNotification[]; selected?: string | null; tiles?: string[]; idleMs?: number } = {}) {
    const attention = makeAttention(opts.attention ?? []);
    const dock = makeDock(opts.selected ?? null, opts.tiles ?? terminals.map((t) => t.id));
    const service = new AgentApiStateService({
      events,
      terminals: makeSource(terminals),
      attention: attention.source,
      dock: dock.source,
      projects,
      now: () => nowMs,
      ...(opts.idleMs !== undefined ? { idleThresholdMs: opts.idleMs } : {}),
    });
    await service.start();
    return { service, attention, dock };
  }

  it("builds metadata-only world state rows for every session", async () => {
    const { service } = await boot([
      { id: "t1", state: "running", title: "codex-local-big", mode: "normal", source: "osc" },
      { id: "t2", state: "approval_required", title: "claude-local-main", mode: "alternate-screen", source: "broker" },
    ], { selected: "t2" });
    const world = service.getWorldState();
    expect(world).toHaveLength(2);
    const t2 = world.find((session) => session.terminalId === "t2")!;
    expect(t2).toMatchObject({
      projectId: PROJECT,
      projectLabel: "coterm",
      displayName: "claude-local-main",
      canonicalState: "approval_required",
      displayState: "approval",
      lifecycleStatus: "running",
      source: "broker",
      selected: true,
      scrollbackMode: "alternate-screen",
    });
    // No `focused` key exists (retry contract): it must never come back as a
    // fabricated alias of `selected` — see AgentApiSessionWorldState docs.
    expect("focused" in t2).toBe(false);
    expect(typeof t2.ageMs).toBe("number");
    // Metadata-only shape: no scrollback/transcript-ish fields exist.
    for (const key of Object.keys(t2)) {
      expect(key).not.toMatch(/scrollback$|transcript|content|command|text/i);
    }
  });

  it("follows ptyStateChanged events synchronously (event-driven, no polling)", async () => {
    const { service } = await boot([{ id: "t1", state: "starting", title: "s", mode: "normal", source: "process" }]);
    expect(service.getWorldState()[0]!.displayState).toBe("starting");
    events.emit("ptyStateChanged", stateEvent("t1", "running"));
    expect(service.getWorldState()[0]!.displayState).toBe("running");
    events.emit("ptyStateChanged", stateEvent("t1", "waiting_input", "broker"));
    const row = service.getWorldState()[0]!;
    expect(row.displayState).toBe("waiting-input");
    expect(row.source).toBe("broker");
    expect(row.ageMs).toBe(0);
    nowMs += 5_000;
    expect(service.getWorldState()[0]!.ageMs).toBe(5_000);
  });

  it("derives done → idle past the threshold, and lifecycle exit → exited", async () => {
    const { service } = await boot([{ id: "t1", state: "running", title: "s", mode: "normal", source: "osc" }], { idleMs: 60_000 });
    events.emit("ptyStateChanged", stateEvent("t1", "done"));
    expect(service.getWorldState()[0]!.displayState).toBe("done");
    nowMs += 61_000;
    expect(service.getWorldState()[0]!.displayState).toBe("idle");
    events.emit("terminalExit", { terminalId: "t1", projectId: PROJECT, exitCode: 0 });
    const row = service.getWorldState()[0]!;
    expect(row.displayState).toBe("exited");
    expect(row.lifecycleStatus).toBe("exited");
  });

  it("drops the attention id when the notification resolves", async () => {
    const { service, attention } = await boot([
      { id: "t1", state: "approval_required", title: "s", mode: "normal", source: "osc" },
    ]);
    attention.file(attentionNotification("t1", "n1"));
    expect(service.getWorldState()[0]!.attentionNotificationId).toBe("n1");
    attention.resolve("n1");
    expect(service.getWorldState()[0]!.attentionNotificationId).toBeNull();
  });

  it("refreshes selection from dock layout events", async () => {
    const { service, dock } = await boot([
      { id: "t1", state: "running", title: "a", mode: "normal", source: "osc" },
      { id: "t2", state: "running", title: "b", mode: "normal", source: "osc" },
    ], { selected: "t1" });
    expect(service.getWorldState().find((s) => s.terminalId === "t1")!.selected).toBe(true);
    dock.emit("t2");
    expect(service.getWorldState().find((s) => s.terminalId === "t2")!.selected).toBe(true);
    expect(service.getWorldState().find((s) => s.terminalId === "t1")!.selected).toBe(false);
  });

  it("§8.2 attention order is approval → waiting → error → blocked", async () => {
    const { service } = await boot([
      { id: "t-blocked", state: "blocked", title: "B", mode: "normal", source: "osc" },
      { id: "t-error", state: "error", title: "E", mode: "normal", source: "osc" },
      { id: "t-waiting", state: "waiting_input", title: "W", mode: "normal", source: "osc" },
      { id: "t-approval", state: "approval_required", title: "A", mode: "normal", source: "osc" },
      { id: "t-running", state: "running", title: "R", mode: "normal", source: "osc" },
    ], { tiles: ["t-blocked", "t-error", "t-waiting", "t-approval", "t-running"] });
    expect(service.attentionOrdered().map((s) => s.terminalId)).toEqual([
      "t-approval",
      "t-waiting",
      "t-error",
      "t-blocked",
    ]);
  });

  it("coalesces event bursts but never drops the final state", async () => {
    vi.useFakeTimers();
    const { service } = await boot([{ id: "t1", state: "starting", title: "s", mode: "normal", source: "process" }]);
    const snapshots: string[] = [];
    service.onWorldChanged((world) => snapshots.push(world.map((s) => s.canonicalState).join(",")));
    for (let i = 0; i < 50; i++) {
      events.emit("ptyStateChanged", stateEvent("t1", "running", "osc"));
    }
    events.emit("ptyStateChanged", stateEvent("t1", "done", "osc"));
    // Synchronous state is always the latest, mid-burst.
    expect(service.getWorldState()[0]!.canonicalState).toBe("done");
    vi.advanceTimersByTime(20);
    expect(snapshots.length).toBeGreaterThan(0);
    expect(snapshots.length).toBeLessThan(10);
    expect(snapshots[snapshots.length - 1]).toBe("done");
    service.dispose();
  });

  it("classifies the four §8.2 fast intents and answers without any transcript", async () => {
    expect(classifyAgentApiFastIntent("現在哪個視窗需要我")).toBe("needs-attention");
    expect(classifyAgentApiFastIntent("Which window needs me?")).toBe("needs-attention");
    expect(classifyAgentApiFastIntent("哪個視窗在跑什麼狀態")).toBe("status-overview");
    expect(classifyAgentApiFastIntent("有沒有錯誤或阻塞的視窗")).toBe("has-issue");
    expect(classifyAgentApiFastIntent("有沒有待批准的視窗")).toBe("has-issue");
    expect(classifyAgentApiFastIntent("現在有幾個在運行")).toBe("running-count");
    expect(classifyAgentApiFastIntent("幫我把這段話翻譯成英文")).toBeNull();
    expect(classifyAgentApiFastIntent("")).toBeNull();

    const { service } = await boot([
      { id: "t1", state: "running", title: "codex-local-big", mode: "normal", source: "osc" },
      { id: "t2", state: "approval_required", title: "claude-local-main", mode: "normal", source: "broker" },
    ]);
    expect(service.answerFastIntent("running-count")).toBe("目前有 1 個視窗在運行。");
    const attention = service.answerFastIntent("needs-attention");
    expect(attention).toContain("1 個視窗需要您處理");
    expect(attention).toContain("claude-local-main");
    expect(attention).toContain("待批准");
    const overview = service.answerFastIntent("status-overview");
    expect(overview).toContain("codex-local-big");
    expect(overview).toContain("運行中");
    // No-issue answer for a clean world.
    const clean = service.answerFastIntent("has-issue");
    expect(clean).toContain("1 個視窗需要您處理"); // approval_required counts as an issue
  });

  it("answers in en-US when requested", async () => {
    const { service } = await boot([{ id: "t1", state: "running", title: "s", mode: "normal", source: "osc" }]);
    expect(service.answerFastIntent("running-count", "en-US")).toBe("1 window(s) running.");
    expect(service.answerFastIntent("needs-attention", "en-US")).toBe("Nothing needs your attention right now.");
  });

  it("8-pane rollup p95 stays under 100 ms", async () => {
    const terminals: FakeTerminal[] = Array.from({ length: 8 }, (_, i) => ({
      id: `pane-${i}`,
      state: (["running", "waiting_input", "approval_required", "blocked", "error", "done", "starting", "running"] as const)[i]!,
      title: `pane-title-${i}`,
      mode: i % 2 === 0 ? "normal" : "alternate-screen",
      source: "osc" as const,
    }));
    const { service } = await boot(terminals, {
      tiles: terminals.map((t) => t.id),
      attention: [
        attentionNotification("pane-1", "n1"),
        attentionNotification("pane-2", "n2"),
      ],
      selected: "pane-3",
    });
    const samples: number[] = [];
    for (let i = 0; i < 200; i++) {
      const start = performance.now();
      service.getWorldState();
      service.attentionOrdered();
      service.answerFastIntent("status-overview");
      samples.push(performance.now() - start);
    }
    samples.sort((a, b) => a - b);
    const p95 = samples[Math.floor(samples.length * 0.95)]!;
    expect(p95).toBeLessThan(100);
    expect(service.getWorldState()).toHaveLength(8);
    expect(service.getWorldState().filter((s) => s.attentionNotificationId)).toHaveLength(2);
  });

  it("prunes exited sessions that lost their dock tile; keeps visible exited panes", async () => {
    const terminal: FakeTerminal = { id: "t1", state: "running", title: "s", mode: "normal", source: "osc" };
    const liveTerminals: FakeTerminal[] = [terminal];
    const source = makeSource(liveTerminals);
    const attention = makeAttention();
    const dock = makeDock("t1", ["t1"]);
    const service = new AgentApiStateService({
      events,
      terminals: source,
      attention: attention.source,
      dock: dock.source,
      projects,
      now: () => nowMs,
    });
    await service.start();
    events.emit("terminalExit", { terminalId: "t1", projectId: PROJECT, exitCode: 1 });
    // PtyManager deletes exited terminals from its dashboard snapshot.
    liveTerminals.splice(0, liveTerminals.length);
    // Still has a tile → the exited marker stays visible.
    expect(service.getWorldState()[0]!.displayState).toBe("exited");
    // Tile closed: terminalListChanged resync drops the dead entry.
    dock.emit(null, []);
    events.emit("terminalListChanged", { projectId: PROJECT });
    expect(service.getWorldState()).toHaveLength(0);
    service.dispose();
  });
});
