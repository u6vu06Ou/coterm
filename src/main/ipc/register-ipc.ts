import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { app, BrowserWindow, dialog, ipcMain, shell } from "electron";
import {
  artifactReadInputSchema,
  createProjectInputSchema,
} from "@shared/schema";
import { z } from "zod";
import type { BrowserSecretVault } from "../browser/browser-secret-vault";
import { IPC } from "@shared/ipc";
import type { ApprovalBroker } from "../core/approval-broker";
import type { CouncilScheduler } from "../providers/council-scheduler";
import type { Repository } from "../storage/repository";
import type { RunCoordinator } from "../core/run-coordinator";
import type { PtyManager } from "../terminal/pty-manager";
import type { AppEventBus } from "../core/event-bus";
import { detectProviders } from "../providers/capability-detector";
import { buildActiveProfiles, localRouteAuthToken } from "../providers/profiles-config";
import { getLauncherDir } from "../providers/agent-shims";
import { assertAllowedPath, assertExistingPath } from "../security/path-policy";
import { transcribeVoice } from "../voice/transcribe";
import { warmLocalVoice } from "../voice/warmup";
import { transcribeVoiceAgentClip } from "../voice/agent-transcribe";
import { logger } from "../core/logger";
import type { AppDatabase } from "../storage/database";
import type { AppOperations } from "../core/app-operations";
import type { AgentApiOrchestrator } from "../core/agentapi-orchestrator";
import type { AgentApiStateService } from "../core/agentapi-state-service";
import type { AgentApiVoiceOrchestrator } from "../core/agentapi-voice-orchestrator";
import type { AgentSemanticProjector } from "../core/agentapi-semantic-projector";
import type { SessionSemanticStore } from "../core/session-semantic-store";
import type { PersistentVoiceSurface } from "../voice/live/persistent-voice-surface";
import { resolveDefaultWorkspacePath } from "../core/workspace-defaults";

interface IpcDependencies {
  repository: Repository;
  database: AppDatabase;
  runs: RunCoordinator;
  council: CouncilScheduler;
  approvals: ApprovalBroker;
  terminals: PtyManager;
  events: AppEventBus;
  operations: AppOperations;
  agentapi?: Pick<AgentApiOrchestrator, "create" | "get" | "resume" | "pause" | "cancel">;
  // Phase 6: world-state push to the panel + voice turn orchestration.
  agentapiState?: Pick<AgentApiStateService, "getWorldState" | "onWorldChanged">;
  agentapiVoice?: Pick<AgentApiVoiceOrchestrator, "turn" | "interrupt">;
  persistentVoice?: Pick<PersistentVoiceSurface, "handle">;
  agentapiSemantic?: {
    projector: Pick<AgentSemanticProjector, "refreshTranscript">;
    store: Pick<SessionSemanticStore, "get">;
  };
  /** B4 (§12.2): local human → agent secret handle minting. Desktop-only; web/HTTP never sees this. */
  browserSecrets?: Pick<BrowserSecretVault, "issue"> | undefined;
}

