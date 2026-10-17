// Integration tests for the Agent API scrollbackMode contract (issue #13 / AT-138).
// Drives the real HTTP server with a stubbed terminal view. The contract under
// test: session detail is always HTTP 200 with a bounded payload; on the
// alternate screen (?1049h) scrollback is "" and the bounded screen-cache text
// is returned instead, so a polling agent can never enter a garbage-retry loop.

import { afterEach, describe, expect, it } from "vitest";
import { startWebServer, type RunningWebServer } from "../../src/main/web/web-server";
import type { TerminalInfo } from "../../src/shared/types";
import type { ScrollbackMode } from "../../src/shared/schema";

const TID = "11111111-1111-4111-8111-111111111111";
const PID = "22222222-2222-4222-8222-222222222222";

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

describe("Agent API scrollbackMode contract (issue #13)", () => {
  let server: RunningWebServer | undefined;

  afterEach(async () => {
    await server?.close();
    server = undefined;
  });

  async function start(options: {
    scrollback: string;
    mode?: ScrollbackMode | null;
    screenText?: string | null;
  }) {
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
        getTerminalWorkspace: () => ({ terminals: [terminal], scrollback: { [TID]: options.scrollback } }),
      },
      terminals: {
        getScrollbackMode: () => options.mode ?? "normal",
        getScreenSnapshot: () => options.screenText ?? null,
      },
    });
    return `http://127.0.0.1:${server.port}`;
  }

  const headers = () => ({ authorization: "Bearer secret" });

  it("alternate-screen session returns bounded screenText and empty scrollback, 200 both polls", async () => {
    const base = await start({
      scrollback: "\x1b[2J\x1b[H█".repeat(100_000),
      mode: "alternate-screen",
      screenText: "line 1\nline 2",
    });
    const first = await fetch(`${base}/api/v1/agent/session/${TID}`, { headers: headers() });
    expect(first.status).toBe(200);
    const body = await first.json() as Record<string, unknown>;
    expect(body.ok).toBe(true);
    expect(body.scrollbackMode).toBe("alternate-screen");
    expect(body.scrollback).toBe("");
    expect(body.screenText).toBe("line 1\nline 2");
    expect(typeof body.truncated).toBe("boolean");

    // Loop-safety: a second poll returns the same bounded shape, never the ring.
    const second = await fetch(`${base}/api/v1/agent/session/${TID}`, { headers: headers() });
    expect(second.status).toBe(200);
    expect(JSON.stringify(await second.json()).length).toBeLessThan(16_384 * 2);
  });

  it("normal session returns the bounded raw scrollback with truncated flag", async () => {
    const tail = "TAIL-MARKER";
    const base = await start({ scrollback: `${"x".repeat(200_000)}${tail}`, mode: "normal" });
    const res = await fetch(`${base}/api/v1/agent/session/${TID}`, { headers: headers() });
    expect(res.status).toBe(200);
    const body = await res.json() as { scrollbackMode: string; scrollback: string; screenText: string | null; truncated: boolean };
    expect(body.scrollbackMode).toBe("normal");
    // Bounded: never the full 200K+ ring, but the agent-relevant tail survives.
    expect(body.scrollback.length).toBeLessThanOrEqual(64_000);
    expect(body.scrollback.endsWith(tail)).toBe(true);
    expect(body.truncated).toBe(true);
    // screenText is the alternate-screen substitute; null in normal mode.
    expect(body.screenText).toBeNull();
  });

  it("normal session under the cap is not truncated and two polls are byte-identical", async () => {
    const base = await start({ scrollback: "short scrollback body", mode: "normal" });
    const a = await fetch(`${base}/api/v1/agent/session/${TID}`, { headers: headers() });
    const b = await fetch(`${base}/api/v1/agent/session/${TID}`, { headers: headers() });
    const textA = await a.text();
    const textB = await b.text();
    expect(a.status).toBe(200);
    expect(textA).toBe(textB);
    const body = JSON.parse(textA) as { scrollback: string; truncated: boolean };
    expect(body.scrollback).toBe("short scrollback body");
    expect(body.truncated).toBe(false);
  });

  it("GET /sessions includes per-terminal scrollbackModes", async () => {
    const base = await start({ scrollback: "", mode: "alternate-screen" });
    const res = await fetch(`${base}/api/v1/agent/sessions`, { headers: headers() });
    expect(res.status).toBe(200);
    const body = await res.json() as { scrollbackModes: Record<string, string> };
    expect(body.scrollbackModes).toEqual({ [TID]: "alternate-screen" });
  });

  it("omitting the terminal view degrades to normal mode (never errors)", async () => {
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
        getTerminalWorkspace: () => ({ terminals: [terminal], scrollback: { [TID]: "abc" } }),
      },
    });
    const res = await fetch(`http://127.0.0.1:${server.port}/api/v1/agent/session/${TID}`, { headers: headers() });
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect(body.scrollbackMode).toBe("normal");
    expect(body.scrollback).toBe("abc");
    expect(body.screenText).toBeNull();
  });
});
