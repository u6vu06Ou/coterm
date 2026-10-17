// Phase 6 (§11): shared voice-agent coordinator. ONE contract drives both
// desktop (Electron IPC) and mobile (authenticated web RPC) — the only
// surface-specific bits are the injected seams: how audio is captured, how
// audio is transcribed, how text is spoken. Policy, state machine,
// redaction-before-speak trust boundary (main-side), barge-in, bounded
// memory and lifecycle resets live here, exactly once.
//
// §11.1 bounded memory: recent turns are capped (AGENTAPI_VOICE_PANE_MAX_TURNS)
// and memory-only. Nothing here writes SQLite or any file.
// §11.3 barge-in: user speech during speaking/thinking → cancel TTS engine
// (clears the queued sentences too), interrupt the supervisor turn in main
// (epoch bump), and re-enter a fresh listening turn. Stale async results are
// dropped via stamp comparison at every await boundary.
// §11.5 lifecycle: lock/background/reconnect call handleLifecycleReset; the
// generation bump guarantees no stale final can re-enter (`no resend old
// finals`). Insecure/no-device contexts return an explicit unavailable
// reason; this module never fakes support.

import type { AgentApiVoiceTurnResult } from "@shared/types";
import {
  reduceVoiceAgentState,
  type VoiceAgentEvent,
  type VoiceAgentUiState,
} from "./agent-state-machine";
import type { VoiceAgentSpeechConfig } from "./tts";

export const AGENTAPI_VOICE_PANE_MAX_TURNS = 8;
/** Ignore a stray lifecycle event arriving within this window of a deliberate
 * mic press — mobile browsers fire visibilitychange on picture-in-picture. */
const LIFECYCLE_RESET_GUARD_MS = 250;

export interface VoiceAgentPaneTurn {
  role: "user" | "agentapi";
  text: string;
  at: number;
  /** Routing provenance for the panel (fast/relay/summary/supervisor). */
  source?: AgentApiVoiceTurnResult["source"];
  spoke: boolean;
  generation: number;
}

export interface VoiceAgentUtterance {
  text: string;
  status: "partial" | "final";
  generation: number;
}

export interface VoiceAgentSnapshot {
  state: VoiceAgentUiState;
  generation: number;
  active: boolean;
  muted: boolean;
  voiceSessionId: string | null;
  partial: string | null;
  lastUtterance: VoiceAgentUtterance | null;
  lastReply: { text: string; source: AgentApiVoiceTurnResult["source"]; spoke: boolean } | null;
  recentTurns: VoiceAgentPaneTurn[];
  error: string | null;
}

export interface VoiceAgentCaptureResult {
  audio: Uint8Array;
  mimeType: string;
}

/** Mic ownership seams (panel-provided). start() is fire-and-forget; any
 * failure surfaces via onSpeechError instead of a throw out of the loop. */
export interface VoiceAgentCapture {
  start(): void;
  /** Release and transcribe the take; null = cancelled/empty. */
  stop: () => Promise<VoiceAgentCaptureResult | null>;
  /** Hard cancel without a final (barge-in/lifecycle reset/stop). */
  cancel(): void;
  /** Barge-in monitor; active only while the coordinator subscribes. */
  onSpeechStart(callback: () => void): () => void;
  /** Endpoint detector callback. Persistent Live Voice uses this to end a
   * user turn after silence without any mic/send button press. */
  onUtteranceEnd?(callback: () => void): () => void;
  /** Rolling preview partials (only some captures stream; optional). */
  onPartial?(callback: (text: string, generation: number) => void): () => void;
}

export interface VoiceAgentPersistentSessionSeam {
  start(): Promise<string>;
  resume(voiceSessionId: string): Promise<void>;
  speechStarted(voiceSessionId: string): Promise<void>;
  turn(voiceSessionId: string, utterance: string): Promise<AgentApiVoiceTurnResult | null>;
  replyFinished(voiceSessionId: string): Promise<void>;
  mute(voiceSessionId: string): Promise<void>;
  unmute(voiceSessionId: string): Promise<void>;
  reconnecting(voiceSessionId: string): Promise<void>;
  reconnected(voiceSessionId: string): Promise<void>;
  end(voiceSessionId: string): Promise<void>;
}

