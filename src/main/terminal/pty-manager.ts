import * as pty from "@lydell/node-pty";
import { homedir } from "node:os";
import { join } from "node:path";
import type { AgentStateExplanation, CommandResult, TerminalCreateInput, TerminalInfo, TerminalLabel, PtyState, PtyStateSource, PtyStateChanged } from "@shared/types";
import { agentStateExplanationSchema, commandResultSchema } from "@shared/schema";
import type { ScrollbackMode } from "@shared/schema";
import { shellTitle } from "@shared/terminal";
import { canTransitionTo, isAttentionState, ptyStateSourceAuthority, toLegacyPtyState, type LegacyPtyState } from "@shared/pty-state";
import type { AppEventBus } from "../core/event-bus";
import { createId } from "../core/ids";
import { sanitizedChildEnvironment } from "../security/environment";
import { redactEgress } from "../security/redaction";
import { logger } from "../core/logger";
import { parseOscChunk, type OscMarker, type NotificationKind } from "./osc-parser";
import { DecModeTracker } from "./dec-modes";
import {
  KEEPALIVE_PROFILES,
  ClaudeKeepaliveManager,
  readLastClaudeTurnAt,
  type ClaudeKeepaliveHours,
  type TerminalKeepaliveState,
} from "./claude-keepalive";
import { resolveLatestSessionJsonl } from "./context-meter";
import { resolveShell, formatShellUnavailable, attemptedCandidates } from "./shell-resolver";
import type { JevVerifier } from "./jev-verifier";
import {
  AgentDetectionEngine,
  hasBackgroundWorkSignal,
  profileFamily,
} from "./agent-detection";

export type { PtyState, PtyStateSource } from "@shared/types";

/**
 * Cold-start timing (private #50/#51): three metadata-only stages —
 * profile resolve, PTY spawn, first CLI output. Durations + profile/shell
 * kind only; NEVER the command line, cwd, or env values (§A.2).
 */
export interface ColdStartTiming {
  terminalId: string;
  profile: TerminalCreateInput["profile"];
  shellKind: string;
  resolveMs: number;
  spawnMs: number;
  firstOutputMs: number;
}

export interface PtyManagerHooks {
  /** Fired once per terminal on its first output chunk. Metadata-only. */
  onColdStartTiming?: (timing: ColdStartTiming) => void;
  /**
   * Jev 注意力複判: optional second opinion consulted when the quiet-debounce
   * is about to mark an agent "done". Absent/disabled → the synchronous
   * heuristic path runs unchanged.
   */
  jevVerifier?: Pick<JevVerifier, "isEnabled" | "classifyQuietScreen">;
  /**
   * PTY output coalescing: buffer incoming chunks per terminal and flush them
   * together so downstream (detection, IPC forward, WS broadcast) runs once per
   * burst instead of once per chunk. Default 16ms; 0 = synchronous legacy
   * per-chunk mode (kept for the flood benchmark baseline).
   */
  outputFlushMs?: number;
  /** Flush immediately when pending output reaches this many chars. */
  outputPendingMaxChars?: number;
  /**
   * Agent mail identity (@-mentions): allocated HERE, before pty.spawn, so the
   * per-pane token lands in the shell env and paste-launched agents inherit it
   * from the hosting shell. Absent → no COTERM_MAIL_* env (headless tests).
   */
  agentMail?: {
    onSpawn(input: { terminalId: string; isAgent: boolean; agentProfile: string | null }): {
      env: Record<string, string>;
      handle: string | null;
    };
    onMarkedAgent(input: { terminalId: string; agentProfile: string }): string | null;
    /**
     * Nudged when the screen rule owning a pane's state changed without a
     * state transition (menu opened/closed under waiting_input) — the mailbox
     * re-evaluates queued deliveries.
     */
    refresh?(terminalId: string): void;
  };
}

/** Max consecutive "still working" deferrals of one quiet streak before the
 * heuristic "done" wins anyway (a stuck spinner must not stay yellow forever). */
const JEV_MAX_DEFERRALS = 2;

/** Hard cap on one Jev consult: a hung provider fails open to heuristic done
 * (council 2026-09-26 R3 #1). */
const JEV_TIMEOUT_MS = 8_000;

/** Default coalescing window (ms) for PTY output flushes. */
const OUTPUT_FLUSH_MS = 16;

/** Default pending-output char count that triggers a synchronous flush. */
const OUTPUT_PENDING_MAX_CHARS = 65_536;

/**
 * Truncate terminal scrollback to at most 2M chars. When truncation is needed,
 * drop the partial first line so replay never starts mid-ANSI. If no newline is
 * found at/after the cut point, fall back to a hard slice (M5 fix: never skip
 * truncation just because indexOf returned -1).
 *
 * Every recovery replay (replace:true) overwrites the xterm buffer with this
 * snapshot, so THIS cap — not xterm's own scrollback — bounds how far the user
 * can scroll back. 250K (~650 heavy-output lines) got exhausted within one long
 * agent session (2026-07-13); 2M is ~16MB RAM worst-case across 8 terminals.
 */
export const SCROLLBACK_MAX_CHARS = 2_000_000;

/**
 * Leading character count to drop from `chunks` (joined length `total`) so the
 * remainder fits `max`, dropping the partial first line so replay never starts
 * mid-ANSI. Falls back to a hard cut when no newline exists at/after the cut
 * point. Works across chunk boundaries so the joined scrollback never has to
 * be built on the hot path.
 */
function scrollbackDropLength(chunks: readonly string[], total: number, max: number): number {
  if (total <= max) return 0;
  const cut = total - max;
  let offset = 0;
  for (const chunk of chunks) {
    // Before the cut point the search window is past the chunk end (indexOf
    // returns -1); inside/after it, search from the cut into later chunks.
    const at = chunk.indexOf("\n", Math.max(0, cut - offset));
    if (at !== -1) return offset + at + 1;
    offset += chunk.length;
  }
  return cut;
}

/**
 * Apply scrollbackDropLength's rule to a chunk list in place: drop whole
 * leading chunks and slice the boundary one. Returns the new total length.
 * The PTY ingest path appends + trims this way so the whole scrollback is not
 * re-copied on every data event (#7). Exported for unit tests.
 */
export function trimScrollbackChunks(chunks: string[], total: number, max: number): number {
  const drop = scrollbackDropLength(chunks, total, max);
  if (drop === 0) return total;
  let remaining = drop;
  let firstKept = 0;
  while (firstKept < chunks.length) {
    const length = chunks[firstKept]?.length ?? 0;
    if (length > remaining) break;
    remaining -= length;
    firstKept += 1;
  }
  if (firstKept > 0) chunks.splice(0, firstKept);
  if (remaining > 0) {
    const head = chunks[0];
    if (head !== undefined) chunks[0] = head.slice(remaining);
  }
  return total - drop;
}

export function truncateScrollback(combined: string, max = SCROLLBACK_MAX_CHARS): string {
  const drop = scrollbackDropLength([combined], combined.length, max);
  return drop === 0 ? combined : combined.slice(drop);
}

/**
 * How long an agent terminal must stay output-silent before its state falls
 * back from "running" to "done". 2.5s is long enough that a brief pause between
 * streaming chunks (tool calls, model thinking) does not flicker the lamp
 * green, but short enough that a finished turn reads as "waiting for next
 * prompt" within a beat. Attention/error states are never cleared by this
 * timer — only osc/broker/provider may exit them.
 */
const AGENT_QUIET_MS = 2_500;

/**
 * Decide whether a parsed ANSI title should replace info.title. The shell
 * default (e.g. "pwsh") must not overwrite a real LLM work summary, and empty
 * titles are ignored. Exported for unit testing.
 */
export function applyTitleToInfo(info: TerminalInfo, title: string): TerminalInfo {
  // Strip rotating braille spinner prefixes (Codex/LLM CLIs prepend one per
  // frame at ~10Hz) before comparing/storing, so every frame collapses to the
  // same title and cannot loop terminalListChanged -> workspace re-fetch.
  const trimmed = title.trim().replace(/^[\u2800-\u28ff]+\s*/, "");
  if (!trimmed) return info;
  if (trimmed === info.title) return info;
  if (trimmed === shellTitle(info.profile)) return info;
  // Claude Code briefly advertises this as its terminal title before the
  // actual task summary arrives. It is a provider marker, not the summary
  // the PTY header is meant to show.
  if (/^[^\p{L}\p{N}]*Claude Code$/iu.test(trimmed)) return info;
  return { ...info, title: trimmed };
}

/**
 * Privacy-safe a command before it is stored in a CommandResult: redact
 * secrets/PII and cap length so a pasted novel can't blow up the ledger.
 * Exported for unit testing the redaction boundary.
 */
export function sanitizeCommand(command: string): string {
  const MAX = 4_000;
  const redacted = redactEgress(command);
  return redacted.length > MAX ? `${redacted.slice(0, MAX)}\u2026` : redacted;
}

