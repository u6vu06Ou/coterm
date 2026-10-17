import { randomBytes } from "node:crypto";
import { join } from "node:path";
import type { AppSettings } from "@shared/schema";
import type {
  VoicePipelineSnapshot,
  VoicePipelineStageKey,
  VoicePipelineStageRecord,
  VoiceSessionRecord,
} from "@shared/types";
import { ensureLivekitServerExecutable, type EnsureServerArtifactResult } from "./server-artifact";
import { LivekitServerProcess } from "./livekit-server-process";
import { LivekitWorkerProcess } from "./livekit-worker-process";
import { LIVEKIT_WORKER_ENV } from "./livekit-worker-env";
import { LiveVoiceRuntimeManager, type LiveVoiceRuntimeState } from "./live-voice-runtime-manager";
import type { LiveVoiceWorkerEvent } from "./live-voice-worker-bridge";
import type { PersistentVoiceSessionController } from "./persistent-voice-session-controller";
import {
  issueLiveVoiceToken,
  liveVoiceRoomName,
  userIdentityForSession,
} from "./livekit-token";
import { PREFLIGHT_STT_TIMEOUT_MS, preflightSttReachable } from "@shared/stt-preflight";

export interface LiveVoiceJoinInfo {
  url: string;
  token: string;
}

export interface LiveVoiceDuplexLogger {
  info(event: string, message: string, fields?: Record<string, unknown>): void;
  warn(event: string, message: string, fields?: Record<string, unknown>): void;
}

export interface LiveVoiceDuplexServiceDeps {
  userDataPath: string;
  workerEntryPath: string;
  getSettings: () => AppSettings;
  setSettings: (settings: AppSettings) => Promise<AppSettings>;
  controller: PersistentVoiceSessionController;
  logger?: LiveVoiceDuplexLogger;
  ensureArtifact?: (targetDir: string) => Promise<EnsureServerArtifactResult>;
  issueToken?: typeof issueLiveVoiceToken;
  serverFactory?: (options: { executablePath: string; apiKey: string; apiSecret: string }) => LivekitServerProcess;
  workerFactory?: (options: { env: Record<string, string>; onEvent: (event: LiveVoiceWorkerEvent) => void }) => LivekitWorkerProcess;
  randomTokenMaterial?: () => string;
  /**
   * Optional STT endpoint reachability check (work order §4). Injected in tests;
   * defaults to a bounded HEAD probe. Receives only the endpoint URL — nothing
   * secret is ever passed in or logged here.
   */
  preflightStt?: (url: string) => Promise<boolean>;
}

const MIN_CREDENTIAL_CHARS = 32;

/**
 * Owns the LiveKit runtime (server binary + voice worker fork) behind the
 * PersistentVoiceSurface. A start that cannot reach "ready" degrades in
 * place: the session is rewritten to the chunked fallback and the caller gets
 * null join info (work order §1.5 open-box rule). Secrets are generated
 * locally, persisted via settings, and never logged.
 */
export class LiveVoiceDuplexService {
  private manager: LiveVoiceRuntimeManager | null = null;
  private worker: LivekitWorkerProcess | null = null;
  private activeSessionId: string | null = null;
  private activeProvider: "cascade" | "gemini" = "cascade";
  private attachQueue: Promise<unknown> = Promise.resolve();
  private lastFallbackReason: string | null = null;
  private readonly stageSnapshots = new Map<string, VoicePipelineSnapshot>();

  constructor(private readonly deps: LiveVoiceDuplexServiceDeps) {}

  /**
   * Attempts to attach LiveKit duplex transport to a freshly started voice
   * session. Serialized so two concurrent starts cannot fork two runtimes.
   */
  attach(session: VoiceSessionRecord): Promise<LiveVoiceJoinInfo | null> {
    const run = this.attachQueue.then(() => this.attachInner(session));
    this.attachQueue = run.catch(() => undefined);
    return run;
  }