export interface VoiceAgentCoordinatorSeams {
  capture: VoiceAgentCapture;
  /** Audio → final text. Desktop: IPC binary channel. Mobile: authenticated
   * RPC base64 channel. Same contract, one policy. */
  transcribe(audio: Uint8Array, mimeType: string, lang: string): Promise<string>;
  /** Utterance → routed turn (fast/relay/summary/supervisor) or null when the
   * in-flight turn was superseded/interrupted. */
  turn(utterance: string): Promise<AgentApiVoiceTurnResult | null>;
  /** Barge-in/interrupt IPC: epoch bump + supervisor abort in main. */
  interruptTurn(): Promise<unknown>;
  getLanguage(): string;
  getSpeechConfig(): VoiceAgentSpeechConfig;
  /** Text speaker. Returns { spoken:false } for the muted/no-voice fallback
   * so the panel keeps text-only display without pretending audio played. */
  speak(text: string, signal: AbortSignal): Promise<{ spoken: boolean; cancelled: boolean }>;
  /** Optional durable main-process session. When supplied, persistent Live
   * Voice routes final text through SQLite-backed session state instead of
   * calling the legacy one-turn seam directly. */
  persistentSession?: VoiceAgentPersistentSessionSeam;
  now?: () => number;
}

export class AgentApiVoiceAgentCoordinator {
  private state: VoiceAgentUiState = "idle";
  private generation = 0;
  private readonly listeners = new Set<(snapshot: VoiceAgentSnapshot) => void>();
  private partial: string | null = null;
  private lastUtterance: VoiceAgentUtterance | null = null;
  private lastReply: VoiceAgentSnapshot["lastReply"] = null;
  private errorMessage: string | null = null;
  private readonly recentTurns: VoiceAgentPaneTurn[] = [];
  private speechAbort: AbortController | null = null;
  private bargeUnsubscribe: (() => void) | null = null;
  private partialUnsubscribe: (() => void) | null = null;
  private endpointUnsubscribe: (() => void) | null = null;
  private sessionActive = false;
  private muted = false;
  private voiceSessionId: string | null = null;
  private lastMicPressAt = 0;
  private readonly now: () => number;
  constructor(private readonly seams: VoiceAgentCoordinatorSeams) {
    this.now = seams.now ?? (() => Date.now());
  }

  getState(): VoiceAgentUiState {
    return this.state;
  }

  getSnapshot(): VoiceAgentSnapshot {
    return {
      state: this.state,
      generation: this.generation,
      active: this.sessionActive,
      muted: this.muted,
      voiceSessionId: this.voiceSessionId,
      partial: this.partial,
      lastUtterance: this.lastUtterance ? { ...this.lastUtterance } : null,
      lastReply: this.lastReply ? { ...this.lastReply } : null,
      recentTurns: this.recentTurns.map((turn) => ({ ...turn })),
      error: this.errorMessage,
    };
  }

  /**
   * Human-like Live Voice entry point. This is intentionally separate from
   * the legacy push-to-talk methods so existing desktop dictation semantics
   * remain compatible while mobile can opt into a persistent call.
   */
  async startSession(existingVoiceSessionId?: string): Promise<void> {
    if (this.sessionActive) {
      if (!this.muted && (this.state === "idle" || this.state === "error")) await this.startListening();
      return;
    }
    if (this.seams.persistentSession) {
      if (existingVoiceSessionId) {
        await this.seams.persistentSession.resume(existingVoiceSessionId);
        this.voiceSessionId = existingVoiceSessionId;
      } else {
        this.voiceSessionId = await this.seams.persistentSession.start();
      }
    }
    this.sessionActive = true;
    this.muted = false;
    if (this.state === "reconnecting") {
      this.dispatch({ type: "reconnected", generation: this.generation });
      this.emit();
    }
    await this.startListening();
  }

  async endSession(): Promise<void> {
    const durableId = this.voiceSessionId;
    this.sessionActive = false;
    this.muted = false;
    this.voiceSessionId = null;
    this.generation += 1;
    this.stopSpeaking();
    this.seams.capture.cancel();
    this.unsubscribePartial();
    this.unsubscribeEndpoint();
    this.partial = null;
    this.dispatch({ type: "stop", generation: this.generation });
    this.emit();
    if (durableId && this.seams.persistentSession) {
      await this.seams.persistentSession.end(durableId).catch(() => undefined);
    }
  }

