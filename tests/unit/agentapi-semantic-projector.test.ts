import { describe, expect, it, vi } from "vitest";
import { AppEventBus } from "../../src/main/core/event-bus";
import { SessionSemanticStore } from "../../src/main/core/session-semantic-store";
import { PendingInteractionStore } from "../../src/main/core/agentapi-pending-interaction-store";
import {
  AgentSemanticProjector,
  identityFromAgentProfile,
  interactionFromProviderEvent,
} from "../../src/main/core/agentapi-semantic-projector";
import type { NormalizedEvent, AgentApiSessionWorldState } from "../../src/shared/types";

const TID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const PID = "11111111-1111-4111-8111-111111111111";
const TURN = "22222222-2222-4222-8222-222222222222";
const EVENT = "33333333-3333-4333-8333-333333333333";

function world(over: Partial<AgentApiSessionWorldState> = {}): AgentApiSessionWorldState {
  return {
    terminalId: TID,
    projectId: PID,
    displayName: "Codex Kimi",
    projectLabel: "coterm",
    agentProfile: "codex-local-big",
    canonicalState: "running",
    lifecycleStatus: "running",
    displayState: "running",
    source: "process",
    attentionNotificationId: null,
    lastTransitionAt: "2026-08-15T01:00:00.000Z",
    ageMs: 0,
    selected: true,
    scrollbackMode: "normal",
    ...over,
  };
}

function event(type: NormalizedEvent["type"], payload: Record<string, unknown>, summary: string = type): NormalizedEvent {
  return {
    id: EVENT,
    conversationId: "44444444-4444-4444-8444-444444444444",
    turnId: TURN,
    providerSessionId: "55555555-5555-4555-8555-555555555555",
    turnGroupId: null,
    type,
    createdAt: "2026-08-15T01:00:05.000Z",
    sequence: 1,
    summary,
    payload,
  };
}

function setup(session = world()) {
  const events = new AppEventBus();
  const semanticStore = new SessionSemanticStore(() => Date.parse("2026-08-15T01:00:10.000Z"));
  const pendingStore = new PendingInteractionStore();
  let sessions = [session];
  const worldListeners = new Set<(value: AgentApiSessionWorldState[]) => void>();
  const getTranscript = vi.fn().mockResolvedValue({
    terminalId: TID,
    provider: "codex",
    status: "ready",
    updatedAt: "2026-08-15T01:00:06.000Z",
    messages: [],
  });
  const projector = new AgentSemanticProjector({
    events,
    worldState: {
      getWorldState: () => sessions,
      onWorldChanged: (callback) => { worldListeners.add(callback); return () => worldListeners.delete(callback); },
    },
    semanticStore,
    pendingStore,
    getTranscript,
    getScreenText: () => "",
    now: () => Date.parse("2026-08-15T01:00:10.000Z"),
  });
  projector.start();
  return {
    events, semanticStore, pendingStore, projector, getTranscript,
    setWorld(next: AgentApiSessionWorldState[]) { sessions = next; for (const listener of worldListeners) listener(next); },
  };
}

describe("identityFromAgentProfile", () => {
  it("keeps harness and backend separate", () => {
    expect(identityFromAgentProfile("codex-local-max")).toMatchObject({ harness: "codex-cli", backend: "glm", profile: "codex-local-max" });
    expect(identityFromAgentProfile("claude-local-long2")).toMatchObject({ harness: "claude-code", backend: "qwen" });
    expect(identityFromAgentProfile("codex-official")).toMatchObject({ harness: "codex-cli", backend: "openai" });
    expect(identityFromAgentProfile("claude-official")).toMatchObject({ harness: "claude-code", backend: "anthropic" });
  });
});

describe("provider projection", () => {
  it("projects final assistant text into completed lastTurn", () => {
    const ctx = setup();
    ctx.events.emit("event", event("assistant.final", { terminalId: TID, text: "Adapter 已建立。318 tests passed." }, "Codex completed."));
    expect(ctx.semanticStore.get(TID)?.lastTurn).toMatchObject({
      status: "completed",
      summary: "Adapter 已建立。",
      finalText: "Adapter 已建立。318 tests passed.",
      source: "provider-event",
      confidence: 1,
    });
    ctx.projector.dispose();
  });

  it("creates and resolves a structured pending interaction", () => {
    const ctx = setup();
    ctx.events.emit("event", event("user_input.requested", {
      terminalId: TID,
      requestId: "req-1",
      questions: [{ question: "請選方案", options: [{ label: "方案一", description: "A" }, { label: "方案二", description: "B" }] }],
    }, "Codex needs input"));
    expect(ctx.pendingStore.getByTerminal(TID)).toMatchObject({
      id: "req-1",
      type: "choice",
      prompt: "請選方案",
      options: [{ id: "1", label: "方案一", description: "A" }, { id: "2", label: "方案二", description: "B" }],
    });
    expect(ctx.semanticStore.get(TID)?.pendingInteraction?.id).toBe("req-1");
    ctx.events.emit("event", event("user_input.resolved", { terminalId: TID, requestId: "req-1" }));
    expect(ctx.pendingStore.getByTerminal(TID)).toBeNull();
    expect(ctx.semanticStore.get(TID)?.pendingInteraction).toBeNull();
    ctx.projector.dispose();
  });
});

describe("transcript / PTY fallback", () => {
  it("uses turn_summary when present and works without recap when absent", async () => {
    const ctx = setup(world({ canonicalState: "done", displayState: "done" }));
    ctx.getTranscript.mockResolvedValueOnce({
      terminalId: TID,
      provider: "codex",
      status: "ready",
      messages: [{ role: "assistant", kind: "turn_summary", text: "Voice routing 完成。", timestamp: "2026-08-15T01:00:08.000Z" }],
    });
    await ctx.projector.refreshTranscript(TID);
    expect(ctx.semanticStore.get(TID)?.lastTurn).toMatchObject({ summary: "Voice routing 完成。", source: "native-transcript" });

    ctx.getTranscript.mockResolvedValueOnce({
      terminalId: TID,
      provider: "codex",
      status: "ready",
      messages: [{ role: "assistant", kind: "message", text: "No recap; final answer still available", timestamp: "2026-08-15T01:01:08.000Z" }],
    });
    await ctx.projector.refreshTranscript(TID);
    expect(ctx.semanticStore.get(TID)?.lastTurn.finalText).toBe("No recap; final answer still available");
    ctx.projector.dispose();
  });

  it("drops a stale async transcript result after terminal exit", async () => {
    let resolveTranscript!: (value: unknown) => void;
    const pending = new Promise((resolve) => { resolveTranscript = resolve; });
    const ctx = setup();
    ctx.getTranscript.mockReturnValueOnce(pending);
    const refresh = ctx.projector.refreshTranscript(TID);
    ctx.events.emit("terminalExit", { terminalId: TID, projectId: PID, exitCode: 0 });
    resolveTranscript({ terminalId: TID, status: "ready", provider: "codex", messages: [{ role: "assistant", text: "stale", timestamp: null }] });
    await refresh;
    expect(ctx.semanticStore.get(TID)).toBeNull();
    ctx.projector.dispose();
  });
});

describe("interactionFromProviderEvent", () => {
  it("maps an approval without inventing choices", () => {
    expect(interactionFromProviderEvent(event("approval.requested", { terminalId: TID, requestId: "a1", reason: "Run tests?" }, "Approval"), "approval"))
      .toMatchObject({ id: "a1", terminalId: TID, type: "approval", prompt: "Run tests?", options: [] });
  });
});
