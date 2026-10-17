import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { Conversation } from "@shared/types";
import { useAppStore } from "../../src/renderer/src/store/app-store";

const originalState = useAppStore.getState();
const projectId = "22222222-2222-4222-8222-222222222222";
const conversationId = "11111111-1111-4111-8111-111111111111";
const otherConversationId = "33333333-3333-4333-8333-333333333333";

beforeAll(() => {
  Object.defineProperty(globalThis, "window", { configurable: true, value: {} });
});

afterEach(() => {
  useAppStore.setState(originalState, true);
  vi.restoreAllMocks();
});

function makeConversation(patch: Partial<Conversation> = {}): Conversation {
  return {
    id: conversationId,
    projectId,
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

describe("archiveConversation repro", () => {
  it("scenario A: archiving the LAST conversation moves it to archived", async () => {
    const archived = makeConversation({ archived: true });
    const archiveConversation = vi.fn(() => Promise.resolve(archived));
    Object.defineProperty(window, "aiTerminal", {
      configurable: true,
      value: { archiveConversation },
    });

    useAppStore.setState({
      conversations: [makeConversation()],
      panes: [{
        id: "pane-1",
        projectId,
        conversationId,
        selectedProvider: "codex-official",
        events: [],
        runningTurnId: null,
        runningCouncilGroupId: null,
        loadToken: 0,
        terminalId: null,
      }],
      activePaneId: "pane-1",
    });

    await useAppStore.getState().archiveConversation(conversationId);

    console.log("SCENARIO A conversations:", useAppStore.getState().conversations.length);
    console.log("SCENARIO A archived:", useAppStore.getState().archivedConversations.length);
    // Terminal-first overhaul: archiveConversation moves the conversation to
    // archivedConversations. The dormant pane model is no longer cleared.
    expect(useAppStore.getState().conversations.length).toBe(0);
    expect(useAppStore.getState().archivedConversations.length).toBe(1);
  });

  it("scenario B: archiving when selectConversation IPC throws should NOT crash archive", async () => {
    const archived = makeConversation({ archived: true });
    const other = makeConversation({ id: otherConversationId });
    const archiveConversation = vi.fn(() => Promise.resolve(archived));
    const listEvents = vi.fn(() => Promise.reject(new Error("listEvents boom")));
    const getTerminalWorkspace = vi.fn(() => Promise.reject(new Error("workspace boom")));
    const getConversationSession = vi.fn(() => Promise.reject(new Error("session boom")));
    Object.defineProperty(window, "aiTerminal", {
      configurable: true,
      value: { archiveConversation, listEvents, getTerminalWorkspace, getConversationSession },
    });

    useAppStore.setState({
      conversations: [makeConversation(), other],
      panes: [{
        id: "pane-1",
        projectId,
        conversationId,
        selectedProvider: "codex-official",
        events: [],
        runningTurnId: null,
        runningCouncilGroupId: null,
        loadToken: 0,
        terminalId: null,
      }],
      activePaneId: "pane-1",
    });

    let threw = false;
    try {
      await useAppStore.getState().archiveConversation(conversationId);
    } catch (error) {
      threw = true;
      console.log("SCENARIO B archive threw:", (error as Error).message);
    }
    console.log("SCENARIO B threw:", threw);
    console.log("SCENARIO B error state:", useAppStore.getState().error);
    console.log("SCENARIO B pane.conversationId:", useAppStore.getState().panes[0]!.conversationId);
    expect(useAppStore.getState().conversations.length).toBe(1);
  });
});
