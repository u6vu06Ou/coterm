// Integration tests for the agent resource board (2026-10-14):
//   GET /api/v1/agent/resources          — token-gated live load + capacity
//   tools/call coterm_resources on /mcp  — same snapshot for MCP clients
// The capacity math itself lives in tests/unit/resource-estimate.test.ts;
// here we pin the wire contract: shape, auth, and the MCP/REST parity.

import { afterEach, describe, expect, it } from "vitest";
import { startWebServer, type RunningWebServer } from "../../src/main/web/web-server";
import type { TerminalInfo } from "../../src/shared/types";

const TID = "11111111-1111-4111-8111-111111111111";
const PID = "22222222-2222-4222-8222-222222222222";
const GIB = 1024 * 1024 * 1024;

function makeTerminal(): TerminalInfo {
  return {
    id: TID,
    projectId: PID,
    profile: "pwsh",
    title: "Agent",
    cwd: "D:\\Coterm",
    cols: 100,
    rows: 28,
    status: "running",
    startedAt: "2026-07-20T00:00:00.000Z",
    closedAt: null,
    lastExitCode: null,
    isAgent: true,
    agentProfile: "claude-local-main",
    ownedByAgentApi: true,
    pid: 0,
    nativeSessionId: null,
    worktreeId: null,
    contextUsage: null,
  };
}

describe("Agent API resource board", () => {
  let server: RunningWebServer | undefined;

  afterEach(async () => {
    await server?.close();
    server = undefined;
  });

  async function start() {
    const terminal = makeTerminal();
    server = await startWebServer({
      port: 0,
      allowedOrigin: "https://coterm.example.com",
      verifyAccess: () => Promise.reject(new Error("agent path should bypass access")),
      getSettings: () => ({ agentApi: { enabled: true, token: "secret" } }) as never,
      operations: {
        getDockLayout: () => ({
          tiles: [{ terminalId: TID, projectId: PID, weight: 1 }],
          selectedTerminalId: TID,
          rows: [1],
          cols: [[1]],
          ptyCols: 100,
          ptyRows: 28,
        }),
        listTerminals: () => [terminal],
        // cpu 42 / 8 GiB of 32 GiB → cpuCapacity floor((75-42)/8)=4,
        // memCapacity floor((25.6-8)/0.6)=29, freeTiles 11 → recommended 4.
        getSystemActivity: () => ({
          cpuPercent: 42, memPercent: 25, memUsedBytes: 8 * GIB, memTotalBytes: 32 * GIB,
          agentFiles: 0, agentBytes: 0, watchedRoots: 0, since: Date.now(),
        }),
      },
    });
    return `http://127.0.0.1:${server.port}`;
  }

  const headers = () => ({ authorization: "Bearer secret" });

  it("GET /resources requires the bearer token", async () => {
    const base = await start();
    const res = await fetch(`${base}/api/v1/agent/resources`);
    expect(res.status).toBe(401);
  });

  it("GET /resources returns the documented snapshot shape", async () => {
    const base = await start();
    const res = await fetch(`${base}/api/v1/agent/resources`, { headers: headers() });
    expect(res.status).toBe(200);
    const body = await res.json() as { ok: boolean; resources: Record<string, unknown> };
    expect(body.ok).toBe(true);
    const r = body.resources;
    expect(r.cpuPercent).toBe(42);
    expect(typeof r.cpuCores).toBe("number");
    expect(r.memUsedBytes).toBe(8 * GIB);
    expect(r.memTotalBytes).toBe(32 * GIB);
    expect(r.memPercent).toBe(25);
    expect(r.openTerminals).toBe(1); // dock tiles, not live PTYs
    expect(r.busyAgents).toBe(1);
    expect(r.recommendedMaxNewAgents).toBe(4);
    expect(typeof r.sampledAt).toBe("number");
  });

  it("MCP tools/call coterm_resources mirrors the REST payload", async () => {
    const base = await start();
    const res = await fetch(`${base}/api/v1/agent/mcp`, {
      method: "POST",
      headers: { ...headers(), "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0", id: 1, method: "tools/call",
        params: { name: "coterm_resources", arguments: {} },
      }),
    });
    expect(res.status).toBe(200);
    const rpc = await res.json() as { result?: { content?: Array<{ text: string }> } };
    expect(rpc.result?.content?.[0]?.text).toBeTruthy();
    const snapshot = JSON.parse(rpc.result!.content![0]!.text) as Record<string, unknown>;
    expect(snapshot.cpuPercent).toBe(42);
    expect(snapshot.openTerminals).toBe(1);
    expect(snapshot.busyAgents).toBe(1);
    expect(snapshot.recommendedMaxNewAgents).toBe(4);
  });

  it("tools/list advertises coterm_resources with a closed schema", async () => {
    const base = await start();
    const res = await fetch(`${base}/api/v1/agent/mcp`, {
      method: "POST",
      headers: { ...headers(), "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }),
    });
    const rpc = await res.json() as { result?: { tools?: Array<{ name: string; inputSchema: Record<string, unknown> }> } };
    const tool = rpc.result?.tools?.find((entry) => entry.name === "coterm_resources");
    expect(tool).toBeTruthy();
    expect(tool!.inputSchema.additionalProperties).toBe(false);
  });
});
