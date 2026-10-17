import { describe, expect, it } from "vitest";
import { parseCodexTranscriptRecord } from "../../src/main/terminal/codex-transcript-parser";

const userRecord = (text: string) => ({ type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text }] } });

describe("codex transcript reader filtering", () => {
  it("drops ambient context and multi-agent notifications delivered as user records", () => {
    for (const text of [
      "# In app browser:\n- The user has the in-app browser open",
      "# Files mentioned by the user:\n\n## a.png",
      "<recommended_plugins>\nHere is a list",
      "<goal_context>\nContinue working",
      "<codex_internal_context source=\"goal\">x",
      "<in-app-browser-context source=\"ambient\">x",
      "<external_codex_apps_open_page>{}",
      "<subagent_notification>\n{\"agent_path\":\"0\"}",
      "<task-notification>\n<task-id>abc</task-id>",
    ]) expect(parseCodexTranscriptRecord(userRecord(text))).toBeNull();
  });

  it("keeps what the user typed and drops tool calls", () => {
    expect(parseCodexTranscriptRecord(userRecord("幫我修這個 bug"))?.text).toBe("幫我修這個 bug");
    expect(parseCodexTranscriptRecord({ type: "response_item", payload: { type: "function_call", name: "team_wait", arguments: "{}" } })).toBeNull();
    expect(parseCodexTranscriptRecord({ type: "response_item", payload: { type: "function_call_output", output: "worker done" } })).toBeNull();
  });
});
