import { watch, type FSWatcher } from "node:fs";
import { stat } from "node:fs/promises";
import { cpus, freemem, homedir, totalmem } from "node:os";
import { join, parse, resolve, sep } from "node:path";
import type { AgentFileKind, AgentFileActivity, SystemActivity } from "@shared/types";
import { logger } from "../core/logger";

/**
 * Sidebar "machine pulse" (sunmoon skin, 2026-10-03 maintainer): CPU / RAM load plus
 * how much the agents have written since Coterm started.
 *
 * Agent output = files under the live terminals' working folders that were
 * created or modified after launch and still exist (a temp file the agent
 * deleted again drops out). One recursive fs.watch per folder
 * (ReadDirectoryChangesW on Windows — no polling), events are batched and
 * stat'ed every FLUSH_MS. `.git` and `node_modules` are skipped (git object
 * churn and package installs would drown the signal), and so are drive roots
 * and the home folder (AppData churn is not agent work).
 *
 * listFiles() feeds the click-to-expand file list (2026-10-06 maintainer): per file
 * size, mtime and created-vs-modified (`kind` — birthtime on/after launch ⇒
 * created; unknown birthtime also ⇒ created, because a file only enters the
 * map via a post-launch watch event). Largest first (2026-10-12 maintainer — find
 * where the fat data is), newest modification as the tiebreaker.
 *
 * Per-file growth (2026-10-12 maintainer): each tracked file carries `baselineSize` —
 * 0 for created files, the size at first sight for modified ones — so the
 * renderer can show how much the item grew this session without extra stat
 * calls (the baseline rides the flush that was already happening). The map is
 * capped at `maxTrackedFiles` entries: beyond the cap new files are skipped
 * (no eviction churn, memory stays bounded).
 *
 * Logging is metadata-only (§A.2): counts, never paths.
 */

const FLUSH_MS = 2_000;
const MAX_PENDING = 20_000;
const MAX_ROOTS = 16;
export const MAX_LIST_FILES = 500;
const DEFAULT_MAX_TRACKED_FILES = 5_000;
const IGNORED_SEGMENTS = new Set([".git", "node_modules"]);

export interface ActivityMonitorOptions {
  /** Working folders of the live terminals (duplicates/garbage tolerated). */
  listRoots: () => string[];
  /** Cap on tracked files (memory bound). Skip new files beyond the cap. */
  maxTrackedFiles?: number;
  now?: () => number;
}

function normalizeRoot(input: string): string | null {
  if (!input || typeof input !== "string") return null;
  const full = resolve(input);
  const parsed = parse(full);
  if (full === parsed.root || full.replace(/[\\/]+$/, "") === parsed.root.replace(/[\\/]+$/, "")) return null;
  const home = resolve(homedir());
  if (full.toLowerCase() === home.toLowerCase()) return null;
  return full;
}

/** True when a watcher-relative path walks through an ignored folder. */
export function isIgnoredActivityPath(relativePath: string): boolean {
  return relativePath.split(/[\\/]/).some((segment) => IGNORED_SEGMENTS.has(segment));
}

export class ActivityMonitor {
  private readonly startedAt: number;
  private readonly watchers = new Map<string, FSWatcher>();
  private readonly files = new Map<string, { baselineSize: number; size: number; mtimeMs: number; kind: AgentFileKind }>();
  private readonly pending = new Set<string>();
  private readonly maxTrackedFiles: number;
  private flushTimer: ReturnType<typeof setInterval> | null = null;
  private flushing = false;
  private lastCpu: { idle: number; total: number } | null = null;
  private stopped = false;

  constructor(private readonly options: ActivityMonitorOptions) {
    this.startedAt = (options.now ?? Date.now)();
    this.maxTrackedFiles = Math.max(1, Math.floor(options.maxTrackedFiles ?? DEFAULT_MAX_TRACKED_FILES) || DEFAULT_MAX_TRACKED_FILES);
  }

  start(): void {
    this.stopped = false;
    this.lastCpu = sampleCpu();
    this.flushTimer = setInterval(() => void this.flush(), FLUSH_MS);
    this.flushTimer.unref?.();
  }

  stop(): void {
    this.stopped = true;
    if (this.flushTimer) clearInterval(this.flushTimer);
    this.flushTimer = null;
    for (const watcher of this.watchers.values()) watcher.close();
    this.watchers.clear();
    this.pending.clear();
  }

