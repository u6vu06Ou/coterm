import { describe, expect, it, vi } from "vitest";
import { createBrowserApi } from "../../src/renderer/src/api/browser-api";

describe("browser API", () => {
  it("calls the allowlisted RPC endpoint and returns its result", async () => {
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      ok: true, result: { projects: [], conversations: [], appVersion: "1.0.0" },
    }), { status: 200, headers: { "content-type": "application/json" } }));
    const api = createBrowserApi({ fetch });
    await expect(api.bootstrap()).resolves.toMatchObject({ appVersion: "1.0.0" });
    expect(fetch).toHaveBeenCalledWith("/api/rpc", expect.objectContaining({
      method: "POST",
      body: JSON.stringify({ method: "bootstrap", args: [] }),
    }));
  });

  it("reports the server's safe error", async () => {
    const fetch = vi.fn().mockResolvedValue(new Response(
      JSON.stringify({ ok: false, error: "Access authentication required." }),
      { status: 401, headers: { "content-type": "application/json" } },
    ));
    const api = createBrowserApi({ fetch });
    await expect(api.bootstrap()).rejects.toThrow("Access authentication required.");
  });

  it("returns the updated conversation from the summary RPC", async () => {
    const conversationId = "11111111-1111-4111-8111-111111111111";
    const updated = {
      id: conversationId,
      projectId: "22222222-2222-4222-8222-222222222222",
      name: "Updated summary name",
      activeProvider: "claude-local-main",
      archived: false,
      summary: {
        brief: "Brief", longTermGoal: "Goal", recentSummary: "Recent",
        updatedAt: "2026-06-21T01:02:03.000Z", partial: true,
      },
      createdAt: "2026-06-20T00:00:00.000Z",
      updatedAt: "2026-06-21T01:02:03.000Z",
    };
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: true, result: updated }), {
      status: 200, headers: { "content-type": "application/json" },
    }));
    const api = createBrowserApi({ fetch });

    await expect(api.summarizeConversation({ conversationId })).resolves.toEqual(updated);
    expect(fetch).toHaveBeenCalledWith("/api/rpc", expect.objectContaining({
      body: JSON.stringify({ method: "summarizeConversation", args: [{ conversationId }] }),
    }));
  });

  it("routes terminalCommand WebSocket events without falling through to RPC", () => {
    const socket = {
      onmessage: null as ((event: MessageEvent) => void) | null,
      onclose: null as (() => void) | null,
      close: vi.fn(),
    };
    const fetch = vi.fn();
    const api = createBrowserApi({
      fetch,
      createSocket: () => socket as unknown as WebSocket,
    });
    const listener = vi.fn();
    const unsubscribe = api.onTerminalCommand(listener);
    const payload = { terminalId: "t1", projectId: "p1", result: { exitCode: 0 } };

    socket.onmessage?.({ data: JSON.stringify({ type: "terminalCommand", payload }) } as MessageEvent);

    expect(listener).toHaveBeenCalledWith(payload);
    expect(fetch).not.toHaveBeenCalled();
    unsubscribe();
    expect(socket.close).toHaveBeenCalledOnce();
  });
});