  private async attachInner(session: VoiceSessionRecord): Promise<LiveVoiceJoinInfo | null> {
    this.lastFallbackReason = null;
    this.stageSnapshots.clear();
    this.updateStage(session.id, "transport", { state: "starting", atMs: Date.now() });
    let settings: AppSettings = this.deps.getSettings();
    const live = settings.voice.live;
    if (!live.enabled) return this.degrade(session, "LiveKit duplex is disabled in settings.");
    const provider = live.provider === "gemini" ? "gemini" : "cascade";
    this.activeProvider = provider;
    if (provider === "gemini") {
      // The Gemini provider talks speech-to-speech to Google; the local STT
      // endpoint is only needed by the cascade brain and chunked dictation.
      if (!live.geminiApiKey) {
        return this.degrade(session, "Gemini Live Voice API key is not configured; staying on chunked dictation.");
      }
    } else {
      // voice.sttUrl empty breaks chunked dictation too (work order §2); treat
      // it as the same chunked outcome instead of starting a runtime that has
      // no STT endpoint configured.
      if (!settings.voice.sttUrl) return this.degrade(session, "Speech-to-text URL is not configured; staying on chunked dictation.");

      // Probe the STT endpoint before starting a runtime: a dead endpoint would
      // strand the session on a chunked path that cannot transcribe either, since
      // Live Voice and chunked dictation share this URL (work order §4). Reporting
      // it up front yields an actionable error instead of a silent dead fallback.
      const sttReachable = await this.resolveSttReachable(settings.voice.sttUrl);
      if (!sttReachable) {
        return this.degrade(
          session,
          "Speech-to-text endpoint is unreachable; verify the STT URL under Voice settings. Live Voice and chunked dictation both use it.",
        );
      }
    }

    settings = await this.ensureCredentials(settings);

    const artifactDir = join(this.deps.userDataPath, "live-voice");
    const artifact = await (this.deps.ensureArtifact ?? ensureLivekitServerExecutable)(artifactDir);
    if (!artifact.ok) return this.degrade(session, artifact.reason);

    await this.stopRuntime();

    const events = (event: LiveVoiceWorkerEvent): void => this.handleWorkerEvent(event);
    const workerEnv = this.buildWorkerEnv(settings, session.id);
    const worker = (this.deps.workerFactory ?? ((options) => new LivekitWorkerProcess({
      workerEntryPath: this.deps.workerEntryPath,
      env: options.env,
      onEvent: options.onEvent,
    })))({ env: workerEnv, onEvent: events });
    const server = (this.deps.serverFactory ?? ((options) => new LivekitServerProcess(options)))({
      executablePath: artifact.path,
      apiKey: settings.voice.live.apiKey,
      apiSecret: settings.voice.live.apiSecret,
    });

    const manager = new LiveVoiceRuntimeManager({
      server,
      worker,
      onStateChanged: (state, reason) => this.onRuntimeState(state, reason),
    });
    this.manager = manager;
    this.worker = worker;
    this.activeSessionId = session.id;

    const state = await manager.start();
    if (state !== "ready") {
      await this.stopRuntime();
      return this.degrade(session, "Live Voice runtime failed to become ready; falling back to chunked dictation.");
    }

    const token = await this.issueToken(settings, session);
    if (token === null) return null;
    this.setTransport(session.id, "livekit");
    this.updateStage(session.id, "transport", { state: "connected", atMs: Date.now() });
    this.deps.logger?.info("liveVoice.duplex.ready", "Live Voice duplex runtime is ready.", {
      voiceSessionId: session.id,
    });
    return { url: settings.voice.live.serverUrl, token };
  }

  private buildWorkerEnv(settings: AppSettings, voiceSessionId: string): Record<string, string> {
    const live = settings.voice.live;
    return {
      [LIVEKIT_WORKER_ENV.url]: live.serverUrl,
      [LIVEKIT_WORKER_ENV.apiKey]: live.apiKey,
      [LIVEKIT_WORKER_ENV.apiSecret]: live.apiSecret,
      [LIVEKIT_WORKER_ENV.room]: liveVoiceRoomName(voiceSessionId),
      [LIVEKIT_WORKER_ENV.voiceSessionId]: voiceSessionId,
      [LIVEKIT_WORKER_ENV.sttUrl]: settings.voice.sttUrl,
      [LIVEKIT_WORKER_ENV.sttModel]: settings.voice.sttModel,
      [LIVEKIT_WORKER_ENV.sttApiKey]: settings.voice.sttApiKey,
      [LIVEKIT_WORKER_ENV.ttsVoice]: live.ttsVoice,
      [LIVEKIT_WORKER_ENV.provider]: live.provider === "gemini" ? "gemini" : "cascade",
      [LIVEKIT_WORKER_ENV.geminiApiKey]: live.geminiApiKey,
      [LIVEKIT_WORKER_ENV.geminiModel]: live.geminiModel,
      [LIVEKIT_WORKER_ENV.geminiLanguage]: settings.voice.responseLanguage,
    };
  }

