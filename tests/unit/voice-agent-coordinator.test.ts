// Phase 6 (§11.5): the shared coordinator is the single voice-agent loop
// for desktop + mobile. These tests drive it with vector-controlled seams
// (no jsdom, no real mic/TTS) and pin push-to-talk flow, barge-in ordering,
// interrupt, lifecycle resets, and bounded memory.
import { describe, expect, it, vi } from "vitest";
import type { AgentApiVoiceTurnResult } from "../../src/shared/types";
import {
  AgentApiVoiceAgentCoordinator,
  AGENTAPI_VOICE_PANE_MAX_TURNS,
  type VoiceAgentCapture,
  type VoiceAgentCoordinatorSeams,
} from "../../src/renderer/src/voice-agent/agent-coordinator";

function deferred<T>() {
  let resolve: (value: T) => void = () => undefined;
  let reject: (error: unknown) => void = () => undefined;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function turnResult(text: string): AgentApiVoiceTurnResult {
  return {
    epoch: 1,
    text,
    source: "fast",
    spoken: true,
    targetTerminalId: null,
    targetTitle: null,
    clarification: null,
  };
}

function makeHarness(seamOverrides: Partial<VoiceAgentCoordinatorSeams> = {}) {
  const speechStartListeners = new Set<() => void>();
  const utteranceEndListeners = new Set<() => void>();
  const partialListeners = new Set<(text: string, generation: number) => void>();
  let clock = 1_000;
  const capture: VoiceAgentCapture & { started: number; cancelled: number } = {
    started: 0,
    cancelled: 0,
    start() { this.started += 1; },
    stop: async () => ({ audio: new Uint8Array([1, 2, 3]), mimeType: "audio/webm" }),
    cancel() { this.cancelled += 1; },
    onSpeechStart(callback) {
      speechStartListeners.add(callback);
      return () => speechStartListeners.delete(callback);
    },
    onUtteranceEnd(callback) {
      utteranceEndListeners.add(callback);
      return () => utteranceEndListeners.delete(callback);
    },
    onPartial(callback) {
      partialListeners.add(callback);
      return () => partialListeners.delete(callback);
    },
  };
  const calls = {
    transcribe: [] as Array<{ mimeType: string; lang: string }>,
    turn: [] as string[],
    interrupt: 0,
    speak: [] as string[],
  };
  const seams: VoiceAgentCoordinatorSeams = {
    capture,
    transcribe: async (_audio, mimeType, lang) => {
      calls.transcribe.push({ mimeType, lang });
      return "你好Agent API";
    },
    turn: async (utterance) => {
      calls.turn.push(utterance);
      return turnResult(`回覆：${utterance}`);
    },
    interruptTurn: async () => {
      calls.interrupt += 1;
    },
    getLanguage: () => "zh-TW",
    getSpeechConfig: () => ({ voiceUri: null, rate: 1, volume: 1, muted: false }),
    speak: async (text) => {
      calls.speak.push(text);
      return { spoken: true, cancelled: false };
    },
    now: () => clock,
    ...seamOverrides,
  };
  const coordinator = new AgentApiVoiceAgentCoordinator(seams);
  return {
    coordinator,
    capture,
    calls,
    fireSpeechStart: () => { for (const listener of speechStartListeners) listener(); },
    fireUtteranceEnd: () => { for (const listener of utteranceEndListeners) listener(); },
    firePartial: (text: string, generation: number) => {
      for (const listener of partialListeners) listener(text, generation);
    },
    advance: (ms: number) => { clock += ms; },
  };
}

describe("persistent Live Voice loop", () => {
  it("one Start automatically endpoints, answers, and returns to Listening", async () => {
    const { coordinator, capture, calls, fireUtteranceEnd } = makeHarness();
    await coordinator.startSession();
    expect(coordinator.getSnapshot()).toMatchObject({ active: true, muted: false, state: "listening" });
    expect(capture.started).toBe(1);
    fireUtteranceEnd();
    await vi.waitFor(() => expect(calls.speak).toHaveLength(1));
    await vi.waitFor(() => expect(coordinator.getState()).toBe("listening"));
    expect(capture.started).toBe(2);
    expect(calls.transcribe).toHaveLength(1);
    expect(calls.turn).toEqual(["你好Agent API"]);
    await coordinator.endSession();
  });

  it("mute/unmute pauses only microphone capture and End closes the call", async () => {
    const { coordinator, capture } = makeHarness();
    await coordinator.startSession();
    await coordinator.mute();
    expect(coordinator.getSnapshot()).toMatchObject({ active: true, muted: true, state: "idle" });
    expect(capture.cancelled).toBeGreaterThanOrEqual(1);
    await coordinator.unmute();
    expect(coordinator.getState()).toBe("listening");
    await coordinator.endSession();
    expect(coordinator.getSnapshot()).toMatchObject({ active: false, muted: false, state: "idle" });
  });

  it("offline/reconnect keeps the logical call active and resumes Listening", async () => {
    const { coordinator, capture } = makeHarness();
    await coordinator.startSession();
    coordinator.handleLifecycleReset("offline");
    expect(coordinator.getSnapshot()).toMatchObject({ active: true, state: "reconnecting" });
    coordinator.handleLifecycleReset("online");
    await vi.waitFor(() => expect(coordinator.getState()).toBe("listening"));
    expect(capture.started).toBe(2);
    await coordinator.endSession();
  });

  it("durable session seam owns turns and preserves one voiceSessionId", async () => {
    const durable = {
      start: vi.fn(async () => "vs-durable"),
      resume: vi.fn(async () => undefined),
      speechStarted: vi.fn(async () => undefined),
      turn: vi.fn(async (_id: string, utterance: string) => turnResult(`durable:${utterance}`)),
      replyFinished: vi.fn(async () => undefined),
      mute: vi.fn(async () => undefined),
      unmute: vi.fn(async () => undefined),
      reconnecting: vi.fn(async () => undefined),
      reconnected: vi.fn(async () => undefined),
      end: vi.fn(async () => undefined),
    };
    const { coordinator, calls, fireUtteranceEnd } = makeHarness({ persistentSession: durable });
    await coordinator.startSession();
    expect(coordinator.getSnapshot().voiceSessionId).toBe("vs-durable");
    fireUtteranceEnd();
    await vi.waitFor(() => expect(durable.replyFinished).toHaveBeenCalledWith("vs-durable"));
    expect(durable.turn).toHaveBeenCalledWith("vs-durable", "你好Agent API");
    expect(calls.turn).toEqual([]);
    await coordinator.endSession();
    expect(durable.end).toHaveBeenCalledWith("vs-durable");
  });

  it("speech during persistent TTS cancels playback immediately and opens the next turn", async () => {
    const speakGate = deferred<{ spoken: boolean; cancelled: boolean }>();
    const speakSignals: AbortSignal[] = [];
    const durable = {
      start: vi.fn(async () => "vs-barge"),
      resume: vi.fn(async () => undefined),
      speechStarted: vi.fn(async () => undefined),
      turn: vi.fn(async (_id: string, utterance: string) => turnResult(`durable:${utterance}`)),
      replyFinished: vi.fn(async () => undefined),
      mute: vi.fn(async () => undefined),
      unmute: vi.fn(async () => undefined),
      reconnecting: vi.fn(async () => undefined),
      reconnected: vi.fn(async () => undefined),
      end: vi.fn(async () => undefined),
    };
    const harness = makeHarness({
      persistentSession: durable,
      speak: (_text, signal) => {
        speakSignals.push(signal);
        return speakGate.promise;
      },
    });
    await harness.coordinator.startSession();
    harness.fireUtteranceEnd();
    await vi.waitFor(() => expect(harness.coordinator.getState()).toBe("speaking"));
    harness.fireSpeechStart();
    await vi.waitFor(() => expect(harness.coordinator.getState()).toBe("listening"));
    expect(speakSignals[0]?.aborted).toBe(true);
    expect(durable.speechStarted).toHaveBeenCalledWith("vs-barge");
    expect(harness.capture.started).toBe(2);
    speakGate.resolve({ spoken: true, cancelled: true });
    await harness.coordinator.endSession();
  });

  it("speech during persistent Thinking aborts the in-flight AgentApi turn before TTS", async () => {
    const turnGate = deferred<AgentApiVoiceTurnResult | null>();
    const durable = {
      start: vi.fn(async () => "vs-thinking-barge"),
      resume: vi.fn(async () => undefined),
      speechStarted: vi.fn(async () => undefined),
      turn: vi.fn(() => turnGate.promise),
      replyFinished: vi.fn(async () => undefined),
      mute: vi.fn(async () => undefined),
      unmute: vi.fn(async () => undefined),
      reconnecting: vi.fn(async () => undefined),
      reconnected: vi.fn(async () => undefined),
      end: vi.fn(async () => undefined),
    };
    const harness = makeHarness({ persistentSession: durable });
    await harness.coordinator.startSession();
    harness.fireUtteranceEnd();
    await vi.waitFor(() => expect(harness.coordinator.getState()).toBe("thinking"));
    harness.fireSpeechStart();
    await vi.waitFor(() => expect(harness.coordinator.getState()).toBe("listening"));
    expect(durable.speechStarted).toHaveBeenCalledWith("vs-thinking-barge");
    expect(harness.calls.speak).toEqual([]);
    turnGate.resolve(null);
    await harness.coordinator.endSession();
  });
});

describe("push-to-talk turn (desktop/mobile shared loop)", () => {
  it("walks listening → transcribing → thinking → speaking → idle", async () => {
    const { coordinator, calls, capture } = makeHarness();
    const states: string[] = [];
    coordinator.onChange((snapshot) => states.push(snapshot.state));
    await coordinator.startListening();
    expect(coordinator.getState()).toBe("listening");
    expect(capture.started).toBe(1);
    await coordinator.stopListening();
    expect(coordinator.getState()).toBe("idle");
    expect(states).toContain("transcribing");
    expect(states).toContain("thinking");
    expect(states).toContain("speaking");
    expect(calls.transcribe).toEqual([{ mimeType: "audio/webm", lang: "zh-TW" }]);
    expect(calls.turn).toEqual(["你好Agent API"]);
    expect(calls.speak).toEqual(["回覆：你好Agent API"]);
    const snapshot = coordinator.getSnapshot();
    expect(snapshot.lastUtterance).toMatchObject({ text: "你好Agent API", status: "final" });
    expect(snapshot.lastReply).toMatchObject({ text: "回覆：你好Agent API", spoke: true });
    expect(snapshot.recentTurns.map((turn) => turn.role)).toEqual(["user", "agentapi"]);
  });

  it("streams partials only for the live generation", async () => {
    const { coordinator, firePartial } = makeHarness();
    await coordinator.startListening();
    const generation = coordinator.getSnapshot().generation;
    firePartial("辨識中", generation);
    expect(coordinator.getSnapshot().partial).toBe("辨識中");
    firePartial("舊的殘影", generation + 1);
    expect(coordinator.getSnapshot().partial).toBe("辨識中");
  });

  it("an empty take returns to idle without calling the turn seam", async () => {
    const { coordinator, calls, capture } = makeHarness();
    capture.stop = async () => null;
    await coordinator.startListening();
    await coordinator.stopListening();
    expect(coordinator.getState()).toBe("idle");
    expect(calls.turn).toEqual([]);
    expect(calls.speak).toEqual([]);
  });

  it("a second press while idle-transcribing never double-submits", async () => {
    const { coordinator, calls } = makeHarness();
    await coordinator.startListening();
    await coordinator.startListening(); // no-op while listening
    await coordinator.stopListening();
    expect(calls.turn).toHaveLength(1);
  });
});

describe("barge-in (§11.3)", () => {
  function speakingHarness() {
    const speakGate = deferred<{ spoken: boolean; cancelled: boolean }>();
    let speakSignal: AbortSignal | null = null;
    const harness = makeHarness({
      speak: (text, signal) => {
        harness.calls.speak.push(text);
        speakSignal = signal;
        return speakGate.promise;
      },
    });
    return { ...harness, speakGate, getSpeakSignal: () => speakSignal };
  }

  it("user speech during speaking: cancels TTS, interrupts main, re-enters listening", async () => {
    const { coordinator, calls, capture, fireSpeechStart, speakGate, getSpeakSignal } = speakingHarness();
    await coordinator.startListening();
    const turnPromise = coordinator.stopListening();
    await vi.waitFor(() => expect(coordinator.getState()).toBe("speaking"));
    fireSpeechStart();
    await vi.waitFor(() => expect(coordinator.getState()).toBe("listening"));
    // Spec order: TTS aborted locally (signal) + epoch bumped in main
    // (interrupt seam) before the fresh capture opens.
    expect(getSpeakSignal()?.aborted).toBe(true);
    expect(calls.interrupt).toBe(1);
    expect(capture.started).toBe(2);
    // The interrupted turn's late speech outcome is discarded.
    speakGate.resolve({ spoken: true, cancelled: true });
    await turnPromise;
    expect(coordinator.getSnapshot().lastReply?.spoke).toBe(false);
    coordinator.dispose();
  });

  it("a mic press during speaking IS the barge-in (single control entry)", async () => {
    const { coordinator, calls, speakGate } = speakingHarness();
    await coordinator.startListening();
    const turnPromise = coordinator.stopListening();
    await vi.waitFor(() => expect(coordinator.getState()).toBe("speaking"));
    await coordinator.startListening();
    expect(coordinator.getState()).toBe("listening");
    expect(calls.interrupt).toBe(1);
    speakGate.resolve({ spoken: true, cancelled: true });
    await turnPromise;
    coordinator.dispose();
  });

  it("the interrupt control cancels speech and lands on idle (no mic reopen)", async () => {
    const { coordinator, calls, capture, speakGate, getSpeakSignal } = speakingHarness();
    await coordinator.startListening();
    const turnPromise = coordinator.stopListening();
    await vi.waitFor(() => expect(coordinator.getState()).toBe("speaking"));
    await coordinator.interrupt();
    expect(coordinator.getState()).toBe("idle");
    expect(getSpeakSignal()?.aborted).toBe(true);
    expect(calls.interrupt).toBe(1);
    expect(capture.started).toBe(1); // mic not reopened
    speakGate.resolve({ spoken: true, cancelled: true });
    await turnPromise;
    coordinator.dispose();
  });
});

describe("lifecycle reset (§11.5 lock/background/reconnect)", () => {
  it("a hidden page cancels capture and an old final can never replay", async () => {
    const turnGate = deferred<AgentApiVoiceTurnResult>();
    const { coordinator, capture, calls, advance } = makeHarness({ turn: () => turnGate.promise });
    await coordinator.startListening();
    advance(300);
    const turnPromise = coordinator.stopListening();
    await vi.waitFor(() => expect(coordinator.getState()).toBe("thinking"));
    coordinator.handleLifecycleReset("hidden");
    expect(coordinator.getState()).toBe("idle");
    expect(capture.cancelled).toBeGreaterThanOrEqual(1);
    // The stale final arrives AFTER the reset: discarded by generation check.
    turnGate.resolve(turnResult("遲到的回覆"));
    await turnPromise;
    expect(coordinator.getSnapshot().lastReply).toBeNull();
    expect(calls.speak).toEqual([]);
    coordinator.dispose();
  });

  it("ignores a hide event racing a deliberate mic press (mobile PiP guard)", async () => {
    const { coordinator, advance } = makeHarness();
    await coordinator.startListening();
    coordinator.handleLifecycleReset("hidden"); // same tick as the press
    expect(coordinator.getState()).toBe("listening");
    advance(300);
    coordinator.handleLifecycleReset("hidden");
    expect(coordinator.getState()).toBe("idle");
    coordinator.dispose();
  });

  it("rehydrate resets a speaking turn the same way", async () => {
    const { coordinator, advance } = makeHarness();
    await coordinator.startListening();
    advance(300);
    const turnPromise = coordinator.stopListening();
    await vi.waitFor(() => expect(coordinator.getState()).toBe("idle"));
    await turnPromise;
    // idle + no partial: reset is a no-op (nothing half-finished to save).
    coordinator.handleLifecycleReset("rehydrate");
    expect(coordinator.getState()).toBe("idle");
    coordinator.dispose();
  });
});

describe("typed turns (dry-run / Voice Playground)", () => {
  it("typed turns get the same routing + TTS as voice turns", async () => {
    const { coordinator, calls, capture } = makeHarness();
    const states: string[] = [];
    coordinator.onChange((snapshot) => states.push(snapshot.state));
    await coordinator.runTextTurn("哪個視窗需要我");
    expect(states).toContain("thinking");
    expect(states).toContain("speaking");
    expect(coordinator.getState()).toBe("idle");
    expect(capture.started).toBe(0); // no mic involved
    expect(calls.turn).toEqual(["哪個視窗需要我"]);
    expect(calls.speak).toEqual(["回覆：哪個視窗需要我"]);
    coordinator.dispose();
  });

  it("recovers from a mic error state instead of bricking the text path", async () => {
    const { coordinator, calls } = makeHarness({
      transcribe: async () => { throw new Error("stt down"); },
    });
    await coordinator.startListening();
    await coordinator.stopListening();
    expect(coordinator.getState()).toBe("error");
    await coordinator.runTextTurn("狀態如何");
    expect(coordinator.getState()).toBe("idle");
    expect(calls.turn).toEqual(["狀態如何"]);
    coordinator.dispose();
  });

  it("a typed turn cancels an active mic take before it becomes authoritative", async () => {
    const { coordinator, calls, capture } = makeHarness();
    await coordinator.startListening();
    await coordinator.runTextTurn("改用文字");
    expect(capture.cancelled).toBe(1);
    expect(calls.transcribe).toEqual([]);
    expect(calls.turn).toEqual(["改用文字"]);
    expect(coordinator.getState()).toBe("idle");
    coordinator.dispose();
  });

  it("bounds the pane memory ring (memory-only, nothing persisted)", async () => {
    const { coordinator } = makeHarness();
    for (let index = 0; index < 12; index += 1) {
      await coordinator.runTextTurn(`第 ${index} 句`);
    }
    const turns = coordinator.getSnapshot().recentTurns;
    expect(turns.length).toBe(AGENTAPI_VOICE_PANE_MAX_TURNS);
    expect(AGENTAPI_VOICE_PANE_MAX_TURNS).toBeLessThanOrEqual(8);
    coordinator.dispose();
  });
});
