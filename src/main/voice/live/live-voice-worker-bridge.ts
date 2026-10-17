import { EventEmitter } from "node:events";

export type LiveVoiceWorkerEvent =
  | { type: "user-speech-started"; voiceSessionId: string; atMs: number }
  | { type: "final-utterance"; voiceSessionId: string; text: string; detectedLanguage?: string | null; atMs: number }
  | { type: "model-utterance"; voiceSessionId: string; text: string; atMs: number }
  | { type: "transport"; voiceSessionId: string; state: "connected" | "reconnecting" | "disconnected"; atMs: number }
  | {
      type: "stage";
      voiceSessionId: string;
      stage: "worker-subscribe" | "worker-mic" | "vad" | "stt" | "tts";
      state: string;
      atMs: number;
      frameCount?: number;
      framesPerSecond?: number;
      rms?: number;
      durationMs?: number;
      textLength?: number;
      reasonCode?: string;
    }
  | { type: "health"; state: "ready" | "degraded"; atMs: number; reasonCode?: string };

type LiveVoiceWorkerListener = (event: LiveVoiceWorkerEvent) => void;

/**
 * Typed local bridge boundary. Only speech-control metadata and final text may
 * cross it. Raw microphone bytes are deliberately not part of the protocol.
 */
export class LiveVoiceWorkerBridge {
  private readonly events = new EventEmitter();

  onEvent(listener: LiveVoiceWorkerListener): () => void {
    this.events.on("event", listener);
    return () => this.events.off("event", listener);
  }

  accept(raw: unknown): LiveVoiceWorkerEvent {
    const event = parseWorkerEvent(raw);
    this.events.emit("event", event);
    return event;
  }
}

export function parseWorkerEvent(raw: unknown): LiveVoiceWorkerEvent {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("Invalid live voice worker event.");
  const input = raw as Record<string, unknown>;
  rejectAudioPayload(input);
  const type = input.type;
  const atMs = boundedTimestamp(input.atMs);
  if (type === "health") {
    const state = input.state;
    if (state !== "ready" && state !== "degraded") throw new Error("Invalid live voice worker health state.");
    const reasonCode = typeof input.reasonCode === "string" && /^[a-z0-9._-]{1,64}$/i.test(input.reasonCode)
      ? input.reasonCode
      : undefined;
    return { type, state, atMs, ...(reasonCode ? { reasonCode } : {}) };
  }

  const voiceSessionId = boundedId(input.voiceSessionId);
  if (type === "user-speech-started") return { type, voiceSessionId, atMs };
  if (type === "stage") {
    const stage = input.stage;
    if (stage !== "worker-subscribe" && stage !== "worker-mic" && stage !== "vad" && stage !== "stt" && stage !== "tts") {
      throw new Error("Invalid live voice pipeline stage.");
    }
    const state = boundedToken(input.state, 48, "Live voice stage state");
    const result: Extract<LiveVoiceWorkerEvent, { type: "stage" }> = { type, voiceSessionId, stage, state, atMs };
    const frameCount = boundedMetric(input.frameCount);
    const framesPerSecond = boundedMetric(input.framesPerSecond);
    const rms = boundedMetric(input.rms);
    const durationMs = boundedMetric(input.durationMs);
    const textLength = boundedMetric(input.textLength);
    const reasonCode = typeof input.reasonCode === "string" && /^[a-z0-9._-]{1,64}$/i.test(input.reasonCode)
      ? input.reasonCode
      : undefined;
    if (frameCount !== undefined) result.frameCount = frameCount;
    if (framesPerSecond !== undefined) result.framesPerSecond = framesPerSecond;
    if (rms !== undefined) result.rms = rms;
    if (durationMs !== undefined) result.durationMs = durationMs;
    if (textLength !== undefined) result.textLength = textLength;
    if (reasonCode) result.reasonCode = reasonCode;
    return result;
  }
  if (type === "transport") {
    const state = input.state;
    if (state !== "connected" && state !== "reconnecting" && state !== "disconnected") {
      throw new Error("Invalid live voice transport state.");
    }
    return { type, voiceSessionId, state, atMs };
  }
  if (type === "final-utterance") {
    const text = typeof input.text === "string" ? input.text.trim().slice(0, 12_000) : "";
    if (!text) throw new Error("Final utterance text is required.");
    const detectedLanguage = typeof input.detectedLanguage === "string" && input.detectedLanguage.trim()
      ? input.detectedLanguage.trim().slice(0, 35)
      : undefined;
    return { type, voiceSessionId, text, atMs, ...(detectedLanguage ? { detectedLanguage } : {}) };
  }
  if (type === "model-utterance") {
    const text = typeof input.text === "string" ? input.text.trim().slice(0, 12_000) : "";
    if (!text) throw new Error("Model utterance text is required.");
    return { type, voiceSessionId, text, atMs };
  }
  throw new Error("Unknown live voice worker event.");
}

function rejectAudioPayload(input: Record<string, unknown>): void {
  for (const key of Object.keys(input)) {
    if (/audio|pcm|webm|opus|buffer|bytes|base64/i.test(key)) {
      throw new Error("Raw audio is forbidden on the live voice worker control bridge.");
    }
  }
}

function boundedTimestamp(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) throw new Error("Invalid live voice event timestamp.");
  return Math.trunc(value);
}

function boundedId(value: unknown): string {
  const id = typeof value === "string" ? value.trim() : "";
  if (!id || id.length > 160) throw new Error("Invalid live voice session id.");
  return id;
}

function boundedToken(value: unknown, max: number, label: string): string {
  const token = typeof value === "string" ? value.trim() : "";
  if (!token || token.length > max || !/^[a-z0-9._-]+$/i.test(token)) throw new Error(`${label} is invalid.`);
  return token;
}

function boundedMetric(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) throw new Error("Invalid live voice stage metric.");
  return Math.round(value * 100) / 100;
}
