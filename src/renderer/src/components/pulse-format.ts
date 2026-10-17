/**
 * Pure pulse-panel formatting (2026-10-12 maintainer — find where the fat data is).
 * Kept out of SunMoonChrome.tsx so the unit tests can import it in a plain
 * node vitest environment (no react / no DOM at import time).
 */

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const digits = unit === 0 ? 0 : value >= 100 ? 0 : value >= 10 ? 1 : 2;
  return `${value.toFixed(digits)} ${units[unit]}`;
}

/**
 * How much an item grew this session, human readable ("+340 KB"); "" when it
 * did not grow (created files have baseline 0, so their whole size is growth).
 */
export function formatGrowthDelta(entry: { baselineSize: number; size: number }): string {
  const delta = entry.size - entry.baselineSize;
  return delta > 0 ? `+${formatBytes(delta)}` : "";
}

/** Sort key of the pulse file-list segmented control (2026-10-12 maintainer). */
export type PulseSortKey = "size" | "growth" | "time";
export type PulseSortDirection = "desc" | "asc";
/** Filter toggle: all files / only created this session / only modified. */
export type PulseFilterKind = "all" | "created" | "modified";

/** Structural subset of AgentFileEntry so tests need no shared import. */
export interface PulseSortEntry {
  baselineSize: number;
  size: number;
  mtimeMs: number;
  kind: "created" | "modified";
}

/** Resolved segmented-control state (one row in localStorage). */
export interface PulseSortPrefs {
  key: PulseSortKey;
  direction: PulseSortDirection;
  filter: PulseFilterKind;
}

const DEFAULT_PULSE_SORT_PREFS: PulseSortPrefs = {
  key: "size",
  direction: "desc",
  filter: "all",
};

const SORT_VALUE: Record<PulseSortKey, (entry: PulseSortEntry) => number> = {
  size: (entry) => entry.size,
  growth: (entry) => entry.size - entry.baselineSize,
  time: (entry) => entry.mtimeMs,
};

/** All vs created vs modified; "all" passes everything through. */
export function filterPulseEntries<T extends PulseSortEntry>(
  entries: readonly T[],
  filter: PulseFilterKind,
): T[] {
  if (filter === "all") return [...entries];
  return entries.filter((entry) => entry.kind === filter);
}

/**
 * 大小 desc＝大→小、成長 desc＝漲最多、時間 desc＝新→舊。Equal values keep
 * their input order (Array#sort is stable), so rows don't jump around while
 * the list refreshes every few seconds.
 */
export function sortPulseEntries<T extends PulseSortEntry>(
  entries: readonly T[],
  key: PulseSortKey,
  direction: PulseSortDirection,
): T[] {
  const value = SORT_VALUE[key];
  const sign = direction === "asc" ? 1 : -1;
  return [...entries].sort((a, b) => (value(a) - value(b)) * sign);
}

/**
 * Clicking the already-active key flips direction (大→小 ↔ 小→大; for time
 * 新→舊 ↔ 舊→新); activating a different key starts at that key's default
 * (descending — biggest / most growth / newest first).
 */
export function nextPulseSortDirection(
  currentKey: PulseSortKey,
  nextKey: PulseSortKey,
  direction: PulseSortDirection,
): PulseSortDirection {
  if (currentKey !== nextKey) return "desc";
  return direction === "desc" ? "asc" : "desc";
}

/** Arrow glyph on the active sort key: ↓ descending, ↑ ascending. */
export function pulseSortArrow(direction: PulseSortDirection): "↓" | "↑" {
  return direction === "desc" ? "↓" : "↑";
}

const SORT_STORAGE_KEY = "coterm.sidebar.pulse.sort";

function isPulseSortKey(value: unknown): value is PulseSortKey {
  return value === "size" || value === "growth" || value === "time";
}

function isPulseFilterKind(value: unknown): value is PulseFilterKind {
  return value === "all" || value === "created" || value === "modified";
}

/**
 * Persisted segmented-control choice; module tests and private windows have
 * no working localStorage, so every failure falls back per field (a corrupt
 * blob never loses all three settings when only one is garbled).
 */
export function readPulseSortPrefs(): PulseSortPrefs {
  try {
    const raw = localStorage.getItem(SORT_STORAGE_KEY);
    if (!raw) return { ...DEFAULT_PULSE_SORT_PREFS };
    const parsed = JSON.parse(raw) as Partial<PulseSortPrefs>;
    return {
      key: isPulseSortKey(parsed.key) ? parsed.key : "size",
      direction:
        parsed.direction === "asc" || parsed.direction === "desc" ? parsed.direction : "desc",
      filter: isPulseFilterKind(parsed.filter) ? parsed.filter : "all",
    };
  } catch {
    return { ...DEFAULT_PULSE_SORT_PREFS };
  }
}

/**
 * Safari private mode throws on storage writes — the choice then just
 * doesn't persist and the in-memory state drives the session.
 */
export function writePulseSortPrefs(prefs: PulseSortPrefs): void {
  try {
    localStorage.setItem(SORT_STORAGE_KEY, JSON.stringify(prefs));
  } catch {
    // Not persistable; keep the in-memory default.
  }
}
