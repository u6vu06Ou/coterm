// AgentDetectionEngine — public contract (issue §2).
//
// Owns one VtSnapshot per tracked terminal. Ingests PTY data into the VT,
// coalesces evaluations (default 50ms), and emits candidates via onCandidate
// only when a rule matches. Never emits raw PTY, region text, or evidence.
//
// Ordering contract: xterm write callbacks fire in order; evaluations are
// scheduled after each write and coalesced so a burst of writes triggers one
// evaluation. After untrack(), no late callback fires (the terminal is
// removed from the map and its VT disposed before any pending evaluation can
// reference it).

import { ManifestLoader, type LoadResult } from "./manifest-loader";
import { evaluate } from "./rule-engine";
import type { BufferSnapshot } from "./regions";
import { VtSnapshot } from "./vt-snapshot";
import type {
  AgentCandidate,
  AgentDetectionEngineOptions,
  AgentStateExplanation,
  AgentStateSource,
  GateSummary,
  Manifest,
  MatchResult,
  PtyState,
  RegionName,
  TrackTerminalInput,
} from "./types";

const DEFAULT_EVALUATION_DELAY_MS = 50;
// Matches the agent API's MAX_TERMINALS (12). At 8, a 9th agent window was never
// tracked, so its alt-screen screenText stayed null and Agent API/eyes saw a blank
// screen ("啟動不起來") whenever the user already had 8 agent panes open.
const MAX_TRACKED = 12;

interface TrackedTerminal {
  vt: VtSnapshot;
  agentProfile: string;
  family: string;
  pendingTimer: ReturnType<typeof setTimeout> | null;
  lastMatchedRuleId: string | null;
  lastManifestVersion: string | null;
  /** Dedup survives a human acknowledgement until the old prompt disappears. */
  lastEmittedRuleId: string | null;
  lastEmittedManifestVersion: string | null;
  fallbackReason: string | null;
  // Cached last evaluation for getExplanation without re-running rules.
  lastMatch: MatchResult | null;
  lastRegion: RegionName | null;
  lastGateSummary: GateSummary | null;
  lastEvaluatedAt: string | null;
  /**
   * Last bounded screen text (issue #13 / AT-138). Updated only in evaluateNow
   * — the only point where reading the VT buffer is safe. This is the sole
   * usable text source while the terminal is on the alternate screen, where the
   * byte scrollback ring is full-repaint escape noise.
   */
  lastScreenText: string | null;
  // Guard against late callbacks after untrack.
  untracked: boolean;
}

// Profile family mapper (issue §5): map Coterm profile ids to a manifest
// family. claude-* → "claude-code", codex-* → "codex". Unknown → no manifest
// (the engine tracks but never emits a candidate).
export function profileFamily(agentProfile: string): string | null {
  if (agentProfile.startsWith("claude-")) return "claude-code";
  if (agentProfile.startsWith("codex-")) return "codex";
  return null;
}

export class AgentDetectionEngine {
  private readonly tracked = new Map<string, TrackedTerminal>();
  private readonly loader: ManifestLoader;
  private manifests = new Map<string, Manifest>();
  private readonly evaluationDelayMs: number;
  private readonly onCandidate: ((terminalId: string, candidate: AgentCandidate) => void) | undefined;
  private started = false;
  private disposed = false;

  constructor(opts: AgentDetectionEngineOptions = {}) {
    this.loader = new ManifestLoader(opts.userDataPath);
    this.evaluationDelayMs = opts.evaluationDelayMs ?? DEFAULT_EVALUATION_DELAY_MS;
    this.onCandidate = opts.onCandidate;
  }

  start(): Promise<void> {
    if (this.started || this.disposed) return Promise.resolve();
    const result = this.loader.load();
    this.manifests = result.manifests;
    // Hot reload: when an override changes, swap in the new manifest set. The
    // next evaluation per terminal uses the new manifests automatically.
    this.loader.startWatch((reload: LoadResult) => {
      this.manifests = reload.manifests;
    });
    this.started = true;
    return Promise.resolve();
  }

  trackTerminal(input: TrackTerminalInput): void {
    if (this.disposed) return;
    // Bounded: never track more than MAX_TRACKED terminals (issue §8: 8 panes).
    if (this.tracked.size >= MAX_TRACKED && !this.tracked.has(input.terminalId)) {
      return;
    }
    // If already tracked, just update the profile.
    const existing = this.tracked.get(input.terminalId);
    if (existing) {
      existing.agentProfile = input.agentProfile;
      existing.family = profileFamily(input.agentProfile) ?? "";
      this.resetScreenMatch(existing);
      return;
    }
    const vt = new VtSnapshot(input.cols, input.rows);
    this.tracked.set(input.terminalId, {
      vt,
      agentProfile: input.agentProfile,
      family: profileFamily(input.agentProfile) ?? "",
      pendingTimer: null,
      lastMatchedRuleId: null,
      lastManifestVersion: null,
      lastEmittedRuleId: null,
      lastEmittedManifestVersion: null,
      fallbackReason: null,
      lastMatch: null,
      lastRegion: null,
      lastGateSummary: null,
      lastEvaluatedAt: null,
      lastScreenText: null,
      untracked: false,
    });
  }

  updateProfile(terminalId: string, agentProfile: string): void {
    const t = this.tracked.get(terminalId);
    if (!t) return;
    t.agentProfile = agentProfile;
    t.family = profileFamily(agentProfile) ?? "";
    this.resetScreenMatch(t);
    t.fallbackReason = null;
  }

