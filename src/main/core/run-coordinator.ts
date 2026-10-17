import type { HandoffPacket, MessageInput, TerminalCommandInput } from "@shared/types";
import type { AppEventBus } from "./event-bus";
import type { Repository } from "../storage/repository";
import type { ProviderAdapter, ProviderEvent } from "../providers/types";
import { ProviderError } from "../providers/types";
import type { HandoffManager } from "./handoff-manager";
import type { CheckpointManager } from "./checkpoint-manager";
import { safeErrorMessage } from "../security/redaction";
import { detectProviders } from "../providers/capability-detector";
import { buildActiveProfiles, localRouteAuthToken } from "../providers/profiles-config";
import { isNativeWorkflowIntent, textValue } from "@shared/value";
import { logger } from "./logger";

export class RunCoordinator {
  private readonly controllers = new Map<string, AbortController>();
  private readonly tasks = new Map<string, Promise<void>>();
  private readonly runningConversations = new Set<string>();

  constructor(
    private readonly repository: Repository,
    private readonly events: AppEventBus,
    private readonly adapters: ProviderAdapter[],
    private readonly handoffs: HandoffManager,
    private readonly checkpointer?: CheckpointManager,
  ) {}

  async send(input: MessageInput): Promise<{ turnId: string }> {
    const conversation = this.repository.getConversation(input.conversationId);
    if (!conversation) throw new Error("Conversation not found.");
    const project = this.repository.getProject(conversation.projectId);
    if (!project) throw new Error("Project not found.");
    if (input.profileId === "council") {
      throw new Error("Use the Council action for Council turns.");
    }
    const nativeWorkflowIntent = isNativeWorkflowIntent(input.profileId, input.text);
    if (input.nativeWorkflow && !input.profileId.startsWith("claude-")) {
      throw new Error("Native Workflow is available only for Claude profiles.");
    }
    if (input.nativeWorkflow && !nativeWorkflowIntent) {
      throw new Error("Native Workflow approval is valid only for workflow commands.");
    }
    if (nativeWorkflowIntent && !input.nativeWorkflow) {
      throw new Error("Native Workflow requires explicit approval.");
    }
    const adapter = this.adapters.find((candidate) => candidate.profiles.includes(input.profileId));
    if (!adapter) throw new Error(`Provider adapter unavailable: ${input.profileId}`);
    if (
      this.runningConversations.has(input.conversationId) ||
      this.repository.listRunningConversationIds().includes(input.conversationId)
    ) {
      throw new Error("This conversation already has a running agent turn.");
    }
    this.runningConversations.add(input.conversationId);
    const attachmentPaths = this.repository.getAttachmentPaths(
      input.conversationId,
      input.attachmentIds,
    );
    const selectedAttachments = this.repository
      .listAttachments(input.conversationId)
      .filter((attachment) => input.attachmentIds.includes(attachment.id));

    let turnId = "";
    let session: Awaited<ReturnType<Repository["getOrCreateProviderSession"]>>;
    try {
      session = await this.repository.getOrCreateProviderSession(
        input.conversationId,
        input.profileId,
      );
      turnId = await this.repository.startTurn(input.conversationId, session.id);
    } catch (error) {
      this.runningConversations.delete(input.conversationId);
      throw error;
    }
    // B — pre-turn checkpoint. Built after startTurn succeeds, before
    // adapter.run. A checkpoint failure is recorded as status='failed' and
    // NEVER affects turn status (the turn proceeds regardless). The
    // conversation path has no worktree binding (terminal-first UI is dormant
    // here), so worktreeId is null — PTY/worktree checkpoints use the
    // explicit CheckpointManager API instead.
    if (this.checkpointer) {
      await this.checkpointer
        .createTurnCheckpoint({
          turnId,
          conversationId: input.conversationId,
          projectId: project.id,
          worktreeId: null,
          phase: "pre",
        })
        .catch(() => {
          // createTurnCheckpoint already records a failed row on its own
          // errors; this catch is a last-resort guard so the turn never breaks.
          logger.warn("run", "checkpoint.pre.uncaught", "Pre-checkpoint uncaught error", {
            turnId,
            status: "failed",
          });
        });
    }
    const sourceProfile = conversation.activeProvider;
    const controller = new AbortController();
    this.controllers.set(turnId, controller);
    await this.emit(
      turnId,
      input.conversationId,
      session.id,
      null,
      "user.message",
      "User message.",
      {
        text: input.text,
        attachmentIds: input.attachmentIds,
        attachments: selectedAttachments,
        profileId: input.profileId,
      },
    );

    const task = (async () => {
      const finalHolder: { event: ProviderEvent | null } = { event: null };
      let hasPartialOutput = false;
      try {
        await this.repository.updateProviderSession(session.id, { status: "running" });
        let prompt = input.text;
        if (sourceProfile !== input.profileId && sourceProfile !== "council") {
          const packet = await this.handoffs.create(
            input.conversationId,
            sourceProfile,
            input.profileId,
            project.workspacePath,
          );
          prompt = `${this.handoffs.format(packet)}\n\nNEW USER REQUEST:\n${prompt}`;
          await this.emit(
            turnId,
            input.conversationId,
            session.id,
            null,
            "assistant.progress",
            `Handoff prepared from ${sourceProfile}.`,
            { handoff: packet },
          );
        }
        const result = await adapter.run({
          profileId: input.profileId,
          claudeModel: conversation.claudeModel,
          workspacePath: project.workspacePath,
          prompt,
          nativeSessionId: session.nativeSessionId,
          attachmentPaths,
          mode: "agent",
          permissionPreset: this.repository.getSettings().permissionPreset,
          signal: controller.signal,
          nativeWorkflow: input.nativeWorkflow === true,
          emit: async (providerEvent: ProviderEvent) => {
            // Claude reports its native session id at the start of the run. Persist it
            // immediately so a cancelled or failed turn still leaves the lane resumable;
            // otherwise the next message silently forks a fresh session and loses context.
            const reportedSessionId = providerEvent.payload?.sessionId;
            if (typeof reportedSessionId === "string" && reportedSessionId) {
              await this.repository.updateProviderSession(session.id, {
                nativeSessionId: reportedSessionId,
              });
            }
            if (providerEvent.payload?.sessionOnly === true) return;
            if (providerEvent.type === "assistant.progress") hasPartialOutput = true;
            if (providerEvent.type === "assistant.final") {
              finalHolder.event = providerEvent;
              return;
            }
            await this.emit(
              turnId,
              input.conversationId,
              session.id,
              null,
              providerEvent.type,
              providerEvent.summary,
              providerEvent.payload ?? {},
            );
          },
        });
        await this.repository.updateProviderSession(session.id, {
          nativeSessionId: result.nativeSessionId,
          status: "idle",
        });
        await this.repository.setActiveProvider(input.conversationId, input.profileId);
        await this.repository.completeTurn(turnId, "completed");
        this.runningConversations.delete(input.conversationId);
        const pendingFinal = finalHolder.event;
        await this.emit(
          turnId,
          input.conversationId,
          session.id,
          null,
          "assistant.final",
          pendingFinal?.summary ?? `${input.profileId} completed.`,
          {
            ...(pendingFinal?.payload ?? { text: result.finalText }),
            provider: input.profileId,
            usage: result.tokenUsage ?? pendingFinal?.payload?.usage ?? null,
          },
        );
      } catch (error) {
        const cancelled =
          controller.signal.aborted || (error instanceof ProviderError && error.code === "cancelled");
        const authenticationFailure =
          error instanceof ProviderError && error.code === "auth_expired";
        const authenticationMessage = authenticationFailure
          ? input.profileId === "claude-official"
            ? "Claude 登入已失效。請在 Windows 主機或「原生互動」終端執行 `claude auth login` 後再試。"
            : input.profileId.startsWith("claude-")
              ? "Claude 代理服務認證失敗，請檢查本機代理服務後再試。"
              : input.profileId === "codex-official"
                ? "Codex 登入已失效。請在「原生互動」終端執行 `codex login` 後再試。"
                : null
          : null;
        const failureMessage = authenticationMessage ?? safeErrorMessage(error);
        await this.repository.updateProviderSession(session.id, {
          status: cancelled ? "idle" : "failed",
        });
        await this.repository.completeTurn(turnId, cancelled ? "cancelled" : "failed");
        this.runningConversations.delete(input.conversationId);
        try {
          await this.emit(
            turnId,
            input.conversationId,
            session.id,
            null,
            cancelled ? "warning" : "error",
            cancelled
              ? hasPartialOutput ? "Run cancelled after partial output." : "Run cancelled."
              : authenticationMessage ? authenticationMessage
              : hasPartialOutput ? "Provider run failed after partial output." : "Provider run failed.",
            {
              code: error instanceof ProviderError ? error.code : "unknown",
              message: failureMessage,
              interrupted: hasPartialOutput,
              attemptedProfile: input.profileId,
              activeProvider: sourceProfile,
              terminal: true,
            },
          );
        } catch (emitError) {
          try {
            await this.emit(
              turnId,
              input.conversationId,
              session.id,
              null,
              "error",
              "Provider run failed (terminal notification also failed).",
              { code: "terminal_emit_failed", message: safeErrorMessage(emitError), terminal: true },
            );
          } catch {
            /* nothing more we can do; finally still clears the guard */
          }
        }
      } finally {
        this.controllers.delete(turnId);
        this.runningConversations.delete(input.conversationId);
        // B — post-turn checkpoint. Finalized on EVERY exit (success/error/
        // cancel) so undo/redo has a complete chain. Same safety: failure is
        // recorded as status='failed' and never affects turn status.
        if (this.checkpointer) {
          await this.checkpointer
            .finalizeTurnCheckpoint({
              turnId,
              conversationId: input.conversationId,
              projectId: project.id,
              worktreeId: null,
              phase: "post",
            })
            .catch(() => {
              logger.warn("run", "checkpoint.post.uncaught", "Post-checkpoint uncaught error", {
                turnId,
                status: "failed",
              });
            });
        }
      }
    })();
    this.tasks.set(turnId, task);
    const cleanupTask = () => this.tasks.delete(turnId);
    void task.then(cleanupTask, cleanupTask);
    return { turnId };
  }

