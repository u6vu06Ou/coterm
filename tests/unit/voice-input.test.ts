import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { VoiceError } from "../../src/renderer/src/components/voice-input";

// Mock engine injected via dependency override (avoids real Web Speech).
type ResultCb = (text: string, isFinal: boolean, generation?: number) => void;
type ErrorCb = (err: VoiceError) => void;

class MockEngine {
  started = false;
  stopped = false;
  private resultCb: ResultCb | null = null;
  private errorCb: ErrorCb | null = null;
  private endCb: (() => void) | null = null;
  start(): void { this.started = true; }
  stop(): void { this.stopped = true; }
  onResult(cb: ResultCb): void { this.resultCb = cb; }
  onError(cb: ErrorCb): void { this.errorCb = cb; }
  onEnd(cb: () => void): void { this.endCb = cb; }
  isSupported(): boolean { return true; }
  // Test helpers
  emitResult(text: string, isFinal: boolean): void { this.resultCb?.(text, isFinal); }
  emitError(err: VoiceError): void { this.errorCb?.(err); }
  emitEnd(): void { this.endCb?.(); }
}

// ponytail: test the pure VoiceController (no React renderer needed in node env).
// The useVoiceInput hook is a thin React wrapper over VoiceController; its state
// mirroring is trivial React glue not worth a jsdom harness.
import { VoiceController, WebSpeechEngine, joinVoiceSegments, setVoiceEngineFactoryForTest, shouldCommitVoiceFinal } from "../../src/renderer/src/components/voice-input";

beforeAll(() => {
  Object.defineProperty(globalThis, "window", { configurable: true, value: { aiTerminal: { writeTerminal: vi.fn(() => undefined) } } });
});

afterEach(() => {
  vi.restoreAllMocks();
  setVoiceEngineFactoryForTest(undefined);
});

describe("VoiceController", () => {
  it("writes final text via onFinal and tracks recording state", () => {
    const engine = new MockEngine();
    const onFinal = vi.fn();
    const ctrl = new VoiceController({ lang: "zh-TW", onFinal }, engine);
    expect(ctrl.isSupported).toBe(true);
    expect(ctrl.isRecording).toBe(false);

    ctrl.start();
    expect(engine.started).toBe(true);
    expect(ctrl.isRecording).toBe(true);

    engine.emitResult("hello", false);
    expect(ctrl.interim).toBe("hello");

    engine.emitResult("hello world", true);
    expect(onFinal).toHaveBeenCalledWith("hello world", expect.any(Number));
    expect(ctrl.isRecording).toBe(false);
    expect(ctrl.interim).toBe("");
  });

  it("does not call onFinal when final text is empty", () => {
    const engine = new MockEngine();
    const onFinal = vi.fn();
    const ctrl = new VoiceController({ lang: "zh-TW", onFinal }, engine);
    ctrl.start();
    engine.emitResult("", true);
    expect(onFinal).not.toHaveBeenCalled();
  });

  it("reports unsupported when engine.isSupported() is false", () => {
    const engine = new MockEngine();
    engine.isSupported = () => false;
    const ctrl = new VoiceController({ lang: "zh-TW", onFinal: vi.fn() }, engine);
    expect(ctrl.isSupported).toBe(false);
  });

  it("forwards errors to onError", () => {
    const engine = new MockEngine();
    const onError = vi.fn();
    const ctrl = new VoiceController({ lang: "zh-TW", onFinal: vi.fn(), onError }, engine);
    ctrl.start();
    engine.emitError("network");
    expect(onError).toHaveBeenCalledWith("network");
  });

  it("commits only the first final in a session", () => {
    const engine = new MockEngine();
    const onFinal = vi.fn();
    const ctrl = new VoiceController({ lang: "zh-TW", onFinal }, engine);
    ctrl.start();
    for (let i = 0; i < 15; i++) engine.emitResult("你好，世界！", true);
    expect(onFinal).toHaveBeenCalledTimes(1);
    expect(onFinal).toHaveBeenCalledWith("你好，世界！", expect.any(Number));
  });

  it("normalizes whitespace and NFC without changing punctuation or emoji", () => {
    const engine = new MockEngine();
    const onFinal = vi.fn();
    const ctrl = new VoiceController({ lang: "zh-TW", onFinal }, engine);
    ctrl.start();
    engine.emitResult("  e\u0301   中文，🎙️  ", true);
    expect(onFinal).toHaveBeenCalledWith("é 中文，🎙️", expect.any(Number));
  });

  it("ignores empty finals and late finals after stop", () => {
    const engine = new MockEngine();
    const onFinal = vi.fn();
    const ctrl = new VoiceController({ lang: "zh-TW", onFinal }, engine);
    ctrl.start();
    engine.emitResult("   ", true);
    engine.emitResult("late", true);
    expect(onFinal).not.toHaveBeenCalled();
    ctrl.start();
    ctrl.stop();
    engine.emitResult("after stop", true);
    expect(onFinal).not.toHaveBeenCalled();
  });

  it("allows the same transcript in two intentional sessions", () => {
    const engine = new MockEngine();
    const onFinal = vi.fn();
    const ctrl = new VoiceController({ lang: "zh-TW", onFinal }, engine);
    ctrl.start();
    engine.emitResult("same", true);
    ctrl.start();
    engine.emitResult("same", true);
    expect(onFinal).toHaveBeenCalledTimes(2);
  });

  it("invalidates a session when the engine ends", () => {
    const engine = new MockEngine();
    const onFinal = vi.fn();
    const ctrl = new VoiceController({ lang: "zh-TW", onFinal }, engine);
    ctrl.start();
    engine.emitEnd();
    engine.emitResult("late", true);
    expect(onFinal).not.toHaveBeenCalled();
  });
});

