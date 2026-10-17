import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AppEventBus } from "../../src/main/core/event-bus";
import { HandoffManager } from "../../src/main/core/handoff-manager";
import { RunCoordinator } from "../../src/main/core/run-coordinator";
import type { CheckpointManager } from "../../src/main/core/checkpoint-manager";
import type {
  ProviderAdapter,
  ProviderRunContext,
  ProviderRunResult,
} from "../../src/main/providers/types";
import { ProviderError } from "../../src/main/providers/types";
import { AppDatabase } from "../../src/main/storage/database";
import { Repository } from "../../src/main/storage/repository";

class LaneAdapter implements ProviderAdapter {
  readonly profiles = ["claude-official", "codex-official"] as const;
  readonly calls: Array<{
    profileId: string;
    nativeSessionId: string | null;
    prompt: string;
    permissionPreset: string;
    nativeWorkflow: boolean;
  }> = [];

  async run(context: ProviderRunContext): Promise<ProviderRunResult> {
    this.calls.push({
      profileId: context.profileId,
      nativeSessionId: context.nativeSessionId,
      prompt: context.prompt,
      permissionPreset: context.permissionPreset,
      nativeWorkflow: context.nativeWorkflow === true,
    });
    const finalText = `completed by ${context.profileId}`;
    await context.emit({
      type: "assistant.final",
      summary: "Completed.",
      payload: { text: finalText, provider: context.profileId },
    });
    return {
      nativeSessionId:
        context.nativeSessionId ?? `session-${context.profileId}`,
      finalText,
    };
  }
}

class PartialFailureAdapter implements ProviderAdapter {
  readonly profiles = ["codex-official"] as const;

  async run(context: ProviderRunContext): Promise<ProviderRunResult> {
    await context.emit({
      type: "assistant.progress",
      summary: "Partial output.",
      payload: { text: "half done" },
    });
    throw new Error("connection lost");
  }
}

class CancelThenResumeAdapter implements ProviderAdapter {
  readonly profiles = ["claude-official"] as const;
  readonly calls: Array<{ nativeSessionId: string | null }> = [];
  private callCount = 0;

  async run(context: ProviderRunContext): Promise<ProviderRunResult> {
    this.calls.push({ nativeSessionId: context.nativeSessionId });
    // Claude reports its session id at the start of every run, before any work.
    await context.emit({
      type: "assistant.progress",
      summary: "Claude session initialized.",
      payload: { sessionId: "sess-init-abc" },
    });
    this.callCount += 1;
    if (this.callCount === 1) {
      // User hits stop (or a 529) after the session exists but before completion.
      throw new ProviderError("cancelled", "Claude run was cancelled.");
    }
    await context.emit({
      type: "assistant.final",
      summary: "Completed.",
      payload: { text: "resumed", provider: context.profileId },
    });
    return { nativeSessionId: "sess-init-abc", finalText: "resumed" };
  }
}

class EarlySessionFailureAdapter implements ProviderAdapter {
  readonly profiles = ["codex-official"] as const;

  async run(context: ProviderRunContext): Promise<ProviderRunResult> {
    await context.emit({
      type: "assistant.progress",
      summary: "Codex session initialized.",
      payload: { sessionId: "codex-thread-abc", sessionOnly: true },
    });
    throw new ProviderError("protocol", "app-server crashed");
  }
}

class AuthenticationFailureAdapter implements ProviderAdapter {
  readonly profiles = ["claude-official", "claude-local-long", "codex-official"] as const;

  run(): Promise<ProviderRunResult> {
    return Promise.reject(new ProviderError(
      "auth_expired",
      "upstream 401 ANTHROPIC_AUTH_TOKEN=super-secret-value D:\\Users\\User\\secret",
    ));
  }
}

class BlockingAdapter implements ProviderAdapter {
  readonly profiles = ["claude-official", "codex-official"] as const;
  readonly started: Promise<void>;
  private release!: () => void;
  private markStarted!: () => void;

  constructor() {
    this.started = new Promise<void>((resolve) => {
      this.markStarted = resolve;
    });
  }

  finish(): void {
    this.release();
  }

  async run(context: ProviderRunContext): Promise<ProviderRunResult> {
    this.markStarted();
    await new Promise<void>((resolve) => {
      this.release = resolve;
    });
    await context.emit({
      type: "assistant.final",
      summary: "Completed.",
      payload: { text: "done", provider: context.profileId },
    });
    return { nativeSessionId: "blocking-session", finalText: "done" };
  }
}