  getSnapshot(): SystemActivity {
    this.syncRoots();
    const cpu = sampleCpu();
    let cpuPercent: number | null = null;
    if (this.lastCpu && cpu.total > this.lastCpu.total) {
      const busy = 1 - (cpu.idle - this.lastCpu.idle) / (cpu.total - this.lastCpu.total);
      cpuPercent = Math.round(Math.max(0, Math.min(1, busy)) * 100);
    }
    this.lastCpu = cpu;
    const memTotalBytes = totalmem();
    const memUsedBytes = Math.max(0, memTotalBytes - freemem());
    let agentBytes = 0;
    // "Produced this session": a new file counts in full, an existing file only
    // by how much it grew — otherwise touching one big old file (a database,
    // a log) would add its whole size to the total.
    for (const file of this.files.values()) {
      agentBytes += file.kind === "created" ? file.size : Math.max(0, file.size - file.baselineSize);
    }
    return {
      cpuPercent,
      memPercent: memTotalBytes > 0 ? Math.round((memUsedBytes / memTotalBytes) * 100) : 0,
      memUsedBytes,
      memTotalBytes,
      agentFiles: this.files.size,
      agentBytes,
      watchedRoots: this.watchers.size,
      since: this.startedAt,
    };
  }

  /**
   * Per-file view for the sidebar file list, largest first (newest
   * modification as the tiebreaker), capped at `limit`. `total` is the
   * uncapped count so the UI can say "N more".
   */
  listFiles(limit = MAX_LIST_FILES): AgentFileActivity {
    const capped = Math.max(1, Math.min(MAX_LIST_FILES, Math.floor(limit) || MAX_LIST_FILES));
    const entries = [...this.files.entries()].map(([path, file]) => ({ path, ...file }));
    entries.sort((a, b) => (b.size - a.size) || (b.mtimeMs - a.mtimeMs));
    return { files: entries.slice(0, capped), total: entries.length };
  }

  /** Watch exactly the current terminal folders (nested folders share the outer watcher). */
  private syncRoots(): void {
    if (this.stopped) return;
    const wanted = [...new Set(this.options.listRoots().map(normalizeRoot).filter((root): root is string => root !== null))]
      .sort((a, b) => a.length - b.length);
    const roots: string[] = [];
    for (const root of wanted) {
      const lower = root.toLowerCase();
      if (roots.some((outer) => lower.startsWith(outer.toLowerCase() + sep))) continue;
      roots.push(root);
      if (roots.length >= MAX_ROOTS) break;
    }
    for (const [root, watcher] of this.watchers) {
      if (!roots.includes(root)) {
        watcher.close();
        this.watchers.delete(root);
      }
    }
    for (const root of roots) {
      if (this.watchers.has(root)) continue;
      try {
        const watcher = watch(root, { recursive: true, persistent: false }, (_event, filename) => {
          if (!filename || this.pending.size >= MAX_PENDING) return;
          const relative = filename.toString();
          if (isIgnoredActivityPath(relative)) return;
          this.pending.add(join(root, relative));
        });
        watcher.on("error", () => {
          watcher.close();
          this.watchers.delete(root);
        });
        this.watchers.set(root, watcher);
      } catch (error) {
        logger.warn("app", "activity.watch.failed", "Activity watcher could not start", {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  private async flush(): Promise<void> {
    if (this.flushing || this.pending.size === 0) return;
    this.flushing = true;
    const batch = [...this.pending];
    this.pending.clear();
    try {
      for (const path of batch) {
        // Memory cap: already-tracked files keep updating, but no new entries
        // beyond the cap (no eviction churn; the list forgets small files).
        if (!this.files.has(path) && this.files.size >= this.maxTrackedFiles) continue;
        try {
          const info = await stat(path);
          if (!info.isFile()) continue;
          if (info.mtimeMs >= this.startedAt || info.birthtimeMs >= this.startedAt) {
            const kind: AgentFileKind =
              info.birthtimeMs <= 0 || info.birthtimeMs >= this.startedAt ? "created" : "modified";
            // Baseline = size at FIRST sight: 0 for created files, the current
            // size the first time a modified file enters the map. Later flushes
            // update size/mtime but keep the baseline, so the delta is "how
            // much this item grew this session".
            const baselineSize = kind === "created" ? 0 : info.size;
            const existing = this.files.get(path);
            this.files.set(path, {
              baselineSize: existing?.baselineSize ?? baselineSize,
              size: info.size,
              mtimeMs: info.mtimeMs,
              kind,
            });
          }
        } catch {
          this.files.delete(path);
        }
      }
    } finally {
      this.flushing = false;
    }
  }
}

function sampleCpu(): { idle: number; total: number } {
  let idle = 0;
  let total = 0;
  for (const cpu of cpus()) {
    const times = cpu.times;
    idle += times.idle;
    total += times.user + times.nice + times.sys + times.idle + times.irq;
  }
  return { idle, total };
}