  async mute(): Promise<void> {
    if (!this.sessionActive || this.muted) return;
    this.muted = true;
    this.unsubscribeEndpoint();
    if (this.state === "listening" || this.state === "transcribing") {
      this.generation += 1;
      this.seams.capture.cancel();
      this.unsubscribePartial();
      this.partial = null;
      this.dispatch({ type: "stop", generation: this.generation });
    }
    this.emit();
    if (this.voiceSessionId && this.seams.persistentSession) {
      await this.seams.persistentSession.mute(this.voiceSessionId).catch(() => undefined);
    }
  }

  async unmute(): Promise<void> {
    if (!this.sessionActive || !this.muted) return;
    if (this.voiceSessionId && this.seams.persistentSession) {
      await this.seams.persistentSession.unmute(this.voiceSessionId);
    }
    this.muted = false;
    this.emit();
    if (this.state === "idle" || this.state === "error") await this.startListening();
  }

  onChange(callback: (snapshot: VoiceAgentSnapshot) => void): () => void {
    this.listeners.add(callback);
    callback(this.getSnapshot());
    return () => this.listeners.delete(callback);
  }

  /** Push-to-talk press. Barge-in while speaking stays the SAME call —
   * the coordinator routes by state. */
  async startListening(): Promise<void> {
    if (this.sessionActive && this.muted) return;
    if (this.state === "speaking" || this.state === "thinking") {
      await this.bargeIn();
      return;
    }
    if (this.state !== "idle" && this.state !== "error") return;
    this.generation += 1;
    this.lastMicPressAt = this.now();
    this.errorMessage = null;
    this.partial = null;
    const generation = this.generation;
    this.dispatch({ type: "startListening", generation });
    this.emit();
    this.seams.capture.start();
    this.subscribePartial(generation);
    if (this.sessionActive) this.subscribeEndpoint(generation);
  }

  /** Push-to-talk release → transcribing → thinking → speaking. */
  async stopListening(): Promise<void> {
    if (this.state !== "listening") return;
    const generation = this.generation;
    this.dispatch({ type: "stopListening", generation });
    this.emit();
    this.unsubscribePartial();
    this.unsubscribeEndpoint();
    const result = await this.seams.capture.stop();
    if (!this.isCurrent(generation)) return; // superseded mid-stop
    if (!result || result.audio.byteLength === 0) {
      this.dispatch({ type: "stop", generation });
      this.emit();
      await this.restartPersistentListening();
      return;
    }
    await this.transcribeAndTurn(result, generation);
  }

  /** Typed dry-run/Voice Playground entry: same routing, no mic needed. */
  async runTextTurn(utterance: string): Promise<void> {
    const text = utterance.trim();
    if (!text) return;
    if (this.state === "speaking" || this.state === "thinking") await this.bargeIn();
    if (this.state === "listening" || this.state === "transcribing") {
      // A typed playground command takes ownership of the turn. Cancel the
      // pending mic take instead of leaving a recorder alive or submitting a
      // second, late transcription into the typed turn.
      this.generation += 1;
      this.seams.capture.cancel();
      this.unsubscribePartial();
      this.partial = null;
      this.dispatch({ type: "stop", generation: this.generation });
    }
    if (this.state === "error") {
      // A failed mic take must not brick the text path; reset then proceed.
      this.dispatch({ type: "stop", generation: this.generation });
      this.errorMessage = null;
    }
    this.generation += 1;
    const generation = this.generation;
    this.errorMessage = null;
    this.lastUtterance = { text, status: "final", generation };
    this.recordTurn({ role: "user", text, generation, spoke: false });
    this.dispatch({ type: "transcribed", generation, text });
    this.emit();
    await this.resolveTurn(text, generation);
  }

  /** Manual interrupt button: same machinery as barge-in, without reopening
   * the mic afterwards. */
  async interrupt(): Promise<void> {
    if (this.state !== "speaking" && this.state !== "thinking") return;
    const generation = this.generation;
    this.stopSpeaking();
    await this.seams.interruptTurn().catch(() => undefined);
    this.dispatch({ type: "stop", generation });
    this.emit();
  }

