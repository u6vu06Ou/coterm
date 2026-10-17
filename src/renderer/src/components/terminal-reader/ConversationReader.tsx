import { useCallback, useEffect, useRef, useState } from "react";
import { Check as CheckIcon, Copy as CopyIcon } from "lucide-react";
import type { TerminalTranscriptMessage } from "@shared/types";
import { MarkdownContent } from "../MarkdownContent";
import { readerMessageLabel } from "./terminal-reader-state";
import { copyTextToClipboard } from "./clipboard";

export function ConversationReader({ messages, emptyLabel, highlightLastAssistant = false }: { messages: TerminalTranscriptMessage[]; emptyLabel: string; highlightLastAssistant?: boolean }): React.JSX.Element {
  // Copy feedback per message ("已複製" check / "複製失敗") — one flash, 1.5s.
  const [copyFeedback, setCopyFeedback] = useState<{ key: string; kind: "ok" | "error" } | null>(null);
  const copyFeedbackTimerRef = useRef<number | null>(null);
  useEffect(() => () => {
    if (copyFeedbackTimerRef.current !== null) window.clearTimeout(copyFeedbackTimerRef.current);
  }, []);

  const copyMessage = useCallback((message: TerminalTranscriptMessage, key: string): void => {
    // Copies the message's original markdown source (message.text).
    void copyTextToClipboard(message.text).then((ok) => {
      setCopyFeedback(ok ? { key, kind: "ok" } : { key, kind: "error" });
      if (copyFeedbackTimerRef.current !== null) window.clearTimeout(copyFeedbackTimerRef.current);
      copyFeedbackTimerRef.current = window.setTimeout(() => setCopyFeedback(null), 1500);
    });
  }, []);

  if (messages.length === 0) return <p className="terminal-reader-empty">{emptyLabel}</p>;
  // Newest assistant message index — jump target for the done-flash highlight.
  let lastAssistantIndex = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]!.role === "assistant") {
      lastAssistantIndex = i;
      break;
    }
  }
  return (
    <div className="terminal-reader-conversation">
      {messages.map((message, index) => {
        const messageKey = message.id ?? `${message.timestamp ?? "message"}-${index}`;
        const label = readerMessageLabel(message);
        const isSummary = message.kind === "turn_summary";
        const feedback = copyFeedback !== null && copyFeedback.key === messageKey ? copyFeedback : null;
        // User messages anchor the turn rail's quick-jump ticks.
        const isNewestAssistant = highlightLastAssistant && index === lastAssistantIndex && message.role === "assistant";
        return (
          <article
            key={messageKey}
            data-message-index={index}
            data-turn-anchor={message.role === "user" ? index : undefined}
            className={`terminal-reader-message terminal-reader-${message.role} ${isSummary ? "terminal-reader-summary" : ""} ${isNewestAssistant ? "terminal-reader-message-new" : ""}`}
          >
            <div className="terminal-reader-message-label">
              <span>{label}</span>
              <button
                type="button"
                data-action-id="terminal.reader.copy-message"
                className="terminal-reader-copy-message"
                aria-label={feedback ? (feedback.kind === "ok" ? "已複製" : "複製失敗") : "複製這段"}
                title="複製這段"
                onPointerDown={(event) => event.stopPropagation()}
                onClick={() => copyMessage(message, messageKey)}
              >
                {feedback ? (feedback.kind === "ok" ? <CheckIcon size={14} aria-hidden /> : <span className="terminal-reader-copy-message-failed">複製失敗</span>) : <CopyIcon size={14} aria-hidden />}
              </button>
            </div>
            {message.role === "assistant" ? <MarkdownContent className="terminal-reader-message-text final-answer" markdown={message.text} /> : <p className="terminal-reader-message-text">{message.text}</p>}
          </article>
        );
      })}
    </div>
  );
}
