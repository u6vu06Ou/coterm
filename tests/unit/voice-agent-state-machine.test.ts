// Phase 6 (work order §11.3): the pure voice-agent FSM is pinned against
// the spec'd path set, the barge-in transition, and stale-generation
// rejection (the mechanism that makes late output impossible to deliver).
import { describe, expect, it } from "vitest";
import {
  BARGE_IN_STEPS,
  reduceVoiceAgentState,
  VOICE_AGENT_REQUIRED_STATES,
  type VoiceAgentUiState,
} from "../../src/renderer/src/voice-agent/agent-state-machine";

function step(state: VoiceAgentUiState, type: string, generation = 1): VoiceAgentUiState {
  return reduceVoiceAgentState(state, { type, generation } as never, generation);
}

describe("voice agent state machine (§11.3)", () => {
  it("declares exactly the required state set", () => {
    expect([...VOICE_AGENT_REQUIRED_STATES]).toEqual([
      "idle",
      "listening",
      "transcribing",
      "thinking",
      "speaking",
      "interrupted",
      "reconnecting",
    ]);
  });

  it("walks the required push-to-talk path", () => {
    expect(step("idle", "startListening")).toBe("listening");
    expect(step("listening", "stopListening")).toBe("transcribing");
    expect(step("transcribing", "transcribed")).toBe("thinking");
    expect(step("thinking", "turnResolved")).toBe("speaking");
    expect(step("speaking", "speechFinished")).toBe("idle");
  });

  it("typed turns enter the loop from idle (no capture stage)", () => {
    expect(step("idle", "transcribed")).toBe("thinking");
  });

  it("barge-in fires from speaking and from thinking only", () => {
    expect(step("speaking", "userSpeechDetected")).toBe("interrupted");
    expect(step("thinking", "userSpeechDetected")).toBe("interrupted");
    expect(step("listening", "userSpeechDetected")).toBe("listening");
    expect(step("idle", "userSpeechDetected")).toBe("idle");
  });

  it("interrupted never lingers: only listening (fresh turn) or idle (stop)", () => {
    expect(step("interrupted", "interrupted")).toBe("listening");
    expect(step("interrupted", "stop")).toBe("idle");
    expect(step("interrupted", "speechFinished")).toBe("interrupted");
    expect(step("interrupted", "turnResolved")).toBe("interrupted");
  });

  it("exposes reconnecting as a first-class persistent-call state", () => {
    expect(step("listening", "reconnecting")).toBe("reconnecting");
    expect(step("speaking", "reconnecting")).toBe("reconnecting");
    expect(step("reconnecting", "reconnected")).toBe("idle");
  });

  it("stopListening during speaking/thinking/interrupted goes idle", () => {
    expect(step("speaking", "stopListening")).toBe("idle");
    expect(step("thinking", "stopListening")).toBe("idle");
    expect(step("interrupted", "stopListening")).toBe("idle");
  });

  it("rejects stale-generation events at every transition", () => {
    // Generation 2 is current; anything stamped 1 is late output.
    const stale = (state: VoiceAgentUiState, type: string): VoiceAgentUiState =>
      reduceVoiceAgentState(state, { type, generation: 1 } as never, 2);
    expect(stale("idle", "startListening")).toBe("idle");
    expect(stale("listening", "stopListening")).toBe("listening");
    expect(stale("transcribing", "transcribed")).toBe("transcribing");
    expect(stale("thinking", "turnResolved")).toBe("thinking");
    expect(stale("speaking", "speechFinished")).toBe("speaking");
    expect(stale("speaking", "userSpeechDetected")).toBe("speaking");
  });

  it("mic/STT/turn failures surface error from listening/transcribing/thinking", () => {
    expect(
      reduceVoiceAgentState("listening", { type: "micFailed", generation: 1, error: "x" }, 1),
    ).toBe("error");
    expect(
      reduceVoiceAgentState("transcribing", { type: "micFailed", generation: 1, error: "x" }, 1),
    ).toBe("error");
    expect(
      reduceVoiceAgentState("thinking", { type: "micFailed", generation: 1, error: "x" }, 1),
    ).toBe("error");
    expect(
      reduceVoiceAgentState("speaking", { type: "micFailed", generation: 1, error: "x" }, 1),
    ).toBe("speaking");
    expect(
      reduceVoiceAgentState("idle", { type: "micFailed", generation: 1, error: "x" }, 1),
    ).toBe("idle");
  });

  it("pins the spec'd barge-in side-effect order", () => {
    expect([...BARGE_IN_STEPS]).toEqual([
      "cancel-tts",
      "abort-or-bump-epoch",
      "drop-pending-sentences",
      "enter-fresh-turn",
    ]);
  });
});