interface ManagedTerminal {
  info: TerminalInfo;
  process: pty.IPty;
  resizeTimer: NodeJS.Timeout | null;
  /** Scrollback as append-ordered chunks; the string only materializes on snapshot reads. */
  scrollback: string[];
  /** Joined length of scrollback, tracked incrementally on append/trim. */
  scrollbackLength: number;
  /**
   * DEC private mode state (alt screen, mouse reporting, bracketed paste...)
   * tracked from the live byte stream. Hydrate snapshots prepend its preamble
   * so late-joining clients replay with the modes the ring may have evicted
   * (#47).
   */
  decModes: DecModeTracker;
  /** Monotonic output boundary captured with scrollback snapshots. */
  outputRevision: number;
  dataDisposer: pty.IDisposable | null;
  exitDisposer: pty.IDisposable | null;
  ptyState: PtyState;
  /** Source that last won the canonical state chokepoint. */
  ptyStateSource: PtyStateSource;
  /**
   * Screen-detection rule id that produced the current state, set only while
   * the screen source owns it (null otherwise). Metadata-only (same class of
   * information as state-explain); the agent mailbox uses it to hold mail
   * while a waiting_input state is actually an open menu/picker.
   */
  screenRuleId: string | null;
  titleBuffer: string | undefined;
  /** OSC 133/633 parser carryover (unparsed tail between chunks). */
  oscCarry: string;
  /** Most recently reported shell cwd (OSC 633 P;Cwd), initialized from spawn cwd. */
  shellCwd: string;
  /** In-flight command lifecycle; null until E+C seen, cleared on D. */
  lifecycle: CommandLifecycle | null;
  /** Last completed CommandResult (null until first rich lifecycle finishes). */
  lastCommand: CommandResult | null;
  /**
   * Agent quiet-debounce: re-armed on every chunk of agent output; when output
   * stays silent for AGENT_QUIET_MS the state falls back to "done". Cleared on
   * kill/dispose. Attention/error states survive the debounce.
   */
  quietTimer: NodeJS.Timeout | null;
  /** Bumped on every re-arm so an in-flight Jev answer for an older quiet
   * streak is discarded once new output arrived. */
  quietGen?: number;
  /** Consecutive Jev "still working" deferrals within the current streak. */
  jevDeferrals?: number;
  /**
   * Dirty-input gate (2026-09-27 fresh-idle false attention): true only while
   * the user's latest submitted turn still awaits the agent's reply. False at
   * launch, set by a HUMAN single-shot Enter with a non-empty draft, cleared
   * when a filed attention state is acknowledged with bare Enter or when the
   * turn completes (a "done" transition). While false, the quiet heuristic,
   * Jev, and the agent-only fallback regex must never file attention.
   */
  awaitingReply?: boolean;
  /**
   * Epoch ms of the last HUMAN Enter typed into this agent pane (desktop,
   * web or mobile; never Agent API/automation). The Windows done-toast only fires
   * for a turn the user started — restored sessions, sub-agents and
   * background tasks finishing on their own have no such Enter.
   */
  lastHumanSubmitAt?: number;
  /**
   * PTY output coalescing (2026-09-27): chunk window buffered between flushes.
   * undefined/empty → nothing pending. Materializes on first chunk.
   */
  outputPending?: string[];
  /** Incremental joined length of outputPending. */
  outputPendingLength?: number;
  /** Single armed flush timer for the pending window; null when not armed. */
  outputFlushTimer?: NodeJS.Timeout | null;
  /**
   * True from write() until the agent's echo chunk (or next flush) goes out,
   * so the first bytes after a submitted input are not held by the window.
   */
  echoPending?: boolean;
  /**
   * Context battery metadata (used/window tokens). Main-owned, written by
   * ContextBatteryMonitor for official Claude/Codex profiles only. null for
   * everything else. Stored on the managed terminal so dashboardSnapshot +
   * get/list surface it without a separate IPC round-trip.
   */
  contextUsage: TerminalInfo["contextUsage"];
  /** Cold-start timing (private #50/#51): measured at create(), completed on
   * first output chunk. Metadata-only (durations + profile/shell kind). */
  spawnStartedAtMs: number;
  spawnDurationMs: number;
  profileResolveMs: number;
  firstOutputAtMs: number | null;
}

/**
 * Accumulates the markers of one command's rich lifecycle (OSC 633 E + C + D).
 * A result is only built when command (E) and preExec (C) have both arrived
 * and a finished (D) marker closes it. Missing E or C → no result (null),
 * never a fabricated command or exit code.
 */
interface CommandLifecycle {
  command: string;
  cwd: string;
  startedAt: string | null;
  hasPreExec: boolean;
}

export class PtyManager {
  private readonly terminals = new Map<string, ManagedTerminal>();
  private readonly shellReadyQueues = new Map<string, Array<{ data: string; source: "human" | "automation" }>>();
  private readonly shellReadyTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly claudeKeepalive: ClaudeKeepaliveManager;
  private readonly agentDetection: AgentDetectionEngine;

  constructor(
    private readonly events: AppEventBus,
    keepaliveHours: ClaudeKeepaliveHours = 2,
    userDataPath?: string,
    private readonly hooks: PtyManagerHooks = {},
  ) {
    this.agentDetection = new AgentDetectionEngine({
      ...(userDataPath ? { userDataPath } : {}),
      onCandidate: (terminalId, candidate) => {
        this.setPtyState(terminalId, candidate.state, "screen");
        const terminal = this.terminals.get(terminalId);
        if (
          terminal &&
          (terminal.ptyState !== candidate.state || terminal.ptyStateSource !== "screen")
        ) {
          // A richer source won the chokepoint. Keep the explanation aligned
          // with the authoritative state instead of exposing a stale screen
          // rule as if it owned the decision.
          this.agentDetection.recordFallback(
            terminalId,
            `${terminal.ptyStateSource}:${terminal.ptyState}`,
          );
        }
        // Mail delivery hint (metadata-only): while screen owns the state,
        // remember WHICH rule produced it — a waiting_input from a menu/picker
        // rule must hold pane mail even though plain prompts deliver. A rule
        // swap without a state change never emits ptyStateChanged, so nudge
        // the mailbox directly.
        if (
          terminal &&
          terminal.ptyStateSource === "screen" &&
          terminal.ptyState === candidate.state &&
          terminal.screenRuleId !== candidate.matchedRuleId
        ) {
          terminal.screenRuleId = candidate.matchedRuleId;
          this.hooks.agentMail?.refresh?.(terminalId);
        }
      },
    });
    this.claudeKeepalive = new ClaudeKeepaliveManager(keepaliveHours, {
      canInject: (terminalId) => {
        const terminal = this.terminals.get(terminalId);
        return Boolean(
          terminal &&
          terminal.info.status === "running" &&
          terminal.info.isAgent &&
          KEEPALIVE_PROFILES.has(terminal.info.agentProfile ?? "") &&
          terminal.ptyState === "done",
        );
      },
      inject: (terminalId, data) => {
        const terminal = this.terminals.get(terminalId);
        if (!terminal || terminal.info.status !== "running") return false;
        try {
          terminal.process.write(data);
          return true;
        } catch {
          return false;
        }
      },
      // #91 freshness probe: claude panes read the session transcript's last
      // usage timestamp (survives app restarts); codex returns undefined and
      // the manager falls back to its own PTY-output clock (codex rollout
      // resolution lives in context-meter, out of this wiring's reach).
      lastModelTurnAt: (terminalId) => this.keepaliveLastModelTurnAt(terminalId),
    });
  }

  /** Load bundled detection manifests and begin watching local overrides. */
  startAgentDetection(): Promise<void> {
    return this.agentDetection.start();
  }

