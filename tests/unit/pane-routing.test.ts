import { describe, expect, it } from "vitest";
import type { NormalizedEvent } from "@shared/types";
import { routeEvent, type WorkspacePane } from "../../src/renderer/src/store/app-store";

const conversationId = "11111111-1111-4111-8111-111111111111";
const turnId = "22222222-2222-4222-8222-222222222222";

describe("workspace pane event routing", () => {
  it("attaches observers to a run started on another device", () => {
    const started = event("user.message", 1);
    const finished = event("assistant.final", 2);
    const observer = pane("pane-1", conversationId, null);

    expect(routeEvent(observer, started).runningTurnId).toBe(turnId);
    expect(routeEvent(routeEvent(observer, started), finished).runningTurnId).toBeNull();
  });

  it("clears running state on a cancel warning but ignores mid-run warnings", () => {
    const running = pane("pane-1", conversationId, turnId);

    // A provider's mid-run warning (e.g. Codex context compaction) must NOT end the turn.
    const midRun = { ...event("warning", 1), payload: { message: "compacted" } };
    expect(routeEvent(running, midRun).runningTurnId).toBe(turnId);

    // A cancelled turn ends with a warning carrying terminal: true and must clear it.
    const cancelled = { ...event("warning", 2), payload: { terminal: true } };
    expect(routeEvent(running, cancelled).runningTurnId).toBeNull();

    const mismatchedTerminal = {
      ...event("warning", 3),
      turnId: "99999999-9999-4999-8999-999999999999",
      payload: { terminal: true },
    };
    expect(routeEvent(running, mismatchedTerminal).runningTurnId).toBeNull();
  });

  it("fans events out by conversation without leaking running state", () => {
    const event: NormalizedEvent = {
      id: "33333333-3333-4333-8333-333333333333",
      conversationId,
      turnId,
      providerSessionId: null,
      turnGroupId: null,
      type: "assistant.final",
      createdAt: new Date(0).toISOString(),
      sequence: 1,
      summary: "done",
      payload: {},
    };
    const running = pane("pane-1", conversationId, turnId);
    const observer = pane("pane-2", conversationId, null);
    const other = pane("pane-3", "44444444-4444-4444-8444-444444444444", null);

    expect(routeEvent(running, event)).toMatchObject({ runningTurnId: null, events: [event] });
    expect(routeEvent(observer, event)).toMatchObject({ runningTurnId: null, events: [event] });
    expect(routeEvent(other, event)).toBe(other);
    expect(routeEvent(routeEvent(observer, event), event).events).toHaveLength(1);
  });

  it("does not resurrect a completed turn when replay delivers its user event late", () => {
    const observer = pane("pane-1", conversationId, null);
    const finished = routeEvent(observer, event("assistant.final", 2));
    const replayed = routeEvent(finished, event("user.message", 1));

    expect(replayed.runningTurnId).toBeNull();
    expect(replayed.events.map((item) => item.sequence)).toEqual([1, 2]);
  });
});

function event(type: NormalizedEvent["type"], sequence: number): NormalizedEvent {
  return {
    id: `${sequence + 3}3333333-3333-4333-8333-333333333333`,
    conversationId,
    turnId,
    providerSessionId: null,
    turnGroupId: null,
    type,
    createdAt: new Date(sequence).toISOString(),
    sequence,
    summary: type,
    payload: {},
  };
}

function pane(id: string, currentConversationId: string, runningTurnId: string | null): WorkspacePane {
  return {
    id,
    projectId: null,
    conversationId: currentConversationId,
    selectedProvider: "codex-official",
    events: [],
    runningTurnId,
    runningCouncilGroupId: null,
    loadToken: 0,
    terminalId: null,
  };
}