  /**
   * §11.5 lifecycle: page hidden (phone lock/background) or socket
   * rehydrate. Never resume a half-finished capture and NEVER re-send an old
   * final — the generation bump makes every in-flight await a dud.
   */
  handleLifecycleReset(reason: "hidden" | "rehydrate" | "offline" | "online" | "visible"): void {
    // Guard against the deliberate press→hide race on mobile (PiP etc).
    if (reason === "hidden" && this.now() - this.lastMicPressAt < LIFECYCLE_RESET_GUARD_MS) return;
    if (this.sessionActive && (reason === "rehydrate" || reason === "online" || reason === "visible")) {
      if (this.state !== "reconnecting") return;
      if (this.voiceSessionId && this.seams.persistentSession) {
        void this.seams.persistentSession.reconnected(this.voiceSessionId).catch(() => undefined);
      }
      this.generation += 1;
      this.dispatch({ type: "reconnected", generation: this.generation });
      this.emit();
      if (!this.muted) void this.startListening();
      return;
    }
    if (this.state === "idle" && !this.partial && !this.sessionActive) return;
    this.generation += 1;
    this.stopSpeaking();
    this.seams.capture.cancel();
    this.unsubscribePartial();
    this.unsubscribeEndpoint();
    this.partial = null;
    this.dispatch({ type: this.sessionActive ? "reconnecting" : "stop", generation: this.generation });
    this.emit();
    if (this.sessionActive && this.voiceSessionId && this.seams.persistentSession) {
      void this.seams.persistentSession.reconnecting(this.voiceSessionId).catch(() => undefined);
    }
  }

  dispose(): void {
    this.sessionActive = false;
    this.muted = false;
    this.voiceSessionId = null;
    this.generation += 1;
    this.stopSpeaking();
    this.seams.capture.cancel();
    this.unsubscribePartial();
    this.unsubscribeEndpoint();
    this.dispatch({ type: "stop", generation: this.generation });
    this.listeners.clear();
  }

  // -- internals ----------------------------------------------------------

  private async bargeIn(): Promise<void> {
    // §11.3 order: TTS cancel first (drops current + queued sentences), then
    // abort/epoch-bump in main, then the fresh turn.
    this.stopSpeaking();
    // Transition first (stamp still matches the outgoing turn), THEN bump
    // the local generation so every awaited result from the outgoing turn
    // resolves as stale even if main answers before the interrupt RPC
    // round-trips.
    this.dispatch({ type: "userSpeechDetected", generation: this.generation });
    this.generation += 1;
    this.emit();
    if (this.sessionActive && this.voiceSessionId && this.seams.persistentSession) {
      await this.seams.persistentSession.speechStarted(this.voiceSessionId).catch(async () => {
        await this.seams.interruptTurn().catch(() => undefined);
      });
    } else {
      await this.seams.interruptTurn().catch(() => undefined);
    }
    if (this.state === "interrupted") {
      const next = this.generation;
      this.dispatch({ type: "interrupted", generation: next });
      this.emit();
      this.seams.capture.start();
      this.subscribePartial(next);
      if (this.sessionActive) this.subscribeEndpoint(next);
    }
  }

  private async transcribeAndTurn(result: VoiceAgentCaptureResult, generation: number): Promise<void> {
    let text: string;
    try {
      text = (await this.seams.transcribe(result.audio, result.mimeType, this.seams.getLanguage())).trim();
    } catch (error) {
      if (!this.isCurrent(generation)) return;
      this.errorMessage = error instanceof Error ? error.message : String(error);
      this.dispatch({ type: "micFailed", generation, error: this.errorMessage });
      this.emit();
      return;
    }
    if (!this.isCurrent(generation)) return;
    if (!text) {
      this.dispatch({ type: "stop", generation });
      this.emit();
      return;
    }
    this.lastUtterance = { text, status: "final", generation };
    this.recordTurn({ role: "user", text, generation, spoke: false });
    this.dispatch({ type: "transcribed", generation, text });
    this.emit();
    await this.resolveTurn(text, generation);
  }