  create(input: TerminalCreateInput): TerminalInfo {
    const id = createId();
    // Cold-start stage 1/3 (private #50/#51): shell profile resolution.
    // "powershell" is explicitly Windows PowerShell 5.1 (public #10); "pwsh"
    // uses the v1.4 legacy passthrough (bare name to conpty) when no install
    // path verifies on disk.
    const resolveStartedAt = Date.now();
    const resolution = resolveShell(input.profile);
    const args = shellArgs(input.profile);
    const profileResolveMs = Date.now() - resolveStartedAt;
    if (!resolution) {
      const attempted = attemptedCandidates(input.profile);
      logger.error("pty", "pty.shell.unavailable", "Shell executable unavailable.", {
        terminalId: id,
        profile: input.profile,
        attempted,
      });
      throw new Error(formatShellUnavailable(input.profile, attempted));
    }
    const executable = resolution.executable;
    const cols = 100;
    const rows = 28;
    // Mail identity before spawn: env flows into the (possibly plain) shell, so
    // agents pasted into it later still inherit COTERM_MAIL_TOKEN & friends.
    const mailIdentity =
      this.hooks.agentMail?.onSpawn({
        terminalId: id,
        isAgent: Boolean(input.isAgent),
        agentProfile: input.agentProfile ?? null,
      }) ?? null;
    let ptyProcess: pty.IPty;
    const spawnStartedAt = Date.now();
    try {
      ptyProcess = pty.spawn(executable, args, {
        name: "xterm-256color",
        cols,
        rows,
        cwd: input.cwd,
        env: {
          ...sanitizedChildEnvironment(),
          TERM: "xterm-256color",
          COLORTERM: "truecolor",
          PYTHONUTF8: "1",
          // ConPTY merges/truncates claude fullscreen (?1049h) incremental
          // repaints and drops erase ops, leaving orphan glyphs on the pane's
          // left edge; the CLI's full-repaint switch works around it (#36).
          ...(process.platform === "win32" ? { CLAUDE_CODE_ALT_SCREEN_FULL_REPAINT: "1" } : {}),
          // Agent env (proxy URL, model, feature flags, AUTH_TOKEN) injected at
          // spawn so it never echoes into the terminal. Caller builds per-profile.
          ...(input.agentEnv ?? {}),
          // Mail identity env comes LAST: a caller-provided agentEnv must never
          // be able to spoof another pane's token/handle.
          ...(mailIdentity?.env ?? {}),
        },
        useConpty: process.platform === "win32",
      });
    } catch (error) {
      logger.error("pty", "pty.spawn.failed", "Failed to spawn PTY.", {
        terminalId: id,
        profile: input.profile,
        shellKind: resolution.kind,
        executable: resolution.executable,
      });
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(
        `Failed to spawn ${resolution.kind} (${resolution.executable}) for profile "${input.profile}": ${detail}`,
        { cause: error },
      );
    }
    const info: TerminalInfo = {
      id,
      projectId: input.projectId,
      profile: input.profile,
      title: input.title ?? shellTitle(input.profile),
      cwd: input.cwd,
      cols,
      rows,
      status: "running",
      startedAt: new Date().toISOString(),
      closedAt: null,
      lastExitCode: null,
      isAgent: input.isAgent ?? false,
      agentProfile: input.agentProfile ?? null,
      ownedByAgentApi: false,
      pid: ptyProcess.pid ?? 0,
      nativeSessionId: null,
      worktreeId: input.worktreeId ?? null,
      contextUsage: null,
      agentHandle: mailIdentity?.handle ?? null,
      // 1.5.45 warroom identity. Memory-only: a PTY never survives an app
      // restart (DockLayoutManager persists fractions only), so there is
      // nothing to persist and no migration to write.
      label: input.label ?? null,
    };
    const spawnDurationMs = Date.now() - spawnStartedAt;
    logger.info("pty", "pty.spawn.done", "PTY spawned.", {
      terminalId: id,
      profile: input.profile,
      agentProfile: input.agentProfile ?? null,
      durationMs: spawnDurationMs,
    });
    const managed: ManagedTerminal = {
      info,
      process: ptyProcess,
      resizeTimer: null,
      scrollback: [],
      scrollbackLength: 0,
      decModes: new DecModeTracker(),
      outputRevision: 0,
      dataDisposer: null,
      exitDisposer: null,
      ptyState: "starting",
      ptyStateSource: "process",
      screenRuleId: null,
      titleBuffer: "",
      oscCarry: "",
      shellCwd: info.cwd,
      lifecycle: null,
      lastCommand: null,
      quietTimer: null,
      awaitingReply: false,
      outputPending: [],
      outputPendingLength: 0,
      outputFlushTimer: null,
      echoPending: false,
      contextUsage: null,
      spawnStartedAtMs: spawnStartedAt,
      spawnDurationMs,
      profileResolveMs,
      firstOutputAtMs: null,
    };
    this.terminals.set(id, managed);
    if (info.isAgent && info.agentProfile) {
      this.agentDetection.trackTerminal({
        terminalId: id,
        agentProfile: info.agentProfile,
        cols,
        rows,
      });
    }
    this.claudeKeepalive.trackTerminal(id, info.agentProfile);
    managed.dataDisposer = ptyProcess.onData((data) => {
      // Cold-start stage 3/3 (#50/#51): first CLI output. Emitted once per
      // terminal; the timing is metadata-only (durations + profile/kind).
      if (managed.firstOutputAtMs === null) {
        managed.firstOutputAtMs = Date.now();
        const timing: ColdStartTiming = {
          terminalId: id,
          profile: info.profile,
          shellKind: resolution.kind,
          resolveMs: managed.profileResolveMs,
          spawnMs: managed.spawnDurationMs,
          firstOutputMs: managed.firstOutputAtMs - managed.spawnStartedAtMs - managed.spawnDurationMs,
        };
        logger.info("pty", "pty.coldstart", "Terminal cold-start timing.", { ...timing });
        this.hooks.onColdStartTiming?.(timing);
      }
      // Coalesced ingest: buffer the chunk and flush with its burst so the
      // parsers/revision/IPC forward run once per flush (2026-09-27).
      this._onPtyChunk(managed, data);
    });
    managed.exitDisposer = ptyProcess.onExit(({ exitCode }) => {
      // Flush-first: trailing output must precede terminalExit/setPtyState so
      // clients see the final bytes before the exit event (2026-09-27).
      this._flushOutput(managed);
      if (managed.resizeTimer) {
        clearTimeout(managed.resizeTimer);
        managed.resizeTimer = null;
      }
      if (managed.quietTimer) {
        clearTimeout(managed.quietTimer);
        managed.quietTimer = null;
      }
      managed.info = {
        ...managed.info,
        status: "exited",
        closedAt: new Date().toISOString(),
        lastExitCode: exitCode,
      };
      if (exitCode !== 0) {
        logger.error("pty", "pty.exit.abnormal", "PTY exited with non-zero code.", {
          terminalId: id,
          exitCode,
        });
      }
      this.setPtyState(id, exitCode === 0 ? "done" : "error", "process");
      this.events.emit("terminalExit", { terminalId: id, projectId: info.projectId, exitCode });
      // Self-cleanup: detach listeners and remove the Map entry so exited
      // terminals do not leak. emit() above uses the captured id/projectId,
      // so deleting here is safe.
      managed.dataDisposer?.dispose();
      managed.exitDisposer?.dispose();
      managed.dataDisposer = null;
      managed.exitDisposer = null;
      const shellReadyTimer = this.shellReadyTimers.get(id);
      if (shellReadyTimer) clearTimeout(shellReadyTimer);
      this.shellReadyTimers.delete(id);
      this.shellReadyQueues.delete(id);
      this.claudeKeepalive.remove(id);
      this.agentDetection.untrack(id);
      this.terminals.delete(id);
    });
    return info;
  }

  write(terminalId: string, data: string, source: "human" | "automation" = "human"): void {
    const terminal = this.requireTerminal(terminalId);
    if (terminal.info.status !== "running") throw new Error("Terminal has exited.");
    if (source === "human") {
      this.claudeKeepalive.recordHumanInput(terminalId, data);
    } else {
      this.claudeKeepalive.recordAutomatedInput(terminalId, data);
    }
    // When the user submits (Enter) while an agent terminal is in an attention
    // state (approval_required / waiting_input), their input is the
    // exit signal — clear the attention state and mark the agent running again
    // so the lamp turns yellow immediately. This is a user gesture (the Enter
    // keystroke), not a PTY-content heuristic, so it uses the process source.
    // A screen/heuristic choice prompt classified as blocked, and a
    // screen/heuristic-filed error, are also acknowledgeable — low-confidence
    // evidence is owed to the user's eyes. Provider/broker/process hard
    // blocked and hard errors stay filed: an ordinary Enter does not prove
    // those were resolved.
    // xterm emits a physical Enter as one `\r` data event; mobile/web and the
    // Agent API agent API submit "draft + Enter" as one `"...draft\r"` write. Requiring
    // the write to END in `\r` with no CR/LF inside acknowledges single-shot
    // submissions while CRLF inside bracketed/multiline paste still cannot
    // acknowledge attention by accident. Automation Enter (Agent API injection) is an
    // explicit "answered" signal and acknowledges the same way.
    if (
      terminal.info.isAgent &&
      data.endsWith("\r") &&
      !/[\r\n]/.test(data.slice(0, -1))
    ) {
      const prev = terminal.ptyState;
      const submittedPrompt = prev === "approval_required" || prev === "waiting_input";
      const submittedScreenBlock = (prev === "blocked" || prev === "error") &&
        (terminal.ptyStateSource === "screen" || terminal.ptyStateSource === "heuristic");
      if (submittedPrompt || submittedScreenBlock) {
        this.setPtyState(terminalId, "running", "process");
      }
      if (source === "human") terminal.lastHumanSubmitAt = Date.now();
      // Dirty-input gate (2026-09-27 fresh-idle false attention): only a
      // HUMAN single-shot Enter with a non-empty draft submits a turn. A bare
      // Enter while an attention state is filed is an acknowledgement — no
      // pending turn remains. Automation (Agent API) Enters never arm the gate.
      if (source === "human") {
        if (data.slice(0, -1).trim().length > 0) {
          terminal.awaitingReply = true;
        } else if (submittedPrompt || submittedScreenBlock) {
          terminal.awaitingReply = false;
        }
      }
    }
    terminal.echoPending = true;
    terminal.process.write(data);
  }

