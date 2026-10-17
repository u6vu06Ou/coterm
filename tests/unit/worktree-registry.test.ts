import { describe, expect, it } from "vitest";
import type { GitHelperOptions, GitResult } from "../../src/main/security/git-helper";
import type { WorktreeScanInput } from "../../src/main/terminal/worktree-registry";
import type { WorktreeRegistryEntry } from "@shared/types";
import { WorktreeRegistry, diffWorktreeScan, parseWorktreeList } from "../../src/main/terminal/worktree-registry";

type GitFn = NonNullable<WorktreeRegistry["options"]["gitFn"]>;

const now = 1_000_000;

/** diffWorktreeScan mutates record objects (they are reused in the result). */
function cloneRecords(records: WorktreeRegistryEntry[]): WorktreeRegistryEntry[] {
  return records.map((record) => ({ ...record }));
}

function scanInput(overrides: Partial<WorktreeScanInput> & { scanned: WorktreeScanInput["scanned"] }): WorktreeScanInput {
  return {
    records: [],
    baselines: new Map(),
    onDisk: new Map(),
    now,
    ...overrides,
  };
}

describe("parseWorktreeList", () => {
  it("parses a porcelain fixture: branch stripped, detached and bare skipped", () => {
    const output = [
      "worktree D:\\repo",
      "HEAD 1111111111111111111111111111111111111111",
      "branch refs/heads/main",
      "",
      "worktree D:\\repo\\.claude\\worktrees\\agent-1",
      "HEAD 2222222222222222222222222222222222222222",
      "branch refs/heads/agent/work",
      "",
      "worktree D:\\bare",
      "bare",
      "",
      "worktree D:\\detached",
      "HEAD 3333333333333333333333333333333333333333",
      "detached",
      "",
    ].join("\n");
    expect(parseWorktreeList(output)).toEqual([
      { path: "D:\\repo", head: "1111111111111111111111111111111111111111", branch: "main" },
      { path: "D:\\repo\\.claude\\worktrees\\agent-1", head: "2222222222222222222222222222222222222222", branch: "agent/work" },
      { path: "D:\\bare", head: null, branch: null },
      { path: "D:\\detached", head: "3333333333333333333333333333333333333333", branch: null },
    ]);
  });

  it("tolerates CRLF endings, blank lines and paths with whitespace", () => {
    const output = "worktree D:\\my repo \r\nHEAD 1111\r\nbranch refs/heads/main\r\n\r\nworktree D:\\my repo\\wt\r\nHEAD 2222\r\n\r\n";
    expect(parseWorktreeList(output)).toEqual([
      { path: "D:\\my repo ", head: "1111", branch: "main" },
      { path: "D:\\my repo\\wt", head: "2222", branch: null },
    ]);
  });

  it("returns nothing for an empty or foreign output", () => {
    expect(parseWorktreeList("")).toEqual([]);
    expect(parseWorktreeList("error: not a repository")).toEqual([]);
  });
});

describe("diffWorktreeScan", () => {
  it("seeds the baseline on the first scan without session records", () => {
    const result = diffWorktreeScan(scanInput({
      scanned: new Map([["r", [
        { path: "R\\wt-a", head: null, branch: "main" },
        { path: "R\\wt-b", head: null, branch: null },
      ]]]),
    }));
    expect(result.records).toEqual([]);
    expect(result.baselines.get("r")).toEqual(new Set(["R\\wt-a", "R\\wt-b"]));
  });

  it("records a worktree created after the baseline, with firstSeenAt", () => {
    const result = diffWorktreeScan(scanInput({
      records: [],
      baselines: new Map([["r", new Set(["R\\wt-a"])]]),
      scanned: new Map([["r", [
        { path: "R\\wt-a", head: null, branch: "main" },
        { path: "R\\wt-new", head: null, branch: "agent/work" },
      ]]]),
    }));
    expect(result.records).toEqual([
      { path: "R\\wt-new", branch: "agent/work", firstSeenAt: now, lastSeenAt: now, removed: false, dirty: null },
    ]);
    expect(result.baselines.get("r")).toEqual(new Set(["R\\wt-a"]));
  });

  it("marks a record removed only when the directory is really gone", () => {
    const records: WorktreeRegistryEntry[] = [
      { path: "R\\wt-new", branch: "agent/work", firstSeenAt: now, lastSeenAt: now, removed: false, dirty: true },
    ];
    const scanned = new Map([["r", [{ path: "R\\wt-a", head: null, branch: "main" }]]]);
    // No longer listed but still on disk (a pruned-but-present tree): kept.
    const kept = diffWorktreeScan(scanInput({
      records: cloneRecords(records),
      baselines: new Map([["r", new Set(["R\\wt-a"])]]),
      scanned,
      onDisk: new Map([["R\\wt-new", true]]),
      now: now + 1,
    }));
    expect(kept.records[0]?.removed).toBe(false);
    expect(kept.records[0]?.dirty).toBe(true);
    expect(kept.records[0]?.lastSeenAt).toBe(now); // keeps the last real listing
    // And gone from disk: removed.
    const gone = diffWorktreeScan(scanInput({
      records: cloneRecords(records),
      baselines: new Map([["r", new Set(["R\\wt-a"])]]),
      scanned,
      onDisk: new Map([["R\\wt-new", false]]),
      now: now + 1,
    }));
    expect(gone.records[0]?.removed).toBe(true);
    expect(gone.records[0]?.branch).toBe("agent/work");
  });

  it("folds a repo first seen mid-session into the baseline silently", () => {
    const result = diffWorktreeScan(scanInput({
      baselines: new Map([["r", new Set(["R\\wt-a"])]]),
      scanned: new Map([
        ["r", [{ path: "R\\wt-a", head: null, branch: "main" }]],
        ["other", [{ path: "O\\wt-1", head: null, branch: "dev" }]],
      ]),
    }));
    expect(result.records).toEqual([]);
    expect(result.baselines.get("other")).toEqual(new Set(["O\\wt-1"]));
  });

  it("caps tracked records and folds the overflow into the baseline", () => {
    const result = diffWorktreeScan(scanInput({
      baselines: new Map([["r", new Set(["R\\wt-a"])]]),
      scanned: new Map([["r", [
        { path: "R\\wt-a", head: null, branch: "main" },
        { path: "R\\wt-1", head: null, branch: "one" },
        { path: "R\\wt-2", head: null, branch: "two" },
        { path: "R\\wt-3", head: null, branch: "three" },
      ]]]),
      maxRecords: 2,
    }));
    expect(result.records.map((entry) => entry.path).sort()).toEqual(["R\\wt-1", "R\\wt-2"]);
    expect(result.baselines.get("r")).toContain("R\\wt-3");
  });
});

