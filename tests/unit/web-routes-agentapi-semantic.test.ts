import { describe, expect, it, vi } from "vitest";
import { bindWebOperations } from "../../src/main/web/routes";
import type { AppOperations } from "../../src/main/core/app-operations";
import type { AppSettings, AgentApiSessionSemanticState } from "../../src/shared/types";

describe("web semantic session summary route", () => {
  it("refreshes the exact terminal before returning its bounded semantic state", async () => {
    const state: AgentApiSessionSemanticState = {
      terminalId: "terminal-1",
      identity: { harness: "codex-cli", backend: "openai", model: null, profile: "codex-official" },
      task: { summary: "Investigate mobile PTY pan", phase: "running", source: "screen-fallback", confidence: 0.45 },
      lastTurn: { status: null, summary: null, finalText: null, completedAt: null, source: null, confidence: 0 },
      pendingInteraction: null,
      updatedAt: "2026-08-15T00:00:00.000Z",
    };
    const refreshTranscript = vi.fn(async () => undefined);
    const api = bindWebOperations({} as AppOperations, undefined, {
      agentapiState: { getWorldState: () => [] },
      agentapiVoice: { turn: vi.fn(), interrupt: vi.fn() },
      agentapiSemantic: {
        projector: { refreshTranscript },
        store: { get: (terminalId: string) => terminalId === "terminal-1" ? state : null },
      },
      getSettings: () => ({ voice: {} }) as AppSettings,
    });

    await expect(api.getAgentApiSemanticState?.("terminal-1")).resolves.toEqual(state);
    expect(refreshTranscript).toHaveBeenCalledWith("terminal-1");
  });
});
