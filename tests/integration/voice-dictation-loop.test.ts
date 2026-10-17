// §11 end-to-end loop coverage: push-to-talk bytes → transcribeVoice (real,
// against a stubbed fetch speaking the OpenAI transcription shape) → the
// coordinator's agent-input seam (utterance → routed reply) → speakSpeechText
// (real sentence chunking, against a fake synth). The unit tests pin each
// stage in isolation; this file pins that the stages still compose, and that
// STT failures surface as user-readable errors — never as silence, and never
// as an error string submitted to the terminal as if it were a transcript.
import { afterEach, describe, expect, it, vi } from "vitest";
import { transcribeVoice } from "../../src/main/voice/transcribe";
import { NO_SERVER_CODE } from "../../src/shared/ipc";
import type { AgentApiVoiceTurnResult } from "../../src/shared/types";
import {
  AgentApiVoiceAgentCoordinator,
  type VoiceAgentCapture,
  type VoiceAgentCoordinatorSeams,
} from "../../src/renderer/src/voice-agent/agent-coordinator";
import type { VoiceAgentUiState } from "../../src/renderer/src/voice-agent/agent-state-machine";
import {
  speakSpeechText,
  type VoiceAgentTtsSynth,
} from "../../src/renderer/src/voice-agent/tts";

const RECORDED_AUDIO = new Uint8Array([9, 8, 7, 6, 5]);
const RECORDED_MIME = "audio/webm;codecs=opus"; // what MediaRecorder reports

type FetchCall = { url: string; method: string; body: unknown };

/** Replace global fetch with an OpenAI-shaped transcription stub. */
function stubFetch(handler: (call: FetchCall) => Response): FetchCall[] {
  const calls: FetchCall[] = [];
  vi.stubGlobal("fetch", vi.fn((input: unknown, init: { method?: string; body?: unknown } = {}) => {
    const call: FetchCall = { url: String(input), method: init.method ?? "GET", body: init.body };
    calls.push(call);
    return Promise.resolve(handler(call));
  }));
  return calls;
}

