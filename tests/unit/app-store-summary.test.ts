import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { Conversation } from "@shared/types";
import { useAppStore } from "../../src/renderer/src/store/app-store";

const originalState = useAppStore.getState();
const conversationId = "11111111-1111-4111-8111-111111111111";
const otherConversationId = "33333333-3333-4333-8333-333333333333";

beforeAll(() => {
  Object.defineProperty(globalThis, "window", { configurable: true, value: {} });
});

afterEach(() => {
  useAppStore.setState(originalState, true);
  vi.restoreAllMocks();
});

describe("conversation summary state", () => {
  it("deduplicates an in-flight request and patches the returned conversation", async () => {
    let resolve!: (conversation: Conversation) => void;
    const request = new Promise<Conversation>((done) => { resolve = done; });
    const summarizeConversation = vi.fn(() => request);
    Object.defineProperty(window, "aiTerminal", {
      configurable: true,
      value: { summarizeConversation },
    });
    const conversation = makeConversation();
    useAppStore.setState({ conversations: [conversation] });

    const first = useAppStore.getState().summarizeConversation(conversationId);
    const duplicate = useAppStore.getState().summarizeConversation(conversationId);

    expect(summarizeConversation).toHaveBeenCalledTimes(1);
    expect(useAppStore.getState().summarizingConversationIds).toContain(conversationId);

    const updated = makeConversation({
      name: "自動摘要名稱",
      summary: {
        brief: "簡略摘要",
        longTermGoal: "長期目標",
        recentSummary: "近期摘要",
        updatedAt: "2026-06-21T04:05:06.000Z",
        partial: false,
      },
    });
    resolve(updated);
    await Promise.all([first, duplicate]);

    expect(useAppStore.getState().conversations).toEqual([updated]);
    expect(useAppStore.getState().summarizingConversationIds).not.toContain(conversationId);
  });

  it("preserves the existing summary and exposes a safe error when regeneration fails", async () => {
    Object.defineProperty(window, "aiTerminal", {
      configurable: true,
      value: { summarizeConversation: vi.fn().mockRejectedValue(new Error("summary unavailable")) },
    });
    const conversation = makeConversation({
      summary: {
        brief: "舊摘要",
        longTermGoal: "舊目標",
        recentSummary: "舊進度",
        updatedAt: "2026-06-20T04:05:06.000Z",
        partial: false,
      },
    });
    useAppStore.setState({ conversations: [conversation], error: "unrelated failure" });

    await useAppStore.getState().summarizeConversation(conversationId);

    expect(useAppStore.getState().conversations[0]).toBe(conversation);
    expect(useAppStore.getState().summaryErrors[conversationId]).toBe("summary unavailable");
    expect(useAppStore.getState().error).toBe("unrelated failure");
    expect(useAppStore.getState().summarizingConversationIds).toEqual([]);
  });

  it("isolates concurrent summary errors and clears only the requested conversation", async () => {
    const rejectors = new Map<string, (error: Error) => void>();
    Object.defineProperty(window, "aiTerminal", {
      configurable: true,
      value: {
        summarizeConversation: vi.fn(({ conversationId: id }: { conversationId: string }) =>
          new Promise<Conversation>((_resolve, reject) => rejectors.set(id, reject))),
      },
    });
    useAppStore.setState({
      conversations: [makeConversation(), makeConversation({ id: otherConversationId })],
      error: "unrelated failure",
      summaryErrors: { [conversationId]: "stale first", [otherConversationId]: "stale second" },
    });

    const first = useAppStore.getState().summarizeConversation(conversationId);
    expect(useAppStore.getState().summaryErrors).toEqual({ [otherConversationId]: "stale second" });
    const second = useAppStore.getState().summarizeConversation(otherConversationId);
    expect(useAppStore.getState().summaryErrors).toEqual({});
    expect(useAppStore.getState().error).toBe("unrelated failure");

    rejectors.get(otherConversationId)!(new Error("second failed"));
    rejectors.get(conversationId)!(new Error("first failed"));
    await Promise.all([first, second]);

    expect(useAppStore.getState().summaryErrors).toEqual({
      [conversationId]: "first failed",
      [otherConversationId]: "second failed",
    });
    useAppStore.getState().clearSummaryError(conversationId);
    expect(useAppStore.getState().summaryErrors).toEqual({ [otherConversationId]: "second failed" });
  });
});

function makeConversation(patch: Partial<Conversation> = {}): Conversation {
  return {
    id: conversationId,
    projectId: "22222222-2222-4222-8222-222222222222",
    name: "原始名稱",
    activeProvider: "codex-official",
    primaryProvider: "codex-official",
    claudeModel: "default",
    continuedFromConversationId: null,
    handoffSourceConversationId: null,
    archived: false,
    summary: null,
    createdAt: "2026-06-20T00:00:00.000Z",
    updatedAt: "2026-06-20T00:00:00.000Z",
    ...patch,
  };
}
