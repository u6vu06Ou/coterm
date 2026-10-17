import { open, stat } from "node:fs/promises";
import type { TerminalKeepaliveState } from "../../shared/schema";

export type { TerminalKeepaliveState };

export const CLAUDE_KEEPALIVE_INTERVAL_MS = 55 * 60 * 1_000;
// Codex prompt cache TTL is 30 minutes (GPT-5.6+ docs, verified 2026-09-08),
// so official-codex panes refresh on a tighter 25-minute cadence.
export const CODEX_KEEPALIVE_INTERVAL_MS = 25 * 60 * 1_000;

// Prompt-cache TTL per provider (issue #91). Past this much silence since the
// last model turn the cache is already dead — a ping then pays a full-price
// cold reload for nobody, so the guard skips it and marks the window cooled.
export const CLAUDE_CACHE_TTL_MS = 60 * 60 * 1_000;
export const CODEX_CACHE_TTL_MS = 30 * 60 * 1_000;

// Keepalive ping goes through the CLI's built-in /btw side channel (issue
// #78): it resends the full prefix so a cache hit refreshes the TTL
// (proxy.log verified 2026-08-10), answers minimally, and does NOT append to
// the main conversation transcript. codex-cli ≥0.154 also ships /btw (slash
// table verified in codex.exe 2026-09-21) with the same side-question
// semantics; an older codex without it just shows an unknown-command entry,
// which is harmless at this cadence.
export const CLAUDE_KEEPALIVE_PROMPT = "/btw 不用做任何事";
export const CODEX_KEEPALIVE_PROMPT = "/btw 不用做任何事";
export const KEEPALIVE_MAX_HOURS = 8;

export type ClaudeKeepaliveHours = 0 | 2 | 4 | 6 | 8;

/** Profiles whose prompt cache is paid and short-lived — keepalive targets.
 *  codex-team (#100): official Codex CLI lead, paid account, same 25-min TTL,
 *  so it joins codex-official as a keepalive target. */
export const KEEPALIVE_PROFILES = new Set(["claude-official", "codex-official", "codex-team"]);

interface KeepaliveEntry {
  profile: string | null;
  lastHumanActivityAt: number;
  /** Last observed model-turn moment (PTY output / own ping). Freshness clock. */
  lastTurnAt: number;
  nextCheckAt: number;
  pendingInput: string;
  overrideHours: number | null;
  /** true once a due tick found the cache past its TTL — injecting paused. */
  cooled: boolean;
  /** Bumped by arm(); stale async freshness probes check it and bail out. */
  seq: number;
  timer: ReturnType<typeof setTimeout> | null;
}

interface ClaudeKeepaliveDependencies {
  canInject: (terminalId: string) => boolean;
  inject: (terminalId: string, data: string) => boolean;
  /**
   * #91 freshness probe: epoch ms of the terminal's last real model turn.
   * Claude panes answer from the session transcript tail (ground truth across
   * app restarts). Return values:
   *   number   — last turn time; compared against the profile TTL.
   *   null     — authoritative "no turns on record": nothing to keep alive.
   *   undefined — "no better source"; fall back to the manager's own
   *              PTY-output clock (codex path).
   */
  lastModelTurnAt?: (
    terminalId: string,
  ) => number | null | undefined | Promise<number | null | undefined>;
  now?: () => number;
}

/**
 * Main-process-only prompt-cache keepalive scheduler.
 *
 * `nextCheckAt` follows all PTY activity, while `lastHumanActivityAt` is the
 * hard lifetime anchor. Keeping those clocks separate prevents a keepalive
 * response from extending a 2h window forever. Eligible windows are the paid
 * official profiles (claude-official, codex-official); codex ticks on the
 * shorter interval above. `overrideHours` carries the per-window value set
 * from the pane header — it wins over the global setting, and anchoring it
 * to "now" makes a header bump read as "protect N hours from this click".
 *
 * Freshness guard (#91): a due tick first asks "is this window's cache still
 * alive?" — last model turn within TTL → inject the /btw ping; overdue → the
 * cache already died, so skip the ping and mark the window `cooled` (visible
 * in the pane header state) until the human comes back and talks. A ping
 * into a dead cache is a full-price cold reload with nobody at the keyboard.
 */