  async command(input: TerminalCommandInput): Promise<void> {
    const conversation = this.repository.getConversation(input.conversationId);
    if (!conversation) throw new Error("Conversation not found.");
    const project = this.repository.getProject(conversation.projectId);
    if (!project) throw new Error("Project not found.");
    const turnId = await this.repository.startTurn(input.conversationId, null);
    // P2: register an AbortController so cancel(turnId) can abort a command turn
    // (previously a no-op) and dispose() can await the task via this.tasks.
    const controller = new AbortController();
    this.controllers.set(turnId, controller);
    await this.emit(
      turnId,
      input.conversationId,
      null,
      null,
      "user.message",
      `Coterm command: /${input.command}`,
      { text: `/${input.command}`, profileId: "coterm" },
    );
    const task = (async () => {
      try {
        const text = await this.commandText(
          input.command,
          conversation.id,
          conversation.activeProvider,
          project,
        );
        if (controller.signal.aborted) {
          await this.repository.completeTurn(turnId, "cancelled");
          await this.emit(
            turnId,
            input.conversationId,
            null,
            null,
            "warning",
            `Coterm /${input.command} cancelled.`,
            { code: "terminal_command", message: "Cancelled.", terminal: true },
          );
          return;
        }
        await this.repository.completeTurn(turnId, "completed");
        await this.emit(
          turnId,
          input.conversationId,
          null,
          null,
          "assistant.final",
          `Coterm /${input.command} completed.`,
          { text, provider: "coterm" },
        );
      } catch (error) {
        const cancelled = controller.signal.aborted;
        await this.repository.completeTurn(turnId, cancelled ? "cancelled" : "failed");
        await this.emit(
          turnId,
          input.conversationId,
          null,
          null,
          cancelled ? "warning" : "error",
          `Coterm /${input.command} ${cancelled ? "cancelled" : "failed"}.`,
          { code: "terminal_command", message: safeErrorMessage(error), terminal: true },
        );
      } finally {
        this.controllers.delete(turnId);
      }
    })();
    this.tasks.set(turnId, task);
    const cleanupTask = () => this.tasks.delete(turnId);
    void task.then(cleanupTask, cleanupTask);
    await task;
  }