function okTranscript(text: string): Response {
  return new Response(JSON.stringify({ text }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

/** Fake speech engine: records every utterance and auto-finishes it, so
 * speakSpeechText's sentence chain can run to completion without jsdom. */
function makeFakeSynth() {
  const spokenChunks: string[] = [];
  const synth: VoiceAgentTtsSynth = {
    getVoices: () => [{ voiceURI: "v-fake", name: "Fake", lang: "zh-TW" }],
    speak(utterance) {
      const u = utterance as { text: string; onend: (() => void) | null };
      spokenChunks.push(u.text);
      queueMicrotask(() => u.onend?.());
    },
    cancel() { /* no queued playback in the fake */ },
  };
  return { synth, spokenChunks };
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

const STT_SETTINGS = {
  serverUrl: "http://stt.invalid:9000/v1",
  model: "large-v3",
  apiKey: undefined as string | undefined,
};

function makeLoop(seamOverrides: Partial<VoiceAgentCoordinatorSeams> = {}) {
  const speechStartListeners = new Set<() => void>();
  const capture: VoiceAgentCapture = {
    start() { /* recorder armed */ },
    stop: async () => ({ audio: RECORDED_AUDIO, mimeType: RECORDED_MIME }),
    cancel() { /* push-to-talk release is the only exit in these tests */ },
    onSpeechStart(callback) {
      speechStartListeners.add(callback);
      return () => speechStartListeners.delete(callback);
    },
  };
  const calls = { turn: [] as string[], interrupt: 0 };
  // The production desktop seam base64-encodes the clip into an IPC envelope;
  // the contract here is bytes-in → transcript-out, so the seam below mirrors
  // the main-side handler body (transcribeVoice with settings-owned URL/model)
  // verbatim — including its failure semantics.
  const seams: VoiceAgentCoordinatorSeams = {
    capture,
    transcribe: async (audio, mimeType, lang) => {
      const buffer = new Uint8Array(audio).buffer; // fresh ArrayBuffer (view offset irrelevant)
      const result = await transcribeVoice({
        audio: buffer,
        mimeType,
        lang,
        serverUrl: STT_SETTINGS.serverUrl,
        model: STT_SETTINGS.model,
        apiKey: STT_SETTINGS.apiKey,
      });
      return result.text;
    },
    turn: async (utterance) => {
      calls.turn.push(utterance);
      return turnResult(`收到：${utterance}`);
    },
    interruptTurn: async () => {
      calls.interrupt += 1;
    },
    getLanguage: () => "zh-TW",
    getSpeechConfig: () => ({ voiceUri: null, rate: 1, volume: 1, muted: false }),
    speak: async () => ({ spoken: false, cancelled: false }), // overridden per-test
    ...seamOverrides,
  };
  const coordinator = new AgentApiVoiceAgentCoordinator(seams);
  const states: VoiceAgentUiState[] = [];
  coordinator.onChange((snapshot) => {
    if (states[states.length - 1] !== snapshot.state) states.push(snapshot.state);
  });
  return { coordinator, calls, states };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("voice dictation loop (說→轉→答→唸)", () => {
  it("happy path: recorded bytes become a transcript, the transcript reaches the agent, and the reply is spoken sentence-by-sentence", async () => {
    const fetchCalls = stubFetch(() => okTranscript("  今天天氣如何  "));
    const { synth, spokenChunks } = makeFakeSynth();
    const { coordinator, calls, states } = makeLoop({
      speak: (text, signal) =>
        speakSpeechText(synth, text, { voiceUri: null, rate: 1, volume: 1, muted: false }, {
          signal,
          createUtterance: (chunk) => ({ text: chunk, onend: null, onerror: null }),
        }),
    });

    await coordinator.startListening();
    await coordinator.stopListening();
    await vi.waitFor(() => expect(coordinator.getState()).toBe("idle"));

    // Whole state walk, no stage skipped.
    expect(states).toEqual(["idle", "listening", "transcribing", "thinking", "speaking", "idle"]);

    // One OpenAI-shaped POST at the resolved transcription path.
    expect(fetchCalls).toHaveLength(1);
    expect(fetchCalls[0]!.url).toBe("http://stt.invalid:9000/v1/audio/transcriptions");
    expect(fetchCalls[0]!.method).toBe("POST");
    expect(fetchCalls[0]!.body).toBeInstanceOf(FormData);

    // The agent input path received the trimmed transcript verbatim, and only it.
    expect(calls.turn).toEqual(["今天天氣如何"]);

    // The reply went through real sentence chunking into the synth.
    expect(spokenChunks.join("")).toBe("收到：今天天氣如何");
    const snapshot = coordinator.getSnapshot();
    expect(snapshot.error).toBeNull();
    expect(snapshot.lastReply).toMatchObject({ text: "收到：今天天氣如何", spoke: true });
    expect(snapshot.recentTurns.map((turn) => [turn.role, turn.text])).toEqual([
      ["user", "今天天氣如何"],
      ["agentapi", "收到：今天天氣如何"],
    ]);
    coordinator.dispose();
  });

  it("no STT server configured: the loop surfaces a user-readable error, nothing is sent to the agent, nothing is spoken", async () => {
    stubFetch(() => okTranscript("不該被叫到"));
    const { synth, spokenChunks } = makeFakeSynth();
    const { coordinator, calls, states } = makeLoop({
      transcribe: async (audio, mimeType, lang) => {
        const buffer = new Uint8Array(audio).buffer; // fresh ArrayBuffer (view offset irrelevant)
        const result = await transcribeVoice({
          audio: buffer,
          mimeType,
          lang,
          serverUrl: "   ", // Settings → Voice input left blank
          model: STT_SETTINGS.model,
        });
        return result.text;
      },
      speak: (text, signal) =>
        speakSpeechText(synth, text, { voiceUri: null, rate: 1, volume: 1, muted: false }, {
          signal,
          createUtterance: (chunk) => ({ text: chunk, onend: null, onerror: null }),
        }),
    });

    await coordinator.startListening();
    await coordinator.stopListening();

    // Fail loudly: explicit error state + a message naming the fix, not a dead mic.
    expect(coordinator.getState()).toBe("error");
    const error = coordinator.getSnapshot().error ?? "";
    expect(error).toContain(NO_SERVER_CODE);
    expect(error).toContain("no speech-to-text server configured");
    expect(error).toContain("Settings");
    expect(calls.turn).toEqual([]); // no phantom utterance reaches the agent
    expect(spokenChunks).toEqual([]);
    expect(states).not.toContain("speaking");
    coordinator.dispose();
  });

  it("STT HTTP 500: the error never enters the transcript lane — the agent sees nothing and the panel shows the failure", async () => {
    stubFetch(() => {
      return new Response(JSON.stringify({ error: { message: "Internal Server Error" } }), {
        status: 500,
        headers: { "content-type": "application/json" },
      });
    });
    const { synth, spokenChunks } = makeFakeSynth();
    const { coordinator, calls } = makeLoop({
      transcribe: async (audio, mimeType, _lang) => {
        const buffer = new Uint8Array(audio).buffer; // fresh ArrayBuffer (view offset irrelevant)
        const result = await transcribeVoice({
          audio: buffer,
          mimeType,
          lang: "en-US", // no zh prompt → no silent-retry ambiguity in this lane
          serverUrl: STT_SETTINGS.serverUrl,
          model: STT_SETTINGS.model,
        });
        return result.text;
      },
      speak: (text, signal) =>
        speakSpeechText(synth, text, { voiceUri: null, rate: 1, volume: 1, muted: false }, {
          signal,
          createUtterance: (chunk) => ({ text: chunk, onend: null, onerror: null }),
        }),
    });

    await coordinator.startListening();
    await coordinator.stopListening();

    expect(coordinator.getState()).toBe("error");
    expect(coordinator.getSnapshot().error).toContain("500");
    // The 500 body must never be treated as a transcript.
    expect(calls.turn).toEqual([]);
    expect(coordinator.getSnapshot().lastUtterance).toBeNull();
    expect(spokenChunks).toEqual([]);
    coordinator.dispose();
  });
});