export class ClaudeKeepaliveManager {
  private readonly entries = new Map<string, KeepaliveEntry>();
  private hours: ClaudeKeepaliveHours;
  private readonly now: () => number;

  constructor(
    hours: ClaudeKeepaliveHours,
    private readonly dependencies: ClaudeKeepaliveDependencies,
  ) {
    this.hours = hours;
    this.now = dependencies.now ?? (() => Date.now());
  }

  trackTerminal(terminalId: string, profile: string | null): void {
    const now = this.now();
    const existing = this.entries.get(terminalId);
    if (existing) {
      existing.profile = profile;
      this.arm(terminalId, existing);
      return;
    }
    const entry: KeepaliveEntry = {
      profile,
      lastHumanActivityAt: now,
      lastTurnAt: now,
      nextCheckAt: now + this.intervalFor(profile),
      pendingInput: "",
      overrideHours: null,
      cooled: false,
      seq: 0,
      timer: null,
    };
    this.entries.set(terminalId, entry);
    this.arm(terminalId, entry);
  }

  setProfile(terminalId: string, profile: string | null): void {
    const entry = this.entries.get(terminalId);
    if (!entry) {
      this.trackTerminal(terminalId, profile);
      return;
    }
    const becameOfficial = !KEEPALIVE_PROFILES.has(entry.profile ?? "") && KEEPALIVE_PROFILES.has(profile ?? "");
    entry.profile = profile;
    if (becameOfficial) {
      const now = this.now();
      entry.lastHumanActivityAt = now;
      entry.lastTurnAt = now;
      entry.nextCheckAt = now + this.intervalFor(profile);
      entry.pendingInput = "";
      entry.overrideHours = null;
      entry.cooled = false;
    }
    this.arm(terminalId, entry);
  }

  recordHumanInput(terminalId: string, data: string): void {
    const entry = this.entries.get(terminalId);
    if (!entry) return;
    const now = this.now();
    entry.lastHumanActivityAt = now;
    entry.nextCheckAt = now + this.intervalFor(entry.profile);
    entry.pendingInput = updatePendingInput(entry.pendingInput, data);
    // The human is back at the keyboard; clear the cooled marker now — the
    // next due tick re-evaluates the transcript honestly. (Typing itself is
    // not a model turn, so lastTurnAt stays put.)
    entry.cooled = false;
    this.arm(terminalId, entry);
  }

  recordAutomatedInput(terminalId: string, data: string): void {
    const entry = this.entries.get(terminalId);
    if (!entry) return;
    entry.nextCheckAt = this.now() + this.intervalFor(entry.profile);
    entry.pendingInput = updatePendingInput(entry.pendingInput, data);
    this.arm(terminalId, entry);
  }

  recordOutput(terminalId: string): void {
    const entry = this.entries.get(terminalId);
    if (!entry) return;
    const now = this.now();
    // PTY output on an agent pane is the observable end of a model turn —
    // advance the freshness clock and clear the cooled marker.
    entry.lastTurnAt = now;
    entry.cooled = false;
    entry.nextCheckAt = now + this.intervalFor(entry.profile);
    this.arm(terminalId, entry);
  }

  setHours(hours: ClaudeKeepaliveHours): void {
    const wasDisabled = this.hours === 0;
    this.hours = hours;
    const now = this.now();
    for (const [terminalId, entry] of this.entries) {
      if (wasDisabled && hours > 0) {
        entry.nextCheckAt = now + this.intervalFor(entry.profile);
      }
      this.arm(terminalId, entry);
    }
  }

  /**
   * Per-window override from the pane header (+/- buttons). A click anchors
   * `lastHumanActivityAt` to now — "＋ twice before leaving" therefore buys
   * hours from the click, not from the last keystroke hours ago.
   */
  setOverrideHours(terminalId: string, hours: number | null): TerminalKeepaliveState {
    if (!this.entries.has(terminalId)) this.trackTerminal(terminalId, null);
    const entry = this.entries.get(terminalId);
    if (!entry) throw new Error("Keepalive entry missing after tracking.");
    const now = this.now();
    if (hours === null) {
      entry.overrideHours = null;
    } else {
      entry.overrideHours = Math.max(0, Math.min(KEEPALIVE_MAX_HOURS, Math.round(hours)));
      entry.lastHumanActivityAt = now;
      entry.nextCheckAt = now + this.intervalFor(entry.profile);
      // Explicit user intent — clear the cooled marker; the next due tick
      // re-probes and re-marks if the cache is truly dead.
      entry.cooled = false;
    }
    this.arm(terminalId, entry);
    return this.stateFor(terminalId, entry);
  }

