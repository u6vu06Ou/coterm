import { describe, expect, it, vi } from "vitest";
import {
  createCotermMcpHandler,
  MCP_BROWSER_CORE_ACTION_IDS,
  MCP_TERMINAL_TOOL_NAMES,
  mcpToolIsMutation,
} from "../../src/main/mcp/mcp-server";
import { browserActionRegistry } from "../../src/main/browser/browser-action-registry";
import type { BrowserRuntimeManager } from "../../src/main/browser/browser-runtime-manager";

describe("coterm MCP handler (AT-135)", () => {
  it("keeps the curated core subset pinned to live registry ids (no-rot guard)", () => {
    const registryIds = new Set(browserActionRegistry.map((item) => item.id));
    for (const id of MCP_BROWSER_CORE_ACTION_IDS) {
      expect(registryIds.has(id), `MCP core id "${id}" missing from browser registry`).toBe(true);
    }
    // Subset, not mirror: the REST envelope + discovery schema carry the rest.
    expect(MCP_BROWSER_CORE_ACTION_IDS.length).toBeLessThan(browserActionRegistry.length);
    // Phase 7 parity rule (§15.2#12): every tiered (p0/p1) action MUST ride the
    // curated subset — HTTP and MCP dispatch the same registry entries.
    const tiered = browserActionRegistry.filter((item) => item.tier !== undefined).map((item) => item.id);
    expect(tiered.length).toBeGreaterThan(0);
    for (const id of tiered) expect(MCP_BROWSER_CORE_ACTION_IDS as readonly string[]).toContain(id);
  });

  it("lists exactly the curated tools with closed input schemas", async () => {
    const handler = createCotermMcpHandler({});
    const listed = await handler({ jsonrpc: "2.0", id: 1, method: "tools/list" });
    const tools = (listed?.result as { tools: Array<{ name: string; inputSchema: Record<string, unknown> }> }).tools;
    const expectedNames = new Set([
      ...MCP_BROWSER_CORE_ACTION_IDS.map(
        (id) => browserActionRegistry.find((item) => item.id === id)!.mcpName,
      ),
      ...MCP_TERMINAL_TOOL_NAMES,
    ]);
    expect(new Set(tools.map((tool) => tool.name))).toEqual(expectedNames);
    expect(tools.every((tool) => tool.inputSchema.additionalProperties !== true)).toBe(true);
  });

  it("rejects registry actions that are not in the curated subset", async () => {
    const handler = createCotermMcpHandler({ browser: {} as BrowserRuntimeManager });
    // page.back exists in the registry but is deliberately not exposed over MCP.
    await expect(
      handler({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "coterm_browser_back", arguments: { pageId: "p" } } }),
    ).resolves.toMatchObject({ error: { data: { code: "invalid_input" } } });
    await expect(
      handler({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "not_a_tool", arguments: {} } }),
    ).resolves.toMatchObject({ error: { data: { code: "invalid_input" } } });
  });

  it("forces screenshot over MCP to artifact-only (no base64 on the wire)", async () => {
    const pageId = "11111111-1111-4111-8111-111111111111";
    const screenshot = vi.fn(async () => ({ artifactPath: "D:/cache/shot.png", bytes: 42 }));
    const browser = { screenshot } as unknown as BrowserRuntimeManager;
    const handler = createCotermMcpHandler({ browser });
    const called = await handler({
      jsonrpc: "2.0",
      id: 4,
      method: "tools/call",
      params: { name: "coterm_browser_screenshot", arguments: { pageId } },
    });
    expect(screenshot).toHaveBeenCalledWith(pageId, { fullPage: false, artifactOnly: true, format: "png", scale: "css" });
    expect(JSON.stringify(called)).toContain("D:/cache/shot.png");
    expect(JSON.stringify(called)).not.toContain("base64");
  });

  it("clamps terminal read bounds and validates terminalId", async () => {
    const terminalRead = vi.fn(async () => ({ scrollbackMode: "normal", scrollback: "tail" }));
    const handler = createCotermMcpHandler({ terminalRead });

    await handler({ jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "coterm_terminal_read", arguments: { terminalId: "t1" } } });
    expect(terminalRead).toHaveBeenLastCalledWith({ terminalId: "t1", tailChars: 2000 });

    await handler({ jsonrpc: "2.0", id: 6, method: "tools/call", params: { name: "coterm_terminal_read", arguments: { terminalId: "t1", tailChars: 999_999 } } });
    expect(terminalRead).toHaveBeenLastCalledWith({ terminalId: "t1", tailChars: 8000 });

    await expect(
      handler({ jsonrpc: "2.0", id: 7, method: "tools/call", params: { name: "coterm_terminal_read", arguments: {} } }),
    ).resolves.toMatchObject({ error: { data: { code: "invalid_input" } } });
  });

  it("answers notifications with null (route maps that to 202) and pings with {}", async () => {
    const handler = createCotermMcpHandler({});
    await expect(handler({ jsonrpc: "2.0", method: "notifications/initialized" })).resolves.toBeNull();
    await expect(handler({ jsonrpc: "2.0", id: 8, method: "ping" })).resolves.toMatchObject({ result: {} });
    await expect(handler({ jsonrpc: "2.0", id: 9, method: "initialize" })).resolves.toMatchObject({
      result: { serverInfo: { name: "coterm" } },
    });
  });

  it("classifies mutation tools for the shared rate-limit bucket", () => {
    expect(mcpToolIsMutation("coterm_browser_navigate")).toBe(true);
    expect(mcpToolIsMutation("coterm_browser_snapshot")).toBe(false);
    expect(mcpToolIsMutation("coterm_terminal_read")).toBe(false);
    expect(mcpToolIsMutation("coterm_terminal_sessions")).toBe(false);
    expect(mcpToolIsMutation("not_a_tool")).toBe(false);
  });
});
