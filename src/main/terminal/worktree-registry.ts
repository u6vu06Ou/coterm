import { stat } from "node:fs/promises";
import { resolve } from "node:path";
import type { WorktreeRegistryEntry, WorktreeRegistryActivity } from "@shared/types";
import { git, type GitHelperOptions, type GitResult } from "../security/git-helper";
import { logger } from "../core/logger";

/**
 * WorktreeRegistry — read-only "本次產出" section (2026-10-12 maintainer): agents
 * sometimes create git worktrees for parallel work and don't remove them; the
 * pulse panel lists the ones created during this session.
 *
 * Baseline: the first scan after app start records all worktrees of the known
 * project folders; anything appearing later is session-created. A repo first
 * seen mid-session has its pre-existing trees folded into the baseline
 * silently (its inherited worktrees are not this session's work).
 *
 * Removal: a record is marked removed only when its directory is really gone
 * (a scan failure or a pruned-but-on-disk tree keeps it listed — never lie
 * about worktrees that may still hold data). Dirty state per worktree rides a
 * throttled `git status --porcelain`.
 *
 * Cheap and non-blocking: one `git worktree list --porcelain` per repo per
 * poll (30s), early-exit no-op on re-entry, hard-capped records. We never
 * delete or prune anything — the panel is read-only.
 */

const DEFAULT_POLL_MS = 30_000;
const FIRST_SCAN_DELAY_MS = 8_000;
const DEFAULT_MAX_RECORDS = 32;
const MAX_ROOTS_PER_SCAN = 32;
const WORKTREE_SCAN_TIMEOUT_MS = 10_000;
const DIRTY_RECHECK_MS = 60_000;
const MAX_DIRTY_CHECKS_PER_SCAN = 8;

export interface ParsedWorktree {
  path: string;
  head: string | null;
  branch: string | null;
}

export interface WorktreeRegistryOptions {
  /** Folders the app knows about (project workspaces + live terminal cwds). */
  listRoots: () => string[];
  /** Poll interval. 30s — `git worktree list` is cheap and trees change slowly. */
  pollMs?: number;
  /** Cap on tracked session worktrees (memory bound). */
  maxRecords?: number;
  /** Injectable for tests. */
  gitFn?: (args: readonly string[], options: GitHelperOptions) => Promise<GitResult>;
  /** Injectable for tests — string-keyed lookup of "does this path exist". */
  pathExists?: (path: string) => Promise<boolean>;
  now?: () => number;
}

export interface WorktreeScanInput {
  records: readonly WorktreeRegistryEntry[];
  /** Repo root → worktree paths known at that root's first scan. */
  baselines: ReadonlyMap<string, ReadonlySet<string>>;
  /** Repo root → parsed `git worktree list --porcelain` for this scan. */
  scanned: ReadonlyMap<string, readonly ParsedWorktree[]>;
  /** path → still on disk (from stat); drives removal decisions. */
  onDisk: ReadonlyMap<string, boolean>;
  now: number;
  maxRecords?: number;
}

export interface WorktreeScanResult {
  records: WorktreeRegistryEntry[];
  baselines: Map<string, Set<string>>;
}

/**
 * Parse `git worktree list --porcelain`. Blank lines / `bare` / `detached`
 * markers are ignored; a `worktree` line starts the next record. Lines are not
 * trimmed so a path with whitespace survives.
 */
export function parseWorktreeList(output: string): ParsedWorktree[] {
  const out: ParsedWorktree[] = [];
  let current: ParsedWorktree | null = null;
  for (const line of output.split(/\r?\n/)) {
    if (line.startsWith("worktree ")) {
      if (current) out.push(current);
      current = { path: line.slice("worktree ".length), head: null, branch: null };
      continue;
    }
    if (!current) continue;
    if (line.startsWith("HEAD ")) {
      current.head = line.slice("HEAD ".length);
    } else if (line.startsWith("branch ")) {
      const ref = line.slice("branch ".length);
      current.branch = ref.startsWith("refs/heads/") ? ref.slice("refs/heads/".length) : ref;
    }
    // "bare" / "detached" / blank lines: nothing to extract.
  }
  if (current) out.push(current);
  return out;
}

/**
 * One scan's bookkeeping — pure, so the fixture unit test can drive it:
 * - a worktree path absent from the baseline set → session-created record
 * - a repo absent from the baselines map → its trees fold into the baseline
 * - a record whose path is no longer scanned AND not on disk → removed
 */
export function diffWorktreeScan(input: WorktreeScanInput): WorktreeScanResult {
  const maxRecords = input.maxRecords ?? DEFAULT_MAX_RECORDS;
  const nextRecords = new Map(input.records.map((record) => [record.path, record]));
  const nextBaselines = new Map<string, Set<string>>([...input.baselines].map(([root, paths]) => [root, new Set(paths)]));
  const branchByPath = new Map<string, string | null>();

  for (const [root, parsed] of input.scanned) {
    const hasBaseline = nextBaselines.has(root);
    for (const tree of parsed) {
      branchByPath.set(tree.path, tree.branch);
      if (!hasBaseline) {
        // Repo first seen this scan: its current trees predate the session.
        let set = nextBaselines.get(root);
        if (!set) {
          set = new Set<string>();
          nextBaselines.set(root, set);
        }
        set.add(tree.path);
        continue;
      }
      const baseline = nextBaselines.get(root)!;
      if (baseline.has(tree.path)) continue; // existed at the baseline scan
      if (nextRecords.has(tree.path)) continue; // already tracked
      if (nextRecords.size >= maxRecords) {
        baseline.add(tree.path); // cap hit: forget it silently, keep memory flat
        continue;
      }
      nextRecords.set(tree.path, {
        path: tree.path,
        branch: tree.branch,
        firstSeenAt: input.now,
        lastSeenAt: input.now,
        removed: false,
        dirty: null,
      });
    }
  }

  for (const record of nextRecords.values()) {
    const branch = branchByPath.get(record.path);
    if (branch !== undefined) {
      record.branch = branch;
      record.lastSeenAt = input.now;
      record.removed = false;
      continue;
    }
    // Not in any scan this time; lastSeenAt keeps the last real listing.
    // Removed only when the directory is really gone — a failed scan or a
    // pruned-but-on-disk tree keeps the record.
    if (input.onDisk.get(record.path) === false) {
      record.removed = true;
      continue;
    }
    record.removed = false;
  }

  return { records: [...nextRecords.values()], baselines: nextBaselines };
}