// Server-side STT (WhisperEngine) only has a transcript after the upload, i.e.
// strictly after stop(). Without finalizesAfterStop the controller invalidates
// on stop() and every desktop dictation is silently dropped.
class DeferredMockEngine extends MockEngine {
  readonly finalizesAfterStop = true;
}

describe("VoiceController with a finalizesAfterStop engine", () => {
  it("ignores repeated stop while the transcript is still pending", () => {
    const engine = new DeferredMockEngine();
    const stop = vi.spyOn(engine, "stop");
    const onFinal = vi.fn();
    const ctrl = new VoiceController({ lang: "zh-TW", onFinal }, engine);
    ctrl.start();
    ctrl.stop();
    ctrl.stop();
    expect(stop).toHaveBeenCalledTimes(1);
    engine.emitResult("完整保留", true);
    expect(onFinal).toHaveBeenCalledWith("完整保留", 1);
  });
  it("commits a final that arrives after stop()", () => {
    const engine = new DeferredMockEngine();
    const onFinal = vi.fn();
    const ctrl = new VoiceController({ lang: "zh-TW", onFinal }, engine);
    ctrl.start();
    ctrl.stop();
    expect(engine.stopped).toBe(true);
    expect(ctrl.isRecording).toBe(true); // still transcribing
    engine.emitResult("上傳完才回來的字", true);
    expect(onFinal).toHaveBeenCalledWith("上傳完才回來的字", 1);
    expect(ctrl.isRecording).toBe(false);
  });

  it("commits the deferred final only once", () => {
    const engine = new DeferredMockEngine();
    const onFinal = vi.fn();
    const ctrl = new VoiceController({ lang: "zh-TW", onFinal }, engine);
    ctrl.start();
    ctrl.stop();
    engine.emitResult("once", true);
    engine.emitResult("once", true);
    expect(onFinal).toHaveBeenCalledTimes(1);
  });

  it("closes the session when the upload fails after stop()", () => {
    const engine = new DeferredMockEngine();
    const onFinal = vi.fn();
    const onError = vi.fn();
    const ctrl = new VoiceController({ lang: "zh-TW", onFinal, onError }, engine);
    ctrl.start();
    ctrl.stop();
    engine.emitError("no-stt-server");
    expect(onError).toHaveBeenCalledWith("no-stt-server");
    expect(ctrl.isRecording).toBe(false);
    engine.emitResult("late", true);
    expect(onFinal).not.toHaveBeenCalled();
  });
});

