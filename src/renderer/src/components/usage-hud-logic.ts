export type UsageLevel = "none" | "cool" | "warn" | "crit";

/** Clamp provider used% into the 0-100 used quota displayed by the HUD. */
export function usedQuota(usedPercent: number | null | undefined): number | null {
  if (usedPercent === null || usedPercent === undefined || !Number.isFinite(usedPercent)) return null;
  return Math.max(0, Math.min(100, usedPercent));
}

/** Remaining quota (100 - used); the bar itself shows used, this stays in the tooltip. */
export function remainingQuota(usedPercent: number | null | undefined): number | null {
  if (usedPercent === null || usedPercent === undefined || !Number.isFinite(usedPercent)) return null;
  return Math.max(0, Math.min(100, 100 - usedPercent));
}

/** Used-quota colour contract (mirrors the Claude Code app): <=60 cool, <=85 warn, >85 crit. */
export function usageLevel(used: number | null): UsageLevel {
  if (used === null) return "none";
  if (used > 85) return "crit";
  if (used > 60) return "warn";
  return "cool";
}

/** A slot older than this is no longer a reading we are willing to show. */
export const USAGE_STALE_AFTER_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Age of a slot's source file in whole days, or null when it is still fresh.
 *
 * `updatedAt` is the source file's mtime, not "now". A stale slot means nobody
 * wrote the file (the Claude CLI only writes ~/.claude/usage-cache.json on a
 * real account session; a machine that lives on free proxy profiles never
 * refreshes it — measured: frozen 7 weeks at 60%). Showing that number as if
 * it were current quota is a lie, so the HUD renders it as no data; only the
 * hover tooltip names the age.
 *
 * An absent updatedAt is NOT stale: the Codex side can legitimately have no
 * mtime, and inventing "expired" for unknown data repeats the same mistake in
 * the other direction.
 */
export function staleAgeDays(
  updatedAtMs: number | null | undefined,
  nowMs: number = Date.now(),
): number | null {
  if (typeof updatedAtMs !== "number" || !Number.isFinite(updatedAtMs)) return null;
  const ageMs = nowMs - updatedAtMs;
  if (ageMs <= USAGE_STALE_AFTER_MS) return null;
  return Math.floor(ageMs / (24 * 60 * 60 * 1000));
}
