/**
 * Preview-only coordinator for desktop dictation.
 *
 * It owns a bounded rolling PCM window and partial uploads only. Full-utterance
 * capture, silence gating, generation invalidation and exactly-once final
 * commit remain exclusively owned by WhisperEngine + VoiceController.
 */

import { PcmRingBuffer, computeRms, encodeWav, PREVIEW_SAMPLE_COUNT, PREVIEW_SAMPLE_RATE } from "./wav-encoder";
import { PreviewRateLimiter, RateLimitError, type TranscribeFn } from "./rate-limiter";

export type StreamingState =
  | "idle"
  | "listening"
  | "partial"
  | "finalizing"
  | "preview-paused"
  | "rate-limited"
  | "error";

export const PREVIEW_INTERVAL_MS = 5_000;
// 0.02 (was 0.01): ambient room noise (0.01–0.05 RMS) leaked through the old
// gate and whisper hallucinated subtitles ("Amara.org", "本集完") out of
// near-silence previews. See voice-input.ts SILENCE_RMS for the full rationale.
export const SILENCE_RMS = 0.02;

export interface StreamingCoordinatorOptions {
  transcribe: TranscribeFn;
  onPartial: (text: string, generation: number) => void;
  onStateChange: (state: StreamingState) => void;
  rateLimiter?: PreviewRateLimiter;
  previewIntervalMs?: number;
  silenceRms?: number;
  now?: () => number;
}

export class StreamingDictationCoordinator {
  private readonly ring = new PcmRingBuffer(PREVIEW_SAMPLE_COUNT);
  private readonly transcribe: TranscribeFn;
  private readonly onPartial: StreamingCoordinatorOptions["onPartial"];
  private readonly onStateChange: StreamingCoordinatorOptions["onStateChange"];
  private readonly rateLimiter: PreviewRateLimiter;
  private readonly previewIntervalMs: number;
  private readonly silenceRms: number;
  private readonly now: () => number;
  private generation = 0;
  private active = false;
  private previewPaused = false;
  private requestInFlight = false;
  private abortController: AbortController | null = null;
  private previewTimer: ReturnType<typeof setInterval> | null = null;
  private state: StreamingState = "idle";

  constructor(options: StreamingCoordinatorOptions) {
    this.transcribe = options.transcribe;
    this.onPartial = options.onPartial;
    this.onStateChange = options.onStateChange;
    this.rateLimiter = options.rateLimiter ?? new PreviewRateLimiter({ maxRetries: 0 });
    this.previewIntervalMs = options.previewIntervalMs ?? PREVIEW_INTERVAL_MS;
    this.silenceRms = options.silenceRms ?? SILENCE_RMS;
    this.now = options.now ?? Date.now;
  }

  start(generation: number): void {
    this.cancel();
    this.generation = generation;
    this.active = true;
    this.previewPaused = false;
    this.requestInFlight = false;
    this.ring.clear();
    this.rateLimiter.reset();
    this.abortController = new AbortController();
    this.setState("listening");
    this.previewTimer = setInterval(() => void this.firePreview(), this.previewIntervalMs);
  }

  feedPcm(samples: Float32Array): void {
    if (this.active) this.ring.append(samples);
  }

  stopForFinal(): void {
    if (!this.active) return;
    this.active = false;
    this.clearTimer();
    this.abortController?.abort();
    this.abortController = null;
    this.setState("finalizing");
  }

  completeFinal(success: boolean): void {
    this.active = false;
    this.clearTimer();
    this.ring.clear();
    this.setState(success ? "idle" : "error");
  }

  cancel(): void {
    this.active = false;
    this.clearTimer();
    this.abortController?.abort();
    this.abortController = null;
    this.ring.clear();
    this.requestInFlight = false;
    this.setState("idle");
  }

  getState(): StreamingState {
    return this.state;
  }

  isPreviewPaused(): boolean {
    return this.previewPaused;
  }

  /** Deterministic test seam; production uses the 5-second timer. */
  async requestPreviewNow(): Promise<void> {
    await this.firePreview();
  }

  private async firePreview(): Promise<void> {
    if (!this.active || this.previewPaused || this.requestInFlight) return;
    const samples = this.ring.tail(PREVIEW_SAMPLE_COUNT);
    if (samples.length === 0 || computeRms(samples) < this.silenceRms) return;
    const generation = this.generation;
    const signal = this.abortController?.signal ?? new AbortController().signal;
    this.requestInFlight = true;
    try {
      const result = await this.rateLimiter.schedule(
        encodeWav(samples, PREVIEW_SAMPLE_RATE),
        this.transcribe,
        signal,
        this.now,
      );
      if (!this.active || generation !== this.generation || signal.aborted) return;
      if (result.status === "ok") {
        const text = result.text.trim();
        if (text) {
          this.setState("partial");
          this.onPartial(text, generation);
        }
        return;
      }
      if (result.status === "aborted") return;
      this.pausePreviews(result.status === "rate-limited" ? "rate-limited" : "preview-paused");
    } catch (error) {
      if (!signal.aborted) {
        this.pausePreviews(error instanceof RateLimitError ? "rate-limited" : "preview-paused");
      }
    } finally {
      this.requestInFlight = false;
    }
  }

  private pausePreviews(state: "preview-paused" | "rate-limited"): void {
    this.previewPaused = true;
    this.clearTimer();
    this.setState(state);
  }

  private clearTimer(): void {
    if (!this.previewTimer) return;
    clearInterval(this.previewTimer);
    this.previewTimer = null;
  }

  private setState(state: StreamingState): void {
    if (this.state === state) return;
    this.state = state;
    this.onStateChange(state);
  }
}

export { RateLimitError };
