import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { DockLayoutManager, type DockRestoredPane } from "../../src/main/core/dock-layout";
import {
  buildDockSessionSnapshot,
  parseDockSessionSnapshot,
  SessionRestoreService,
  type PaneSessionQuery,
  type ResolvedPaneSession,
} from "../../src/main/core/session-restore";
import { AppEventBus } from "../../src/main/core/event-bus";
import { sessionIdFromFile } from "../../src/main/terminal/session-file-resolver";
import { DEFAULT_PROFILES } from "../../src/main/providers/profiles-config";
import type { DockLayout, Project, TerminalInfo } from "../../src/shared/types";

function pane(overrides: Partial<DockRestoredPane> = {}): DockRestoredPane {
  return {
    projectId: "p1",
    cwd: "D:\\ws",
    profile: "pwsh",
    isAgent: false,
    agentProfile: null,
    nativeSessionId: null,
    worktreeId: null,
    label: null,
    ...overrides,
  };
}

function dockLayout(overrides: Partial<DockLayout> = {}): DockLayout {
  return {
    tiles: [
      { terminalId: "t0", projectId: "p1", weight: 1, agentProfile: null, label: null },
      { terminalId: "t1", projectId: "p1", weight: 1, agentProfile: "claude-local-main", label: null },
      { terminalId: "t2", projectId: "p1", weight: 1, agentProfile: null, label: null },
    ],
    selectedTerminalId: "t1",
    exclusiveTerminalId: null,
    rows: [1],
    cols: [[1 / 3, 1 / 3, 1 / 3]],
    ptyCols: 100,
    ptyRows: 28,
    ...overrides,
  };
}

describe("buildDockSessionSnapshot", () => {
  it("maps tiles to panes in order and keeps the selection index", () => {
    const snapshot = buildDockSessionSnapshot(dockLayout(), (terminalId) =>
      pane({ cwd: `cwd-${terminalId}` }));
    expect(snapshot.panes.map((p) => p.cwd)).toEqual(["cwd-t0", "cwd-t1", "cwd-t2"]);
    expect(snapshot.selectedIndex).toBe(1);
    expect(snapshot.version).toBe(1);
    expect(snapshot.rows).toEqual([1]);
    expect(snapshot.cols).toEqual([[1 / 3, 1 / 3, 1 / 3]]);
  });

  it("drops tiles the resolver cannot describe and reindexes the selection", () => {
    const snapshot = buildDockSessionSnapshot(dockLayout(), (terminalId) =>
      terminalId === "t0" ? null : pane({ cwd: `cwd-${terminalId}` }));
    expect(snapshot.panes.map((p) => p.cwd)).toEqual(["cwd-t1", "cwd-t2"]);
    // t1 was tile index 1, now snapshot index 0.
    expect(snapshot.selectedIndex).toBe(0);
  });

  it("records null selection when the selected terminal is gone", () => {
    const snapshot = buildDockSessionSnapshot(dockLayout(), (terminalId) =>
      terminalId === "t1" ? null : pane());
    expect(snapshot.selectedIndex).toBeNull();
  });
});

