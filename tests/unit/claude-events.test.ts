import { describe, expect, it } from "vitest";
import { claudeQuestionResult, normalizeClaudeRecord } from "../../src/main/providers/claude-adapter";
import type { ProviderEvent, ProviderRunContext } from "../../src/main/providers/types";

describe("Claude event normalization", () => {
  it("maps structured answers back into AskUserQuestion input", () => {
    expect(claudeQuestionResult({ questions: [{ question: "Which approach?" }] }, {
      "Which approach?": ["Agent SDK"],
    })).toEqual({ questions: [{ question: "Which approach?" }], answers: {
      "Which approach?": "Agent SDK",
    } });
  });

  it("classifies an error result without emitting a duplicate provider event", async () => {
    const events: ProviderEvent[] = [];

    await expect(normalizeClaudeRecord(
      { type: "result", is_error: true, result: "HTTP 401 from provider" },
      fakeContext(events),
      new Map(),
    )).rejects.toMatchObject({ code: "auth_expired" });
    expect(events).toEqual([]);
  });

  it("emits one progress event for a complete assistant text block", async () => {
    const events: ProviderEvent[] = [];
    await normalizeClaudeRecord(
      { type: "assistant", message: { content: [{ type: "text", text: "正在檢查設定。" }] } },
      fakeContext(events),
      new Map(),
    );

    expect(events).toMatchObject([
      { type: "assistant.progress", payload: { text: "正在檢查設定。" } },
    ]);
  });

  it("maps Bash tool records to command lifecycle events", async () => {
    const events: ProviderEvent[] = [];
    const context = fakeContext(events);
    const tools = new Map<string, { name: string; input: Record<string, unknown> }>();

    await normalizeClaudeRecord(
      {
        type: "assistant",
        message: {
          content: [
            {
              type: "tool_use",
              id: "tool-1",
              name: "Bash",
              input: { command: "npm test" },
            },
          ],
        },
      },
      context,
      tools,
    );
    await normalizeClaudeRecord(
      {
        type: "user",
        message: {
          content: [{ type: "tool_result", tool_use_id: "tool-1", content: "passed" }],
        },
        tool_use_result: { stdout: "passed", stderr: "" },
      },
      context,
      tools,
    );

    expect(events.map((event) => event.type)).toEqual([
      "command.started",
      "command.output",
      "command.completed",
    ]);
    expect(events[1]?.payload?.output).toBe("passed");
  });

  it("maps file writes to completed and file-changed events", async () => {
    const events: ProviderEvent[] = [];
    const context = fakeContext(events);
    const tools = new Map<string, { name: string; input: Record<string, unknown> }>();

    await normalizeClaudeRecord(
      {
        type: "assistant",
        message: {
          content: [
            {
              type: "tool_use",
              id: "tool-2",
              name: "Write",
              input: { file_path: "D:\\workspace\\marker.txt" },
            },
          ],
        },
      },
      context,
      tools,
    );
    await normalizeClaudeRecord(
      {
        type: "user",
        message: {
          content: [{ type: "tool_result", tool_use_id: "tool-2", content: "created" }],
        },
        tool_use_result: { type: "create", filePath: "D:\\workspace\\marker.txt" },
      },
      context,
      tools,
    );

    expect(events.map((event) => event.type)).toEqual([
      "tool.started",
      "file.changed",
      "tool.completed",
    ]);
    expect(events[1]?.payload?.path).toBe("D:\\workspace\\marker.txt");
  });

  it("maps Claude workflow agents and completion usage", async () => {
    const events: ProviderEvent[] = [];
    const context = fakeContext(events);
    const tools = new Map<string, { name: string; input: Record<string, unknown> }>();

    await normalizeClaudeRecord({
      type: "system",
      subtype: "task_started",
      task_id: "task-1",
      description: "搜尋終端專案",
      subagent_type: "researcher",
    }, context, tools);
    await normalizeClaudeRecord({
      type: "system",
      subtype: "task_notification",
      task_id: "task-1",
      status: "completed",
      summary: "搜尋完成",
      usage: { total_tokens: 3210, tool_uses: 7, duration_ms: 42_000 },
    }, context, tools);

    expect(events).toMatchObject([
      { type: "agent.started", payload: { taskId: "task-1", status: "running" } },
      {
        type: "agent.completed",
        payload: { taskId: "task-1", totalTokens: 3210, toolUses: 7, durationMs: 42_000 },
      },
    ]);
  });

  it("maps native workflow progress into the existing agent ledger", async () => {
    const events: ProviderEvent[] = [];
    await normalizeClaudeRecord({
      type: "system",
      subtype: "task_progress",
      task_id: "workflow-1",
      workflow_progress: [{
        type: "workflow_phase",
        index: 1,
        title: "Research",
      }, {
        type: "workflow_agent",
        index: 1,
        phaseTitle: "Research",
        label: "Find evidence",
        state: "start",
      }, {
        type: "workflow_agent",
        agentId: "agent-1",
        phaseTitle: "Research",
        label: "Find evidence",
        state: "done",
        tokens: 123,
        toolCalls: 4,
        durationMs: 2_500,
      }],
    }, fakeContext(events), new Map());

    expect(events).toMatchObject([{
      type: "agent.completed",
      summary: "Research: Find evidence",
      payload: {
        taskId: "agent-1",
        status: "completed",
        totalTokens: 123,
        toolUses: 4,
        durationMs: 2_500,
      },
    }]);
  });
});

function fakeContext(events: ProviderEvent[]): ProviderRunContext {
  return {
    profileId: "claude-official",
    workspacePath: "D:\\workspace",
    prompt: "",
    nativeSessionId: null,
    attachmentPaths: [],
    mode: "agent",
    permissionPreset: "ask",
    signal: new AbortController().signal,
    emit: (event) => {
      events.push(event);
      return Promise.resolve();
    },
  };
}
