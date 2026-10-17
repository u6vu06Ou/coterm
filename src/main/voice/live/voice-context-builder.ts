import type { VoiceContextSnapshot } from "@shared/types";
import type { VoiceSessionRepository } from "./voice-session-repository";

const DEFAULT_RECENT_TURNS = 16;
const MAX_SUMMARY_CHARS = 8_000;
const MAX_TURN_CHARS = 2_000;

/** Builds bounded prompt context; it never returns the complete transcript. */
export class VoiceContextBuilder {
  constructor(
    private readonly repository: VoiceSessionRepository,
    private readonly recentTurnLimit = DEFAULT_RECENT_TURNS,
  ) {}

  build(voiceSessionId: string): VoiceContextSnapshot {
    const session = this.repository.require(voiceSessionId);
    const recentTurns = this.repository.listRecentTurns(voiceSessionId, this.recentTurnLimit)
      .map((turn) => ({ ...turn, text: turn.text.slice(0, MAX_TURN_CHARS) }));
    return {
      voiceSessionId,
      rollingSummary: session.rollingSummary.slice(0, MAX_SUMMARY_CHARS),
      recentTurns,
      currentTopic: session.currentTopic,
      activeTerminalId: session.activeTerminalId,
    };
  }
}
