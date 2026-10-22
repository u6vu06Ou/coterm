import {
  artifactReadInputSchema,
  artifactWriteInputSchema,
  artifactTokenInputSchema,
  browserArtifactInputSchema,
  attachmentSaveInputSchema,
  uploadSaveInputSchema,
  approvalResolveInputSchema,
  userInputResolveInputSchema,
  attentionResolveInputSchema,
  conversationStateInputSchema,
  conversationModelInputSchema,
  claudeHistoryListInputSchema,
  claudeHistoryReadInputSchema,
  conversationSummaryInputSchema,
  councilInputSchema,
  providerRefreshInputSchema,
  createConversationInputSchema,
  continueConversationInputSchema,
  createProjectInputSchema,
  deleteProjectInputSchema,
  globalSearchInputSchema,
  idSchema,
  messageInputSchema,
  projectStateInputSchema,
  reorderProjectsInputSchema,
  renameConversationInputSchema,
  renameProjectInputSchema,
  terminalCommandInputSchema,
  terminalCreateInputSchema,
  terminalIdInputSchema,
  terminalRenameInputSchema,
  terminalMarkAgentInputSchema,
  terminalSetLabelInputSchema,
  terminalResizeInputSchema,
  terminalSetNativeSessionIdInputSchema,
  terminalKeepaliveSetInputSchema,
  terminalWriteInputSchema,
  terminalWorkspaceSaveInputSchema,
  workspaceListInputSchema,
  workspaceSearchInputSchema,
  workspacePathInputSchema,
  workspaceRenameInputSchema,
  workspaceCreateInputSchema,
  workspaceDuplicateInputSchema,
  dockOpenTileInputSchema,
  dockCloseTileInputSchema,
  dockSelectTileInputSchema,
  dockSetLayoutInputSchema,
  dockSetExclusiveInputSchema,
  dockReorderTileInputSchema,
  worktreeCreateInputSchema,
  worktreeListInputSchema,
  worktreeIdInputSchema,
  worktreeMergeInputSchema,
  worktreeBindSessionInputSchema,
  worktreeResumeInputSchema,
  checkpointListInputSchema,
  checkpointIdInputSchema,
  checkpointDiffInputSchema,
  checkpointRestorePreviewInputSchema,
  checkpointRestoreInputSchema,
  checkpointHunkRestoreInputSchema,
  checkpointUndoInputSchema,
  checkpointCreateExplicitInputSchema,
} from "@shared/schema";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { basename, dirname, extname, isAbsolute, join, relative, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { ApprovalBroker } from "./approval-broker";
import type { ConversationSummarizer } from "./conversation-summarizer";
import type { ClaudeHistory } from "./claude-history";
import type { RunCoordinator } from "./run-coordinator";
import type { CouncilScheduler } from "../providers/council-scheduler";
import { detectProviders } from "../providers/capability-detector";
import type { Repository } from "../storage/repository";
import type { PtyManager } from "../terminal/pty-manager";
import { exportTerminalHandoff as exportTerminalHandoffCore } from "../terminal/handoff-exporter";
import type { AppEventBus } from "./event-bus";
import type { AttentionCenter } from "./attention-center";
import { assertAllowedPath, assertExistingPath } from "../security/path-policy";
import { mintArtifactPreviewToken } from "../web/artifact-preview-tokens";
import { DockLayoutManager } from "./dock-layout";
import type { WorktreeManager } from "./worktree-manager";
import type { WorktreeRegistry } from "../terminal/worktree-registry";
import type { CheckpointManager } from "./checkpoint-manager";
import { logger } from "./logger";
import type { SessionIndex } from "./session-index";
import type { DockLayout, TerminalWorkspaceState, AttentionNotification, Worktree, WorktreeMergeInput, Checkpoint, CheckpointDiff, CheckpointRestorePreview, UsageSnapshot, SystemActivity, AgentFileActivity, WorktreeRegistryActivity, SpreadsheetModel, PresentationModel, TerminalTranscript, TerminalSessionInfo, AppSettings } from "@shared/types";
import type { TerminalDashboardEntry, UiActionRecordInput } from "@shared/ipc";
import { TerminalTranscriptService, providerFor } from "../terminal/transcript-service";
import type { UsageMonitor } from "../terminal/usage-monitor";
import type { ActivityMonitor } from "../terminal/activity-monitor";
import type { BrowserRuntimeManager } from "../browser/browser-runtime-manager";
import { dispatchBrowserAction } from "../browser/browser-action-registry";
import { buildWorktreeResumeCommand } from "../providers/agent-launch";
import { ensureAgentShims } from "../providers/agent-shims";
import { buildActiveProfiles, localRouteAuthToken } from "../providers/profiles-config";
import { codexProfileHomesFor } from "../providers/agent-shims";
import { isPromptEchoTitle, normalizeCodexThreadTitle, resolveCodexStorage } from "../terminal/context-meter";
import { deriveAgentOptions } from "@shared/agent-options";
import { parsePresentation, parseSpreadsheet } from "./office-preview";
import {
  createWorkspaceDirectory,
  createWorkspaceFile,
  duplicateTarget,
  duplicateWorkspaceEntry,
  assertSafeEntryName,
  listWorkspaceEntries,
  renameWorkspaceEntry,
  workspaceEntryType,
  type WorkspaceShell,
} from "./workspace-operations";
import { searchWorkspaceEntries as scanWorkspaceEntries } from "./workspace-search";

interface AppOperationsDependencies {
  repository: Repository;
  summarizer?: Pick<ConversationSummarizer, "summarize">;
  claudeHistory?: Pick<ClaudeHistory, "list" | "read" | "resolve">;
  sessionIndex?: Pick<SessionIndex, "search" | "sync" | "stats" | "status">;
  runs: Pick<RunCoordinator, "send" | "cancel" | "command">;
  approvals: Pick<ApprovalBroker, "resolve"> & Partial<Pick<ApprovalBroker, "resolveInput">>;
  council: Pick<CouncilScheduler, "start" | "cancel">;
  terminals: Pick<PtyManager, "create" | "write" | "writeWhenShellReady" | "resize" | "rename" | "setLabel" | "markAgent" | "markAgentOwned" | "setNativeSessionId" | "kill" | "list" | "snapshots" | "get" | "getPtyState" | "getLastCommand" | "dashboardSnapshot"> & Partial<Pick<PtyManager, "getScrollbackTail">>
    & Partial<Pick<PtyManager, "setClaudeKeepaliveHours" | "getAgentStateExplanation">>
    & Pick<PtyManager, "setTerminalKeepalive" | "listTerminalKeepaliveStates">;
  attention: Pick<AttentionCenter, "list" | "resolve" | "onAttentionChanged">;
  // Optional: the global usage HUD monitor. Absent in tests that don't care
  // about the HUD; getUsageSnapshot returns an empty snapshot when missing.
  usage?: Pick<UsageMonitor, "getSnapshot">;
  // Optional: sidebar machine pulse. Absent in tests → zeroed snapshot.
  activity?: Pick<ActivityMonitor, "getSnapshot" | "listFiles">;
  // Optional: read-only session worktree registry. Absent in tests → empty.
  worktreeRegistry?: Pick<WorktreeRegistry, "list">;
  events: AppEventBus;
  appVersion: string;
  userDataPath: string;
  /** Electron clipboard writer, injected from index.ts (absent in tests). */
  clipboardWrite?: (text: string) => void;
  tempPath: string;
  /** Live web-server port, for minting loopback artifact-preview URLs. Absent before it starts. */
  webServerPort?: () => number | null;
  remoteRoots?: string[];
  worktrees?: WorktreeManager;
  checkpointer?: CheckpointManager;
  workspaceShell?: WorkspaceShell;
  browser?: BrowserRuntimeManager;
  transcriptService?: Pick<TerminalTranscriptService, "get" | "resolveSessionFile">;
  /** Codex Team config template dir (bundling contract); absent in tests. */
  codexTeamTemplateDir?: string;
}

/** Same clientMutationId reused with a different payload (work order §10.4). */
export class TerminalMutationConflictError extends Error {
  readonly code = "terminal_mutation_conflict";
  constructor() {
    super("clientMutationId was already used for a different payload.");
    this.name = "TerminalMutationConflictError";
  }
}

export interface TerminalWriteResult {
  /** "deduped" = identical retry (same id + payload hash); nothing was written. */
  status: "written" | "deduped";
}

export class AppOperations {
  private readonly transcriptService: Pick<TerminalTranscriptService, "get" | "resolveSessionFile">;

  constructor(private readonly dependencies: AppOperationsDependencies) {
    this.transcriptService = dependencies.transcriptService ?? new TerminalTranscriptService();
    // 殭屍格回收（1.5.44）: a PTY exit must free its dock tile (the registry
    // entry is already gone, so the pane can never hydrate again — it would be
    // a blank placeholder still counting toward MAX_TILES). closeTile kills
    // (which also emits terminalExit); handleTerminalExit is idempotent, so
    // that double delivery is a no-op.
    this.dependencies.events.on("terminalExit", (payload) => {
      // Only reclaim when the dock manager already exists — never construct it
      // here (an exit for a terminal that never had a tile must not touch the
      // layout file).
      const dock = this.dockLayout;
      if (!dock) return;
      void dock.handleTerminalExit(payload.terminalId).catch((error: unknown) => {
        logger.warn("app", "dockLayout.tile.reclaim.failed", "Failed to reclaim the dock tile of an exited terminal.", {
          terminalId: payload.terminalId,
          error: error instanceof Error ? error.message : String(error),
        });
      });
    });
  }

  private readonly artifactTokenCache = new Map<string, {
    projectId: string;
    path: string;
    kind: "spreadsheet" | "presentation";
    model: SpreadsheetModel | PresentationModel;
    expiresAt: number;
  }>();

  /**
   * Per-project in-flight getTerminalWorkspace promises. Two concurrent calls
   * for the same project (React StrictMode double-invoke, rapid pane/project
   * switching) used to both see live.length===0 and each restore its own set of
   * terminals, producing duplicate PTYs whose xterm instances then mirrored
   * each other's output. Coalescing them onto a single promise fixes that.
   */
  private readonly terminalWorkspaceInFlight = new Map<string, Promise<TerminalWorkspaceState>>();
  /**
   * Mobile composer, retry-safe clients and Phase 5 voice dispatch use UUIDs,
   * never text matching, for idempotency (work order §10.4). Each id records
   * a payload hash + bounded TTL: same id + same payload = deduped no-op
   * (covers HTTP retry); same id + different payload = conflict (client bug).
   */
  private readonly terminalMutationIds = new Map<string, { payloadHash: string; expiresAt: number }>();

  /**
   * Dock layout manager — the main-process single source of truth for the
   * terminal dock. Lazily created so the JSON file is only touched on first
   * dock access. See dock-layout.ts and the terminal-first overhaul spec.
   */
  private dockLayout: DockLayoutManager | null = null;
  private get dock(): DockLayoutManager {
    if (!this.dockLayout) {
      this.dockLayout = new DockLayoutManager({
        terminals: this.dependencies.terminals,
        repository: this.dependencies.repository,
        userDataPath: this.dependencies.userDataPath,
        tempPath: this.dependencies.tempPath,
        ...(this.dependencies.worktrees ? { worktrees: this.dependencies.worktrees } : {}),
      });
    }
    return this.dockLayout;
  }

  bootstrap() {
    const { repository, appVersion, userDataPath } = this.dependencies;
    return {
      projects: repository.listProjects(),
      conversations: repository.listConversations(),
      runningConversationIds: repository.listRunningConversationIds(),
      archivedProjects: repository.listArchivedProjects(),
      archivedConversations: repository.listArchivedConversations(),
      providers: [],
      appVersion,
      userDataPath,
      // ALERTS.md banner removed 2026-10-18 (user request); field kept empty for old clients.
      startupAlerts: "",
    };
  }

  /**
   * If retention.pruneOnStart is enabled in settings, prune old events and
   * terminal_events (day-based). The hard rolling caps
   * (Repository.pruneTerminalEventsOverflow) always run — they are a safety
   * bound, not a preference, and an uncapped ledger is what stalled every
   * write on a full-DB export. When a prune frees enough rows, VACUUM once at
   * startup so the on-disk file shrinks (DELETE alone leaves free pages).
   * Errors are logged but never prevent boot.
   */
  async maybePruneOnStart(): Promise<void> {
    const { retention } = this.dependencies.repository.getSettings();
    try {
      let deleted = 0;
      if (retention?.pruneOnStart) {
        const result = await this.dependencies.repository.pruneOldData({ days: retention.days });
        deleted += result.deletedEvents + result.deletedTerminalEvents;
        logger.audit("storage", "prune.onStart", "Startup prune completed", result);
      }
      const overflow = await this.dependencies.repository.pruneTerminalEventsOverflow("startup");
      deleted += overflow.deleted;
      if (deleted >= 1_000) {
        await this.dependencies.repository.vacuumAfterPrune(deleted);
      }
    } catch (error) {
      logger.warn("storage", "prune.onStart.failed", "Startup prune failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  getSettings() { return this.dependencies.repository.getSettings(); }
  recordUiAction(input: unknown): void {
    if (!input || typeof input !== "object") throw new Error("Invalid UI action record.");
    const record = input as Record<string, unknown>;
    const actionId = typeof record.actionId === "string" ? record.actionId : "";
    const surface = record.surface;
    const controlType = record.controlType;
    const interaction = record.interaction;
    const validSurface = surface === "desktop" || surface === "web" || surface === "mobile-web";
    const validControl = ["button", "link", "input", "select", "textarea", "role-button", "other"].includes(String(controlType));
    const validInteraction = ["click", "change", "submit", "pointerdown", "doubleclick", "mousedown", "keyboard"].includes(String(interaction));
    if (!/^[a-z0-9][a-z0-9._:-]{0,119}$/i.test(actionId) || !validSurface || !validControl || !validInteraction || typeof record.identified !== "boolean") {
      throw new Error("Invalid UI action record.");
    }
    const safeRecord: UiActionRecordInput = {
      actionId,
      surface,
      identified: record.identified,
      controlType: controlType as UiActionRecordInput["controlType"],
      interaction: interaction as UiActionRecordInput["interaction"],
    };
    // Privacy contract: identifiers and coarse control metadata only. Never
    // log labels, field values, clipboard data, PTY output, or conversation text.
    logger.audit("audit", "ui.action", "UI action invoked", { ...safeRecord });
  }
  // Renderer→main error sink (coterm.log). No-throw by design: callers are
  // themselves error handlers, so malformed input is dropped, never thrown.
  private rendererErrorStamps: number[] = [];
  reportRendererError(input: unknown): void {
    if (!input || typeof input !== "object") return;
    const report = input as Record<string, unknown>;
    const rawMessage = typeof report.message === "string" ? report.message.trim() : "";
    if (!rawMessage) return;
    const rawSource = typeof report.source === "string" ? report.source.trim() : "";
    const source = ((rawSource || "renderer").replace(/[^a-zA-Z0-9._:-]/g, "").slice(0, 40)) || "renderer";
    const stack = typeof report.stack === "string" ? report.stack.slice(0, 4096) : "";
    const now = Date.now();
    this.rendererErrorStamps = this.rendererErrorStamps.filter((stamp) => now - stamp < 60_000);
    if (this.rendererErrorStamps.length >= 20) return;
    this.rendererErrorStamps.push(now);
    // Privacy contract: message + truncated stack + origin tag only. Never
    // PTY output, conversation text, or detection evidence (logging A.2).
    logger.error("app", "renderer.error", rawMessage.slice(0, 2000), {
      source,
      stack: stack || undefined,
    });
  }
  sessionIndexStatus(): { syncing: boolean; lastCompletedAt: string | null } {
    const session = this.dependencies.sessionIndex?.status() ?? { syncing: false, lastCompletedAt: null };
    const ledger = this.dependencies.repository.searchIndexStatus();
    return {
      syncing: session.syncing || ledger.syncing || ledger.dirty,
      lastCompletedAt: session.lastCompletedAt,
    };
  }
  async setSettings(input: unknown) {
    // #60: `settings:set` is a deep-partial patch. A full AppSettings payload
    // is still a valid patch, so older/renderer clients keep working, but
    // absent fields (e.g. the whole `voice` block) no longer get reset.
    // Hot model registry (stage 1): snapshot the pre-write customProfiles so a
    // change is detectable after the merge (shims + push below).
    const previous = this.dependencies.repository.getSettings();
    const settings = await this.dependencies.repository.updateSettings(input);
    this.dependencies.terminals.setClaudeKeepaliveHours?.(settings.claudeKeepaliveHours);
    if (JSON.stringify(previous.customProfiles ?? {}) !== JSON.stringify(settings.customProfiles ?? {})) {
      this.applyProfilesChange(settings);
    }
    return settings;
  }

  /**
   * Hot model registry (stage 1): react to a customProfiles change without a
   * restart. Regenerates the launcher shims from the ACTIVE table (a custom
   * profile needs its own .ps1 before the picker can launch it), then pushes
   * the derived agent option list on the bus (IPC broadcast + live WS). Shim
   * regeneration failure never fails the settings write — the push still goes
   * out and the next launch regenerates from the startup path.
   */
  private applyProfilesChange(settings: AppSettings): void {
    try {
      ensureAgentShims(this.dependencies.userDataPath, settings.proxyUrl, {
        profileTable: buildActiveProfiles(settings.customProfiles),
        codexTeamTemplateDir: this.dependencies.codexTeamTemplateDir,
      });
    } catch (error) {
      logger.warn("provider", "agent.shims.hot-reload-failed", "Agent launcher shim regeneration failed after a profiles change.", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
    this.dependencies.events.emit("profilesChanged", deriveAgentOptions(settings.customProfiles));
    // Logging §A.2 / stage 2 security: record ids only — never profile
    // contents (authToken must never reach coterm.log).
    logger.info(
      "provider",
      "profiles.changed",
      `Active profiles: ${Object.keys(buildActiveProfiles(settings.customProfiles)).sort().join(",")}`,
    );
  }
  async pickWorkspace(): Promise<string | null> {
    const root = this.dependencies.remoteRoots?.[0];
    return root ? assertAllowedPath(root, { roots: [root] }) : null;
  }
  async createProject(input: unknown) {
    const parsed = createProjectInputSchema.parse(input);
    const roots = this.dependencies.remoteRoots ?? [];
    if (roots.length === 0) throw new Error("Remote workspace roots are not configured.");
    const workspacePath = await assertAllowedPath(parsed.workspacePath, { roots });
    return this.dependencies.repository.createProject(parsed.name, workspacePath);
  }
  async listWorkspace(input: unknown) {
    const parsed = workspaceListInputSchema.parse(input);
    const project = this.dependencies.repository.getProject(parsed.projectId);
    if (!project) throw new Error("Project not found.");
    const root = await assertAllowedPath(project.workspacePath, { roots: [project.workspacePath] });
    const directory = await assertAllowedPath(parsed.path ?? root, { roots: [root] });
    return listWorkspaceEntries(root, directory);
  }

  async searchWorkspaceEntries(input: unknown) {
    const parsed = workspaceSearchInputSchema.parse(input);
    const root = await this.workspaceRoot(parsed.projectId);
    return scanWorkspaceEntries({ root, query: parsed.query, ...(parsed.maxResults !== undefined ? { maxResults: parsed.maxResults } : {}), ...(parsed.includeDirectories !== undefined ? { includeDirectories: parsed.includeDirectories } : {}), ...(parsed.includeHidden !== undefined ? { includeHidden: parsed.includeHidden } : {}) });
  }

  private async workspaceRoot(projectId: string): Promise<string> {
    const project = this.dependencies.repository.getProject(projectId);
    if (!project) throw new Error("Project not found.");
    return assertAllowedPath(project.workspacePath, { roots: [project.workspacePath] });
  }

  private async workspacePath(input: unknown): Promise<{ root: string; path: string }> {
    const parsed = workspacePathInputSchema.parse(input);
    const root = await this.workspaceRoot(parsed.projectId);
    const path = await assertAllowedPath(parsed.path, { roots: [root] });
    return { root, path };
  }

  private workspaceShell(): WorkspaceShell {
    if (!this.dependencies.workspaceShell) throw new Error("Workspace shell integration is unavailable.");
    return this.dependencies.workspaceShell;
  }

  private async workspaceEntry(root: string, path: string) {
    return {
      name: basename(path),
      path,
      type: await workspaceEntryType(path),
      relativePath: relative(root, path),
    } as const;
  }

  async renameWorkspaceEntry(input: unknown) {
    const parsed = workspaceRenameInputSchema.parse(input);
    const root = await this.workspaceRoot(parsed.projectId);
    const source = await assertAllowedPath(parsed.path, { roots: [root] });
    const safeName = assertSafeEntryName(parsed.newName);
    const parent = await assertAllowedPath(parsed.newParentPath ?? dirname(source), { roots: [root] });
    const descendant = relative(source, parent);
    if (descendant && !descendant.startsWith("..") && !isAbsolute(descendant)) {
      throw new Error("An entry cannot be moved into itself.");
    }
    const target = await assertAllowedPath(join(parent, safeName), { roots: [root], mustExist: false });
    await renameWorkspaceEntry(source, target, root);
    return this.workspaceEntry(root, target);
  }

  async createWorkspaceFile(input: unknown) {
    const parsed = workspaceCreateInputSchema.parse(input);
    const root = await this.workspaceRoot(parsed.projectId);
    const parent = await assertAllowedPath(parsed.parentPath ?? root, { roots: [root] });
    const safeName = assertSafeEntryName(parsed.name);
    const target = await assertAllowedPath(join(parent, safeName), { roots: [root], mustExist: false });
    await createWorkspaceFile(parent, safeName);
    return this.workspaceEntry(root, target);
  }

  async createWorkspaceDirectory(input: unknown) {
    const parsed = workspaceCreateInputSchema.parse(input);
    const root = await this.workspaceRoot(parsed.projectId);
    const parent = await assertAllowedPath(parsed.parentPath ?? root, { roots: [root] });
    const safeName = assertSafeEntryName(parsed.name);
    const target = await assertAllowedPath(join(parent, safeName), { roots: [root], mustExist: false });
    await createWorkspaceDirectory(parent, safeName);
    return this.workspaceEntry(root, target);
  }

  async deleteWorkspaceEntry(input: unknown): Promise<void> {
    const { root, path } = await this.workspacePath(input);
    if (path.toLowerCase() === root.toLowerCase()) throw new Error("The workspace root cannot be deleted.");
    await this.workspaceShell().trashItem(path);
  }

  async duplicateWorkspaceEntry(input: unknown) {
    const parsed = workspaceDuplicateInputSchema.parse(input);
    const root = await this.workspaceRoot(parsed.projectId);
    const path = await assertAllowedPath(parsed.path, { roots: [root] });
    if (path.toLowerCase() === root.toLowerCase()) throw new Error("The workspace root cannot be duplicated.");
    const destinationParent = await assertAllowedPath(parsed.destinationPath ?? dirname(path), { roots: [root] });
    if (await workspaceEntryType(destinationParent) !== "directory") throw new Error("Duplicate destination must be a directory.");
    const target = await assertAllowedPath(await duplicateTarget(path, destinationParent), { roots: [root], mustExist: false });
    await duplicateWorkspaceEntry(path, target);
    return this.workspaceEntry(root, target);
  }

  async revealWorkspaceEntry(input: unknown): Promise<void> {
    const { path } = await this.workspacePath(input);
    this.workspaceShell().showItemInFolder(path);
  }

  async openWorkspaceEntryExternal(input: unknown): Promise<void> {
    const { path } = await this.workspacePath(input);
    const lower = path.toLowerCase();
    const executable = [
      ".exe", ".bat", ".cmd", ".com", ".msi", ".scr", ".ps1", ".psm1", ".vbs",
      ".vbe", ".jse", ".wsf", ".wsh", ".hta", ".cpl", ".jar", ".reg", ".lnk", ".pif",
    ];
    if (executable.some((extension) => lower.endsWith(extension))) {
      this.workspaceShell().showItemInFolder(path);
      return;
    }
    const openError = await this.workspaceShell().openPath(path);
    if (openError) this.workspaceShell().showItemInFolder(path);
  }
  search(input: unknown) {
    const parsed = globalSearchInputSchema.parse(input);
    const projects = this.dependencies.repository.listProjects();
    const projectNameById = new Map(projects.map((project) => [project.id, project.name]));
    const sessionIndex = this.dependencies.sessionIndex;
    if (sessionIndex) {
      // Fire-and-forget: refresh index opportunistically, never block search.
      void sessionIndex.sync(projects).catch((error) => {
        logger.warn("storage", "sessionIndex.sync.failed", "Session index sync failed", {
          error: error instanceof Error ? error.message : String(error),
        });
      });
    }
    const sessionHits = sessionIndex
      ? sessionIndex.search(parsed.query, projects, parsed.limit).map((hit) => ({
          id: hit.nativeSessionId,
          kind: "session" as const,
          title: hit.title,
          snippet: hit.snippet,
          projectId: hit.projectId,
          conversationId: null,
          terminalId: null,
          nativeSessionId: hit.nativeSessionId,
          projectName: projectNameById.get(hit.projectId) ?? null,
          updatedAt: hit.updatedAt,
        }))
      : [];
    const dbHits = this.dependencies.repository.search(parsed);
    return [...sessionHits, ...dbHits].slice(0, parsed.limit);
  }
  async saveAttachment(input: unknown) {
    const parsed = attachmentSaveInputSchema.parse(input);
    if (!this.dependencies.repository.getConversation(parsed.conversationId)) throw new Error("Conversation not found.");
    const bytes = Buffer.from(parsed.dataBase64, "base64");
    if (bytes.length > 20_000_000) throw new Error("Attachment exceeds the 20 MB limit.");
    const extensions: Record<string, string> = {
      "image/png": ".png", "image/jpeg": ".jpg", "image/webp": ".webp", "image/gif": ".gif",
      "application/pdf": ".pdf", "text/csv": ".csv", "text/plain": ".txt", "text/markdown": ".md", "text/html": ".html",
      "application/json": ".json", "text/javascript": ".js", "text/typescript": ".ts", "text/css": ".css",
      "text/x-python": ".py", "text/x-powershell": ".ps1", "text/x-shellscript": ".sh",
    };
    const extension = extensions[parsed.mimeType];
    if (!extension) throw new Error("Unsupported attachment MIME type.");
    const directory = join(this.dependencies.userDataPath, "attachments", parsed.conversationId);
    await mkdir(directory, { recursive: true });
    const localPath = join(directory, `${randomUUID()}${extension}`);
    await writeFile(localPath, bytes);
    try {
      return await this.dependencies.repository.addAttachment(parsed.conversationId, parsed.name, parsed.mimeType, localPath, bytes.length);
    } catch (error) {
      await rm(localPath, { force: true });
      throw error;
    }
  }
  async saveUpload(input: unknown): Promise<{ localPath: string }> {
    const parsed = uploadSaveInputSchema.parse(input);
    const bytes = Buffer.from(parsed.dataBase64, "base64");
    if (bytes.length > 20_000_000) throw new Error("Upload exceeds the 20 MB limit.");
    const extensions: Record<string, string> = {
      "image/png": ".png", "image/jpeg": ".jpg", "image/webp": ".webp", "image/gif": ".gif",
    };
    const extension = extensions[parsed.mimeType];
    if (!extension) throw new Error("Unsupported upload MIME type.");
    const directory = join(this.dependencies.userDataPath, "uploads");
    await mkdir(directory, { recursive: true });
    const localPath = join(directory, `${randomUUID()}${extension}`);
    await writeFile(localPath, bytes);
    return { localPath };
  }
  listAttachments(conversationId: unknown) {
    const id = idSchema.parse(conversationId);
    if (!this.dependencies.repository.getConversation(id)) throw new Error("Conversation not found.");
    return this.dependencies.repository.listAttachments(id);
  }
  async deleteAttachment(attachmentId: unknown): Promise<void> {
    const localPath = await this.dependencies.repository.deleteAttachment(idSchema.parse(attachmentId));
    if (!localPath) return;
    await rm(await assertAllowedPath(localPath, { roots: [join(this.dependencies.userDataPath, "attachments")] }), { force: true });
  }

  private storeArtifactModel(projectId: string, path: string, kind: "spreadsheet" | "presentation", model: SpreadsheetModel | PresentationModel): string {
    const now = Date.now();
    for (const [token, cached] of this.artifactTokenCache) {
      if (cached.expiresAt <= now) this.artifactTokenCache.delete(token);
    }
    while (this.artifactTokenCache.size >= 24) {
      const oldest = this.artifactTokenCache.keys().next().value;
      if (!oldest) break;
      this.artifactTokenCache.delete(oldest);
    }
    const token = randomUUID();
    this.artifactTokenCache.set(token, { projectId, path, kind, model, expiresAt: now + 15 * 60_000 });
    return token;
  }

  private artifactModel(input: unknown, kind: "spreadsheet" | "presentation"): SpreadsheetModel | PresentationModel {
    const { token } = artifactTokenInputSchema.parse(input);
    const cached = this.artifactTokenCache.get(token);
    if (!cached || cached.expiresAt <= Date.now() || cached.kind !== kind) throw new Error("Artifact preview has expired.");
    cached.expiresAt = Date.now() + 15 * 60_000;
    return cached.model;
  }

  readArtifactWorkbook(input: unknown): SpreadsheetModel {
    return this.artifactModel(input, "spreadsheet") as SpreadsheetModel;
  }

  readArtifactPresentation(input: unknown): PresentationModel {
    return this.artifactModel(input, "presentation") as PresentationModel;
  }

  openBrowserArtifact(input: unknown) {
    const { url } = browserArtifactInputSchema.parse(input);
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      throw new Error("Browser artifact URL is invalid.");
    }
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
      throw new Error("Only HTTP and HTTPS browser artifacts are allowed.");
    }
    return { kind: "browser", mimeType: "text/uri-list", path: parsed.toString(), size: 0, url: parsed.toString() } as const;
  }

  private browserRuntime(): BrowserRuntimeManager {
    if (!this.dependencies.browser) throw new Error("Browser runtime is unavailable.");
    return this.dependencies.browser;
  }

  createBrowserSession(input?: unknown) { return dispatchBrowserAction(this.browserRuntime(), "createSession", input ?? {}, "ipc"); }
  listBrowserSessions() { return dispatchBrowserAction(this.browserRuntime(), "listSessions", {}, "ipc"); }
  closeBrowserSession(sessionId: unknown): Promise<void> { return dispatchBrowserAction(this.browserRuntime(), "closeSession", { sessionId: idSchema.parse(sessionId) }, "ipc") as Promise<void>; }
  newBrowserPage(input: unknown) { return dispatchBrowserAction(this.browserRuntime(), "newPage", input, "ipc"); }
  listBrowserPages(sessionId: unknown) { return dispatchBrowserAction(this.browserRuntime(), "listPages", { sessionId: idSchema.parse(sessionId) }, "ipc"); }
  closeBrowserPage(input: unknown): Promise<void> { return dispatchBrowserAction(this.browserRuntime(), "closePage", input, "ipc") as Promise<void>; }
  selectBrowserPage(input: unknown) { return dispatchBrowserAction(this.browserRuntime(), "selectPage", input, "ipc"); }
  navigateBrowser(input: unknown) { return dispatchBrowserAction(this.browserRuntime(), "navigate", input, "ipc"); }
  async openInAgentBrowser(input: { target: string }): Promise<{ ok: boolean; error?: string }> {
    try {
      const runtime = this.browserRuntime();
      const trimmed = input.target.trim();
      // file: is a hard-blocked scheme (browser-policy.ts), so a local target
      // goes through the loopback artifact-preview route; an http(s) URL goes
      // through the policy-checked session path. createSession is called directly
      // (it parses its own input): the action registry's schema.parse grafts a
      // defaulted `mode`, which defeats createSession's explicit-mode popout probe.
      if (/^https?:\/\//i.test(trimmed)) {
        await runtime.createSession({ url: trimmed });
      } else {
        // A user click on a terminal path: any folder (2026-10-18), unlike the agent-facing
        // previewLocalFile which stays limited to project/temp/userData roots.
        const path = await assertExistingPath(trimmed);
        if (!/\.html?$/i.test(path)) throw new Error("Local preview is limited to .html files.");
        const port = this.dependencies.webServerPort?.();
        if (!port) throw new Error("Local preview needs Coterm's web server to be running.");
        await runtime.createSession({
          url: `http://127.0.0.1:${port}/artifact-preview/${mintArtifactPreviewToken(dirname(path))}/${encodeURIComponent(basename(path))}`,
        });
      }
      return { ok: true };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  }
  browserBack(pageId: unknown) { return dispatchBrowserAction(this.browserRuntime(), "back", { pageId: idSchema.parse(pageId) }, "ipc"); }
  browserForward(pageId: unknown) { return dispatchBrowserAction(this.browserRuntime(), "forward", { pageId: idSchema.parse(pageId) }, "ipc"); }
  browserReload(pageId: unknown) { return dispatchBrowserAction(this.browserRuntime(), "reload", { pageId: idSchema.parse(pageId) }, "ipc"); }
  browserStop(pageId: unknown) { return dispatchBrowserAction(this.browserRuntime(), "stop", { pageId: idSchema.parse(pageId) }, "ipc"); }
  snapshotBrowser(input: unknown) { return dispatchBrowserAction(this.browserRuntime(), "snapshot", input, "ipc"); }
  clickBrowser(input: unknown) { return dispatchBrowserAction(this.browserRuntime(), "click", input, "ipc"); }
  clickBrowserCoordinates(input: unknown) { return dispatchBrowserAction(this.browserRuntime(), "clickCoordinates", input, "ipc"); }
  fillBrowser(input: unknown) { return dispatchBrowserAction(this.browserRuntime(), "fill", input, "ipc"); }
  typeBrowser(input: unknown) { return dispatchBrowserAction(this.browserRuntime(), "type", input, "ipc"); }
  pressBrowser(input: unknown) { return dispatchBrowserAction(this.browserRuntime(), "press", input, "ipc"); }
  extractBrowser(input: unknown) { return dispatchBrowserAction(this.browserRuntime(), "extract", input, "ipc"); }
  saveBrowserExtraction(input: unknown) { return dispatchBrowserAction(this.browserRuntime(), "saveExtraction", input, "ipc"); }
  searchBrowserIndex(input: unknown) { return dispatchBrowserAction(this.browserRuntime(), "searchIndex", input, "ipc"); }
  screenshotBrowser(input: unknown) { return dispatchBrowserAction(this.browserRuntime(), "screenshot", input, "ipc"); }

  async readArtifact(input: unknown) {
    const parsed = artifactReadInputSchema.parse(input);
    const project = this.dependencies.repository.getProject(parsed.projectId);
    if (!project) throw new Error("Project not found.");
    // No folder restriction (user decision 2026-10-18): an artifact link anywhere on disk must open.
    // Exposure stays bounded by the extension whitelist + size caps below and the web server's auth.
    const allowedPath = await assertExistingPath(parsed.path);
    const extension = extname(allowedPath).toLowerCase();
    if ([".xlsx", ".csv", ".tsv"].includes(extension)) {
      const info = await stat(allowedPath);
      if (!info.isFile()) throw new Error("Spreadsheet preview requires a file.");
      if (info.size > 25_000_000) throw new Error("Spreadsheet exceeds the 25 MB preview limit.");
      const model = parseSpreadsheet(await readFile(allowedPath), extension);
      const token = this.storeArtifactModel(parsed.projectId, allowedPath, "spreadsheet", model);
      const mimeType = extension === ".xlsx"
        ? "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
        : extension === ".tsv" ? "text/tab-separated-values" : "text/csv";
      return {
        kind: "spreadsheet",
        mimeType,
        path: allowedPath,
        size: info.size,
        workbookToken: token,
        metadata: {
          format: model.format,
          limited: model.limited,
          sheets: model.sheets.map(({ name, index, rowCount, columnCount, truncated }) => ({ name, index, rowCount, columnCount, truncated })),
        },
      };
    }
    if (extension === ".pptx") {
      const info = await stat(allowedPath);
      if (!info.isFile()) throw new Error("Presentation preview requires a file.");
      if (info.size > 50_000_000) throw new Error("Presentation exceeds the 50 MB preview limit.");
      const model = parsePresentation(await readFile(allowedPath));
      const token = this.storeArtifactModel(parsed.projectId, allowedPath, "presentation", model);
      return {
        kind: "presentation",
        mimeType: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
        path: allowedPath,
        size: info.size,
        presentationToken: token,
        metadata: { width: model.width, height: model.height, limited: model.limited, slideCount: model.slides.length },
      };
    }
    const formats: Record<string, [string, string, string?]> = {
      ".png": ["image", "image/png"], ".jpg": ["image", "image/jpeg"], ".jpeg": ["image", "image/jpeg"],
      ".webp": ["image", "image/webp"], ".gif": ["image", "image/gif"], ".mp4": ["video", "video/mp4"],
      ".webm": ["video", "video/webm"], ".ogv": ["video", "video/ogg"],
      ".pdf": ["pdf", "application/pdf"],
      ".md": ["markdown", "text/markdown", "markdown"], ".markdown": ["markdown", "text/markdown", "markdown"],
      ".html": ["html", "text/html", "html"], ".htm": ["html", "text/html", "html"],
      ".js": ["code", "text/javascript", "javascript"], ".jsx": ["code", "text/javascript", "jsx"],
      ".ts": ["code", "text/typescript", "typescript"], ".tsx": ["code", "text/typescript", "tsx"],
      ".json": ["code", "application/json", "json"], ".css": ["code", "text/css", "css"],
      ".py": ["code", "text/x-python", "python"], ".ps1": ["code", "text/plain", "powershell"],
      ".sh": ["code", "text/x-shellscript", "shell"], ".sql": ["code", "text/plain", "sql"],
      ".yaml": ["code", "text/yaml", "yaml"], ".yml": ["code", "text/yaml", "yaml"],
      ".xml": ["code", "application/xml", "xml"], ".svg": ["code", "image/svg+xml", "xml"],
      ".txt": ["text", "text/plain"], ".log": ["text", "text/plain"],
      ".diff": ["code", "text/plain", "diff"], ".patch": ["code", "text/plain", "diff"],
    };
    const format = formats[extname(allowedPath).toLowerCase()];
    if (!format) throw new Error("This file type cannot be previewed safely.");
    const info = await stat(allowedPath);
    if (!info.isFile()) throw new Error("Artifact preview requires a file.");
    const binary = format[0] === "image" || format[0] === "video" || format[0] === "pdf";
    const limit = format[0] === "video" ? 50_000_000 : binary ? 20_000_000 : 2_000_000;
    if (info.size > limit) throw new Error(`Artifact exceeds the ${limit / 1_000_000} MB preview limit.`);
    const bytes = await readFile(allowedPath);
    // HTML gets a loopback preview URL alongside the raw text: served over http:// from its own
    // directory, its scripts run and its relative assets resolve. The sandboxed srcDoc viewer is
    // still the fallback (and the safe-mode toggle) — this only adds the working option.
    const previewUrl = format[0] === "html" && this.dependencies.webServerPort
      ? `http://127.0.0.1:${this.dependencies.webServerPort()}/artifact-preview/${mintArtifactPreviewToken(dirname(allowedPath))}/${encodeURIComponent(basename(allowedPath))}`
      : undefined;
    return { kind: format[0], mimeType: format[1], path: allowedPath, size: info.size,
      ...(previewUrl ? { previewUrl } : {}),
      ...(binary ? { dataUrl: `data:${format[1]};base64,${bytes.toString("base64")}` }
        : { text: bytes.toString("utf8"), language: format[2] }) };
  }
  async writeArtifact(input: unknown): Promise<void> {
    const parsed = artifactWriteInputSchema.parse(input);
    const project = this.dependencies.repository.getProject(parsed.projectId);
    if (!project) throw new Error("Project not found.");
    const allowedPath = await assertAllowedPath(parsed.path, { roots: [project.workspacePath] });
    if (![".md", ".markdown"].includes(extname(allowedPath).toLowerCase())) throw new Error("Only Markdown files can be edited in Coterm.");
    if (!(await stat(allowedPath)).isFile()) throw new Error("Markdown editor requires a file.");
    if (Buffer.byteLength(parsed.text, "utf8") > 2_000_000) throw new Error("Markdown file exceeds the 2 MB edit limit.");
    await writeFile(allowedPath, parsed.text, "utf8");
  }
  renameProject(input: unknown) {
    const parsed = renameProjectInputSchema.parse(input);
    return this.dependencies.repository.renameProject(parsed.projectId, parsed.name);
  }
  pinProject(input: unknown) {
    const parsed = projectStateInputSchema.parse(input);
    return this.dependencies.repository.setProjectPinned(parsed.projectId, parsed.value);
  }
  reorderProjects(input: unknown) {
    const parsed = reorderProjectsInputSchema.parse(input);
    return this.dependencies.repository.reorderProjects(parsed.projectIds);
  }
  archiveProject(input: unknown) {
    const parsed = projectStateInputSchema.parse(input);
    return this.dependencies.repository.setProjectArchived(parsed.projectId, parsed.value);
  }
  async deleteProject(input: unknown): Promise<void> {
    const parsed = deleteProjectInputSchema.parse(input);
    // Refuse before closing anything if a sandbox has uncommitted work.
    await this.dependencies.worktrees?.assertProjectCanDelete(parsed.projectId);
    // Close every dock tile for this project. closeTile kills the PTY,
    // removes the tile, recomputes the split, persists, and broadcasts —
    // so the dock stays consistent with the soon-to-be-deleted project row.
    const layout = await this.dock.getDockLayout();
    const tileIds = layout.tiles.filter((t) => t.projectId === parsed.projectId).map((t) => t.terminalId);
    for (const terminalId of tileIds) {
      try { await this.dock.closeTile(terminalId); } catch { /* tile already gone */ }
    }
    // Kill any PTYs that had no dock tile (orphaned in the PtyManager map).
    for (const t of this.dependencies.terminals.list(parsed.projectId)) {
      if (t.status === "running") {
        try { this.dependencies.terminals.kill(t.id); } catch { /* already exited */ }
      }
    }
    // Physical worktrees must be removed before the DB cascade drops their
    // rows. cleanup is idempotent and refuses dirty/running sandboxes.
    if (this.dependencies.worktrees) {
      for (const worktree of this.dependencies.worktrees.list(parsed.projectId)) {
        await this.dependencies.worktrees.cleanup(worktree.id);
      }
    }
    // B — remove Coterm-owned checkpoint refs/snapshots while the project path
    // is still available. This never touches user branches/index/worktree.
    await this.dependencies.checkpointer?.cleanupProjectSnapshots(parsed.projectId).catch(() => undefined);
    await this.dependencies.repository.deleteProject(parsed.projectId);
    this.dependencies.events.emit("terminalListChanged", { projectId: parsed.projectId });
  }
  createConversation(input: unknown) {
    const parsed = createConversationInputSchema.parse(input);
    if (!this.dependencies.repository.getProject(parsed.projectId)) {
      throw new Error("Project not found.");
    }
    return this.dependencies.repository.createConversation(
      parsed.projectId, parsed.name, parsed.provider,
    );
  }
  continueConversationWithProvider(input: unknown) {
    const parsed = continueConversationInputSchema.parse(input);
    return this.dependencies.repository.createContinuationConversation(
      parsed.sourceConversationId,
      parsed.targetProvider,
    );
  }
  renameConversation(input: unknown) {
    const parsed = renameConversationInputSchema.parse(input);
    return this.dependencies.repository.renameConversation(parsed.conversationId, parsed.name);
  }
  archiveConversation(input: unknown) {
    const parsed = conversationStateInputSchema.parse(input);
    return this.dependencies.repository.setConversationArchived(parsed.conversationId, parsed.value);
  }
  async deleteConversation(input: unknown): Promise<void> {
    const conversationId = idSchema.parse(input);
    const attachmentPaths = await this.dependencies.repository.deleteConversation(conversationId);
    await Promise.all(attachmentPaths.map(async (localPath) => {
      try {
        await rm(await assertAllowedPath(localPath, { roots: [join(this.dependencies.userDataPath, "attachments")] }), { force: true });
      } catch {
        // best-effort: file may already be gone
      }
    }));
  }
  setConversationClaudeModel(input: unknown) {
    const parsed = conversationModelInputSchema.parse(input);
    return this.dependencies.repository.setConversationClaudeModel(
      parsed.conversationId,
      parsed.model,
    );
  }
  listEvents(conversationId: unknown) {
    return this.dependencies.repository.listEvents(idSchema.parse(conversationId));
  }
  async listProjectSessions(projectId: unknown) {
    const id = idSchema.parse(projectId);
    const repository = this.dependencies.repository;
    const project = repository.getProject(id);
    if (!project) throw new Error("Project not found.");
    const rawRows = repository.listProjectSessions(id);
    const knownNativeIds = new Set(rawRows.map((session) => session.nativeSessionId).filter(Boolean));
    const history = this.dependencies.claudeHistory;
    // Projected claude-history rows first (pure mapping below); the Codex
    // title lookup batches both groups into one pass over the state DB.
    const projected = history ? await history.list(project, repository.listProjects()) : [];
    const adoptable = projected.filter((session) => !knownNativeIds.has(session.nativeSessionId));
    const codexTitleMemo = this.codexSessionTitles([
      ...rawRows.map((session) => ({ profileId: session.profileId, nativeSessionId: session.nativeSessionId })),
      ...adoptable.map((session) => ({ profileId: session.profileId, nativeSessionId: session.nativeSessionId })),
    ]);
    const codexTitleFor = (profileId: string | null | undefined, nativeSessionId: string | null | undefined) =>
      codexTitleMemo.get(`${profileId ?? ""}\u0000${nativeSessionId ?? ""}`) ?? null;
    const sessions = rawRows.map((session) => {
      // Codex history naming: the row's own name/aiTitle channels are claude
      // jsonl concepts — codex carries its generated title in the state DB
      // (threads.name), so without this lookup the sidebar falls back to the
      // raw first-prompt remnant. Same prompt-echo guards as the pane header.
      const codexTitle = codexTitleFor(session.profileId, session.nativeSessionId);
      return {
        ...session,
        conversationName: composeDbName(session.summary, codexTitle ?? session.conversationName),
        tokenTotals: null,
      };
    });
    const merged = history ? [
      ...sessions,
      ...adoptable.map((session) => ({
        source: "claude-history" as const,
        providerSessionId: null,
        conversationId: null,
        projectId: session.projectId,
        conversationName: composeHistoryName(
          codexTitleFor(session.profileId, session.nativeSessionId) ?? session.aiTitle,
          session.firstPrompt,
          session.title,
        ),
        profileId: session.profileId,
        nativeSessionId: session.nativeSessionId,
        historyKey: session.key,
        sizeBytes: session.sizeBytes,
        status: "idle" as const,
        summary: null,
        tokenTotals: null,
        conversationUpdatedAt: session.updatedAt,
        sessionUpdatedAt: session.updatedAt,
      })),
    ] : sessions;
    const sessionIndex = this.dependencies.sessionIndex;
    const tokenMap = sessionIndex
      ? sessionIndex.stats(merged.map((s) => s.nativeSessionId).filter((n): n is string => Boolean(n)))
      : null;
    const withTokens = tokenMap
      ? merged.map((session) => ({
          ...session,
          tokenTotals: session.nativeSessionId ? (tokenMap.get(session.nativeSessionId) ?? null) : null,
        }))
      : merged;
    return withTokens.sort((left, right) => right.conversationUpdatedAt.localeCompare(left.conversationUpdatedAt));
  }
  findProviderSession(conversationId: unknown) {
    const id = idSchema.parse(conversationId);
    const conversation = this.dependencies.repository.getConversation(id);
    if (!conversation) return null;
    const session = this.dependencies.repository.findProviderSession(id, conversation.activeProvider);
    if (!session) return null;
    return { nativeSessionId: session.nativeSessionId };
  }
  async summarizeConversation(input: unknown) {
    if (!this.dependencies.summarizer) throw new Error("Conversation summaries are unavailable.");
    return this.dependencies.summarizer.summarize(
      conversationSummaryInputSchema.parse(input).conversationId,
    );
  }
  async listClaudeHistory(input: unknown) {
    const history = this.dependencies.claudeHistory;
    if (!history) throw new Error("Claude history is unavailable.");
    const parsed = claudeHistoryListInputSchema.parse(input);
    const project = this.dependencies.repository.getProject(parsed.projectId);
    if (!project) throw new Error("Project not found.");
    return history.list(project, this.dependencies.repository.listProjects());
  }
  async readClaudeHistory(input: unknown) {
    const history = this.dependencies.claudeHistory;
    if (!history) throw new Error("Claude history is unavailable.");
    const parsed = claudeHistoryReadInputSchema.parse(input);
    const project = this.dependencies.repository.getProject(parsed.projectId);
    if (!project) throw new Error("Project not found.");
    return history.read(project, this.dependencies.repository.listProjects(), parsed.key);
  }
  async adoptClaudeHistory(input: unknown) {
    const history = this.dependencies.claudeHistory;
    if (!history) throw new Error("Claude history is unavailable.");
    const parsed = claudeHistoryReadInputSchema.parse(input);
    const repository = this.dependencies.repository;
    const project = repository.getProject(parsed.projectId);
    if (!project) throw new Error("Project not found.");
    const resolved = await history.resolve(project, repository.listProjects(), parsed.key);
    const existing = repository.findConversationByNativeSession(
      "claude-official",
      resolved.nativeSessionId,
    );
    if (existing) return existing.archived
      ? repository.setConversationArchived(existing.id, false)
      : existing;
    const conversation = await repository.createConversation(
      project.id,
      resolved.session.title,
      "claude-official",
    );
    const providerSession = await repository.getOrCreateProviderSession(
      conversation.id,
      "claude-official",
    );
    await repository.updateProviderSession(providerSession.id, {
      nativeSessionId: resolved.nativeSessionId,
    });
    return conversation;
  }
  sendMessage(input: unknown) {
    return this.dependencies.runs.send(messageInputSchema.parse(input));
  }
  cancelMessage(turnId: unknown) {
    return this.dependencies.runs.cancel(idSchema.parse(turnId));
  }
  runTerminalCommand(input: unknown) {
    return this.dependencies.runs.command(terminalCommandInputSchema.parse(input));
  }
  resolveApproval(input: unknown): void {
    const parsed = approvalResolveInputSchema.parse(input);
    this.dependencies.approvals.resolve(parsed.requestId, parsed.decision);
  }

  resolveUserInput(input: unknown): void {
    const parsed = userInputResolveInputSchema.parse(input);
    if (!this.dependencies.approvals.resolveInput) throw new Error("User input is unavailable.");
    this.dependencies.approvals.resolveInput(parsed.requestId, parsed.answers);
  }
  async startCouncil(input: unknown) {
    const parsed = councilInputSchema.parse(input);
    const conversation = this.dependencies.repository.getConversation(parsed.conversationId);
    if (!conversation) throw new Error("Conversation not found.");
    const project = this.dependencies.repository.getProject(conversation.projectId);
    if (!project) throw new Error("Project not found.");
    return this.dependencies.council.start(parsed, project.workspacePath);
  }
  cancelCouncil(turnGroupId: unknown) {
    return this.dependencies.council.cancel(idSchema.parse(turnGroupId));
  }
  refreshProviders(input?: unknown) {
    const settings = this.dependencies.repository.getSettings();
    const profiles = buildActiveProfiles(settings.customProfiles);
    const request = providerRefreshInputSchema.parse(input ?? {});
    return detectProviders({
      proxyUrl: settings.proxyUrl,
      // Stage 2: probe with the effective local route token (per-profile
      // override first).
      authToken: localRouteAuthToken(profiles),
      profiles,
      // Membership is the ACTIVE profile table, so a hot-registered model gets
      // a status row instead of rendering as「未安裝」.
      options: deriveAgentOptions(settings.customProfiles),
      force: request.force === true,
      focus: request.focus ?? null,
    });
  }
  async createTerminal(input: unknown) {
    const parsed = terminalCreateInputSchema.parse(input);
    const project = this.dependencies.repository.getProject(parsed.projectId);
    if (!project) throw new Error("Project not found.");
    const cwd = await assertAllowedPath(parsed.cwd, {
      roots: [project.workspacePath, this.dependencies.userDataPath, this.dependencies.tempPath],
    });
    const terminal = this.dependencies.terminals.create({ ...parsed, cwd });
    await this.dependencies.repository.appendTerminalEvent({
      projectId: project.id,
      terminalId: terminal.id,
      type: "terminal.session.started",
      summary: `${terminal.title} started.`,
      payload: {
        profile: terminal.profile,
        cwd: terminal.cwd,
        isAgent: terminal.isAgent,
        agentProfile: terminal.agentProfile,
      },
    });
    // council 2026-09-26 #7: bump first, then a SINGLE terminalListChanged.
    // The old order emitted twice (plain → with projectIds), so every client
    // re-sorted the sidebar twice per window open.
    const bumped = await this.bumpProjectRecency(project.id);
    if (!bumped) this.dependencies.events.emit("terminalListChanged", { projectId: project.id });
    return terminal;
  }
  writeTerminal(input: unknown): TerminalWriteResult {
    const parsed = terminalWriteInputSchema.parse(input);
    const source = parsed.source === "automation" ? "automation" : "human";
    let pendingMutation: { id: string; payloadHash: string } | null = null;
    if (parsed.clientMutationId) {
      const now = Date.now();
      for (const [id, record] of this.terminalMutationIds) if (record.expiresAt <= now) this.terminalMutationIds.delete(id);
      const payloadHash = createHash("sha256").update(JSON.stringify({
        terminalId: parsed.terminalId,
        data: parsed.data,
        source,
        waitForShellReady: parsed.waitForShellReady === true,
      })).digest("hex").slice(0, 32);
      const existing = this.terminalMutationIds.get(parsed.clientMutationId);
      // §10.4 exact-once: identical retry dedupes without a second PTY write;
      // a reused id carrying a DIFFERENT payload is a client bug, so it fails
      // loudly instead of silently sending the wrong text.
      if (existing) {
        if (existing.payloadHash === payloadHash) return { status: "deduped" };
        throw new TerminalMutationConflictError();
      }
      // Record only AFTER the write succeeds (write is synchronous): if the
      // PTY already exited, the caller's retry must be able to actually write
      // instead of being deduped against a write that never happened.
      pendingMutation = { id: parsed.clientMutationId, payloadHash };
    }
    if (parsed.waitForShellReady) {
      this.dependencies.terminals.writeWhenShellReady(parsed.terminalId, parsed.data, source);
    } else {
      this.dependencies.terminals.write(parsed.terminalId, parsed.data, source);
    }
    if (pendingMutation) {
      this.terminalMutationIds.set(pendingMutation.id, { payloadHash: pendingMutation.payloadHash, expiresAt: Date.now() + 5 * 60_000 });
      while (this.terminalMutationIds.size > 1000) this.terminalMutationIds.delete(this.terminalMutationIds.keys().next().value!);
    }
    return { status: "written" };
  }
  resizeTerminal(input: unknown): void {
    const parsed = terminalResizeInputSchema.parse(input);
    this.dependencies.terminals.resize(parsed.terminalId, parsed.cols, parsed.rows);
    // Broadcast the new geometry to all clients (web/mobile) so they resize
    // their local xterm to match the shared PTY, preventing re-wrap garble.
    void this.dock.setPtyGeometry(parsed.cols, parsed.rows);
  }
  /**
   * AT-158 option 1: a remote (web/mobile) client may not call resizeTerminal
   * directly (browser-api no-ops it — competing writers re-wrap output at
   * conflicting widths and garble every client). But a phone mirroring a small
   * desktop tile's PTY ends with a canvas that stops well short of the screen
   * bottom ("桌機全展開 → 手機底部被擠壓"). This is the legitimate intent
   * channel: the client names what it is looking at, MAIN performs the real
   * ConPTY resize itself, and the broadcast keeps one geometry truth.
   *
   * Rows-only claim: columns stay at the PTY's own width so the phone's
   * wide-grid horizontal pan guarantee (responsive-geometry e2e) is intact
   * and no re-wrap churn hits other clients' scrollback. Desktop tiles
   * reclaim the geometry on their next fit (ResizeObserver → resizeTerminal),
   * which is exactly how a desktop re-layout already returns ownership.
   */
  requestTerminalGeometry(input: unknown): void {
    const parsed = terminalResizeInputSchema.parse(input);
    const terminal = this.dependencies.terminals.get(parsed.terminalId);
    if (!terminal) return;
    const rows = Math.max(8, Math.min(160, parsed.rows));
    if (terminal.rows === rows) return;
    this.dependencies.terminals.resize(parsed.terminalId, terminal.cols, rows);
    void this.dock.setPtyGeometry(terminal.cols, rows);
  }
  async refreshTerminal(terminalId: unknown): Promise<void> {
    const id = idSchema.parse(terminalId);
    const terminal = this.dependencies.terminals.get(id);
    if (!terminal) return;
    // getTerminalWorkspace returns a live scrollback map keyed by terminalId.
    const workspace = await this.getTerminalWorkspace(terminal.projectId);
    const scrollback = workspace.scrollback[id] ?? "";
    const revision = workspace.scrollbackRevision[id] ?? 0;
    // ponytail: emit the scrollback as a replace:true terminalData event so the
    // renderer resets its xterm buffer and rewrites at the CURRENT canvas width.
    // The old impl wrote \x1b[2J + scrollback into the PTY (ConPTY stdin), which
    // re-flowed the clear code and re-garbled the very display we meant to fix.
    // The PTY's own scrollback snapshot is clean (raw byte stream) — only the
    // xterm canvas was wrong. Going through the same replace path as reconnect
    // replay (TerminalDock.tsx payload.replace branch) keeps one recovery path.
    // Empty scrollback still emits a clear so the user sees the button did
    // something (previously `if (!scrollback) return` silently no-op'd).
    this.dependencies.events.emit("terminalData", {
      terminalId: id,
      projectId: terminal.projectId,
      data: scrollback,
      replace: true,
      force: true,
      revision,
    });
  }
  renameTerminal(input: unknown) {
    const parsed = terminalRenameInputSchema.parse(input);
    return this.dependencies.terminals.rename(parsed.terminalId, parsed.title);
  }
  /**
   * 1.5.45 hand-colouring for a plain terminal. Deliberately the same shape and
   * propagation as renameTerminal (parse → PtyManager setter → terminalListChanged)
   * so the manual entry point is a sibling of rename, not a new mechanism.
   */
  setTerminalLabel(input: unknown) {
    const parsed = terminalSetLabelInputSchema.parse(input);
    return this.dependencies.terminals.setLabel(parsed.terminalId, parsed.label);
  }
  async getTerminalTranscript(terminalId: unknown): Promise<TerminalTranscript> {
    const id = idSchema.parse(terminalId);
    const terminal = this.dependencies.terminals.get(id);
    if (!terminal) {
      return { terminalId: id, status: "not_found", provider: "unknown", sessionBinding: "none", messages: [], updatedAt: new Date().toISOString(), stale: false, reasonCode: "terminal_not_found" };
    }
    return this.transcriptService.get({
      terminalId: id,
      cwd: terminal.cwd,
      startedAt: terminal.startedAt,
      nativeSessionId: terminal.nativeSessionId,
      agentProfile: terminal.agentProfile,
      reservedSessionIds: this.dependencies.terminals.dashboardSnapshot()
        .map(({ info }) => info.id !== id ? info.nativeSessionId : null)
        .filter((sessionId): sessionId is string => Boolean(sessionId)),
      // /clear or an in-session /resume moved the agent to a new file: keep the terminal's id in step
      // so the reader, resume and header all follow the session the user is actually in.
      onRebind: (sessionId) => this.dependencies.terminals.setNativeSessionId(id, sessionId),
    });
  }
  /**
   * Pane-header "Session 資訊" block (2026-10-23): metadata-only session
   * pointer for agent panes. The transcript path comes from the SAME
   * session-file resolver the reader uses, so it follows /clear and in-session
   * /resume hops; unresolved/ambiguous bindings simply return null fields and
   * the renderer hides them. null return = plain shell pane (block hidden).
   */
  async getTerminalSessionInfo(terminalId: unknown): Promise<TerminalSessionInfo | null> {
    const id = idSchema.parse(terminalId);
    const terminal = this.dependencies.terminals.get(id);
    if (!terminal || !terminal.isAgent) return null;
    const provider = providerFor(terminal.agentProfile);
    let nativeSessionId = terminal.nativeSessionId;
    let transcriptPath: string | null = null;
    try {
      const resolved = await this.transcriptService.resolveSessionFile({
        terminalId: id,
        cwd: terminal.cwd,
        startedAt: terminal.startedAt,
        nativeSessionId: terminal.nativeSessionId,
        agentProfile: terminal.agentProfile,
        reservedSessionIds: this.dependencies.terminals.dashboardSnapshot()
          .map(({ info: other }) => other.id !== id ? other.nativeSessionId : null)
          .filter((sessionId): sessionId is string => Boolean(sessionId)),
        onRebind: (sessionId) => this.dependencies.terminals.setNativeSessionId(id, sessionId),
      });
      if (resolved.status === "ready" && resolved.file) transcriptPath = resolved.file;
      if (resolved.reboundSessionId) nativeSessionId = resolved.reboundSessionId;
    } catch {
      /* best-effort: an unreadable sessions root leaves the path blank, not broken */
    }
    const resumeCommand =
      provider === "claude" && nativeSessionId
        ? `claude --resume ${nativeSessionId}`
        : provider === "codex" && nativeSessionId
          ? `codex resume ${nativeSessionId}`
          : null;
    return {
      terminalId: id,
      agentProfile: terminal.agentProfile,
      provider,
      nativeSessionId,
      cwd: terminal.cwd,
      pid: terminal.pid,
      model: terminal.contextUsage?.model ?? null,
      transcriptPath,
      resumeCommand,
    };
  }
  markTerminalAgent(input: unknown) {
    const parsed = terminalMarkAgentInputSchema.parse(input);
    const info = this.dependencies.terminals.markAgent(parsed.terminalId, parsed.agentProfile);
    this.dependencies.events.emit("terminalListChanged", { projectId: info.projectId });
    return info;
  }
  markTerminalAgentOwned(input: unknown) {
    const parsed = terminalIdInputSchema.parse(input);
    const info = this.dependencies.terminals.markAgentOwned(parsed.terminalId);
    this.dependencies.events.emit("terminalListChanged", { projectId: info.projectId });
    return info;
  }
  async setTerminalNativeSessionId(input: unknown): Promise<void> {
    const parsed = terminalSetNativeSessionIdInputSchema.parse(input);
    // A — trusted resume phase 2: if this terminal is bound to a worktree,
    // persist the native session id + a metadata-only resume command on the
    // worktree row. The resume command is NEVER an arbitrary shell string —
    // it is a tiny JSON hint { profile, sessionId } rebuilt from an allowlist
    // at resume time. No token/secret is stored.
    const terminal = this.dependencies.terminals.get(parsed.terminalId);
    if (terminal?.worktreeId && terminal.agentProfile) {
      const worktree = this.requireWorktrees().get(terminal.worktreeId);
      if (!worktree || worktree.status !== "active") throw new Error("Worktree is not active.");
      this.assertResumeTerminal(terminal, worktree, terminal.agentProfile);
      const resumeCommand = JSON.stringify({
        profile: terminal.agentProfile,
        sessionId: parsed.nativeSessionId,
      });
      await this.dependencies.repository.bindWorktreeSession(
        terminal.worktreeId,
        parsed.nativeSessionId,
        resumeCommand,
      );
    }
    this.dependencies.terminals.setNativeSessionId(parsed.terminalId, parsed.nativeSessionId);
  }
  killTerminal(input: unknown): void {
    const parsed = terminalIdInputSchema.parse(input);
    const terminal = this.dependencies.terminals.get(parsed.terminalId);
    const projectId = terminal?.projectId ?? null;
    this.dependencies.terminals.kill(parsed.terminalId);
    if (projectId) this.dependencies.events.emit("terminalListChanged", { projectId });
  }
  listTerminals(projectId: unknown) {
    return this.dependencies.terminals.list(idSchema.parse(projectId));
  }
  getPtyState(terminalId: unknown) {
    return this.dependencies.terminals.getPtyState(idSchema.parse(terminalId));
  }
  setTerminalKeepalive(input: unknown) {
    const parsed = terminalKeepaliveSetInputSchema.parse(input);
    return this.dependencies.terminals.setTerminalKeepalive(parsed.terminalId, parsed.hours);
  }
  listTerminalKeepalives() {
    return this.dependencies.terminals.listTerminalKeepaliveStates();
  }
  /**
   * Pane-header handoff export (2026-09-26 maintainer). Official claude/codex tiles
   * only (the exporter double-checks). Needs dependencies.clipboardWrite —
   * injected from electron main so this module stays electron-free for tests.
   */
  async exportTerminalHandoff(terminalId: unknown) {
    // council 2026-09-26 R2 #8: never let a validation/lookup throw escape to
    // the IPC layer as an raw exception — the renderer shows error state
    // either way, so return a structured failure.
    try {
      const id = idSchema.parse(terminalId);
      const info = this.dependencies.terminals.get(id);
      const clipboardWrite = this.dependencies.clipboardWrite;
      if (!clipboardWrite) return { ok: false as const, error: "clipboard_unavailable" };
      return await exportTerminalHandoffCore(
        info
          ? {
              id: info.id,
              cwd: info.cwd,
              agentProfile: info.agentProfile,
              nativeSessionId: info.nativeSessionId,
            }
          : null,
        {
          outDir: join(this.dependencies.userDataPath, "handoffs"),
          getScrollbackTail: (tid, max) => this.dependencies.terminals.getScrollbackTail?.(tid, max) ?? null,
          clipboard: { writeText: clipboardWrite },
        },
      );
    } catch (error) {
      // council R3 #7 / R4 #3: fixed code to the renderer (raw error text may
      // carry local paths), but still log the detail here — this catch covers
      // id validation and lookup failures the core exporter never sees.
      logger.warn("app", "handoff.ipc.failed", "Handoff export failed before the core exporter.", {
        error: error instanceof Error ? error.message.slice(0, 200) : String(error),
      });
      return { ok: false as const, error: "export_failed" };
    }
  }
  getAgentStateExplanation(terminalId: unknown) {
    return this.dependencies.terminals.getAgentStateExplanation?.(idSchema.parse(terminalId)) ?? null;
  }
  listAttention() {
    return this.dependencies.attention.list();
  }
  resolveAttention(input: unknown): void {
    const parsed = attentionResolveInputSchema.parse(input);
    this.dependencies.attention.resolve(parsed.notificationId);
  }
  getLastCommand(terminalId: unknown) {
    return this.dependencies.terminals.getLastCommand(idSchema.parse(terminalId));
  }
  async getTerminalDashboard(): Promise<TerminalDashboardEntry[]> {
    const layout = await this.dock.getDockLayout();
    const selectedId = layout.selectedTerminalId;
    const weightMap = new Map(layout.tiles.map((tile) => [tile.terminalId, tile.weight]));
    const snapshots = this.dependencies.terminals.dashboardSnapshot();
    return snapshots.map(({ info, ptyState, lastCommand }) => ({
      id: info.id,
      pid: info.pid,
      projectId: info.projectId,
      cwd: info.cwd,
      profile: info.profile,
      agentProfile: info.agentProfile,
      title: info.title,
      ptyState,
      weight: weightMap.get(info.id) ?? 1,
      selected: info.id === selectedId,
      isAgent: info.isAgent,
      ownedByAgentApi: info.ownedByAgentApi,
      lastCommand,
    }));
  }
  async getTerminalWorkspace(projectId: unknown): Promise<TerminalWorkspaceState> {
    const id = idSchema.parse(projectId);
    const existing = this.terminalWorkspaceInFlight.get(id);
    if (existing) return existing;
    const promise = this.doGetTerminalWorkspace(id);
    this.terminalWorkspaceInFlight.set(id, promise);
    try {
      return await promise;
    } finally {
      this.terminalWorkspaceInFlight.delete(id);
    }
  }

  private async doGetTerminalWorkspace(id: string) {
    const project = this.dependencies.repository.getProject(id);
    if (!project) throw new Error("Project not found.");
    const persisted = this.dependencies.repository.loadTerminalWorkspace(id);
    let live = this.dependencies.terminals.list(id);
    let restored = false;
    const snapshots = this.dependencies.terminals.snapshots(id);
    const scrollback: Record<string, string> = Object.fromEntries(
      snapshots.map((snapshot) => [snapshot.info.id, snapshot.scrollback]),
    );
    const scrollbackRevision: Record<string, number> = Object.fromEntries(
      snapshots.map((snapshot) => [snapshot.info.id, snapshot.revision]),
    );
    if (live.length === 0 && persisted?.panes.length) {
      const roots = [project.workspacePath, this.dependencies.userDataPath, this.dependencies.tempPath];
      const panes = (await Promise.all(persisted.panes.map(async (pane) => {
        try { return { ...pane, cwd: await assertAllowedPath(pane.cwd, { roots }) }; }
        catch { return null; }
      }))).filter((pane) => pane !== null);
      live = panes.map((pane) => {
        const info = this.dependencies.terminals.create({
          projectId: id,
          profile: pane.profile,
          cwd: pane.cwd,
          title: pane.title,
          isAgent: pane.isAgent,
          agentProfile: pane.agentProfile,
        });
        scrollback[info.id] = `${pane.scrollback}\r\n\x1b[33m[Coterm] Previous process ended; a new shell was restored.\x1b[0m\r\n`;
        scrollbackRevision[info.id] = 0;
        return info;
      });
      restored = true;
    }
    const activeId = persisted?.activeIndex == null ? (live[0]?.id ?? null)
      : (live[persisted.activeIndex]?.id ?? live[0]?.id ?? null);
    const secondaryId = persisted?.secondaryIndex == null ? null : (live[persisted.secondaryIndex]?.id ?? null);
    return { terminals: live, split: live.length > 1 ? (persisted?.split ?? "vertical") : "single" as const,
      activeId, secondaryId, scrollback, scrollbackRevision, restored };
  }
  async saveTerminalWorkspace(input: unknown): Promise<void> {
    const parsed = terminalWorkspaceSaveInputSchema.parse(input);
    const snapshots = this.dependencies.terminals.snapshots(parsed.projectId);
    const byId = new Map(snapshots.map((snapshot) => [snapshot.info.id, snapshot]));
    const ordered = parsed.terminalIds.flatMap((id) => {
      const snapshot = byId.get(id);
      return snapshot ? [snapshot] : [];
    });
    await this.dependencies.repository.saveTerminalWorkspace(parsed.projectId, {
      split: parsed.split,
      activeIndex: parsed.activeId ? parsed.terminalIds.indexOf(parsed.activeId) : null,
      secondaryIndex: parsed.secondaryId ? parsed.terminalIds.indexOf(parsed.secondaryId) : null,
    }, ordered.map(({ info, scrollback }) => ({ ...info, scrollback })));
  }

  // --- Dock layout (terminal-first overhaul) ---------------------------------

  getDockLayout(): Promise<DockLayout> {
    return this.dock.getDockLayout();
  }

  /**
   * Session restore (2026-10-23): index.ts constructs SessionRestoreService
   * with the dock manager. Public accessor instead of duplicated state; the
   * manager is still created lazily on first dock access.
   */
  getDockManager(): DockLayoutManager {
    return this.dock;
  }

  // --- A — Worktree sandbox + trusted resume --------------------------------

  private requireWorktrees(): WorktreeManager {
    const worktrees = this.dependencies.worktrees;
    if (!worktrees) throw new Error("Worktree sandboxes are unavailable.");
    return worktrees;
  }

  private assertResumeTerminal(
    terminal: NonNullable<ReturnType<AppOperationsDependencies["terminals"]["get"]>>,
    worktree: Worktree,
    expectedProfile: string,
  ): void {
    if (terminal.status !== "running") throw new Error("Resume terminal is not running.");
    if (terminal.worktreeId !== worktree.id) throw new Error("Terminal is not bound to this worktree.");
    const terminalPath = resolve(terminal.cwd);
    const worktreePath = resolve(worktree.worktreePath);
    const samePath = process.platform === "win32"
      ? terminalPath.toLowerCase() === worktreePath.toLowerCase()
      : terminalPath === worktreePath;
    if (!samePath) throw new Error("Terminal cwd does not match the worktree path.");
    if (terminal.agentProfile !== expectedProfile) {
      throw new Error("Terminal agent profile does not match the trusted resume profile.");
    }
  }

  async createWorktree(input: unknown): Promise<Worktree> {
    const parsed = worktreeCreateInputSchema.parse(input);
    return this.requireWorktrees().create(parsed);
  }

  listWorktrees(input: unknown): Worktree[] {
    const parsed = worktreeListInputSchema.parse(input);
    return this.requireWorktrees().list(parsed.projectId);
  }

  getWorktree(input: unknown): Worktree | null {
    const parsed = worktreeIdInputSchema.parse(input);
    return this.requireWorktrees().get(parsed.worktreeId);
  }

  async worktreeDiffSummary(input: unknown) {
    const parsed = worktreeIdInputSchema.parse(input);
    return this.requireWorktrees().diffSummary(parsed.worktreeId);
  }

  async mergeWorktree(input: unknown): Promise<Worktree> {
    const parsed: WorktreeMergeInput = worktreeMergeInputSchema.parse(input);
    return this.requireWorktrees().merge(parsed.worktreeId, parsed.confirm);
  }

  async abortWorktree(input: unknown): Promise<Worktree> {
    const parsed = worktreeIdInputSchema.parse(input);
    return this.requireWorktrees().abort(parsed.worktreeId);
  }

  async cleanupWorktree(input: unknown): Promise<void> {
    const parsed = worktreeIdInputSchema.parse(input);
    return this.requireWorktrees().cleanup(parsed.worktreeId);
  }

  /**
   * Bind a native session id to a worktree (trusted resume phase 2). Called
   * when an agent PTY emits its session id. Validates the worktree is active
   * and the terminal is bound to it before persisting.
   */
  async bindWorktreeSession(input: unknown): Promise<void> {
    const parsed = worktreeBindSessionInputSchema.parse(input);
    const worktrees = this.requireWorktrees();
    const worktree = worktrees.get(parsed.worktreeId);
    if (!worktree) throw new Error("Worktree not found.");
    if (worktree.status !== "active") {
      throw new Error(`Worktree is not active (status: ${worktree.status}).`);
    }
    const terminal = this.dependencies.terminals.get(parsed.terminalId);
    if (!terminal) throw new Error("Terminal not found.");
    this.assertResumeTerminal(terminal, worktree, parsed.agentProfile);
    // Metadata-only resume command: profile + sessionId. Rebuilt from the
    // profile allowlist at resume time — never executed verbatim.
    const resumeCommand = JSON.stringify({
      profile: parsed.agentProfile,
      sessionId: parsed.nativeSessionId,
    });
    await this.dependencies.repository.bindWorktreeSession(
      parsed.worktreeId,
      parsed.nativeSessionId,
      resumeCommand,
    );
    this.dependencies.terminals.setNativeSessionId(parsed.terminalId, parsed.nativeSessionId);
  }

  /**
   * Trusted resume: rebuild the launch command for a worktree-bound session.
   * Validates (1) the worktree is active, (2) the requested live terminal is
   * still bound to the exact worktree cwd/profile, and (3) the persisted
   * sessionId matches the schema. The launch
   * argv is rebuilt from the profile allowlist + sessionId — the persisted
   * resume_command is treated as untrusted data and NEVER executed verbatim.
   * Returns the rebuilt command string (caller writes it to the PTY).
   */
  async resumeWorktree(input: unknown): Promise<{ command: string; worktree: Worktree }> {
    await Promise.resolve();
    const parsed = worktreeResumeInputSchema.parse(input);
    const worktrees = this.requireWorktrees();
    const worktree = worktrees.get(parsed.worktreeId);
    if (!worktree) throw new Error("Worktree not found.");
    if (worktree.status !== "active") {
      throw new Error(`Worktree is not active (status: ${worktree.status}).`);
    }
    if (!worktree.nativeSessionId) {
      throw new Error("Worktree has no bound native session id.");
    }
    // Parse the persisted resume hint as UNTRUSTED data. We only read profile
    // + sessionId from it; the actual command is rebuilt below from the
    // allowlist. A tampered hint with a different profile/sessionId is caught
    // by the schema + allowlist checks.
    let hint: { profile?: unknown; sessionId?: unknown } = {};
    try {
      hint = JSON.parse(worktree.resumeCommand ?? "{}") as typeof hint;
    } catch {
      hint = {};
    }
    const profile = typeof hint.profile === "string" ? hint.profile : "";
    const sessionId = typeof hint.sessionId === "string" ? hint.sessionId : "";
    if (!profile || !sessionId) {
      throw new Error("Worktree resume hint is missing profile or sessionId.");
    }
    if (sessionId !== worktree.nativeSessionId) {
      throw new Error("Resume sessionId does not match the bound native session id.");
    }
    if (sessionId.length > 120 || !/^[A-Za-z0-9_-]{1,120}$/.test(sessionId)) {
      throw new Error("Resume sessionId failed schema validation.");
    }
    const terminal = this.dependencies.terminals.get(parsed.terminalId);
    if (!terminal) throw new Error("Resume terminal not found.");
    this.assertResumeTerminal(terminal, worktree, profile);
    // Rebuild the launch argv from the profile allowlist. This reuses the
    // Agent API's allowlisted builder so a tampered hint can never inject an
    // arbitrary command. The command targets the worktree path as cwd.
    const command = buildWorktreeResumeCommand(
      profile,
      worktree.worktreePath,
      sessionId,
      buildActiveProfiles(this.dependencies.repository.getSettings().customProfiles),
    );
    if (!command) {
      throw new Error(`Profile ${profile} is not allowed for worktree resume.`);
    }
    return { command, worktree };
  }

  // --- B — Checkpoint / undo-redo rail --------------------------------------

  private requireCheckpointer(): CheckpointManager {
    const checkpointer = this.dependencies.checkpointer;
    if (!checkpointer) throw new Error("Checkpoint rail is unavailable.");
    return checkpointer;
  }

  listCheckpoints(input: unknown): Checkpoint[] {
    const parsed = checkpointListInputSchema.parse(input);
    const filter: { conversationId?: string | null; projectId?: string; worktreeId?: string | null } = {};
    if (parsed.conversationId !== undefined) filter.conversationId = parsed.conversationId;
    if (parsed.projectId !== undefined) filter.projectId = parsed.projectId;
    if (parsed.worktreeId !== undefined) filter.worktreeId = parsed.worktreeId;
    return this.requireCheckpointer().list(filter);
  }

  getCheckpoint(input: unknown): Checkpoint | null {
    const parsed = checkpointIdInputSchema.parse(input);
    return this.requireCheckpointer().get(parsed.checkpointId);
  }

  async checkpointDiff(input: unknown): Promise<CheckpointDiff> {
    const parsed = checkpointDiffInputSchema.parse(input);
    return this.requireCheckpointer().diff(parsed.checkpointId, parsed.base);
  }

  async checkpointRestorePreview(input: unknown): Promise<CheckpointRestorePreview> {
    const parsed = checkpointRestorePreviewInputSchema.parse(input);
    return this.requireCheckpointer().restorePreview(parsed.checkpointId);
  }

  async restoreCheckpoint(input: unknown): Promise<Checkpoint> {
    const parsed = checkpointRestoreInputSchema.parse(input);
    return this.requireCheckpointer().restore(parsed);
  }

  async restoreCheckpointHunk(input: unknown): Promise<Checkpoint> {
    const parsed = checkpointHunkRestoreInputSchema.parse(input);
    return this.requireCheckpointer().restoreHunk(parsed);
  }

  async undoCheckpoint(input: unknown): Promise<Checkpoint> {
    const parsed = checkpointUndoInputSchema.parse(input);
    return this.requireCheckpointer().undo(parsed);
  }

  async redoCheckpoint(input: unknown): Promise<Checkpoint> {
    const parsed = checkpointUndoInputSchema.parse(input);
    return this.requireCheckpointer().redo(parsed);
  }

  async createExplicitCheckpoint(input: unknown): Promise<Checkpoint> {
    const parsed = checkpointCreateExplicitInputSchema.parse(input);
    return this.requireCheckpointer().createExplicit({
      projectId: parsed.projectId,
      worktreeId: parsed.worktreeId ?? null,
      phase: parsed.phase,
    });
  }

  async openTile(input: unknown): Promise<DockLayout> {
    const parsed = dockOpenTileInputSchema.parse(input);
    const layout = await this.dock.openTile(parsed.projectId, parsed.agentProfile, parsed.worktreeId, parsed.label);
    await this.bumpProjectRecency(parsed.projectId);
    return layout;
  }

  /**
   * 最近開過置頂 (2026-09-26 maintainer): a project where a window just opened floats
   * to the top of the sidebar. The new order rides on terminalListChanged so
   * every client (app/web/mobile) re-sorts without a second round trip.
   * Best-effort — ordering must never fail a window open.
   */
  private async bumpProjectRecency(projectId: string): Promise<boolean> {
    try {
      const projectIds = await this.dependencies.repository.bumpProjectToTop(projectId);
      if (projectIds && projectIds.length > 0) {
        this.dependencies.events.emit("terminalListChanged", { projectId, projectIds });
        return true;
      }
    } catch (error) {
      logger.warn("app", "project.recency.failed", "Failed to float project to the top.", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
    return false;
  }

  closeTile(input: unknown): Promise<DockLayout> {
    const parsed = dockCloseTileInputSchema.parse(input);
    return this.dock.closeTile(parsed.terminalId);
  }

  selectTile(input: unknown): Promise<DockLayout> {
    const parsed = dockSelectTileInputSchema.parse(input);
    return this.dock.selectTile(parsed.terminalId);
  }

  setDockLayout(input: unknown): Promise<DockLayout> {
    const parsed = dockSetLayoutInputSchema.parse(input);
    return this.dock.setDockLayout(parsed.rows, parsed.cols);
  }

  setExclusive(input: unknown): Promise<DockLayout> {
    const parsed = dockSetExclusiveInputSchema.parse(input);
    return this.dock.setExclusive(parsed.terminalId);
  }

  reorderTile(input: unknown): Promise<DockLayout> {
    const parsed = dockReorderTileInputSchema.parse(input);
    return this.dock.reorderTile(parsed.terminalId, parsed.toIndex);
  }

  /**
   * Register a callback fired on every dock layout mutation. Returns an
   * unsubscribe. Used by register-ipc.ts to push IPC updates to the desktop
   * renderer, and by live-socket.ts to push WS updates to web/mobile.
   */
  onDockLayoutChanged(callback: (layout: DockLayout) => void): () => void {
    return this.dock.onLayoutChanged(callback);
  }

  /**
   * Register a callback fired when an attention notification is filed or
   * resolved. Returns an unsubscribe. Used by register-ipc.ts (IPC push) and
   * live-socket.ts (WS replay/push to web/mobile).
   */
  onAttentionChanged(callback: (notification: AttentionNotification) => void): () => void {
    return this.dependencies.attention.onAttentionChanged(callback);
  }

  /**
   * Current global paid-account usage snapshot (Claude 5h/7d + Codex 7d).
   * Main-process UsageMonitor is the single source of truth; this exposes it
   * to IPC + the live socket so desktop/web/mobile render the same HUD.
   */
  /**
   * Sidebar history titles for Codex-family sessions, batched: one
   * readCodexThreadTitles connection per distinct state DB (usually one)
   * instead of reopening per row. Keys are
   * `${profileId}\u0000${nativeSessionId}`. Same gates as the old single-row
   * reader (codex-* profile + valid thread UUID; read-only, metadata-only);
   * null on any miss → callers keep their existing fallback.
   */
  private codexSessionTitles(
    requests: Array<{ profileId: string | null | undefined; nativeSessionId: string | null | undefined }>,
  ): Map<string, string | null> {
    const memo = new Map<string, string | null>();
    const pending: Array<{ key: string; profileId: string; nativeSessionId: string }> = [];
    for (const { profileId, nativeSessionId } of requests) {
      const key = `${profileId ?? ""}\u0000${nativeSessionId ?? ""}`;
      if (memo.has(key)) continue;
      if (!profileId || !nativeSessionId || !profileId.startsWith("codex-")) {
        memo.set(key, null);
      } else if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(nativeSessionId)) {
        memo.set(key, null);
      } else {
        pending.push({ key, profileId, nativeSessionId });
      }
    }
    if (!pending.length) return memo;
    let homes: ReturnType<typeof codexProfileHomesFor>;
    try {
      homes = codexProfileHomesFor(
        this.dependencies.userDataPath,
        buildActiveProfiles(this.dependencies.repository.getSettings().customProfiles),
      );
    } catch {
      for (const item of pending) memo.set(item.key, null);
      return memo;
    }
    const groups = new Map<string, Array<{ key: string; rollout: string }>>();
    for (const item of pending) {
      try {
        const storage = resolveCodexStorage(
          item.profileId,
          homes,
          {
            sessionsRoot: join(homedir(), ".codex", "sessions"),
            stateDbPath: join(homedir(), ".codex", "state_5.sqlite"),
          },
        );
        // readCodexThreadTitles binds the rollout filename; the reader
        // extracts the thread UUID from it (matches on `id` for a
        // synthesized name).
        const rollout = `rollout-${item.nativeSessionId}.jsonl`;
        const group = groups.get(storage.stateDbPath);
        if (group) group.push({ key: item.key, rollout });
        else groups.set(storage.stateDbPath, [{ key: item.key, rollout }]);
      } catch {
        memo.set(item.key, null);
      }
    }
    for (const [stateDbPath, group] of groups) {
      const titles = readCodexThreadTitles(stateDbPath, group.map((item) => item.rollout));
      for (const item of group) {
        memo.set(item.key, titles.get(item.rollout) ?? null);
      }
    }
    return memo;
  }

  getSystemActivity(): SystemActivity {
    return this.dependencies.activity?.getSnapshot()
      ?? { cpuPercent: null, memPercent: 0, memUsedBytes: 0, memTotalBytes: 0, agentFiles: 0, agentBytes: 0, watchedRoots: 0, since: 0 };
  }

  /** Click-to-expand file list under the pulse (2026-10-06). Validation is here — counts, never paths logged. */
  getAgentFileActivity(input?: unknown): AgentFileActivity {
    const limitRaw = (typeof input === "object" && input !== null ? (input as { limit?: unknown }).limit : undefined);
    const limit = typeof limitRaw === "number" && Number.isFinite(limitRaw) ? limitRaw : undefined;
    return this.dependencies.activity?.listFiles(limit) ?? { files: [], total: 0 };
  }

  /** Read-only list of git worktrees created this session (2026-10-12). Count/path metadata only. */
  getWorktreeRegistry(): WorktreeRegistryActivity {
    return this.dependencies.worktreeRegistry?.list()
      ?? { entries: [], baselineCount: 0, lastCheckedAt: null };
  }

  getUsageSnapshot(): UsageSnapshot {
    return this.dependencies.usage?.getSnapshot() ?? { claude5h: null, claude7d: null, codex7d: null, fetchedAt: 0 };
  }

  /**
   * Register a callback fired when the usage snapshot changes (10s poll).
   * Returns an unsubscribe. Used by register-ipc (IPC push) and live-socket
   * (WS replay/push to web/mobile).
   */
  onUsageChanged(callback: (snapshot: UsageSnapshot) => void): () => void {
    const listener = (snapshot: UsageSnapshot) => callback(snapshot);
    this.dependencies.events.on("usageChanged", listener);
    return () => this.dependencies.events.off("usageChanged", listener);
  }
}

/**
 * Compose a history session display name: "aiTitle — firstPrompt" (aiTitle
 * primary, firstPrompt as supplement). Falls back to firstPrompt alone, then
 * to title, when aiTitle is missing. Exported for potential testing.
 */
function composeHistoryName(aiTitle: string | null, firstPrompt: string | null, title: string): string {
  const prompt = (firstPrompt ?? title).slice(0, 60);
  if (aiTitle && prompt) return `${aiTitle} — ${prompt}`;
  if (aiTitle) return aiTitle;
  return prompt || title;
}

/**
 * Compose a DB-source session display name: "brief — name" (brief primary,
 * conversationName as supplement). Falls back to conversationName alone when
 * summary is missing. Mirrors composeHistoryName's format for visual parity.
 */
function composeDbName(summary: { brief: string } | null, conversationName: string): string {
  if (summary?.brief && conversationName && summary.brief !== conversationName) {
    return `${summary.brief} — ${conversationName}`;
  }
  return summary?.brief || conversationName;
}

/** Normalize one threads row into the sidebar title, with the exact guard
 * chain of context-meter's readCodexThreadTitle (name → generated title →
 * placeholder set → prompt-echo). Returns null on any miss. */
function decodeCodexThreadRow(row: {
  name?: unknown;
  title?: unknown;
  first_user_message?: unknown;
  preview?: unknown;
  cwd?: unknown;
}): string | null {
  const name = normalizeCodexThreadTitle(row.name);
  if (name) return name;
  const title = normalizeCodexThreadTitle(row.title);
  if (!title) return null;
  const firstPrompt = normalizeCodexThreadTitle(row.first_user_message);
  const preview = normalizeCodexThreadTitle(row.preview);
  const stateCwd = typeof row.cwd === "string" && row.cwd.trim() ? row.cwd.trim() : null;
  const cwdName = stateCwd?.replace(/[\\/]+$/, "").split(/[\\/]/).pop()?.trim() ?? "";
  const placeholders = new Set([
    firstPrompt?.toLocaleLowerCase(),
    preview?.toLocaleLowerCase(),
    cwdName.toLocaleLowerCase(),
    "codex", "shell", "powershell", "pwsh", "cmd", "bash", "zsh", "untitled", "new thread", "new chat",
  ].filter((value): value is string => Boolean(value)));
  if (placeholders.has(title.toLocaleLowerCase())) return null;
  // #92: a truncated prompt stored in `title` is a prefix of the prompt, not
  // an exact match — show nothing rather than a prompt masquerading as the
  // session summary.
  if (isPromptEchoTitle(title, firstPrompt, preview)) return null;
  return title;
}

/**
 * Batch reader: title for many rollouts from one state DB over a single
 * connection. Same lookup precedence as readCodexThreadTitle (exact
 * rollout_path primary, thread-UUID fallback) and the same guard chain via
 * decodeCodexThreadRow. Rollouts missing from the DB return null. Returned
 * Map is keyed by the rollout filename as given. Exported for testing.
 */
export function readCodexThreadTitles(stateDbPath: string, rollouts: string[]): Map<string, string | null> {
  const results = new Map<string, string | null>();
  if (!rollouts.length) return results;
  let db: DatabaseSync | null = null;
  try {
    db = new DatabaseSync(stateDbPath, { readOnly: true });
    const columns = new Set(
      (db.prepare("PRAGMA table_info(threads)").all() as Array<{ name?: unknown }>)
        .map((row) => typeof row.name === "string" ? row.name : "")
        .filter(Boolean),
    );
    if (!columns.has("id")) return results;
    const select = ["name", "title", "first_user_message", "preview", "cwd", "rollout_path"]
      .filter((column) => columns.has(column));
    if (!select.includes("name") && !select.includes("title")) return results;
    const hasRollout = columns.has("rollout_path");
    const rolloutPredicate = hasRollout ? "rollout_path = ? OR " : "";
    const order = hasRollout
      ? "ORDER BY CASE WHEN rollout_path = ? THEN 0 ELSE 1 END"
      : "";
    const statement = db.prepare(
      `SELECT ${select.join(", ")}
       FROM threads
       WHERE ${rolloutPredicate}id = ?
       ${order}
       LIMIT 1`,
    );
    for (const rollout of rollouts) {
      const match = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/iu.exec(rollout);
      const threadId = match?.[1] ?? "";
      const row = (hasRollout
        ? statement.get(rollout, threadId, rollout)
        : statement.get(threadId)) as {
        name?: unknown;
        title?: unknown;
        first_user_message?: unknown;
        preview?: unknown;
        cwd?: unknown;
      } | undefined;
      results.set(rollout, row ? decodeCodexThreadRow(row) : null);
    }
  } catch {
    // Older Codex builds may not have state_5.sqlite/threads yet; every
    // rollout not yet resolved keeps its null fallback.
    for (const rollout of rollouts) {
      if (!results.has(rollout)) results.set(rollout, null);
    }
  } finally {
    db?.close();
  }
  return results;
}
