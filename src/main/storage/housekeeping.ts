import { basename, join } from "node:path";
import { readdir, rm, rmdir, stat } from "node:fs/promises";

/**
 * Startup storage housekeeping: DB backup rotation, aged-file pruning, and
 * caps for app-owned dirs that would otherwise grow without bound. Pure
 * node:fs — no Electron imports — so it can run in the background off the
 * boot path without touching the app logger or any live surface.
 *
 * Iron rule: only delete things the app itself created and clearly stale.
 * Never touch the active ledger DB (ai-terminal.sqlite), its live WAL/SHM
 * sidecars, the session index DBs, or current profile configs.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

/** Any -wal / -shm / -journal sidecar of ANY database is a tripwire. */
const SIDECAR_RE = /-(wal|shm|journal)$/i;
/** Files inside a codex home that must survive every sweep. */
const CODEX_KEEP_FILES = new Set(["config.toml", "auth.json"]);
/** Deepest directory recursion for size collection / pruning. */
const MAX_DEPTH = 8;

interface FileMeta {
  path: string;
  size: number;
  mtimeMs: number;
  home: string;
}

export interface SweepSummary {
  name: string;
  scanned: number;
  kept?: number;
  deleted: number;
  freedBytes: number;
}

export interface StorageHousekeepingSummary {
  sweeps: SweepSummary[];
  totalDeleted: number;
  totalFreedBytes: number;
  durationMs: number;
}

export interface StorageHousekeepingOptions {
  ledgerPath: string;
  userDataPath: string;
  now?: number;
}

/**
 * Tripwire for names that must never be deleted by any sweep below. The two
 * ledger staging siblings (.restore / .before-restore) are intentionally NOT
 * listed — rotateDatabaseBackups manages them by name.
 */
function isTripwire(name: string): boolean {
  if (SIDECAR_RE.test(name)) return true;
  if (name === "ai-terminal.sqlite") return true;
  if (name === "session-index.db") return true;
  if (name.endsWith(".search-index.sqlite")) return true;
  if (name.endsWith("-journal")) return true;
  return false;
}

/** Recursively collect file metadata under dir (bounded depth). Never throws. */
async function collectFiles(dir: string, out: FileMeta[], home: string, depth = 0): Promise<number> {
  if (depth > MAX_DEPTH) return 0;
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  let count = 0;
  for (const entry of entries) {
    if (isTripwire(entry.name)) continue;
    const p = join(dir, entry.name);
    if (entry.isFile()) {
      const info = await stat(p).catch(() => null);
      if (!info) continue;
      out.push({ path: p, size: info.size, mtimeMs: info.mtimeMs, home });
      count += 1;
    } else if (entry.isDirectory()) {
      count += await collectFiles(p, out, home, depth + 1);
    }
  }
  return count;
}

/** Total bytes of all files under dir. Never throws. */
async function dirSize(dir: string): Promise<number> {
  const files: FileMeta[] = [];
  await collectFiles(dir, files, dir);
  return files.reduce((sum, f) => sum + f.size, 0);
}

/** Newest mtime among dir's files (0 if none). Never throws. */
async function newestMtime(dir: string): Promise<number> {
  const files: FileMeta[] = [];
  await collectFiles(dir, files, dir);
  return files.reduce((newest, f) => (f.mtimeMs > newest ? f.mtimeMs : newest), 0);
}

/** Recursively delete now-empty child directories (never the dir itself). */
async function removeEmptyDirs(dir: string): Promise<void> {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (isTripwire(entry.name)) continue;
    const p = join(dir, entry.name);
    await removeEmptyDirs(p);
    const remaining = await readdir(p).catch(() => null);
    if (remaining && remaining.length === 0) await rmdir(p).catch(() => undefined);
  }
}

async function deleteFile(path: string): Promise<boolean> {
  return rm(path).then(
    () => true,
    () => false,
  );
}

async function deleteDir(path: string): Promise<boolean> {
  return rm(path, { recursive: true, force: true }).then(
    () => true,
    () => false,
  );
}

export interface RotateBackupsOptions extends StorageHousekeepingOptions {
  keep?: number;
}

/**
 * Keep only the newest `keep` DB backups and delete older ones after a
 * successful new backup. Candidate pool = legacy top-level `bak-*` files in
 * userData + the ledger's `.before-restore` recovery copy; a stale `.restore`
 * staging copy is always removed. The active ledger is never touched.
 */
