import { describe, expect, it } from "vitest";
import { parseClaudeTranscriptRecord } from "../../src/main/terminal/claude-transcript-parser";

const user = (content: string) => ({ type: "user", message: { role: "user", content } });

describe("claude transcript reader filtering", () => {
  it("drops agent-team reports wrapped with the cross-session lead-in", () => {
    expect(parseClaudeTranscriptRecord(user("Another Claude session sent a message:\n<teammate-message teammate_id=\"x\">done</teammate-message>"))).toBeNull();
    expect(parseClaudeTranscriptRecord(user("<teammate-message teammate_id=\"x\">done</teammate-message>"))).toBeNull();
  });

  it("drops subagent sidechains (the lead's task prompt to a teammate)", () => {
    expect(parseClaudeTranscriptRecord({ ...user("You work in the repo..."), isSidechain: true, agentId: "a1" })).toBeNull();
  });

  it("drops tool calls and keeps what the user typed", () => {
    expect(parseClaudeTranscriptRecord({ type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", name: "Agent", input: { prompt: "do x" } }] } })).toBeNull();
    expect(parseClaudeTranscriptRecord(user("幫我改手機版"))?.text).toBe("幫我改手機版");
    expect(parseClaudeTranscriptRecord({ type: "assistant", message: { role: "assistant", stop_reason: "end_turn", content: [{ type: "text", text: "done" }] } })?.endsTurn).toBe(true);
    expect(parseClaudeTranscriptRecord({ type: "assistant", message: { role: "assistant", stop_reason: "tool_use", content: [{ type: "text", text: "wip" }] } })?.endsTurn).toBeUndefined();
  });
});