  /**
   * Buffered write that waits while the terminal is still in "starting" (no
   * shell prompt seen yet). Writing a launch command into a booting pwsh can
   * have its trailing Enter swallowed (#50). Other states write immediately:
   * "done" = prompt idle, attention states are answered by input, "running"
   * preserves the old un-gated behavior. On timeout the buffered writes are
   * flushed anyway — a launch command must never be dropped.
   */
  writeWhenShellReady(
    terminalId: string,
    data: string,
    source: "human" | "automation" = "automation",
    timeoutMs = 10_000,
  ): void {
    this.requireTerminal(terminalId);
    const queue = this.shellReadyQueues.get(terminalId) ?? [];
    queue.push({ data, source });
    this.shellReadyQueues.set(terminalId, queue);
    if (this.shellReadyTimers.has(terminalId)) return; // drain already scheduled
    const startedAt = Date.now();
    const tick = (): void => {
      this.shellReadyTimers.delete(terminalId);
      const terminal = this.terminals.get(terminalId);
      const pending = this.shellReadyQueues.get(terminalId) ?? [];
      if (!terminal || pending.length === 0) return;
      const ready = terminal.ptyState !== "starting" && terminal.info.status === "running";
      if (!ready && Date.now() - startedAt < timeoutMs) {
        this.shellReadyTimers.set(terminalId, setTimeout(tick, 100));
        return;
      }
      this.shellReadyQueues.delete(terminalId);
      if (terminal.info.status !== "running") return;
      if (!ready) {
        logger.warn("pty", "terminal.write.shell_ready_timeout", "Shell-ready wait timed out; writing anyway.", {
          terminalId,
          timeoutMs,
        });
      }
      for (const item of pending) this.write(terminalId, item.data, item.source);
    };
    this.shellReadyTimers.set(terminalId, setTimeout(tick, 100));
  }

  resize(terminalId: string, cols: number, rows: number): void {
    const terminal = this.requireTerminal(terminalId);
    if (terminal.resizeTimer) clearTimeout(terminal.resizeTimer);
    terminal.resizeTimer = setTimeout(() => {
      if (terminal.info.status !== "running") {
        terminal.resizeTimer = null;
        return;
      }
      try {
        terminal.process.resize(cols, rows);
        this.agentDetection.resize(terminalId, cols, rows);
        terminal.info = { ...terminal.info, cols, rows };
      } catch {
        // The PTY may exit between the status check and the native resize call.
      }
      terminal.resizeTimer = null;
    }, 80);
  }

  rename(terminalId: string, title: string): TerminalInfo {
    const terminal = this.requireTerminal(terminalId);
    terminal.info = { ...terminal.info, title };
    return terminal.info;
  }

  /**
   * 1.5.45 warroom identity. Sets (or clears, with null) the top-edge colour
   * band label. Emits terminalListChanged so every client repaints the band —
   * the same propagation rename() relies on for titles.
   */
  setLabel(terminalId: string, label: TerminalLabel | null): TerminalInfo {
    const terminal = this.requireTerminal(terminalId);
    terminal.info = { ...terminal.info, label: label ?? null };
    this.events.emit("terminalListChanged", { projectId: terminal.info.projectId });
    return terminal.info;
  }

  markAgent(terminalId: string, agentProfile: string): TerminalInfo {
    const terminal = this.requireTerminal(terminalId);
    terminal.info = { ...terminal.info, isAgent: true, agentProfile };
    this.agentDetection.trackTerminal({
      terminalId,
      agentProfile,
      cols: terminal.info.cols,
      rows: terminal.info.rows,
    });
    this.claudeKeepalive.setProfile(terminalId, agentProfile);
    // Paste-launched agents get their mail handle here (env was already
    // inherited from the hosting shell at spawn; only the handle was pending).
    const handle = this.hooks.agentMail?.onMarkedAgent({ terminalId, agentProfile });
    if (handle && handle !== terminal.info.agentHandle) {
      terminal.info = { ...terminal.info, agentHandle: handle };
      this.events.emit("terminalListChanged", { projectId: terminal.info.projectId });
    }
    return terminal.info;
  }

  setClaudeKeepaliveHours(hours: ClaudeKeepaliveHours): void {
    this.claudeKeepalive.setHours(hours);
  }

  /** Per-window keepalive override from the pane header (+/- buttons). */
  setTerminalKeepalive(terminalId: string, hours: number | null): TerminalKeepaliveState {
    this.requireTerminal(terminalId);
    return this.claudeKeepalive.setOverrideHours(terminalId, hours);
  }

  listTerminalKeepaliveStates(): TerminalKeepaliveState[] {
    return this.claudeKeepalive.listStates();
  }

  /**
   * #91 keepalive freshness probe. Claude panes resolve the terminal's own
   * session jsonl (exact by nativeSessionId when Coterm generated one) and
   * read the newest usage record's timestamp — ground truth that survives an
   * app restart. null = no usable record (nothing to keep alive). Non-claude
   * profiles return undefined so the manager falls back to its own
   * PTY-output freshness clock.
   */
  private async keepaliveLastModelTurnAt(terminalId: string): Promise<number | null | undefined> {
    const terminal = this.terminals.get(terminalId);
    if (!terminal) return undefined;
    const profile = terminal.info.agentProfile ?? "";
    if (!profile.startsWith("claude-")) return undefined;
    const cwd = terminal.info.cwd;
    if (!cwd) return null;
    const resolved = await resolveLatestSessionJsonl(
      cwd,
      join(homedir(), ".claude", "projects"),
      terminal.info.nativeSessionId,
    ).catch(() => null);
    if (!resolved) return null;
    return readLastClaudeTurnAt(resolved.file);
  }

  markAgentOwned(terminalId: string): TerminalInfo {
    const terminal = this.requireTerminal(terminalId);
    terminal.info = { ...terminal.info, ownedByAgentApi: true };
    return terminal.info;
  }

  /**
   * Record the claude --session-id Coterm generated for this terminal agent.
   * Called once after the launch command is written. Emits terminalListChanged
   * so the renderer (and clean-view) pick up the id for exact .jsonl
   * resolution. No dedup — called once per launch.
   */
  setNativeSessionId(terminalId: string, nativeSessionId: string): void {
    const t = this.terminals.get(terminalId);
    if (!t) return;
    const changed = t.info.nativeSessionId !== nativeSessionId;
    t.info = {
      ...t.info,
      nativeSessionId,
      ...(changed ? { agentSummaryTitle: null, agentRecap: null } : {}),
    };
    this.events.emit("terminalListChanged", { projectId: t.info.projectId });
  }

  /** Publish provider-authored header metadata without overwriting the
   * user/OSC title. null clears a previous session's value. Never logged. */
  setAgentSummaryTitle(terminalId: string, title: string | null): void {
    const t = this.terminals.get(terminalId);
    if (!t || t.info.agentSummaryTitle === title) return;
    t.info = { ...t.info, agentSummaryTitle: title };
    this.events.emit("terminalListChanged", { projectId: t.info.projectId });
  }

  /** Provider-authored away recap. Feeds the mobile PTY-switcher marquee only —
   * never the pane header, which owns the short session summary. Never logged. */
  setAgentRecap(terminalId: string, recap: string | null): void {
    const t = this.terminals.get(terminalId);
    if (!t || t.info.agentRecap === recap) return;
    t.info = { ...t.info, agentRecap: recap };
    this.events.emit("terminalListChanged", { projectId: t.info.projectId });
  }

  /**
   * Write context-battery metadata (used/window tokens) onto a terminal's
   * info. Called by ContextBatteryMonitor for official Claude/Codex profiles
   * only. Emits terminalListChanged so the renderer header re-renders the
   * 10-segment battery. Metadata only — never the session body (logging §A.2).
   */
  setContextUsage(
    terminalId: string,
    usedTokens: number,
    windowTokens: number | null,
    percent: number | null,
    model: string | null,
  ): void {
    const t = this.terminals.get(terminalId);
    if (!t) return;
    const next = {
      usedTokens,
      windowTokens,
      percent,
      model: model ?? null,
    };
    const prev = t.info.contextUsage;
    // Idempotent: skip the emit when nothing changed (the 10s poll otherwise
    // churns terminalListChanged every tick even when usage is steady).
    if (
      prev &&
      prev.usedTokens === next.usedTokens &&
      prev.windowTokens === next.windowTokens &&
      prev.percent === next.percent &&
      (prev.model ?? null) === next.model
    ) return;
    t.contextUsage = next;
    t.info = { ...t.info, contextUsage: next };
    this.events.emit("terminalListChanged", { projectId: t.info.projectId });
  }

