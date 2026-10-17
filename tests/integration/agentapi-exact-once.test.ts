// Phase 5 (work order §10.4): exact-once terminal input over HTTP retries —
// repository-side idempotency pattern reused for the supervisor's
// send_agent_message and the Agent API input endpoint. Real AppOperations,
// real web server; the PTY manager is mocked (no live Coterm, no live DB).
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AppOperations, TerminalMutationConflictError } from "../../src/main/core/app-operations";
import { AppEventBus } from "../../src/main/core/event-bus";
import { AppDatabase } from "../../src/main/storage/database";
import { Repository } from "../../src/main/storage/repository";
import { startWebServer, type RunningWebServer } from "../../src/main/web/web-server";

const TID = "11111111-1111-4111-8111-111111111111";
const MUT = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";

function makeOperations(directory: string, repository: Repository) {
  const write = vi.fn();
  const writeWhenShellReady = vi.fn();
  const operations = new AppOperations({
    repository,
    runs: { send: vi.fn(), cancel: vi.fn(), command: vi.fn() },
    approvals: { resolve: vi.fn() },
    council: { start: vi.fn(), cancel: vi.fn() },
    attention: { list: vi.fn().mockReturnValue([]), resolve: vi.fn(), onAttentionChanged: vi.fn().mockReturnValue(() => undefined) },
    events: new AppEventBus(),
    terminals: {
      create: vi.fn(), write, writeWhenShellReady, resize: vi.fn(), rename: vi.fn(), setLabel: vi.fn(), markAgent: vi.fn(), markAgentOwned: vi.fn(), setNativeSessionId: vi.fn(),
      kill: vi.fn(), list: vi.fn().mockReturnValue([]), snapshots: vi.fn().mockReturnValue([]), get: vi.fn().mockReturnValue(null), getPtyState: vi.fn().mockReturnValue(null), getLastCommand: vi.fn().mockReturnValue(null), dashboardSnapshot: vi.fn().mockReturnValue([]), setTerminalKeepalive: vi.fn().mockReturnValue(null), listTerminalKeepaliveStates: vi.fn().mockReturnValue([]),
    },
    appVersion: "1.5.0",
    userDataPath: directory,
    tempPath: directory,
  });
  return { operations, write, writeWhenShellReady };
}

describe("AppOperations.writeTerminal exact-once (§10.4)", () => {
  let directory: string;
  let database: AppDatabase;
  let repository: Repository;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "coterm-exact-once-"));
    database = new AppDatabase(join(directory, "state.sqlite"));
    await database.open();
    repository = new Repository(database);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    database.close();
    await rm(directory, { recursive: true, force: true });
  });

  it("identical retry dedupes without a second PTY write", () => {
    const { operations, write } = makeOperations(directory, repository);
    const first = operations.writeTerminal({ terminalId: TID, data: "hi\r", source: "automation", clientMutationId: MUT });
    expect(first.status).toBe("written");
    const retry = operations.writeTerminal({ terminalId: TID, data: "hi\r", source: "automation", clientMutationId: MUT });
    expect(retry.status).toBe("deduped");
    expect(write).toHaveBeenCalledTimes(1);
    expect(write).toHaveBeenCalledWith(TID, "hi\r", "automation");
  });

  it("same id with a different payload conflicts loudly", () => {
    const { operations, write } = makeOperations(directory, repository);
    operations.writeTerminal({ terminalId: TID, data: "a\r", source: "automation", clientMutationId: MUT });
    expect(() =>
      operations.writeTerminal({ terminalId: TID, data: "b\r", source: "automation", clientMutationId: MUT }),
    ).toThrowError(TerminalMutationConflictError);
    expect(write).toHaveBeenCalledTimes(1);
  });

  it("payload covers terminal id: same id reused across terminals conflicts", () => {
    const { operations, write } = makeOperations(directory, repository);
    operations.writeTerminal({ terminalId: TID, data: "a\r", source: "automation", clientMutationId: MUT });
    expect(() =>
      operations.writeTerminal({ terminalId: "22222222-2222-4222-8222-222222222222", data: "a\r", source: "automation", clientMutationId: MUT }),
    ).toThrowError(TerminalMutationConflictError);
    expect(write).toHaveBeenCalledTimes(1);
  });

  it("payload covers source and shell-ready mode", () => {
    const { operations, write } = makeOperations(directory, repository);
    operations.writeTerminal({ terminalId: TID, data: "a\r", source: "automation", clientMutationId: MUT });
    expect(() =>
      operations.writeTerminal({ terminalId: TID, data: "a\r", source: "human", clientMutationId: MUT }),
    ).toThrowError(TerminalMutationConflictError);
    expect(() =>
      operations.writeTerminal({ terminalId: TID, data: "a\r", source: "automation", waitForShellReady: true, clientMutationId: MUT }),
    ).toThrowError(TerminalMutationConflictError);
    expect(write).toHaveBeenCalledTimes(1);
  });

  it("a failed write is NOT recorded — the retry can still actually write", () => {
    const { operations, write } = makeOperations(directory, repository);
    write.mockImplementationOnce(() => {
      throw new Error("Terminal not found or PTY exited.");
    });
    expect(() =>
      operations.writeTerminal({ terminalId: TID, data: "hi\r", source: "automation", clientMutationId: MUT }),
    ).toThrow(/exited/);
    const retry = operations.writeTerminal({ terminalId: TID, data: "hi\r", source: "automation", clientMutationId: MUT });
    expect(retry.status).toBe("written");
    expect(write).toHaveBeenCalledTimes(2);
  });

  it("mutation records expire after the bounded TTL", () => {
    const realNow = Date.now();
    const { operations, write } = makeOperations(directory, repository);
    operations.writeTerminal({ terminalId: TID, data: "hi\r", source: "automation", clientMutationId: MUT });
    vi.spyOn(Date, "now").mockReturnValue(realNow + 6 * 60_000);
    const retry = operations.writeTerminal({ terminalId: TID, data: "hi\r", source: "automation", clientMutationId: MUT });
    expect(retry.status).toBe("written");
    expect(write).toHaveBeenCalledTimes(2);
  });

  it("payload+Enter is one atomic write (single data string, one write call)", () => {
    const { operations, write } = makeOperations(directory, repository);
    operations.writeTerminal({ terminalId: TID, data: "deploy now\r", source: "automation", clientMutationId: MUT });
    expect(write).toHaveBeenCalledTimes(1);
    expect(write).toHaveBeenCalledWith(TID, "deploy now\r", "automation");
  });
});

