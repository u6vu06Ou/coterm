import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startWebServer, type RunningWebServer } from "../../src/main/web/web-server";
import { createTailscaleVerifier } from "../../src/main/web/access-auth";
import { initLogger, logger } from "../../src/main/core/logger";
import type { TerminalInfo } from "../../src/shared/types";
import { BrowserRuntimeManager } from "../../src/main/browser/browser-runtime-manager";

describe("Coterm loopback web server", () => {
  let server: RunningWebServer | undefined;
  afterEach(async () => server?.close());

  async function start() {
    server = await startWebServer({
      port: 0,
      allowedOrigin: "https://coterm.example.com",
      verifyAccess: (token) => token === "valid"
        ? Promise.resolve({ email: "owner@example.com" })
        : Promise.reject(new Error("nope")),
      operations: {
        bootstrap: () => ({ appVersion: "1.0.0" }),
        sendMessage: vi.fn(() => { throw new Error("secret internal path C:\\private"); }),
      },
    });
    return `http://127.0.0.1:${server.port}`;
  }

  it("offers only a minimal unauthenticated health check", async () => {
    const base = await start();
    const response = await fetch(`${base}/health`);
    expect(await response.json()).toEqual({ status: "ok" });
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(server?.host).toBe("127.0.0.1");
  });

  it("requires Access authentication and the public origin", async () => {
    const base = await start();
    const unauthenticated = await fetch(`${base}/api/rpc`, {
      method: "POST", headers: { origin: "https://coterm.example.com" },
      body: JSON.stringify({ method: "bootstrap", args: [] }),
    });
    expect(unauthenticated.status).toBe(401);

    const wrongOrigin = await fetch(`${base}/api/rpc`, {
      method: "POST",
      headers: { origin: "https://evil.invalid", "cf-access-jwt-assertion": "valid" },
      body: JSON.stringify({ method: "bootstrap", args: [] }),
    });
    expect(wrongOrigin.status).toBe(403);
  });

  it("accepts Tailscale Serve identity for configured ts.net hosts only", async () => {
    server = await startWebServer({
      port: 0,
      allowedOrigin: "self",
      allowedHosts: ["desktop.example.ts.net"],
      verifyAccess: createTailscaleVerifier("owner@example.com"),
      operations: { bootstrap: () => ({ appVersion: "1.0.0" }) },
    });
    const url = `http://127.0.0.1:${server.port}/api/rpc`;
    const body = JSON.stringify({ method: "bootstrap", args: [] });
    const baseHeaders = { origin: "https://desktop.example.ts.net:8443", "content-type": "application/json" };

    const missingIdentity = await fetch(url, { method: "POST", headers: baseHeaders, body });
    expect(missingIdentity.status).toBe(401);

    const wrongIdentity = await fetch(url, {
      method: "POST",
      headers: { ...baseHeaders, "tailscale-user-login": "other@example.com" },
      body,
    });
    expect(wrongIdentity.status).toBe(401);

    const accepted = await fetch(url, {
      method: "POST",
      headers: { ...baseHeaders, "tailscale-user-login": "owner@example.com" },
      body,
    });
    expect(accepted.status).toBe(200);
    expect(await accepted.json()).toEqual({ ok: true, result: { appVersion: "1.0.0" } });
  });

  it("invokes allowlisted operations without exposing internal errors", async () => {
    const base = await start();
    const headers = {
      origin: "https://coterm.example.com",
      "cf-access-jwt-assertion": "valid",
      "content-type": "application/json",
    };
    const ok = await fetch(`${base}/api/rpc`, {
      method: "POST", headers,
      body: JSON.stringify({ method: "bootstrap", args: [] }),
    });
    expect(await ok.json()).toEqual({ ok: true, result: { appVersion: "1.0.0" } });

    const failed = await fetch(`${base}/api/rpc`, {
      method: "POST", headers,
      body: JSON.stringify({ method: "sendMessage", args: [{}] }),
    });
    expect(failed.status).toBe(500);
    expect(await failed.text()).toBe('{"ok":false,"error":"Coterm request failed."}');
  });

  it("offers the authenticated conversation summary RPC", async () => {
    const conversationId = "11111111-1111-4111-8111-111111111111";
    const updated = {
      id: conversationId,
      projectId: "22222222-2222-4222-8222-222222222222",
      name: "Updated",
      activeProvider: "claude-local-main",
      archived: false,
      summary: {
        brief: "Brief", longTermGoal: "Goal", recentSummary: "Recent",
        updatedAt: "2026-06-21T01:02:03.000Z", partial: false,
      },
      createdAt: "2026-06-20T00:00:00.000Z",
      updatedAt: "2026-06-21T01:02:03.000Z",
    };
    const summarizeConversation = vi.fn().mockResolvedValue(updated);
    server = await startWebServer({
      port: 0,
      allowedOrigin: "https://coterm.example.com",
      verifyAccess: (token) => token === "valid"
        ? Promise.resolve({ email: "owner@example.com" })
        : Promise.reject(new Error("nope")),
      operations: { summarizeConversation },
    });
    const response = await fetch(`http://127.0.0.1:${server.port}/api/rpc`, {
      method: "POST",
      headers: {
        origin: "https://coterm.example.com",
        "cf-access-jwt-assertion": "valid",
        "content-type": "application/json",
      },
      body: JSON.stringify({ method: "summarizeConversation", args: [{ conversationId }] }),
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, result: updated });
    expect(summarizeConversation).toHaveBeenCalledWith({ conversationId });
  });

  it("rejects oversized request bodies", async () => {
    const base = await start();
    const response = await fetch(`${base}/api/rpc`, {
      method: "POST",
      headers: {
        origin: "https://coterm.example.com",
        "cf-access-jwt-assertion": "valid",
        "content-type": "application/json",
      },
      body: JSON.stringify({ method: "bootstrap", args: ["x".repeat(1_100_000)] }),
    });
    expect(response.status).toBe(413);
  });

  it("serves only renderer assets and rate limits mutations", async () => {
    const directory = await mkdtemp(join(tmpdir(), "coterm-web-"));
    await mkdir(join(directory, "assets"));
    await writeFile(join(directory, "index.html"), "<main>Coterm</main>");
    await writeFile(join(directory, "assets", "app.js"), "console.log('coterm')");
    server = await startWebServer({
      port: 0,
      allowedOrigin: "https://coterm.example.com",
      verifyAccess: () => Promise.resolve({ email: "owner@example.com" }),
      operations: { sendMessage: vi.fn(() => ({ turnId: "one" })) },
      rendererPath: directory,
      mutationLimit: 1,
    });
    const base = `http://127.0.0.1:${server.port}`;
    const access = { "cf-access-jwt-assertion": "valid" };
    expect(await (await fetch(`${base}/`, { headers: access })).text()).toBe("<main>Coterm</main>");
    expect(await (await fetch(`${base}/assets/app.js`, { headers: access })).text()).toContain("coterm");
    expect((await fetch(`${base}/../package.json`, { headers: access })).status).toBe(404);
    const request = () => fetch(`${base}/api/rpc`, {
      method: "POST",
      headers: { origin: "https://coterm.example.com", "cf-access-jwt-assertion": "valid" },
      body: JSON.stringify({ method: "sendMessage", args: [{}] }),
    });
    expect((await request()).status).toBe(200);
    expect((await request()).status).toBe(429);
    await rm(directory, { recursive: true, force: true });
  });

  it("does not rate limit dock selection separately from heavy mutations", async () => {
    const selectTile = vi.fn(() => ({ selectedTerminalId: "term-2", tiles: [] }));
    server = await startWebServer({
      port: 0,
      allowedOrigin: "https://coterm.example.com",
      verifyAccess: () => Promise.resolve({ email: "owner@example.com" }),
      operations: {
        sendMessage: vi.fn(() => ({ turnId: "one" })),
        selectTile,
      },
      mutationLimit: 1,
    });
    const base = `http://127.0.0.1:${server.port}`;
    const headers = {
      origin: "https://coterm.example.com",
      "cf-access-jwt-assertion": "valid",
      "content-type": "application/json",
    };

    const sendMessage = () => fetch(`${base}/api/rpc`, {
      method: "POST",
      headers,
      body: JSON.stringify({ method: "sendMessage", args: [{}] }),
    });
    expect((await sendMessage()).status).toBe(200);
    expect((await sendMessage()).status).toBe(429);

    for (let i = 0; i < 4; i += 1) {
      const response = await fetch(`${base}/api/rpc`, {
        method: "POST",
        headers,
        body: JSON.stringify({ method: "selectTile", args: [{ terminalId: `term-${i}` }] }),
      });
      expect(response.status).toBe(200);
    }
    expect(selectTile).toHaveBeenCalledTimes(4);
  });

  it("rate limits UI action audit separately from product mutations", async () => {
    const recordUiAction = vi.fn();
    const sendMessage = vi.fn(() => ({ turnId: "one" }));
    server = await startWebServer({
      port: 0,
      allowedOrigin: "https://coterm.example.com",
      verifyAccess: () => Promise.resolve({ email: "owner@example.com" }),
      operations: { recordUiAction, sendMessage },
      mutationLimit: 1,
      uiActionLimit: 2,
    });
    const base = `http://127.0.0.1:${server.port}`;
    const headers = {
      origin: "https://coterm.example.com",
      "cf-access-jwt-assertion": "valid",
      "content-type": "application/json",
    };
    const rpc = (method: string, args: unknown[]) => fetch(`${base}/api/rpc`, {
      method: "POST",
      headers,
      body: JSON.stringify({ method, args }),
    });
    const audit = {
      actionId: "topbar.settings.open",
      surface: "web",
      identified: true,
      controlType: "button",
      interaction: "click",
    };

    expect((await rpc("recordUiAction", [audit])).status).toBe(200);
    expect((await rpc("recordUiAction", [audit])).status).toBe(200);
    expect((await rpc("recordUiAction", [audit])).status).toBe(429);
    expect((await rpc("sendMessage", [{}])).status).toBe(200);
    expect((await rpc("sendMessage", [{}])).status).toBe(429);
    expect(recordUiAction).toHaveBeenCalledTimes(2);
    expect(sendMessage).toHaveBeenCalledTimes(1);
  });

  it("lets the agent API list capacity, open agent-owned terminals, and close only owned terminals by default", async () => {
    const projectId = "22222222-2222-4222-8222-222222222222";
    const userTerminal = {
      id: "11111111-1111-4111-8111-111111111111",
      projectId,
      profile: "pwsh" as const,
      title: "PowerShell",
      cwd: "D:\\Coterm",
      cols: 100,
      rows: 28,
      status: "running" as const,
      startedAt: "2026-06-30T00:00:00.000Z",
      closedAt: null,
      lastExitCode: null,
      isAgent: false,
      agentProfile: null,
      ownedByAgentApi: false,
      pid: 0,
      nativeSessionId: null,
      worktreeId: null,
      contextUsage: null,
    };
    const agentTerminal = {
      ...userTerminal,
      id: "33333333-3333-4333-8333-333333333333",
      isAgent: true,
      agentProfile: "claude-local-main",
    };
    let terminals: TerminalInfo[] = [userTerminal];
    let layout = {
      tiles: [{ terminalId: userTerminal.id, projectId, weight: 1 }],
      selectedTerminalId: userTerminal.id,
      rows: [1],
      cols: [[1]],
      ptyCols: 100,
      ptyRows: 28,
    };
    const getDockLayout = vi.fn(() => layout);
    const listTerminals = vi.fn(() => terminals);
    const openTile = vi.fn(() => {
      terminals = [...terminals, agentTerminal];
      layout = {
        ...layout,
        tiles: [...layout.tiles, { terminalId: agentTerminal.id, projectId, weight: 1 }],
        selectedTerminalId: agentTerminal.id,
      };
      return layout;
    });
    const markTerminalAgent = vi.fn(({ terminalId, agentProfile }) => {
      terminals = terminals.map((terminal) =>
        terminal.id === terminalId ? { ...terminal, isAgent: true, agentProfile } : terminal,
      );
      return terminals.find((terminal) => terminal.id === terminalId);
    });
    const writeTerminal = vi.fn();
    const closeTile = vi.fn(({ terminalId }) => {
      terminals = terminals.filter((terminal) => terminal.id !== terminalId);
      layout = {
        ...layout,
        tiles: layout.tiles.filter((tile) => tile.terminalId !== terminalId),
        selectedTerminalId: userTerminal.id,
      };
      return layout;
    });
    server = await startWebServer({
      port: 0,
      allowedOrigin: "https://coterm.example.com",
      verifyAccess: () => Promise.reject(new Error("agent path should bypass access")),
      getSettings: () => ({ agentApi: { enabled: true, token: "secret" } }) as never,
      operations: { getDockLayout, listTerminals, openTile, markTerminalAgent, writeTerminal, closeTile },
    });
    const base = `http://127.0.0.1:${server.port}`;
    const headers = { authorization: "Bearer secret", "content-type": "application/json" };

    const before = await fetch(`${base}/api/v1/agent/sessions`, { headers });
    expect(await before.json()).toMatchObject({
      ok: true,
      maxTerminals: 12,
      terminalCount: 1,
      availableSlots: 11,
      canCreate: true,
      terminals: [{ id: userTerminal.id, ownedByAgentApi: false }],
    });

    const refuseUserClose = await fetch(`${base}/api/v1/agent/session/${userTerminal.id}/close`, {
      method: "POST",
      headers,
      body: "{}",
    });
    expect(refuseUserClose.status).toBe(409);
    expect(await refuseUserClose.json()).toMatchObject({ needsUserApproval: true });
    expect(closeTile).not.toHaveBeenCalled();

    const created = await fetch(`${base}/api/v1/agent/terminals`, {
      method: "POST",
      headers,
      body: JSON.stringify({ projectId, agentProfile: "claude-local-main" }),
    });
    expect(created.status).toBe(200);
    expect(await created.json()).toMatchObject({
      ok: true,
      selectedTerminalId: agentTerminal.id,
      terminalCount: 2,
      availableSlots: 10,
      launched: true,
      terminal: { id: agentTerminal.id, ownedByAgentApi: true, agentProfile: "claude-local-main" },
    });
    expect(writeTerminal).toHaveBeenCalledWith({
      terminalId: agentTerminal.id,
      data: expect.stringContaining("my-glm-flash"),
      source: "automation",
      // #50: launch writes buffer until the fresh shell shows its first prompt.
      waitForShellReady: true,
    });
    expect(writeTerminal.mock.calls[0]?.[0].data).toContain("$env:CLAUDE_CODE_DISABLE_AGENT_VIEW='1'");
    expect(writeTerminal.mock.calls[0]?.[0].data).not.toContain("claude-local-long.cmd");

    const closeAgent = await fetch(`${base}/api/v1/agent/session/${agentTerminal.id}/close`, {
      method: "POST",
      headers,
      body: "{}",
    });
    expect(closeAgent.status).toBe(200);
    expect(await closeAgent.json()).toMatchObject({
      ok: true,
      terminalCount: 1,
      availableSlots: 11,
      canCreate: true,
    });
  });

  it("rejects created terminals that are missing from the terminal list", async () => {
    const projectId = "55555555-5555-4555-8555-555555555555";
    const terminalId = "55555555-5555-4555-8555-555555555556";
    let layout = {
      tiles: [] as Array<{ terminalId: string; projectId: string; weight: number }>,
      selectedTerminalId: null as string | null,
      rows: [1],
      cols: [[] as number[]],
      ptyCols: 100,
      ptyRows: 28,
    };
    const openTile = vi.fn(() => {
      layout = {
        ...layout,
        tiles: [{ terminalId, projectId, weight: 1 }],
        selectedTerminalId: terminalId,
        cols: [[1]],
      };
      return layout;
    });
    // The failed-create path must reclaim the tile itself (1.5.44 殭屍格), so
    // this mock removes it like the real closeTile does.
    const closeTile = vi.fn((input: unknown) => {
      const { terminalId: closing } = input as { terminalId: string };
      layout = {
        ...layout,
        tiles: layout.tiles.filter((tile) => tile.terminalId !== closing),
        selectedTerminalId: null,
      };
      return layout;
    });
    server = await startWebServer({
      port: 0,
      allowedOrigin: "https://coterm.example.com",
      verifyAccess: () => Promise.reject(new Error("agent path should bypass access")),
      getSettings: () => ({ agentApi: { enabled: true, token: "secret" } }) as never,
      operations: {
        getDockLayout: () => layout,
        listTerminals: () => [],
        openTile,
        closeTile,
      },
    });
    const base = `http://127.0.0.1:${server.port}`;
    const headers = { authorization: "Bearer secret", "content-type": "application/json" };

    const created = await fetch(`${base}/api/v1/agent/terminals`, {
      method: "POST",
      headers,
      body: JSON.stringify({ projectId, agentProfile: "claude-local-main" }),
    });
    expect(created.status).toBe(500);
    expect(await created.json()).toMatchObject({
      ok: false,
      error: "Created terminal is not available.",
    });
    // 殭屍格回收: the 500 must have closed the tile it just created — retries
    // no longer pile up blank placeholders.
    expect(closeTile).toHaveBeenCalledTimes(1);
    expect(closeTile).toHaveBeenCalledWith({ terminalId });

    // Reclaimed already: a follow-up close finds no tile (404), not a
    // user-terminal guard or a ghost slot.
    const closeMissing = await fetch(`${base}/api/v1/agent/session/${terminalId}/close`, {
      method: "POST",
      headers,
      body: "{}",
    });
    expect(closeMissing.status).toBe(404);
    expect(closeTile).toHaveBeenCalledTimes(1);
  });

  it("reports slot truth from the dock, not the live-terminal list (dead tiles visible)", async () => {
    const projectId = "66666666-6666-4666-8666-666666666666";
    const liveId = "66666666-6666-4666-8666-666666666661";
    const deadId = "66666666-6666-4666-8666-666666666662";
    // One live terminal + one ZOMBIE tile (PTY gone from the registry, tile
    // still in the dock). The old accounting counted only live terminals, so
    // availableSlots said "1 free" while openTile would refuse "dock is full"
    // (or eyes would see a slot that is really occupied).
    const layout = {
      tiles: [
        { terminalId: liveId, projectId, weight: 1 },
        { terminalId: deadId, projectId, weight: 1 },
      ],
      selectedTerminalId: liveId,
      rows: [1],
      cols: [[0.5, 0.5]],
      ptyCols: 100,
      ptyRows: 28,
    };
    const liveTerminal: TerminalInfo = {
      id: liveId, projectId, profile: "pwsh", title: "PowerShell", cwd: "D:\\Coterm",
      cols: 100, rows: 28, status: "running", startedAt: "2026-06-30T00:00:00.000Z",
      closedAt: null, lastExitCode: null, isAgent: false, agentProfile: null, ownedByAgentApi: false, pid: 0, nativeSessionId: null,
      worktreeId: null,
      contextUsage: null,
    };
    server = await startWebServer({
      port: 0,
      allowedOrigin: "https://coterm.example.com",
      verifyAccess: () => Promise.reject(new Error("agent path should bypass access")),
      getSettings: () => ({ agentApi: { enabled: true, token: "secret" } }) as never,
      operations: {
        getDockLayout: () => layout,
        listTerminals: () => [liveTerminal],
      },
    });
    const base = `http://127.0.0.1:${server.port}`;
    const headers = { authorization: "Bearer secret", "content-type": "application/json" };

    const sessions = await fetch(`${base}/api/v1/agent/sessions`, { headers });
    expect(await sessions.json()).toMatchObject({
      ok: true,
      maxTerminals: 12,
      terminalCount: 2,
      liveTerminalCount: 1,
      deadTileCount: 1,
      deadTileIds: [deadId],
      availableSlots: 10,
      canCreate: true,
      terminals: [{ id: liveId, ownedByAgentApi: false }],
    });
  });

  it("rejects terminal creation when the dock is full and cleans ownership on close", async () => {
    const projectId = "44444444-4444-4444-8444-444444444444";
    // Pre-fill the dock with 11 user-opened (NOT agent-owned) terminals. The 12th
    // slot is filled via POST /terminals so we can exercise the ownership-cleanup
    // branch on close (pre-filled terminals are never agent-owned).
    const tiles: Array<{ terminalId: string; projectId: string; weight: number }> = [];
    let terminals: TerminalInfo[] = [];
    for (let i = 0; i < 11; i++) {
      const id = `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`;
      tiles.push({ terminalId: id, projectId, weight: 1 });
      terminals.push({
        id, projectId, profile: "pwsh", title: "PowerShell", cwd: "D:\\Coterm",
        cols: 100, rows: 28, status: "running", startedAt: "2026-06-30T00:00:00.000Z",
        closedAt: null, lastExitCode: null, isAgent: false, agentProfile: null, ownedByAgentApi: false, pid: 0, nativeSessionId: null,
        worktreeId: null,
        contextUsage: null,
      });
    }
    // 12th slot: index 11, past the 11 pre-filled terminals.
    const agentId = "00000000-0000-4000-8000-000000000011";
    const agentTerminal: TerminalInfo = {
      id: agentId, projectId, profile: "pwsh", title: "GLM", cwd: "D:\\Coterm",
      cols: 100, rows: 28, status: "running", startedAt: "2026-06-30T00:00:00.000Z",
      closedAt: null, lastExitCode: null, isAgent: true, agentProfile: "codex-local-main", ownedByAgentApi: false, pid: 0, nativeSessionId: null,
        worktreeId: null,
        contextUsage: null,
    };
    let layout = {
      tiles, selectedTerminalId: tiles[10]!.terminalId,
      rows: [1], cols: [tiles.map(() => 1)], ptyCols: 100, ptyRows: 28,
    };
    const getDockLayout = vi.fn(() => layout);
    const listTerminals = vi.fn(() => terminals);
    const openTile = vi.fn(() => {
      terminals.push(agentTerminal);
      tiles.push({ terminalId: agentId, projectId, weight: 1 });
      layout = { ...layout, tiles, selectedTerminalId: agentId };
      return layout;
    });
    const markTerminalAgent = vi.fn(({ terminalId, agentProfile }) => {
      terminals = terminals.map((terminal) =>
        terminal.id === terminalId ? { ...terminal, isAgent: true, agentProfile } : terminal,
      );
      return terminals.find((terminal) => terminal.id === terminalId);
    });
    const writeTerminal = vi.fn();
    const closeTile = vi.fn(({ terminalId }) => {
      const remaining = terminals.filter((t) => t.id !== terminalId);
      terminals.length = 0;
      terminals.push(...remaining);
      const remainingTiles = tiles.filter((tile) => tile.terminalId !== terminalId);
      tiles.length = 0;
      tiles.push(...remainingTiles);
      layout = {
        ...layout,
        tiles,
        selectedTerminalId: tiles[0]?.terminalId ?? "",
      };
      return layout;
    });
    server = await startWebServer({
      port: 0,
      allowedOrigin: "https://coterm.example.com",
      verifyAccess: () => Promise.reject(new Error("agent path should bypass access")),
      getSettings: () => ({ agentApi: { enabled: true, token: "secret" } }) as never,
      operations: { getDockLayout, listTerminals, openTile, markTerminalAgent, writeTerminal, closeTile },
    });
    const base = `http://127.0.0.1:${server.port}`;
    const headers = { authorization: "Bearer secret", "content-type": "application/json" };

    // Fill the 12th slot via the API → agent-owned, dock now full.
    const created = await fetch(`${base}/api/v1/agent/terminals`, {
      method: "POST", headers,
      body: JSON.stringify({ projectId, agentProfile: "codex-local-main" }),
    });
    expect(created.status).toBe(200);
    expect(await created.json()).toMatchObject({
      ok: true, terminalCount: 12, availableSlots: 0, canCreate: false,
      terminal: { id: agentId, ownedByAgentApi: true },
    });

    // Full dock → 409, canCreate false, openTile not called again.
    const full = await fetch(`${base}/api/v1/agent/terminals`, {
      method: "POST", headers,
      body: JSON.stringify({ projectId, agentProfile: "codex-local-main" }),
    });
    expect(full.status).toBe(409);
    expect(await full.json()).toMatchObject({
      ok: false, maxTerminals: 12, terminalCount: 12, availableSlots: 0, canCreate: false,
    });
    expect(openTile).toHaveBeenCalledTimes(1);

    // Closing the agent-owned terminal frees a slot AND clears ownership, so a
    // subsequent close of the SAME id is rejected (no longer in dock / not owned).
    const closeOne = await fetch(`${base}/api/v1/agent/session/${agentId}/close`, {
      method: "POST", headers, body: "{}",
    });
    expect(closeOne.status).toBe(200);
    expect(await closeOne.json()).toMatchObject({
      ok: true, terminalCount: 11, availableSlots: 1, canCreate: true,
    });

    // Ownership was cleaned: closing the same id again → 404 (no longer in dock),
    // closeTile not invoked a second time.
    const closeAgain = await fetch(`${base}/api/v1/agent/session/${agentId}/close`, {
      method: "POST", headers, body: "{}",
    });
    expect(closeAgain.status).toBe(404);
    expect(closeTile).toHaveBeenCalledTimes(1);
  });

  it("returns a structured error without terminal:undefined when openTile itself throws (H1)", async () => {
    const projectId = "66666666-6666-4666-8666-666666666666";
    const layout = {
      tiles: [] as Array<{ terminalId: string; projectId: string; weight: number }>,
      selectedTerminalId: null as string | null,
      rows: [1],
      cols: [[] as number[]],
      ptyCols: 100,
      ptyRows: 28,
    };
    const openTile = vi.fn(() => { throw new Error("openTile boom"); });
    server = await startWebServer({
      port: 0,
      allowedOrigin: "https://coterm.example.com",
      verifyAccess: () => Promise.reject(new Error("agent path should bypass access")),
      getSettings: () => ({ agentApi: { enabled: true, token: "secret" } }) as never,
      operations: {
        getDockLayout: () => layout,
        listTerminals: () => [],
        openTile,
      },
    });
    const base = `http://127.0.0.1:${server.port}`;
    const headers = { authorization: "Bearer secret", "content-type": "application/json" };

    const created = await fetch(`${base}/api/v1/agent/terminals`, {
      method: "POST",
      headers,
      body: JSON.stringify({ projectId, agentProfile: "claude-local-main" }),
    });
    expect(created.status).toBe(500);
    const body = await created.json();
    expect(body).toMatchObject({ ok: false, error: "openTile boom" });
    // H1: must not leak a terminal:undefined field from a failed destructure.
    expect(body).not.toHaveProperty("terminal");
  });

  it("preserves ownership when closeTile throws so a retry is not 404 (M2)", async () => {
    const projectId = "77777777-7777-4777-8777-777777777777";
    const agentId = "77777777-7777-4777-8777-777777777778";
    const agentTerminal: TerminalInfo = {
      id: agentId, projectId, profile: "pwsh", title: "GLM", cwd: "D:\\Coterm",
      cols: 100, rows: 28, status: "running", startedAt: "2026-06-30T00:00:00.000Z",
      closedAt: null, lastExitCode: null, isAgent: true, agentProfile: "claude-local-main", ownedByAgentApi: false, pid: 0, nativeSessionId: null,
        worktreeId: null,
        contextUsage: null,
    };
    let terminals: TerminalInfo[] = [];
    let layout = {
      tiles: [] as Array<{ terminalId: string; projectId: string; weight: number }>,
      selectedTerminalId: null as string | null,
      rows: [1],
      cols: [[] as number[]],
      ptyCols: 100,
      ptyRows: 28,
    };
    const getDockLayout = vi.fn(() => layout);
    const listTerminals = vi.fn(() => terminals);
    const openTile = vi.fn(() => {
      terminals = [agentTerminal];
      layout = {
        ...layout,
        tiles: [{ terminalId: agentId, projectId, weight: 1 }],
        selectedTerminalId: agentId,
        cols: [[1]],
      };
      return layout;
    });
    const markTerminalAgent = vi.fn(({ terminalId, agentProfile }) => {
      terminals = terminals.map((t) =>
        t.id === terminalId ? { ...t, isAgent: true, agentProfile } : t,
      );
      return terminals.find((t) => t.id === terminalId);
    });
    const writeTerminal = vi.fn();
    const closeTile = vi.fn(() => { throw new Error("boom"); });
    server = await startWebServer({
      port: 0,
      allowedOrigin: "https://coterm.example.com",
      verifyAccess: () => Promise.reject(new Error("agent path should bypass access")),
      getSettings: () => ({ agentApi: { enabled: true, token: "secret" } }) as never,
      operations: { getDockLayout, listTerminals, openTile, markTerminalAgent, writeTerminal, closeTile },
    });
    const base = `http://127.0.0.1:${server.port}`;
    const headers = { authorization: "Bearer secret", "content-type": "application/json" };

    // Create an agent-owned terminal via the API first.
    const created = await fetch(`${base}/api/v1/agent/terminals`, {
      method: "POST",
      headers,
      body: JSON.stringify({ projectId, agentProfile: "claude-local-main" }),
    });
    expect(created.status).toBe(200);

    // First close: closeTile throws → 500 structured error.
    const firstClose = await fetch(`${base}/api/v1/agent/session/${agentId}/close`, {
      method: "POST",
      headers,
      body: "{}",
    });
    expect(firstClose.status).toBe(500);
    expect(await firstClose.json()).toMatchObject({ ok: false, error: "boom" });

    // M2: ownership was NOT cleaned (closeTile failed before ownedIds.delete),
    // so a retry is not rejected as 404 "not in dock" — it reaches closeTile again.
    const retryClose = await fetch(`${base}/api/v1/agent/session/${agentId}/close`, {
      method: "POST",
      headers,
      body: "{}",
    });
    expect(retryClose.status).not.toBe(404);
    expect(closeTile).toHaveBeenCalledTimes(2);
  });

  it("exposes logger health via the agent API with token + redacts the log path", async () => {
    // Initialise a real FileLogger so getLoggerHealth() returns meaningful data.
    const logDir = await mkdtemp(join(tmpdir(), "coterm-logger-health-"));
    initLogger({ userDataDir: logDir });

    server = await startWebServer({
      port: 0,
      allowedOrigin: "https://coterm.example.com",
      verifyAccess: () => Promise.reject(new Error("agent path should bypass access")),
      getSettings: () => ({ agentApi: { enabled: true, token: "secret" } }) as never,
      operations: {},
    });
    const base = `http://127.0.0.1:${server.port}`;

    // No token → 401.
    const unauthenticated = await fetch(`${base}/api/v1/agent/logger-health`);
    expect(unauthenticated.status).toBe(401);

    // Valid token → 200 + health shape.
    const response = await fetch(`${base}/api/v1/agent/logger-health`, {
      headers: { authorization: "Bearer secret" },
    });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toMatchObject({ ok: true });
    expect(body.health).toBeDefined();
    expect(typeof body.health.degraded).toBe("boolean");
    expect(typeof body.health.ringBufferCount).toBe("number");
    expect(typeof body.health.consecutiveWriteFailures).toBe("number");
    expect(typeof body.health.fileWriteDisabled).toBe("boolean");
    // logPath must be redacted (no raw tmpdir path leaks).
    expect(body.health.logPath).not.toContain(tmpdir());
    expect(body.health.logPath).toContain("~");

    await rm(logDir, { recursive: true, force: true });
  });

  it("aggregates warn/error incidents via the agent API with byCategory counts", async () => {
    const logDir = await mkdtemp(join(tmpdir(), "coterm-incidents-"));
    initLogger({ userDataDir: logDir, level: "debug" });
    // Inject entries: 1 info (ignored), 2 warn, 1 error across two categories.
    logger.info("app", "test.info", "Info message (not an incident)");
    logger.warn("app", "test.warn1", "Warning one");
    logger.warn("pty", "test.warn2", "Warning two");
    logger.error("app", "test.error1", "Error one");

    server = await startWebServer({
      port: 0,
      allowedOrigin: "https://coterm.example.com",
      verifyAccess: () => Promise.reject(new Error("agent path should bypass access")),
      getSettings: () => ({ agentApi: { enabled: true, token: "secret" } }) as never,
      operations: {},
    });
    const base = `http://127.0.0.1:${server.port}`;
    const headers = { authorization: "Bearer secret" };

    // No token → 401.
    const unauthenticated = await fetch(`${base}/api/v1/agent/incidents`);
    expect(unauthenticated.status).toBe(401);

    // Valid token → 200 + aggregated incidents.
    const response = await fetch(`${base}/api/v1/agent/incidents?window=5m`, { headers });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.ok).toBe(true);
    expect(body.incidents).toBeDefined();
    expect(body.incidents.count).toBe(3); // 2 warn + 1 error
    expect(body.incidents.byLevel).toEqual({ warn: 2, error: 1 });
    expect(body.incidents.byCategory).toEqual({ app: 2, pty: 1 });
    expect(body.incidents.window).toBe("5m");
    expect(Array.isArray(body.incidents.recent)).toBe(true);
    expect(body.incidents.recent.length).toBeLessThanOrEqual(10);
    // Each recent entry is a JSON string with level warn or error.
    for (const line of body.incidents.recent) {
      const parsed = JSON.parse(line);
      expect(["warn", "error"]).toContain(parsed.level);
    }
    expect(body.incidents.truncated).toBe(false);

    await rm(logDir, { recursive: true, force: true });
  });

  it("lets the agent API grep logs with level filter and maxChars truncation", async () => {
    const logDir = await mkdtemp(join(tmpdir(), "coterm-logs-grep-"));
    initLogger({ userDataDir: logDir, level: "debug" });
    // Inject entries into the ring buffer.
    logger.info("app", "test.info", "Info message one");
    logger.warn("app", "test.warn", "Warning message two");
    logger.error("app", "test.error", "Error message three");

    server = await startWebServer({
      port: 0,
      allowedOrigin: "https://coterm.example.com",
      verifyAccess: () => Promise.reject(new Error("agent path should bypass access")),
      getSettings: () => ({ agentApi: { enabled: true, token: "secret" } }) as never,
      operations: {},
    });
    const base = `http://127.0.0.1:${server.port}`;
    const headers = { authorization: "Bearer secret" };

    // No token → 401.
    const unauthenticated = await fetch(`${base}/api/v1/agent/logs`);
    expect(unauthenticated.status).toBe(401);

    // All entries → 4 lines (3 injected + 1 from initLogger).
    const allResponse = await fetch(`${base}/api/v1/agent/logs`, { headers });
    expect(allResponse.status).toBe(200);
    const allBody = await allResponse.json();
    expect(allBody.ok).toBe(true);
    expect(allBody.lines.length).toBe(4);
    expect(allBody.truncated).toBe(false);

    // Level filter: only warn → 1 line.
    const warnResponse = await fetch(`${base}/api/v1/agent/logs?level=warn`, { headers });
    const warnBody = await warnResponse.json();
    expect(warnBody.lines.length).toBe(1);
    const parsed = JSON.parse(warnBody.lines[0]);
    expect(parsed.level).toBe("warn");
    expect(parsed.msg).toContain("Warning message two");

    // maxChars truncation: set a tiny budget so only the first line fits.
    const truncResponse = await fetch(`${base}/api/v1/agent/logs?maxChars=10`, { headers });
    const truncBody = await truncResponse.json();
    expect(truncBody.truncated).toBe(true);
    expect(truncBody.lines.length).toBe(0);

    await rm(logDir, { recursive: true, force: true });
  });

  it("lets the agent API tail the log file as text/plain with truncation", async () => {
    const logDir = await mkdtemp(join(tmpdir(), "coterm-logs-file-"));
    initLogger({ userDataDir: logDir, level: "debug" });
    // Write some entries so the file has content.
    logger.info("app", "test.file1", "File line one");
    logger.warn("app", "test.file2", "File line two");

    server = await startWebServer({
      port: 0,
      allowedOrigin: "https://coterm.example.com",
      verifyAccess: () => Promise.reject(new Error("agent path should bypass access")),
      getSettings: () => ({ agentApi: { enabled: true, token: "secret" } }) as never,
      operations: {},
    });
    const base = `http://127.0.0.1:${server.port}`;
    const headers = { authorization: "Bearer secret" };

    const response = await fetch(`${base}/api/v1/agent/logs/file`, { headers });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/plain; charset=utf-8");
    const text = await response.text();
    expect(text).toContain("File line one");
    expect(text).toContain("File line two");
    // No raw tmpdir path should leak.
    expect(text).not.toContain(tmpdir());

    // Tiny maxChars → truncated header set.
    const truncResponse = await fetch(`${base}/api/v1/agent/logs/file?maxChars=5`, { headers });
    expect(truncResponse.status).toBe(200);
    expect(truncResponse.headers.get("x-truncated")).toBe("true");

    await rm(logDir, { recursive: true, force: true });
  });

  it("exposes app state summary via the agent API without scrollback", async () => {
    const projectId = "88888888-8888-4888-8888-888888888888";
    const terminal: TerminalInfo = {
      id: "99999999-9999-4999-8999-999999999999",
      projectId,
      profile: "pwsh",
      title: "Agent",
      cwd: "D:\\Coterm",
      cols: 100,
      rows: 28,
      status: "running",
      startedAt: "2026-07-02T00:00:00.000Z",
      closedAt: null,
      lastExitCode: null,
      isAgent: true,
      agentProfile: "claude-local-main",
      ownedByAgentApi: false,
      pid: 0,
      nativeSessionId: null,
        worktreeId: null,
        contextUsage: null,
    };
    const layout = {
      tiles: [{ terminalId: terminal.id, projectId, weight: 1 }],
      selectedTerminalId: terminal.id,
      rows: [1],
      cols: [[1]],
      ptyCols: 100,
      ptyRows: 28,
    };
    server = await startWebServer({
      port: 0,
      allowedOrigin: "https://coterm.example.com",
      verifyAccess: () => Promise.reject(new Error("agent path should bypass access")),
      getSettings: () => ({
        agentApi: { enabled: true, token: "secret" },
        defaultProvider: "claude-local-main",
        defaultShell: "pwsh",
      }) as never,
      operations: {
        getDockLayout: () => layout,
        listTerminals: () => [terminal],
      },
    });
    const base = `http://127.0.0.1:${server.port}`;

    // No token → 401.
    const unauthenticated = await fetch(`${base}/api/v1/agent/state`);
    expect(unauthenticated.status).toBe(401);

    // Valid token → 200 + state summary.
    const response = await fetch(`${base}/api/v1/agent/state`, {
      headers: { authorization: "Bearer secret" },
    });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.ok).toBe(true);
    expect(body.state).toBeDefined();
    expect(typeof body.state.terminals).toBe("number");
    expect(body.state.terminals).toBe(1);
    expect(body.state.dockLayout).toEqual({ tileCount: 1, selectedTerminalId: terminal.id });
    expect(body.state.settings).toEqual({
      agentApiEnabled: true,
      defaultProvider: "claude-local-main",
      defaultShell: "pwsh",
    });
    // Must NOT contain scrollback or terminal detail fields.
    expect(body.state).not.toHaveProperty("scrollback");
    // terminals is a count (number), not an array of terminal details.
    expect(typeof body.state.terminals).toBe("number");
    // No terminal detail (title/cwd/agentProfile) should leak — only counts.
    expect(JSON.stringify(body.state)).not.toContain("Agent");
    expect(JSON.stringify(body.state)).not.toContain(terminal.cwd);
  });

  it("exposes diagnostics aggregating health, state, and incidents in one call", async () => {
    const logDir = await mkdtemp(join(tmpdir(), "coterm-diag-"));
    initLogger({ userDataDir: logDir, level: "debug" });
    logger.warn("app", "test.diag.warn", "Diagnostic warning");
    logger.error("pty", "test.diag.error", "Diagnostic error");

    const projectId = "12121212-1212-4121-8121-121212121212";
    const terminal: TerminalInfo = {
      id: "13131313-1313-4131-8131-131313131313",
      projectId,
      profile: "pwsh",
      title: "Diag",
      cwd: "D:\\Coterm",
      cols: 100,
      rows: 28,
      status: "running",
      startedAt: "2026-07-02T00:00:00.000Z",
      closedAt: null,
      lastExitCode: null,
      isAgent: false,
      agentProfile: null,
      ownedByAgentApi: false,
      pid: 0,
      nativeSessionId: null,
        worktreeId: null,
        contextUsage: null,
    };
    const layout = {
      tiles: [{ terminalId: terminal.id, projectId, weight: 1 }],
      selectedTerminalId: terminal.id,
      rows: [1],
      cols: [[1]],
      ptyCols: 100,
      ptyRows: 28,
    };
    server = await startWebServer({
      port: 0,
      allowedOrigin: "https://coterm.example.com",
      verifyAccess: () => Promise.reject(new Error("agent path should bypass access")),
      getSettings: () => ({
        agentApi: { enabled: true, token: "secret" },
        defaultProvider: "claude-local-main",
        defaultShell: "pwsh",
      }) as never,
      operations: {
        getDockLayout: () => layout,
        listTerminals: () => [terminal],
      },
    });
    const base = `http://127.0.0.1:${server.port}`;

    // No token → 401.
    const unauthenticated = await fetch(`${base}/api/v1/agent/diagnostics`);
    expect(unauthenticated.status).toBe(401);

    // Valid token → 200 + three sub-objects.
    const response = await fetch(`${base}/api/v1/agent/diagnostics`, {
      headers: { authorization: "Bearer secret" },
    });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.ok).toBe(true);
    expect(body.diagnostics).toBeDefined();
    // health sub-object
    expect(body.diagnostics.health).toBeDefined();
    expect(typeof body.diagnostics.health.degraded).toBe("boolean");
    expect(typeof body.diagnostics.health.ringBufferCount).toBe("number");
    // state sub-object
    expect(body.diagnostics.state).toBeDefined();
    expect(typeof body.diagnostics.state.terminals).toBe("number");
    expect(body.diagnostics.state.terminals).toBe(1);
    expect(body.diagnostics.state.dockLayout.tileCount).toBe(1);
    // incidents sub-object
    expect(body.diagnostics.incidents).toBeDefined();
    expect(body.diagnostics.incidents.count).toBe(2); // 1 warn + 1 error
    expect(body.diagnostics.incidents.byLevel).toEqual({ warn: 1, error: 1 });
    expect(body.diagnostics.incidents.byCategory).toEqual({ app: 1, pty: 1 });
    // memory sub-object (RAM observability)
    expect(body.diagnostics.memory).toBeDefined();
    expect(typeof body.diagnostics.memory.rss).toBe("number");
    expect(typeof body.diagnostics.memory.heapUsed).toBe("number");
    expect(typeof body.diagnostics.memory.heapTotal).toBe("number");
    expect(typeof body.diagnostics.memory.external).toBe("number");
    // logPath must be redacted.
    expect(body.diagnostics.health.logPath).not.toContain(tmpdir());

    await rm(logDir, { recursive: true, force: true });
  });

  it("returns the static log schema with levels and categories arrays", async () => {
    server = await startWebServer({
      port: 0,
      allowedOrigin: "https://coterm.example.com",
      verifyAccess: () => Promise.reject(new Error("agent path should bypass access")),
      getSettings: () => ({ agentApi: { enabled: true, token: "secret" } }) as never,
      operations: {},
    });
    const base = `http://127.0.0.1:${server.port}`;

    // No token → 401.
    const unauthenticated = await fetch(`${base}/api/v1/agent/schema`);
    expect(unauthenticated.status).toBe(401);

    // Valid token → 200 + schema.
    const response = await fetch(`${base}/api/v1/agent/schema`, {
      headers: { authorization: "Bearer secret" },
    });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.ok).toBe(true);
    expect(body.schema).toBeDefined();
    expect(Array.isArray(body.schema.levels)).toBe(true);
    expect(body.schema.levels).toEqual(["debug", "info", "warn", "error"]);
    expect(Array.isArray(body.schema.categories)).toBe(true);
    expect(body.schema.categories).toContain("app");
    expect(body.schema.categories).toContain("audit");
    expect(Array.isArray(body.schema.msgCodes)).toBe(true);
    expect(body.schema.msgCodes.length).toBeGreaterThan(0);
    expect(body.schema.msgCodes).toContain("app.bootstrap");
  });

  it("lets the agent API pull the audit trail via /audit with category=audit filter", async () => {
    const logDir = await mkdtemp(join(tmpdir(), "coterm-audit-"));
    initLogger({ userDataDir: logDir, level: "debug" });
    // Inject audit-category entries (as written in repository.ts: logger.info("audit", ...))
    // plus a non-audit entry to verify the filter excludes it.
    logger.info("audit", "terminal.workspace.saved", "Workspace persisted");
    logger.info("audit", "terminal.event.appended", "Event appended");
    logger.info("app", "test.info", "Non-audit info message");

    server = await startWebServer({
      port: 0,
      allowedOrigin: "https://coterm.example.com",
      verifyAccess: () => Promise.reject(new Error("agent path should bypass access")),
      getSettings: () => ({ agentApi: { enabled: true, token: "secret" } }) as never,
      operations: {},
    });
    const base = `http://127.0.0.1:${server.port}`;
    const headers = { authorization: "Bearer secret" };

    // No token → 401.
    const unauthenticated = await fetch(`${base}/api/v1/agent/audit`);
    expect(unauthenticated.status).toBe(401);

    // Valid token → 200 + audit entries only.
    const response = await fetch(`${base}/api/v1/agent/audit`, { headers });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.ok).toBe(true);
    expect(Array.isArray(body.entries)).toBe(true);
    // 2 audit entries injected (the non-audit info must be excluded).
    expect(body.count).toBe(2);
    expect(body.truncated).toBe(false);
    for (const line of body.entries) {
      const parsed = JSON.parse(line);
      expect(parsed.category).toBe("audit");
      expect(parsed.level).toBe("info");
    }
    // Verify the audit messages are present.
    const msgs = body.entries.map((l: string) => JSON.parse(l).msg);
    expect(msgs).toContain("Workspace persisted");
    expect(msgs).toContain("Event appended");

    // maxChars truncation.
    const truncResponse = await fetch(`${base}/api/v1/agent/audit?maxChars=10`, { headers });
    const truncBody = await truncResponse.json();
    expect(truncBody.truncated).toBe(true);

    await rm(logDir, { recursive: true, force: true });
  });

  it("exposes the last command via /session/:id/last-command (200 null/result, 404 missing)", async () => {
    const projectId = "44444444-4444-4444-8444-444444444444";
    const terminalId = "44444444-4444-4444-8444-444444444445";
    const layout = {
      tiles: [{ terminalId, projectId, weight: 1 }],
      selectedTerminalId: terminalId,
      rows: [1],
      cols: [[1]],
      ptyCols: 100,
      ptyRows: 28,
    };
    const result = {
      id: "44444444-4444-4444-8444-444444444450",
      cwd: "D:\\proj",
      command: "git status",
      exitCode: 0,
      startedAt: "2026-07-14T00:00:00.000Z",
      endedAt: "2026-07-14T00:00:01.000Z",
      durationMs: 1000,
    };
    const getLastCommand = vi.fn(() => result);
    server = await startWebServer({
      port: 0,
      allowedOrigin: "https://coterm.example.com",
      verifyAccess: () => Promise.reject(new Error("agent path should bypass access")),
      getSettings: () => ({ agentApi: { enabled: true, token: "secret" } }) as never,
      operations: { getDockLayout: () => layout, getLastCommand },
    });
    const base = `http://127.0.0.1:${server.port}`;
    const headers = { authorization: "Bearer secret" };

    // Missing terminal (not in dock) → 404.
    const missing = await fetch(`${base}/api/v1/agent/session/00000000-0000-4000-8000-000000000000/last-command`, { headers });
    expect(missing.status).toBe(404);

    // Present terminal → 200 with the result.
    const ok = await fetch(`${base}/api/v1/agent/session/${terminalId}/last-command`, { headers });
    expect(ok.status).toBe(200);
    const body = await ok.json() as unknown as { ok: boolean; lastCommand: typeof result };
    expect(body.ok).toBe(true);
    expect(body.lastCommand).toEqual(result);
    expect(getLastCommand).toHaveBeenCalledWith(terminalId);
  });

  it("returns null last-command when the shell has no rich lifecycle yet", async () => {
    const projectId = "44444444-4444-4444-8444-444444444446";
    const terminalId = "44444444-4444-4444-8444-444444444447";
    const layout = {
      tiles: [{ terminalId, projectId, weight: 1 }],
      selectedTerminalId: terminalId,
      rows: [1],
      cols: [[1]],
      ptyCols: 100,
      ptyRows: 28,
    };
    server = await startWebServer({
      port: 0,
      allowedOrigin: "https://coterm.example.com",
      verifyAccess: () => Promise.reject(new Error("agent path should bypass access")),
      getSettings: () => ({ agentApi: { enabled: true, token: "secret" } }) as never,
      operations: { getDockLayout: () => layout, getLastCommand: () => null },
    });
    const base = `http://127.0.0.1:${server.port}`;
    const response = await fetch(`${base}/api/v1/agent/session/${terminalId}/last-command`, {
      headers: { authorization: "Bearer secret" },
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, lastCommand: null });
  });

  it("explains agent state without returning PTY text or matched evidence", async () => {
    const terminalId = "44444444-4444-4444-8444-444444444460";
    const explanation = {
      canonicalState: "approval_required",
      authoritativeSource: "screen",
      agentProfile: "codex-local-main",
      matchedRuleId: "codex_approval_prompt",
      fallbackReason: null,
      evaluatedRegion: "bottom_non_empty",
      gateSummary: {
        allPassed: true,
        allCount: 1,
        anyPassed: true,
        anyCount: 1,
        nonePassed: true,
        noneCount: 1,
      },
      manifestVersion: "1.0.0",
      evaluatedAt: "2026-07-20T12:00:00.000Z",
    } as const;
    let injectUnexpectedEvidence = false;
    const getAgentStateExplanation = vi.fn((id: unknown) => {
      if (id !== terminalId) return null;
      return injectUnexpectedEvidence
        ? { ...explanation, matchedText: "Approve running this command? secret" }
        : explanation;
    });
    server = await startWebServer({
      port: 0,
      allowedOrigin: "https://coterm.example.com",
      verifyAccess: () => Promise.reject(new Error("agent path should bypass access")),
      getSettings: () => ({ agentApi: { enabled: true, token: "secret" } }) as never,
      operations: { getAgentStateExplanation },
    });
    const base = `http://127.0.0.1:${server.port}`;
    const headers = { authorization: "Bearer secret" };

    const missing = await fetch(`${base}/api/v1/agent/session/00000000-0000-4000-8000-000000000000/state-explain`, { headers });
    expect(missing.status).toBe(404);

    const response = await fetch(`${base}/api/v1/agent/session/${terminalId}/state-explain`, { headers });
    expect(response.status).toBe(200);
    const body = await response.json() as unknown as { ok: boolean; explanation: typeof explanation };
    expect(body).toEqual({ ok: true, explanation });
    expect(Object.keys(body.explanation).sort()).toEqual([
      "agentProfile", "authoritativeSource", "canonicalState", "evaluatedAt", "evaluatedRegion",
      "fallbackReason", "gateSummary", "manifestVersion", "matchedRuleId",
    ]);
    const serialized = JSON.stringify(body);
    expect(serialized).not.toContain("Approve running this command?");
    expect(serialized).not.toContain("matchedText");
    expect(getAgentStateExplanation).toHaveBeenCalledWith(terminalId);

    // Strict egress schema fails closed if an internal implementation ever
    // tries to append raw match evidence.
    injectUnexpectedEvidence = true;
    const rejected = await fetch(`${base}/api/v1/agent/session/${terminalId}/state-explain`, { headers });
    expect(rejected.status).toBe(500);
    expect(JSON.stringify(await rejected.json())).not.toContain("Approve running this command");
  });

  it("includes lastCommand in session detail and redacts secrets in it", async () => {
    const projectId = "44444444-4444-4444-8444-444444444448";
    const terminalId = "44444444-4444-4444-8444-444444444449";
    const terminal: TerminalInfo = {
      id: terminalId, projectId, profile: "pwsh", title: "PS", cwd: "D:\\proj",
      cols: 100, rows: 28, status: "running", startedAt: "2026-07-14T00:00:00.000Z",
      closedAt: null, lastExitCode: null, isAgent: false, agentProfile: null,
      ownedByAgentApi: false, pid: 0, nativeSessionId: null,
        worktreeId: null,
        contextUsage: null,
    };
    const layout = {
      tiles: [{ terminalId, projectId, weight: 1 }],
      selectedTerminalId: terminalId,
      rows: [1],
      cols: [[1]],
      ptyCols: 100,
      ptyRows: 28,
    };
    // Command already redacted by PtyManager; the route re-redacts as defence.
    const getLastCommand = vi.fn(() => ({
      id: "44444444-4444-4444-8444-444444444451",
      cwd: "D:\\proj",
      command: "curl -H api_key=super-secret-token-value https://x",
      exitCode: 1,
      startedAt: "2026-07-14T00:00:00.000Z",
      endedAt: "2026-07-14T00:00:02.000Z",
      durationMs: 2000,
    }));
    server = await startWebServer({
      port: 0,
      allowedOrigin: "https://coterm.example.com",
      verifyAccess: () => Promise.reject(new Error("agent path should bypass access")),
      getSettings: () => ({ agentApi: { enabled: true, token: "secret" } }) as never,
      operations: {
        getDockLayout: () => layout,
        getTerminalWorkspace: () => ({ terminals: [terminal], scrollback: {}, split: "single", activeId: terminalId, secondaryId: null, restored: false }),
        getLastCommand,
      },
    });
    const base = `http://127.0.0.1:${server.port}`;
    const detail = await fetch(`${base}/api/v1/agent/session/${terminalId}`, {
      headers: { authorization: "Bearer secret" },
    });
    expect(detail.status).toBe(200);
    const body = await detail.json() as unknown as { lastCommand: { exitCode: number | null } };
    expect(body.lastCommand).toBeDefined();
    expect(body.lastCommand.exitCode).toBe(1);
    // The raw secret must never appear in the egress.
    expect(JSON.stringify(body)).not.toContain("super-secret-token-value");
  });

  it("agent API worktree routes require token + enabled flag (auth gate)", async () => {
    const listWorktrees = vi.fn(() => []);
    const createWorktree = vi.fn();
    server = await startWebServer({
      port: 0,
      allowedOrigin: "https://coterm.example.com",
      verifyAccess: () => Promise.reject(new Error("agent path should bypass access")),
      getSettings: () => ({ agentApi: { enabled: true, token: "secret" } }) as never,
      operations: { listWorktrees, createWorktree },
    });
    const base = `http://127.0.0.1:${server.port}`;

    // No token → 401.
    const unauth = await fetch(`${base}/api/v1/agent/worktrees?projectId=22222222-2222-4222-8222-222222222222`);
    expect(unauth.status).toBe(401);

    // Valid token → 200 + list.
    const ok = await fetch(`${base}/api/v1/agent/worktrees?projectId=22222222-2222-4222-8222-222222222222`, {
      headers: { authorization: "Bearer secret" },
    });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ ok: true, worktrees: [] });
    expect(listWorktrees).toHaveBeenCalledWith({ projectId: "22222222-2222-4222-8222-222222222222" });

    // Missing projectId → 400.
    const bad = await fetch(`${base}/api/v1/agent/worktrees`, {
      headers: { authorization: "Bearer secret" },
    });
    expect(bad.status).toBe(400);

    // Create without projectId → 400 (schema validation).
    const noProject = await fetch(`${base}/api/v1/agent/worktrees`, {
      method: "POST",
      headers: { authorization: "Bearer secret", "content-type": "application/json" },
      body: "{}",
    });
    expect(noProject.status).toBe(400);
    expect(createWorktree).not.toHaveBeenCalled();
  });

  it("agent API merge route requires confirm:true (safety gate)", async () => {
    const mergeWorktree = vi.fn();
    server = await startWebServer({
      port: 0,
      allowedOrigin: "https://coterm.example.com",
      verifyAccess: () => Promise.reject(new Error("agent path should bypass access")),
      getSettings: () => ({ agentApi: { enabled: true, token: "secret" } }) as never,
      operations: { mergeWorktree },
    });
    const base = `http://127.0.0.1:${server.port}`;
    const id = "11111111-1111-4111-8111-111111111111";

    // No confirm → 400.
    const refused = await fetch(`${base}/api/v1/agent/worktrees/${id}/merge`, {
      method: "POST",
      headers: { authorization: "Bearer secret", "content-type": "application/json" },
      body: "{}",
    });
    expect(refused.status).toBe(400);
    expect(mergeWorktree).not.toHaveBeenCalled();

    // confirm:true → proceeds.
    const ok = await fetch(`${base}/api/v1/agent/worktrees/${id}/merge`, {
      method: "POST",
      headers: { authorization: "Bearer secret", "content-type": "application/json" },
      body: JSON.stringify({ confirm: true }),
    });
    expect(ok.status).toBe(200);
    expect(mergeWorktree).toHaveBeenCalledWith({ worktreeId: id, confirm: true });
  });

  it("agent API trusted resume requires an explicit target terminal", async () => {
    const resumeWorktree = vi.fn().mockReturnValue({ command: "safe", worktree: { id: "w" } });
    server = await startWebServer({
      port: 0,
      allowedOrigin: "https://coterm.example.com",
      verifyAccess: () => Promise.reject(new Error("agent path should bypass access")),
      getSettings: () => ({ agentApi: { enabled: true, token: "secret" } }) as never,
      operations: { resumeWorktree },
    });
    const base = `http://127.0.0.1:${server.port}`;
    const worktreeId = "11111111-1111-4111-8111-111111111111";
    const terminalId = "22222222-2222-4222-8222-222222222222";

    const missing = await fetch(`${base}/api/v1/agent/worktrees/${worktreeId}/resume`, {
      method: "POST",
      headers: { authorization: "Bearer secret", "content-type": "application/json" },
      body: "{}",
    });
    expect(missing.status).toBe(400);
    expect(resumeWorktree).not.toHaveBeenCalled();

    const ok = await fetch(`${base}/api/v1/agent/worktrees/${worktreeId}/resume`, {
      method: "POST",
      headers: { authorization: "Bearer secret", "content-type": "application/json" },
      body: JSON.stringify({ terminalId }),
    });
    expect(ok.status).toBe(200);
    expect(resumeWorktree).toHaveBeenCalledWith({ worktreeId, terminalId });
  });

  it("agent API is hidden (404) when the enabled flag is off", async () => {
    server = await startWebServer({
      port: 0,
      allowedOrigin: "https://coterm.example.com",
      verifyAccess: () => Promise.reject(new Error("agent path should bypass access")),
      getSettings: () => ({ agentApi: { enabled: false, token: "secret" } }) as never,
      operations: {},
    });
    const base = `http://127.0.0.1:${server.port}`;
    const res = await fetch(`${base}/api/v1/agent/worktrees?projectId=22222222-2222-4222-8222-222222222222`, {
      headers: { authorization: "Bearer secret" },
    });
    expect(res.status).toBe(404);
  });

  it("MCP endpoint (AT-135): token-gated JSON-RPC, curated tools, alt-screen terminal read", async () => {
    const projectId = "11111111-1111-4111-8111-111111111111";
    const terminal: TerminalInfo = { id: "term-mcp-1", title: "pwsh", cwd: "D:/repo", isAgent: false } as TerminalInfo;
    server = await startWebServer({
      port: 0,
      allowedOrigin: "https://coterm.example.com",
      verifyAccess: () => Promise.reject(new Error("agent path should bypass access")),
      getSettings: () => ({ agentApi: { enabled: true, token: "secret" } }) as never,
      operations: {
        getDockLayout: () => ({ tiles: [{ terminalId: terminal.id, projectId, weight: 1 }], selectedTerminalId: terminal.id }),
        listTerminals: () => [terminal],
        getTerminalWorkspace: () => ({ terminals: [terminal], scrollback: { [terminal.id]: "raw-ring-bytes" } }),
        getLastCommand: () => null,
      },
      terminals: {
        getScrollbackMode: () => "alternate-screen",
        getScreenSnapshot: () => "FULLSCREEN FRAME TEXT",
      } as never,
    });
    const base = `http://127.0.0.1:${server.port}`;
    const headers = { authorization: "Bearer secret", "content-type": "application/json" };

    // Token gate is the same as every other agent route.
    const unauthenticated = await fetch(`${base}/api/v1/agent/mcp`, { method: "POST", body: "{}" });
    expect(unauthenticated.status).toBe(401);

    const init = await fetch(`${base}/api/v1/agent/mcp`, {
      method: "POST",
      headers,
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize" }),
    });
    expect(await init.json()).toMatchObject({ result: { serverInfo: { name: "coterm" } } });

    // Notifications get 202 with no body (streamable-HTTP stateless mode).
    const notification = await fetch(`${base}/api/v1/agent/mcp`, {
      method: "POST",
      headers,
      body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
    });
    expect(notification.status).toBe(202);

    const listed = await fetch(`${base}/api/v1/agent/mcp`, {
      method: "POST",
      headers,
      body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }),
    });
    const tools = ((await listed.json()) as { result: { tools: Array<{ name: string }> } }).result.tools;
    const names = tools.map((tool) => tool.name);
    expect(names).toContain("coterm_browser_navigate");
    expect(names).toContain("coterm_terminal_read");
    // Curated subset: page.back stays REST-only.
    expect(names).not.toContain("coterm_browser_back");

    // alt-screen contract through MCP: scrollback "" and screenText carries the frame.
    const read = await fetch(`${base}/api/v1/agent/mcp`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: { name: "coterm_terminal_read", arguments: { terminalId: terminal.id } },
      }),
    });
    const readResult = (await read.json()) as { result: { content: Array<{ text: string }> } };
    expect(JSON.parse(readResult.result.content[0]!.text)).toMatchObject({
      scrollbackMode: "alternate-screen",
      scrollback: "",
      screenText: "FULLSCREEN FRAME TEXT",
    });

    // Non-object bodies and JSON-RPC batches are loud 400s, never fake 202s.
    for (const bad of ["null", "[]", '"str"', '[{"jsonrpc":"2.0","id":1,"method":"ping"}]']) {
      const res = await fetch(`${base}/api/v1/agent/mcp`, { method: "POST", headers, body: bad });
      expect(res.status, `body ${bad}`).toBe(400);
      expect(await res.json()).toMatchObject({ error: { code: -32600 } });
    }

    // Streamable-HTTP: the optional SSE GET stream we do not serve must be a 405.
    const get = await fetch(`${base}/api/v1/agent/mcp`, { headers: { authorization: "Bearer secret" } });
    expect(get.status).toBe(405);
  });

  it("Phase 7 HTTP contract: discovery publishes P0 actions+live flags; gated tiers fail closed; core unaffected", async () => {
    const browserRoot = await mkdtemp(join(tmpdir(), "coterm-browser-http-"));
    let p0 = false;
    // Real registry + runtime — but no session is created, so no Chromium launch.
    const browser = new BrowserRuntimeManager({ userDataPath: browserRoot, superpowersProvider: () => ({ p0, p1: false }) });
    try {
      server = await startWebServer({
        port: 0,
        allowedOrigin: "https://coterm.example.com",
        verifyAccess: () => Promise.reject(new Error("agent path bypasses access")),
        getSettings: () => ({ agentApi: { enabled: true, token: "secret" } }) as never,
        operations: { bootstrap: () => ({ appVersion: "1.0.0" }) },
        browser,
      });
      const base = `http://127.0.0.1:${server.port}`;
      const headers = { authorization: "Bearer secret", "content-type": "application/json" };
      const pageId = "11111111-1111-4111-8111-111111111111";

      const schemaRes = await fetch(`${base}/api/v1/agent/browser/schema`, { headers });
      expect(schemaRes.status).toBe(200);
      const schema = ((await schemaRes.json()) as { schema: Record<string, unknown> }).schema;
      const actions = schema.actions as Array<{ id: string; tier: string; risk: number; approval: string; timeoutMs: number; inputSchema: unknown }>;
      const byId = new Map(actions.map((action) => [action.id, action]));
      for (const id of ["page.waitFor", "page.scroll", "page.scrollIntoView", "page.hover", "page.snapshotDiff", "page.networkLog"]) {
        const action = byId.get(id);
        expect(action, `discovery must publish ${id}`).toBeDefined();
        expect(action!.tier).toBe("p0");
        expect(action!.timeoutMs).toBeGreaterThan(0);
        expect(typeof action!.inputSchema).toBe("object");
      }
      // Every core action stays tier "core" (never gated).
      expect(byId.get("page.snapshot")!.tier).toBe("core");
      expect(byId.get("page.click")!.tier).toBe("core");
      expect(schema.featureFlags).toEqual({ superpowersP0: false, superpowersP1: false });
      expect(schema.networkLog).toMatchObject({ maxEntries: 50, perBodyChars: 65536 });

      // Flag off → P0 dispatch fails closed with 403/policy_denied...
      const gated = await fetch(`${base}/api/v1/agent/browser/action`, {
        method: "POST", headers,
        body: JSON.stringify({ action: "waitFor", input: { pageId, condition: "networkidle" } }),
      });
      expect(gated.status).toBe(403);
      expect(await gated.json()).toMatchObject({ ok: false, code: "policy_denied" });
      // ...while a core action on the same manager still dispatches fine.
      const core = await fetch(`${base}/api/v1/agent/browser/action`, {
        method: "POST", headers,
        body: JSON.stringify({ action: "listSessions", input: {} }),
      });
      expect(core.status).toBe(200);
      expect(await core.json()).toMatchObject({ ok: true, result: [] });

      // Flag on → the same P0 call reaches the runtime (unknown page = 404, not gate).
      p0 = true;
      const reached = await fetch(`${base}/api/v1/agent/browser/action`, {
        method: "POST", headers,
        body: JSON.stringify({ action: "waitFor", input: { pageId, condition: "networkidle" } }),
      });
      expect(reached.status).toBe(404);
      expect(await reached.json()).toMatchObject({ ok: false, code: "not_found" });
      const liveSchema = ((await (await fetch(`${base}/api/v1/agent/browser/schema`, { headers })).json()) as { schema: { featureFlags: unknown } }).schema;
      expect(liveSchema.featureFlags).toMatchObject({ superpowersP0: true });

      // MCP parity (§15.2#12): the whole P0 set is discoverable and dispatchable
      // over the curated MCP endpoint, with the same tier gate.
      const listed = await fetch(`${base}/api/v1/agent/mcp`, {
        method: "POST", headers,
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
      });
      const toolNames = ((await listed.json()) as { result: { tools: Array<{ name: string }> } }).result.tools.map((tool) => tool.name);
      for (const name of ["coterm_browser_wait_for", "coterm_browser_scroll", "coterm_browser_scroll_into_view", "coterm_browser_hover", "coterm_browser_snapshot_diff", "coterm_browser_network_log"]) {
        expect(toolNames).toContain(name);
      }
      p0 = false;
      const mcpGated = await fetch(`${base}/api/v1/agent/mcp`, {
        method: "POST", headers,
        body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "coterm_browser_wait_for", arguments: { pageId, condition: "networkidle" } } }),
      });
      expect(await mcpGated.json()).toMatchObject({ error: { data: { code: "policy_denied" } } });
    } finally {
      await browser.dispose();
      await rm(browserRoot, { recursive: true, force: true });
    }
  });
});