describe("WorktreeRegistry", () => {
  it("tracks a session worktree from creation to removal with throttled dirty checks", async () => {
    let tickNow = now;
    let porcelain = "worktree D:\\repo\nHEAD 1111\nbranch refs/heads/main\n";
    let status: string | null = " M src/a.ts";
    const gitFn: GitFn = async (args: readonly string[], _options: GitHelperOptions): Promise<GitResult> => {
      if (args[0] === "worktree" && args[1] === "list") {
        if (!porcelain) throw new Error("not a repo");
        return { stdout: porcelain, exitCode: 0, truncated: false };
      }
      if (args[0] === "status" && args[1] === "--porcelain") {
        if (status === null) throw new Error("git failed");
        return { stdout: status, exitCode: 0, truncated: false };
      }
      throw new Error("unexpected git call");
    };
    let exists = true;
    const registry = new WorktreeRegistry({
      listRoots: () => ["D:\\repo"],
      gitFn,
      pathExists: async () => exists,
      now: () => tickNow,
    });

    // Scan 1: baseline only, nothing session-created yet.
    await registry.refresh();
    expect(registry.list()).toEqual({ entries: [], baselineCount: 1, lastCheckedAt: now });

    // Scan 2: an agent created a worktree; its dirty status rides the same pass.
    porcelain = [
      "worktree D:\\repo",
      "HEAD 1111",
      "branch refs/heads/main",
      "",
      "worktree D:\\repo\\.claude\\worktrees\\agent-1",
      "HEAD 2222",
      "branch refs/heads/agent/work",
      "",
    ].join("\n");
    tickNow = now + 100;
    await registry.refresh();
    const entries = registry.list().entries;
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      path: "D:\\repo\\.claude\\worktrees\\agent-1",
      branch: "agent/work",
      removed: false,
      dirty: true,
    });

    // Dirty checks are throttled within the window: the stale status stays.
    status = "";
    tickNow = now + 200;
    await registry.refresh();
    expect(registry.list().entries[0]?.dirty).toBe(true);

    // After the window it re-checks (clean) and the unknown state shows as null.
    tickNow += 60_000 + 1;
    await registry.refresh();
    expect(registry.list().entries[0]?.dirty).toBe(false);

    status = null; // git status fails → unknown, shown as such
    tickNow += 60_000 + 1;
    await registry.refresh();
    expect(registry.list().entries[0]?.dirty).toBe(null);

    // Removal is decided by the real directory being gone, not by the listing.
    porcelain = "worktree D:\\repo\nHEAD 1111\nbranch refs/heads/main\n";
    exists = false;
    tickNow += 60_000 + 1;
    await registry.refresh();
    const removed = registry.list().entries[0];
    expect(removed?.removed).toBe(true);
    expect(removed?.branch).toBe("agent/work");
    expect(registry.list().baselineCount).toBe(1);
  });

  it("does not rescan twice concurrently and resets on stop", async () => {
    const tickNow = now;
    let running = false;
    let overlaps = 0;
    const gitFn: GitFn = async (args: readonly string[]): Promise<GitResult> => {
      if (args[0] === "worktree") {
        if (running) overlaps += 1;
        running = true;
        await new Promise((resolve) => setTimeout(resolve, 25));
        running = false;
        return { stdout: "", exitCode: 0, truncated: false };
      }
      return { stdout: "", exitCode: 0, truncated: false };
    };
    const registry = new WorktreeRegistry({
      listRoots: () => ["D:\\repo"],
      gitFn,
      pathExists: async () => true,
      now: () => tickNow,
    });
    await Promise.all([registry.refresh(), registry.refresh(), registry.refresh()]);
    expect(overlaps).toBe(0);
    registry.stop();
    expect(registry.list()).toEqual({ entries: [], baselineCount: 0, lastCheckedAt: null });
  });
});