  private async resolveTurn(utterance: string, generation: number): Promise<void> {
    let result: AgentApiVoiceTurnResult | null;
    // Persistent calls keep the microphone analyser alive during thinking so
    // "等等…" can abort an answer before TTS even begins.
    if (this.sessionActive) this.subscribeBargeIn(generation);
    try {
      result = this.sessionActive && this.voiceSessionId && this.seams.persistentSession
        ? await this.seams.persistentSession.turn(this.voiceSessionId, utterance)
        : await this.seams.turn(utterance);
    } catch (error) {
      if (!this.isCurrent(generation)) return;
      this.errorMessage = error instanceof Error ? error.message : String(error);
      this.dispatch({ type: "micFailed", generation, error: this.errorMessage });
      this.emit();
      return;
    }
    if (!this.isCurrent(generation)) return; // late output discarded (§11.3)
    if (result === null) {
      // Interrupted in main. Barge-in already re-entered listening; an
      // explicit interrupt went idle. Either way the old answer never plays.
      return;
    }
    this.dispatch({ type: "turnResolved", generation });
    this.lastReply = { text: result.text, source: result.source, spoke: false };
    this.emit();
    if (this.state !== "speaking") return;
    const abort = new AbortController();
    this.speechAbort = abort;
    this.subscribeBargeIn(generation);
    const outcome = await this.seams.speak(result.text, abort.signal);
    if (!this.isCurrent(generation)) return;
    this.unsubscribeBargeIn();
    this.speechAbort = null;
    this.lastReply = { text: result.text, source: result.source, spoke: outcome.spoken };
    this.recordTurn({
      role: "agentapi",
      text: result.text,
      generation,
      source: result.source,
      spoke: outcome.spoken && !outcome.cancelled,
    });
    this.dispatch({ type: "speechFinished", generation });
    this.emit();
    if (this.sessionActive && this.voiceSessionId && this.seams.persistentSession) {
      await this.seams.persistentSession.replyFinished(this.voiceSessionId).catch(() => undefined);
    }
    await this.restartPersistentListening();
  }

  private subscribePartial(generation: number): void {
    this.unsubscribePartial();
    this.partialUnsubscribe = this.seams.capture.onPartial?.((text, partialGeneration) => {
      if (!this.isCurrent(generation) || partialGeneration !== generation) return;
      this.partial = text;
      this.emit();
    }) ?? null;
  }

  private unsubscribePartial(): void {
    this.partialUnsubscribe?.();
    this.partialUnsubscribe = null;
  }

  private subscribeEndpoint(generation: number): void {
    this.unsubscribeEndpoint();
    this.endpointUnsubscribe = this.seams.capture.onUtteranceEnd?.(() => {
      if (!this.sessionActive || this.muted || !this.isCurrent(generation) || this.state !== "listening") return;
      void this.stopListening();
    }) ?? null;
  }

  private unsubscribeEndpoint(): void {
    this.endpointUnsubscribe?.();
    this.endpointUnsubscribe = null;
  }

  private subscribeBargeIn(generation: number): void {
    this.unsubscribeBargeIn();
    this.bargeUnsubscribe = this.seams.capture.onSpeechStart(() => {
      if (!this.isCurrent(generation)) return;
      if (this.state !== "speaking" && this.state !== "thinking") return;
      void this.bargeIn();
    });
  }

  private unsubscribeBargeIn(): void {
    this.bargeUnsubscribe?.();
    this.bargeUnsubscribe = null;
  }

  private stopSpeaking(): void {
    this.speechAbort?.abort();
    this.speechAbort = null;
    this.unsubscribeBargeIn();
  }

  private async restartPersistentListening(): Promise<void> {
    if (!this.sessionActive || this.muted || this.state !== "idle") return;
    await this.startListening();
  }

  /** Stamp check: the sole authority on whether an awaited step may proceed
   * (generations advance on every fresh turn, barge-in, lifecycle reset). */
  private isCurrent(generation: number): boolean {
    return generation === this.generation
      && this.state !== "idle"
      && this.state !== "error";
  }

  private dispatch(event: VoiceAgentEvent): void {
    this.state = reduceVoiceAgentState(this.state, event, this.generation);
  }

  private recordTurn(entry: Omit<VoiceAgentPaneTurn, "at">): void {
    this.recentTurns.push({ ...entry, at: this.now() });
    while (this.recentTurns.length > AGENTAPI_VOICE_PANE_MAX_TURNS) this.recentTurns.shift();
  }

  private emit(): void {
    const snapshot = this.getSnapshot();
    for (const listener of this.listeners) listener(snapshot);
  }
}