export async function rotateDatabaseBackups(options: RotateBackupsOptions): Promise<SweepSummary> {
  const { ledgerPath, userDataPath } = options;
  const keep = Math.max(1, options.keep ?? 2);
  const candidates: FileMeta[] = [];

  const entries = await readdir(userDataPath, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.startsWith("bak-") || isTripwire(entry.name)) continue;
    const p = join(userDataPath, entry.name);
    const info = await stat(p).catch(() => null);
    if (info) candidates.push({ path: p, size: info.size, mtimeMs: info.mtimeMs, home: userDataPath });
  }
  const beforeRestore = `${ledgerPath}.before-restore`;
  const bInfo = await stat(beforeRestore).catch(() => null);
  if (bInfo) candidates.push({ path: beforeRestore, size: bInfo.size, mtimeMs: bInfo.mtimeMs, home: userDataPath });

  let deleted = 0;
  let freedBytes = 0;

  // A leftover .restore staging copy is always stale once restore() finished.
  const staleRestore = `${ledgerPath}.restore`;
  const rInfo = await stat(staleRestore).catch(() => null);
  if (rInfo && (await deleteFile(staleRestore))) {
    deleted += 1;
    freedBytes += rInfo.size;
  }

  candidates.sort((a, b) => b.mtimeMs - a.mtimeMs); // newest first
  const keepPaths = new Set(candidates.slice(0, keep).map((c) => c.path));
  for (const candidate of candidates) {
    if (keepPaths.has(candidate.path)) continue;
    if (await deleteFile(candidate.path)) {
      deleted += 1;
      freedBytes += candidate.size;
    }
  }
  return { name: "db-backups", scanned: candidates.length, kept: keepPaths.size, deleted, freedBytes };
}

export interface PruneAgedOptions {
  dir: string;
  maxAgeMs: number;
  now?: number;
}

/**
 * Recursively delete files older than maxAgeMs (live-voice artifacts 30d,
 * uploads 7d) and remove directories left empty. Only ever called on dirs
 * the app itself creates.
 */
export async function pruneAgedFiles(options: PruneAgedOptions): Promise<SweepSummary> {
  const { dir, maxAgeMs } = options;
  const now = options.now ?? Date.now();
  const cutoff = now - maxAgeMs;
  const files: FileMeta[] = [];
  const scanned = await collectFiles(dir, files, dir);
  let deleted = 0;
  let freedBytes = 0;
  for (const file of files) {
    if (file.mtimeMs >= cutoff) continue;
    if (await deleteFile(file.path)) {
      deleted += 1;
      freedBytes += file.size;
    }
  }
  await removeEmptyDirs(dir);
  return { name: `aged:${basename(dir)}`, scanned, deleted, freedBytes };
}

export interface PruneCodexOptions {
  userDataPath: string;
  homeCapBytes?: number;
  totalCapBytes?: number;
  deadProfiles?: string[];
  minAgeMs?: number;
  now?: number;
}

/**
 * Cap the codex-homes dir (evaluation B-3): per-home 100 MB / global 300 MB,
 * oldest files first. `codex-local-max` (archived forever-off profile) is deleted
 * outright. config.toml / auth.json and anything touched inside minAgeMs are
 * never candidates, so an active profile keeps its credentials and today's
 * session state no matter how large the sweep.
 */
export async function pruneCodexHomes(options: PruneCodexOptions): Promise<SweepSummary> {
  const {
    userDataPath,
    homeCapBytes = 100 * 1024 * 1024,
    totalCapBytes = 300 * 1024 * 1024,
    deadProfiles = ["codex-local-max"],
    minAgeMs = DAY_MS,
  } = options;
  const now = options.now ?? Date.now();
  const root = join(userDataPath, "codex-homes");
  const dirEntries = (await readdir(root, { withFileTypes: true }).catch(() => [])).filter((d) => d.isDirectory());

  let scanned = 0;
  let deleted = 0;
  let freedBytes = 0;

  // Dead profiles go outright, regardless of size.
  const deadSet = new Set(deadProfiles);
  for (const entry of dirEntries) {
    if (!deadSet.has(entry.name)) continue;
    const p = join(root, entry.name);
    const size = await dirSize(p);
    if (await deleteDir(p)) {
      deleted += 1;
      freedBytes += size;
    }
  }

  // Surviving homes: prune oldest-first under per-home cap, then global cap.
  const homes = (await readdir(root, { withFileTypes: true }).catch(() => []))
    .filter((d) => d.isDirectory() && !deadSet.has(d.name))
    .map((d) => join(root, d.name));

  const prunableByHome = new Map<string, FileMeta[]>();
  const homeTotals = new Map<string, number>();
  for (const home of homes) {
    const prunable: FileMeta[] = [];
    scanned += await collectFiles(home, prunable, home);
    homeTotals.set(home, await dirSize(home));
    prunableByHome.set(
      home,
      prunable
        .filter((f) => !CODEX_KEEP_FILES.has(basename(f.path)) && f.mtimeMs < now - minAgeMs)
        .sort((a, b) => a.mtimeMs - b.mtimeMs), // oldest first
    );
  }

  const deletions = new Set<string>();
  let grandTotal = [...homeTotals.values()].reduce((s, v) => s + v, 0);

  for (const [home, prunable] of prunableByHome) {
    let remaining = homeTotals.get(home) ?? 0;
    for (const file of prunable) {
      if (remaining <= homeCapBytes) break;
      deletions.add(file.path);
      remaining -= file.size;
    }
  }
  const globalPool = [...prunableByHome.values()].flat().sort((a, b) => a.mtimeMs - b.mtimeMs);
  for (const file of globalPool) {
    if (grandTotal <= totalCapBytes) break;
    if (deletions.has(file.path)) continue;
    deletions.add(file.path);
    grandTotal -= file.size;
  }

  const sizeByPath = new Map<string, number>();
  for (const prunable of prunableByHome.values()) {
    for (const file of prunable) sizeByPath.set(file.path, file.size);
  }
  for (const path of deletions) {
    if (await deleteFile(path)) {
      deleted += 1;
      freedBytes += sizeByPath.get(path) ?? 0;
    }
  }
  return { name: "codex-homes", scanned, deleted, freedBytes };
}