  private async ensureCredentials(settings: AppSettings): Promise<AppSettings> {
    const live = settings.voice.live;
    if (live.apiKey.length >= MIN_CREDENTIAL_CHARS && live.apiSecret.length >= MIN_CREDENTIAL_CHARS) {
      return settings;
    }
    const random = this.deps.randomTokenMaterial ?? (() => randomBytes(24).toString("base64url"));
    const apiKey = random();
    const apiSecret = random();
    const next = await this.deps.setSettings({
      ...settings,
      voice: {
        ...settings.voice,
        live: { ...live, apiKey, apiSecret },
      },
    });
    // Log the event only; the generated material never enters any log field.
    this.deps.logger?.info("liveVoice.duplex.credentials", "Generated Live Voice API credentials.", {});
    return next;
  }

  private async resolveSttReachable(url: string): Promise<boolean> {
    const probe = this.deps.preflightStt;
    return probe ? probe(url) : preflightSttReachable(url, PREFLIGHT_STT_TIMEOUT_MS);
  }

  // Token issuance is wrapped locally: a missing lazily-loaded
  // livekit-server-sdk (the package is no longer shipped with the app) or bad
  // credentials must degrade the session, never throw uncaught out of
  // attachInner. Delegates to the injected hook when a test provides one.
  private async issueToken(settings: AppSettings, session: VoiceSessionRecord): Promise<string | null> {
    try {
      return await (this.deps.issueToken ?? issueLiveVoiceToken)({
        voiceSessionId: session.id,
        apiKey: settings.voice.live.apiKey,
        apiSecret: settings.voice.live.apiSecret,
        identity: userIdentityForSession(session.id),
      });
    } catch (error) {
      this.deps.logger?.warn("liveVoice.duplex.tokenFailed", "Live Voice token issuance failed; degrading.", {
        voiceSessionId: session.id,
        error: error instanceof Error ? error.message : String(error),
      });
      return this.degrade(session, "Live Voice join token could not be issued; falling back to chunked dictation.");
    }
  }

  private degrade(session: VoiceSessionRecord, reason: string): null {
    this.lastFallbackReason = safeFallbackReason(reason);
    this.updateStage(session.id, "transport", {
      state: "chunked",
      atMs: Date.now(),
      reasonCode: fallbackReasonCode(reason),
    });
    this.setTransport(session.id, "chunked");
    this.deps.logger?.warn("liveVoice.duplex.degraded", "Live Voice duplex unavailable; chunked dictation fallback active.", {
      voiceSessionId: session.id,
      reason: this.lastFallbackReason,
    });
    return null;
  }

  fallbackReason(): string | null {
    return this.lastFallbackReason;
  }

  diagnostics(voiceSessionId: string): VoicePipelineSnapshot | null {
    const snapshot = this.stageSnapshots.get(voiceSessionId);
    if (!snapshot) return null;
    return {
      voiceSessionId: snapshot.voiceSessionId,
      updatedAtMs: snapshot.updatedAtMs,
      stages: Object.fromEntries(
        Object.entries(snapshot.stages).map(([key, value]) => [key, value ? { ...value } : value]),
      ),
    };
  }

  private setTransport(voiceSessionId: string, transport: "livekit" | "chunked"): void {
    try {
      this.deps.controller.resume(voiceSessionId, transport);
    } catch {
      // Session may have already ended while the runtime was starting.
    }
  }

