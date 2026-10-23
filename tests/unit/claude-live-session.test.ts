import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  ClaudeLiveSessionTracker,
  collectDescendants,
  type ProcessEntry,
} from "../../src/main/terminal/claude-live-session";
import { ContextBatteryMonitor, mungeCwd } from "../../src/main/terminal/context-meter";
import type { PtyManager } from "../../src/main/terminal/pty-manager";

interface Fixture {
  sessionsDir: string;
  projectsRoot: string;
  cleanup: () => Promise<void>;
}

async function fixture(): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), "coterm-live-session-"));
  const sessionsDir = join(root, "sessions");
  const projectsRoot = join(root, "projects");
  await mkdir(sessionsDir, { recursive: true });
  await mkdir(projectsRoot, { recursive: true });
  return {
    sessionsDir,
    projectsRoot,
    cleanup: () => rm(root, { recursive: true, force: true }),
  };
}

function sessionPayload(overrides: Record<string, unknown>): string {
  return JSON.stringify({
    pid: 0,
    sessionId: "00000000-0000-4000-8000-000000000000",
    cwd: "D:\\repo",
    startedAt: Date.now(),
    status: "busy",
    updatedAt: Date.now(),
    ...overrides,
  });
}

async function writePidFile(sessionsDir: string, pid: number, overrides: Record<string, unknown> = {}): Promise<void> {
  await writeFile(join(sessionsDir, `${pid}.json`), sessionPayload({ pid, ...overrides }), "utf8");
}

async function writeTranscript(projectsRoot: string, cwd: string, sessionId: string): Promise<void> {
  const dir = join(projectsRoot, mungeCwd(cwd));
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, `${sessionId}.jsonl`), "{}\n", "utf8");
}

const PANE = {
  terminalId: "pane-1",
  shellPid: 100,
  cwd: "D:\\repo",
  startedAt: new Date().toISOString(),
  nativeSessionId: "aaaaaaaa-0000-4000-8000-000000000000",
  reservedSessionIds: [] as string[],
};

function tree(...entries: ProcessEntry[]): () => Promise<ProcessEntry[]> {
  return () => Promise.resolve(entries);
}

describe("collectDescendants", () => {
  it("walks the whole subtree below the shell pid, including the root itself", () => {
    const table: ProcessEntry[] = [
      { pid: 100, ppid: 1 },   // pane shell
      { pid: 200, ppid: 100 }, // claude
      { pid: 300, ppid: 200 }, // claude child (mcp server etc.)
      { pid: 400, ppid: 1 },   // unrelated process
    ];
    expect([...collectDescendants(100, table)].sort((a, b) => a - b)).toEqual([100, 200, 300]);
  });

  it("survives a pid cycle in a corrupt table", () => {
    const table: ProcessEntry[] = [
      { pid: 100, ppid: 200 },
      { pid: 200, ppid: 100 },
    ];
    expect([...collectDescendants(100, table)].sort((a, b) => a - b)).toEqual([100, 200]);
  });
});