  kill(terminalId: string): void {
    const terminal = this.requireTerminal(terminalId);
    // Flush-first: trailing output precedes terminalExit so consumers see the
    // final bytes before the exit event (2026-09-27).
    this._flushOutput(terminal);
    this.claudeKeepalive.remove(terminalId);
    // Drop any queued shell-ready writes: the native onExit cleanup is
    // detached below, so without this a terminal killed while booting leaks
    // its shellReadyQueues/shellReadyTimers entries forever.
    const shellReadyTimer = this.shellReadyTimers.get(terminalId);
    if (shellReadyTimer) clearTimeout(shellReadyTimer);
    this.shellReadyTimers.delete(terminalId);
    this.shellReadyQueues.delete(terminalId);
    if (terminal.resizeTimer) clearTimeout(terminal.resizeTimer);
    if (terminal.quietTimer) {
      clearTimeout(terminal.quietTimer);
      terminal.quietTimer = null;
    }
    if (terminal.info.status === "running") {
      this.setPtyState(terminalId, "done", "process");
      this.agentDetection.untrack(terminalId);
      terminal.process.kill();
      // Emit exit so consumers (IPC ledger, renderer) learn the session ended,
      // matching the mock API. Detach listeners afterwards to prevent the
      // native onExit from firing on a detached entry.
      this.events.emit("terminalExit", {
        terminalId,
        projectId: terminal.info.projectId,
        exitCode: 0,
      });
    }
    terminal.dataDisposer?.dispose();
    terminal.exitDisposer?.dispose();
    terminal.dataDisposer = null;
    terminal.exitDisposer = null;
    this.agentDetection.untrack(terminalId);
    this.terminals.delete(terminalId);
  }

  list(projectId: string): TerminalInfo[] {
    return [...this.terminals.values()]
      .filter((terminal) => terminal.info.projectId === projectId)
      .map((terminal) => terminal.info);
  }

  /** Working folders of every live terminal (all projects) — the activity monitor's watch roots. */
  liveCwds(): string[] {
    return [...this.terminals.values()].map((terminal) => terminal.info.cwd).filter((cwd): cwd is string => typeof cwd === "string" && cwd.length > 0);
  }

  /** Look up a single terminal's info by id without throwing. */
  get(terminalId: string): TerminalInfo | null {
    const t = this.terminals.get(terminalId);
    return t ? t.info : null;
  }

  /**
   * Session restore (2026-10-23): the pane's CURRENT working directory —
   * OSC 633 P;Cwd when the shell reported one (user cd'd after spawn),
   * falling back to the spawn cwd. TerminalInfo.cwd stays the spawn value,
   * so snapshotting cwd without this accessor would lose manual cd's.
   */
  getLiveCwd(terminalId: string): string | null {
    const t = this.terminals.get(terminalId);
    if (!t) return null;
    return t.shellCwd || t.info.cwd || null;
  }

  /** When the user last pressed Enter in this agent pane (null = never). */
  getLastHumanSubmitAt(terminalId: string): number | null {
    return this.terminals.get(terminalId)?.lastHumanSubmitAt ?? null;
  }

  /** Look up a single terminal's ptyState by id. */
  getPtyState(terminalId: string): PtyState | null {
    const t = this.terminals.get(terminalId);
    return t ? t.ptyState : null;
  }

  /** Source that currently owns a terminal's canonical state. */
  getPtyStateSource(terminalId: string): PtyStateSource | null {
    const t = this.terminals.get(terminalId);
    return t ? t.ptyStateSource : null;
  }

  /**
   * Screen-detection rule owning the current state, null when another source
   * owns it. Metadata-only; consumed by the agent mailbox's menu/picker hold.
   */
  getScreenRuleId(terminalId: string): string | null {
    const t = this.terminals.get(terminalId);
    return t?.screenRuleId ?? null;
  }

  /** Metadata-only explanation of the current canonical Agent state. */
  getAgentStateExplanation(terminalId: string): AgentStateExplanation | null {
    const terminal = this.terminals.get(terminalId);
    if (!terminal) return null;
    return agentStateExplanationSchema.parse(
      this.agentDetection.getExplanation(
        terminalId,
        terminal.ptyState,
        terminal.ptyStateSource,
      ),
    );
  }

  /**
   * Canonical legacy 3-state for old IPC consumers (getPtyState IPC returns
   * canonical now; this maps for any internal caller still on the old shape).
   */
  getLegacyPtyState(terminalId: string): LegacyPtyState | null {
    const t = this.terminals.get(terminalId);
    return t ? toLegacyPtyState(t.ptyState) : null;
  }

  /**
   * The ONLY writer to a terminal's ptyState. Idempotent: a no-op when
   * `state` equals the current state. Emits a metadata-only `ptyStateChanged`
   * event (terminalId + projectId + state + previousState + source) — never
   * the prompt, command, approval text, or any PTY content.
   *
   * Reliability guard: a `heuristic` source may NOT change or clear an
   * existing attention state. A conservative agent-only fallback may enter
   * attention, while richer osc/broker/provider signals remain authoritative.
   */
  setPtyState(
    terminalId: string,
    state: PtyState,
    source: PtyStateSource,
  ): void {
    const t = this.terminals.get(terminalId);
    if (!t) return;
    const previous = t.ptyState;
    if (previous === state) {
      // The canonical state is unchanged, but a richer signal may confirm it.
      // Upgrade the authority so a later low-reliability screen transition or
      // human Enter cannot clear a provider/broker/process-owned hard state.
      if (ptyStateSourceAuthority(source) <= ptyStateSourceAuthority(t.ptyStateSource)) return;
      t.ptyStateSource = source;
    } else {
      if (!canTransitionTo(previous, state, source, t.ptyStateSource)) return;
      t.ptyState = state;
      t.ptyStateSource = source;
    }
    // The screen rule id belongs to the screen source only — another source
    // owning the state makes it stale (metadata-only, mirrors state-explain).
    if (source !== "screen") t.screenRuleId = null;
    // Dirty-input gate (2026-09-27): a completed turn has no pending reply.
    // Reset wherever the state actually lands on "done", from any source, so
    // a stray later banner cannot re-consult Jev on the idle home prompt and
    // re-file the fresh-idle false attention.
    if (state === "done" && previous !== "done") {
      t.awaitingReply = false;
    }
    const payload: PtyStateChanged = {
      terminalId,
      projectId: t.info.projectId,
      state,
      previousState: previous,
      source,
    };
    // Metadata only: state + ids + source. No message, no command, no prompt.
    logger.info("state", "pty.state.changed", "Terminal PTY state changed", {
      terminalId,
      state,
      previousState: previous,
      source,
    });
    if (source !== "screen") {
      this.agentDetection.recordFallback(terminalId, `${source}:${state}`);
    }
    this.events.emit("ptyStateChanged", payload);
  }

  /**
   * Apply a notification classification (from OSC 9/99/777 or the agent-only
   * fallback regex) to a terminal's state. Maps the coarse kind to a canonical
   * attention state via the OSC source. The triggering message is discarded
   * immediately after classification — never stored or forwarded.
   */
  private _applyNotificationKind(
    terminal: ManagedTerminal,
    kind: NotificationKind,
    source: PtyStateSource = "osc",
  ): void {
    const id = terminal.info.id;
    switch (kind) {
      case "approval":
        this.setPtyState(id, "approval_required", source);
        return;
      case "input":
        this.setPtyState(id, "waiting_input", source);
        return;
      case "blocked":
        this.setPtyState(id, "blocked", source);
        return;
      case "error":
        this.setPtyState(id, "error", source);
        return;
      case "done":
        this.setPtyState(id, "done", source);
        return;
      case "info":
        // Not an attention signal; leave current state alone.
        return;
    }
  }

  /**
   * Last completed CommandResult for a terminal, or null when the shell has
   * not emitted a rich OSC 633 lifecycle (E+C+D) yet. Unsupported shells
   * (cmd.exe, OSC 133-only) stay null — we never fabricate a command or exit.
   */
  getLastCommand(terminalId: string): CommandResult | null {
    const t = this.terminals.get(terminalId);
    return t ? t.lastCommand : null;
  }

  /** Parse PTY output for ANSI title sequences and LLM state changes. */
  private _detectPtyState(terminal: ManagedTerminal, data: string): void {
    // Reset title buffer for this chunk
    let foundTitle: string | undefined;
    // Parse title escape sequences: \x1b]0;TITLE\x07 or \x1b]0;TITLE\x1b\\
    // eslint-disable-next-line no-control-regex -- ANSI OSC 0 title sequence: \x1b \x07 are protocol framing delimiters, no alternative
    const titleRe = /\x1b\]0;([\s\S]*?)(?:\x07|\x1b\\)/g;
    let m: RegExpExecArray | null;
    while ((m = titleRe.exec(data)) !== null) {
      foundTitle = m[1];
    }

