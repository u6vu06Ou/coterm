import type {
  AgentApiVoiceTurnResult,
  VoiceResponseLanguage,
  VoiceSessionRecord,
  VoiceSttLanguageMode,
} from "@shared/types";
import type { AgentApiVoiceOrchestrator } from "../../core/agentapi-voice-orchestrator";
import type { VoiceSessionRepository } from "./voice-session-repository";

export interface PersistentVoiceSessionControllerDeps {
  repository: VoiceSessionRepository;
  agentapi: Pick<AgentApiVoiceOrchestrator, "turn" | "interrupt">;
  now?: () => string;
}

export interface StartPersistentVoiceSessionInput {
  transport?: string;
  sttLanguageMode?: VoiceSttLanguageMode;
  responseLanguage?: VoiceResponseLanguage;
}

/**
 * Main-process authority for a logical VoiceSession. Realtime transport is an
 * adapter dependency added after the LiveKit dependency gate; this state
 * machine therefore remains testable without WebRTC or microphone access.
 */
export class PersistentVoiceSessionController {
  private readonly now: () => string;

  constructor(private readonly deps: PersistentVoiceSessionControllerDeps) {
    this.now = deps.now ?? (() => new Date().toISOString());
  }

  start(input: StartPersistentVoiceSessionInput = {}): VoiceSessionRecord {
    const session = this.deps.repository.create({
      // Default is "starting": the duplex gateway (persistent-voice-surface
      // `live` dep) rewrites it to "livekit" or "chunked" once the runtime
      // answer is known. Legacy rows may still carry "pending-livekit"; the
      // transport column is a plain string precisely so old values stay
      // readable without a schema migration.
      transport: input.transport ?? "starting",
      sttLanguageMode: input.sttLanguageMode ?? "auto",
      responseLanguage: input.responseLanguage ?? "zh-TW",
      now: this.now(),
    });
    return this.deps.repository.setStatus(session.id, "listening", this.now());
  }

  get(voiceSessionId: string): VoiceSessionRecord {
    return this.deps.repository.require(voiceSessionId);
  }

  resume(voiceSessionId: string, transport?: string): VoiceSessionRecord {
    const current = this.requireActive(voiceSessionId);
    if (transport && transport !== current.transport) {
      this.deps.repository.updateContext({ id: voiceSessionId, transport, now: this.now() });
    }
    return this.deps.repository.setStatus(voiceSessionId, current.status === "muted" ? "muted" : "listening", this.now());
  }

  mute(voiceSessionId: string): VoiceSessionRecord {
    this.requireActive(voiceSessionId);
    return this.deps.repository.setStatus(voiceSessionId, "muted", this.now());
  }

  unmute(voiceSessionId: string): VoiceSessionRecord {
    this.requireActive(voiceSessionId);
    return this.deps.repository.setStatus(voiceSessionId, "listening", this.now());
  }

  markReconnecting(voiceSessionId: string): VoiceSessionRecord {
    this.requireActive(voiceSessionId);
    return this.deps.repository.setStatus(voiceSessionId, "reconnecting", this.now());
  }

  markReconnected(voiceSessionId: string): VoiceSessionRecord {
    this.requireActive(voiceSessionId);
    return this.deps.repository.setStatus(voiceSessionId, "listening", this.now());
  }

  userSpeechStarted(voiceSessionId: string): VoiceSessionRecord {
    const current = this.requireActive(voiceSessionId);
    if (current.status === "muted") return current;
    this.deps.agentapi.interrupt();
    return this.deps.repository.setStatus(voiceSessionId, "user-speaking", this.now());
  }

  async submitUtterance(voiceSessionId: string, utterance: string): Promise<AgentApiVoiceTurnResult | null> {
    const current = this.requireActive(voiceSessionId);
    if (current.status === "muted") throw new Error("Voice session is muted.");
    const text = utterance.trim();
    if (!text) throw new Error("Voice utterance must not be empty.");
    this.deps.repository.appendTurn({
      voiceSessionId,
      role: "user",
      text,
      source: "supervisor",
      createdAt: this.now(),
    });
    this.deps.repository.setStatus(voiceSessionId, "thinking", this.now());
    const result = await this.deps.agentapi.turn(text);
    if (!result) {
      const latest = this.deps.repository.require(voiceSessionId);
      if (latest.status !== "user-speaking" && latest.status !== "ended" && latest.status !== "muted") {
        this.deps.repository.setStatus(voiceSessionId, "listening", this.now());
      }
      return null;
    }
    this.deps.repository.appendTurn({
      voiceSessionId,
      role: "agentapi",
      text: result.text,
      source: result.source,
      terminalId: result.targetTerminalId,
      createdAt: this.now(),
    });
    this.deps.repository.setStatus(voiceSessionId, "speaking", this.now());
    return result;
  }

  /**
   * Gemini Live provider: the speech-to-speech model already answered, so the
   * transcript rows land directly — no supervisor turn runs in between.
   */
  recordUserUtterance(voiceSessionId: string, utterance: string): VoiceSessionRecord {
    const current = this.requireActive(voiceSessionId);
    const text = utterance.trim();
    if (!text) throw new Error("Voice utterance must not be empty.");
    this.deps.repository.appendTurn({
      voiceSessionId,
      role: "user",
      text,
      source: "supervisor",
      createdAt: this.now(),
    });
    if (current.status === "listening" || current.status === "user-speaking") {
      return this.deps.repository.setStatus(voiceSessionId, "thinking", this.now());
    }
    return current;
  }

  /** Gemini Live provider reply (already spoken by the model). */
  recordModelReply(voiceSessionId: string, text: string): VoiceSessionRecord {
    this.requireActive(voiceSessionId);
    const trimmed = text.trim();
    if (!trimmed) throw new Error("Model reply must not be empty.");
    this.deps.repository.appendTurn({
      voiceSessionId,
      role: "agentapi",
      text: trimmed,
      source: "supervisor",
      createdAt: this.now(),
    });
    return this.deps.repository.setStatus(voiceSessionId, "speaking", this.now());
  }

  replyFinished(voiceSessionId: string): VoiceSessionRecord {
    const current = this.requireActive(voiceSessionId);
    if (current.status !== "speaking") return current;
    return this.deps.repository.setStatus(voiceSessionId, "listening", this.now());
  }

  end(voiceSessionId: string): VoiceSessionRecord {
    const current = this.deps.repository.require(voiceSessionId);
    if (current.status === "ended") return current;
    this.deps.agentapi.interrupt();
    return this.deps.repository.setStatus(voiceSessionId, "ended", this.now());
  }

  private requireActive(voiceSessionId: string): VoiceSessionRecord {
    const session = this.deps.repository.require(voiceSessionId);
    if (session.status === "ended") throw new Error("Voice session has ended.");
    return session;
  }
}
