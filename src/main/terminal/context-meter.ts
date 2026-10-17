import { open, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { createReadStream } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { MYQWEN_CLAUDE_CONTEXT_WINDOW } from "@shared/types";
import { resolveCodexProfileSpec, type CodexProfileSource } from "@shared/codex-profiles";
import type { PtyManager } from "./pty-manager";
import { readCodexSessionMeta } from "./session-file-resolver";
import { logger } from "../core/logger";

/**
 * Clean-view transcript reader + context battery for trustworthy session-local
 * usage (official Claude/Codex).
 *
 * The context battery is metadata-only: every 10s ContextBatteryMonitor reads
 * each metered agent terminal's own session file and pushes
 * used/window token counts onto TerminalInfo via PtyManager.setContextUsage.
 * Free proxy profiles (claude-local-main/qwen, codex-local-main) get NO battery — their
 * usage reports are unreliable, so we hide it rather than mislead.
 *
 * Nothing here logs raw PTY or conversation bodies to coterm.log — the file
 * is only read in-memory to extract token counts (logging §A.2).
 */

/** A user/assistant message extracted from a Claude Code session jsonl. */
export interface TranscriptMessage {
  role: "user" | "assistant";
  text: string;
  timestamp: string;
}

const BATTERY_POLL_INTERVAL_MS = 10_000;
const TAIL_BYTES = 64_000;

/** A fixed home map (tests) or a getter re-read each poll (main, #92). */
export type CodexProfileHomesSource =
  | Partial<Record<string, string>>
  | (() => Partial<Record<string, string>>);

export interface ContextBatteryOptions {
  terminals: Pick<PtyManager, "dashboardSnapshot" | "setContextUsage" | "setAgentSummaryTitle" | "setAgentRecap">;
  /** Override ~/.claude/projects root for tests. */
  projectsRoot?: string;
  /** Override ~/.codex/sessions root for tests. */
  codexSessionsRoot?: string;
  /** Override ~/.codex/state_5.sqlite for tests. */
  codexStateDbPath?: string;
  /**
   * Per-profile CODEX_HOME overrides. A FUNCTION is re-read on every poll so a
   * profile hot-registered after launch is metered from its own home (#92);
   * tests and custom launcher installs pass a plain object.
   */
  codexProfileHomes?: CodexProfileHomesSource;
  /** Hot model registry (stage 2): ACTIVE custom-profile table — registered
   *  codex- entries are metered by isContextMeterProfile. */
  getCustomProfiles?: () => Record<string, CodexProfileSource> | null;
  /** Where the learned per-profile context tier is persisted (userData). */
  claudeTierCachePath?: string;
  /** Override poll interval for tests. */
  intervalMs?: number;
}

export interface ContextUsage {
  usedTokens: number;
  model: string | null;
}

/**
 * Polls live metered agent terminals every 10s and pushes context-window usage
 * onto TerminalInfo. GLM/Qwen profiles stay hidden because their usage is not
 * a trustworthy per-session measure.
 *
 * Claude: with a nativeSessionId, read the EXACT ~/.claude/projects/<munged
 * cwd>/<id>.jsonl — never fall back to another session. used = input +
 * cache_read + cache_creation + output (the four Claude token buckets are
 * mutually exclusive and all consume window space).
 *
 * Codex: resolve THIS terminal's own rollout. With a bound id, exact file;
 * fresh (no id yet), match by session_meta cwd + session start timestamp
 * against the terminal's cwd/startedAt, pick the closest file not earlier
 * than the terminal start within a tolerance, and cache the binding. used =
 * last_token_usage.input_tokens + output_tokens (input already contains the
 * cached subset — do not add cached_input_tokens again). window =
 * model_context_window from the same record.
 */
export class ContextBatteryMonitor {
  private timer: NodeJS.Timeout | null = null;
  private readonly projectsRoot: string;
  private readonly codexSessionsRoot: string;
  private readonly codexStateDbPath: string;
  private readonly intervalMs: number;
  /** terminalId → exact Codex rollout + its matching state DB. */
  private readonly codexBinding = new Map<string, { file: string; stateDbPath: string }>();
  /**
   * mtime short-check: once a terminal's session file is bound, the 10s poll
   * only stats it; the 64KB tail-read (claude usage/recap, codex usage) and
   * the Codex state-DB title lookup run only when the file mtime actually
   * moved. The title DB gets its own mtime gate because a generated title can
   * land in threads while the rollout is idle. Keeping this per-terminal (not
   * per-file) means a rebound session re-reads once.
   */
  private readonly claudeReads = new Map<string, { file: string; mtimeMs: number }>();
  private readonly codexReads = new Map<string, { file: string; fileMtimeMs: number; dbMtimeMs: number }>();
  /**
   * Learned per-profile context tier (#79). The 200k-vs-1M tier is an
   * ACCOUNT property, and the transcript model id carries no tier marker —
   * so once any session on the profile is observed past 200k, every other
   * session on that profile is on the 1M tier too. Without this, a 1M
   * session under 200k shows 5x inflated usage (92.8% that is really 18.6%).
   * Persisted so a restart does not reset the learning. null = not loaded yet.
   */
  private claudeTierCache: Record<string, number> | null = null;

  constructor(private readonly options: ContextBatteryOptions) {
    this.projectsRoot = options.projectsRoot ?? join(homedir(), ".claude", "projects");
    this.codexSessionsRoot = options.codexSessionsRoot ?? join(homedir(), ".codex", "sessions");
    this.codexStateDbPath = options.codexStateDbPath ?? join(homedir(), ".codex", "state_5.sqlite");
    this.intervalMs = options.intervalMs ?? BATTERY_POLL_INTERVAL_MS;
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

  private async tick(): Promise<void> {
    let snapshots: ReturnType<PtyManager["dashboardSnapshot"]>;
    try {
      snapshots = this.options.terminals.dashboardSnapshot();
    } catch {
      return;
    }
    const customProfiles = this.options.getCustomProfiles?.() ?? null;
    const tracked = snapshots.filter(
      (s) => isContextMeterProfile(s.info.agentProfile, customProfiles) || isClaudeTitleProfile(s.info.agentProfile) || isCodexTitleProfile(s.info.agentProfile),
    );
    const activeCodexIds = new Set(
      tracked
        .filter((s) => isCodexTitleProfile(s.info.agentProfile))
        .map((s) => s.info.id),
    );
    for (const terminalId of this.codexBinding.keys()) {
      if (!activeCodexIds.has(terminalId)) this.codexBinding.delete(terminalId);
    }
    const activeIds = new Set(tracked.map((s) => s.info.id));
    for (const terminalId of this.claudeReads.keys()) {
      if (!activeIds.has(terminalId)) this.claudeReads.delete(terminalId);
    }
    for (const terminalId of this.codexReads.keys()) {
      if (!activeIds.has(terminalId)) this.codexReads.delete(terminalId);
    }

    // Resolve sequentially so two same-cwd terminals cannot race and bind the
    // same fresh rollout during one poll.
    for (const s of tracked) {
      try {
        await this.measureOne(
          s.info.id,
          s.info.agentProfile!,
          s.info.cwd,
          s.info.nativeSessionId,
          s.info.startedAt,
        );
      } catch (error) {
        logger.warn("pty", "contextBattery.measure.failed", "Context battery read failed", {
          terminalId: s.info.id,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  private async loadClaudeTierCache(): Promise<Record<string, number>> {
    if (this.claudeTierCache) return this.claudeTierCache;
    const cache: Record<string, number> = {};
    const path = this.options.claudeTierCachePath;
    if (path) {
      try {
        const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
        if (parsed && typeof parsed === "object") {
          for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
            // Only the 1M tier is ever learned — anything else is ignored.
            if (value === 1_000_000) cache[key] = 1_000_000;
          }
        }
      } catch {
        // Missing or corrupt cache — start empty, learning re-fills it.
      }
    }
    this.claudeTierCache = cache;
    return cache;
  }

  private learnClaudeTier(profile: string, tiers: Record<string, number>): void {
    if (tiers[profile] === 1_000_000) return;
    tiers[profile] = 1_000_000;
    const path = this.options.claudeTierCachePath;
    if (!path) return;
    void writeFile(path, JSON.stringify(tiers)).catch(() => undefined);
  }

  private async measureOne(
    terminalId: string,
    agentProfile: string,
    cwd: string,
    nativeSessionId: string | null,
    startedAt: string,
  ): Promise<void> {
    if (!cwd) return;
    if (agentProfile.startsWith("claude-")) {
      // Claude needs a nativeSessionId for exact resolution; without it we
      // do not guess (cwd+mtime collides across same-project agent panes).
      if (!nativeSessionId) return;
      const resolved = await resolveLatestSessionJsonl(cwd, this.projectsRoot, nativeSessionId);
      if (!resolved) return;
      // mtime short-check: an unchanged session file yields the same recap and
      // usage as last poll — skip the two tail-reads.
      const lastRead = this.claudeReads.get(terminalId);
      if (lastRead && lastRead.file === resolved.file && lastRead.mtimeMs === resolved.mtimeMs) {
        return;
      }
      // The recap goes to its own field. It used to be written into
      // agentSummaryTitle, which the pane header reads — a null recap (the
      // normal case) then blanked the amber header summary, and a recap
      // carrying proxy error text pasted that over it instead.
      const recap = await readClaudeRecap(resolved.file);
      this.options.terminals.setAgentRecap(terminalId, recap);
      // Mark the file as read BEFORE the meter gate — without it an unmetered
      // proxy pane would skip the mtime short-check and re-read on every poll.
      this.claudeReads.set(terminalId, resolved);
      // Profile gate: only metered claude profiles (official / window-pinned
      // like claude-local-long2) may light the battery. Proxy free windows
      // (claude-local-main, claude-local-big…) resolve a real jsonl and report usage, but
      // their window is not pinned, so showing a battery there is the v1.5.46
      // regression — codex half has had this gate from the start.
      if (!isContextMeterProfile(agentProfile, this.options.getCustomProfiles?.() ?? null)) return;
      const usage = await readClaudeContextUsage(resolved.file);
      if (!usage) return;
      const tiers = await this.loadClaudeTierCache();
      let window = claudeContextWindow(usage.model);
      // Observed usage above the preset proves the preset is too small for THIS
      // session (measured: claude-opus-4-8 sitting at 253,590 tokens against a
      // 200k preset — the old code clamped that to a fake 100% "empty battery"
      // while the session was healthy). Anthropic ships exactly two window
      // tiers, so a session over 200k is running the 1M tier; promote instead
      // of clamping. Above 1M there is no larger tier to promote to, so fall
      // back to null (renderer shows a grey "?" — never a fake full battery).
      if (agentProfile === "claude-official" && window !== null && usage.usedTokens > window) {
        window = usage.usedTokens <= 1_000_000 ? 1_000_000 : null;
        if (window === 1_000_000) this.learnClaudeTier(agentProfile, tiers);
      } else if (
        agentProfile === "claude-official"
        && window === 200_000
        && tiers[agentProfile] === 1_000_000
      ) {
        // #79: account was already observed on the 1M tier — apply it below
        // the 200k crossing too, or every such session overreports 5x.
        window = 1_000_000;
      }
      const percent = window ? Math.min(100, (usage.usedTokens / window) * 100) : null;
      this.options.terminals.setContextUsage(terminalId, usage.usedTokens, window, percent, usage.model);
      return;
    }
    // codex-official
    const resolved = await this.resolveCodexRollout(terminalId, agentProfile, cwd, nativeSessionId, startedAt);
    if (!resolved) return;
    // mtime short-check: stat the rollout and its title DB; skip the tail-read
    // / SQLite title lookup while both are unchanged since the last poll.
    const fileInfo = await stat(resolved.file).catch(() => null);
    if (!fileInfo) return;
    const dbInfo = await stat(resolved.stateDbPath).catch(() => null);
    const dbMtimeMs = dbInfo?.mtimeMs ?? 0;
    const lastRead = this.codexReads.get(terminalId);
    const fileChanged = !lastRead || lastRead.file !== resolved.file
      || lastRead.fileMtimeMs !== fileInfo.mtimeMs;
    // A bound-file switch must re-read the title even if the DB is untouched
    // (the title key is the rollout's thread UUID).
    const dbChanged = !lastRead || dbMtimeMs !== lastRead.dbMtimeMs
      || lastRead.file !== resolved.file;
    if (fileChanged || dbChanged) {
      if (dbChanged) {
        const title = readCodexThreadTitle(resolved.stateDbPath, resolved.file, cwd);
        this.options.terminals.setAgentSummaryTitle(terminalId, title);
      }
      // All Codex-family profiles get their generated title, but GLM/Qwen keep
      // the existing no-battery contract because proxy usage is not trustworthy.
      if (fileChanged
        && isContextMeterProfile(agentProfile, this.options.getCustomProfiles?.() ?? null)) {
        const usage = await readCodexContextUsage(resolved.file);
        if (usage) {
          const windowTokens = usage.windowTokens;
          const percent = windowTokens ? Math.min(100, (usage.usedTokens / windowTokens) * 100) : null;
          this.options.terminals.setContextUsage(
            terminalId,
            usage.usedTokens,
            windowTokens,
            percent,
            usage.model,
          );
        }
      }
      this.codexReads.set(terminalId, {
        file: resolved.file,
        fileMtimeMs: fileInfo.mtimeMs,
        dbMtimeMs,
      });
    }
  }

  /**
   * Resolve this terminal's own Codex rollout. With a bound id (cached or
   * nativeSessionId), exact file. Fresh launch: scan today's rollouts, match
   * by session_meta.cwd against the terminal cwd and a session start
   * timestamp not earlier than the terminal start (within a tolerance), pick
   * the closest, and cache the binding. Never falls back to global newest.
   */
  private async resolveCodexRollout(
    terminalId: string,
    agentProfile: string,
    cwd: string,
    nativeSessionId: string | null,
    startedAt: string,
  ): Promise<{ file: string; stateDbPath: string } | null> {
    const bound = this.codexBinding.get(terminalId);
    if (bound) {
      // Still exists?
      if (await stat(bound.file).then(() => true).catch(() => false)) return bound;
      this.codexBinding.delete(terminalId);
    }
    const startedMs = Date.parse(startedAt);
    if (!Number.isFinite(startedMs)) return null;
    const storage = this.codexStorage(agentProfile);
    const candidates = await listRecentCodexRollouts(storage.sessionsRoot, startedMs);
    const reserved = new Set(
      [...this.codexBinding.entries()]
        .filter(([id]) => id !== terminalId)
        .map(([, value]) => value.file.toLowerCase()),
    );

    // Resumed Codex sessions expose their native id; the rollout filename ends
    // with that UUID, which is stronger evidence than cwd/timestamp matching.
    if (nativeSessionId) {
      const suffix = `-${nativeSessionId.toLowerCase()}.jsonl`;
      const exact = candidates.find(
        (candidate) => candidate.file.toLowerCase().endsWith(suffix)
          && !reserved.has(candidate.file.toLowerCase()),
      );
      if (exact) {
        const next = { file: exact.file, stateDbPath: storage.stateDbPath };
        this.codexBinding.set(terminalId, next);
        return next;
      }
    }

    const matches: Array<{ file: string; diff: number }> = [];
    for (const candidate of candidates) {
      if (reserved.has(candidate.file.toLowerCase())) continue;
      const meta = await readCodexSessionMeta(candidate.file);
      if (!meta) continue;
      // cwd must match (case-insensitive, normalized separators).
      const metaCwd = meta.cwd?.replace(/\\/g, "/").toLowerCase();
      const termCwd = cwd.replace(/\\/g, "/").toLowerCase();
      if (!metaCwd || metaCwd !== termCwd) continue;
      // Allow a small clock/spawn skew in either direction, but choose by
      // absolute distance. A signed comparison made an older same-cwd session
      // incorrectly beat the terminal's own newer rollout.
      const diff = Math.abs(meta.startedAtMs - startedMs);
      if (diff > 120_000) continue;
      matches.push({ file: candidate.file, diff });
    }
    if (matches.length === 0) return null;
    matches.sort((a, b) => a.diff - b.diff);
    const best = matches[0]!;
    const runnerUp = matches[1];
    // Two same-cwd sessions launched within a few seconds are not reliably
    // distinguishable without a native id. Prefer a blank header to leaking
    // another pane's title across windows.
    if (runnerUp && runnerUp.diff - best.diff < 5_000) return null;
    const next = { file: best.file, stateDbPath: storage.stateDbPath };
    this.codexBinding.set(terminalId, next);
    return next;
  }

  /** The home map for THIS poll — getter form re-reads the live profile table. */
  private codexProfileHomes(): Partial<Record<string, string>> {
    const source = this.options.codexProfileHomes;
    if (!source) return {};
    return typeof source === "function" ? source() : source;
  }

  private codexStorage(agentProfile: string): { sessionsRoot: string; stateDbPath: string } {
    return resolveCodexStorage(agentProfile, this.codexProfileHomes(), {
      sessionsRoot: this.codexSessionsRoot,
      stateDbPath: this.codexStateDbPath,
    });
  }
}

/**
 * Where a Codex profile keeps its rollouts + state DB: its private CODEX_HOME
 * (profile homes map or the codex-local-main/codex-local-long env fallbacks) or the shared
 * default home. Exported so other readers of threads metadata (e.g. the
 * sidebar history name resolver) follow the exact same home routing instead
 * of hard-assuming ~/.codex.
 */
export function resolveCodexStorage(
  agentProfile: string,
  profileHomes: Partial<Record<string, string>>,
  defaults: { sessionsRoot: string; stateDbPath: string },
): { sessionsRoot: string; stateDbPath: string } {
  const explicit = profileHomes[agentProfile]?.trim();
  let profileHome = explicit || "";
  if (!profileHome && agentProfile === "codex-local-main") {
    profileHome = process.env.COTERM_CODEX_HOME?.trim() ?? "";
  } else if (!profileHome && agentProfile === "codex-local-long") {
    profileHome = process.env.COTERM_CODEX_LONG_HOME?.trim()
      || (process.env.COTERM_PROXY_DIR?.trim()
        ? join(process.env.COTERM_PROXY_DIR.trim(), "codex_long")
        : "");
  }
  return profileHome
    ? { sessionsRoot: join(profileHome, "sessions"), stateDbPath: join(profileHome, "state_5.sqlite") }
    : defaults;
}

const MAX_CODEX_HEADER_TITLE_CHARS = 96;

/**
 * Shortest title that can be rejected as a prompt echo. A generated Codex title
 * is a rephrase; the state DB's fallback is the raw first prompt, which it may
 * truncate before storing — so a truncated prompt is a PREFIX of
 * first_user_message and is not caught by the exact-equality filter alone
 * (#92: a 36-char truncated prompt passed as a summary). The length floor keeps
 * a genuinely short title that happens to open the prompt from being discarded.
 */
const MIN_PROMPT_ECHO_CHARS = 16;

/**
 * True when `title` is just the opening of the raw prompt/preview — the state
 * DB's pre-title fallback wearing a summary's clothes. Compared case-folded on
 * whitespace-collapsed text so a casing/whitespace rewrite still matches.
 */
export function isPromptEchoTitle(
  title: string,
  prompt: string | null,
  preview: string | null,
): boolean {
  if (Array.from(title).length < MIN_PROMPT_ECHO_CHARS) return false;
  const needle = title.toLocaleLowerCase();
  return [prompt, preview].some((source) =>
    Boolean(source && source.toLocaleLowerCase().startsWith(needle)),
  );
}

/** Collapse a Codex task title to one safe header line. The state DB may use
 * the full first prompt until its generated title arrives; bounded truncation
 * keeps that fallback from swallowing the whole pane header. */
export function normalizeCodexThreadTitle(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const clean = value.replace(/\s+/gu, " ").trim();
  if (!clean) return null;
  const chars = Array.from(clean);
  return chars.length <= MAX_CODEX_HEADER_TITLE_CHARS
    ? clean
    : `${chars.slice(0, MAX_CODEX_HEADER_TITLE_CHARS - 1).join("")}…`;
}

/** Read the title for one already-bound rollout. Exact rollout_path is the
 * primary key in practice; UUID is the fallback for path-normalization drift.
 * This is read-only metadata access and deliberately returns no prompt body. */
export function readCodexThreadTitle(stateDbPath: string, rolloutFile: string, cwd?: string | null): string | null {
  let db: DatabaseSync | null = null;
  try {
    db = new DatabaseSync(stateDbPath, { readOnly: true });
    const columns = new Set(
      (db.prepare("PRAGMA table_info(threads)").all() as Array<{ name?: unknown }>)
        .map((row) => typeof row.name === "string" ? row.name : "")
        .filter(Boolean),
    );
    if (!columns.has("id")) return null;
    const match = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/iu.exec(rolloutFile);
    const threadId = match?.[1] ?? "";
    const select = ["name", "title", "first_user_message", "preview", "cwd", "rollout_path"]
      .filter((column) => columns.has(column));
    if (!select.includes("name") && !select.includes("title")) return null;
    const rolloutPredicate = columns.has("rollout_path") ? "rollout_path = ? OR " : "";
    const order = columns.has("rollout_path")
      ? "ORDER BY CASE WHEN rollout_path = ? THEN 0 ELSE 1 END"
      : "";
    const statement = db.prepare(
      `SELECT ${select.join(", ")}
       FROM threads
       WHERE ${rolloutPredicate}id = ?
       ${order}
       LIMIT 1`,
    );
    const row = (columns.has("rollout_path")
      ? statement.get(rolloutFile, threadId, rolloutFile)
      : statement.get(threadId)) as {
      name?: unknown;
      title?: unknown;
      first_user_message?: unknown;
      preview?: unknown;
      cwd?: unknown;
    } | undefined;
    if (!row) return null;
    const name = normalizeCodexThreadTitle(row.name);
    if (name) return name;
    const title = normalizeCodexThreadTitle(row.title);
    if (!title) return null;
    const firstPrompt = normalizeCodexThreadTitle(row.first_user_message);
    const preview = normalizeCodexThreadTitle(row.preview);
    const stateCwd = typeof row.cwd === "string" && row.cwd.trim() ? row.cwd.trim() : cwd;
    const cwdName = stateCwd?.replace(/[\\/]+$/, "").split(/[\\/]/).pop()?.trim() ?? "";
    const placeholders = new Set([
      firstPrompt?.toLocaleLowerCase(),
      preview?.toLocaleLowerCase(),
      cwdName.toLocaleLowerCase(),
      "codex", "shell", "powershell", "pwsh", "cmd", "bash", "zsh", "untitled", "new thread", "new chat",
    ].filter((value): value is string => Boolean(value)));
    if (placeholders.has(title.toLocaleLowerCase())) return null;
    // #92: a truncated prompt stored in `title` is a prefix of the prompt, not
    // an exact match — show nothing rather than a prompt masquerading as the
    // session summary.
    if (isPromptEchoTitle(title, firstPrompt, preview)) return null;
    return title;
  } catch {
    // Older Codex builds may not have state_5.sqlite/threads yet. Header keeps
    // its OSC fallback; the 10s poll will pick the title up after migration.
    return null;
  } finally {
    db?.close();
  }
}

/** Claude header contract: only a provider-authored recap is eligible. The
 * current Claude transcript schema emits it as system/away_summary content.
 * We inspect only the bounded tail and never log or persist transcript text. */
export async function readClaudeRecap(file: string): Promise<string | null> {
  const info = await stat(file).catch(() => null);
  if (!info) return null;
  const start = Math.max(0, info.size - TAIL_BYTES);
  const handle = await open(file, "r").catch(() => null);
  if (!handle) return null;
  const text = await (async () => {
    try {
      const buf = Buffer.alloc(Math.min(TAIL_BYTES, info.size));
      const { bytesRead } = await handle.read(buf, 0, buf.length, start);
      return buf.subarray(0, bytesRead).toString("utf8");
    } finally {
      await handle.close();
    }
  })();
  const lines = text.split("\n");
  if (start > 0 && lines.length > 1) lines.shift();
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]?.trim();
    if (!line) continue;
    try {
      const record = JSON.parse(line) as { type?: unknown; subtype?: unknown; content?: unknown };
      if (record.type !== "system" || record.subtype !== "away_summary" || typeof record.content !== "string") continue;
      const recap = record.content.replace(/\s+/gu, " ").trim();
      if (!recap) continue;
      return Array.from(recap).slice(0, 180).join("");
    } catch {
      // Partial/corrupt tail line: continue to earlier records.
    }
  }
  return null;
}

/**
 * Read the tail of a Claude session jsonl and return the most recent usage
 * record. usedTokens = input + cache_read + cache_creation + output (the four
 * buckets are mutually exclusive and all consume context-window space).
 * model comes from message.model on the same or nearest earlier record.
 * Returns null when no positive usage total is found in the tail.
 */
export async function readClaudeContextUsage(file: string): Promise<ContextUsage | null> {
  const info = await stat(file).catch(() => null);
  if (!info) return null;
  const start = Math.max(0, info.size - TAIL_BYTES);
  const handle = await open(file, "r").catch(() => null);
  if (!handle) return null;
  let text: string;
  try {
    const buf = Buffer.alloc(Math.min(TAIL_BYTES, info.size));
    const { bytesRead } = await handle.read(buf, 0, buf.length, start);
    text = buf.subarray(0, bytesRead).toString("utf8");
  } finally {
    await handle.close();
  }
  const lines = text.split("\n");
  if (start > 0 && lines.length > 1) lines.shift();
  let lastModel: string | null = null;
  let latestUsage: number | null = null;
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (!line) continue;
    let record: unknown;
    try {
      record = JSON.parse(line);
    } catch {
      continue;
    }
    // Task subagents carry their own context window; mixing their usage into
    // the main thread's battery would falsely inflate it. Skip sidechain rows.
    if ((record as Record<string, unknown> | null)?.isSidechain === true) continue;
    const message = (record as Record<string, unknown> | null)?.message;
    if (!message || typeof message !== "object") continue;
    const msg = message as Record<string, unknown>;
    if (typeof msg.model === "string" && msg.model && msg.model !== "<synthetic>" && lastModel === null) {
      lastModel = msg.model;
    }
    const usage = msg.usage;
    if (!usage || typeof usage !== "object") continue;
    const u = usage as Record<string, unknown>;
    // Claude's four token buckets are mutually exclusive — sum all of them.
    const total =
      numOrZero(u.input_tokens) +
      numOrZero(u.cache_read_input_tokens) +
      numOrZero(u.cache_creation_input_tokens) +
      numOrZero(u.output_tokens);
    if (total > 0 && latestUsage === null) latestUsage = total;
    if (latestUsage !== null && lastModel !== null) {
      return { usedTokens: latestUsage, model: lastModel };
    }
  }
  if (latestUsage !== null) return { usedTokens: latestUsage, model: lastModel };
  return null;
}

interface CodexContextUsage {
  usedTokens: number;
  windowTokens: number | null;
  model: string | null;
}

/**
 * Read the tail of a Codex rollout jsonl and return the most recent
 * token_count record's usage. used = last_token_usage.input_tokens +
 * output_tokens (input already contains the cached subset — do not add
 * cached_input_tokens again). window = model_context_window. model from
 * payload.info.model. Returns null when no token_count is found.
 */
export async function readCodexContextUsage(file: string): Promise<CodexContextUsage | null> {
  const info = await stat(file).catch(() => null);
  if (!info) return null;
  const start = Math.max(0, info.size - TAIL_BYTES);
  const handle = await open(file, "r").catch(() => null);
  if (!handle) return null;
  let text: string;
  try {
    const buf = Buffer.alloc(Math.min(TAIL_BYTES, info.size));
    const { bytesRead } = await handle.read(buf, 0, buf.length, start);
    text = buf.subarray(0, bytesRead).toString("utf8");
  } finally {
    await handle.close();
  }
  const lines = text.split("\n");
  if (start > 0 && lines.length > 1) lines.shift();
  let model: string | null = null;
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (!line) continue;
    let record: unknown;
    try {
      record = JSON.parse(line);
    } catch {
      continue;
    }
    const r = record as Record<string, unknown> | null;
    if (!r) continue;
    const payload = r.payload as Record<string, unknown> | undefined;
    if (!payload || payload.type !== "token_count") continue;
    // Real Codex rollout shape is payload.info.last_token_usage (not a
    // payload.last_token_usage sibling). Keep the parser aligned with the
    // production JSONL rather than a synthetic approximation.
    const infoObj = payload.info as Record<string, unknown> | undefined;
    const last = infoObj?.last_token_usage as Record<string, unknown> | undefined;
    if (!last) continue;
    const input = numOrZero(last.input_tokens);
    const output = numOrZero(last.output_tokens);
    // input_tokens already includes the cached subset; do NOT add
    // cached_input_tokens again (would double-count).
    const used = input + output;
    if (used <= 0) continue;
    const window = numOrPositive(infoObj?.model_context_window) ?? null;
    if (typeof infoObj?.model === "string" && infoObj.model) model = infoObj.model;
    return { usedTokens: used, windowTokens: window, model };
  }
  return null;
}

/**
 * List Codex rollout files modified within a recent window of the terminal
 * start (so a fresh launch only scans today's dir, not the whole tree).
 * Returns newest-first by mtime.
 */
async function listRecentCodexRollouts(
  sessionsRoot: string,
  startedMs: number,
): Promise<Array<{ file: string; mtimeMs: number }>> {
  // Scan only the nearby YYYY/MM/DD dirs (local and UTC) to tolerate timezone
  // drift without walking years of rollout history every 10 seconds.
  const out: Array<{ file: string; mtimeMs: number }> = [];
  const dayPaths = new Set<string>();
  for (const dayOffset of [-1, 0, 1]) {
    const date = new Date(startedMs + dayOffset * 86_400_000);
    dayPaths.add(join(
      sessionsRoot,
      String(date.getFullYear()),
      String(date.getMonth() + 1).padStart(2, "0"),
      String(date.getDate()).padStart(2, "0"),
    ));
    dayPaths.add(join(
      sessionsRoot,
      String(date.getUTCFullYear()),
      String(date.getUTCMonth() + 1).padStart(2, "0"),
      String(date.getUTCDate()).padStart(2, "0"),
    ));
  }
  for (const dayPath of dayPaths) {
    let names: string[];
    try {
      names = await readdir(dayPath);
    } catch {
      continue;
    }
    for (const name of names) {
      if (!name.startsWith("rollout-") || !name.endsWith(".jsonl")) continue;
      const file = join(dayPath, name);
      try {
        const st = await stat(file);
        // Only files modified around or after the terminal started.
        if (st.mtimeMs < startedMs - 60_000) continue;
        out.push({ file, mtimeMs: st.mtimeMs });
      } catch {
        // skip
      }
    }
  }
  out.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return out;
}

/**
 * Built-in Claude context-window presets by model family, first match wins.
 * Bridge-proxy models report their upstream id (e.g. "upstream-my-qwen"), so
 * the table matches on family needles rather than exact aliases — without
 * these the battery fell back to a grey "?" for every claude-local-long2 pane. Unknown model → null (renderer shows a grey "?" — we
 * never pretend a window we don't know).
 */
const MODEL_FAMILY_CONTEXT_WINDOWS: ReadonlyArray<{ needles: string[]; window: number }> = [
  { needles: ["my-qwen"], window: MYQWEN_CLAUDE_CONTEXT_WINDOW },
  { needles: ["[1m]", "-1m"], window: 1_000_000 },
  // Fable 5 ships with a 1M context window (no [1m] suffix in the model id).
  { needles: ["fable"], window: 1_000_000 },
  { needles: ["claude"], window: 200_000 },
];

export function claudeContextWindow(model: string | null): number | null {
  if (!model) return null;
  const m = model.toLowerCase();
  for (const family of MODEL_FAMILY_CONTEXT_WINDOWS) {
    if (family.needles.some((needle) => m.includes(needle))) return family.window;
  }
  return null;
}

/**
 * Profiles whose per-session usage numbers are trustworthy enough to meter,
 * as data. The claude/codex official ids plus the window-pinng free profiles
 * (Qwen Local) are in — Coterm pins their context window
 * itself (CLAUDE_CODE_MAX_CONTEXT_TOKENS / model_context_window), so
 * used/window is a real measure against a known ceiling. codex-local-main/codex-local-long
 * stay out (their proxy usage reports are unreliable).
 */
const METERED_PROFILES: ReadonlySet<string> = new Set([
  "claude-official",
  "codex-official",
  "claude-local-long2",
  "codex-local-long2",
]);

const UNMETERED_CODEX_PROFILES: ReadonlySet<string> = new Set([
  "codex-local-main",
  "codex-local-max",
  "codex-local-long",
]);

/**
 * Stage 2 (codex half): a registered custom codex- entry is metered too — its
 * spec pins the model/id wiring, so the rollout's own usage numbers are a real
 * per-session measure. Pass the ACTIVE custom-profile table so hot-registered
 * entries meter without new hand-written ids (the default keeps the legacy
 * builtin-only behavior for callers without a table at hand).
 */
export function isContextMeterProfile(
  profile: string | null,
  customProfiles?: Record<string, CodexProfileSource> | null,
): boolean {
  if (!profile) return false;
  if (METERED_PROFILES.has(profile)) return true;
  if (UNMETERED_CODEX_PROFILES.has(profile)) return false;
  if (profile.startsWith("codex-")) {
    return resolveCodexProfileSpec(profile, customProfiles) !== null;
  }
  return false;
}

export function isCodexTitleProfile(profile: string | null): boolean {
  return typeof profile === "string" && profile.startsWith("codex-");
}

export function isClaudeTitleProfile(profile: string | null): boolean {
  return typeof profile === "string" && profile.startsWith("claude-");
}

function numOrZero(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function numOrPositive(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;
}

/**
 * Munge a cwd into the Claude Code projects folder name: every non-alphanumeric
 * char becomes `-`. Verified against ~/.claude/projects: `D:\Coterm` →
 * `D--Coterm` (colon + backslash + space each collapse to `-`).
 */
export function mungeCwd(cwd: string): string {
  return cwd.replace(/[^a-zA-Z0-9]/g, "-");
}

/**
 * Resolve a terminal's cwd to its most-recently-modified Claude Code session
 * jsonl. Used by the clean-view transcript reader so it follows the same
 * session-location rule. Returns null when there is no Claude project folder
 * for this cwd or no .jsonl inside it.
 *
 * When nativeSessionId is provided (a claude --session-id Coterm generated for
 * this terminal), look for <folder>/<nativeSessionId>.jsonl only. A fresh
 * session may not have written its file yet; falling back to mtime-newest in
 * that window would show another session's transcript. Terminals without
 * a native session id retain the legacy cwd+mtime lookup.
 */
export async function resolveLatestSessionJsonl(
  cwd: string,
  projectsRoot: string,
  nativeSessionId?: string | null,
): Promise<{ file: string; mtimeMs: number } | null> {
  if (!cwd) return null;
  const folder = mungeCwd(cwd);
  // Exact-match path: when Coterm generated a --session-id for this terminal,
  // the .jsonl filename is <nativeSessionId>.jsonl. This is the authoritative
  // resolution — no mtime guessing, no cross-pane collision.
  if (nativeSessionId) {
    const exactFile = join(projectsRoot, folder, `${nativeSessionId}.jsonl`);
    try {
      const info = await stat(exactFile);
      return { file: exactFile, mtimeMs: info.mtimeMs };
    } catch {
      // File not created yet (agent just launched, no first turn written).
      // Do not read a different session from the same project.
      return null;
    }
  }
  let entries: string[];
  try {
    entries = await readdir(join(projectsRoot, folder));
  } catch {
    // No Claude project folder for this cwd yet — not a Claude session.
    return null;
  }
  // mtime-newest .jsonl, excluding subagents/ (which is a subdirectory).
  let newest: { file: string; mtimeMs: number } | null = null;
  for (const name of entries) {
    if (!name.endsWith(".jsonl")) continue;
    const file = join(projectsRoot, folder, name);
    try {
      const info = await stat(file);
      if (!newest || info.mtimeMs > newest.mtimeMs) newest = { file, mtimeMs: info.mtimeMs };
    } catch {
      // File may have rotated between readdir and stat — skip.
    }
  }
  return newest;
}

/**
 * Parse one Claude Code session jsonl record into a clean-view message, or null
 * if the record carries no user/assistant text. Pure function (no I/O) so it can
 * be unit-tested by feeding hand-written records.
 *
 * - user record: message.content as a string OR an array of text blocks. Tool
 *   results (type==="tool_result") are dropped. Strings beginning with
 *   "<system-reminder>" are injected context, not real user input — dropped.
 * - assistant record: only type==="text" blocks are joined; thinking and
 *   tool_use blocks are dropped.
 * - Empty text never produces a message.
 * - timestamp comes from the record's top-level `timestamp` field.
 */
export function parseTranscriptRecord(record: Record<string, unknown>): TranscriptMessage | null {
  const message = record.message;
  if (!message || typeof message !== "object") return null;
  const value = message as Record<string, unknown>;
  if (value.role !== "user" && value.role !== "assistant") return null;
  const content = value.content;
  let text: string;
  if (typeof content === "string") {
    text = content;
  } else if (Array.isArray(content)) {
    text = content.flatMap((block) => {
      if (!block || typeof block !== "object") return [];
      const item = block as Record<string, unknown>;
      // Only text blocks survive; tool_result (user) and tool_use/thinking
      // (assistant) are the noise the clean view hides.
      if (item.type !== "text" || typeof item.text !== "string") return [];
      return [item.text];
    }).join("\n");
  } else {
    text = "";
  }
  if (value.role === "user" && text.trimStart().startsWith("<system-reminder>")) {
    return null;
  }
  const trimmed = text.trim();
  if (!trimmed) return null;
  const timestamp = typeof record.timestamp === "string" ? record.timestamp : "";
  return { role: value.role, text: trimmed, timestamp };
}

/**
 * Stream a session jsonl and collect clean-view messages (user text + assistant
 * text only; tool calls, tool results, thinking, and system-reminder injections
 * are dropped). Keeps only the last `maxMessages` so a huge transcript can't
 * flood the renderer. Returns [] on any read/parse failure.
 */
export async function readTranscriptMessages(
  file: string,
  maxMessages = 200,
): Promise<TranscriptMessage[]> {
  const messages: TranscriptMessage[] = [];
  try {
    const lines = createInterface({ input: createReadStream(file), crlfDelay: Infinity });
    for await (const line of lines) {
      if (!line) continue;
      let record: unknown;
      try {
        record = JSON.parse(line);
      } catch {
        continue;
      }
      if (!record || typeof record !== "object") continue;
      const message = parseTranscriptRecord(record as Record<string, unknown>);
      if (!message) continue;
      messages.push(message);
      while (messages.length > maxMessages) messages.shift();
    }
  } catch {
    // File vanished or unreadable mid-read — return what we have.
  }
  return messages;
}
