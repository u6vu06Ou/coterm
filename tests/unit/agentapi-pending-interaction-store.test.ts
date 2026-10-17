import { describe, expect, it } from "vitest";
import { PendingInteractionStore } from "../../src/main/core/agentapi-pending-interaction-store";
import type { AgentApiPendingInteraction } from "../../src/shared/types";

const TID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

function pending(id = "p1"): AgentApiPendingInteraction {
  return {
    id,
    terminalId: TID,
    type: "choice",
    prompt: "Choose one",
    options: [{ id: "1", label: "One" }, { id: "2", label: "Two" }],
    source: "provider-event",
    createdAt: "2026-08-15T00:00:00.000Z",
  };
}

describe("PendingInteractionStore", () => {
  it("creates, replaces, resolves, and clears per terminal", () => {
    const store = new PendingInteractionStore();
    store.set(pending("p1"));
    expect(store.getByTerminal(TID)?.id).toBe("p1");
    store.set(pending("p2"));
    expect(store.getActive()).toHaveLength(1);
    expect(store.getByTerminal(TID)?.id).toBe("p2");
    store.resolve("p2");
    expect(store.getByTerminal(TID)).toBeNull();
    store.set(pending("p3"));
    store.clearForTerminal(TID);
    expect(store.getActive()).toEqual([]);
  });
});
