import type {
  VoiceResponseLanguage,
  VoiceSessionCommand,
  VoiceSessionCommandResult,
  VoiceSessionRecord,
  VoiceSttLanguageMode,
  VoicePipelineSnapshot,
} from "@shared/types";
import type { PersistentVoiceSessionController } from "./persistent-voice-session-controller";

const MAX_ID_CHARS = 160;
const MAX_UTTERANCE_CHARS = 12_000;
const MAX_TRANSPORT_CHARS = 80;

/** Optional LiveKit duplex gateway. When wired, `start` attempts to promote
 * the session to realtime transport and returns join material; a failure
 * resolves null and the session stays on the chunked fallback. */
export interface PersistentVoiceLiveGateway {
  attach(session: VoiceSessionRecord): Promise<{ url: string; token: string } | null>;
  fallbackReason?(): string | null;
  diagnostics?(voiceSessionId: string): VoicePipelineSnapshot | null;
}

/**
 * Validates the IPC/HTTP control envelope before it reaches the durable voice
 * controller. Audio cannot cross this protocol; only metadata/final text can.
 */
export class PersistentVoiceSurface {
  constructor(
    private readonly controller: PersistentVoiceSessionController,
    private readonly live: PersistentVoiceLiveGateway | null = null,
  ) {}

  async handle(raw: unknown): Promise<VoiceSessionCommandResult> {
    const command = parseVoiceSessionCommand(raw);
    switch (command.action) {
      case "start": {
        const started = this.controller.start({
          ...(command.transport ? { transport: command.transport } : {}),
          ...(command.sttLanguageMode ? { sttLanguageMode: command.sttLanguageMode } : {}),
          ...(command.responseLanguage ? { responseLanguage: command.responseLanguage } : {}),
        });
        if (!this.live) return { session: started };
        const live = await this.live.attach(started);
        // attach() may rewrite the transport (livekit/chunked); return the
        // freshest record so the renderer badge matches the DB.
        return {
          session: this.controller.get(started.id),
          live,
          ...(!live ? { liveFallbackReason: this.live.fallbackReason?.() ?? null } : {}),
          diagnostics: this.live.diagnostics?.(started.id) ?? null,
        };
      }
      case "get":
        return {
          session: this.controller.get(command.voiceSessionId),
          diagnostics: this.live?.diagnostics?.(command.voiceSessionId) ?? null,
        };
      case "resume":
        return { session: this.controller.resume(command.voiceSessionId, command.transport) };
      case "speech-started":
        return { session: this.controller.userSpeechStarted(command.voiceSessionId) };
      case "utterance": {
        const turn = await this.controller.submitUtterance(command.voiceSessionId, command.text);
        return { session: this.controller.get(command.voiceSessionId), turn };
      }
      case "reply-finished":
        return { session: this.controller.replyFinished(command.voiceSessionId) };
      case "mute":
        return { session: this.controller.mute(command.voiceSessionId) };
      case "unmute":
        return { session: this.controller.unmute(command.voiceSessionId) };
      case "reconnecting":
        return { session: this.controller.markReconnecting(command.voiceSessionId) };
      case "reconnected": {
        if (command.transport) this.controller.resume(command.voiceSessionId, command.transport);
        return { session: this.controller.markReconnected(command.voiceSessionId) };
      }
      case "end":
        return { session: this.controller.end(command.voiceSessionId) };
    }
  }
}

export function parseVoiceSessionCommand(raw: unknown): VoiceSessionCommand {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("Invalid Live Voice command.");
  const input = raw as Record<string, unknown>;
  rejectAudioFields(input);
  const action = input.action;
  if (action === "start") {
    const sttLanguageMode = parseSttLanguage(input.sttLanguageMode);
    const responseLanguage = parseResponseLanguage(input.responseLanguage);
    const transport = parseTransport(input.transport);
    return {
      action,
      ...(sttLanguageMode ? { sttLanguageMode } : {}),
      ...(responseLanguage ? { responseLanguage } : {}),
      ...(transport ? { transport } : {}),
    };
  }
  if (!isSessionAction(action)) throw new Error("Unknown Live Voice command.");
  const voiceSessionId = boundedString(input.voiceSessionId, MAX_ID_CHARS, "Live Voice session id");
  if (action === "utterance") {
    return { action, voiceSessionId, text: boundedString(input.text, MAX_UTTERANCE_CHARS, "Live Voice utterance") };
  }
  if (action === "resume" || action === "reconnected") {
    const transport = parseTransport(input.transport);
    return { action, voiceSessionId, ...(transport ? { transport } : {}) };
  }
  return { action, voiceSessionId };
}

function isSessionAction(value: unknown): value is Exclude<VoiceSessionCommand["action"], "start"> {
  return value === "get"
    || value === "resume"
    || value === "speech-started"
    || value === "utterance"
    || value === "reply-finished"
    || value === "mute"
    || value === "unmute"
    || value === "reconnecting"
    || value === "reconnected"
    || value === "end";
}

function boundedString(value: unknown, max: number, label: string): string {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text || text.length > max) throw new Error(`${label} is invalid.`);
  return text;
}

function parseTransport(value: unknown): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  return boundedString(value, MAX_TRANSPORT_CHARS, "Live Voice transport");
}

function parseSttLanguage(value: unknown): VoiceSttLanguageMode | undefined {
  return value === "auto" || value === "zh-TW" || value === "zh-CN" || value === "en-US" ? value : undefined;
}

function parseResponseLanguage(value: unknown): VoiceResponseLanguage | undefined {
  return value === "zh-TW" || value === "zh-CN" || value === "en-US" ? value : undefined;
}

function rejectAudioFields(input: Record<string, unknown>): void {
  for (const key of Object.keys(input)) {
    if (/audio|pcm|webm|opus|buffer|bytes|base64/i.test(key)) {
      throw new Error("Raw audio is forbidden on the Live Voice control surface.");
    }
  }
}
