import type { TerminalTranscriptMessage } from "@shared/types";

// Real rollout shapes (verified against ~/.codex/sessions):
//   {"timestamp","type":"response_item","payload":{"type":"message","role","content","phase"}}
//   {"timestamp","type":"event_msg","payload":{"type":"user_message","message",...}}
//   {"timestamp","type":"event_msg","payload":{"type":"agent_message","message","phase",...}}
// Codex writes every conversation record twice — once as an event_msg and once
// as a response_item message. Both are parsed here; the adjacent duplicate is
// collapsed by TerminalTranscriptService.
export function parseCodexTranscriptRecord(record: unknown, index = 0): TerminalTranscriptMessage | null {
  if (!record || typeof record !== "object") return null;
  const value = record as Record<string, unknown>;
  const payload = value.payload;
  if (!payload || typeof payload !== "object") return null;
  const body = payload as Record<string, unknown>;
  const topType = typeof value.type === "string" ? value.type : "";
  let role: "user" | "assistant" | null = null;
  let content: unknown;
  let phase: unknown;
  if (topType === "response_item" && body.type === "message") {
    // role "developer" is Codex's system-prompt injection channel (e.g.
    // <permissions instructions>) — never user-typed text, so drop it.
    if (body.role !== "user" && body.role !== "assistant") return null;
    role = body.role;
    content = body.content;
    phase = body.phase;
  } else if (body.type === "user_message" || body.type === "agent_message") {
    role = body.type === "user_message" ? "user" : "assistant";
    content = body.message ?? body.text;
    phase = body.phase;
  }
  if (!role) return null;
  const text = extractText(content);
  if (!text || (role === "user" && isInjectedUserText(text))) return null;
  return {
    id: `codex-${index}`,
    role,
    kind: phase === "final_answer" ? "turn_summary" : "message",
    text,
    timestamp: typeof value.timestamp === "string" ? value.timestamp : null,
    provider: "codex",
    model: typeof body.model === "string" ? body.model : null,
  };
}

function extractText(content: unknown): string {
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";
  return content.flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const block = item as Record<string, unknown>;
    return block.type === "output_text" || block.type === "input_text" || block.type === "text"
      ? (typeof block.text === "string" ? [block.text] : [])
      : [];
  }).join("\n").trim();
}

// Codex seeds rollouts with pseudo-user records that are not the user's
// instructions (AGENTS.md / environment context blobs, abort markers) — same
// spirit as Claude's CLI_INJECTED_USER_PREFIXES.
const INJECTED_USER_PREFIXES = [
  "<system-reminder>",
  "# AGENTS.md instructions",
  "<environment_context>",
  "<turn_aborted>",
  // Ambient/system context Codex delivers as user-role records (verified in
  // real rollouts 2026-10-09): browser/app context, plugin lists, goal
  // continuations, attachment manifests, and subagent / task notifications
  // from multi-agent runs. None of it is what the user typed.
  "# In app browser:",
  "# Files mentioned by the user:",
  "<recommended_plugins>",
  "<goal_context>",
  "<codex_internal_context",
  "<in-app-browser-context",
  "<external_codex_apps_open_page>",
  "<subagent_notification>",
  "<task-notification",
  "<teammate-message",
  "<cross-session-message",
];

function isInjectedUserText(text: string): boolean {
  const trimmed = text.trimStart();
  return INJECTED_USER_PREFIXES.some((prefix) => trimmed.startsWith(prefix));
}