  // Ingest a PTY data chunk into the VT. The write callback fires once the
  // buffer reflects the data; we schedule an evaluation there (coalesced).
  // This guarantees we never read buffer.active before the write is applied
  // (issue §1: "write(data, callback) 後才讀 buffer.active").
  ingest(terminalId: string, data: string): void {
    const t = this.tracked.get(terminalId);
    if (!t || t.untracked) return;
    t.vt.write(data, () => {
      if (t.untracked) return;
      this.scheduleEvaluation(terminalId, t);
    });
  }

  resize(terminalId: string, cols: number, rows: number): void {
    const t = this.tracked.get(terminalId);
    if (!t) return;
    t.vt.resize(cols, rows);
  }

  untrack(terminalId: string): void {
    const t = this.tracked.get(terminalId);
    if (!t) return;
    // Mark untracked first so any in-flight write callback becomes a no-op,
    // then cancel the pending evaluation and dispose the VT.
    t.untracked = true;
    if (t.pendingTimer) {
      clearTimeout(t.pendingTimer);
      t.pendingTimer = null;
    }
    t.vt.dispose();
    this.tracked.delete(terminalId);
  }

  // Record a fallback classification (e.g. from the existing heuristic path).
  // Stored as metadata only; surfaces in getExplanation as fallbackReason.
  recordFallback(terminalId: string, reason: string): void {
    const t = this.tracked.get(terminalId);
    if (!t) return;
    this.clearScreenExplanation(t);
    t.fallbackReason = reason;
    t.lastEvaluatedAt = new Date().toISOString();
  }

  // Build a metadata-only explanation. Never includes the region text that was
  // evaluated — only the region name, gate summary, and matched rule id.
  getExplanation(
    terminalId: string,
    canonicalState: PtyState,
    authoritativeSource: AgentStateSource | null,
  ): AgentStateExplanation {
    const t = this.tracked.get(terminalId);
    const now = new Date().toISOString();
    if (!t) {
      return {
        canonicalState,
        authoritativeSource,
        agentProfile: null,
        matchedRuleId: null,
        fallbackReason: null,
        evaluatedRegion: null,
        gateSummary: null,
        manifestVersion: null,
        evaluatedAt: now,
      };
    }
    return {
      canonicalState,
      authoritativeSource,
      agentProfile: t.agentProfile,
      matchedRuleId: t.lastMatchedRuleId,
      fallbackReason: t.fallbackReason,
      evaluatedRegion: t.lastRegion,
      gateSummary: t.lastGateSummary,
      manifestVersion: t.lastManifestVersion,
      evaluatedAt: t.lastEvaluatedAt ?? now,
    };
  }

  /**
   * Last cached screen text for a tracked terminal, or null when untracked /
   * never evaluated. Reads the cache only — it never touches the VT buffer.
   */
  getScreenText(terminalId: string): string | null {
    return this.tracked.get(terminalId)?.lastScreenText ?? null;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const [id, t] of this.tracked) {
      t.untracked = true;
      if (t.pendingTimer) clearTimeout(t.pendingTimer);
      t.vt.dispose();
      this.tracked.delete(id);
    }
    this.loader.dispose();
  }

  // --- Internal: coalesced evaluation -----------------------------------
  private scheduleEvaluation(terminalId: string, t: TrackedTerminal): void {
    if (t.pendingTimer) return; // coalesce: one evaluation per delay window
    t.pendingTimer = setTimeout(() => {
      t.pendingTimer = null;
      if (t.untracked || this.disposed) return;
      this.evaluateNow(terminalId, t);
    }, this.evaluationDelayMs);
  }

  private evaluateNow(terminalId: string, t: TrackedTerminal): void {
    const manifest = this.manifests.get(t.family);
    if (!manifest) return; // no manifest for this family → no candidate
    const snapshot: BufferSnapshot = t.vt.boundedSnapshot();
    // Cache the current frame even when no rule matches: the cache is only
    // refreshed here, inside the post-write evaluation, never via a live read.
    t.lastScreenText = snapshot.lines.join("\n");
    const match = evaluate(snapshot, manifest);
    t.lastEvaluatedAt = new Date().toISOString();
    if (!match) {
      this.resetScreenMatch(t);
      return;
    }
    // Only emit when the matched rule changes (avoid re-emitting the same
    // state on every chunk). A fallback/human acknowledgement clears public
    // screen evidence but intentionally keeps this dedup latch until a
    // no-match is observed; otherwise the still-visible old prompt would
    // immediately re-file itself as "new" attention.
    if (
      t.lastEmittedRuleId === match.ruleId &&
      t.lastEmittedManifestVersion === match.manifestVersion
    ) {
      return;
    }
    t.lastMatch = match;
    t.lastRegion = match.region;
    t.lastGateSummary = match.gateSummary;
    t.lastMatchedRuleId = match.ruleId;
    t.lastManifestVersion = match.manifestVersion;
    t.lastEmittedRuleId = match.ruleId;
    t.lastEmittedManifestVersion = match.manifestVersion;
    t.fallbackReason = null;
    const candidate: AgentCandidate = {
      terminalId,
      state: match.state,
      matchedRuleId: match.ruleId,
      manifestVersion: match.manifestVersion,
      evaluatedAt: t.lastEvaluatedAt,
    };
    this.onCandidate?.(terminalId, candidate);
  }

  private resetScreenMatch(t: TrackedTerminal): void {
    this.clearScreenExplanation(t);
    t.lastEmittedRuleId = null;
    t.lastEmittedManifestVersion = null;
  }

  private clearScreenExplanation(t: TrackedTerminal): void {
    t.lastMatchedRuleId = null;
    t.lastManifestVersion = null;
    t.lastMatch = null;
    t.lastRegion = null;
    t.lastGateSummary = null;
  }

  // --- Test-only accessors ---------------------------------------------
  getTrackedCountForTests(): number {
    return this.tracked.size;
  }
  getManifestsForTests(): Map<string, Manifest> {
    return new Map(this.manifests);
  }
}
