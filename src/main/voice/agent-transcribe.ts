import type { AppSettings } from "@shared/types";
import {
  defaultVoiceSttProviders,
  type VoiceSttProviderId,
  type VoiceSttProviderRegistry,
} from "./live/voice-stt-provider";

export const MAX_VOICE_AGENT_BASE64_CHARS = 8_500_000;

const CANONICAL_BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

interface VoiceAgentClip {
  audioBase64?: unknown;
  mimeType?: unknown;
  lang?: unknown;
}

/**
 * Decode the JSON-only mobile audio envelope at the main-process boundary.
 * Only canonical base64 is accepted, so malformed data cannot silently turn
 * into an empty or truncated recording through Buffer.from's permissive
 * decoder.
 */
export function decodeVoiceAgentClip(input: unknown): {
  audio: ArrayBuffer;
  mimeType: string;
  lang: string | null;
} {
  if (!input || typeof input !== "object") {
    throw new Error("Voice-agent transcription expects an audio payload.");
  }
  const clip = input as VoiceAgentClip;
  const encoded = clip.audioBase64;
  if (
    typeof encoded !== "string"
    || encoded.length === 0
    || encoded.length > MAX_VOICE_AGENT_BASE64_CHARS
    || encoded.length % 4 !== 0
    || !CANONICAL_BASE64.test(encoded)
  ) {
    throw new Error("Voice-agent transcription expects bounded canonical base64 audio.");
  }
  const decoded = Buffer.from(encoded, "base64");
  if (decoded.toString("base64") !== encoded) {
    throw new Error("Voice-agent transcription received malformed base64 audio.");
  }
  return {
    audio: decoded.buffer.slice(decoded.byteOffset, decoded.byteOffset + decoded.byteLength),
    mimeType: typeof clip.mimeType === "string" ? clip.mimeType : "audio/webm",
    lang: typeof clip.lang === "string" && clip.lang.length <= 35 ? clip.lang : null,
  };
}

/** The STT URL/model/key are settings-owned; client input never participates. */
export function transcribeVoiceAgentClip(
  input: unknown,
  voice: AppSettings["voice"],
  providers: VoiceSttProviderRegistry = defaultVoiceSttProviders,
  preferredProvider: VoiceSttProviderId = "existing-cloud",
): Promise<{ text: string; detectedLanguage?: string | null }> {
  const clip = decodeVoiceAgentClip(input);
  return providers.transcribe({
    audio: clip.audio,
    mimeType: clip.mimeType,
    language: clip.lang ?? voice.sttLanguageMode,
    settings: voice,
  }, preferredProvider);
}
