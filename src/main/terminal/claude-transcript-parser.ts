import type { TerminalTranscriptMessage } from "@shared/types";

export function parseClaudeTranscriptRecord(record: unknown, index = 0): TerminalTranscriptMessage | null {
  if (!record || typeof record !== "object") return null;
  const value = record as Record<string, unknown>;
  // Structural noise markers (verified against real ~/.claude/projects
  // transcripts): subagent sidechains are isSidechain:true / separate
  // subagents/*.jsonl files; tool-result echo and other meta records carry
  // isMeta:true or toolUseResult. None of them is human-typed text or a
  // main-agent reply, so drop them before looking at content.
  if (value.isSidechain === true || value.isMeta === true) return null;
  if (typeof value.agentId === "string" && value.agentId) return null;
  if (value.toolUseResult != null) return null;
  const message = value.message;
  if (!message || typeof message !== "object") return null;
  const body = message as Record<string, unknown>;
  if (body.role !== "user" && body.role !== "assistant") return null;
  const text = extractText(body.content);
  if (!text || (body.role === "user" && isCliInjectedUserText(text))) return null;
  return {
    id: `claude-${index}`,
    role: body.role,
    kind: "message",
    text,
    timestamp: typeof value.timestamp === "string" ? value.timestamp : null,
    provider: "claude",
    model: typeof value.model === "string" ? value.model : null,
    ...(body.role === "assistant" && body.stop_reason === "end_turn" ? { endsTurn: true } : {}),
  };
}

function extractText(content: unknown): string {
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";
  return content.flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const block = item as Record<string, unknown>;
    return block.type === "text" && typeof block.text === "string" ? [block.text] : [];
  }).join("\n").trim();
}

// The Claude CLI injects several pseudo-user records into the transcript that
// are not the user's instructions (tool stdout, command metadata, caveat
// banners, and — in multi-agent sessions — task notifications, teammate and
// cross-session messages delivered as unflagged user-role text). The
// conversation reader is for reviewing what the user typed and what the
// agent concluded — drop these so they don't pollute the user side.
const CLI_INJECTED_USER_PREFIXES = [
  "<system-reminder>",
  "<local-command-stdout>",
  "<command-name>",
  "<command-message>",
  "<command-args>",
  "<bash-input>",
  "<bash-stdout>",
  "<task-notification",
  "<teammate-message",
  "<cross-session-message",
  // Agent-team reports arrive wrapped with this lead-in line before the
  // <teammate-message> tag (seen 2026-10-09), so the tag prefix alone misses them.
  "Another Claude session sent a message:",
  "Caveat:",
  // Compact/resume continuations are injected into the transcript as user
  // text; the dip continues the conversation, it is not what the user typed.
  "This session is being continued from a previous conversation",
];

function isCliInjectedUserText(text: string): boolean {
  const trimmed = text.trimStart();
  return CLI_INJECTED_USER_PREFIXES.some((prefix) => trimmed.startsWith(prefix));
}
