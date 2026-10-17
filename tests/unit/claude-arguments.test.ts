import { describe, expect, it } from "vitest";
import { buildClaudeArguments } from "../../src/main/providers/claude-adapter";
import type { ProviderRunContext } from "../../src/main/providers/types";

describe("Claude CLI arguments", () => {
  it("does not persist or resume ephemeral runs", () => {
    const args = buildClaudeArguments(context({ ephemeral: true, nativeSessionId: "existing-session" }), "model", "new-session");

    expect(args).toContain("--no-session-persistence");
    expect(args).not.toContain("--resume");
    expect(args).not.toContain("--session-id");
  });

  it("preserves normal resume and new-session arguments", () => {
    expect(buildClaudeArguments(context({ nativeSessionId: "existing-session" }), undefined, "new-session"))
      .toEqual(expect.arrayContaining(["--resume", "existing-session"]));
    expect(buildClaudeArguments(context({ nativeSessionId: null }), undefined, "new-session"))
      .toEqual(expect.arrayContaining(["--session-id", "new-session"]));
  });

  it("passes the selected official Claude model alias", () => {
    const args = buildClaudeArguments(
      context({ profileId: "claude-official", claudeModel: "opus" }),
      "opus",
      "new-session",
    );

    expect(args).toEqual(expect.arrayContaining(["--model", "opus"]));
  });

  it("pre-approves only an explicitly approved native Workflow run", () => {
    const approved = buildClaudeArguments(
      context({ mode: "agent", nativeWorkflow: true }),
      "model",
      "new-session",
    );
    const ordinary = buildClaudeArguments(context({}), "model", "new-session");
    const advisory = buildClaudeArguments(context({ nativeWorkflow: true }), "model", "new-session");

    expect(approved).toEqual(expect.arrayContaining(["--allowedTools", "Workflow"]));
    expect(ordinary).not.toContain("--allowedTools");
    expect(advisory).not.toContain("--allowedTools");
  });
});

function context(overrides: Partial<ProviderRunContext>): ProviderRunContext {
  return {
    profileId: "claude-local-main", workspacePath: "D:\\workspace", prompt: "summary",
    nativeSessionId: null, attachmentPaths: [], mode: "advisory", permissionPreset: "ask",
    signal: new AbortController().signal, emit: () => Promise.resolve(), ...overrides,
  };
}
