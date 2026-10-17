import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startWebServer, type RunningWebServer } from "../../src/main/web/web-server";
import { TerminalHandoffError, TerminalHandoffService, type TerminalHandoffResult } from "../../src/main/core/terminal-handoff-service";
import { AppDatabase } from "../../src/main/storage/database";
import { Repository } from "../../src/main/storage/repository";
import type { ProviderAdapter } from "../../src/main/providers/types";
import type { TerminalInfo } from "../../src/shared/types";

const TID = "11111111-1111-4111-8111-111111111111";
const packetResult: TerminalHandoffResult = {
  packet: {
    version: 1,
    sourceSessionId: "ref-abc",
    sourceProfile: "claude-local-main",
    targetProfile: "codex-local-main",
    projectId: "project-abc",
    worktree: { dirty: false },
    brief: "handoff ready",
    completed: [],
    changedFiles: [],
    verification: [],
    pending: [],
    nextAction: "review",
    risks: [],
    state: { canonical: "done", authoritativeSource: "process", matchedRuleId: null },
    lastCommand: null,
    source: "native-transcript",
    partial: false,
    createdAt: "2026-07-20T00:00:00.000Z",
  },
  formattedPrompt: "<UNTRUSTED_TERMINAL_HISTORY />",
  provenance: {
    source: "native-transcript",
    summarizerProfile: "claude-local-main",
    inputBytes: 100,
    packetBytes: 200,
    tokenEstimate: 60,
    ledgerId: "ledger-1",
    createdAt: "2026-07-20T00:00:00.000Z",
    reused: false,
  },
};