export interface PruneBrowserOptions {
  userDataPath: string;
  capBytes?: number;
  minAgeMs?: number;
  now?: number;
}

/**
 * Cap the browser-profiles dir (evaluation B-3): 50 MB total, oldest session
 * profile first. A profile touched inside minAgeMs is skipped even if it is
 * the oldest — an automation run from yesterday must survive the sweep.
 */
export async function pruneBrowserProfiles(options: PruneBrowserOptions): Promise<SweepSummary> {
  const { userDataPath, capBytes = 50 * 1024 * 1024, minAgeMs = DAY_MS } = options;
  const now = options.now ?? Date.now();
  const root = join(userDataPath, "browser-profiles");
  const dirEntries = (await readdir(root, { withFileTypes: true }).catch(() => [])).filter((d) => d.isDirectory());

  let scanned = 0;
  const metas: { dir: string; size: number; touchedAt: number }[] = [];
  for (const entry of dirEntries) {
    const p = join(root, entry.name);
    const size = await dirSize(p);
    const touchedAt = Math.max(await newestMtime(p), (await stat(p).catch(() => null))?.mtimeMs ?? 0);
    metas.push({ dir: p, size, touchedAt });
    scanned += 1;
  }

  let deleted = 0;
  let freedBytes = 0;
  let total = metas.reduce((s, m) => s + m.size, 0);
  metas.sort((a, b) => a.touchedAt - b.touchedAt); // oldest-touched first
  for (const meta of metas) {
    if (total <= capBytes) break;
    if (meta.touchedAt >= now - minAgeMs) continue; // fresh: never touch
    if (await deleteDir(meta.dir)) {
      deleted += 1;
      freedBytes += meta.size;
      total -= meta.size;
    }
  }
  return { name: "browser-profiles", scanned, deleted, freedBytes };
}

/**
 * Runs every startup sweep once, off the boot path. Never throws per sweep;
 * a failing sweep degrades to zero on its own line of the summary.
 */
export async function runStorageHousekeeping(options: StorageHousekeepingOptions): Promise<StorageHousekeepingSummary> {
  const startedAt = Date.now();
  const { ledgerPath, userDataPath } = options;
  const sweeps: SweepSummary[] = [];
  const zero = (name: string): SweepSummary => ({ name, scanned: 0, deleted: 0, freedBytes: 0 });

  const push = async (label: string, run: () => Promise<SweepSummary>): Promise<void> => {
    try {
      sweeps.push(await run());
    } catch {
      sweeps.push(zero(label));
    }
  };

  // live-voice/ holds only the cached livekit-server.exe (no recordings) — an
  // age sweep would just force a ~50MB re-download, so it is left alone.
  await push("aged:uploads", () => pruneAgedFiles({ dir: join(userDataPath, "uploads"), maxAgeMs: 7 * DAY_MS }));
  await push("codex-homes", () => pruneCodexHomes({ userDataPath }));
  await push("browser-profiles", () => pruneBrowserProfiles({ userDataPath }));
  await push("db-backups", () => rotateDatabaseBackups({ ledgerPath, userDataPath, keep: 2 }));

  return {
    sweeps,
    totalDeleted: sweeps.reduce((s, w) => s + w.deleted, 0),
    totalFreedBytes: sweeps.reduce((s, w) => s + w.freedBytes, 0),
    durationMs: Date.now() - startedAt,
  };
}

export const HOUSEKEEPING_DIR_NAMES = {
  codexHomes: "codex-homes",
  browserProfiles: "browser-profiles",
  liveVoice: "live-voice",
  uploads: "uploads",
} as const;