  cancel(turnId: string): void {
    this.controllers.get(turnId)?.abort();
  }

  async dispose(): Promise<void> {
    for (const controller of this.controllers.values()) controller.abort();
    await Promise.allSettled(this.tasks.values());
    for (const adapter of this.adapters) {
      await adapter.dispose?.();
    }
  }

  private async commandText(
    command: TerminalCommandInput["command"],
    conversationId: string,
    activeProvider: MessageInput["profileId"],
    project: { name: string; workspacePath: string },
  ): Promise<string> {
    if (command === "status") {
      const settings = this.repository.getSettings();
      return [
        "## Coterm status",
        `- Project: ${inlineCode(project.name)}`,
        `- Workspace: ${inlineCode(project.workspacePath)}`,
        `- Active runtime: ${inlineCode(activeProvider)}`,
        `- Permission preset: ${inlineCode(settings.permissionPreset)}`,
        "- Memory owner: local SQLite event ledger",
        "- Automatic cross-provider fallback: disabled",
        "- MCP routing: backend native",
      ].join("\n");
    }

    if (command === "session") {
      const conversation = this.repository.getConversation(conversationId);
      const session = this.repository.findProviderSession(conversationId, activeProvider);
      return [
        "## Coterm session",
        `- Conversation: ${inlineCode(conversation?.id ?? conversationId)}`,
        `- Active provider: ${inlineCode(activeProvider)}`,
        `- Selected pane provider: ${inlineCode(activeProvider)}`,
        `- Native session/thread: ${inlineCode(session?.nativeSessionId ?? "not recorded")}`,
        `- Provider session status: ${inlineCode(session?.status ?? "not created")}`,
        `- Coterm summary: ${conversation?.summary ? conversation.summary.updatedAt : "not recorded"}`,
      ].join("\n");
    }

    if (command === "compact-status") {
      const conversation = this.repository.getConversation(conversationId);
      const events = this.repository.listEvents(conversationId);
      const compacted = events.findLast((event) =>
        event.type === "warning" && event.summary.toLowerCase().includes("compacted")
      );
      const usage = events.findLast((event) =>
        event.type === "assistant.final" && event.payload.usage && typeof event.payload.usage === "object"
      )?.payload.usage as { input?: unknown; output?: unknown; contextWindow?: unknown } | undefined;
      return [
        "## Compact status",
        `- Conversation: ${inlineCode(conversation?.id ?? conversationId)}`,
        `- Active provider: ${inlineCode(activeProvider)}`,
        `- Last provider compacted at: ${textValue(compacted?.payload.compactedAt) || "not recorded"}`,
        `- Provider-native compaction: ${compacted ? "observed" : "not exposed"}`,
        `- Coterm summary: ${conversation?.summary ? conversation.summary.updatedAt : "not recorded"}`,
        `- Last token usage: ${formatUsage(usage)}`,
        `- Provider compact summary: ${compacted?.payload.summaryAvailable === true ? "available" : "Provider did not expose compacted summary."}`,
      ].join("\n");
    }

    if (command === "handoff") {
      const packet = await this.handoffs.create(
        conversationId,
        activeProvider,
        activeProvider,
        project.workspacePath,
      );
      return formatHandoff(packet);
    }

    // Stage 2: probe with the effective local route token (per-profile
    // override first). Cached: /health reads, it does not re-probe.
    const settings = this.repository.getSettings();
    const profiles = buildActiveProfiles(settings.customProfiles);
    const providers = await detectProviders({
      proxyUrl: settings.proxyUrl,
      authToken: localRouteAuthToken(profiles),
      profiles,
      customProfiles: settings.customProfiles,
    });
    if (command === "health") {
      return [
        "## Runtime health",
        ...providers.map((provider) =>
          `- ${provider.label}: ${provider.state ?? (provider.online === true ? "online" : provider.online === false ? "offline" : "unknown")} · ${provider.detail}`,
        ),
      ].join("\n");
    }

    const provider = providers.find((item) => item.id === activeProvider);
    if (!provider) return `No capability snapshot is available for ${inlineCode(activeProvider)}.`;
    const enabled = Object.entries(provider.capabilities)
      .filter(([, value]) => value)
      .map(([name]) => name);
    const unavailable = Object.entries(provider.capabilities)
      .filter(([, value]) => !value)
      .map(([name]) => name);
    return [
      `## Capabilities: ${provider.label}`,
      `- Version: ${inlineCode(provider.version ?? "unavailable")}`,
      `- Available: ${enabled.map(inlineCode).join(", ") || "none"}`,
      `- Unavailable: ${unavailable.map(inlineCode).join(", ") || "none"}`,
    ].join("\n");
  }