describe("ClaudeLiveSessionTracker process-tree path", () => {
  it("follows a /resume to an OLDER session via the descendant pid file", async () => {
    const fx = await fixture();
    const older = "bbbbbbbb-1111-4111-8111-111111111111";
    // 100 = pane shell, 200 = claude (child of the shell).
    await writePidFile(fx.sessionsDir, 200, { sessionId: older });
    await writeTranscript(fx.projectsRoot, PANE.cwd, older);
    const tracker = new ClaudeLiveSessionTracker({
      sessionsDir: fx.sessionsDir,
      claudeProjectsRoot: fx.projectsRoot,
      listProcesses: tree({ pid: 100, ppid: 1 }, { pid: 200, ppid: 100 }),
    });
    try {
      await expect(tracker.follow(PANE)).resolves.toBe(older);
    } finally {
      await fx.cleanup();
    }
  });

  it("returns null when the pid file already agrees with the bound session", async () => {
    const fx = await fixture();
    await writePidFile(fx.sessionsDir, 200, { sessionId: PANE.nativeSessionId });
    await writeTranscript(fx.projectsRoot, PANE.cwd, PANE.nativeSessionId!);
    const tracker = new ClaudeLiveSessionTracker({
      sessionsDir: fx.sessionsDir,
      claudeProjectsRoot: fx.projectsRoot,
      listProcesses: tree({ pid: 100, ppid: 1 }, { pid: 200, ppid: 100 }),
    });
    try {
      await expect(tracker.follow(PANE)).resolves.toBeNull();
    } finally {
      await fx.cleanup();
    }
  });

  it("refuses a session claimed by another pane even when it is in our own tree", async () => {
    const fx = await fixture();
    const claimed = "cccccccc-2222-4222-8222-222222222222";
    await writePidFile(fx.sessionsDir, 200, { sessionId: claimed });
    await writeTranscript(fx.projectsRoot, PANE.cwd, claimed);
    const tracker = new ClaudeLiveSessionTracker({
      sessionsDir: fx.sessionsDir,
      claudeProjectsRoot: fx.projectsRoot,
      listProcesses: tree({ pid: 100, ppid: 1 }, { pid: 200, ppid: 100 }),
    });
    try {
      await expect(tracker.follow({ ...PANE, reservedSessionIds: [claimed] })).resolves.toBeNull();
    } finally {
      await fx.cleanup();
    }
  });

  it("never binds to a session whose transcript file does not exist yet (/clear beat)", async () => {
    const fx = await fixture();
    await writePidFile(fx.sessionsDir, 200, { sessionId: "dddddddd-3333-4333-8333-333333333333" });
    const tracker = new ClaudeLiveSessionTracker({
      sessionsDir: fx.sessionsDir,
      claudeProjectsRoot: fx.projectsRoot,
      listProcesses: tree({ pid: 100, ppid: 1 }, { pid: 200, ppid: 100 }),
    });
    try {
      await expect(tracker.follow(PANE)).resolves.toBeNull();
    } finally {
      await fx.cleanup();
    }
  });

  it("ignores a pid file whose payload pid disagrees with its filename", async () => {
    const fx = await fixture();
    await writePidFile(fx.sessionsDir, 200, { pid: 999, sessionId: "eeeeeeee-4444-4444-8444-444444444444" });
    const tracker = new ClaudeLiveSessionTracker({
      sessionsDir: fx.sessionsDir,
      claudeProjectsRoot: fx.projectsRoot,
      listProcesses: tree({ pid: 100, ppid: 1 }, { pid: 200, ppid: 100 }),
    });
    try {
      await expect(tracker.follow(PANE)).resolves.toBeNull();
    } finally {
      await fx.cleanup();
    }
  });

  it("does nothing for a pane without a live shell pid", async () => {
    const fx = await fixture();
    let listed = 0;
    const tracker = new ClaudeLiveSessionTracker({
      sessionsDir: fx.sessionsDir,
      claudeProjectsRoot: fx.projectsRoot,
      listProcesses: () => { listed += 1; return Promise.resolve([]); },
    });
    try {
      await expect(tracker.follow({ ...PANE, shellPid: 0 })).resolves.toBeNull();
      expect(listed).toBe(0);
    } finally {
      await fx.cleanup();
    }
  });

  it("lists processes only when a session file appears for an unseen pid", async () => {
    const fx = await fixture();
    await writePidFile(fx.sessionsDir, 200, { sessionId: PANE.nativeSessionId });
    let listed = 0;
    const tracker = new ClaudeLiveSessionTracker({
      sessionsDir: fx.sessionsDir,
      claudeProjectsRoot: fx.projectsRoot,
      listProcesses: () => { listed += 1; return Promise.resolve([{ pid: 100, ppid: 1 }, { pid: 200, ppid: 100 }, { pid: 500, ppid: 1 }]); },
    });
    try {
      await tracker.follow(PANE);
      await tracker.follow({ ...PANE, terminalId: "pane-2", shellPid: 500 });
      await tracker.follow(PANE);
      expect(listed).toBe(1);
    } finally {
      await fx.cleanup();
    }
  });
});

