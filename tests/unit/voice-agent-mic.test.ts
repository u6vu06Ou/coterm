// Phase 6 (§11.5): mic capability policy. Insecure contexts and missing
// devices must produce an explicit, displayable reason — never a dead
// button, never a pretend success.
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  agentAudioConstraints,
  buildAgentAudioConstraints,
  probeAgentMicSupport,
} from "../../src/renderer/src/voice-agent/mic";
import {
  createMediaRecorderCapture,
  encodeAudioBase64,
} from "../../src/renderer/src/voice-agent/live-capture";

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function installCaptureBrowser(getUserMedia: () => Promise<MediaStream>) {
  let recorderStarts = 0;
  const contexts: FakeAudioContext[] = [];
  const analyser = {
    fftSize: 0,
    getFloatTimeDomainData(buffer: Float32Array) {
      buffer.fill(0.2);
    },
  };
  class FakeMediaRecorder {
    state: "inactive" | "recording" = "inactive";
    mimeType = "audio/webm";
    ondataavailable: ((event: { data: Blob }) => void) | null = null;
    onstop: (() => void) | null = null;
    start(): void {
      this.state = "recording";
      recorderStarts += 1;
    }
    stop(): void {
      this.state = "inactive";
      this.onstop?.();
    }
  }
  class FakeAudioContext {
    state: "running" | "suspended" = "running";
    resumeCalls = 0;
    onstatechange: (() => void) | null = null;
    resume(): Promise<void> {
      this.resumeCalls += 1;
      this.state = "running";
      return Promise.resolve();
    }
    createAnalyser() { return analyser; }
    createMediaStreamSource() { return { connect: vi.fn() }; }
  }
  vi.stubGlobal("navigator", {
    mediaDevices: { getUserMedia, getSupportedConstraints: () => ({}) },
  });
  vi.stubGlobal("AudioContext", class extends FakeAudioContext {
    constructor() {
      super();
      contexts.push(this);
    }
  });
  vi.stubGlobal("MediaRecorder", FakeMediaRecorder);
  return { getRecorderStarts: () => recorderStarts, getAudioContexts: () => contexts };
}

describe("probeAgentMicSupport (§11.5)", () => {
  it("blocks insecure contexts with an explicit reason", () => {
    const probe = probeAgentMicSupport({
      isSecureContext: false,
      mediaDevices: { getUserMedia: async () => ({}) },
    });
    expect(probe).toEqual({ supported: false, reason: "insecure-context" });
  });

  it("blocks secure contexts without mediaDevices", () => {
    expect(probeAgentMicSupport({ isSecureContext: true, mediaDevices: null }))
      .toEqual({ supported: false, reason: "no-media-devices" });
    expect(probeAgentMicSupport({ isSecureContext: true, mediaDevices: {} }))
      .toEqual({ supported: false, reason: "no-media-devices" });
  });

  it("reports support only for secure context + getUserMedia", () => {
    const probe = probeAgentMicSupport({
      isSecureContext: true,
      mediaDevices: { getUserMedia: async () => ({}) },
    });
    expect(probe).toEqual({ supported: true, reason: null });
  });
});

describe("buildAgentAudioConstraints (echo/noise/AGC policy)", () => {
  it("requests suppression features only when the UA advertises them", () => {
    expect(buildAgentAudioConstraints({
      echoCancellation: true,
      noiseSuppression: false,
      autoGainControl: true,
    })).toEqual({ audio: { echoCancellation: true, autoGainControl: true } });
    expect(buildAgentAudioConstraints({})).toEqual({ audio: {} });
  });

  it("agentAudioConstraints reads the UA-supported constraint map", () => {
    const constraints = agentAudioConstraints({
      isSecureContext: true,
      mediaDevices: {
        getUserMedia: async () => ({}),
        getSupportedConstraints: () => ({ noiseSuppression: true }),
      },
    });
    expect(constraints).toEqual({ audio: { noiseSuppression: true } });
  });
});

describe("encodeAudioBase64 (mobile authenticated RPC channel)", () => {
  it("round-trips arbitrary bytes including multibyte boundaries", () => {
    const audio = new Uint8Array(70_000);
    for (let index = 0; index < audio.length; index += 1) audio[index] = index % 251;
    const encoded = encodeAudioBase64(audio);
    const decoded = Uint8Array.from(atob(encoded), (char) => char.charCodeAt(0));
    expect(decoded).toEqual(audio);
  });
});

describe("MediaRecorder capture lifecycle", () => {
  const fakeStream = {
    getAudioTracks: () => [{ readyState: "live", addEventListener: vi.fn() }],
  } as unknown as MediaStream;

  it("keeps VAD active during TTS and stops it after unsubscribe", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    installCaptureBrowser(async () => fakeStream);
    const capture = createMediaRecorderCapture();
    capture.start();
    await Promise.resolve();
    await Promise.resolve();
    await capture.stop();
    const speechStart = vi.fn();
    const unsubscribe = capture.onSpeechStart(speechStart);
    await vi.advanceTimersByTimeAsync(180);
    expect(speechStart).toHaveBeenCalledTimes(1);
    unsubscribe();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(speechStart).toHaveBeenCalledTimes(1);
    capture.cancel();
  });

  it("resumes a suspended audio context so VAD keeps listening (iOS interruptions)", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const browser = installCaptureBrowser(async () => fakeStream);
    const capture = createMediaRecorderCapture();
    const speechStart = vi.fn();
    const unsubscribe = capture.onSpeechStart(speechStart);
    await Promise.resolve();
    await Promise.resolve();
    const context = browser.getAudioContexts()[0]!;
    context.state = "suspended";
    await vi.advanceTimersByTimeAsync(80);
    expect(context.resumeCalls).toBeGreaterThan(0);
    expect(context.state).toBe("running");
    unsubscribe();
    capture.cancel();
  });

  it("does not open a rogue recorder when stop wins the getUserMedia race", async () => {
    let resolveStream: (stream: MediaStream) => void = () => undefined;
    const pendingStream = new Promise<MediaStream>((resolve) => { resolveStream = resolve; });
    const browser = installCaptureBrowser(() => pendingStream);
    const capture = createMediaRecorderCapture();
    capture.start();
    await expect(capture.stop()).resolves.toBeNull();
    resolveStream(fakeStream);
    await Promise.resolve();
    await Promise.resolve();
    expect(browser.getRecorderStarts()).toBe(0);
    capture.cancel();
  });
});