describe("parseDockSessionSnapshot", () => {
  it("round-trips a serialized snapshot", () => {
    const snapshot = buildDockSessionSnapshot(dockLayout(), (terminalId) =>
      pane({
        cwd: `cwd-${terminalId}`,
        isAgent: terminalId === "t1",
        agentProfile: terminalId === "t1" ? "claude-local-main" : null,
        nativeSessionId: terminalId === "t1" ? "sess-1" : null,
      }), "2026-10-23T00:00:00.000Z");
    const parsed = parseDockSessionSnapshot(JSON.stringify(snapshot));
    expect(parsed).not.toBeNull();
    expect(parsed!.savedAt).toBe("2026-10-23T00:00:00.000Z");
    expect(parsed!.panes).toHaveLength(3);
    expect(parsed!.panes[1]).toMatchObject({
      agentProfile: "claude-local-main",
      nativeSessionId: "sess-1",
      isAgent: true,
    });
    expect(parsed!.selectedIndex).toBe(1);
  });

  it("returns null for garbage JSON and unknown versions", () => {
    expect(parseDockSessionSnapshot("not json")).toBeNull();
    expect(parseDockSessionSnapshot(JSON.stringify({ version: 2, panes: [] }))).toBeNull();
    expect(parseDockSessionSnapshot(JSON.stringify({ version: 1 }))).toBeNull();
    expect(parseDockSessionSnapshot(JSON.stringify(null))).toBeNull();
  });

  it("drops a corrupt pane but keeps the valid ones", () => {
    const parsed = parseDockSessionSnapshot(JSON.stringify({
      version: 1,
      savedAt: "x",
      selectedIndex: 0,
      panes: [
        pane(),
        { projectId: "p1", cwd: "D:\\ws", profile: "not-a-shell", isAgent: false },
        pane({ projectId: "p2" }),
      ],
      rows: [1],
      cols: [[0.5, 0.5]],
      ptyCols: 100,
      ptyRows: 28,
    }));
    expect(parsed).not.toBeNull();
    expect(parsed!.panes.map((p) => p.projectId)).toEqual(["p1", "p2"]);
  });

  it("nulls an out-of-range selectedIndex and mismatched cols", () => {
    const parsed = parseDockSessionSnapshot(JSON.stringify({
      version: 1,
      savedAt: "x",
      selectedIndex: 9,
      panes: [pane()],
      rows: [1],
      cols: [[0.5, 0.5], [1]],
      ptyCols: 100,
      ptyRows: 28,
    }));
    expect(parsed!.selectedIndex).toBeNull();
    expect(parsed!.cols).toEqual([]);
  });
});

