import { describe, expect, it } from "vitest";
import { SessionSemanticStore, semanticSourceRank } from "../../src/main/core/session-semantic-store";

const TID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

describe("SessionSemanticStore", () => {
  it("keeps semantic state separate and addressable by terminalId", () => {
    const store = new SessionSemanticStore(() => Date.parse("2026-08-15T00:00:00.000Z"));
    store.updateIdentity(TID, { harness: "codex-cli", backend: "glm", model: "my-glm-flash", profile: "codex-local-main" });
    store.updateTask(TID, { summary: "Implement voice routing", phase: "running" }, {
      source: "provider-event", confidence: 0.99,
    });
    expect(store.get(TID)).toMatchObject({
      terminalId: TID,
      identity: { harness: "codex-cli", backend: "glm", profile: "codex-local-main" },
      task: { summary: "Implement voice routing", source: "provider-event", confidence: 0.99 },
    });
  });

  it("uses provider > transcript > detector > screen precedence for equal-time observations", () => {
    expect(semanticSourceRank("provider-event")).toBeGreaterThan(semanticSourceRank("native-transcript"));
    expect(semanticSourceRank("native-transcript")).toBeGreaterThan(semanticSourceRank("agent-detector"));
    expect(semanticSourceRank("agent-detector")).toBeGreaterThan(semanticSourceRank("screen-fallback"));
    const store = new SessionSemanticStore();
    const at = "2026-08-15T01:00:00.000Z";
    store.updateTask(TID, { summary: "provider" }, { source: "provider-event", confidence: 1, observedAt: at });
    expect(store.updateTask(TID, { summary: "screen" }, { source: "screen-fallback", confidence: 0.5, observedAt: at })).toBe(false);
    expect(store.get(TID)?.task.summary).toBe("provider");
  });

  it("never lets a stale observation roll a newer field backwards", () => {
    const store = new SessionSemanticStore();
    store.updateLastTurn(TID, { status: "completed", summary: "new" }, {
      source: "native-transcript", confidence: 0.9, observedAt: "2026-08-15T01:00:10.000Z",
    });
    expect(store.updateLastTurn(TID, { status: "running", summary: "old provider event" }, {
      source: "provider-event", confidence: 1, observedAt: "2026-08-15T01:00:00.000Z",
    })).toBe(false);
    expect(store.get(TID)?.lastTurn).toMatchObject({ status: "completed", summary: "new" });
  });

  it("allows a genuinely newer observation to advance a prior high-confidence turn", () => {
    const store = new SessionSemanticStore();
    store.updateLastTurn(TID, { status: "completed", summary: "turn one" }, {
      source: "provider-event", confidence: 1, observedAt: "2026-08-15T01:00:00.000Z",
    });
    store.updateLastTurn(TID, { status: "completed", summary: "turn two fallback" }, {
      source: "native-transcript", confidence: 0.9, observedAt: "2026-08-15T01:05:00.000Z",
    });
    expect(store.get(TID)?.lastTurn.summary).toBe("turn two fallback");
  });
});
