import { describe, expect, it, vi } from "vitest";
import { ApprovalBroker } from "../../src/main/core/approval-broker";
import {
  buildCodexAppServerArguments,
  codexAppServerEnvironment,
  codexCompactionEvent,
  codexUserInputResponse,
  codexRuntimePolicy,
  isLoopbackProxyUrl,
  CodexAppServer,
} from "../../src/main/providers/codex-app-server";

describe("Codex app-server profiles", () => {
  it("launches a native official team profile without proxy overrides", () => {
    const profiles = { "codex-team": { configProfile: "codex-team", label: "Codex Team", model: "ignored", env: {} } };
    expect(buildCodexAppServerArguments("codex-team", "http://127.0.0.1:8787", profiles, () => ({model_provider: "openai", agents: {enabled: true}})))
      .toEqual(["app-server", "--listen", "stdio://", "-c", '"model_provider"="openai"', "-c", '"agents"."enabled"=true']);
    const env = codexAppServerEnvironment("codex-team", { CODEX_HOME: "free-home", PATH: "bin" }, profiles);
    expect(env.CODEX_HOME).toMatch(/\.codex$/);
    expect(env).not.toHaveProperty("TEAM_API_KEY");
  });
  it("maps structured answers to the requestUserInput protocol", () => {
    expect(codexUserInputResponse({ approach: ["Agent SDK"] })).toEqual({
      answers: { approach: { answers: ["Agent SDK"] } },
    });
  });

  it("keeps official, GLM, and Qwen app servers isolated", () => {
    const approvals = new ApprovalBroker();
    const official = new CodexAppServer(approvals);
    const glm = new CodexAppServer(approvals, "codex-local-main", () => "http://127.0.0.1:8787");
    const qwen = new CodexAppServer(approvals, "codex-local-long", () => "http://127.0.0.1:8787");

    expect(official.profiles).toEqual(["codex-official"]);
    expect(glm.profiles).toEqual(["codex-local-main"]);
    expect(qwen.profiles).toEqual(["codex-local-long"]);
    expect(buildCodexAppServerArguments("codex-official", "http://127.0.0.1:8787"))
      .toEqual(["app-server", "--listen", "stdio://"]);
    expect(buildCodexAppServerArguments("codex-local-main", "http://127.0.0.1:8787"))
      .toEqual([
        "app-server", "--listen", "stdio://",
        "-c", 'model_provider="glm"',
        "-c", 'model="my-glm-flash"',
        "-c", "model_context_window=170000",
        "-c", "model_max_output_tokens=32768",
        "-c", "model_auto_compact_token_limit=150000",
        "-c", 'model_auto_compact_token_limit_scope="total"',
        "-c", 'model_reasoning_effort="high"',
        "-c", 'model_providers.glm.name="GLM Local Flash"',
        "-c", 'model_providers.glm.base_url="http://127.0.0.1:8787/v1"',
        "-c", 'model_providers.glm.env_key="GLM_API_KEY"',
        "-c", 'model_providers.glm.wire_api="responses"',
      ]);
    expect(buildCodexAppServerArguments("codex-local-long", "http://127.0.0.1:8787"))
      .toEqual([
        "app-server", "--listen", "stdio://",
        "-c", 'model_provider="qwen"',
        "-c", 'model="upstream-my-qwen-old-freeform"',
        "-c", "model_context_window=262144",
        "-c", "model_max_output_tokens=32768",
        "-c", 'model_providers.qwen.name="Qwen 3.6"',
        "-c", 'model_providers.qwen.base_url="http://127.0.0.1:8787/v1"',
        "-c", 'model_providers.qwen.env_key="CODEX_QWEN_API_KEY"',
        "-c", 'model_providers.qwen.wire_api="responses"',
      ]);
  });

  it("preserves official authentication env but isolates local credentials", () => {
    const source = { PATH: "bin", OPENAI_API_KEY: "official-secret", OTHER_TOKEN: "drop-me" };

    expect(codexAppServerEnvironment("codex-official", source)).toEqual(source);
    expect(codexAppServerEnvironment("codex-local-main", source)).toEqual({
      PATH: "bin",
      GLM_API_KEY: "coterm-local-dev",
    });
    expect(codexAppServerEnvironment("codex-local-long", source)).toEqual({
      PATH: "bin",
      CODEX_QWEN_API_KEY: "coterm-local-dev",
    });
  });

  it("normalizes Codex compaction notifications into session status payloads", () => {
    expect(codexCompactionEvent(
      "codex-local-main",
      "thread-123",
      { reason: "context_limit", tokenUsageBefore: { input: 10 }, tokenUsageAfter: { input: 2 } },
      "2026-06-23T05:00:00.000Z",
    )).toEqual({
      type: "warning",
      summary: "Codex compacted the context window.",
      payload: {
        provider: "codex-local-main",
        nativeSessionId: "thread-123",
        compactedAt: "2026-06-23T05:00:00.000Z",
        reason: "context_limit",
        tokenUsageBefore: { input: 10 },
        tokenUsageAfter: { input: 2 },
        summaryAvailable: false,
      },
    });
  });

  it("forces AgentApi reviewer read-only/never and validates loopback proxy", async () => {
    expect(codexRuntimePolicy("ask", { forceReadOnly: true })).toEqual({
      approvalPolicy: "never",
      sandbox: "read-only",
    });
    expect(isLoopbackProxyUrl("http://127.0.0.1:8787")).toBe(true);
    expect(isLoopbackProxyUrl("http://localhost:8787")).toBe(true);
    expect(isLoopbackProxyUrl("https://paid.example.com")).toBe(false);

    const server = new CodexAppServer(
      new ApprovalBroker(),
      "codex-local-main",
      () => "https://paid.example.com",
      { forceReadOnly: true, denyApprovalRequests: true, requireLoopbackProxy: true },
    );
    await expect(server.run({
      profileId: "codex-local-main",
      workspacePath: process.cwd(),
      prompt: "review",
      nativeSessionId: null,
      attachmentPaths: [],
      mode: "advisory",
      permissionPreset: "trusted",
      signal: new AbortController().signal,
      emit: async () => undefined,
    })).rejects.toThrow("loopback proxy");
  });

  it("fails a non-interactive reviewer closed instead of waiting for user input", async () => {
    const server = new CodexAppServer(
      new ApprovalBroker(),
      "codex-local-main",
      () => "http://127.0.0.1:8787",
      { forceReadOnly: true, denyApprovalRequests: true, requireLoopbackProxy: true },
    );
    const internal = server as unknown as {
      handleServerRequest(message: { id: number; method: string; params: Record<string, unknown> }): Promise<void>;
      waitForTurn(threadId: string, turnId: string, signal: AbortSignal): Promise<void>;
      turnWaiters: Map<string, (error: Error) => void>;
      respond(id: number, result: unknown): void;
      request(method: string, params: Record<string, unknown>): Promise<unknown>;
    };
    const rejectTurn = vi.fn();
    const otherTurn = vi.fn();
    const respond = vi.fn();
    internal.turnWaiters.set("thread-1:turn-1", rejectTurn);
    internal.turnWaiters.set("thread-2:turn-2", otherTurn);
    internal.respond = respond;

    await internal.handleServerRequest({
      id: 7,
      method: "item/tool/requestUserInput",
      params: { threadId: "thread-1", turnId: "turn-1" },
    });

    expect(respond).toHaveBeenCalledWith(7, { answers: {} });
    expect(rejectTurn).toHaveBeenCalledWith(expect.objectContaining({
      code: "protocol",
      message: "Codex reviewer requested user input.",
    }));
    expect(otherTurn).not.toHaveBeenCalled();
    expect([...internal.turnWaiters.keys()]).toEqual(["thread-2:turn-2"]);

    const aborted = new AbortController();
    aborted.abort();
    internal.request = vi.fn(() => Promise.resolve({}));
    await expect(internal.waitForTurn("thread-3", "turn-3", aborted.signal))
      .rejects.toMatchObject({ code: "cancelled" });
  });
});