describe("RunCoordinator provider lanes", () => {
  let directory: string;
  let database: AppDatabase;
  let repository: Repository;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "ai-terminal-lanes-"));
    database = new AppDatabase(join(directory, "state.sqlite"));
    await database.open();
    repository = new Repository(database);
  });

  afterEach(async () => {
    database.close();
    await rm(directory, { recursive: true, force: true });
  });

  it("switches providers with handoffs and resumes the original native lane", async () => {
    const project = await repository.createProject("lanes", directory);
    const conversation = await repository.createConversation(
      project.id,
      "lanes",
      "claude-official",
    );
    const adapter = new LaneAdapter();
    const coordinator = new RunCoordinator(
      repository,
      new AppEventBus(),
      [adapter],
      new HandoffManager(repository),
    );

    await coordinator.send({
      conversationId: conversation.id,
      profileId: "claude-official",
      text: "Start in Claude.",
      attachmentIds: [],
    });
    await waitForFinal(repository, conversation.id, 1);

    await coordinator.send({
      conversationId: conversation.id,
      profileId: "codex-official",
      text: "Continue in Codex.",
      attachmentIds: [],
    });
    await waitForFinal(repository, conversation.id, 2);

    await coordinator.send({
      conversationId: conversation.id,
      profileId: "claude-official",
      text: "Return to Claude.",
      attachmentIds: [],
    });
    await waitForFinal(repository, conversation.id, 3);

    expect(adapter.calls).toHaveLength(3);
    expect(adapter.calls[0]).toMatchObject({
      profileId: "claude-official",
      nativeSessionId: null,
      permissionPreset: "ask",
    });
    expect(adapter.calls[1]?.prompt).toContain("<provider_handoff");
    expect(adapter.calls[1]?.nativeSessionId).toBeNull();
    expect(adapter.calls[2]).toMatchObject({
      profileId: "claude-official",
      nativeSessionId: "session-claude-official",
    });
    expect(adapter.calls[2]?.prompt).toContain("NEW USER REQUEST");
    expect(
      database.queryOne<{ count: number }>("SELECT COUNT(*) AS count FROM provider_sessions")
        ?.count,
    ).toBe(2);
    expect(
      database.queryOne<{ count: number }>("SELECT COUNT(*) AS count FROM handoffs")?.count,
    ).toBe(2);
    expect(repository.getConversation(conversation.id)?.activeProvider).toBe("claude-official");

    await coordinator.dispose();
  });

  it("creates pre before provider.run and post after every successful turn", async () => {
    const project = await repository.createProject("checkpoint-success", directory);
    const conversation = await repository.createConversation(
      project.id,
      "checkpoint-success",
      "claude-official",
    );
    const adapter = new LaneAdapter();
    const checkpointer = {
      createTurnCheckpoint: vi.fn(() => {
        expect(adapter.calls).toHaveLength(0);
        return Promise.resolve(null);
      }),
      finalizeTurnCheckpoint: vi.fn(() => {
        expect(adapter.calls).toHaveLength(1);
        return Promise.resolve(null);
      }),
    };
    const coordinator = new RunCoordinator(
      repository,
      new AppEventBus(),
      [adapter],
      new HandoffManager(repository),
      checkpointer as unknown as CheckpointManager,
    );

    const { turnId } = await coordinator.send({
      conversationId: conversation.id,
      profileId: "claude-official",
      text: "checkpoint me",
      attachmentIds: [],
    });
    await waitForFinal(repository, conversation.id, 1);
    await vi.waitFor(() => expect(checkpointer.finalizeTurnCheckpoint).toHaveBeenCalledOnce(), { timeout: 5_000 });
    expect(checkpointer.createTurnCheckpoint).toHaveBeenCalledWith({
      turnId,
      conversationId: conversation.id,
      projectId: project.id,
      worktreeId: null,
      phase: "pre",
    });
    expect(checkpointer.finalizeTurnCheckpoint).toHaveBeenCalledWith({
      turnId,
      conversationId: conversation.id,
      projectId: project.id,
      worktreeId: null,
      phase: "post",
    });
    await coordinator.dispose();
  });

  it.each([
    ["error", new PartialFailureAdapter(), "error"],
    ["cancel", new CancelThenResumeAdapter(), "warning"],
  ] as const)("finalizes a post checkpoint after a provider %s", async (_label, adapter, terminalEvent) => {
    const project = await repository.createProject(`checkpoint-${_label}`, directory);
    const conversation = await repository.createConversation(
      project.id,
      `checkpoint-${_label}`,
      adapter.profiles[0],
    );
    const checkpointer = {
      createTurnCheckpoint: vi.fn(() => Promise.resolve(null)),
      finalizeTurnCheckpoint: vi.fn(() => Promise.resolve(null)),
    };
    const coordinator = new RunCoordinator(
      repository,
      new AppEventBus(),
      [adapter],
      new HandoffManager(repository),
      checkpointer as unknown as CheckpointManager,
    );
    await coordinator.send({
      conversationId: conversation.id,
      profileId: adapter.profiles[0],
      text: "finish through finally",
      attachmentIds: [],
    });
    await vi.waitFor(
      () => {
        expect(repository.listEvents(conversation.id).some((event) => event.type === terminalEvent)).toBe(true);
        expect(checkpointer.finalizeTurnCheckpoint).toHaveBeenCalledOnce();
      },
      { timeout: 5_000 },
    );
    expect(checkpointer.createTurnCheckpoint).toHaveBeenCalledOnce();
    await coordinator.dispose();
  });

  it("keeps a successful turn successful when both checkpoint hooks fail", async () => {
    const project = await repository.createProject("checkpoint-hook-failure", directory);
    const conversation = await repository.createConversation(
      project.id,
      "checkpoint-hook-failure",
      "claude-official",
    );
    const adapter = new LaneAdapter();
    const checkpointer = {
      createTurnCheckpoint: vi.fn(() => Promise.reject(new Error("pre failed"))),
      finalizeTurnCheckpoint: vi.fn(() => Promise.reject(new Error("post failed"))),
    };
    const coordinator = new RunCoordinator(
      repository,
      new AppEventBus(),
      [adapter],
      new HandoffManager(repository),
      checkpointer as unknown as CheckpointManager,
    );
    await coordinator.send({
      conversationId: conversation.id,
      profileId: "claude-official",
      text: "provider still runs",
      attachmentIds: [],
    });
    await waitForFinal(repository, conversation.id, 1);
    await vi.waitFor(() => expect(checkpointer.finalizeTurnCheckpoint).toHaveBeenCalledOnce(), { timeout: 5_000 });
    expect(adapter.calls).toHaveLength(1);
    expect(repository.listEvents(conversation.id).at(-1)?.type).toBe("assistant.final");
    await coordinator.dispose();
  });

  it("passes an approved native Workflow unchanged and rejects missing approval", async () => {
    const project = await repository.createProject("ultracode", directory);
    const conversation = await repository.createConversation(
      project.id,
      "ultracode",
      "claude-official",
    );
    const adapter = new LaneAdapter();
    const coordinator = new RunCoordinator(
      repository,
      new AppEventBus(),
      [adapter],
      new HandoffManager(repository),
    );

    await coordinator.send({
      conversationId: conversation.id,
      profileId: "claude-official",
      text: "ultracode 調查並修復問題",
      attachmentIds: [],
      nativeWorkflow: true,
    });
    await waitForFinal(repository, conversation.id, 1);

    expect(adapter.calls[0]).toMatchObject({
      prompt: "ultracode 調查並修復問題",
      nativeWorkflow: true,
    });
    expect(repository.listEvents(conversation.id)[0]?.payload.text).toBe("ultracode 調查並修復問題");

    await expect(coordinator.send({
      conversationId: conversation.id,
      profileId: "claude-official",
      text: "/goal 未核准",
      attachmentIds: [],
    })).rejects.toThrow("Native Workflow requires explicit approval");
    expect(adapter.calls).toHaveLength(1);

    await expect(coordinator.send({
      conversationId: conversation.id,
      profileId: "claude-official",
      text: "ordinary chat",
      attachmentIds: [],
      nativeWorkflow: true,
    })).rejects.toThrow("Native Workflow approval is valid only for workflow commands");
    expect(adapter.calls).toHaveLength(1);

    await expect(coordinator.send({
      conversationId: conversation.id,
      profileId: "codex-official",
      text: "ultracode 不可用於 Codex",
      attachmentIds: [],
      nativeWorkflow: true,
    })).rejects.toThrow("Native Workflow is available only for Claude profiles");
    await coordinator.dispose();
  });

  it("keeps the previous provider when a switched run fails after partial output", async () => {
    const project = await repository.createProject("rollback", directory);
    const conversation = await repository.createConversation(
      project.id,
      "rollback",
      "claude-official",
    );
    const coordinator = new RunCoordinator(
      repository,
      new AppEventBus(),
      [new PartialFailureAdapter()],
      new HandoffManager(repository),
    );

    await coordinator.send({
      conversationId: conversation.id,
      profileId: "codex-official",
      text: "Try Codex.",
      attachmentIds: [],
    });
    await vi.waitFor(() => {
      expect(repository.listEvents(conversation.id).some((event) => event.type === "error")).toBe(true);
    }, { timeout: 5_000 });

    expect(repository.getConversation(conversation.id)?.activeProvider).toBe("claude-official");
    const failure = repository.listEvents(conversation.id).find((event) => event.type === "error");
    expect(failure?.payload).toMatchObject({
      interrupted: true,
      message: "connection lost",
      attemptedProfile: "codex-official",
      activeProvider: "claude-official",
    });
    await coordinator.dispose();
  });

  it("keeps the native session id when a turn is cancelled, so the next turn resumes it", async () => {
    const project = await repository.createProject("resume-cancel", directory);
    const conversation = await repository.createConversation(
      project.id,
      "resume-cancel",
      "claude-official",
    );
    const adapter = new CancelThenResumeAdapter();
    const coordinator = new RunCoordinator(
      repository,
      new AppEventBus(),
      [adapter],
      new HandoffManager(repository),
    );

    await coordinator.send({
      conversationId: conversation.id,
      profileId: "claude-official",
      text: "First turn, then cancelled.",
      attachmentIds: [],
    });
    await vi.waitFor(() => {
      expect(repository.listEvents(conversation.id).some((event) => event.type === "warning")).toBe(true);
    });

    // The cancelled turn must still have persisted the native session id.
    expect(
      database.queryOne<{ native_session_id: string | null }>(
        "SELECT native_session_id FROM provider_sessions WHERE conversation_id = $c",
        { $c: conversation.id },
      )?.native_session_id,
    ).toBe("sess-init-abc");

    await coordinator.send({
      conversationId: conversation.id,
      profileId: "claude-official",
      text: "Second turn should resume.",
      attachmentIds: [],
    });
    await waitForFinal(repository, conversation.id, 1);

    // Without the fix this is null and the conversation silently forks a new session.
    expect(adapter.calls[1]?.nativeSessionId).toBe("sess-init-abc");

    await coordinator.dispose();
  });

  it("keeps a hidden native session id when a provider crashes before final output", async () => {
    const project = await repository.createProject("resume-crash", directory);
    const conversation = await repository.createConversation(
      project.id,
      "resume-crash",
      "codex-official",
    );
    const coordinator = new RunCoordinator(
      repository,
      new AppEventBus(),
      [new EarlySessionFailureAdapter()],
      new HandoffManager(repository),
    );

    await coordinator.send({
      conversationId: conversation.id,
      profileId: "codex-official",
      text: "Crash after thread creation.",
      attachmentIds: [],
    });
    await vi.waitFor(
      () => {
        expect(repository.listEvents(conversation.id).some((event) => event.type === "error")).toBe(true);
      },
      { timeout: 5_000 },
    );

    expect(
      database.queryOne<{ native_session_id: string | null }>(
        "SELECT native_session_id FROM provider_sessions WHERE conversation_id = $c",
        { $c: conversation.id },
      )?.native_session_id,
    ).toBe("codex-thread-abc");
    expect(repository.listEvents(conversation.id).map((event) => event.type))
      .toEqual(["user.message", "error"]);

    await coordinator.dispose();
  });

  it.each([
    ["claude-official", "claude-official"],
    ["claude-local-long", "claude-proxy"],
    ["codex-official", "codex-official"],
  ] as const)("persists one safe authentication error for %s", async (profileId, expectedMessage) => {
    const project = await repository.createProject(`auth-${profileId}`, directory);
    const conversation = await repository.createConversation(
      project.id,
      `auth-${profileId}`,
      profileId,
    );
    const coordinator = new RunCoordinator(
      repository,
      new AppEventBus(),
      [new AuthenticationFailureAdapter()],
      new HandoffManager(repository),
    );

    await coordinator.send({
      conversationId: conversation.id,
      profileId,
      text: "Continue.",
      attachmentIds: [],
    });
    await vi.waitFor(
      () => {
        expect(repository.listEvents(conversation.id).filter((event) => event.type === "error")).toHaveLength(1);
      },
      { timeout: 5_000 },
    );

    const failure = repository.listEvents(conversation.id).find((event) => event.type === "error");
    expect(failure?.payload).toMatchObject({ code: "auth_expired" });
    expect(failure?.summary).not.toContain("upstream 401");
    expect(failure?.summary).not.toContain("super-secret-value");
    expect(failure?.payload.message).not.toContain("upstream 401");
    expect(failure?.payload.message).not.toContain("super-secret-value");
    expect(failure?.payload.message).not.toContain("D:\\Users\\User");
    if (expectedMessage === "claude-official") {
      expect(failure?.summary).toContain("Windows");
      expect(failure?.summary).toContain("claude auth login");
      expect(failure?.payload.message).toContain("Windows");
      expect(failure?.payload.message).toContain("claude auth login");
    } else if (expectedMessage === "claude-proxy") {
      expect(failure?.summary).toContain("認證失敗");
      expect(failure?.payload.message).not.toContain("claude auth login");
      expect(failure?.payload.message).toContain("認證失敗");
    } else {
      expect(failure?.summary).toContain("原生互動");
      expect(failure?.summary).toContain("codex login");
      expect(failure?.payload.message).toContain("codex login");
      expect(failure?.payload.message).not.toContain("Claude");
      expect(failure?.payload.message).not.toContain("proxy");
      expect(failure?.payload.message).not.toContain(":8787");
    }
    await coordinator.dispose();
  });

  it("persists terminal-level status without invoking a provider", async () => {
    const project = await repository.createProject("status", directory);
    const conversation = await repository.createConversation(
      project.id,
      "status",
      "claude-official",
    );
    const coordinator = new RunCoordinator(
      repository,
      new AppEventBus(),
      [],
      new HandoffManager(repository),
    );

    await coordinator.command({ conversationId: conversation.id, command: "status" });

    const events = repository.listEvents(conversation.id);
    expect(events.map((event) => event.type)).toEqual(["user.message", "assistant.final"]);
    expect(events[0]?.payload).toMatchObject({ text: "/status", profileId: "coterm" });
    expect(events[1]?.payload.text).toContain("Automatic cross-provider fallback: disabled");
    await coordinator.dispose();
  });

  it("rejects a second agent turn while the conversation is already running", async () => {
    const project = await repository.createProject("lock", directory);
    const conversation = await repository.createConversation(
      project.id,
      "lock",
      "claude-official",
    );
    const adapter = new BlockingAdapter();
    const coordinator = new RunCoordinator(
      repository,
      new AppEventBus(),
      [adapter],
      new HandoffManager(repository),
    );

    await coordinator.send({
      conversationId: conversation.id,
      profileId: "claude-official",
      text: "first",
      attachmentIds: [],
    });
    await adapter.started;

    await expect(coordinator.send({
      conversationId: conversation.id,
      profileId: "codex-official",
      text: "second",
      attachmentIds: [],
    })).rejects.toThrow("This conversation already has a running agent turn.");
    expect(repository.listRunningConversationIds()).toEqual([conversation.id]);

    adapter.finish();
    await waitForFinal(repository, conversation.id, 1);
    await coordinator.dispose();
  });

  it("reports provider lane and compact status for the active session", async () => {
    const project = await repository.createProject("session", directory);
    const conversation = await repository.createConversation(
      project.id,
      "session",
      "codex-official",
    );
    const session = await repository.getOrCreateProviderSession(conversation.id, "codex-official");
    await repository.updateProviderSession(session.id, {
      nativeSessionId: "thread-123",
      status: "running",
    });
    const coordinator = new RunCoordinator(
      repository,
      new AppEventBus(),
      [],
      new HandoffManager(repository),
    );

    await coordinator.command({ conversationId: conversation.id, command: "session" });
    await coordinator.command({ conversationId: conversation.id, command: "compact-status" });

    const finals = repository.listEvents(conversation.id).filter((event) => event.type === "assistant.final");
    expect(finals[0]?.payload.text).toContain("- Conversation:");
    expect(finals[0]?.payload.text).toContain("- Active provider: `codex-official`");
    expect(finals[0]?.payload.text).toContain("- Native session/thread: `thread-123`");
    expect(finals[0]?.payload.text).toContain("- Provider session status: `running`");
    expect(finals[1]?.payload.text).toContain("## Compact status");
    expect(finals[1]?.payload.text).toContain("- Provider-native compaction: not exposed");
    expect(finals[1]?.payload.text).toContain("- Coterm summary: not recorded");
    await coordinator.dispose();
  });
});

async function waitForFinal(
  repository: Repository,
  conversationId: string,
  count: number,
): Promise<void> {
  await vi.waitFor(
    () => {
      expect(
        repository
          .listEvents(conversationId)
          .filter((event) => event.type === "assistant.final"),
      ).toHaveLength(count);
    },
    { timeout: 5_000, interval: 20 },
  );
}
