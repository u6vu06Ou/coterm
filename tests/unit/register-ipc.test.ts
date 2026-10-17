import { beforeEach, describe, expect, it, vi } from "vitest";
import { IPC } from "../../src/shared/ipc";
import type { AppOperations } from "../../src/main/core/app-operations";
import { AppEventBus } from "../../src/main/core/event-bus";

const handlers = new Map<string, (...args: unknown[]) => unknown>();
const { audit } = vi.hoisted(() => ({ audit: vi.fn() }));

vi.mock("../../src/main/core/logger", () => ({
  logger: { audit, warn: vi.fn(), error: vi.fn() },
}));

vi.mock("electron", () => ({
  app: { getVersion: () => "1.0.0", getPath: () => "D:\\tmp", quit: vi.fn(), relaunch: vi.fn() },
  BrowserWindow: { getAllWindows: () => [] },
  dialog: { showSaveDialog: vi.fn(), showOpenDialog: vi.fn() },
  ipcMain: {
    handle: (channel: string, listener: (...args: unknown[]) => unknown) => handlers.set(channel, listener),
    removeHandler: (channel: string) => handlers.delete(channel),
    on: vi.fn(), removeListener: vi.fn(),
  },
  shell: { showItemInFolder: vi.fn() },
}));

describe("registerIpc", () => {
  beforeEach(() => {
    handlers.clear();
    audit.mockClear();
  });

  it("binds the conversation summary operation", async () => {
    const summarizeConversation = vi.fn().mockResolvedValue({
      id: "11111111-1111-4111-8111-111111111111",
      projectId: "22222222-2222-4222-8222-222222222222",
      name: "Updated",
      activeProvider: "claude-local-main",
      archived: false,
      summary: { brief: "Brief", longTermGoal: "Goal", recentSummary: "Recent", updatedAt: "2026-06-21T01:02:03.000Z", partial: false },
      createdAt: "2026-06-20T00:00:00.000Z",
      updatedAt: "2026-06-21T01:02:03.000Z",
    });
    const { registerIpc } = await import("../../src/main/ipc/register-ipc");
    const inert = vi.fn();
    registerIpc({
      repository: {} as never, database: {} as never, runs: {} as never,
      council: {} as never, approvals: {} as never, terminals: {} as never,
      events: { on: inert, off: inert } as never,
      operations: {
        summarizeConversation,
        onDockLayoutChanged: () => () => undefined,
        onAttentionChanged: () => () => undefined,
        onUsageChanged: () => () => undefined,
      } as unknown as AppOperations,
    });

    const handler = handlers.get(IPC.conversationsSummarize);
    expect(handler).toBeDefined();
    await expect(handler?.({}, { conversationId: "11111111-1111-4111-8111-111111111111" }))
      .resolves.toMatchObject({ name: "Updated", summary: { partial: false } });
    expect(summarizeConversation).toHaveBeenCalledWith({ conversationId: "11111111-1111-4111-8111-111111111111" });
  });

  it("forwards UI action records through the desktop IPC", async () => {
    const { registerIpc } = await import("../../src/main/ipc/register-ipc");
    const inert = vi.fn();
    const recordUiAction = vi.fn();
    registerIpc({
      repository: {} as never, database: {} as never, runs: {} as never,
      council: {} as never, approvals: {} as never, terminals: {} as never,
      events: { on: inert, off: inert } as never,
      operations: {
        recordUiAction,
        onDockLayoutChanged: () => () => undefined,
        onAttentionChanged: () => () => undefined,
        onUsageChanged: () => () => undefined,
      } as unknown as AppOperations,
    });

    const handler = handlers.get(IPC.uiActionRecord);
    const input = {
      actionId: "topbar.settings.open",
      surface: "desktop",
      identified: true,
      controlType: "button",
      interaction: "click",
    };
    await expect(handler?.({}, input)).resolves.toBeUndefined();
    expect(recordUiAction).toHaveBeenCalledWith(input);
  });

  it("persists a complete privacy-safe terminal.command.finished payload", async () => {
    const { registerIpc } = await import("../../src/main/ipc/register-ipc");
    const events = new AppEventBus();
    const appendTerminalEvent = vi.fn().mockResolvedValue({});
    const unregister = registerIpc({
      repository: { appendTerminalEvent } as never,
      database: {} as never,
      runs: {} as never,
      council: {} as never,
      approvals: {} as never,
      terminals: {} as never,
      events,
      operations: {
        onDockLayoutChanged: () => () => undefined,
        onAttentionChanged: () => () => undefined,
        onUsageChanged: () => () => undefined,
      } as unknown as AppOperations,
    });
    const result = {
      id: "11111111-1111-4111-8111-111111111111",
      cwd: "D:\\project",
      command: "git status",
      exitCode: 0,
      startedAt: "2026-07-14T00:00:00.000Z",
      endedAt: "2026-07-14T00:00:00.010Z",
      durationMs: 10,
    };

    events.emit("terminalCommand", {
      terminalId: "22222222-2222-4222-8222-222222222222",
      projectId: "33333333-3333-4333-8333-333333333333",
      result,
    });

    await vi.waitFor(() => expect(appendTerminalEvent).toHaveBeenCalledOnce());
    expect(appendTerminalEvent).toHaveBeenCalledWith(expect.objectContaining({
      type: "terminal.command.finished",
      payload: result,
    }));
    await unregister();
  });
});