    // A title is ONLY a title — it must never drive the running state. The
    // shell/agent re-emits OSC 0 titles on every prompt render and spinner
    // frame, so treating any title as "running" kept long-lived CLIs (Claude
    // Code, Codex) stuck yellow forever. applyTitleToInfo updates the header
    // label only; state is driven by data activity + OSC lifecycle below.
    if (foundTitle) {
      terminal.titleBuffer = foundTitle;
      const updated = applyTitleToInfo(terminal.info, foundTitle);
      if (updated !== terminal.info) {
        terminal.info = updated;
        this.events.emit("terminalListChanged", { projectId: terminal.info.projectId });
      }
    }

    // Agent data activity: real output from an agent terminal means the LLM
    // is computing/streaming → running. We then arm a debounce so that when
    // output goes quiet for QUIET_MS the state falls back to done. A bare OSC
    // 0 title sequence is NOT activity (the shell re-emits it every prompt
    // render / spinner frame), so strip title sequences before deciding.
    // Attention states except error are NOT cleared by activity — only
    // osc/broker/provider may clear them. An error attempt still goes to
    // setPtyState: the chokepoint (canTransitionTo) lets activity retract a
    // screen/heuristic-filed error while hard-sourced errors stay filed.
    if (terminal.info.isAgent) {
      const stripped = stripTerminalControl(data);
      if (stripped.trim().length > 0) {
        terminal.jevDeferrals = 0;
        this._armAgentQuietTimer(terminal);
        if (!isAttentionState(terminal.ptyState) || terminal.ptyState === "error") {
          this.setPtyState(terminal.info.id, "running", "heuristic");
        }
      }
    }

    // Detect PowerShell prompt → shell is ready (heuristic). Also fires from
    // "running" so the state clears once the agent exits and control returns
    // to the shell. The chokepoint guard ensures this cannot clear an
    // attention state — only osc/broker/provider may. Plain (non-agent)
    // shells rely on this + the OSC command lifecycle; agent shells rely on
    // the quiet-debounce above instead, so skip the prompt check for them.
    if (!terminal.info.isAgent) {
      const lastLine = data.split(/\r?\n/).pop() ?? "";
      if (/^PS [Dd]:/.test(lastLine) || lastLine.includes("PS D:\\")) {
        this.setPtyState(terminal.info.id, "done", "heuristic");
      }
    }

