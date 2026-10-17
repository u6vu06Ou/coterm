import type { TerminalTranscriptMessage } from "@shared/types";

// The reader has exactly one view: the reflowed conversation (agent
// summaries/answers + each user turn). The old 對話/原始輸出 toggle and the
// 僅結論 switch were removed (v1.5.65) — keepFinalTurnOutputs is applied
// unconditionally, so there is no view state left besides open + font size.
export interface ReaderState {
  open: boolean;
  fontSize: number;
}

const DEFAULT_FONT_SIZE = 16;

export const READER_FONT_MIN = 12;
export const READER_FONT_MAX = 32;

export function clampReaderFontSize(value: number): number {
  return Math.min(READER_FONT_MAX, Math.max(READER_FONT_MIN, Math.round(value)));
}

// A-/A+ walk this ladder (~12% per step) instead of +-1px: single pixels were
// barely visible per click.
const READER_FONT_LADDER = [12, 14, 16, 18, 20, 22, 25, 28, 32];

export function stepReaderFontSize(current: number, direction: 1 | -1): number {
  if (direction > 0) return READER_FONT_LADDER.find((size) => size > current) ?? READER_FONT_MAX;
  return [...READER_FONT_LADDER].reverse().find((size) => size < current) ?? READER_FONT_MIN;
}

// Phone pinch: font follows the finger spread from where the pinch started,
// and the text reflows at the new size (no page zoom).
export function pinchReaderFontSize(startFont: number, startDistance: number, distance: number): number {
  if (!(startDistance > 0) || !(distance > 0)) return clampReaderFontSize(startFont);
  return clampReaderFontSize(startFont * (distance / startDistance));
}

// Keep every user message, every system/notice message, and only one entry
// per consecutive assistant run. Codex marks the turn's final answer with
// kind "turn_summary" — prefer it and drop the run's commentary; without a
// summary (Claude), keep the last message of the run. An agent turn that
// emits three assistant chunks (reasoning → tool-call narration → final
// answer) collapses to just the final answer — the "conversation" reader is
// for reviewing what the agent concluded, not replaying its whole stream.
export function keepFinalTurnOutputs(messages: TerminalTranscriptMessage[]): TerminalTranscriptMessage[] {
  const out: TerminalTranscriptMessage[] = [];
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    if (!msg) continue;
    if (msg.role !== "assistant") {
      out.push(msg);
      continue;
    }
    let end = i;
    while (end + 1 < messages.length && messages[end + 1]?.role === "assistant") end++;
    let pick = messages[end]!;
    for (let j = end; j >= i; j--) {
      if (messages[j]?.kind === "turn_summary") { pick = messages[j]!; break; }
    }
    // Claude: background notifications and teammate messages are dropped as
    // injected user text, so several real turns can land in one assistant
    // run. Keep every reply that ended a turn, plus the run's last message
    // (a turn still in progress), instead of only the last one.
    if (pick.kind !== "turn_summary") {
      for (let j = i; j < end; j++) {
        if (messages[j]?.endsTurn) out.push(messages[j]!);
      }
    }
    out.push(pick);
    i = end;
  }
  return out;
}

// Label shown in front of each message in the conversation reader and used as
// the prefix when copying that message out of the reader. One rule for both
// places so copied text always matches what the UI shows. "turn_summary"
// wins over the role label (Codex marks the turn's final answer with it).
export function readerMessageLabel(message: TerminalTranscriptMessage): string {
  if (message.kind === "turn_summary") return "回合摘要";
  return message.role === "user" ? "你" : message.role === "system" ? "系統" : message.provider === "codex" ? "Codex" : "Agent";
}

// Copy-all payload: one "<label>:\n<text>" block per message, blank line
// between blocks, exactly what the conversation reader shows.
export function buildCopyAllText(messages: TerminalTranscriptMessage[]): string {
  return messages
    .map((message) => `${readerMessageLabel(message)}:\n${message.text}`)
    .join("\n\n");
}

class TerminalReaderController {
  private readonly state = new Map<string, ReaderState>();
  private readonly listeners = new Set<() => void>();
  private revision = 0;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getSnapshot = (): number => this.revision;

  get(terminalId: string): ReaderState {
    return this.state.get(terminalId) ?? { open: false, fontSize: DEFAULT_FONT_SIZE };
  }

  isOpenFor(terminalId: string): boolean { return this.get(terminalId).open; }

  toggle(terminalId: string): void { this.update(terminalId, { open: !this.get(terminalId).open }); }
  close(terminalId: string): void { this.update(terminalId, { open: false }); }
  adjustFont(terminalId: string, delta: number): void { this.update(terminalId, { fontSize: clampReaderFontSize(this.get(terminalId).fontSize + delta), open: true }); }
  stepFont(terminalId: string, direction: 1 | -1): void { this.update(terminalId, { fontSize: stepReaderFontSize(this.get(terminalId).fontSize, direction), open: true }); }
  setFont(terminalId: string, size: number): void {
    const fontSize = clampReaderFontSize(size);
    if (fontSize !== this.get(terminalId).fontSize) this.update(terminalId, { fontSize, open: true });
  }
  resetFont(terminalId: string): void { this.update(terminalId, { fontSize: DEFAULT_FONT_SIZE, open: true }); }

  resetForTest(): void { this.state.clear(); this.revision += 1; this.emit(); }

  private update(terminalId: string, patch: Partial<ReaderState>): void {
    this.state.set(terminalId, { ...this.get(terminalId), ...patch });
    this.emit();
  }

  private emit(): void { this.revision += 1; for (const listener of this.listeners) listener(); }
}

export const terminalReaderController = new TerminalReaderController();
