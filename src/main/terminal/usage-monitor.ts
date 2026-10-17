import { readdir, stat, open, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { UsageSlot, UsageSnapshot } from "@shared/types";
import { logger } from "../core/logger";

/**
 * Global paid-account usage HUD. Every 10s reads LOCAL-ONLY files (no network,
 * no cookies) for the two official backends and publishes a single snapshot
 * the TopBar renders on desktop/web/mobile alike.
 *
 * - Claude: C:/Users/Example/.claude/usage-cache.json → five_hour + seven_day
 *   (already a percentage + resets_at epoch seconds).
 * - Codex: newest rollout-*.jsonl under ~/.codex/sessions/YYYY/MM/DD/ whose
 *   payload.type==="token_count" carries rate_limits.primary. We pick the
 *   entry whose primary.window_minutes===10080 (weekly) and surface
 *   used_percent + resets_at.
 *
 * Parsers are fault-tolerant (missing file / malformed JSON / absent fields →
 * that slot is null, shown as "--"). Percentages are clamped to 0–100.
 * Logging is metadata-only (§A.2): never the file body, just source + age.
 */

const POLL_INTERVAL_MS = 10_000;

/**
 * Claude freshness contract: the on-disk usage-cache is written only by the
 * official CLI on a real account session — a machine living on free proxy
 * profiles never refreshes it (measured: frozen 53 days). When the file is
 * stale, Coterm fetches the OAuth usage endpoint itself (same source the CLI
 * uses) and keeps the result IN MEMORY; it never overwrites the CLI's cache
 * file. If neither source yields fresh data the slots keep their file mtime,
 * so the HUD marks them 「過期 N 天」 — an honest stale flag, never a frozen
 * number wearing a "current" costume (work-order red line).
 */
const CLAUDE_FILE_FRESH_MS = 15 * 60_000;
const CLAUDE_REFRESH_MIN_INTERVAL_MS = 5 * 60_000;
const CLAUDE_USAGE_ENDPOINT = "https://api.anthropic.com/api/oauth/usage";
const OAUTH_BETA_HEADER = "oauth-2025-04-20";
/** Re-fetch skew: don't ride a token into its last half minute. */
const TOKEN_EXPIRY_SKEW_MS = 30_000;

export interface UsageMonitorOptions {
  events: { emit(event: "usageChanged", payload: UsageSnapshot): void };
  /** Override for tests. Defaults to ~/.claude/usage-cache.json. */
  claudeCachePath?: string;
  /** Override for tests. Defaults to ~/.codex/sessions. */
  codexSessionsRoot?: string;
  /** Override for tests. Defaults to ~/.claude/.credentials.json. */
  claudeCredentialsPath?: string;
  /** Override the OAuth usage endpoint (tests). */
  claudeUsageEndpoint?: string;
  /** fetch injection for tests. */
  fetchImpl?: typeof fetch;
  /** Clock injection for tests. Defaults to Date.now. */
  now?: () => number;
  /** Override poll interval (ms) for tests. */
  intervalMs?: number;
}

export class UsageMonitor {
  private timer: NodeJS.Timeout | null = null;
  private polling = false;
  private snapshot: UsageSnapshot = emptySnapshot();
  private readonly claudeCachePath: string;
  private readonly codexSessionsRoot: string;
  private readonly claudeCredentialsPath: string;
  private readonly claudeUsageEndpoint: string;
  private readonly intervalMs: number;
  /** Last network refresh ATTEMPT (success or failure) — throttles the API. */
  private lastRefreshAttemptAt = 0;
  /** Newest successful OAuth usage read; served while fresher than the file. */
  private refreshed: { result: ClaudeResult; fetchedAt: number } | null = null;

  constructor(private readonly options: UsageMonitorOptions) {
    this.claudeCachePath = options.claudeCachePath ?? join(homedir(), ".claude", "usage-cache.json");
    this.codexSessionsRoot = options.codexSessionsRoot ?? join(homedir(), ".codex", "sessions");
    this.claudeCredentialsPath = options.claudeCredentialsPath
      ?? join(homedir(), ".claude", ".credentials.json");
    this.claudeUsageEndpoint = options.claudeUsageEndpoint ?? CLAUDE_USAGE_ENDPOINT;
    this.intervalMs = options.intervalMs ?? POLL_INTERVAL_MS;
  }

  start(): void {
    if (this.timer) return;
    void this.tick();
    this.timer = setInterval(() => { void this.tick(); }, this.intervalMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  getSnapshot(): UsageSnapshot {
    return this.snapshot;
  }

  private async tick(): Promise<void> {
    if (this.polling) return;
    this.polling = true;
    try {
      const [claude, codex] = await Promise.all([
        this.readClaudeSlots().catch(() => null),
        readCodexUsage(this.codexSessionsRoot).catch(() => null),
      ]);
      const next: UsageSnapshot = {
        claude5h: claude?.fiveHour ?? null,
        claude7d: claude?.sevenDay ?? null,
        codex7d: codex ?? null,
        fetchedAt: Date.now(),
      };
      const changed = !sameSnapshot(this.snapshot, next);
      this.snapshot = next;
      if (changed) {
        this.options.events.emit("usageChanged", next);
      }
    } finally {
      this.polling = false;
    }
  }

  /**
   * Claude slots, freshest-trustworthy-first: a recent in-memory OAuth refresh,
   * then a fresh on-disk cache, then (when the file is stale) ONE throttled
   * OAuth usage call, then whatever the stale file holds (the HUD renders its
   * age honestly). Network runs at most once per CLAUDE_REFRESH_MIN_INTERVAL_MS
   * and only while the stored OAuth token is unexpired; a Mac-style Keychain
   * credential store simply yields a missing file and no refresh.
   */
  private async readClaudeSlots(): Promise<ClaudeResult | null> {
    const now = (this.options.now ?? Date.now)();
    if (this.refreshed && now - this.refreshed.fetchedAt < CLAUDE_REFRESH_MIN_INTERVAL_MS) {
      return this.refreshed.result;
    }
    const fileResult = await readClaudeUsage(this.claudeCachePath);
    const fileUpdatedAt = fileResult ? newestSlotMtime(fileResult) : null;
    if (fileResult && fileUpdatedAt !== null && now - fileUpdatedAt < CLAUDE_FILE_FRESH_MS) {
      return fileResult;
    }
    if (now - this.lastRefreshAttemptAt < CLAUDE_REFRESH_MIN_INTERVAL_MS) {
      return fileResult;
    }
    const token = await readClaudeAccessToken(this.claudeCredentialsPath, now);
    if (!token) return fileResult;
    this.lastRefreshAttemptAt = now;
    const fetched = await this.fetchClaudeUsage(token, now);
    if (fetched) {
      this.refreshed = { result: fetched, fetchedAt: now };
      return fetched;
    }
    return fileResult;
  }

  private async fetchClaudeUsage(token: string, now: number): Promise<ClaudeResult | null> {
    const fetchImpl = this.options.fetchImpl ?? fetch;
    let response: Awaited<ReturnType<typeof fetch>>;
    try {
      response = await fetchImpl(this.claudeUsageEndpoint, {
        headers: {
          authorization: `Bearer ${token}`,
          "anthropic-beta": OAUTH_BETA_HEADER,
          "content-type": "application/json",
        },
        signal: AbortSignal.timeout(10_000),
      });
    } catch (error) {
      logger.warn("pty", "usage.claude.refresh.networkFailed", "Claude usage refresh request failed", {
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
    if (!response.ok) {
      // 401 = token went stale between check and call; 429/5xx = transient.
      // Either way the file (and its honest stale marker) stays the source.
      logger.warn("pty", "usage.claude.refresh.rejected", "Claude usage endpoint rejected the refresh", {
        status: response.status,
      });
      return null;
    }
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      return null;
    }
    return parseClaudeUsageEndpoint(body, now);
  }
}

function emptySnapshot(): UsageSnapshot {
  return { claude5h: null, claude7d: null, codex7d: null, fetchedAt: 0 };
}

function sameSnapshot(a: UsageSnapshot, b: UsageSnapshot): boolean {
  return slotEq(a.claude5h, b.claude5h) && slotEq(a.claude7d, b.claude7d) && slotEq(a.codex7d, b.codex7d);
}

function slotEq(a: UsageSlot | null, b: UsageSlot | null): boolean {
  if (a == null || b == null) return a == null && b == null;
  return a.percent === b.percent && a.resetAt === b.resetAt && a.updatedAt === b.updatedAt && a.source === b.source;
}

function clampPercent(value: unknown): number | null {
  const n = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  if (!Number.isFinite(n)) return null;
  return Math.max(0, Math.min(100, n));
}

interface ClaudeResult {
  fiveHour: UsageSlot | null;
  sevenDay: UsageSlot | null;
}

/**
 * Parse ~/.claude/usage-cache.json. Shape (observed 2026-07):
 *   { fetchedAt, rate_limits: { five_hour: {used_percentage, resets_at},
 *                               seven_day: {used_percentage, resets_at} } }
 * fetchedAt + resets_at are epoch seconds. Returns null slots when the file
 * is missing or the shape is unexpected.
 */
export async function readClaudeUsage(cachePath: string): Promise<ClaudeResult | null> {
  let raw: string;
  let mtimeMs: number;
  try {
    raw = await readFile(cachePath, "utf8");
    mtimeMs = (await stat(cachePath)).mtimeMs;
  } catch {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  const root = parsed as Record<string, unknown> | null;
  const limits = root?.rate_limits;
  if (!limits || typeof limits !== "object") return null;
  const table = limits as Record<string, unknown>;
  return {
    fiveHour: claudeSlot(table.five_hour, "claude", mtimeMs),
    sevenDay: claudeSlot(table.seven_day, "claude", mtimeMs),
  };
}

/** Newest mtime carried by a ClaudeResult's slots (they share one file). */
function newestSlotMtime(result: ClaudeResult): number | null {
  const times = [result.fiveHour?.updatedAt, result.sevenDay?.updatedAt]
    .filter((value): value is number => typeof value === "number" && Number.isFinite(value));
  return times.length > 0 ? Math.max(...times) : null;
}

/**
 * Read the OAuth access token from ~/.claude/.credentials.json shape:
 * { claudeAiOauth: { accessToken, expiresAt } }. Returns null when the file
 * is missing (e.g. macOS Keychain storage), malformed, or the token is inside
 * its expiry skew — an unrefreshable token is not worth an API round trip.
 * Coterm deliberately does NOT run the OAuth refresh flow or write back to
 * this file: credential rotation belongs to the official CLI alone.
 */
export async function readClaudeAccessToken(
  credentialsPath: string,
  nowMs: number,
): Promise<string | null> {
  let raw: string;
  try {
    raw = await readFile(credentialsPath, "utf8");
  } catch {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  const oauth = (parsed as Record<string, unknown> | null)?.claudeAiOauth;
  if (!oauth || typeof oauth !== "object") return null;
  const entry = oauth as Record<string, unknown>;
  const token = entry.accessToken;
  const expiresAt = entry.expiresAt;
  if (typeof token !== "string" || !token) return null;
  if (typeof expiresAt === "number" && Number.isFinite(expiresAt)
    && expiresAt <= nowMs + TOKEN_EXPIRY_SKEW_MS) {
    return null;
  }
  return token;
}

/**
 * Parse the OAuth usage endpoint response into ClaudeResult. Shape (observed
 * 2026-09): { five_hour: { utilization, resets_at }, seven_day: {...} } where
 * utilization is a used-percentage float and resets_at an ISO-8601 timestamp.
 * Slots whose window entry is missing/malformed degrade independently to
 * null; updatedAt = fetch time (this is fresh network data, not a file).
 */
export function parseClaudeUsageEndpoint(body: unknown, nowMs: number): ClaudeResult | null {
  if (!body || typeof body !== "object") return null;
  const table = body as Record<string, unknown>;
  const fiveHour = endpointSlot(table.five_hour, nowMs);
  const sevenDay = endpointSlot(table.seven_day, nowMs);
  if (!fiveHour && !sevenDay) return null;
  return { fiveHour, sevenDay };
}

function endpointSlot(entry: unknown, nowMs: number): UsageSlot | null {
  if (!entry || typeof entry !== "object") return null;
  const e = entry as Record<string, unknown>;
  const percent = clampPercent(e.utilization);
  if (percent === null) return null;
  let resetAt: number | null = null;
  if (typeof e.resets_at === "string") {
    const parsed = Date.parse(e.resets_at);
    if (Number.isFinite(parsed)) resetAt = Math.floor(parsed / 1000);
  }
  return { percent, resetAt, updatedAt: nowMs, source: "claude" };
}

function claudeSlot(entry: unknown, source: "claude" | "codex", mtimeMs: number): UsageSlot | null {
  if (!entry || typeof entry !== "object") return null;
  const e = entry as Record<string, unknown>;
  const percent = clampPercent(e.used_percentage);
  if (percent === null) return null;
  const resetAt = typeof e.resets_at === "number" && Number.isFinite(e.resets_at) ? e.resets_at : null;
  return { percent, resetAt, updatedAt: mtimeMs, source };
}

/**
 * Find the newest Codex rollout-*.jsonl under sessionsRoot and extract the
 * last token_count record whose rate_limits.primary.window_minutes===10080
 * (weekly). Walks the tail newest-first so a huge transcript is not fully
 * scanned. Returns null when no matching record is found.
 *
 * payload shape: { type: "token_count", rate_limits: { primary|secondary:
 * { used_percent, window_minutes, resets_at } } }. Codex can assign the weekly
 * window to either slot depending on the account/plan.
 */
export async function readCodexUsage(sessionsRoot: string): Promise<UsageSlot | null> {
  const newest = await findNewestRollout(sessionsRoot);
  if (!newest) return null;
  const slot = await readCodexRolloutTail(newest.file);
  if (slot) return slot;
  return null;
}

/** Resolve the most-recently-modified rollout-*.jsonl under sessionsRoot. */
export async function findNewestRollout(
  sessionsRoot: string,
): Promise<{ file: string; mtimeMs: number } | null> {
  // Codex nests sessions/YYYY/MM/DD/rollout-*.jsonl. Walk year dirs newest-first.
  let years: string[];
  try {
    years = await readdir(sessionsRoot);
  } catch {
    return null;
  }
  const yearStats = await statsFor(sessionsRoot, years);
  yearStats.sort((a, b) => b.mtimeMs - a.mtimeMs);
  for (const year of yearStats) {
    const months = await listDirs(year.path);
    months.sort((a, b) => b.mtimeMs - a.mtimeMs);
    for (const month of months) {
      const days = await listDirs(month.path);
      days.sort((a, b) => b.mtimeMs - a.mtimeMs);
      for (const day of days) {
        const files = await listRollouts(day.path);
        files.sort((a, b) => b.mtimeMs - a.mtimeMs);
        if (files.length > 0) return files[0]!;
      }
    }
  }
  return null;
}

async function listDirs(parent: string): Promise<Array<{ path: string; mtimeMs: number }>> {
  let names: string[];
  try {
    names = await readdir(parent);
  } catch {
    return [];
  }
  return statsFor(parent, names);
}

async function listRollouts(parent: string): Promise<Array<{ file: string; path: string; mtimeMs: number }>> {
  let names: string[];
  try {
    names = await readdir(parent);
  } catch {
    return [];
  }
  const out: Array<{ file: string; path: string; mtimeMs: number }> = [];
  for (const name of names) {
    if (!name.startsWith("rollout-") || !name.endsWith(".jsonl")) continue;
    const file = join(parent, name);
    try {
      out.push({ file, path: parent, mtimeMs: (await stat(file)).mtimeMs });
    } catch {
      // vanished between readdir and stat — skip
    }
  }
  return out;
}

async function statsFor(parent: string, names: string[]): Promise<Array<{ path: string; mtimeMs: number }>> {
  const out: Array<{ path: string; mtimeMs: number }> = [];
  for (const name of names) {
    const path = join(parent, name);
    try {
      const info = await stat(path);
      if (info.isDirectory()) out.push({ path, mtimeMs: info.mtimeMs });
    } catch {
      // skip
    }
  }
  return out;
}

/**
 * Stream the tail of a Codex rollout jsonl and return the most recent
 * token_count record whose primary window is weekly (10080 min). Pure-ish:
 * takes the file path + an optional mtime (callers pass the rollout's mtime
 * so the slot's updatedAt reflects the source file, not "now").
 */
export async function readCodexRolloutTail(
  file: string,
  mtimeMs?: number,
): Promise<UsageSlot | null> {
  let fileMtime: number | null = mtimeMs ?? null;
  if (fileMtime === null) {
    try {
      fileMtime = (await stat(file)).mtimeMs;
    } catch {
      fileMtime = null;
    }
  }
  // Read the tail as text (rollouts can be large; the last token_count is
  // what we want, and it is emitted near the end of a session).
  const info = await stat(file).catch(() => null);
  if (!info) return null;
  const start = Math.max(0, info.size - 256 * 1024);
  const handle = await open(file, "r").catch(() => null);
  if (!handle) return null;
  let text: string;
  try {
    const buf = Buffer.alloc(Math.min(256 * 1024, info.size));
    const { bytesRead } = await handle.read(buf, 0, buf.length, start);
    text = buf.subarray(0, bytesRead).toString("utf8");
  } finally {
    await handle.close();
  }
  const lines = text.split("\n");
  if (start > 0 && lines.length > 1) lines.shift();
  // newest-first: last token_count with weekly window wins.
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (!line) continue;
    let record: unknown;
    try {
      record = JSON.parse(line);
    } catch {
      continue;
    }
    const slot = parseCodexTokenCount(record, fileMtime ?? null);
    if (slot) return slot;
  }
  return null;
}

/**
 * Parse one Codex rollout jsonl record into a weekly UsageSlot, or null.
 * Exported for unit testing with hand-written records.
 */
export function parseCodexTokenCount(record: unknown, updatedAt: number | null): UsageSlot | null {
  if (!record || typeof record !== "object") return null;
  const r = record as Record<string, unknown>;
  const payload = r.payload;
  if (!payload || typeof payload !== "object") return null;
  const p = payload as Record<string, unknown>;
  if (p.type !== "token_count") return null;
  const limits = p.rate_limits;
  if (!limits || typeof limits !== "object") return null;
  const rl = limits as Record<string, unknown>;
  for (const candidate of [rl.primary, rl.secondary]) {
    if (!candidate || typeof candidate !== "object") continue;
    const window = candidate as Record<string, unknown>;
    if (window.window_minutes !== 10080) continue;
    const percent = clampPercent(window.used_percent);
    if (percent === null) continue;
    const resetAt = typeof window.resets_at === "number" && Number.isFinite(window.resets_at)
      ? window.resets_at
      : null;
    return { percent, resetAt, updatedAt, source: "codex" };
  }
  return null;
}