  private handleWorkerEvent(event: LiveVoiceWorkerEvent): void {
    switch (event.type) {
      case "user-speech-started":
        try {
          this.deps.controller.userSpeechStarted(event.voiceSessionId);
        } catch {
          // Session ended mid-barge-in; nothing to interrupt.
        }
        this.worker?.send({ type: "stop-speaking" });
        break;
      case "final-utterance":
        if (this.activeProvider === "gemini") {
          this.handleGeminiUserUtterance(event.voiceSessionId, event.text);
        } else {
          void this.handleFinalUtterance(event.voiceSessionId, event.text);
        }
        break;
      case "model-utterance":
        this.handleGeminiModelReply(event.voiceSessionId, event.text);
        break;
      case "transport":
        this.handleTransportEvent(event);
        break;
      case "health":
        if (event.state === "degraded") {
          this.deps.logger?.warn("liveVoice.duplex.workerDegraded", "Live Voice worker reported degraded health.", {
            ...(event.reasonCode ? { reasonCode: event.reasonCode } : {}),
          });
        }
        break;
      case "stage":
        // Safe structured diagnostics only: stage/state plus bounded numeric
        // metadata. The bridge schema makes transcript/audio payloads
        // impossible here.
        this.deps.logger?.info("liveVoice.stage", "Live Voice pipeline stage changed.", {
          voiceSessionId: event.voiceSessionId,
          stage: event.stage,
          state: event.state,
          ...(event.frameCount !== undefined ? { frameCount: event.frameCount } : {}),
          ...(event.framesPerSecond !== undefined ? { framesPerSecond: event.framesPerSecond } : {}),
          ...(event.rms !== undefined ? { rms: event.rms } : {}),
          ...(event.durationMs !== undefined ? { durationMs: event.durationMs } : {}),
          ...(event.textLength !== undefined ? { textLength: event.textLength } : {}),
          ...(event.reasonCode ? { reasonCode: event.reasonCode } : {}),
        });
        this.updateStage(event.voiceSessionId, event.stage, {
          state: event.state,
          atMs: event.atMs,
          ...(event.frameCount !== undefined ? { frameCount: event.frameCount } : {}),
          ...(event.framesPerSecond !== undefined ? { framesPerSecond: event.framesPerSecond } : {}),
          ...(event.rms !== undefined ? { rms: event.rms } : {}),
          ...(event.durationMs !== undefined ? { durationMs: event.durationMs } : {}),
          ...(event.textLength !== undefined ? { textLength: event.textLength } : {}),
          ...(event.reasonCode ? { reasonCode: event.reasonCode } : {}),
        });
        if (event.stage === "tts" && event.state === "ended") {
          try {
            this.deps.controller.replyFinished(event.voiceSessionId);
          } catch {
            // Session may have ended while the final audio frame drained.
          }
        }
        break;
    }
  }

  /**
   * Gemini provider: the user utterance arrived via the model's own
   * transcription, and the spoken reply is already coming back through the
   * worker — there is no supervisor turn to submit.
   */
  private handleGeminiUserUtterance(voiceSessionId: string, text: string): void {
    if (this.activeSessionId !== voiceSessionId) return;
    const startedAt = Date.now();
    this.updateStage(voiceSessionId, "turn", { state: "submitted", atMs: startedAt, textLength: text.length });
    try {
      this.deps.controller.recordUserUtterance(voiceSessionId, text);
    } catch (error) {
      this.deps.logger?.warn("liveVoice.duplex.geminiUserTurnFailed", "Gemini user turn recording failed.", {
        voiceSessionId,
        errorName: error instanceof Error ? error.name.slice(0, 80) : "UnknownError",
      });
    }
  }

  private handleGeminiModelReply(voiceSessionId: string, text: string): void {
    if (this.activeSessionId !== voiceSessionId) return;
    try {
      this.deps.controller.recordModelReply(voiceSessionId, text);
      this.updateStage(voiceSessionId, "turn", { state: "committed", atMs: Date.now(), textLength: text.length });
    } catch (error) {
      this.deps.logger?.warn("liveVoice.duplex.geminiReplyFailed", "Gemini reply recording failed.", {
        voiceSessionId,
        errorName: error instanceof Error ? error.name.slice(0, 80) : "UnknownError",
      });
    }
  }