export class WorktreeRegistry {
  private readonly records = new Map<string, WorktreeRegistryEntry>();
  private readonly baselines = new Map<string, Set<string>>();
  private readonly dirtyCheckedAt = new Map<string, number>();
  private lastCheckedAt: number | null = null;
  private baselineCount = 0;
  private timer: ReturnType<typeof setInterval> | null = null;
  private refreshing = false;

  constructor(private readonly options: WorktreeRegistryOptions) {}

  start(): void {
    this.timer = setInterval(() => void this.refresh(), this.options.pollMs ?? DEFAULT_POLL_MS);
    this.timer.unref?.();
    // First scan is deferred: spawning git while the window is still coming up
    // stalled the renderer's frame pipeline (requestAnimationFrame never fired,
    // e2e clicks timed out waiting for "stable"). Measured 2026-10-13: an 8s
    // delay keeps frames flowing and later 30s polls are harmless.
    const first = setTimeout(() => void this.refresh().catch((error) => {
      logger.warn("app", "worktreeRegistry.scan.failed", "Worktree baseline scan failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    }), FIRST_SCAN_DELAY_MS);
    first.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.records.clear();
    this.baselines.clear();
    this.dirtyCheckedAt.clear();
    this.lastCheckedAt = null;
    this.baselineCount = 0;
  }

  /** Current registry state, session-created worktrees newest first. */
  list(): WorktreeRegistryActivity {
    const entries = [...this.records.values()].sort((a, b) => b.firstSeenAt - a.firstSeenAt);
    return {
      entries,
      baselineCount: this.baselineCount,
      lastCheckedAt: this.lastCheckedAt,
    };
  }

  /** One scan pass. Throttled by design (no-op while a scan is in flight). */
  async refresh(): Promise<void> {
    if (this.refreshing) return;
    this.refreshing = true;
    try {
      const now = (this.options.now ?? Date.now)();
      const roots = [...new Set(
        this.options.listRoots()
          .map((root) => (root && typeof root === "string" ? resolve(root) : null))
          .filter((root): root is string => root !== null)
          .map((root) => root.toLowerCase()),
      )].slice(0, MAX_ROOTS_PER_SCAN);
      const scanned = new Map<string, ParsedWorktree[]>();
      const gitFn = this.options.gitFn ?? git;
      for (const root of roots) {
        try {
          const result = await gitFn(["worktree", "list", "--porcelain"], {
            cwd: root,
            timeoutMs: WORKTREE_SCAN_TIMEOUT_MS,
          });
          scanned.set(root, parseWorktreeList(result.stdout));
        } catch {
          scanned.set(root, []); // not a repo / git missing: contributes nothing
        }
      }
      if (scanned.size === 0) return;

      // Cheap disk check for tracked session records (≤ maxRecords stat calls).
      const onDisk = new Map<string, boolean>();
      const existsFn = this.options.pathExists ?? ((path: string) => stat(path).then(() => true).catch(() => false));
      for (const path of this.records.keys()) {
        onDisk.set(path, await existsFn(path));
      }

      const diff = diffWorktreeScan({
        records: [...this.records.values()],
        baselines: this.baselines,
        scanned,
        onDisk,
        now,
        maxRecords: this.options.maxRecords ?? DEFAULT_MAX_RECORDS,
      });
      this.records.clear();
      for (const record of diff.records) this.records.set(record.path, record);
      for (const [root, paths] of diff.baselines) this.baselines.set(root, paths);
      this.baselineCount = 0;
      for (const paths of this.baselines.values()) this.baselineCount += paths.size;
      this.lastCheckedAt = now;

      await this.refreshDirty(now);
    } finally {
      this.refreshing = false;
    }
  }

  /** Throttled per-worktree dirty check: `git status --porcelain`. */
  private async refreshDirty(now: number): Promise<void> {
    const gitFn = this.options.gitFn ?? git;
    let checked = 0;
    for (const record of this.records.values()) {
      if (record.removed) continue;
      const lastAt = this.dirtyCheckedAt.get(record.path);
      if (lastAt !== undefined && now - lastAt < DIRTY_RECHECK_MS) continue;
      if (checked >= MAX_DIRTY_CHECKS_PER_SCAN) break;
      checked += 1;
      this.dirtyCheckedAt.set(record.path, now);
      try {
        const result = await gitFn(["status", "--porcelain"], {
          cwd: record.path,
          timeoutMs: WORKTREE_SCAN_TIMEOUT_MS,
        });
        record.dirty = result.stdout.trim().length > 0;
      } catch {
        record.dirty = null; // unknown state, shown as such
      }
    }
  }
}