  listStates(): TerminalKeepaliveState[] {
    return Array.from(this.entries.entries(), ([terminalId, entry]) => this.stateFor(terminalId, entry));
  }

  remove(terminalId: string): void {
    const entry = this.entries.get(terminalId);
    if (!entry) return;
    this.clear(entry);
    this.entries.delete(terminalId);
  }

  dispose(): void {
    for (const entry of this.entries.values()) this.clear(entry);
    this.entries.clear();
  }

  private stateFor(terminalId: string, entry: KeepaliveEntry): TerminalKeepaliveState {
    const effectiveHours = this.effectiveHours(entry);
    return {
      terminalId,
      profile: entry.profile,
      eligible: KEEPALIVE_PROFILES.has(entry.profile ?? "") && effectiveHours > 0,
      overrideHours: entry.overrideHours,
      effectiveHours,
      cooled: entry.cooled,
    };
  }

  private effectiveHours(entry: KeepaliveEntry): number {
    return entry.overrideHours ?? this.hours;
  }

  private isCodex(profile: string | null): boolean {
    return profile === "codex-official" || profile === "codex-team";
  }

  private intervalFor(profile: string | null): number {
    return this.isCodex(profile) ? CODEX_KEEPALIVE_INTERVAL_MS : CLAUDE_KEEPALIVE_INTERVAL_MS;
  }

  private ttlFor(profile: string | null): number {
    return this.isCodex(profile) ? CODEX_CACHE_TTL_MS : CLAUDE_CACHE_TTL_MS;
  }

  private promptFor(profile: string | null): string {
    return this.isCodex(profile) ? CODEX_KEEPALIVE_PROMPT : CLAUDE_KEEPALIVE_PROMPT;
  }

  private arm(terminalId: string, entry: KeepaliveEntry): void {
    this.clear(entry);
    entry.seq += 1;
    if (!this.isEligible(entry)) return;
    const now = this.now();
    const expiresAt = this.expiresAt(entry);
    if (now >= expiresAt) return;
    const dueAt = Math.min(entry.nextCheckAt, expiresAt);
    entry.timer = setTimeout(() => this.tick(terminalId), Math.max(0, dueAt - now));
  }

  private tick(terminalId: string): void {
    const entry = this.entries.get(terminalId);
    if (!entry) return;
    entry.timer = null;
    if (!this.isEligible(entry)) return;
    const now = this.now();
    if (now >= this.expiresAt(entry)) return;
    if (now < entry.nextCheckAt) {
      this.arm(terminalId, entry);
      return;
    }

    const probe = this.dependencies.lastModelTurnAt;
    if (!probe) {
      this.resolveTick(terminalId, entry, entry.lastTurnAt);
      return;
    }
    const seq = entry.seq;
    void Promise.resolve()
      .then(() => probe(terminalId))
      .then((turnAt) => {
        // A record*/arm during the await already rescheduled this entry —
        // its own future tick will re-probe; do not double-act.
        if (this.entries.get(terminalId) !== entry || entry.seq !== seq) return;
        this.resolveTick(terminalId, entry, turnAt === undefined ? entry.lastTurnAt : turnAt);
      })
      .catch(() => {
        // Probe failed (unreadable transcript etc.): skip this round without
        // touching the cooled flag, retry on the next interval.
        if (this.entries.get(terminalId) !== entry || entry.seq !== seq) return;
        entry.nextCheckAt = this.now() + this.intervalFor(entry.profile);
        this.arm(terminalId, entry);
      });
  }