    // Agent-only fallback: a conservative regex for attention signals in
    // plain PTY text. ONLY applied to agent terminals (isAgent), and only as
    // a last-resort hint — the OSC parser above is the reliable path. The
    // matched text is classified then discarded; never stored or logged.
    const hasScreenProfile = profileFamily(terminal.info.agentProfile ?? "") !== null;
    if (terminal.info.isAgent && !hasScreenProfile && !isAttentionState(terminal.ptyState)) {
      const kind = matchAgentFallbackAttention(data);
      // Fresh-idle false attention (2026-09-27): the fallback regex files
      // attention from plain output text. With no user-submitted turn pending,
      // an unrecognized "press enter"-style line is not owed attention — the
      // table has no error pattern, so only prompt kinds reach this block.
      if (kind && terminal.awaitingReply === true) {
        this._applyNotificationKind(terminal, kind, "heuristic");
      }
    }
  }

  /**
   * Arm (or re-arm) the agent quiet-debounce timer. Each chunk of agent output
   * pushes the deadline forward; when output stays silent for QUIET_MS the
   * terminal falls back to "done" (turn finished, waiting for next prompt).
   * Attention/error states are never cleared here — canTransitionTo refuses a
   * heuristic transition out of them, so the timer is a no-op while the agent
   * is waiting on a human. The timer is cleared on kill/dispose.
   */
  private _armAgentQuietTimer(terminal: ManagedTerminal): void {
    if (terminal.quietTimer) clearTimeout(terminal.quietTimer);
    const generation = (terminal.quietGen ?? 0) + 1;
    terminal.quietGen = generation;
    terminal.quietTimer = setTimeout(() => {
      terminal.quietTimer = null;
      // Only fall back to done from a working state. Attention/error must
      // survive the debounce (the user still needs to act).
      if (terminal.ptyState !== "running" && terminal.ptyState !== "starting") return;
      // Background-work override (green-lamp bug): the main agent can park
      // its turn on background agents/teammates — "Waiting for N background
      // agents to finish", teammate rows with ticking elapsed/token
      // counters, "N shells, M monitors" — while emitting NO output and
      // showing an idle-looking prompt. The cached screen frame is the
      // ground truth: while any of those live signals is present the turn is
      // still in progress, so re-arm the debounce instead of filing done.
      // This check runs BEFORE the Jev consult so the quiet heuristic and
      // Jev can never outrank concrete screen evidence of background work.
      try {
        if (hasBackgroundWorkSignal(this.agentDetection.getScreenText(terminal.info.id))) {
          this._armAgentQuietTimer(terminal);
          return;
        }
      } catch {
        // Fail open to the normal heuristic path below.
      }
      // council 2026-09-26 R3 #2: isEnabled() runs in a sync timer callback —
      // any throw here would be an uncaught main-process exception. Fail open.
      let verifier: PtyManagerHooks["jevVerifier"];
      try {
        verifier = this.hooks.jevVerifier?.isEnabled() ? this.hooks.jevVerifier : undefined;
      } catch {
        verifier = undefined;
      }
      if (!verifier) {
        this.setPtyState(terminal.info.id, "done", "heuristic");
        return;
      }
      this._resolveQuietWithJev(terminal, generation, verifier).catch(() => {
        // Unreachable in practice (the body never rejects) — belt & braces so
        // a terminal can never be orphaned in "running" by a coding slip.
        try {
          if (terminal.quietGen === generation) this.setPtyState(terminal.info.id, "done", "heuristic");
        } catch {
          /* dispose raced us; nothing to do */
        }
      });
    }, AGENT_QUIET_MS);
  }

  /**
   * Jev 注意力複判: ask Jev what the quiet screen means before declaring done.
   * Confident "waiting_input" → attention (the rules missed a prompt);
   * confident "still_working" → re-arm instead of a premature done (capped);
   * anything else, or a stale answer → the original heuristic done.
   * council 2026-09-26 R3 #1: the whole consult is wrapped with a hard timeout
   * and try/catch — a hung provider must not pin the terminal yellow forever.
   */
  private async _resolveQuietWithJev(
    terminal: ManagedTerminal,
    generation: number,
    verifier: NonNullable<PtyManagerHooks["jevVerifier"]>,
  ): Promise<void> {
    let result: Awaited<ReturnType<JevVerifier["classifyQuietScreen"]>>;
    try {
      result = await Promise.race([
        verifier
          .classifyQuietScreen(this.agentDetection.getScreenText(terminal.info.id) ?? "")
          .catch(() => null),
        new Promise<null>((resolve) => setTimeout(resolve, JEV_TIMEOUT_MS, null)),
      ]);
    } catch {
      result = null;
    }
    // New output (a newer quiet streak) or a state change while Jev thought:
    // this answer describes a screen that no longer exists.
    if (terminal.quietGen !== generation || !this.terminals.has(terminal.info.id)) return;
    if (terminal.ptyState !== "running" && terminal.ptyState !== "starting") return;
    if (result?.verdict === "waiting_input") {
      if (terminal.awaitingReply === true) {
        this.setPtyState(terminal.info.id, "waiting_input", "jev");
      } else {
        // Fresh-idle false attention (2026-09-27): on an untouched session the
        // cursor sits at the ambiguous idle home prompt — Jev can read it as
        // confident "waiting_input". With no user-submitted turn pending, that
        // is not attention: end the turn dark, exactly like the no-verifier path.
        this.setPtyState(terminal.info.id, "done", "heuristic");
      }
      return;
    }
    if (result?.verdict === "still_working" && (terminal.jevDeferrals ?? 0) < JEV_MAX_DEFERRALS) {
      terminal.jevDeferrals = (terminal.jevDeferrals ?? 0) + 1;
      this._armAgentQuietTimer(terminal);
      return;
    }
    this.setPtyState(terminal.info.id, "done", "heuristic");
  }

  /**
   * Feed PTY output through the OSC 133/633 parser and drive the command
   * lifecycle state machine. A CommandResult is built ONLY on a rich lifecycle
   * (E command + C pre-exec + D finished). The command is redactEgress'd and
   * length-capped before the result is stored or emitted; logger metadata
   * never carries the command text (logging-api-final-design §A.2).
   */
  private _parseOsc(terminal: ManagedTerminal, data: string): void {
    const { markers, carry } = parseOscChunk(data, terminal.oscCarry);
    terminal.oscCarry = carry;
    for (const marker of markers) {
      this._applyOscMarker(terminal, marker);
    }
  }

  private _applyOscMarker(terminal: ManagedTerminal, marker: OscMarker): void {
    switch (marker.kind) {
      case "command": {
        // E: start (or restart) a lifecycle with the exact command. cwd is the
        // terminal's spawn cwd — OSC 633 does not carry a cwd marker in the
        // minimal set, and we never guess a different one.
        const command = sanitizeCommand(marker.value as string);
        terminal.lifecycle = command.trim() ? {
          command,
          cwd: terminal.shellCwd,
          startedAt: null,
          hasPreExec: false,
        } : null;
        return;
      }
      case "preExec": {
        // C: command is about to run. If we have an in-flight lifecycle (from
        // E), mark it ready. A C without a preceding E cannot produce a result
        // (no command) — leave lifecycle null.
        if (terminal.lifecycle) {
          terminal.lifecycle.hasPreExec = true;
          terminal.lifecycle.startedAt = new Date().toISOString();
          // A real command is executing → running. OSC source may enter/clear
          // attention states, so this also clears a stale attention state.
          this.setPtyState(terminal.info.id, "running", "osc");
        }
        return;
      }
      case "finished": {
        // D: command finished. Only emit when we have a complete rich lifecycle
        // (E + C). Missing E or C → drop silently, never fabricate.
        const life = terminal.lifecycle;
        if (!life || !life.hasPreExec || !life.startedAt) {
          terminal.lifecycle = null;
          return;
        }
        const endedAt = new Date().toISOString();
        const durationMs = Math.max(0, Date.parse(endedAt) - Date.parse(life.startedAt));
        const result = commandResultSchema.parse({
          id: createId(),
          cwd: life.cwd,
          command: life.command,
          exitCode: typeof marker.value === "number" ? marker.value : null,
          startedAt: life.startedAt,
          endedAt,
          durationMs,
        });
        terminal.lastCommand = result;
        terminal.lifecycle = null;
        // D closes a command → done (or error on non-zero exit). OSC source.
        this.setPtyState(terminal.info.id, result.exitCode === 0 ? "done" : "error", "osc");
        // Metadata only: never the command text. cwd is already a workspace
        // path the logger sees elsewhere; exitCode/duration are non-sensitive.
        logger.info("pty", "terminal.command.finished", "Shell command finished", {
          terminalId: terminal.info.id,
          exitCode: result.exitCode,
          durationMs: result.durationMs,
        });
        this.events.emit("terminalCommand", {
          terminalId: terminal.info.id,
          projectId: terminal.info.projectId,
          result,
        });
        return;
      }
      case "promptStart":
      case "promptEnd":
        // A/B are prompt boundaries; not needed to build a result. Clearing an
        // orphaned lifecycle on a new prompt start prevents a stale E (with no
        // matching C/D) from leaking into the next command.
        if (marker.kind === "promptStart") {
          terminal.lifecycle = null;
          // A new prompt means the shell is idle and waiting → done. OSC
          // source, so it can clear a prior attention state legitimately.
          this.setPtyState(terminal.info.id, "done", "osc");
        }
        return;
      case "cwd":
        terminal.shellCwd = marker.value as string;
        return;
      case "notification": {
        // OSC 9/99/777 attention marker. The notificationKind is the only thing
        // we keep — the message text was discarded inside the parser. Map to a
        // canonical attention state via the OSC source.
        if (marker.notificationKind) {
          this._applyNotificationKind(terminal, marker.notificationKind);
        }
        return;
      }
    }
  }

  snapshots(projectId: string): Array<{ info: TerminalInfo; scrollback: string; revision: number }> {
    return [...this.terminals.values()]
      .filter((terminal) => {
        // Pre-read flush: a hydrating client must not get a snapshot missing
        // bytes still held by the pending window (2026-09-27).
        this._flushOutput(terminal);
        return terminal.info.projectId === projectId;
      })
      .map((terminal) => ({
        info: terminal.info,
        // Mode preamble first (#47): the ring may have evicted the original
        // ?1049h / mouse-enable bytes; without them a hydrated xterm stays in
        // the normal buffer with mouse reporting off. Empty for plain shells,
        // so their snapshots are byte-identical to before.
        scrollback: `${terminal.decModes.preamble()}${terminal.scrollback.join("")}`,
        revision: terminal.outputRevision,
      }));
  }

  /** Snapshot of all terminals (across all projects) for the dashboard: info + ptyState + lastCommand. */
  dashboardSnapshot(): Array<{ info: TerminalInfo; ptyState: PtyState; lastCommand: CommandResult | null }> {
    return [...this.terminals.values()].map((terminal) => ({
      info: terminal.info,
      ptyState: terminal.ptyState,
      lastCommand: terminal.lastCommand,
    }));
  }

  /**
   * Current scrollback buffer mode (issue #13): "alternate-screen" when DEC mode
   * 1049 is enabled per the DecModeTracker. null when the terminal is unknown.
   */
  getScrollbackMode(terminalId: string): ScrollbackMode | null {
    const terminal = this.terminals.get(terminalId);
    if (!terminal) return null;
    return terminal.decModes.isEnabled(1049) ? "alternate-screen" : "normal";
  }

  /**
   * Last screen text cached by the detection engine (bounded: <=80 lines/16K),
   * or null for untracked terminals. Cache read only — the VT buffer must never
   * be read outside the engine's post-write evaluation (vt-snapshot.ts contract).
   */
  getScreenSnapshot(terminalId: string): string | null {
    return this.agentDetection.getScreenText(terminalId);
  }

  /**
   * Tail of the joined raw scrollback for the handoff exporter (user-initiated
   * export of their own session). Bounded by maxChars; null for unknown ids.
   * This is a data path to the exporter only — never logged.
   */
  getScrollbackTail(terminalId: string, maxChars: number): string | null {
    // council 2026-09-26 R3 #11: guard the bound, and accumulate from the END
    // instead of join-then-slice (a 2 MB buffer must not be materialised whole
    // just to be truncated). The first retained line is dropped when partial —
    // same "no headless line" rule the JSONL tail reader uses.
    if (!Number.isFinite(maxChars) || maxChars <= 0) return null;
    const terminal = this.terminals.get(terminalId);
    if (!terminal) return null;
    // Pre-read flush: bounded tails must not miss bytes still held by the
    // pending window (2026-09-27).
    this._flushOutput(terminal);
    let total = 0;
    let start = terminal.scrollback.length;
    while (start > 0) {
      const prev = terminal.scrollback[start - 1] ?? "";
      if (total + prev.length > maxChars) break;
      start -= 1;
      total += prev.length;
    }
    let tail = terminal.scrollback.slice(start).join("");
    if (tail.length > maxChars) tail = tail.slice(-maxChars);
    if (start > 0 || tail.length === maxChars) {
      const nl = tail.indexOf("\n");
      if (nl > 0 && nl < tail.length - 1) tail = tail.slice(nl + 1);
    }
    return tail;
  }

  dispose(): void {
    this.claudeKeepalive.dispose();
    for (const terminal of this.terminals.values()) {
      // Flush-first, best-effort: trailing output precedes the exit on teardown.
      this._flushOutput(terminal);
      if (terminal.resizeTimer) clearTimeout(terminal.resizeTimer);
      if (terminal.quietTimer) {
        clearTimeout(terminal.quietTimer);
        terminal.quietTimer = null;
      }
      if (terminal.info.status === "running") {
        this.setPtyState(terminal.info.id, "done", "process");
        terminal.process.kill();
      }
      terminal.dataDisposer?.dispose();
      terminal.exitDisposer?.dispose();
      terminal.dataDisposer = null;
      terminal.exitDisposer = null;
    }
    this.terminals.clear();
    this.agentDetection.dispose();
  }

  /** PTY chunk ingest: append to the pending window, flush early on echo/size/sync mode, else arm the timer. */
  private _onPtyChunk(managed: ManagedTerminal, data: string): void {
    const pending = (managed.outputPending ??= []);
    pending.push(data);
    managed.outputPendingLength = (managed.outputPendingLength ?? 0) + data.length;
    const flushMs = this.hooks.outputFlushMs ?? OUTPUT_FLUSH_MS;
    const maxChars = this.hooks.outputPendingMaxChars ?? OUTPUT_PENDING_MAX_CHARS;
    if (managed.echoPending || managed.outputPendingLength >= maxChars || flushMs <= 0) {
      this._flushOutput(managed);
      return;
    }
    if (!managed.outputFlushTimer) {
      managed.outputFlushTimer = setTimeout(() => {
        managed.outputFlushTimer = null;
        this._flushOutput(managed);
      }, flushMs);
    }
  }

  /**
   * Flush the pending output window: append+trim once, run each stream parser
   * ONCE on the joined text (all parsers carry state between chunks, so parsing
   * the join is semantically equivalent to per-chunk parsing), bump the output
   * revision once, and emit a single terminalData event.
   */
  private _flushOutput(managed: ManagedTerminal): void {
    if (managed.outputFlushTimer) {
      clearTimeout(managed.outputFlushTimer);
      managed.outputFlushTimer = null;
    }
    const pending = managed.outputPending;
    if (!pending || pending.length === 0) {
      managed.echoPending = false;
      return;
    }
    const data = pending.join("");
    managed.outputPending = [];
    managed.outputPendingLength = 0;
    managed.echoPending = false;
    // Chunked append: `${scrollback}${data}` re-copied the whole buffer on
    // every PTY tick. The trim rule is unchanged — truncateScrollback's
    // semantics applied to the chunk list's total length.
    managed.scrollback.push(data);
    managed.scrollbackLength += data.length;
    if (managed.scrollbackLength > SCROLLBACK_MAX_CHARS) {
      managed.scrollbackLength = trimScrollbackChunks(
        managed.scrollback,
        managed.scrollbackLength,
        SCROLLBACK_MAX_CHARS,
      );
    }
    managed.decModes.ingest(data);
    this.claudeKeepalive.recordOutput(managed.info.id);
    if (managed.info.isAgent) this.agentDetection.ingest(managed.info.id, data);
    this._detectPtyState(managed, data);
    this._parseOsc(managed, data);
    managed.outputRevision += 1;
    this.events.emit("terminalData", {
      terminalId: managed.info.id,
      projectId: managed.info.projectId,
      data,
      revision: managed.outputRevision,
    });
  }

  private requireTerminal(terminalId: string): ManagedTerminal {
    const terminal = this.terminals.get(terminalId);
    if (!terminal) throw new Error("Terminal not found.");
    return terminal;
  }
}

