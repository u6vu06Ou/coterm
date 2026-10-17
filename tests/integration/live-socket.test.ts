import WebSocket from "ws";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AppEventBus } from "../../src/main/core/event-bus";
import { startWebServer, type RunningWebServer } from "../../src/main/web/web-server";
import { createTailscaleVerifier } from "../../src/main/web/access-auth";

describe("Coterm live socket", () => {
  let server: RunningWebServer | undefined;
  afterEach(async () => server?.close());

  it("authenticates upgrades and carries events and terminal RPC", async () => {
    const events = new AppEventBus();
    const writeTerminal = vi.fn();
    server = await startWebServer({
      port: 0,
      allowedOrigin: "https://coterm.example.com",
      verifyAccess: (token) => token === "valid"
        ? Promise.resolve({ email: "owner@example.com" })
        : Promise.reject(new Error("unauthorized")),
      operations: { writeTerminal },
      events,
    });
    const socket = new WebSocket(`ws://127.0.0.1:${server.port}/live`, {
      origin: "https://coterm.example.com",
      headers: { "cf-access-jwt-assertion": "valid" },
    });
    await new Promise<void>((resolve, reject) => {
      socket.once("open", resolve); socket.once("error", reject);
    });
    const messages: unknown[] = [];
    socket.on("message", (data) => {
      const message = JSON.parse(Buffer.from(data as ArrayBuffer).toString("utf8")) as (typeof messages)[number];
      messages.push(message);
    });
    events.emit("terminalData", {
      terminalId: "terminal-1",
      projectId: "project-1",
      data: "ready",
      revision: 1,
    });
    const result = {
      id: "11111111-1111-4111-8111-111111111119",
      cwd: "D:\\project",
      command: "git status",
      exitCode: 0,
      startedAt: "2026-07-14T00:00:00.000Z",
      endedAt: "2026-07-14T00:00:00.010Z",
      durationMs: 10,
    };
    events.emit("terminalCommand", { terminalId: "terminal-1", projectId: "project-1", result });
    socket.send(JSON.stringify({
      type: "rpc", id: "request-1", method: "writeTerminal",
      args: [{ terminalId: "terminal-1", data: "dir\r" }],
    }));
    await vi.waitFor(() => expect(messages).toHaveLength(3));
    expect(messages).toContainEqual({
      type: "terminalData", payload: {
        terminalId: "terminal-1", projectId: "project-1", data: "ready", revision: 1,
      },
    });
    expect(messages).toContainEqual({
      type: "terminalCommand", payload: { terminalId: "terminal-1", projectId: "project-1", result },
    });
    expect(messages).toContainEqual({ type: "rpc", id: "request-1", ok: true });
    expect(writeTerminal).toHaveBeenCalledOnce();
    socket.close();
  });

  it("rejects an unauthenticated upgrade", async () => {
    server = await startWebServer({
      port: 0, allowedOrigin: "https://coterm.example.com",
      verifyAccess: () => Promise.reject(new Error("unauthorized")),
      operations: {}, events: new AppEventBus(),
    });
    const status = await new Promise<number>((resolve) => {
      const socket = new WebSocket(`ws://127.0.0.1:${server!.port}/live`, {
        origin: "https://coterm.example.com",
      });
      socket.once("unexpected-response", (_request, response) => resolve(response.statusCode ?? 0));
    });
    expect(status).toBe(401);
  });

  it("closes a connection that sends more than the HTTP payload limit", async () => {
    const writeTerminal = vi.fn();
    server = await startWebServer({
      port: 0, allowedOrigin: "https://coterm.example.com",
      verifyAccess: () => Promise.resolve({ email: "owner@example.com" }),
      operations: { writeTerminal }, events: new AppEventBus(),
    });
    const socket = new WebSocket(`ws://127.0.0.1:${server.port}/live`, {
      origin: "https://coterm.example.com",
    });
    await new Promise<void>((resolve, reject) => {
      socket.once("open", resolve); socket.once("error", reject);
    });
    socket.send("x".repeat(1_000_001));
    const code = await new Promise<number>((resolve) => socket.once("close", resolve));
    expect(code).toBe(1009);
    expect(writeTerminal).not.toHaveBeenCalled();
  });

  it("replays persisted conversation events whenever a client reconnects", async () => {
    const conversationId = "11111111-1111-4111-8111-111111111111";
    const persisted = { id: "22222222-2222-4222-8222-222222222222", conversationId,
      turnId: "33333333-3333-4333-8333-333333333333", providerSessionId: null,
      turnGroupId: null, type: "assistant.final", createdAt: new Date().toISOString(),
      sequence: 1, summary: "Persisted", payload: { text: "Finished while offline" } };
    server = await startWebServer({
      port: 0, allowedOrigin: "https://coterm.example.com",
      verifyAccess: () => Promise.resolve({ email: "owner@example.com" }),
      operations: {
        bootstrap: () => ({ conversations: [{ id: conversationId }], projects: [{ id: conversationId }] }),
        listEvents: () => [persisted],
        getTerminalWorkspace: () => ({ scrollback: { "terminal-1": "offline output" } }),
      },
      events: new AppEventBus(),
      dockLayout: dockLayoutWith([{ terminalId: "terminal-1", projectId: conversationId }]),
    });
    const socket = new WebSocket(`ws://127.0.0.1:${server.port}/live`, {
      origin: "https://coterm.example.com",
    });
    // Scrollback replay is dock-scoped now, so a dockLayout is wired above and
    // its on-connect push is filtered out — this test is about the replay itself.
    const messages = await new Promise<unknown[]>((resolve, reject) => {
      const values: unknown[] = [];
      socket.on("message", (data) => {
        const message = JSON.parse(Buffer.from(data as ArrayBuffer).toString("utf8")) as { type?: unknown };
        if (message.type !== "event" && message.type !== "terminalData") return;
        values.push(message);
        if (values.length === 2) resolve(values);
      });
      socket.once("error", reject);
    });
    expect(messages).toEqual([
      { type: "event", payload: persisted },
      {
        type: "terminalData",
        payload: { terminalId: "terminal-1", data: "offline output", replace: true, revision: 0 },
      },
    ]);
    socket.close();
  });

  it("buffers live events until persisted replay finishes", async () => {
    const events = new AppEventBus();
    const conversationId = "11111111-1111-4111-8111-111111111111";
    const turnId = "33333333-3333-4333-8333-333333333333";
    const persisted = event("user.message", 1, conversationId, turnId);
    const final = event("assistant.final", 2, conversationId, turnId);
    let releaseReplay!: () => void;
    let replayStarted!: () => void;
    const replayGate = new Promise<void>((resolve) => { releaseReplay = resolve; });
    const started = new Promise<void>((resolve) => { replayStarted = resolve; });
    server = await startWebServer({
      port: 0, allowedOrigin: "https://coterm.example.com",
      verifyAccess: () => Promise.resolve({ email: "owner@example.com" }),
      operations: {
        bootstrap: () => ({ conversations: [{ id: conversationId }], projects: [] }),
        listEvents: async () => {
          replayStarted();
          await replayGate;
          return [persisted];
        },
      },
      events,
    });
    const socket = new WebSocket(`ws://127.0.0.1:${server.port}/live`, {
      origin: "https://coterm.example.com",
    });
    const messages: Array<{ type: string; payload: { type: string } }> = [];
    socket.on("message", (data) => {
      const message = JSON.parse(Buffer.from(data as ArrayBuffer).toString("utf8")) as (typeof messages)[number];
      messages.push(message);
    });
    await started;
    events.emit("event", final);
    releaseReplay();
    await vi.waitFor(() => expect(messages).toHaveLength(2));

    expect(messages.map((message) => message.payload.type)).toEqual(["user.message", "assistant.final"]);
    socket.close();
  });

  it("pushes ptyStateChanged and replays unresolved attention on connect", async () => {
    const events = new AppEventBus();
    const attentionNotification = {
      id: "11111111-1111-4111-8111-111111111111",
      terminalId: "terminal-1",
      projectId: "11111111-1111-4111-8111-111111111112",
      state: "approval_required" as const,
      source: "osc" as const,
      createdAt: "2026-07-15T00:00:00.000Z",
      resolvedAt: null,
    };
    server = await startWebServer({
      port: 0, allowedOrigin: "https://coterm.example.com",
      verifyAccess: () => Promise.resolve({ email: "owner@example.com" }),
      operations: { bootstrap: () => ({ conversations: [], projects: [] }) },
      events,
      attention: {
        list: () => [attentionNotification],
        subscribe: () => () => undefined,
      },
    });
    const socket = new WebSocket(`ws://127.0.0.1:${server.port}/live`, {
      origin: "https://coterm.example.com",
    });
    const messages: Array<{ type: string; payload: unknown }> = [];
    socket.on("message", (data) => {
      const parsed: unknown = JSON.parse(Buffer.from(data as ArrayBuffer).toString("utf8"));
      if (parsed && typeof parsed === "object" && "type" in parsed && "payload" in parsed) {
        const record = parsed as { type?: unknown; payload?: unknown };
        if (typeof record.type === "string") messages.push({ type: record.type, payload: record.payload });
      }
    });
    // Wait for the connect-time attention replay.
    await vi.waitFor(() => expect(messages.some((m) => m.type === "attentionChanged")).toBe(true));
    // A live state change is pushed immediately.
    events.emit("ptyStateChanged", {
      terminalId: "terminal-1",
      projectId: "p1",
      state: "running",
      previousState: "approval_required",
      source: "broker",
    });
    await vi.waitFor(() => expect(messages.some((m) => m.type === "ptyStateChanged")).toBe(true));
    expect(messages.find((m) => m.type === "attentionChanged")!.payload).toEqual(attentionNotification);
    socket.close();
  });

  it("authenticates Tailscale Serve identity on WebSocket upgrades", async () => {
    server = await startWebServer({
      port: 0,
      allowedOrigin: "self",
      allowedHosts: ["desktop.example.ts.net"],
      verifyAccess: createTailscaleVerifier("owner@example.com"),
      operations: {},
      events: new AppEventBus(),
    });
    const socket = new WebSocket(`ws://127.0.0.1:${server.port}/live`, {
      origin: "https://desktop.example.ts.net:8443",
      headers: { "tailscale-user-login": "owner@example.com" },
    });
    await new Promise<void>((resolve, reject) => {
      socket.once("open", resolve);
      socket.once("error", reject);
    });
    expect(socket.readyState).toBe(WebSocket.OPEN);
    socket.close();
  });

  it("hydrates and pushes the global usage snapshot", async () => {
    let publishUsage: ((snapshot: {
      claude5h: null;
      claude7d: null;
      codex7d: null;
      fetchedAt: number;
    }) => void) | undefined;
    const initial = { claude5h: null, claude7d: null, codex7d: null, fetchedAt: 1 } as const;
    const updated = { claude5h: null, claude7d: null, codex7d: null, fetchedAt: 2 } as const;
    server = await startWebServer({
      port: 0, allowedOrigin: "https://coterm.example.com",
      verifyAccess: () => Promise.resolve({ email: "owner@example.com" }),
      operations: { bootstrap: () => ({ conversations: [], projects: [] }) },
      events: new AppEventBus(),
      usage: {
        get: () => initial,
        subscribe: (callback) => {
          publishUsage = callback;
          return () => { publishUsage = undefined; };
        },
      },
    });
    const socket = new WebSocket(`ws://127.0.0.1:${server.port}/live`, {
      origin: "https://coterm.example.com",
    });
    const snapshots: unknown[] = [];
    socket.on("message", (data) => {
      const message = JSON.parse(Buffer.from(data as ArrayBuffer).toString("utf8")) as { type?: unknown; payload?: unknown };
      if (message.type === "usageChanged") snapshots.push(message.payload);
    });

    await vi.waitFor(() => expect(snapshots).toContainEqual(initial));
    publishUsage?.(updated);
    await vi.waitFor(() => expect(snapshots).toContainEqual(updated));
    socket.close();
  });

  // Regression: connect-time replay used to push EVERY project's scrollback, so a
  // 20-project workspace shipped ~4.5 MB on connect, blew the send-buffer ceiling,
  // and the server closed the socket — mobile reconnect-looped forever.
  it("replays scrollback only for docked terminals", async () => {
    const dockedProject = "11111111-1111-4111-8111-111111111111";
    const idleProject = "11111111-1111-4111-8111-111111111112";
    const requested: string[] = [];
    server = await startWebServer({
      port: 0, allowedOrigin: "https://coterm.example.com",
      verifyAccess: () => Promise.resolve({ email: "owner@example.com" }),
      operations: {
        bootstrap: () => ({ conversations: [], projects: [{ id: dockedProject }, { id: idleProject }] }),
        getTerminalWorkspace: (id) => {
          requested.push(String(id));
          return { scrollback: { "terminal-docked": "docked output", "terminal-undocked": "undocked output" } };
        },
      },
      events: new AppEventBus(),
      dockLayout: dockLayoutWith([{ terminalId: "terminal-docked", projectId: dockedProject }]),
    });
    const socket = new WebSocket(`ws://127.0.0.1:${server.port}/live`, {
      origin: "https://coterm.example.com",
    });
    const replays: unknown[] = [];
    socket.on("message", (data) => {
      const message = JSON.parse(Buffer.from(data as ArrayBuffer).toString("utf8")) as { type?: unknown; payload?: unknown };
      if (message.type === "terminalData") replays.push(message.payload);
    });

    await vi.waitFor(() => expect(replays).toHaveLength(1));
    expect(replays).toEqual([{
      terminalId: "terminal-docked", data: "docked output", replace: true, revision: 0,
    }]);
    // The idle project's workspace is never even built — that's where the MBs went.
    expect(requested).toEqual([dockedProject]);
    socket.close();
  });

  it("scopes conversation replay to docked projects — many undocked conversations do not grow replay (issue #87)", async () => {
    const docked: Array<{ id: string; projectId: string }> = [];
    const tiles: Array<{ terminalId: string; projectId: string }> = [];
    for (let i = 0; i < 4; i++) {
      const pid = `p-${i}`;
      const cid = `c-${i}`;
      docked.push({ id: cid, projectId: pid });
      tiles.push({ terminalId: `t-${i}`, projectId: pid });
    }
    // 25 extra conversations whose projectId is NOT in any docked project. The
    // whole point of #87: without scoping, every one of these would be
    // listEvents-fetched AND pushed on connect, so connect->visible scales with
    // this count. After the fix they must never be fetched or pushed.
    const nonDocked = Array.from({ length: 25 }, (_, i) => ({ id: `nc-${i}`, projectId: "off-dock" }));

    const listEvents = vi.fn(async (_id: unknown): Promise<unknown[]> => [{
      id: _id, type: "assistant.final", sequence: 1, summary: "x", payload: { text: "y" },
    }]);
    server = await startWebServer({
      port: 0, allowedOrigin: "https://coterm.example.com",
      verifyAccess: () => Promise.resolve({ email: "owner@example.com" }),
      operations: {
        bootstrap: () => ({ conversations: [...docked, ...nonDocked], projects: [] }),
        listEvents,
      },
      events: new AppEventBus(),
      dockLayout: dockLayoutWith(tiles),
    });
    const socket = new WebSocket(`ws://127.0.0.1:${server.port}/live`, {
      origin: "https://coterm.example.com",
    });
    // Attach the message handler synchronously (before the connect burst can
    // arrive) — otherwise the on-connect replay is lost, same pattern as above.
    const messages: unknown[] = [];
    socket.on("message", (data) => {
      const m = JSON.parse(Buffer.from(data as ArrayBuffer).toString("utf8")) as { type?: unknown };
      if (m.type === "event") messages.push(m);
    });
    await vi.waitFor(() => expect(messages).toHaveLength(docked.length));
    const calledIds = listEvents.mock.calls.map((c) => String(c[0]));
    const dockIdSet = new Set(docked.map((c) => c.id));
    // exactly the N docked conversations were fetched, in count and scope...
    expect(calledIds).toHaveLength(docked.length);
    for (const id of calledIds) expect(dockIdSet.has(id)).toBe(true);
    // ...and nothing from the 25 non-docked conversations leaks through.
    const leaked = calledIds.filter((id) => !dockIdSet.has(id));
    expect(leaked).toHaveLength(0);
    expect(messages).toHaveLength(docked.length);
    socket.close();
  });
});

function dockLayoutWith(tiles: Array<{ terminalId: string; projectId: string }>) {
  const layout = {
    tiles: tiles.map((tile) => ({ ...tile, weight: 1, agentProfile: null })),
    selectedTerminalId: tiles[0]?.terminalId ?? null,
    exclusiveTerminalId: null,
    rows: [1], cols: [[1]], ptyCols: 100, ptyRows: 28,
  };
  return { get: () => Promise.resolve(layout), subscribe: () => () => undefined };
}

function event(type: "user.message" | "assistant.final", sequence: number, conversationId: string, turnId: string) {
  return {
    id: `${sequence}2222222-2222-4222-8222-222222222222`,
    conversationId, turnId, providerSessionId: null, turnGroupId: null, type,
    createdAt: new Date(sequence).toISOString(), sequence, summary: type, payload: {},
  };
}
