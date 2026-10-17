// Phase 6 (§11.3): pure voice-agent state machine. No DOM, no timers, no
// audio — jsdom-free unit tests drive this reducer directly, and the
// coordinator in agent-coordinator.ts is a thin adapter around it.
//
// Required shape (work order §11.3):
//   idle → listening → transcribing → thinking → speaking
//   speaking + user speech → interrupted → listening
//
// Invariants baked into the reducer (not convention):
//   - barge-in only fires from `speaking` (or `thinking`, aborting an
//     in-flight supervisor turn before any speech started)
//   - every event carries a generation stamp; a stale event from an older
//     turn is ignored, which is how "old finals never replay" (§11.5
//     lock/reconnect) is enforced at the loop level
//   - `interrupted` never lingers: the only legal exit is `listening`
//     (fresh turn) or `idle` (explicit stop)

export type VoiceAgentUiState =
  | "idle"
  | "listening"
  | "transcribing"
  | "thinking"
  | "speaking"
  | "interrupted"
  | "reconnecting"
  | "error";

export type VoiceAgentEvent =
  | { type: "startListening"; generation: number }
  | { type: "micReady"; generation: number }
  | { type: "micFailed"; generation: number; error: string }
  | { type: "stopListening"; generation: number }
  | { type: "transcribed"; generation: number; text: string }
  | { type: "turnResolved"; generation: number }
  | { type: "speechFinished"; generation: number }
  | { type: "userSpeechDetected"; generation: number }
  | { type: "interrupted"; generation: number }
  | { type: "reconnecting"; generation: number }
  | { type: "reconnected"; generation: number }
  | { type: "stop"; generation: number };

export function reduceVoiceAgentState(
  state: VoiceAgentUiState,
  event: VoiceAgentEvent,
  currentGeneration: number,
): VoiceAgentUiState {
  // Stale-event guard: anything stamped with an older generation is the
  // late output §11.3/11.5 demands be discarded.
  if (event.generation !== currentGeneration) return state;
  switch (event.type) {
    case "startListening":
      return "listening";
    case "micReady":
      return state === "listening" ? "listening" : state;
    case "micFailed":
      // Capture, STT and turn failures all surface the same error state;
      // a failure while speaking is just the end of speech, not an error.
      return state === "listening" || state === "transcribing" || state === "thinking"
        ? "error"
        : state;
    case "stopListening":
      if (state === "listening") return "transcribing";
      if (state === "speaking" || state === "thinking" || state === "interrupted") return "idle";
      return state;
    case "transcribed":
      // Mic path arrives from `transcribing`; typed dry-run/playground turns
      // arrive from `idle` (no capture stage) and still need thinking →
      // speaking so text turns get the same TTS + barge-in treatment.
      return state === "transcribing" || state === "idle" ? "thinking" : state;
    case "turnResolved":
      return state === "thinking" ? "speaking" : state;
    case "speechFinished":
      // After a spoken answer the agent returns to idle (push-to-talk loop);
      // it only re-enters listening explicitly.
      return state === "speaking" ? "idle" : state;
    case "userSpeechDetected":
      // Barge-in: speaking (TTS playing) or thinking (answer pending) can be
      // cut short by the user starting to talk again.
      return state === "speaking" || state === "thinking" ? "interrupted" : state;
    case "interrupted":
      return "listening";
    case "reconnecting":
      return "reconnecting";
    case "reconnected":
      return state === "reconnecting" ? "idle" : state;
    case "stop":
      return "idle";
  }
}

/** The exact legal path set — pinned by tests against spec drift. */
export const VOICE_AGENT_REQUIRED_STATES: readonly VoiceAgentUiState[] = [
  "idle",
  "listening",
  "transcribing",
  "thinking",
  "speaking",
  "interrupted",
  "reconnecting",
];

/** Barge-in required side effects, in spec order (§11.3). */
export const BARGE_IN_STEPS = [
  "cancel-tts",
  "abort-or-bump-epoch",
  "drop-pending-sentences",
  "enter-fresh-turn",
] as const;
