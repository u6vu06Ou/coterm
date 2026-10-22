import type { TerminalTranscriptMessage } from "@shared/types";

// Structural equality over every field the reader renders, keys, or filters on
// (keepFinalTurnOutputs reads role/kind/endsTurn; the row renders text/kind/
// role/provider; React keys use id/timestamp).
export function transcriptMessageEqual(a: TerminalTranscriptMessage, b: TerminalTranscriptMessage): boolean {
  return (
    a.id === b.id &&
    a.role === b.role &&
    a.kind === b.kind &&
    a.text === b.text &&
    a.timestamp === b.timestamp &&
    a.provider === b.provider &&
    a.model === b.model &&
    a.endsTurn === b.endsTurn
  );
}

// Reconciles a freshly fetched transcript with the one already on screen.
// - Identical list -> returns `previous` itself: the useState write bails out,
//   so a poll that changed nothing re-renders nothing (no markdown/highlight
//   re-run, no scroll jump).
// - Changed list -> returns a new array in which every message that still
//   matches keeps its OLD object reference. Unchanged rows then skip React.memo,
//   so appended messages mount while existing DOM nodes (and their syntax
//   highlighting) stay untouched — no flash.
// Matching is by message id first (service responses always set it), falling
// back to positional equality for id-less backwards-compatible fixtures.
export function mergeTranscriptMessages(
  previous: TerminalTranscriptMessage[],
  next: TerminalTranscriptMessage[],
): TerminalTranscriptMessage[] {
  const byId = new Map<string, TerminalTranscriptMessage>();
  for (const message of previous) {
    if (message.id !== undefined) byId.set(message.id, message);
  }
  let identical = previous.length === next.length;
  const merged = next.map((message, index) => {
    const candidate =
      (message.id !== undefined ? byId.get(message.id) : undefined) ??
      (index < previous.length ? previous[index] : undefined);
    if (candidate !== undefined && transcriptMessageEqual(candidate, message)) {
      if (candidate !== previous[index]) identical = false;
      return candidate;
    }
    identical = false;
    return message;
  });
  return identical ? previous : merged;
}