  private async handleFinalUtterance(voiceSessionId: string, text: string): Promise<void> {
    if (this.activeSessionId !== voiceSessionId) return;
    const startedAt = Date.now();
    this.updateStage(voiceSessionId, "turn", { state: "submitted", atMs: startedAt, textLength: text.length });
    this.deps.logger?.info("liveVoice.turn.submitted", "Live Voice turn submitted.", {
      voiceSessionId,
      textLength: text.length,
    });
    try {
      const turn = await this.deps.controller.submitUtterance(voiceSessionId, text);
      this.updateStage(voiceSessionId, "turn", {
        state: "committed",
        atMs: Date.now(),
        durationMs: Date.now() - startedAt,
      });
      this.deps.logger?.info("liveVoice.turn.committed", "Live Voice turn committed.", {
        voiceSessionId,
        durationMs: Date.now() - startedAt,
        hasReply: Boolean(turn),
      });
      if (turn && this.activeSessionId === voiceSessionId) {
        this.worker?.send({ type: "speak", voiceSessionId, text: turn.text });
      }
    } catch (error) {
      this.updateStage(voiceSessionId, "turn", {
        state: "failed",
        atMs: Date.now(),
        durationMs: Date.now() - startedAt,
        reasonCode: "turn-failed",
      });
      this.deps.logger?.warn("liveVoice.duplex.turnFailed", "Live Voice turn failed.", {
        voiceSessionId,
        durationMs: Date.now() - startedAt,
        errorName: error instanceof Error ? error.name.slice(0, 80) : "UnknownError",
        reasonCode: "turn-failed",
      });
    }
  }

  private handleTransportEvent(event: Extract<LiveVoiceWorkerEvent, { type: "transport" }>): void {
    try {
      if (event.state === "reconnecting" || event.state === "disconnected") {
        this.updateStage(event.voiceSessionId, "transport", { state: event.state, atMs: event.atMs });
        this.deps.controller.markReconnecting(event.voiceSessionId);
      } else {
        this.updateStage(event.voiceSessionId, "transport", { state: "connected", atMs: event.atMs });
        this.deps.controller.resume(event.voiceSessionId, "livekit");
        this.deps.controller.markReconnected(event.voiceSessionId);
      }
    } catch {
      // Session may have ended while the transport flapped.
    }
  }

  private onRuntimeState(state: LiveVoiceRuntimeState, reason?: string): void {
    if (state === "degraded") {
      this.deps.logger?.warn("liveVoice.duplex.runtimeDegraded", "Live Voice runtime degraded.", {
        ...(reason ? { reason } : {}),
      });
    }
  }

  private updateStage(voiceSessionId: string, stage: VoicePipelineStageKey, record: VoicePipelineStageRecord): void {
    const current = this.stageSnapshots.get(voiceSessionId) ?? {
      voiceSessionId,
      updatedAtMs: record.atMs,
      stages: {},
    };
    current.updatedAtMs = Math.max(current.updatedAtMs, record.atMs);
    current.stages[stage] = { ...record };
    this.stageSnapshots.set(voiceSessionId, current);
  }

  async stop(): Promise<void> {
    this.activeSessionId = null;
    await this.stopRuntime();
  }

  private async stopRuntime(): Promise<void> {
    const manager = this.manager;
    this.manager = null;
    this.worker = null;
    if (manager) await manager.stop();
  }
}

function safeFallbackReason(reason: string): string {
  const compact = reason.replace(/\s+/gu, " ").trim();
  return compact.slice(0, 240) || "Live Voice realtime transport unavailable.";
}

function fallbackReasonCode(reason: string): string {
  const lower = reason.toLowerCase();
  if (lower.includes("gemini")) return "gemini-unconfigured";
  if (lower.includes("unreachable") || lower.includes("endpoint")) return "stt-unreachable";
  if (lower.includes("not configured") || lower.includes("is not configured")) return "stt-unconfigured";
  if (lower.includes("disabled")) return "live-disabled";
  if (lower.includes("artifact") || lower.includes("download") || lower.includes("network")) return "runtime-artifact-unavailable";
  if (lower.includes("ready")) return "runtime-not-ready";
  return "live-unavailable";
}
