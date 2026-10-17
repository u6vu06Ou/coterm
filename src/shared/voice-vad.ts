export interface VadEndpointOptions {
  /** Conservative initial value so normal Chinese pauses do not cut early. */
  silenceMs?: number;
  minSpeechMs?: number;
  maxUtteranceMs?: number;
}

export type VadEndpointEvent =
  | { type: "speech-started"; atMs: number }
  | { type: "utterance-ended"; atMs: number; durationMs: number; reason: "silence" | "max-duration" };

export const DEFAULT_VAD_ENDPOINT_OPTIONS = {
  silenceMs: 900,
  minSpeechMs: 180,
  maxUtteranceMs: 45_000,
} as const;

/**
 * Audio-free endpointing state machine shared by the browser capture fallback
 * and the future LiveKit/Silero worker. It stores timestamps only, never PCM.
 */
export class VadEndpointController {
  private readonly silenceMs: number;
  private readonly minSpeechMs: number;
  private readonly maxUtteranceMs: number;
  private speechStartedAt: number | null = null;
  private lastSpeechAt: number | null = null;
  private speaking = false;

  constructor(options: VadEndpointOptions = {}) {
    this.silenceMs = clampMs(options.silenceMs ?? DEFAULT_VAD_ENDPOINT_OPTIONS.silenceMs, 300, 5_000);
    this.minSpeechMs = clampMs(options.minSpeechMs ?? DEFAULT_VAD_ENDPOINT_OPTIONS.minSpeechMs, 0, 2_000);
    this.maxUtteranceMs = clampMs(options.maxUtteranceMs ?? DEFAULT_VAD_ENDPOINT_OPTIONS.maxUtteranceMs, 5_000, 120_000);
  }

  observe(input: { speech: boolean; atMs: number }): VadEndpointEvent[] {
    const atMs = Math.max(0, Math.trunc(input.atMs));
    const events: VadEndpointEvent[] = [];

    if (input.speech) {
      this.lastSpeechAt = atMs;
      if (!this.speaking) {
        this.speaking = true;
        this.speechStartedAt = atMs;
        events.push({ type: "speech-started", atMs });
      }
    }

    if (this.speaking && this.speechStartedAt !== null) {
      const durationMs = atMs - this.speechStartedAt;
      if (durationMs >= this.maxUtteranceMs) {
        events.push(this.finish(atMs, "max-duration"));
        return events;
      }

      if (!input.speech && this.lastSpeechAt !== null) {
        const silenceDuration = atMs - this.lastSpeechAt;
        if (durationMs >= this.minSpeechMs && silenceDuration >= this.silenceMs) {
          events.push(this.finish(atMs, "silence"));
        }
      }
    }

    return events;
  }

  reset(): void {
    this.speechStartedAt = null;
    this.lastSpeechAt = null;
    this.speaking = false;
  }

  private finish(atMs: number, reason: "silence" | "max-duration"): Extract<VadEndpointEvent, { type: "utterance-ended" }> {
    const startedAt = this.speechStartedAt ?? atMs;
    const event = {
      type: "utterance-ended" as const,
      atMs,
      durationMs: Math.max(0, atMs - startedAt),
      reason,
    };
    this.reset();
    return event;
  }
}

function clampMs(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.max(min, Math.min(max, Math.trunc(value)));
}