export function registerIpc(dependencies: IpcDependencies): () => Promise<void> {
  const { repository, database, runs, council, approvals, terminals, events, operations, agentapi, agentapiState, agentapiVoice, persistentVoice, agentapiSemantic, browserSecrets } = dependencies;
  const handlers: string[] = [];
  const approvedWorkspacePaths = new Set<string>();
  const otherHandlersIdle = new Set<() => void>();
  let activeHandlers = 0;
  let restoring = false;
  let restoreNeedsRelaunch = false;
  let restoreRelaunchTimer: NodeJS.Timeout | null = null;
  const handle = <TArgs extends unknown[], TResult>(
    channel: string,
    listener: (...args: TArgs) => TResult | Promise<TResult>,
  ) => {
    ipcMain.handle(channel, async (_event, ...args: TArgs) => {
      if (restoring) throw new Error("Coterm is restoring its database.");
      activeHandlers += 1;
      try {
        return await listener(...args);
      } finally {
        activeHandlers -= 1;
        if (activeHandlers <= 1) {
          for (const resolve of otherHandlersIdle) resolve();
          otherHandlersIdle.clear();
        }
      }
    });
    handlers.push(channel);
  };
  const waitForOtherHandlers = (timeoutMs = 10_000): Promise<void> => {
    if (activeHandlers <= 1) return Promise.resolve();
    return new Promise<void>((resolve, reject) => {
      const finish = () => {
        clearTimeout(timer);
        otherHandlersIdle.delete(finish);
        resolve();
      };
      const timer = setTimeout(() => {
        otherHandlersIdle.delete(finish);
        reject(new Error("Timed out waiting for active operations before restore."));
      }, timeoutMs);
      otherHandlersIdle.add(finish);
    });
  };
  const scheduleRestoreRelaunch = (delayMs: number) => {
    if (restoreRelaunchTimer) clearTimeout(restoreRelaunchTimer);
    restoreRelaunchTimer = setTimeout(() => {
      app.relaunch();
      app.quit();
    }, delayMs);
  };
  const restoreRelaunchListener = () => {
    if (restoreNeedsRelaunch) scheduleRestoreRelaunch(0);
  };
  ipcMain.on(IPC.backupRestoreRelaunch, restoreRelaunchListener);

  handle(IPC.bootstrap, () => operations.bootstrap());
  handle(IPC.uiActionRecord, (input: unknown) => operations.recordUiAction(input));
  handle(IPC.reportRendererError, (input: unknown) => operations.reportRendererError(input));
  handle(IPC.appQuit, () => {
    setImmediate(() => app.quit());
  });
  handle(IPC.settingsGet, () => operations.getSettings());
  handle(IPC.settingsSet, async (input: unknown) => {
    return operations.setSettings(input);
  });
  const collectDiagnostics = async () => {
    const settings = repository.getSettings();
    return {
      generatedAt: new Date().toISOString(),
      appVersion: app.getVersion(),
      platform: process.platform,
      arch: process.arch,
      providers: await detectProviders({
        proxyUrl: settings.proxyUrl,
        // Stage 2: probe with the effective local route token (per-profile
        // override first).
        authToken: localRouteAuthToken(buildActiveProfiles(settings.customProfiles)),
        profiles: buildActiveProfiles(settings.customProfiles),
        customProfiles: settings.customProfiles,
      }),
      database: { path: database.path, schemaVersion: database.schemaVersion },
      recentErrors: repository.listRecentErrors(),
    };
  };
  handle(IPC.diagnostics, collectDiagnostics);
  // Native dialogs are owned by main, outside the renderer i18n table, so their
  // copy follows the persisted locale here instead of shipping Chinese-only.
  const dialogTitle = (zhTw: string, enUs: string): string =>
    repository.getSettings().locale === "en-US" ? enUs : zhTw;
  handle(IPC.diagnosticsExport, async () => {
    const result = await dialog.showSaveDialog({
      title: dialogTitle("匯出 Coterm 診斷資料", "Export Coterm diagnostics"),
      defaultPath: join(
        app.getPath("documents"),
        `ai-terminal-diagnostics-${new Date().toISOString().replaceAll(":", "-").slice(0, 19)}.json`,
      ),
      filters: [{ name: "JSON diagnostics", extensions: ["json"] }],
    });
    if (result.canceled || !result.filePath) return null;
    await writeFile(
      result.filePath,
      `${JSON.stringify(await collectDiagnostics(), null, 2)}\n`,
      "utf8",
    );
    return result.filePath;
  });
  handle(IPC.backupCreate, async () => {
    const result = await dialog.showSaveDialog({
      title: dialogTitle("備份 Coterm 本機資料", "Back up Coterm local data"),
      defaultPath: join(
        app.getPath("documents"),
        `ai-terminal-backup-${new Date().toISOString().slice(0, 10)}.sqlite`,
      ),
      filters: [{ name: "Coterm SQLite backup", extensions: ["sqlite"] }],
    });
    if (result.canceled || !result.filePath) return null;
    await database.backup(result.filePath);
    return result.filePath;
  });
  handle(IPC.backupRestore, async () => {
    const result = await dialog.showOpenDialog({
      title: dialogTitle("還原 Coterm 本機資料", "Restore Coterm local data"),
      properties: ["openFile"],
      filters: [{ name: "Coterm SQLite backup", extensions: ["sqlite", "db"] }],
    });
    const source = result.filePaths[0];
    if (result.canceled || !source) return null;
    if (restoring) throw new Error("A database restore is already in progress.");
    restoring = true;
    try {
      await waitForOtherHandlers();
    } catch (error) {
      restoring = false;
      throw error;
    }
    restoreNeedsRelaunch = true;
    try {
      approvals.cancelAll();
      terminals.dispose();
      await council.dispose();
      await runs.dispose();
      await database.restore(source);
      return source;
    } finally {
      scheduleRestoreRelaunch(5_000);
    }
  });
  handle(IPC.workspacePick, async () => {
    const result = await dialog.showOpenDialog({
      title: dialogTitle("選擇專案工作目錄", "Select project workspace folder"),
      properties: ["openDirectory", "createDirectory"],
      // #10: never default the picker at a stale/hard-coded path. Order:
      // the user's configured defaultWorkspacePath, existing project
      // workspaces, then OS fallbacks (Documents, home).
      defaultPath: resolveDefaultWorkspacePath({
        configured: repository.getSettings().defaultWorkspacePath,
        candidates: repository.listProjects().map((project) => project.workspacePath),
        fallbacks: [app.getPath("documents"), app.getPath("home")],
      }),
    });
    const selected = result.filePaths[0];
    if (result.canceled || !selected) return null;
    const canonical = await assertAllowedPath(selected, { roots: [selected] });
    approvedWorkspacePaths.add(canonical.toLowerCase());
    return canonical;
  });
  handle(IPC.workspaceList, (input: unknown) => operations.listWorkspace(input));
  handle(IPC.workspaceSearch, (input: unknown) => operations.searchWorkspaceEntries(input));
  handle(IPC.workspaceRename, (input: unknown) => operations.renameWorkspaceEntry(input));
  handle(IPC.workspaceCreateFile, (input: unknown) => operations.createWorkspaceFile(input));
  handle(IPC.workspaceCreateDirectory, (input: unknown) => operations.createWorkspaceDirectory(input));
  handle(IPC.workspaceDelete, (input: unknown) => operations.deleteWorkspaceEntry(input));
  handle(IPC.workspaceDuplicate, (input: unknown) => operations.duplicateWorkspaceEntry(input));
  handle(IPC.workspaceReveal, (input: unknown) => operations.revealWorkspaceEntry(input));
  handle(IPC.workspaceOpenExternal, (input: unknown) => operations.openWorkspaceEntryExternal(input));
  handle(IPC.search, (input: unknown) => operations.search(input));
  handle(IPC.sessionIndexStatus, () => operations.sessionIndexStatus());
  handle(IPC.attachmentSave, (input: unknown) => operations.saveAttachment(input));
  handle(IPC.uploadSave, (input: unknown) => operations.saveUpload(input));
  handle(IPC.attachmentsList, (conversationId: unknown) => operations.listAttachments(conversationId));
  handle(IPC.attachmentDelete, (attachmentId: unknown) => operations.deleteAttachment(attachmentId));
  handle(IPC.artifactRead, (input: unknown) => operations.readArtifact(input));
  handle(IPC.artifactWorkbookRead, (input: unknown) => operations.readArtifactWorkbook(input));
  handle(IPC.artifactPresentationRead, (input: unknown) => operations.readArtifactPresentation(input));
  handle(IPC.browserArtifactOpen, (input: unknown) => operations.openBrowserArtifact(input));
  handle(IPC.browserSessionCreate, (input: unknown) => operations.createBrowserSession(input));
  handle(IPC.browserSessionList, () => operations.listBrowserSessions());
  handle(IPC.browserSessionClose, (id: unknown) => operations.closeBrowserSession(id));
  handle(IPC.browserPageNew, (input: unknown) => operations.newBrowserPage(input));
  handle(IPC.browserPageList, (id: unknown) => operations.listBrowserPages(id));
  handle(IPC.browserPageClose, (input: unknown) => operations.closeBrowserPage(input));
  handle(IPC.browserPageSelect, (input: unknown) => operations.selectBrowserPage(input));
  handle(IPC.browserNavigate, (input: unknown) => operations.navigateBrowser(input));
  handle(IPC.browserBack, (id: unknown) => operations.browserBack(id));
  handle(IPC.browserForward, (id: unknown) => operations.browserForward(id));
  handle(IPC.browserReload, (id: unknown) => operations.browserReload(id));
  handle(IPC.browserStop, (id: unknown) => operations.browserStop(id));
  handle(IPC.browserSnapshot, (input: unknown) => operations.snapshotBrowser(input));
  handle(IPC.browserClick, (input: unknown) => operations.clickBrowser(input));
  handle(IPC.browserClickCoordinates, (input: unknown) => operations.clickBrowserCoordinates(input));
  handle(IPC.browserFill, (input: unknown) => operations.fillBrowser(input));
  handle(IPC.browserType, (input: unknown) => operations.typeBrowser(input));
  handle(IPC.browserPress, (input: unknown) => operations.pressBrowser(input));
  handle(IPC.browserExtract, (input: unknown) => operations.extractBrowser(input));
  handle(IPC.browserSaveExtraction, (input: unknown) => operations.saveBrowserExtraction(input));
  handle(IPC.browserSearchIndex, (input: unknown) => operations.searchBrowserIndex(input));
  handle(IPC.browserScreenshot, (input: unknown) => operations.screenshotBrowser(input));
  // openInAgentBrowser: validate the target before composing (local path vs
  // http(s) URL). IPC-only — routes.ts has no such method.
  const browserOpenInAgentSchema = z.object({ target: z.string().min(1).max(4_096) });
  handle(IPC.browserOpenInAgent, (input: unknown) => operations.openInAgentBrowser(browserOpenInAgentSchema.parse(input)));
  // B4: mint a one-time browser secret handle for the human to hand to an
  // agent. Renderer-only IPC: the value is validated, issued into the
  // in-memory vault, and NEVER logged, returned, or reachable over the web
  // RPC transport (routes.ts allowlist has no such method).
  const browserSecretIssueSchema = z.object({ value: z.string().min(1).max(4_096), ttlMs: z.number().int().min(1_000).max(600_000).default(60_000) });
  handle(IPC.browserSecretIssue, (input: unknown) => {
    const parsed = browserSecretIssueSchema.parse(input);
    if (!browserSecrets) throw new Error("Browser secret vault is unavailable.");
    const handle = browserSecrets.issue(parsed.value, parsed.ttlMs);
    return { handle, expiresInMs: parsed.ttlMs };
  });
  handle(IPC.artifactWrite, (input: unknown) => operations.writeArtifact(input));
  handle(IPC.artifactReveal, async (input: unknown) => {
    const parsed = artifactReadInputSchema.parse(input);
    const project = repository.getProject(parsed.projectId);
    if (!project) throw new Error("Project not found.");
    // No root containment here, deliberately (approved product decision, 2026-07-26): this is desktop IPC
    // only, so the caller is the person clicking, and every artifact outside a project workspace
    // (a synced folder or scratch folder on another drive) was unopenable for no security gain.
    const allowedPath = await assertExistingPath(parsed.path);
    shell.showItemInFolder(allowedPath);
  });
  handle(IPC.artifactOpenExternal, async (input: unknown) => {
    const parsed = artifactReadInputSchema.parse(input);
    const project = repository.getProject(parsed.projectId);
    if (!project) throw new Error("Project not found.");
    // No root containment here, deliberately (approved product decision, 2026-07-26): this is desktop IPC
    // only, so the caller is the person clicking, and every artifact outside a project workspace
    // (a synced folder or scratch folder on another drive) was unopenable for no security gain.
    const allowedPath = await assertExistingPath(parsed.path);
    // A clickable terminal link that could EXECUTE code is an injection surface
    // (agent output prints C:\evil.bat, user clicks). For executable/script
    // extensions, reveal-in-folder instead of shell.openPath (which runs them).
    const lower = allowedPath.toLowerCase();
    const executable = [
      ".exe", ".bat", ".cmd", ".com", ".msi", ".scr", ".ps1", ".psm1", ".vbs",
      ".vbe", ".jse", ".wsf", ".wsh", ".hta", ".cpl", ".jar", ".reg", ".lnk", ".pif",
    ];
    if (executable.some((ext) => lower.endsWith(ext))) {
      shell.showItemInFolder(allowedPath);
      return;
    }
    const openError = await shell.openPath(allowedPath); // "" on success
    if (openError) shell.showItemInFolder(allowedPath); // no default app -> reveal
  });
  handle(IPC.projectsCreate, async (input: unknown) => {
    const parsed = createProjectInputSchema.parse(input);
    const workspacePath = await assertAllowedPath(parsed.workspacePath, {
      roots: [parsed.workspacePath],
    });
    if (!approvedWorkspacePaths.has(workspacePath.toLowerCase())) {
      throw new Error("Choose the workspace through the native folder picker first.");
    }
    approvedWorkspacePaths.delete(workspacePath.toLowerCase());
    return repository.createProject(parsed.name, workspacePath);
  });
  handle(IPC.projectsRename, (input: unknown) => operations.renameProject(input));
  handle(IPC.projectsPin, (input: unknown) => operations.pinProject(input));
  handle(IPC.projectsReorder, (input: unknown) => operations.reorderProjects(input));
  handle(IPC.projectsArchive, (input: unknown) => operations.archiveProject(input));
  handle(IPC.conversationsCreate, (input: unknown) => operations.createConversation(input));
  handle(IPC.conversationsContinue, (input: unknown) => operations.continueConversationWithProvider(input));
  handle(IPC.conversationsRename, (input: unknown) => operations.renameConversation(input));
  handle(IPC.conversationsArchive, (input: unknown) => operations.archiveConversation(input));
  handle(IPC.conversationsDelete, (input: unknown) => operations.deleteConversation(input));
  handle(IPC.conversationsEvents, (conversationId: unknown) => operations.listEvents(conversationId));
  handle(IPC.projectSessions, (projectId: unknown) => operations.listProjectSessions(projectId));
  handle(IPC.conversationsSession, (conversationId: unknown) => operations.findProviderSession(conversationId));
  handle(IPC.conversationsSummarize, (input: unknown) => operations.summarizeConversation(input));
  handle(IPC.conversationsModel, (input: unknown) => operations.setConversationClaudeModel(input));
  handle(IPC.claudeHistoryList, (input: unknown) => operations.listClaudeHistory(input));
  handle(IPC.claudeHistoryRead, (input: unknown) => operations.readClaudeHistory(input));
  handle(IPC.claudeHistoryAdopt, (input: unknown) => operations.adoptClaudeHistory(input));
  handle(IPC.messageSend, (input: unknown) => operations.sendMessage(input));
  handle(IPC.messageCancel, (turnId: unknown) => operations.cancelMessage(turnId));
  handle(IPC.terminalCommand, (input: unknown) => operations.runTerminalCommand(input));
  handle(IPC.approvalResolve, (input: unknown) => operations.resolveApproval(input));
  handle(IPC.userInputResolve, (input: unknown) => operations.resolveUserInput(input));
  handle(IPC.councilStart, (input: unknown) => operations.startCouncil(input));
  handle(IPC.councilCancel, (turnGroupId: unknown) => operations.cancelCouncil(turnGroupId));
  handle(IPC.providersRefresh, (input?: unknown) => operations.refreshProviders(input));
  handle(IPC.terminalCreate, (input: unknown) => operations.createTerminal(input));
  handle(IPC.terminalWrite, (input: unknown) => operations.writeTerminal(input));
  handle(IPC.voiceTranscribe, (input: unknown) => {
    const clip = input as { audio?: ArrayBuffer | Uint8Array; mimeType?: unknown; lang?: unknown };
    const raw = clip.audio;
    const audio = raw instanceof Uint8Array
      ? raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength) as ArrayBuffer
      : raw;
    if (!(audio instanceof ArrayBuffer)) throw new Error("voice:transcribe expects an audio buffer.");
    // Server URL and model come from settings in main, not from the renderer,
    // so a compromised renderer cannot aim the upload at an arbitrary host.
    const { voice } = repository.getSettings();
    return transcribeVoice({
      audio,
      mimeType: typeof clip.mimeType === "string" ? clip.mimeType : "audio/webm",
      lang: typeof clip.lang === "string" ? clip.lang : voice.lang,
      serverUrl: voice.sttUrl,
      model: voice.sttModel,
      apiKey: voice.sttApiKey || undefined,
    });
  });
  handle(IPC.voiceWarmup, () => warmLocalVoice(repository.getSettings().voice.sttUrl));
  handle(IPC.terminalResize, (input: unknown) => operations.resizeTerminal(input));
  handle(IPC.terminalRequestGeometry, (input: unknown) => operations.requestTerminalGeometry(input));
  handle(IPC.terminalRename, (input: unknown) => operations.renameTerminal(input));
  handle(IPC.terminalSetLabel, (input: unknown) => operations.setTerminalLabel(input));
  handle(IPC.terminalMarkAgent, (input: unknown) => operations.markTerminalAgent(input));
  handle(IPC.terminalSetNativeSessionId, (input: unknown) => operations.setTerminalNativeSessionId(input));
  handle(IPC.terminalKill, (input: unknown) => operations.killTerminal(input));
  handle(IPC.terminalList, (projectId: unknown) => operations.listTerminals(projectId));
  handle(IPC.terminalPtyState, (terminalId: unknown) => operations.getPtyState(terminalId));
  handle(IPC.terminalKeepaliveSet, (input: unknown) => operations.setTerminalKeepalive(input));
  handle(IPC.terminalExportHandoff, (terminalId: unknown) => operations.exportTerminalHandoff(terminalId));
  handle(IPC.terminalKeepaliveList, () => operations.listTerminalKeepalives());
  handle(IPC.terminalLastCommand, (terminalId: unknown) => operations.getLastCommand(terminalId));
  handle(IPC.agentLauncherDir, () => getLauncherDir());
  handle(IPC.terminalDashboard, () => operations.getTerminalDashboard());
  handle(IPC.attentionList, () => operations.listAttention());
  handle(IPC.attentionResolve, (input: unknown) => operations.resolveAttention(input));
  handle(IPC.usageGet, () => operations.getUsageSnapshot());
  handle(IPC.systemActivityGet, () => operations.getSystemActivity());
  handle(IPC.agentFileActivityGet, (input: unknown) => operations.getAgentFileActivity(input));
  handle(IPC.worktreeRegistryGet, () => operations.getWorktreeRegistry());
  if (agentapi) {
    handle(IPC.agentapiCreate, (input: unknown) => agentapi.create(input));
    handle(IPC.agentapiGet, (id: unknown) => agentapi.get(requireWorkflowId(id)));
    handle(IPC.agentapiResume, (id: unknown) => agentapi.resume(requireWorkflowId(id)));
    handle(IPC.agentapiPause, (id: unknown) => agentapi.pause(requireWorkflowId(id)));
    handle(IPC.agentapiCancel, (id: unknown) => agentapi.cancel(requireWorkflowId(id)));
  }
  // --- Phase 6: panel world snapshot + voice turn orchestration ----------
  if (agentapiState) {
    handle(IPC.agentapiWorldSnapshot, () => agentapiState.getWorldState());
  }
  if (agentapiSemantic) {
    handle(IPC.agentapiSemanticState, async (terminalId: unknown) => {
      if (typeof terminalId !== "string" || !terminalId) return null;
      await agentapiSemantic.projector.refreshTranscript(terminalId);
      return agentapiSemantic.store.get(terminalId);
    });
  }
  if (agentapiVoice) {
    handle(IPC.agentapiVoiceTurn, (input: unknown) => {
      const utterance = (input as { utterance?: unknown } | null)?.utterance;
      return agentapiVoice.turn(utterance);
    });
    handle(IPC.agentapiVoiceInterrupt, () => agentapiVoice.interrupt());
  }
  if (persistentVoice) {
    handle(IPC.liveVoiceSession, (input: unknown) => persistentVoice.handle(input));
  }
  handle(IPC.voiceDiag, (input: unknown) => {
    const diag = (input ?? {}) as { stage?: unknown; detail?: unknown };
    const stage = typeof diag.stage === "string" ? diag.stage.slice(0, 64) : "unknown";
    const detail = typeof diag.detail === "string" ? diag.detail.slice(0, 160) : null;
    // Stage codes and coarse numbers only — transcripts/audio never cross here.
    logger.warn("voice", "renderer.diag", "Renderer voice diagnostics event.", detail ? { stage, detail } : { stage });
  });
  // Mobile audio → main STT (§11.5). Audio crosses as base64 JSON instead of
  // an ArrayBuffer because the authenticated web RPC surface is JSON-only;
  // the key/server URL stay settings-owned in main exactly like channel
  // voice:transcribe. Never logged; bounded to ~6 MB before decode.
  handle(IPC.transcribeVoiceAgent, (input: unknown) => {
    const { voice } = repository.getSettings();
    return transcribeVoiceAgentClip(input, voice);
  });
  handle(IPC.terminalRefresh, (terminalId: unknown) => operations.refreshTerminal(terminalId));
  handle(IPC.terminalWorkspaceGet, (projectId: unknown) => operations.getTerminalWorkspace(projectId));
  handle(IPC.terminalTranscriptGet, (terminalId: unknown) => operations.getTerminalTranscript(terminalId));
  handle(IPC.terminalSessionInfoGet, (terminalId: unknown) => operations.getTerminalSessionInfo(terminalId));
  handle(IPC.terminalWorkspaceSave, (input: unknown) => operations.saveTerminalWorkspace(input));
  handle(IPC.dockGetLayout, () => operations.getDockLayout());
  handle(IPC.projectDelete, (input: unknown) => operations.deleteProject(input));
  handle(IPC.dockOpenTile, (input: unknown) => operations.openTile(input));
  handle(IPC.dockCloseTile, (input: unknown) => operations.closeTile(input));
  handle(IPC.dockSelectTile, (input: unknown) => operations.selectTile(input));
  handle(IPC.dockSetLayout, (input: unknown) => operations.setDockLayout(input));
  handle(IPC.dockSetExclusive, (input: unknown) => operations.setExclusive(input));
  handle(IPC.dockReorderTile, (input: unknown) => operations.reorderTile(input));
  handle(IPC.worktreeCreate, (input: unknown) => operations.createWorktree(input));
  handle(IPC.worktreeList, (input: unknown) => operations.listWorktrees(input));
  handle(IPC.worktreeGet, (input: unknown) => operations.getWorktree(input));
  handle(IPC.worktreeDiffSummary, (input: unknown) => operations.worktreeDiffSummary(input));
  handle(IPC.worktreeMerge, (input: unknown) => operations.mergeWorktree(input));
  handle(IPC.worktreeAbort, (input: unknown) => operations.abortWorktree(input));
  handle(IPC.worktreeCleanup, (input: unknown) => operations.cleanupWorktree(input));
  handle(IPC.worktreeBindSession, (input: unknown) => operations.bindWorktreeSession(input));
  handle(IPC.worktreeResume, (input: unknown) => operations.resumeWorktree(input));
  handle(IPC.checkpointList, (input: unknown) => operations.listCheckpoints(input));
  handle(IPC.checkpointGet, (input: unknown) => operations.getCheckpoint(input));
  handle(IPC.checkpointDiff, (input: unknown) => operations.checkpointDiff(input));
  handle(IPC.checkpointRestorePreview, (input: unknown) => operations.checkpointRestorePreview(input));
  handle(IPC.checkpointRestore, (input: unknown) => operations.restoreCheckpoint(input));
  handle(IPC.checkpointRestoreHunk, (input: unknown) => operations.restoreCheckpointHunk(input));
  handle(IPC.checkpointUndo, (input: unknown) => operations.undoCheckpoint(input));
  handle(IPC.checkpointRedo, (input: unknown) => operations.redoCheckpoint(input));
  handle(IPC.checkpointCreateExplicit, (input: unknown) => operations.createExplicitCheckpoint(input));

  const send = (channel: string, payload: unknown) => {
    for (const window of BrowserWindow.getAllWindows()) {
      if (!window.isDestroyed()) window.webContents.send(channel, payload);
    }
  };
  const eventListener = (event: unknown) => send(IPC.event, event);
  const FLUSH_IDLE_MS = 250;
  const FLUSH_SIZE_CHARS = 32_000;
  interface TerminalBuffer {
    projectId: string;
    chunks: string[];
    lastFlush: number;
    timer: NodeJS.Timeout | null;
  }
  const terminalBuffers = new Map<string, TerminalBuffer>();
  const flushTerminal = (terminalId: string): Promise<void> => {
    const buffer = terminalBuffers.get(terminalId);
    if (!buffer) return Promise.resolve();
    if (buffer.timer) {
      clearTimeout(buffer.timer);
      buffer.timer = null;
    }
    if (buffer.chunks.length === 0) {
      terminalBuffers.delete(terminalId);
      return Promise.resolve();
    }
    const text = buffer.chunks.join("");
    buffer.chunks = [];
    buffer.lastFlush = Date.now();
    terminalBuffers.delete(terminalId);
    return repository.appendTerminalEvent({
      projectId: buffer.projectId,
      terminalId,
      type: "terminal.output",
      summary: text.replace(/\s+/g, " ").trim().slice(0, 200) || "Terminal output.",
      payload: { text: text.slice(-8_000) },
    }).catch(() => {
      logger.warn("ipc", "terminal.output.flush.failed", "Failed to flush buffered terminal output.", {
        terminalId,
      });
    }).then(() => undefined);
  };
  const flushAllTerminals = (): Promise<void> => {
    return Promise.all([...terminalBuffers.keys()].map((id) => flushTerminal(id))).then(() => undefined);
  };
  const terminalDataListener = (payload: unknown) => {
    const data = payload as { terminalId?: string; projectId?: string; data?: string };
    if (data.terminalId && data.projectId && typeof data.data === "string") {
      const terminalId = data.terminalId;
      let buffer = terminalBuffers.get(terminalId);
      if (!buffer) {
        buffer = { projectId: data.projectId, chunks: [], lastFlush: Date.now(), timer: null };
        terminalBuffers.set(terminalId, buffer);
      }
      buffer.chunks.push(data.data);
      if (buffer.timer) clearTimeout(buffer.timer);
      const totalChars = buffer.chunks.reduce((sum, chunk) => sum + chunk.length, 0);
      if (totalChars >= FLUSH_SIZE_CHARS) {
        void flushTerminal(terminalId);
      } else {
        buffer.timer = setTimeout(() => { void flushTerminal(terminalId); }, FLUSH_IDLE_MS);
      }
    }
    send(IPC.terminalData, payload);
  };
  const terminalExitListener = (payload: unknown) => {
    const data = payload as { terminalId?: string; projectId?: string; exitCode?: number };
    if (data.terminalId && data.projectId && typeof data.exitCode === "number") {
      void flushTerminal(data.terminalId);
      void repository.appendTerminalEvent({
        projectId: data.projectId,
        terminalId: data.terminalId,
        type: "terminal.session.closed",
        summary: `Terminal exited with code ${data.exitCode}.`,
        payload: { exitCode: data.exitCode },
      }).catch(() => undefined);
    }
    send(IPC.terminalExit, payload);
  };
  const terminalListChangedListener = (payload: unknown) => send(IPC.terminalListChanged, payload);
  const terminalGeometryChangedListener = (payload: unknown) => send(IPC.terminalGeometryChanged, payload);
  const terminalCommandListener = (payload: unknown) => {
    const data = payload as { terminalId?: string; projectId?: string; result?: { command?: string; exitCode?: number | null; durationMs?: number } };
    if (data.terminalId && data.projectId && data.result) {
      // Append a structured command event to the terminal ledger. The result's
      // command is already redactEgress'd by PtyManager; repository's payload
      // sanitizer re-redacts as defence in depth. Summary carries no command
      // text — only exit + duration metadata (logging-api §A.2 layering).
      void repository.appendTerminalEvent({
        projectId: data.projectId,
        terminalId: data.terminalId,
        type: "terminal.command.finished",
        summary: `Command exited with code ${data.result.exitCode ?? "unknown"} after ${data.result.durationMs ?? 0}ms.`,
        payload: { ...data.result },
      }).catch(() => {
        logger.warn("ipc", "terminal.command.append.failed", "Failed to append terminal command event.", {
          terminalId: data.terminalId ?? null,
        });
      });
    }
    send(IPC.terminalCommandFinished, payload);
  };
  const dockLayoutChangedListener = (layout: unknown) => send(IPC.dockLayoutChanged, layout);
  // Hot model registry (stage 1): push the derived agent option list to every
  // renderer window when settings.customProfiles changes.
  const profilesChangedListener = (options: unknown) => send(IPC.profilesChanged, options);
  // ptyStateChanged: generic push, carries ALL canonical state transitions.
  // attentionChanged: only need-a-human notifications (mobile push channel).
  const ptyStateChangedListener = (payload: unknown) => send(IPC.ptyStateChanged, payload);
  const attentionChangedListener = (notification: unknown) => send(IPC.attentionChanged, notification);
  const usageChangedListener = (snapshot: unknown) => send(IPC.usageChanged, snapshot);
  const browserArtifactSavedListener = (artifact: unknown) => send(IPC.browserArtifactSaved, artifact);
  events.on("event", eventListener);
  events.on("terminalData", terminalDataListener);
  events.on("terminalExit", terminalExitListener);
  events.on("terminalListChanged", terminalListChangedListener);
  events.on("terminalGeometryChanged", terminalGeometryChangedListener);
  events.on("terminalCommand", terminalCommandListener);
  events.on("ptyStateChanged", ptyStateChangedListener);
  events.on("profilesChanged", profilesChangedListener);
  events.on("browserArtifactSaved", browserArtifactSavedListener);
  const unsubscribeAttention = operations.onAttentionChanged(attentionChangedListener);
  const unsubscribeDockLayout = operations.onDockLayoutChanged(dockLayoutChangedListener);
  const unsubscribeUsage = operations.onUsageChanged(usageChangedListener);
  // Phase 6: burst-coalesced metadata-only world snapshot push to the panel.
  const unsubscribeWorld = agentapiState?.onWorldChanged((sessions) =>
    send(IPC.agentapiWorldChanged, sessions));

  return async () => {
    await flushAllTerminals();
    ipcMain.removeListener(IPC.backupRestoreRelaunch, restoreRelaunchListener);
    if (restoreRelaunchTimer) clearTimeout(restoreRelaunchTimer);
    for (const channel of handlers) ipcMain.removeHandler(channel);
    events.off("event", eventListener);
    events.off("terminalData", terminalDataListener);
    events.off("terminalExit", terminalExitListener);
    events.off("terminalListChanged", terminalListChangedListener);
    events.off("terminalGeometryChanged", terminalGeometryChangedListener);
    events.off("terminalCommand", terminalCommandListener);
    events.off("ptyStateChanged", ptyStateChangedListener);
    events.off("profilesChanged", profilesChangedListener);
    events.off("browserArtifactSaved", browserArtifactSavedListener);
    unsubscribeAttention();
    unsubscribeDockLayout();
    unsubscribeUsage();
    unsubscribeWorld?.();
  };
}

function requireWorkflowId(value: unknown): string {
  if (typeof value !== "string" || !/^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(value)) {
    throw new Error("Invalid AgentApi workflow ID.");
  }
  return value;
}