describe("ClaudeLiveSessionTracker cwd fallback", () => {
  const noneInTree = tree({ pid: 100, ppid: 1 });

  it("binds the single unclaimed same-cwd session started at/after the pane", async () => {
    const fx = await fixture();
    const live = "ffffffff-5555-4555-8555-555555555555";
    await writePidFile(fx.sessionsDir, 700, { sessionId: live, startedAt: Date.now() });
    await writeTranscript(fx.projectsRoot, PANE.cwd, live);
    const tracker = new ClaudeLiveSessionTracker({
      sessionsDir: fx.sessionsDir,
      claudeProjectsRoot: fx.projectsRoot,
      listProcesses: noneInTree,
    });
    try {
      await expect(tracker.follow(PANE)).resolves.toBe(live);
    } finally {
      await fx.cleanup();
    }
  });

  it("matches the pane cwd case-insensitively", async () => {
    const fx = await fixture();
    const live = "10101010-6666-4666-8666-666666666666";
    // The pid file's cwd differs only by case and a trailing slash.
    await writePidFile(fx.sessionsDir, 700, { sessionId: live, cwd: "d:\\REPO\\" });
    // Claude munges the pid-file cwd for its projects folder (same normalized string).
    await writeTranscript(fx.projectsRoot, "d:\\REPO", live);
    const tracker = new ClaudeLiveSessionTracker({
      sessionsDir: fx.sessionsDir,
      claudeProjectsRoot: fx.projectsRoot,
      listProcesses: noneInTree,
    });
    try {
      await expect(tracker.follow(PANE)).resolves.toBe(live);
    } finally {
      await fx.cleanup();
    }
  });

  it("fails soft when TWO same-cwd sessions could be the pane's", async () => {
    const fx = await fixture();
    await writePidFile(fx.sessionsDir, 700, { sessionId: "20202020-7777-4777-8777-777777777777" });
    await writePidFile(fx.sessionsDir, 701, { sessionId: "30303030-8888-4888-8888-888888888888" });
    // .key sidecars sit next to the pid files and must be ignored.
    await writeFile(join(fx.sessionsDir, "700.abcdef.key"), "{}", "utf8");
    const tracker = new ClaudeLiveSessionTracker({
      sessionsDir: fx.sessionsDir,
      claudeProjectsRoot: fx.projectsRoot,
      listProcesses: noneInTree,
    });
    try {
      await expect(tracker.follow(PANE)).resolves.toBeNull();
    } finally {
      await fx.cleanup();
    }
  });

  it("ignores a session started long before the pane (someone else's window)", async () => {
    const fx = await fixture();
    const stale = "40404040-9999-4999-8999-999999999999";
    await writePidFile(fx.sessionsDir, 700, {
      sessionId: stale,
      startedAt: Date.parse(PANE.startedAt) - 10 * 60_000,
    });
    await writeTranscript(fx.projectsRoot, PANE.cwd, stale);
    const tracker = new ClaudeLiveSessionTracker({
      sessionsDir: fx.sessionsDir,
      claudeProjectsRoot: fx.projectsRoot,
      listProcesses: noneInTree,
    });
    try {
      await expect(tracker.follow(PANE)).resolves.toBeNull();
    } finally {
      await fx.cleanup();
    }
  });

  it("ignores a different-cwd session and one claimed by another pane", async () => {
    const fx = await fixture();
    const other = "50505050-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    await writePidFile(fx.sessionsDir, 700, { sessionId: other, cwd: "D:\\other" });
    await writePidFile(fx.sessionsDir, 701, { sessionId: "60606060-bbbb-4bbb-8bbb-bbbbbbbbbbbb" });
    await writeTranscript(fx.projectsRoot, PANE.cwd, "60606060-bbbb-4bbb-8bbb-bbbbbbbbbbbb");
    const tracker = new ClaudeLiveSessionTracker({
      sessionsDir: fx.sessionsDir,
      claudeProjectsRoot: fx.projectsRoot,
      listProcesses: noneInTree,
    });
    try {
      await expect(tracker.follow({
        ...PANE,
        reservedSessionIds: ["60606060-bbbb-4bbb-8bbb-bbbbbbbbbbbb"],
      })).resolves.toBeNull();
    } finally {
      await fx.cleanup();
    }
  });

  it("uses the fallback when the process listing itself fails", async () => {
    const fx = await fixture();
    const live = "70707070-cccc-4ccc-8ccc-cccccccccccc";
    await writePidFile(fx.sessionsDir, 700, { sessionId: live });
    await writeTranscript(fx.projectsRoot, PANE.cwd, live);
    const tracker = new ClaudeLiveSessionTracker({
      sessionsDir: fx.sessionsDir,
      claudeProjectsRoot: fx.projectsRoot,
      listProcesses: () => Promise.reject(new Error("cim unavailable")),
    });
    try {
      await expect(tracker.follow(PANE)).resolves.toBe(live);
    } finally {
      await fx.cleanup();
    }
  });
});