  private async emit(
    turnId: string,
    conversationId: string,
    providerSessionId: string | null,
    turnGroupId: string | null,
    type: ProviderEvent["type"],
    summary: string,
    payload: Record<string, unknown>,
  ): Promise<void> {
    const event = await this.repository.appendEvent({
      turnId,
      conversationId,
      providerSessionId,
      turnGroupId,
      type,
      summary,
      payload,
    });
    this.events.emit("event", event);
  }
}

function inlineCode(value: string): string {
  return `\`${value.replaceAll("`", "'")}\``;
}

function formatUsage(usage: { input?: unknown; output?: unknown; contextWindow?: unknown } | undefined): string {
  if (!usage) return "not recorded";
  return [
    `input=${usageValue(usage.input)}`,
    `output=${usageValue(usage.output)}`,
    `contextWindow=${usageValue(usage.contextWindow)}`,
  ].join(", ");
}

function usageValue(value: unknown): string {
  return typeof value === "number" || typeof value === "string" ? String(value) : "unknown";
}

function formatHandoff(packet: HandoffPacket): string {
  return [
    "## Coterm handoff",
    `- Runtime: ${inlineCode(packet.sourceProfile)}`,
    `- Goal: ${packet.objective || "Not recorded"}`,
    `- Workspace: ${inlineCode(packet.workspace.path)}`,
    `- Branch: ${inlineCode(packet.workspace.branch ?? "unknown")}`,
    `- HEAD: ${inlineCode(packet.workspace.head ?? "unknown")}`,
    "### Decisions",
    ...(packet.decisions.length ? packet.decisions.map((item) => `- ${item}`) : ["- None recorded"]),
    "### Pending / risks",
    ...(packet.pending.length ? packet.pending.map((item) => `- ${item}`) : ["- None recorded"]),
    "### Recent terminal",
    ...(packet.recentTerminal.length ? packet.recentTerminal.map((item) => `- ${item}`) : ["- None recorded"]),
    "### Recent conversation",
    ...packet.recentMessages.map((item) => `- **${item.role}:** ${item.content}`),
  ].join("\n");
}
