import { afterEach, describe, expect, it, vi } from "vitest";
import { startWebServer, type RunningWebServer } from "../../src/main/web/web-server";
import { AgentApiConflictError, AgentApiNotFoundError, type AgentApiOrchestrator } from "../../src/main/core/agentapi-orchestrator";

const WORKFLOW_ID = "11111111-1111-4111-8111-111111111111";
const PROJECT_ID = "22222222-2222-4222-8222-222222222222";

describe("Agent API AgentApi workflow endpoints", () => {
  let server: RunningWebServer | undefined;

  afterEach(async () => {
    await server?.close();
    server = undefined;
  });

  async function start(overrides: Partial<Record<"create" | "get" | "resume" | "pause" | "cancel", (...args: never[]) => unknown>> = {}, enabled = true) {
    const workflow = {
      id: WORKFLOW_ID,
      projectId: PROJECT_ID,
      task: "implement FOO=private-value C:\\Private\\task.txt sk-abcdefghijklmnop",
      idempotencyKey: "workflow-key",
      branch: null,
      baseRef: null,
      implementer: "claude-local-main",
      reviewer: "codex-local-main",
      state: "queued",
      resumeState: null,
      reviewLoop: 0,
      worktreeId: null,
      worktreePath: "C:\\Private\\worktree",
      terminalId: null,
      sessionId: null,
      handoffId: null,
      lastOutcome: {
        code: "reviewed",
        reason: "See C:\\Private\\review.txt BAR=private-review",
        review: {
          verdict: "changes_requested",
          summary: "sk-abcdefghijklmnop C:\\Private\\summary.txt",
          findings: [{ severity: "major", file: "C:\\Private\\file.ts", message: "TOKEN=private-token" }],
          verification: ["C:\\Private\\verify.log"],
        },
      },
      revision: 0,
      createdAt: "2026-07-20T00:00:00.000Z",
      updatedAt: "2026-07-20T00:00:00.000Z",
      startedAt: null,
      completedAt: null,
    } as const;
    const agentapi = {
      create: vi.fn(async () => workflow),
      get: vi.fn(() => ({ workflow, steps: [] })),
      resume: vi.fn(async () => workflow),
      pause: vi.fn(async () => workflow),
      cancel: vi.fn(async () => ({ ...workflow, state: "canceled" as const })),
      shutdown: vi.fn(async () => undefined),
      ...overrides,
    } as unknown as Pick<AgentApiOrchestrator, "create" | "get" | "resume" | "pause" | "cancel" | "shutdown">;
    server = await startWebServer({
      port: 0,
      allowedOrigin: "https://coterm.example.com",
      verifyAccess: () => Promise.reject(new Error("agent path bypasses access")),
      getSettings: () => ({ agentApi: { enabled, token: "secret" } }) as never,
      operations: {},
      agentapi,
    });
    return { base: `http://127.0.0.1:${server.port}/api/v1/agent/workflow`, agentapi };
  }

  const init = (body: unknown = {}) => ({
    method: "POST",
    headers: { authorization: "Bearer secret", "content-type": "application/json" },
    body: JSON.stringify(body),
  });

  it("creates, reads, and cancels through the shared service", async () => {
    const { base, agentapi } = await start();
    const create = await fetch(base, init({ projectId: PROJECT_ID, task: "implement", idempotencyKey: "workflow-key" }));
    expect(create.status).toBe(202);
    expect((await create.json()).workflow.id).toBe(WORKFLOW_ID);

    const get = await fetch(`${base}/${WORKFLOW_ID}`, { headers: { authorization: "Bearer secret" } });
    expect(get.status).toBe(200);
    const payload = await get.json();
    expect(payload.steps).toEqual([]);
    expect(payload.workflow.id).toBe(WORKFLOW_ID);
    expect(payload.workflow.worktreePath).toBe("[PATH REDACTED]");
    const serialized = JSON.stringify(payload);
    expect(serialized).not.toContain("private-value");
    expect(serialized).not.toContain("Private\\");
    expect(serialized).not.toContain("sk-abcdefghijklmnop");
    expect(serialized).toContain("[REDACTED]");

    const cancel = await fetch(`${base}/${WORKFLOW_ID}/cancel`, init());
    expect(cancel.status).toBe(200);
    expect((await cancel.json()).workflow.state).toBe("canceled");
    expect(agentapi.cancel).toHaveBeenCalledWith(WORKFLOW_ID);
  });

  it("maps unresolved attention to 409 and missing workflow to 404", async () => {
    const { base } = await start({
      resume: vi.fn(async () => { throw new AgentApiConflictError("Agent attention remains unresolved."); }),
      get: vi.fn(() => { throw new AgentApiNotFoundError("AgentApi workflow not found."); }),
    });
    const resume = await fetch(`${base}/${WORKFLOW_ID}/resume`, init());
    expect(resume.status).toBe(409);
    const get = await fetch(`${base}/${WORKFLOW_ID}`, { headers: { authorization: "Bearer secret" } });
    expect(get.status).toBe(404);
  });
});
