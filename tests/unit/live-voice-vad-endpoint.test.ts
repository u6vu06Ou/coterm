import { describe, expect, it } from "vitest";
import { DEFAULT_VAD_ENDPOINT_OPTIONS, VadEndpointController } from "../../src/main/voice-worker/vad-endpoint";

describe("VadEndpointController", () => {
  it("uses a conservative initial silence threshold", () => {
    expect(DEFAULT_VAD_ENDPOINT_OPTIONS.silenceMs).toBeGreaterThanOrEqual(800);
  });

  it("does not cut a normal Chinese pause before the silence threshold", () => {
    const endpoint = new VadEndpointController({ silenceMs: 900 });
    expect(endpoint.observe({ speech: true, atMs: 0 })).toEqual([{ type: "speech-started", atMs: 0 }]);
    expect(endpoint.observe({ speech: true, atMs: 400 })).toEqual([]);
    expect(endpoint.observe({ speech: false, atMs: 1_150 })).toEqual([]);
    expect(endpoint.observe({ speech: false, atMs: 1_300 })).toEqual([
      { type: "utterance-ended", atMs: 1_300, durationMs: 1_300, reason: "silence" },
    ]);
  });

  it("bounds a runaway utterance", () => {
    const endpoint = new VadEndpointController({ maxUtteranceMs: 5_000 });
    endpoint.observe({ speech: true, atMs: 100 });
    expect(endpoint.observe({ speech: true, atMs: 5_100 })).toEqual([
      { type: "utterance-ended", atMs: 5_100, durationMs: 5_000, reason: "max-duration" },
    ]);
  });
});