describe("WebSpeechEngine session policy", () => {
  class RecognitionStub {
    lang = "";
    continuous = false;
    interimResults = false;
    onresult: ((event: { results: ArrayLike<ArrayLike<{ transcript: string; isFinal?: boolean }>>; resultIndex: number }) => void) | null = null;
    onerror: ((event: { error: string }) => void) | null = null;
    onend: (() => void) | null = null;
    start = vi.fn();
    stop = vi.fn();
    emitFinal(text: string, resultIndex = 0): void {
      this.onresult?.({ results: [[{ transcript: text, isFinal: true }]], resultIndex });
    }
  }

  let recognition: RecognitionStub;

  beforeAll(() => {
    recognition = new RecognitionStub();
    Object.assign(globalThis.window, {
      SpeechRecognition: class {
        constructor() { return recognition; }
      },
    });
  });

  const finals = (cb: ReturnType<typeof vi.fn>): string[] =>
    cb.mock.calls.filter((call) => call[1] === true).map((call) => call[0] as string);

  it("commits a repeated final event only once", () => {
    const engine = new WebSpeechEngine();
    const onResult = vi.fn();
    engine.onResult(onResult);
    engine.start("zh-TW");
    for (let i = 0; i < 15; i++) recognition.emitFinal("一句中文，emoji 🎙️", 0);
    engine.stop();
    recognition.onend?.();
    expect(finals(onResult)).toEqual(["一句中文，emoji 🎙️"]);
  });

  it("deduplicates the same final when the browser changes resultIndex", () => {
    const engine = new WebSpeechEngine();
    const onResult = vi.fn();
    engine.onResult(onResult);
    engine.start("zh-TW");
    recognition.emitFinal("same transcript", 0);
    recognition.emitFinal("same transcript", 4);
    engine.stop();
    recognition.onend?.();
    expect(finals(onResult)).toEqual(["same transcript"]);
  });

  it("invalidates a stopped generation and keeps a new generation isolated", () => {
    const engine = new WebSpeechEngine();
    const onResult = vi.fn();
    engine.onResult(onResult);
    engine.onError(vi.fn());
    engine.start("zh-TW");
    const oldHandler = recognition.onresult;
    engine.stop();
    recognition.onend?.();
    engine.start("zh-TW");
    oldHandler?.({ results: [[{ transcript: "old session", isFinal: true }]], resultIndex: 0 });
    recognition.emitFinal("new session", 0);
    engine.stop();
    recognition.onend?.();
    expect(finals(onResult)).toEqual(["new session"]);
    expect(onResult).toHaveBeenLastCalledWith("new session", true, expect.any(Number));
  });

  it("permits the same transcript once per new session", () => {
    const engine = new WebSpeechEngine();
    const onResult = vi.fn();
    engine.onResult(onResult);
    engine.start("zh-TW");
    recognition.emitFinal("repeat intentionally", 0);
    engine.stop();
    recognition.onend?.();
    engine.start("zh-TW");
    recognition.emitFinal("repeat intentionally", 0);
    engine.stop();
    recognition.onend?.();
    expect(finals(onResult)).toEqual(["repeat intentionally", "repeat intentionally"]);
  });

  it("keeps listening across a pause and commits the whole sentence on stop", () => {
    const engine = new WebSpeechEngine();
    const onResult = vi.fn();
    engine.onResult(onResult);
    engine.start("zh-TW");
    const startsBefore = recognition.start.mock.calls.length;
    recognition.emitFinal("第一句", 0);
    recognition.onend?.(); // browser ended the run at the pause; user still talking
    expect(recognition.start.mock.calls.length).toBe(startsBefore + 1);
    recognition.emitFinal("第二句", 0);
    engine.stop();
    recognition.onend?.();
    expect(finals(onResult)).toEqual(["第一句第二句"]);
  });

  it("keeps the in-flight words when the user taps stop mid-sentence", () => {
    const engine = new WebSpeechEngine();
    const onResult = vi.fn();
    engine.onResult(onResult);
    engine.start("zh-TW");
    recognition.onresult?.({ results: [[{ transcript: "還沒講完", isFinal: false }]], resultIndex: 0 });
    engine.stop();
    recognition.onend?.();
    expect(finals(onResult)).toEqual(["還沒講完"]);
  });

  it("commits after a grace period when the browser never fires onend", () => {
    vi.useFakeTimers();
    try {
      const engine = new WebSpeechEngine();
      const onResult = vi.fn();
      engine.onResult(onResult);
      engine.start("en-US");
      recognition.emitFinal("hello", 0);
      engine.stop();
      expect(finals(onResult)).toEqual([]);
      vi.advanceTimersByTime(3_000);
      expect(finals(onResult)).toEqual(["hello"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("reports no-speech when nothing was heard", () => {
    const engine = new WebSpeechEngine();
    const onError = vi.fn();
    engine.onError(onError);
    engine.start("zh-TW");
    engine.stop();
    recognition.onend?.();
    expect(onError).toHaveBeenCalledWith("no-speech");
  });

  it("joins Latin segments with a space and CJK without", () => {
    expect(joinVoiceSegments(["hello", "world"])).toBe("hello world");
    expect(joinVoiceSegments(["你好", "世界"])).toBe("你好世界");
    expect(joinVoiceSegments(["run", "測試", " "])).toBe("run測試");
  });
});

describe("TopBar voice commit guard", () => {
  it("rejects duplicate text in one session but accepts it in another", () => {
    const first = { text: "同一句", sessionId: 1, at: 100 };
    expect(shouldCommitVoiceFinal(first, "同一句", 1, 101)).toBe(false);
    expect(shouldCommitVoiceFinal(first, "同一句", 2, 101)).toBe(true);
  });

  it("keeps legacy engines safe for a short duplicate window", () => {
    const first = { text: "legacy", sessionId: undefined, at: 100 };
    expect(shouldCommitVoiceFinal(first, "legacy", undefined, 999)).toBe(false);
    expect(shouldCommitVoiceFinal(first, "legacy", undefined, 1_100)).toBe(true);
  });
});