  /**
   * One due tick: apply the TTL freshness guard, inject when fresh + idle,
   * then schedule the next round a full interval out.
   * `turnAt === null` = authoritative "no turns on record" → treated as cold.
   */
  private resolveTick(terminalId: string, entry: KeepaliveEntry, turnAt: number | null): void {
    if (!this.isEligible(entry)) return;
    const now = this.now();
    if (now >= this.expiresAt(entry)) return;
    const fresh = turnAt !== null && now - turnAt <= this.ttlFor(entry.profile);

    if (fresh && entry.pendingInput.length === 0 && this.dependencies.canInject(terminalId)) {
      const sent = this.dependencies.inject(
        terminalId,
        `${this.promptFor(entry.profile)}\r`,
      );
      if (sent) {
        entry.pendingInput = "";
        // The ping itself provokes a model turn; if recordOutput lags or
        // misses it, the freshness clock must not report stale.
        entry.lastTurnAt = now;
      }
    }

    // Busy or dirty input skips this round. The next attempt remains a full
    // interval away; a tight retry loop could interrupt a long task.
    entry.cooled = !fresh;
    entry.nextCheckAt = now + this.intervalFor(entry.profile);
    this.arm(terminalId, entry);
  }

  private isEligible(entry: KeepaliveEntry): boolean {
    return KEEPALIVE_PROFILES.has(entry.profile ?? "") && this.effectiveHours(entry) > 0;
  }

  private expiresAt(entry: KeepaliveEntry): number {
    return entry.lastHumanActivityAt + this.effectiveHours(entry) * 60 * 60 * 1_000;
  }

  private clear(entry: KeepaliveEntry): void {
    if (entry.timer !== null) clearTimeout(entry.timer);
    entry.timer = null;
  }
}

/** Track enough line-editing state to reject keepalive when the prompt is dirty. */
export function updatePendingInput(current: string, data: string): string {
  // Cursor/function-key escape sequences do not add text to the prompt.
  const escape = String.fromCharCode(27);
  const plain = data.replace(new RegExp(`${escape}(?:\\[[0-?]*[ -/]*[@-~]|O.)`, "g"), "");
  let next = current;
  for (const char of plain) {
    if (char === "\r" || char === "\n" || char === "\x03" || char === "\x15") {
      next = "";
    } else if (char === "\b" || char === "\x7f") {
      next = next.slice(0, -1);
    } else if (char >= " ") {
      next += char;
    }
  }
  return next.slice(-4_096);
}

// Same tail window as context-meter.ts: the newest usage record lives well
// inside the last 64 KB of a session jsonl even after a long day.
const TRANSCRIPT_TAIL_BYTES = 64_000;

/**
 * #91 probe half: tail-read a Claude Code session jsonl and return the epoch
 * ms of the newest real model turn (a record carrying `message.usage` with a
 * top-level `timestamp`). Sidechain rows belong to Task subagents and do not
 * describe this pane's main-thread cache. Returns null when the file is
 * missing/unreadable or has no usage record — callers treat that as "nothing
 * to keep alive". (`record.timestamp` is an ISO 8601 string; Date.parse is
 * exact enough for TTL comparisons.)
 */
export async function readLastClaudeTurnAt(file: string): Promise<number | null> {
  const info = await stat(file).catch(() => null);
  if (!info) return null;
  const start = Math.max(0, info.size - TRANSCRIPT_TAIL_BYTES);
  const handle = await open(file, "r").catch(() => null);
  if (!handle) return null;
  let text: string;
  try {
    const buf = Buffer.alloc(Math.min(TRANSCRIPT_TAIL_BYTES, info.size));
    const { bytesRead } = await handle.read(buf, 0, buf.length, start);
    text = buf.subarray(0, bytesRead).toString("utf8");
  } finally {
    await handle.close();
  }
  const lines = text.split("\n");
  // A window mid-file always splits a record — drop the partial first line.
  if (start > 0 && lines.length > 1) lines.shift();
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (!line) continue;
    let record: unknown;
    try {
      record = JSON.parse(line);
    } catch {
      continue;
    }
    const row = record as Record<string, unknown> | null;
    if (row?.isSidechain === true) continue;
    const message = row?.message;
    if (!message || typeof message !== "object") continue;
    const usage = (message as Record<string, unknown>).usage;
    if (!usage || typeof usage !== "object") continue;
    const tsRaw = row?.timestamp;
    if (typeof tsRaw !== "string") continue;
    const ts = Date.parse(tsRaw);
    if (Number.isFinite(ts)) return ts;
  }
  return null;
}