describe("Agent API POST /session/:id/input exact-once (§10.4)", () => {
  let server: RunningWebServer | undefined;
  let directory: string;
  let database: AppDatabase;
  let repository: Repository;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "coterm-exact-once-http-"));
    database = new AppDatabase(join(directory, "state.sqlite"));
    await database.open();
    repository = new Repository(database);
  });

  afterEach(async () => {
    await server?.close();
    server = undefined;
    database.close();
    await rm(directory, { recursive: true, force: true });
  });

  async function start() {
    const { operations, write } = makeOperations(directory, repository);
    server = await startWebServer({
      port: 0,
      allowedOrigin: "https://coterm.example.com",
      verifyAccess: () => Promise.reject(new Error("agent path bypasses access")),
      getSettings: () => ({ agentApi: { enabled: true, token: "secret" } }) as never,
      operations: { writeTerminal: (input: unknown) => operations.writeTerminal(input) },
    });
    return { write, url: `http://127.0.0.1:${server.port}/api/v1/agent/session/${TID}/input` };
  }

  const post = (url: string, body: unknown) =>
    fetch(url, {
      method: "POST",
      headers: { authorization: "Bearer secret", "content-type": "application/json" },
      body: JSON.stringify(body),
    });

  it("HTTP retry with the same clientMutationId delivers exactly once", async () => {
    const { write, url } = await start();
    const body = { data: "hello", enter: true, clientMutationId: MUT };
    const first = await post(url, body);
    expect(first.status).toBe(200);
    expect(await first.json()).toEqual({ ok: true, deduped: false });
    const retry = await post(url, body);
    expect(retry.status).toBe(200);
    expect(await retry.json()).toEqual({ ok: true, deduped: true });
    expect(write).toHaveBeenCalledTimes(1);
    expect(write).toHaveBeenCalledWith(TID, "hello\r", "automation");
  });

  it("same mutation id with a different payload is a 409 mutation_conflict", async () => {
    const { write, url } = await start();
    await post(url, { data: "one", enter: true, clientMutationId: MUT });
    const conflict = await post(url, { data: "two", enter: true, clientMutationId: MUT });
    expect(conflict.status).toBe(409);
    expect(await conflict.json()).toMatchObject({ ok: false, code: "mutation_conflict" });
    expect(write).toHaveBeenCalledTimes(1);
  });

  it("a malformed clientMutationId is a 400 before any write", async () => {
    const { write, url } = await start();
    const bad = await post(url, { data: "x", clientMutationId: "not-a-uuid" });
    expect(bad.status).toBe(400);
    expect(write).not.toHaveBeenCalled();
  });

  it("legacy clients without an id keep the previous pass-through behavior", async () => {
    const { write, url } = await start();
    const first = await post(url, { data: "hi", enter: true });
    const second = await post(url, { data: "hi", enter: true });
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(await second.json()).toEqual({ ok: true, deduped: false });
    expect(write).toHaveBeenCalledTimes(2);
  });
});