describe("Agent API terminal handoff endpoint", () => {
  let server: RunningWebServer | undefined;
  afterEach(async () => {
    await server?.close();
    server = undefined;
  });

  async function start(create?: (id: string, input: never, signal?: AbortSignal) => Promise<TerminalHandoffResult>, enabled = true) {
    const writeTerminal = vi.fn();
    const resolveAttention = vi.fn();
    server = await startWebServer({
      port: 0,
      allowedOrigin: "https://coterm.example.com",
      verifyAccess: () => Promise.reject(new Error("agent path bypasses access")),
      getSettings: () => ({ agentApi: { enabled, token: "secret" } }) as never,
      operations: { writeTerminal, resolveAttention },
      ...(create ? { handoffService: { create } } : {}),
    });
    return {
      url: `http://127.0.0.1:${server.port}/api/v1/agent/session/${TID}/handoff-packet`,
      writeTerminal,
      resolveAttention,
    };
  }

  const init = (body: unknown, signal?: AbortSignal) => ({
    method: "POST",
    headers: { authorization: "Bearer secret", "content-type": "application/json" },
    body: JSON.stringify(body),
    ...(signal ? { signal } : {}),
  });

  it("returns structured packet and never writes PTY or acknowledges attention", async () => {
    const create = vi.fn(async () => packetResult);
    const { url, writeTerminal, resolveAttention } = await start(create);
    const response = await fetch(url, init({ targetProfile: "codex-local-main", objective: "review", idempotencyKey: "step" }));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toMatchObject({ ok: true, packet: { version: 1 }, formattedPrompt: packetResult.formattedPrompt });
    expect(create).toHaveBeenCalledOnce();
    expect(writeTerminal).not.toHaveBeenCalled();
    expect(resolveAttention).not.toHaveBeenCalled();
  });

  it("returns 200 when provider output contains a Windows absolute path or ordinary env assignment", async () => {
    const directory = await mkdtemp(join(tmpdir(), "coterm-handoff-api-"));
    const database = new AppDatabase(join(directory, "state.sqlite"));
    await database.open();
    try {
      const repository = new Repository(database);
      const terminal: TerminalInfo = {
        id: TID, projectId: "22222222-2222-4222-8222-222222222222", profile: "pwsh", title: "Agent", cwd: directory,
        cols: 100, rows: 28, status: "running", startedAt: "2026-07-20T00:00:00.000Z", closedAt: null,
        lastExitCode: null, isAgent: true, agentProfile: "claude-local-main", ownedByAgentApi: false, pid: 1,
        nativeSessionId: null, worktreeId: null, contextUsage: null,
      };
      const adapter: ProviderAdapter = {
        profiles: ["claude-local-main", "claude-local-long"],
        run: async (context) => ({
          nativeSessionId: null,
          finalText: context.prompt.includes("FINAL_JSON")
            ? JSON.stringify({ brief: "C:\\Private\\secret.txt FOO=ordinary-private-value", completed: [], changedFiles: [], verification: [], pending: [], nextAction: "review", risks: [] })
            : "fragment",
        }),
      };
      const service = new TerminalHandoffService(repository, [adapter], {
        getTerminal: () => terminal,
        getTranscript: async () => ({ messages: [{ role: "assistant", text: "done", timestamp: "2026-07-20T00:00:00.000Z" }] }),
        getScrollback: () => "",
        getScrollbackMode: () => "normal",
        getScreenText: () => null,
        getState: () => "done",
        getStateExplanation: () => null,
        getLastCommand: () => null,
      }, { summaryWorkspacePath: tmpdir() });
      const { url } = await start(service.create.bind(service));
      const response = await fetch(url, init({ targetProfile: "codex-local-main", objective: "review", idempotencyKey: "path-regression" }));
      const body = await response.json();
      expect(response.status).toBe(200);
      expect(JSON.stringify(body)).not.toContain("Private\\secret.txt");
      expect(JSON.stringify(body)).not.toContain("ordinary-private-value");
    } finally {
      database.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("requires a strict request body and bearer token", async () => {
    const { url } = await start(async () => packetResult);
    const extra = await fetch(url, init({ targetProfile: "codex-local-main", objective: "review", idempotencyKey: "step", extra: true }));
    expect(extra.status).toBe(400);
    const unauthorized = await fetch(url, { method: "POST", body: "{}" });
    expect(unauthorized.status).toBe(401);
  });

  it("is hidden when disabled or the handoff service is absent", async () => {
    let started = await start(async () => packetResult, false);
    expect((await fetch(started.url, init({ targetProfile: "codex-local-main", objective: "review", idempotencyKey: "step" }))).status).toBe(404);
    await server?.close();
    server = undefined;
    started = await start();
    expect((await fetch(started.url, init({ targetProfile: "codex-local-main", objective: "review", idempotencyKey: "step" }))).status).toBe(404);
  });

  it("maps service capacity errors to 429 without exposing internals", async () => {
    const { url } = await start(async () => { throw new TerminalHandoffError("BUSY", "Too many terminal handoffs are running."); });
    const response = await fetch(url, init({ targetProfile: "codex-local-main", objective: "review", idempotencyKey: "step" }));
    expect(response.status).toBe(429);
    expect(await response.json()).toMatchObject({ error: { code: "BUSY" } });
  });

  it("maps deadline and idempotency conflicts to distinguishable HTTP errors", async () => {
    let started = await start(async () => { throw new TerminalHandoffError("TIMEOUT", "deadline"); });
    let response = await fetch(started.url, init({ targetProfile: "codex-local-main", objective: "review", idempotencyKey: "timeout" }));
    expect(response.status).toBe(504);
    expect(await response.json()).toMatchObject({ error: { code: "TIMEOUT" } });
    await server?.close();
    server = undefined;

    started = await start(async () => { throw new TerminalHandoffError("IDEMPOTENCY_CONFLICT", "conflict"); });
    response = await fetch(started.url, init({ targetProfile: "codex-local-main", objective: "review", idempotencyKey: "conflict" }));
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: { code: "IDEMPOTENCY_CONFLICT" } });
  });

  it("propagates caller disconnect as an abort signal", async () => {
    let observedAbort = false;
    const { url } = await start((_id, _input, signal) => new Promise<TerminalHandoffResult>((_resolve, reject) => {
      signal?.addEventListener("abort", () => {
        observedAbort = true;
        reject(new TerminalHandoffError("ABORTED", "aborted"));
      }, { once: true });
    }));
    const controller = new AbortController();
    const pending = fetch(url, init({ targetProfile: "codex-local-main", objective: "review", idempotencyKey: "step" }, controller.signal));
    await new Promise<void>((resolve) => setTimeout(resolve, 30));
    controller.abort();
    await expect(pending).rejects.toThrow();
    await new Promise<void>((resolve) => setTimeout(resolve, 30));
    expect(observedAbort).toBe(true);
  });
});
