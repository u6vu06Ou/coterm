import { afterEach, describe, expect, it, vi } from "vitest";
import {
  RateLimitError,
  StreamingDictationCoordinator,
  type StreamingState,
} from "../../src/renderer/src/components/voice/streaming-coordinator";
import { PreviewRateLimiter } from "../../src/renderer/src/components/voice/rate-limiter";
import { PREVIEW_SAMPLE_COUNT } from "../../src/renderer/src/components/voice/wav-encoder";

function loudSamples(count = PREVIEW_SAMPLE_COUNT): Float32Array {
  const samples = new Float32Array(count);
  for (let index = 0; index < count; index += 1) samples[index] = Math.sin(index * 0.01) * 0.5;
  return samples;
}

function makeCoordinator(options: {
  transcribe?: (audio: ArrayBuffer, signal: AbortSignal) => Promise<string>;
  onPartial?: (text: string, generation: number) => void;
  onStateChange?: (state: StreamingState) => void;
}) {
  const onPartial = options.onPartial ?? vi.fn();
  const onStateChange = options.onStateChange ?? vi.fn();
  const coordinator = new StreamingDictationCoordinator({
    transcribe: options.transcribe ?? vi.fn().mockResolvedValue("partial"),
    onPartial,
    onStateChange,
    rateLimiter: new PreviewRateLimiter({ minIntervalMs: 0, maxRetries: 0 }),
    previewIntervalMs: 100_000,
    silenceRms: 0,
  });
  return { coordinator, onPartial, onStateChange };
}

afterEach(() => vi.useRealTimers());

describe("StreamingDictationCoordinator preview layer", () => {
  it("emits a partial for the locked generation and never owns a final callback", async () => {
    const onPartial = vi.fn();
    const transcribe = vi.fn().mockResolvedValue("你好 hello");
    const { coordinator } = makeCoordinator({ transcribe, onPartial });
    coordinator.start(17);
    coordinator.feedPcm(loudSamples());
    await coordinator.requestPreviewNow();
    expect(onPartial).toHaveBeenCalledOnce();
    expect(onPartial).toHaveBeenCalledWith("你好 hello", 17);
    expect(transcribe).toHaveBeenCalledOnce();
  });

  it("stops preview requests after the first 429 while leaving final ownership outside", async () => {
    const transcribe = vi.fn().mockRejectedValue(new RateLimitError());
    const { coordinator, onStateChange } = makeCoordinator({ transcribe });
    coordinator.start(1);
    coordinator.feedPcm(loudSamples());
    await coordinator.requestPreviewNow();
    await coordinator.requestPreviewNow();
    expect(transcribe).toHaveBeenCalledOnce();
    expect(coordinator.isPreviewPaused()).toBe(true);
    expect(onStateChange).toHaveBeenCalledWith("rate-limited");
  });

  it("stops preview requests after a network failure", async () => {
    const transcribe = vi.fn().mockRejectedValue(new Error("timeout"));
    const { coordinator, onStateChange } = makeCoordinator({ transcribe });
    coordinator.start(2);
    coordinator.feedPcm(loudSamples());
    await coordinator.requestPreviewNow();
    await coordinator.requestPreviewNow();
    expect(transcribe).toHaveBeenCalledOnce();
    expect(onStateChange).toHaveBeenCalledWith("preview-paused");
  });

  it("stopForFinal aborts and ignores a late preview", async () => {
    let resolvePreview: ((value: string) => void) | undefined;
    const transcribe = vi.fn((_audio: ArrayBuffer, _signal: AbortSignal) => new Promise<string>((resolve) => {
      resolvePreview = resolve;
    }));
    const onPartial = vi.fn();
    const { coordinator, onStateChange } = makeCoordinator({ transcribe, onPartial });
    coordinator.start(3);
    coordinator.feedPcm(loudSamples());
    const pending = coordinator.requestPreviewNow();
    coordinator.stopForFinal();
    resolvePreview?.("late");
    await pending;
    expect(onPartial).not.toHaveBeenCalled();
    expect(onStateChange).toHaveBeenCalledWith("finalizing");
  });

  it("cancel invalidates the generation and clears state", async () => {
    const onPartial = vi.fn();
    const { coordinator } = makeCoordinator({ onPartial });
    coordinator.start(4);
    coordinator.feedPcm(loudSamples());
    coordinator.cancel();
    await coordinator.requestPreviewNow();
    expect(onPartial).not.toHaveBeenCalled();
    expect(coordinator.getState()).toBe("idle");
  });

  it("silence never uploads a preview", async () => {
    const transcribe = vi.fn();
    const coordinator = new StreamingDictationCoordinator({
      transcribe,
      onPartial: vi.fn(),
      onStateChange: vi.fn(),
      previewIntervalMs: 100_000,
      silenceRms: 0.01,
    });
    coordinator.start(5);
    coordinator.feedPcm(new Float32Array(PREVIEW_SAMPLE_COUNT));
    await coordinator.requestPreviewNow();
    expect(transcribe).not.toHaveBeenCalled();
  });
});