/**
 * Agent-only fallback attention detector. A conservative regex over plain PTY
 * text for terminals where OSC 9/99/777 markers are unavailable. ONLY matches
 * explicit, unambiguous attention phrases — false positives here light up the
 * inbox for no reason, so the bar is high (anchored, word-boundary, specific).
 *
 * The matched text is classified via classifyNotificationMessage and then
 * discarded; never stored, logged, or forwarded. Returns null when nothing
 * attention-worthy is found (the common case — ordinary agent output).
 *
 * ponytail: regex over PTY text is inherently fuzzy. The OSC parser is the
 * reliable path; this is a last-resort hint for agent panes without it. If
 * false positives appear, tighten the phrases here rather than disabling it.
 */
const AGENT_FALLBACK_PATTERNS: Array<{ re: RegExp; kind: NotificationKind }> = [
  // Approval: Claude Code / Codex permission prompts. Anchor to the line head
  // the CLI uses, so ordinary prose containing "allow" does not match.
  { re: /^\s*(Do you want to|Would you like to|Allow|Approve|Trust)\b.*\??\s*$/im, kind: "approval" },
  // Selection / input: Codex/Claude list-choice prompts ("Enter to select",
  // "Type your response", "Press enter to continue"). These need a human pick.
  { re: /^\s*(Enter to select|Press enter to continue|Type your response|Choose an option|Select an option)\b/im, kind: "input" },
  // Blocked: explicit lock/wait-for-resource language.
  { re: /^\s*(Blocked|Deadlock|Waiting for lock|Cannot proceed)\b/im, kind: "blocked" },
  // No "Error:" fallback: agent tool stderr legitimately starts lines with it,
  // which filed unrecoverable error states. Fatal errors exit the process; the
  // exit code owns the error state (see onExit).
];

export function matchAgentFallbackAttention(data: string): NotificationKind | null {
  // Only scan the last few lines — attention prompts are always at the bottom
  // of the visible buffer. Scanning the whole chunk would match source code.
  const tail = stripTerminalControl(data).slice(-512);
  for (const { re, kind } of AGENT_FALLBACK_PATTERNS) {
    if (re.test(tail)) return kind;
  }
  return null;
}

/** Remove ANSI/OSC framing while preserving visible text for state matching. */
function stripTerminalControl(data: string): string {
  return data
    // eslint-disable-next-line no-control-regex -- ANSI OSC framing
    .replace(/\x1b\][\s\S]*?(?:\x07|\x1b\\)/g, "")
    // eslint-disable-next-line no-control-regex -- ANSI CSI framing
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");
}

// Shell executable resolution lives in ./shell-resolver (public #10):
// "powershell" => Windows PowerShell 5.1 explicitly; "pwsh" => pwsh 7
// verified on disk or a detectable failure (never a bare spawn-guaranteed-
// to-fail name). resolve happens per-spawn — spawning is rare and the checks
// are a handful of existsSync calls.

function shellArgs(profile: TerminalCreateInput["profile"]): string[] {
  if (profile === "powershell" || profile === "pwsh")
    return [
      "-NoLogo",
      "-NoExit",
      "-Command",
      // Disable PSReadLine history predictions: the history file accumulates
      // arbitrary shell input (including sensitive data users paste) which then
      // appears as ghost-text predictions in every new session, leaking content
      // the user didn't intend to see again. None = no inline/list suggestions.
      //
      // Then install OSC 633 shell-integration markers (VS Code FinalTerm
      // protocol). This wraps the user's existing prompt — it does NOT modify
      // their $PROFILE. PSReadLine's OnAccept pipeline fires at the read
      // boundary (Enter pressed) so we emit E (escaped exact command) + C
      // (pre-exec) exactly once per accepted line; the next prompt render emits
      // D (finished, with $LASTEXITCODE) + A/B (prompt start/end). If
      // PSReadLine is absent or FullLanguage is unavailable, we silently fall
      // back to plain-text mode (no markers → getLastCommand returns null).
      pwshBootstrapCommand(),
    ];
  if (profile === "cmd") return ["/k", "chcp 65001 > nul"];
  // zsh/bash: spawn login shell for consistent PATH/profile loading.
  if (profile === "zsh" || profile === "bash") return ["-l"];
  return [];
}

/**
 * Build the pwsh -Command bootstrap string: UTF-8 setup + PSReadLine prediction
 * disable + OSC 633 shell-integration marker injection. The marker injection
 * wraps the user's existing prompt and PSConsoleHostReadLine functions to emit
 * E (escaped exact command) + C (pre-exec) at the read boundary; the wrapped
 * prompt emits D (finished, using PowerShell's reliable 0/1 `$?` status) plus
 * current cwd and A/B on the next render. Falls back to plain-text mode (no
 * markers) when PSReadLine is unavailable or the language mode is not
 * FullLanguage (ConstrainedLanguage blocks script handlers).
 *
 * Exported for unit testing the marker payload shape.
 */
export function pwshBootstrapCommand(): string {
  // This follows VS Code's PowerShell integration shape: wrap the existing
  // Prompt and PSConsoleHostReadLine functions instead of replacing the
  // user's Enter key handler. The prompt captures $? before doing any work so
  // a previous native failure cannot poison a later successful cmdlet.
  return [
    "[Console]::OutputEncoding=[Text.Encoding]::UTF8",
    "$OutputEncoding=[Text.Encoding]::UTF8",
    "chcp 65001 > $null",
    "if (Get-Module PSReadLine) { Set-PSReadLineOption -PredictionSource None }",
    "if ((Get-Module PSReadLine) -and $ExecutionContext.SessionState.LanguageMode -eq 'FullLanguage' -and -not (Test-Path variable:global:__CotermShellIntegration)) {",
    "  $Global:__CotermShellIntegration = @{ OriginalPrompt = $function:Prompt; OriginalReadLine = $function:PSConsoleHostReadLine; InExecution = $false }",
    "  function Global:__CotermEscape([string]$value) {",
    "    $builder = [Text.StringBuilder]::new()",
    "    foreach ($character in $value.ToCharArray()) {",
    "      $code = [int]$character",
    "      if ($code -eq 92) { [void]$builder.Append('\\\\') } elseif ($code -le 32 -or $code -eq 59) { [void]$builder.Append(('\\x{0:x2}' -f $code)) } else { [void]$builder.Append($character) }",
    "    }",
    "    return $builder.ToString()",
    "  }",
    "  function Global:Prompt {",
    "    $fakeCode = [int]!$Global:?",
    "    Microsoft.PowerShell.Core\\Set-StrictMode -Off",
    "    $result = ''",
    "    if ($Global:__CotermShellIntegration.InExecution) { $Global:__CotermShellIntegration.InExecution = $false; $result += ([char]27 + ']633;D;' + $fakeCode + [char]7) }",
    "    $result += ([char]27 + ']633;A' + [char]7)",
    "    if ($PWD.Provider.Name -eq 'FileSystem') { $result += ([char]27 + ']633;P;Cwd=' + (__CotermEscape $PWD.ProviderPath) + [char]7) }",
    "    if ($fakeCode -ne 0) { Write-Error 'coterm-status' -ErrorAction Ignore }",
    "    $result += [string]::Join('', @($Global:__CotermShellIntegration.OriginalPrompt.Invoke()))",
    "    $result += ([char]27 + ']633;B' + [char]7)",
    "    return $result",
    "  }",
    "  function Global:PSConsoleHostReadLine {",
    "    $line = [string]$Global:__CotermShellIntegration.OriginalReadLine.Invoke()",
    "    $Global:__CotermShellIntegration.InExecution = $true",
    "    [Console]::Write([char]27 + ']633;E;' + (__CotermEscape $line) + [char]7 + [char]27 + ']633;C' + [char]7)",
    "    return $line",
    "  }",
    "}",
  ].join("; ");
}