describe("ContextBatteryMonitor live-session follow wiring", () => {
  it("rebinds a claude pane through followLiveSession and meters the NEW session in the same tick", async () => {
    const fx = await fixture();
    const oldId = "80808080-dddd-4ddd-8ddd-dddddddddddd";
    const liveId = "90909090-eeee-4eee-8eee-eeeeeeeeeeee";
    const cwd = "D:\\repo";
    await writePidFile(fx.sessionsDir, 200, { sessionId: liveId, cwd });
    // The OLD transcript (bound at launch) and the resumed-live one.
    const dir = join(fx.projectsRoot, mungeCwd(cwd));
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, `${oldId}.jsonl`), "{}\n", "utf8");
    await writeFile(
      join(dir, `${liveId}.jsonl`),
      JSON.stringify({
        message: {
          model: "claude-sonnet-4-6",
          usage: { input_tokens: 1000, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 5 },
        },
      }) + "\n",
      "utf8",
    );

    // A mutable one-pane fake: the rebind callback mimics PtyManager
    // .setNativeSessionId so the monitor's post-rebind re-snapshot sees the
    // new id (measureOne must read the NEW session file this same tick).
    const state = {
      id: "claude-1", agentProfile: "claude-official", cwd,
      nativeSessionId: oldId as string | null, startedAt: new Date().toISOString(), pid: 100,
    };
    const rebinds: Array<[string, string]> = [];
    const usageCalls: Array<[string, number]> = [];
    const terminals: Pick<PtyManager, "dashboardSnapshot" | "setContextUsage" | "setAgentSummaryTitle" | "setAgentRecap"> = {
      dashboardSnapshot: () => [{
        info: {
          id: state.id, projectId: "p", profile: "pwsh", title: "t", cwd: state.cwd,
          cols: 100, rows: 28, status: "running",
          startedAt: state.startedAt, closedAt: null, lastExitCode: null,
          isAgent: true, agentProfile: state.agentProfile, ownedByAgentApi: false,
          pid: state.pid, nativeSessionId: state.nativeSessionId, worktreeId: null,
          contextUsage: null, agentSummaryTitle: null,
        },
        ptyState: "running" as const,
        lastCommand: null,
      }],
      setContextUsage: (id, used) => { usageCalls.push([id, used]); },
      setAgentSummaryTitle: () => undefined,
      setAgentRecap: () => undefined,
    };
    try {
      const monitor = new ContextBatteryMonitor({
        terminals,
        projectsRoot: fx.projectsRoot,
        claudeSessionsDir: fx.sessionsDir,
        codexSessionsRoot: join(tmpdir(), "no-codex"),
        liveSessionListProcesses: tree({ pid: 100, ppid: 1 }, { pid: 200, ppid: 100 }),
        followLiveSession: (terminalId, sessionId) => {
          rebinds.push([terminalId, sessionId]);
          state.nativeSessionId = sessionId;
        },
        intervalMs: 60_000,
      });
      const tick = () => (monitor as unknown as { tick: () => Promise<void> }).tick();
      await tick();
      // Rebound to the live session...
      expect(rebinds).toEqual([["claude-1", liveId]]);
      // ...and the battery read the RESUMED session's usage (1005), not the
      // old/empty one's — same tick, no 10s lag.
      expect(usageCalls).toEqual([["claude-1", 1005]]);
      // Steady state: a second tick does not rebind again.
      await tick();
      expect(rebinds).toHaveLength(1);
    } finally {
      await fx.cleanup();
    }
  });
});