/** DockLayoutManager with fake PTYs over a real temp workspace (makeDock pattern). */
async function makeRestoreHarness(): Promise<{
  dir: string;
  dock: DockLayoutManager;
  spawned: Array<{ id: string; input: Record<string, unknown> }>;
  cleanup: () => Promise<void>;
}> {
  const dir = await mkdtemp(join(tmpdir(), "coterm-session-restore-"));
  let counter = 0;
  const spawned: Array<{ id: string; input: Record<string, unknown> }> = [];
  const terminals = {
    create: vi.fn((input: Record<string, unknown>) => {
      const id = `t${counter++}`;
      spawned.push({ id, input });
      return { id, cwd: input.cwd } as TerminalInfo;
    }),
    kill: vi.fn(),
    get: vi.fn().mockReturnValue(null),
  };
  const repository = {
    getProject: vi.fn((id: string): Project | null =>
      id === "missing"
        ? null
        : ({ id, name: id, workspacePath: dir } as unknown as Project)),
    getSettings: vi.fn(() => ({
      defaultShell: "pwsh",
      proxyUrl: "http://127.0.0.1:8787",
      customProfiles: {},
    })),
  };
  const dock = new DockLayoutManager({
    terminals: terminals as never,
    repository: repository as never,
    userDataPath: dir,
    tempPath: dir,
  });
  return { dir, dock, spawned, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

describe("DockLayoutManager.restoreTiles", () => {
  it("recreates panes in order with the stored selection and even split", async () => {
    const { dir, dock, spawned, cleanup } = await makeRestoreHarness();
    try {
      const { layout, created } = await dock.restoreTiles(
        [pane({ cwd: dir }), pane({ cwd: dir, isAgent: true, agentProfile: "claude-local-main", nativeSessionId: "s1" })],
        { selectedIndex: 1, rows: [], cols: [], ptyCols: 120, ptyRows: 30 },
      );
      expect(created).toHaveLength(2);
      expect(spawned[1]!.input.isAgent).toBe(true);
      expect(spawned[1]!.input.agentProfile).toBe("claude-local-main");
      // Stored fractions don't match the tile count → even split.
      expect(layout.selectedTerminalId).toBe(created[1]!.terminalId);
      expect(layout.rows).toEqual([1]);
      expect(layout.cols).toEqual([[0.5, 0.5]]);
      expect(layout.ptyCols).toBe(120);
    } finally {
      await cleanup();
    }
  });

  it("reuses stored fractions when their shape matches the restored tiles", async () => {
    const { dir, dock, cleanup } = await makeRestoreHarness();
    try {
      const { layout } = await dock.restoreTiles(
        [pane({ cwd: dir }), pane({ cwd: dir })],
        { selectedIndex: 0, rows: [1], cols: [[0.25, 0.75]], ptyCols: 100, ptyRows: 28 },
      );
      expect(layout.cols).toEqual([[0.25, 0.75]]);
    } finally {
      await cleanup();
    }
  });

  it("skips panes whose project no longer exists", async () => {
    const { dir, dock, cleanup } = await makeRestoreHarness();
    try {
      const { layout, created } = await dock.restoreTiles(
        [pane({ projectId: "missing", cwd: dir }), pane({ cwd: dir })],
        { selectedIndex: 1, rows: [], cols: [], ptyCols: 100, ptyRows: 28 },
      );
      expect(created).toHaveLength(1);
      // Selection was clamped onto the only surviving tile.
      expect(layout.selectedTerminalId).toBe(created[0]!.terminalId);
    } finally {
      await cleanup();
    }
  });

  it("refuses to clobber a dock that already has live tiles", async () => {
    const { dir, dock, spawned, cleanup } = await makeRestoreHarness();
    try {
      await dock.openTile("p1");
      const before = spawned.length;
      const { created } = await dock.restoreTiles(
        [pane({ cwd: dir })],
        { selectedIndex: 0, rows: [], cols: [], ptyCols: 100, ptyRows: 28 },
      );
      expect(created).toHaveLength(0);
      expect(spawned.length).toBe(before);
    } finally {
      await cleanup();
    }
  });
});

describe("SessionRestoreService", () => {
  async function makeService(options: {
    resolvePaneSession?: (query: PaneSessionQuery) => Promise<ResolvedPaneSession | null>;
  } = {}): Promise<{
    dir: string;
    dock: DockLayoutManager;
    spawned: Array<{ id: string; input: Record<string, unknown> }>;
    writes: Array<{ terminalId: string; data: string }>;
    bound: Array<{ terminalId: string; sessionId: string }>;
    live: Map<string, { cwd: string; info: TerminalInfo }>;
    terminals: {
      get: ReturnType<typeof vi.fn>;
      getLiveCwd: ReturnType<typeof vi.fn>;
      setNativeSessionId: ReturnType<typeof vi.fn>;
      writeWhenShellReady: ReturnType<typeof vi.fn>;
    };
    service: SessionRestoreService;
    enabled: { value: boolean };
    cleanup: () => Promise<void>;
  }> {
    const harness = await makeRestoreHarness();
    const writes: Array<{ terminalId: string; data: string }> = [];
    const bound: Array<{ terminalId: string; sessionId: string }> = [];
    const live = new Map<string, { cwd: string; info: TerminalInfo }>();
    const terminals = {
      get: vi.fn((id: string) => live.get(id)?.info ?? null),
      getLiveCwd: vi.fn((id: string) => live.get(id)?.cwd ?? null),
      setNativeSessionId: vi.fn((terminalId: string, sessionId: string) => { bound.push({ terminalId, sessionId }); }),
      writeWhenShellReady: vi.fn((terminalId: string, data: string) => { writes.push({ terminalId, data }); }),
    };
    const enabled = { value: true };
    const service = new SessionRestoreService({
      userDataPath: harness.dir,
      dock: harness.dock,
      terminals: terminals as never,
      events: new AppEventBus(),
      getEnabled: () => enabled.value,
      getProfileTable: () => DEFAULT_PROFILES,
      ...(options.resolvePaneSession ? { resolvePaneSession: options.resolvePaneSession } : {}),
    });
    return { ...harness, writes, bound, live, terminals, service, enabled, cleanup: harness.cleanup };
  }

  it("restores agent panes with their provider resume command and binds the session id", async () => {
    const ctx = await makeService();
    try {
      const snapshot = {
        version: 1,
        savedAt: "2026-10-23T00:00:00.000Z",
        panes: [
          pane({ cwd: ctx.dir }),
          pane({ cwd: ctx.dir, isAgent: true, agentProfile: "claude-local-main", nativeSessionId: "claude-sess-1" }),
          pane({ cwd: ctx.dir, isAgent: true, agentProfile: "codex-local-main", nativeSessionId: "codex-sess-9" }),
        ],
        selectedIndex: 1,
        rows: [],
        cols: [],
        ptyCols: 100,
        ptyRows: 28,
      };
      const { writeFile } = await import("node:fs/promises");
      await writeFile(join(ctx.dir, "session-restore.json"), JSON.stringify(snapshot), "utf8");
      const outcome = await ctx.service.restore();
      expect(outcome.restored).toBe(3);
      expect(outcome.relaunched).toBe(2);
      // claude -> --resume flag; codex -> resume subcommand.
      const claudeWrite = ctx.writes.find((w) => w.data.includes("claude-sess-1"));
      const codexWrite = ctx.writes.find((w) => w.data.includes("codex-sess-9"));
      expect(claudeWrite?.data).toContain("--resume 'claude-sess-1'");
      expect(codexWrite?.data).toContain("resume 'codex-sess-9'");
      // Auto-Enter, same as the renderer's launch path.
      expect(claudeWrite?.data.endsWith("\r")).toBe(true);
      // Plain shell pane gets no relaunch write.
      expect(ctx.writes).toHaveLength(2);
      expect(ctx.bound).toContainEqual({ terminalId: claudeWrite!.terminalId, sessionId: "claude-sess-1" });
    } finally {
      await ctx.cleanup();
    }
  });

  it("leaves truly unknown profiles as a plain shell (no error loop)", async () => {
    const ctx = await makeService();
    try {
      const snapshot = {
        version: 1,
        savedAt: "x",
        panes: [pane({ cwd: ctx.dir, isAgent: true, agentProfile: "ghost-agent-9000", nativeSessionId: "gone" })],
        selectedIndex: 0,
        rows: [],
        cols: [],
        ptyCols: 100,
        ptyRows: 28,
      };
      const { writeFile } = await import("node:fs/promises");
      await writeFile(join(ctx.dir, "session-restore.json"), JSON.stringify(snapshot), "utf8");
      const outcome = await ctx.service.restore();
      expect(outcome.restored).toBe(1);
      expect(outcome.relaunched).toBe(0);
      expect(ctx.writes).toHaveLength(0);
    } finally {
      await ctx.cleanup();
    }
  });

  it("resumes PAID/official picker panes too (claude-official, codex-official, codex-team)", async () => {
    const ctx = await makeService();
    try {
      const snapshot = {
        version: 1,
        savedAt: "x",
        panes: [
          pane({ cwd: ctx.dir, isAgent: true, agentProfile: "claude-official", nativeSessionId: "official-claude-1" }),
          pane({ cwd: ctx.dir, isAgent: true, agentProfile: "codex-official", nativeSessionId: "official-codex-2" }),
          pane({ cwd: ctx.dir, isAgent: true, agentProfile: "codex-team", nativeSessionId: "team-codex-3" }),
        ],
        selectedIndex: 0,
        rows: [],
        cols: [],
        ptyCols: 100,
        ptyRows: 28,
      };
      const { writeFile } = await import("node:fs/promises");
      await writeFile(join(ctx.dir, "session-restore.json"), JSON.stringify(snapshot), "utf8");
      const outcome = await ctx.service.restore();
      expect(outcome).toEqual({ restored: 3, relaunched: 3 });
      // claude-official: --resume flag; proxy env wall nulled for paid home.
      const claudeWrite = ctx.writes.find((w) => w.data.includes("official-claude-1"));
      expect(claudeWrite?.data).toContain("claude --resume 'official-claude-1'");
      expect(claudeWrite?.data).toContain("$env:ANTHROPIC_BASE_URL=$null");
      // codex-official: resume SUBCOMMAND after the bypass flag, paid env nulled.
      const codexWrite = ctx.writes.find((w) => w.data.includes("official-codex-2"));
      expect(codexWrite?.data).toContain("codex --dangerously-bypass-approvals-and-sandbox resume 'official-codex-2'");
      // codex-team: --profile wrapper + the resume subcommand inside the TOML-exists guard.
      const teamWrite = ctx.writes.find((w) => w.data.includes("team-codex-3"));
      expect(teamWrite?.data).toContain("--profile 'codex-team'");
      expect(teamWrite?.data).toContain(" resume 'team-codex-3'");
    } finally {
      await ctx.cleanup();
    }
  });

  it("drops a malformed session id and launches the agent fresh instead", async () => {
    const ctx = await makeService();
    try {
      const snapshot = {
        version: 1,
        savedAt: "x",
        panes: [pane({ cwd: ctx.dir, isAgent: true, agentProfile: "claude-official", nativeSessionId: "x'; evil --flag" })],
        selectedIndex: 0,
        rows: [],
        cols: [],
        ptyCols: 100,
        ptyRows: 28,
      };
      const { writeFile } = await import("node:fs/promises");
      await writeFile(join(ctx.dir, "session-restore.json"), JSON.stringify(snapshot), "utf8");
      const outcome = await ctx.service.restore();
      expect(outcome.relaunched).toBe(1);
      expect(ctx.writes).toHaveLength(1);
      expect(ctx.writes[0]!.data).not.toContain("--resume");
      expect(ctx.writes[0]!.data).toContain("claude --dangerously-skip-permissions");
    } finally {
      await ctx.cleanup();
    }
  });

  it("no-ops when the setting is off", async () => {
    const ctx = await makeService();
    try {
      ctx.enabled.value = false;
      const { writeFile } = await import("node:fs/promises");
      await writeFile(join(ctx.dir, "session-restore.json"), JSON.stringify({
        version: 1, savedAt: "x", panes: [pane({ cwd: ctx.dir })],
        selectedIndex: 0, rows: [], cols: [], ptyCols: 100, ptyRows: 28,
      }), "utf8");
      const outcome = await ctx.service.restore();
      expect(outcome).toEqual({ restored: 0, relaunched: 0 });
      expect(ctx.spawned).toHaveLength(0);
    } finally {
      await ctx.cleanup();
    }
  });

  it("no-ops on a missing or corrupt snapshot file", async () => {
    const ctx = await makeService();
    try {
      await expect(ctx.service.restore()).resolves.toEqual({ restored: 0, relaunched: 0 });
      const { writeFile } = await import("node:fs/promises");
      await writeFile(join(ctx.dir, "session-restore.json"), "{broken", "utf8");
      await expect(ctx.service.restore()).resolves.toEqual({ restored: 0, relaunched: 0 });
    } finally {
      await ctx.cleanup();
    }
  });

  it("saveNow persists a snapshot the parser reads back, including an empty dock", async () => {
    const ctx = await makeService();
    try {
      await ctx.service.saveNow();
      const parsed = parseDockSessionSnapshot(await readFile(join(ctx.dir, "session-restore.json"), "utf8"));
      expect(parsed).not.toBeNull();
      expect(parsed!.panes).toEqual([]);
      expect(parsed!.selectedIndex).toBeNull();
    } finally {
      await ctx.cleanup();
    }
  });

  /**
   * Live-pane factory: open a real tile through the DockLayoutManager, then
   * point the service's terminals map at a running agent-session info.
   */
  function liveAgentInfo(terminalId: string, cwd: string, overrides: Partial<TerminalInfo> = {}): TerminalInfo {
    return {
      id: terminalId,
      projectId: "p1",
      title: "agent",
      cwd,
      profile: "pwsh",
      status: "running",
      pid: 4242,
      cols: 100,
      rows: 28,
      startedAt: "2026-10-23T00:00:00.000Z",
      isAgent: true,
      agentProfile: "claude-local-main",
      nativeSessionId: "launch-random-id",
      worktreeId: null,
      label: null,
      ...overrides,
    } as unknown as TerminalInfo;
  }

  async function openLiveAgentTile(ctx: Awaited<ReturnType<typeof makeService>>, overrides: Partial<TerminalInfo> = {}): Promise<string> {
    await ctx.dock.openTile("p1");
    const terminalId = ctx.spawned[ctx.spawned.length - 1]!.id;
    ctx.live.set(terminalId, { cwd: ctx.dir, info: liveAgentInfo(terminalId, ctx.dir, overrides) });
    return terminalId;
  }

  it("snapshots the session the pane is ACTUALLY in after an in-session /resume hop", async () => {
    // 2026-10-23 bug: the stored --session-id stays the launch-time random one
    // when the user hops with /resume and no reader runs before quit; restore
    // then resumed an empty launch session instead of the live conversation.
    const queries: PaneSessionQuery[] = [];
    const ctx = await makeService({
      resolvePaneSession: async (query) => {
        queries.push(query);
        return { nativeSessionId: "real-current-id", transcriptExists: true };
      },
    });
    try {
      const terminalId = await openLiveAgentTile(ctx);
      await ctx.service.saveNow();
      const parsed = parseDockSessionSnapshot(await readFile(join(ctx.dir, "session-restore.json"), "utf8"));
      expect(parsed).not.toBeNull();
      expect(parsed!.panes).toHaveLength(1);
      // Resolved hop target wins over the stale launch-time id.
      expect(parsed!.panes[0]!.nativeSessionId).toBe("real-current-id");
      expect(queries).toHaveLength(1);
      expect(queries[0]).toMatchObject({
        terminalId,
        agentProfile: "claude-local-main",
        nativeSessionId: "launch-random-id",
      });
    } finally {
      await ctx.cleanup();
    }
  });

  it("stores a null session id when the transcript file no longer exists", async () => {
    const ctx = await makeService({
      resolvePaneSession: async () => ({ nativeSessionId: "launch-random-id", transcriptExists: false }),
    });
    try {
      await openLiveAgentTile(ctx);
      await ctx.service.saveNow();
      const parsed = parseDockSessionSnapshot(await readFile(join(ctx.dir, "session-restore.json"), "utf8"));
      expect(parsed!.panes[0]!.nativeSessionId).toBeNull();
    } finally {
      await ctx.cleanup();
    }
  });

  it("falls back to the stored id when session resolution is unavailable", async () => {
    const ctx = await makeService({
      resolvePaneSession: async () => { throw new Error("resolver blew up"); },
    });
    try {
      await openLiveAgentTile(ctx);
      await ctx.service.saveNow();
      const parsed = parseDockSessionSnapshot(await readFile(join(ctx.dir, "session-restore.json"), "utf8"));
      expect(parsed!.panes[0]!.nativeSessionId).toBe("launch-random-id");
    } finally {
      await ctx.cleanup();
    }
  });

  it("logs per-pane restore metadata (profile, session id presence, transcript existence)", async () => {
    // logger is a Proxy facade over the active sink; with no initLogger in the
    // test env it routes to console.log — spy there instead.
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const ctx = await makeService({
      resolvePaneSession: async () => ({ nativeSessionId: "[redacted]", transcriptExists: true }),
    });
    try {
      const snapshot = {
        version: 1,
        savedAt: "x",
        panes: [
          pane({ cwd: ctx.dir, isAgent: true, agentProfile: "claude-official", nativeSessionId: "official-claude-1" }),
          pane({ cwd: ctx.dir }),
        ],
        selectedIndex: 0,
        rows: [],
        cols: [],
        ptyCols: 100,
        ptyRows: 28,
      };
      const { writeFile } = await import("node:fs/promises");
      await writeFile(join(ctx.dir, "session-restore.json"), JSON.stringify(snapshot), "utf8");
      const outcome = await ctx.service.restore();
      expect(outcome.relaunched).toBe(1);
      const logs = logSpy.mock.calls.filter((call) => typeof call[0] === "string" && call[0].includes("sessionRestore.paneRelaunch"));
      expect(logs).toHaveLength(1);
      const meta = logs[0]![1] as Record<string, unknown>;
      expect(meta).toMatchObject({
        agentProfile: "claude-official",
        hasSessionId: true,
        transcriptExists: true,
        relaunched: true,
      });
      expect(JSON.stringify(meta)).not.toContain("official-claude-1");
    } finally {
      logSpy.mockRestore();
      await ctx.cleanup();
    }
  });
});

describe("sessionIdFromFile", () => {
  it("extracts the claude session id from ~/.claude/projects/<munged>/<id>.jsonl", () => {
    const file = join("C:\\Users\\u\\.claude\\projects\\D--workspace-demo", "8bd28ac6-6b02-45f1-98fd-def7424112ec.jsonl");
    expect(sessionIdFromFile(file, "claude")).toBe("8bd28ac6-6b02-45f1-98fd-def7424112ec");
    expect(sessionIdFromFile(join("x", "not a session.txt"), "claude")).toBeNull();
  });

  it("extracts the codex rollout uuid suffix and rejects non-rollout names", () => {
    const rollout = join("C:\\Users\\u\\.codex\\sessions\\2026\\10\\23", "rollout-2026-10-23T00-26-01-7dda5fbd-1b2e-4d03-92ab-fe861644b85e.jsonl");
    expect(sessionIdFromFile(rollout, "codex")).toBe("7dda5fbd-1b2e-4d03-92ab-fe861644b85e");
    expect(sessionIdFromFile(join("x", "rollout-no-uuid.jsonl"), "codex")).toBeNull();
    expect(sessionIdFromFile(join("x", "anything.jsonl"), "unsupported")).toBeNull();
  });
});
