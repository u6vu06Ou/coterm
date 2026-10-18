import { mkdtemp, realpath, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AppOperations } from "../../src/main/core/app-operations";
import { AppEventBus } from "../../src/main/core/event-bus";
import { initLogger } from "../../src/main/core/logger";
import { AppDatabase } from "../../src/main/storage/database";
import { Repository } from "../../src/main/storage/repository";
import { bindWebOperations } from "../../src/main/web/routes";
import * as XLSX from "xlsx";

describe("AppOperations", () => {
  const events = new AppEventBus();
  let directory: string;
  let database: AppDatabase;
  let repository: Repository;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "coterm-operations-"));
    database = new AppDatabase(join(directory, "state.sqlite"));
    await database.open();
    repository = new Repository(database);
  });

  afterEach(async () => {
    await repository.closeSearchIndex();
    database.close();
    await rm(directory, { recursive: true, force: true });
  });

  it("uses one repository and run coordinator for every transport", async () => {
    const send = vi.fn().mockResolvedValue({ turnId: "turn-1" });
    const operations = new AppOperations({
      repository,
      runs: { send, cancel: vi.fn(), command: vi.fn() },
      approvals: { resolve: vi.fn() },
      council: { start: vi.fn(), cancel: vi.fn() },
      attention: { list: vi.fn().mockReturnValue([]), resolve: vi.fn(), onAttentionChanged: vi.fn().mockReturnValue(() => undefined) },
      events,
      terminals: {
        create: vi.fn(), write: vi.fn(), writeWhenShellReady: vi.fn(), resize: vi.fn(), rename: vi.fn(), markAgent: vi.fn(), setLabel: vi.fn(), markAgentOwned: vi.fn(), setNativeSessionId: vi.fn(),
        kill: vi.fn(), list: vi.fn().mockReturnValue([]), snapshots: vi.fn().mockReturnValue([]), get: vi.fn().mockReturnValue(null), getPtyState: vi.fn().mockReturnValue(null), getLastCommand: vi.fn().mockReturnValue(null), dashboardSnapshot: vi.fn().mockReturnValue([]), setTerminalKeepalive: vi.fn().mockReturnValue(null), listTerminalKeepaliveStates: vi.fn().mockReturnValue([]),
      },
      appVersion: "1.0.0",
      userDataPath: directory,
      tempPath: directory,
    });
    const project = await repository.createProject("Coterm", directory);

    const conversation = await operations.createConversation({
      projectId: project.id,
      name: "Remote",
      provider: "codex-official",
    });
    await operations.sendMessage({
      conversationId: conversation.id,
      profileId: "codex-official",
      text: "Continue this session",
      attachmentIds: [],
    });
    const providerSession = await repository.getOrCreateProviderSession(
      conversation.id,
      "codex-official",
    );
    await repository.updateProviderSession(providerSession.id, {
      nativeSessionId: "resume-native-id",
    });

    expect(operations.bootstrap().conversations).toContainEqual(conversation);
    expect(send).toHaveBeenCalledWith(expect.objectContaining({
      conversationId: conversation.id,
      text: "Continue this session",
    }));
    await expect(operations.listProjectSessions(project.id)).resolves.toEqual([
      expect.objectContaining({
        providerSessionId: providerSession.id,
        conversationId: conversation.id,
        profileId: "codex-official",
        nativeSessionId: "resume-native-id",
      }),
    ]);

    expect(bindWebOperations(operations).bootstrap?.()).toMatchObject({
      appVersion: "1.0.0",
    });
    await expect(bindWebOperations(operations).listProjectSessions?.(project.id)).resolves.toHaveLength(1);
  });

  it("requestTerminalGeometry applies a rows-only, clamped resize for remote clients (AT-158)", async () => {
    const resize = vi.fn();
    const get = vi.fn().mockReturnValue({ id: "00000000-0000-4000-8000-000000000001", cols: 132, rows: 28, status: "running" });
    const operations = new AppOperations({
      repository,
      runs: { send: vi.fn(), cancel: vi.fn(), command: vi.fn() },
      approvals: { resolve: vi.fn() },
      council: { start: vi.fn(), cancel: vi.fn() },
      attention: { list: vi.fn().mockReturnValue([]), resolve: vi.fn(), onAttentionChanged: vi.fn().mockReturnValue(() => undefined) },
      events,
      terminals: {
        create: vi.fn(), write: vi.fn(), writeWhenShellReady: vi.fn(), resize, rename: vi.fn(), markAgent: vi.fn(), setLabel: vi.fn(), markAgentOwned: vi.fn(), setNativeSessionId: vi.fn(),
        kill: vi.fn(), list: vi.fn().mockReturnValue([]), snapshots: vi.fn().mockReturnValue([]), get, getPtyState: vi.fn().mockReturnValue(null), getLastCommand: vi.fn().mockReturnValue(null), dashboardSnapshot: vi.fn().mockReturnValue([]), setTerminalKeepalive: vi.fn().mockReturnValue(null), listTerminalKeepaliveStates: vi.fn().mockReturnValue([]),
      },
      appVersion: "1.0.0",
      userDataPath: directory,
      tempPath: directory,
    });

    // Rows-only claim: the phone's columns never override the PTY's own width
    // (wide-grid horizontal pan guarantee).
    operations.requestTerminalGeometry({ terminalId: "00000000-0000-4000-8000-000000000001", cols: 40, rows: 46 });
    expect(resize).toHaveBeenCalledWith("00000000-0000-4000-8000-000000000001", 132, 46);

    // Out-of-range rows are clamped, never trusted blindly.
    operations.requestTerminalGeometry({ terminalId: "00000000-0000-4000-8000-000000000001", cols: 40, rows: 300 });
    expect(resize).toHaveBeenLastCalledWith("00000000-0000-4000-8000-000000000001", 132, 160);

    // Same rows → no-op (no broadcast churn while the phone holds the tile).
    resize.mockClear();
    operations.requestTerminalGeometry({ terminalId: "00000000-0000-4000-8000-000000000001", cols: 40, rows: 28 });
    expect(resize).not.toHaveBeenCalled();

    // Unknown terminal: silent no-op, no throw.
    get.mockReturnValue(null);
    expect(() => operations.requestTerminalGeometry({ terminalId: "00000000-0000-4000-8000-0000000000ff", cols: 40, rows: 46 })).not.toThrow();
    expect(resize).not.toHaveBeenCalled();

    // Exposed over the web RPC surface (the phone's only transport).
    expect(typeof bindWebOperations(operations).requestTerminalGeometry).toBe("function");
    // Let the fire-and-forget dock-layout write settle so the temp-dir cleanup
    // does not race it on Windows.
    await new Promise((resolve) => setTimeout(resolve, 150));
  });

  it("reclaims the dock tile when the tile's PTY exits (殭屍格回收, 1.5.44)", async () => {
    let counter = 0;
    const kill = vi.fn();
    const operations = new AppOperations({
      repository,
      runs: { send: vi.fn(), cancel: vi.fn(), command: vi.fn() },
      approvals: { resolve: vi.fn() },
      council: { start: vi.fn(), cancel: vi.fn() },
      attention: { list: vi.fn().mockReturnValue([]), resolve: vi.fn(), onAttentionChanged: vi.fn().mockReturnValue(() => undefined) },
      events,
      terminals: {
        create: vi.fn(() => {
          counter += 1;
          const id = `00000000-0000-4000-8000-${String(counter).padStart(12, "0")}`;
          return {
            id, projectId: "", profile: "pwsh" as const, title: "PowerShell", cwd: directory,
            cols: 100, rows: 28, status: "running" as const, startedAt: "2026-09-22T00:00:00.000Z",
            closedAt: null, lastExitCode: null, isAgent: false, agentProfile: null, ownedByAgentApi: false, pid: 0, nativeSessionId: null,
            worktreeId: null,
            contextUsage: null,
          };
        }),
        write: vi.fn(), writeWhenShellReady: vi.fn(), resize: vi.fn(), rename: vi.fn(), markAgent: vi.fn(), setLabel: vi.fn(), markAgentOwned: vi.fn(), setNativeSessionId: vi.fn(),
        kill, list: vi.fn().mockReturnValue([]), snapshots: vi.fn().mockReturnValue([]), get: vi.fn().mockReturnValue(null), getPtyState: vi.fn().mockReturnValue(null), getLastCommand: vi.fn().mockReturnValue(null), dashboardSnapshot: vi.fn().mockReturnValue([]), setTerminalKeepalive: vi.fn().mockReturnValue(null), listTerminalKeepaliveStates: vi.fn().mockReturnValue([]),
      },
      appVersion: "1.0.0", userDataPath: directory, tempPath: directory,
    });
    const project = await repository.createProject("Reclaim", directory);

    await operations.openTile({ projectId: project.id });
    await operations.openTile({ projectId: project.id });
    let layout = await operations.getDockLayout();
    expect(layout.tiles).toHaveLength(2);
    const [first, second] = layout.tiles.map((tile) => tile.terminalId);

    // PTY exits on its own (immediate spawn death / `exit` / crash): the tile
    // must be reclaimed by the terminalExit hook — before 1.5.44 it stayed as
    // a blank unclosable placeholder still counting toward MAX_TILES.
    events.emit("terminalExit", { terminalId: first!, projectId: project.id, exitCode: 1 });
    await vi.waitFor(async () => {
      layout = await operations.getDockLayout();
      expect(layout.tiles.map((tile) => tile.terminalId)).toEqual([second]);
    });
    // Selection moved to the surviving tile.
    expect(layout.selectedTerminalId).toBe(second);
    expect(kill).not.toHaveBeenCalled();

    // Exits for ids that are not dock tiles are a no-op (never throw, never
    // disturb the layout).
    events.emit("terminalExit", { terminalId: "99999999-9999-4999-8999-999999999999", projectId: project.id, exitCode: 0 });
    await new Promise((resolve) => setTimeout(resolve, 50));
    layout = await operations.getDockLayout();
    expect(layout.tiles.map((tile) => tile.terminalId)).toEqual([second]);

    // Idempotency: closeTile kills the PTY, which emits terminalExit itself —
    // the reclaim hook must not double-remove or throw.
    kill.mockImplementation(() => {
      events.emit("terminalExit", { terminalId: second!, projectId: project.id, exitCode: 0 });
    });
    layout = await operations.closeTile({ terminalId: second! });
    expect(layout.tiles).toHaveLength(0);
    await new Promise((resolve) => setTimeout(resolve, 50));
    layout = await operations.getDockLayout();
    expect(layout.tiles).toHaveLength(0);
  });

  it("accepts privacy-safe UI action metadata on desktop and web transports", () => {
    const operations = new AppOperations({
      repository,
      runs: { send: vi.fn(), cancel: vi.fn(), command: vi.fn() },
      approvals: { resolve: vi.fn() },
      council: { start: vi.fn(), cancel: vi.fn() },
      attention: { list: vi.fn().mockReturnValue([]), resolve: vi.fn(), onAttentionChanged: vi.fn().mockReturnValue(() => undefined) },
      events,
      terminals: {
        create: vi.fn(), write: vi.fn(), writeWhenShellReady: vi.fn(), resize: vi.fn(), rename: vi.fn(), markAgent: vi.fn(), setLabel: vi.fn(), markAgentOwned: vi.fn(), setNativeSessionId: vi.fn(),
        kill: vi.fn(), list: vi.fn().mockReturnValue([]), snapshots: vi.fn().mockReturnValue([]), get: vi.fn().mockReturnValue(null), getPtyState: vi.fn().mockReturnValue(null), getLastCommand: vi.fn().mockReturnValue(null), dashboardSnapshot: vi.fn().mockReturnValue([]), setTerminalKeepalive: vi.fn().mockReturnValue(null), listTerminalKeepaliveStates: vi.fn().mockReturnValue([]),
      },
      appVersion: "1.0.0", userDataPath: directory, tempPath: directory,
    });
    const record = {
      actionId: "topbar.settings.open",
      surface: "mobile-web",
      identified: true,
      controlType: "button",
      interaction: "click",
    };

    expect(() => operations.recordUiAction(record)).not.toThrow();
    expect(() => bindWebOperations(operations).recordUiAction?.(record)).not.toThrow();
    expect(() => operations.recordUiAction({ ...record, actionId: "raw labels are forbidden" })).toThrow("Invalid UI action record");
  });

  it("creates provider continuations without rewriting the source lane", async () => {
    const operations = new AppOperations({
      repository,
      runs: { send: vi.fn(), cancel: vi.fn(), command: vi.fn() },
      approvals: { resolve: vi.fn() },
      council: { start: vi.fn(), cancel: vi.fn() },
      attention: { list: vi.fn().mockReturnValue([]), resolve: vi.fn(), onAttentionChanged: vi.fn().mockReturnValue(() => undefined) },
      events,
      terminals: {
        create: vi.fn(), write: vi.fn(), writeWhenShellReady: vi.fn(), resize: vi.fn(), rename: vi.fn(), markAgent: vi.fn(), setLabel: vi.fn(), markAgentOwned: vi.fn(), setNativeSessionId: vi.fn(),
        kill: vi.fn(), list: vi.fn().mockReturnValue([]), snapshots: vi.fn().mockReturnValue([]), get: vi.fn().mockReturnValue(null), getPtyState: vi.fn().mockReturnValue(null), getLastCommand: vi.fn().mockReturnValue(null), dashboardSnapshot: vi.fn().mockReturnValue([]), setTerminalKeepalive: vi.fn().mockReturnValue(null), listTerminalKeepaliveStates: vi.fn().mockReturnValue([]),
      },
      appVersion: "1.0.0",
      userDataPath: directory,
      tempPath: directory,
    });
    const project = await repository.createProject("Coterm", directory);
    const source = await repository.createConversation(project.id, "Source", "claude-official");

    const continuation = await operations.continueConversationWithProvider({
      sourceConversationId: source.id,
      targetProvider: "codex-official",
    });

    expect(continuation).toMatchObject({
      projectId: project.id,
      name: "Source",
      activeProvider: "codex-official",
      primaryProvider: "codex-official",
      continuedFromConversationId: source.id,
      handoffSourceConversationId: source.id,
    });
    expect(repository.getConversation(source.id)?.activeProvider).toBe("claude-official");
    await expect(bindWebOperations(operations).continueConversationWithProvider?.({
      sourceConversationId: source.id,
      targetProvider: "claude-local-main",
    })).resolves.toMatchObject({
      activeProvider: "claude-local-main",
      continuedFromConversationId: source.id,
    });
  });

  it("validates and resolves structured user input", () => {
    const resolveInput = vi.fn();
    const operations = new AppOperations({
      repository,
      runs: { send: vi.fn(), cancel: vi.fn(), command: vi.fn() },
      approvals: { resolve: vi.fn(), resolveInput },
      council: { start: vi.fn(), cancel: vi.fn() },
      attention: { list: vi.fn().mockReturnValue([]), resolve: vi.fn(), onAttentionChanged: vi.fn().mockReturnValue(() => undefined) },
      events,
      terminals: { create: vi.fn(), write: vi.fn(), writeWhenShellReady: vi.fn(), resize: vi.fn(), rename: vi.fn(), markAgent: vi.fn(), setLabel: vi.fn(), markAgentOwned: vi.fn(), setNativeSessionId: vi.fn(), kill: vi.fn(), list: vi.fn(), snapshots: vi.fn(), get: vi.fn().mockReturnValue(null), getPtyState: vi.fn().mockReturnValue(null), getLastCommand: vi.fn().mockReturnValue(null), dashboardSnapshot: vi.fn().mockReturnValue([]), setTerminalKeepalive: vi.fn().mockReturnValue(null), listTerminalKeepaliveStates: vi.fn().mockReturnValue([]) },
      appVersion: "1.0.0", userDataPath: directory, tempPath: directory,
    });

    operations.resolveUserInput({ requestId: "question-1", answers: { architecture: ["Agent SDK"] } });

    expect(resolveInput).toHaveBeenCalledWith("question-1", { architecture: ["Agent SDK"] });
    expect(() => operations.resolveUserInput({ requestId: "question-1", answers: { architecture: [] } }))
      .toThrow();
  });

  it("validates and delegates conversation summaries to the shared summarizer", async () => {
    const project = await repository.createProject("Summary", directory);
    const conversation = await repository.createConversation(project.id, "Before", "claude-local-main");
    const updated = {
      ...conversation,
      name: "After",
      summary: {
        brief: "Brief",
        longTermGoal: "Goal",
        recentSummary: "Recent",
        updatedAt: "2026-06-21T01:02:03.000Z",
        partial: true,
      },
    };
    const summarize = vi.fn().mockResolvedValue(updated);
    const operations = new AppOperations({
      repository,
      summarizer: { summarize },
      runs: { send: vi.fn(), cancel: vi.fn(), command: vi.fn() },
      approvals: { resolve: vi.fn() }, council: { start: vi.fn(), cancel: vi.fn() },
      attention: { list: vi.fn().mockReturnValue([]), resolve: vi.fn(), onAttentionChanged: vi.fn().mockReturnValue(() => undefined) },
      events,
      terminals: { create: vi.fn(), write: vi.fn(), writeWhenShellReady: vi.fn(), resize: vi.fn(), rename: vi.fn(), markAgent: vi.fn(), setLabel: vi.fn(), markAgentOwned: vi.fn(), setNativeSessionId: vi.fn(), kill: vi.fn(), list: vi.fn(), snapshots: vi.fn(), get: vi.fn().mockReturnValue(null), getPtyState: vi.fn().mockReturnValue(null), getLastCommand: vi.fn().mockReturnValue(null), dashboardSnapshot: vi.fn().mockReturnValue([]), setTerminalKeepalive: vi.fn().mockReturnValue(null), listTerminalKeepaliveStates: vi.fn().mockReturnValue([]) },
      appVersion: "1.0.0", userDataPath: directory, tempPath: directory,
    });

    await expect(operations.summarizeConversation({ conversationId: conversation.id }))
      .resolves.toEqual(updated);
    expect(summarize).toHaveBeenCalledWith(conversation.id);
    await expect(operations.summarizeConversation({ conversationId: "not-an-id" }))
      .rejects.toThrow();
    await expect(operations.summarizeConversation({ conversationId: conversation.id, extra: true }))
      .rejects.toThrow();
    expect(summarize).toHaveBeenCalledTimes(1);
  });

  it("projects and adopts Claude history without exposing the native session ID", async () => {
    const project = await repository.createProject("History", directory);
    const session = {
      key: "a".repeat(64),
      projectId: project.id,
      title: "Existing Claude work",
      updatedAt: "2026-06-21T01:02:03.000Z",
    };
    const claudeHistory = {
      list: vi.fn().mockResolvedValue([session]),
      read: vi.fn().mockResolvedValue({ session, messages: [], truncated: false }),
      resolve: vi.fn().mockResolvedValue({
        file: join(directory, "private.jsonl"),
        nativeSessionId: "private-native-session",
        session,
      }),
    };
    const operations = new AppOperations({
      repository,
      claudeHistory,
      runs: { send: vi.fn(), cancel: vi.fn(), command: vi.fn() },
      approvals: { resolve: vi.fn() }, council: { start: vi.fn(), cancel: vi.fn() },
      attention: { list: vi.fn().mockReturnValue([]), resolve: vi.fn(), onAttentionChanged: vi.fn().mockReturnValue(() => undefined) },
      events,
      terminals: { create: vi.fn(), write: vi.fn(), writeWhenShellReady: vi.fn(), resize: vi.fn(), rename: vi.fn(), markAgent: vi.fn(), setLabel: vi.fn(), markAgentOwned: vi.fn(), setNativeSessionId: vi.fn(), kill: vi.fn(), list: vi.fn(), snapshots: vi.fn(), get: vi.fn().mockReturnValue(null), getPtyState: vi.fn().mockReturnValue(null), getLastCommand: vi.fn().mockReturnValue(null), dashboardSnapshot: vi.fn().mockReturnValue([]), setTerminalKeepalive: vi.fn().mockReturnValue(null), listTerminalKeepaliveStates: vi.fn().mockReturnValue([]) },
      appVersion: "1.0.0", userDataPath: directory, tempPath: directory,
    });

    await expect(operations.listClaudeHistory({ projectId: project.id })).resolves.toEqual([session]);
    await expect(operations.readClaudeHistory({ projectId: project.id, key: session.key }))
      .resolves.toMatchObject({ session, messages: [] });
    const adopted = await operations.adoptClaudeHistory({ projectId: project.id, key: session.key });
    const adoptedAgain = await operations.adoptClaudeHistory({ projectId: project.id, key: session.key });
    const providerSession = await repository.getOrCreateProviderSession(adopted.id, "claude-official");

    expect(adoptedAgain.id).toBe(adopted.id);
    expect(providerSession.nativeSessionId).toBe("private-native-session");
    expect(JSON.stringify(adopted)).not.toContain("private-native-session");
  });

  it("keeps workspace, artifact, and attachment access inside the shared boundary", async () => {
    const workspaceShell = {
      trashItem: vi.fn().mockResolvedValue(undefined),
      showItemInFolder: vi.fn(),
      openPath: vi.fn().mockResolvedValue(""),
    };
    const operations = new AppOperations({
      repository,
      runs: { send: vi.fn(), cancel: vi.fn(), command: vi.fn() },
      approvals: { resolve: vi.fn() }, council: { start: vi.fn(), cancel: vi.fn() },
      attention: { list: vi.fn().mockReturnValue([]), resolve: vi.fn(), onAttentionChanged: vi.fn().mockReturnValue(() => undefined) },
      events,
      workspaceShell,
      terminals: { create: vi.fn(), write: vi.fn(), writeWhenShellReady: vi.fn(), resize: vi.fn(), rename: vi.fn(), markAgent: vi.fn(), setLabel: vi.fn(), markAgentOwned: vi.fn(), setNativeSessionId: vi.fn(), kill: vi.fn(), list: vi.fn().mockReturnValue([]), snapshots: vi.fn().mockReturnValue([]), get: vi.fn().mockReturnValue(null), getPtyState: vi.fn().mockReturnValue(null), getLastCommand: vi.fn().mockReturnValue(null), dashboardSnapshot: vi.fn().mockReturnValue([]), setTerminalKeepalive: vi.fn().mockReturnValue(null), listTerminalKeepaliveStates: vi.fn().mockReturnValue([]) },
      appVersion: "1.0.0", userDataPath: directory, tempPath: directory,
    });
    const project = await repository.createProject("Files", directory);
    const conversation = await repository.createConversation(project.id, "Files", "codex-official");
    const markdown = join(directory, "note.md");
    const csv = join(directory, "rows.csv");
    const pdf = join(directory, "report.pdf");
    const xlsx = join(directory, "book.xlsx");
    await writeFile(markdown, "old", "utf8");
    await writeFile(csv, "name,value\nalpha,1\n", "utf8");
    await writeFile(pdf, Buffer.from("%PDF-1.4\nprobe"));
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([["中文", "值"], ["demo", 7]]), "資料");
    await writeFile(xlsx, XLSX.write(workbook, { type: "buffer", bookType: "xlsx" }) as Buffer);

    expect(await operations.listWorkspace({ projectId: project.id, path: directory }))
      .toContainEqual(expect.objectContaining({ name: "note.md", type: "file" }));
    const created = await operations.createWorkspaceFile({ projectId: project.id, name: "created.txt" });
    expect(created).toMatchObject({ name: "created.txt", relativePath: "created.txt" });
    const renamed = await operations.renameWorkspaceEntry({ projectId: project.id, path: created.path, newName: "renamed.txt" });
    expect(renamed.name).toBe("renamed.txt");
    await expect(operations.createWorkspaceFile({ projectId: project.id, name: "../escape.txt" }))
      .rejects.toThrow(/outside|Invalid workspace entry/u);
    await operations.deleteWorkspaceEntry({ projectId: project.id, path: renamed.path });
    expect(workspaceShell.trashItem).toHaveBeenCalledWith(renamed.path);
    expect(await operations.readArtifact({ projectId: project.id, path: markdown }))
      .toMatchObject({ kind: "markdown", text: "old" });
    // No folder restriction: a file outside the project, userData, temp and home still opens.
    const outside = await mkdtemp(join(process.cwd(), ".artifact-outside-"));
    try {
      await writeFile(join(outside, "far.md"), "far", "utf8");
      expect(await operations.readArtifact({ projectId: project.id, path: join(outside, "far.md") }))
        .toMatchObject({ kind: "markdown", text: "far" });
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
    const csvArtifact = await operations.readArtifact({ projectId: project.id, path: csv });
    expect(csvArtifact).toMatchObject({ kind: "spreadsheet", mimeType: "text/csv" });
    if (!("workbookToken" in csvArtifact)) throw new Error("Expected a CSV workbook token");
    expect(operations.readArtifactWorkbook({ token: csvArtifact.workbookToken })).toMatchObject({ format: "csv" });
    const pdfArtifact = await operations.readArtifact({ projectId: project.id, path: pdf });
    expect(pdfArtifact).toMatchObject({ kind: "pdf", mimeType: "application/pdf" });
    if (!("dataUrl" in pdfArtifact)) throw new Error("Expected a binary PDF artifact");
    expect(pdfArtifact.dataUrl).toMatch(/^data:application\/pdf;base64,/);
    const workbookArtifact = await operations.readArtifact({ projectId: project.id, path: xlsx });
    expect(workbookArtifact).toMatchObject({ kind: "spreadsheet", mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
    if (!("workbookToken" in workbookArtifact)) throw new Error("Expected a workbook token");
    expect(operations.readArtifactWorkbook({ token: workbookArtifact.workbookToken })).toMatchObject({ sheets: [expect.objectContaining({ name: "資料" })] });
    expect(operations.openBrowserArtifact({ url: "https://example.com/work" })).toMatchObject({ kind: "browser", url: "https://example.com/work" });
    expect(() => operations.openBrowserArtifact({ url: "javascript:alert(1)" })).toThrow(/HTTP and HTTPS/u);
    await operations.writeArtifact({ projectId: project.id, path: markdown, text: "new" });
    expect(await readFile(markdown, "utf8")).toBe("new");

    const attachment = await operations.saveAttachment({
      conversationId: conversation.id, name: "image.png", mimeType: "image/png",
      dataBase64: Buffer.from("png").toString("base64"),
    });
    expect(operations.listAttachments(conversation.id)).toContainEqual(attachment);
    await operations.deleteAttachment(attachment.id);
    expect(operations.listAttachments(conversation.id)).toEqual([]);
  });

  it("shares live terminal layout and scrollback", async () => {
    const project = await repository.createProject("Terminal", directory);
    const info = { id: "11111111-1111-4111-8111-111111111111", projectId: project.id, profile: "powershell" as const,
      title: "PowerShell", cwd: directory, cols: 100, rows: 28, status: "running" as const,
      startedAt: new Date().toISOString(), closedAt: null, lastExitCode: null,
      isAgent: false, agentProfile: null, nativeSessionId: null };
    const terminals = {
      create: vi.fn(), write: vi.fn(), writeWhenShellReady: vi.fn(), resize: vi.fn(), rename: vi.fn(), markAgent: vi.fn(), setLabel: vi.fn(), markAgentOwned: vi.fn(), setNativeSessionId: vi.fn(), kill: vi.fn(),
      list: vi.fn().mockReturnValue([info]),
      snapshots: vi.fn().mockReturnValue([{ info, scrollback: "same process" }]), get: vi.fn().mockReturnValue(null), getPtyState: vi.fn().mockReturnValue(null), getLastCommand: vi.fn().mockReturnValue(null), dashboardSnapshot: vi.fn().mockReturnValue([]), setTerminalKeepalive: vi.fn().mockReturnValue(null), listTerminalKeepaliveStates: vi.fn().mockReturnValue([]),
    };
    const operations = new AppOperations({
      repository, terminals,
      runs: { send: vi.fn(), cancel: vi.fn(), command: vi.fn() }, approvals: { resolve: vi.fn() },
      council: { start: vi.fn(), cancel: vi.fn() }, attention: { list: vi.fn().mockReturnValue([]), resolve: vi.fn(), onAttentionChanged: vi.fn().mockReturnValue(() => undefined) }, events, appVersion: "1.0.0",
      userDataPath: directory, tempPath: directory,
    });
    await expect(operations.getTerminalWorkspace(project.id)).resolves.toMatchObject({
      terminals: [info], activeId: info.id, restored: false,
      scrollback: { [info.id]: "same process" },
    });
    await operations.saveTerminalWorkspace({
      projectId: project.id, terminalIds: [info.id], split: "single",
      activeId: info.id, secondaryId: null,
    });
    expect(repository.loadTerminalWorkspace(project.id)?.panes[0]?.scrollback).toBe("same process");
  });

  it("refreshTerminal emits replace:true terminalData and never writes clear codes to the PTY", async () => {
    const project = await repository.createProject("Refresh", directory);
    const info = { id: "22222222-2222-4222-8222-222222222222", projectId: project.id, profile: "powershell" as const,
      title: "PowerShell", cwd: directory, cols: 100, rows: 28, status: "running" as const,
      startedAt: new Date().toISOString(), closedAt: null, lastExitCode: null,
      isAgent: false, agentProfile: null, nativeSessionId: null };
    const write = vi.fn();
    const snapshots = vi.fn().mockReturnValue([{ info, scrollback: "fake-scrollback-bytes" }]);
    const terminals = {
      create: vi.fn(), write, writeWhenShellReady: vi.fn(), resize: vi.fn(), rename: vi.fn(), markAgent: vi.fn(), setLabel: vi.fn(), markAgentOwned: vi.fn(), setNativeSessionId: vi.fn(), kill: vi.fn(),
      list: vi.fn().mockReturnValue([info]), snapshots, get: vi.fn().mockReturnValue(info), getPtyState: vi.fn().mockReturnValue(null), getLastCommand: vi.fn().mockReturnValue(null), dashboardSnapshot: vi.fn().mockReturnValue([]), setTerminalKeepalive: vi.fn().mockReturnValue(null), listTerminalKeepaliveStates: vi.fn().mockReturnValue([]),
    };
    const operations = new AppOperations({
      repository, terminals,
      runs: { send: vi.fn(), cancel: vi.fn(), command: vi.fn() }, approvals: { resolve: vi.fn() },
      council: { start: vi.fn(), cancel: vi.fn() }, attention: { list: vi.fn().mockReturnValue([]), resolve: vi.fn(), onAttentionChanged: vi.fn().mockReturnValue(() => undefined) }, events, appVersion: "1.0.0",
      userDataPath: directory, tempPath: directory,
    });
    const emitSpy = vi.spyOn(events, "emit");

    await operations.refreshTerminal(info.id);

    expect(emitSpy).toHaveBeenCalledWith("terminalData", expect.objectContaining({
      terminalId: info.id, projectId: project.id, replace: true, data: "fake-scrollback-bytes",
    }));
    expect(write).not.toHaveBeenCalled();
  });

  it("refreshTerminal still emits a clear when scrollback is empty (no silent no-op)", async () => {
    const project = await repository.createProject("RefreshEmpty", directory);
    const info = { id: "33333333-3333-4333-8333-333333333333", projectId: project.id, profile: "powershell" as const,
      title: "PowerShell", cwd: directory, cols: 100, rows: 28, status: "running" as const,
      startedAt: new Date().toISOString(), closedAt: null, lastExitCode: null,
      isAgent: false, agentProfile: null, nativeSessionId: null };
    const write = vi.fn();
    const snapshots = vi.fn().mockReturnValue([{ info, scrollback: "" }]);
    const terminals = {
      create: vi.fn(), write, writeWhenShellReady: vi.fn(), resize: vi.fn(), rename: vi.fn(), markAgent: vi.fn(), setLabel: vi.fn(), markAgentOwned: vi.fn(), setNativeSessionId: vi.fn(), kill: vi.fn(),
      list: vi.fn().mockReturnValue([info]), snapshots, get: vi.fn().mockReturnValue(info), getPtyState: vi.fn().mockReturnValue(null), getLastCommand: vi.fn().mockReturnValue(null), dashboardSnapshot: vi.fn().mockReturnValue([]), setTerminalKeepalive: vi.fn().mockReturnValue(null), listTerminalKeepaliveStates: vi.fn().mockReturnValue([]),
    };
    const operations = new AppOperations({
      repository, terminals,
      runs: { send: vi.fn(), cancel: vi.fn(), command: vi.fn() }, approvals: { resolve: vi.fn() },
      council: { start: vi.fn(), cancel: vi.fn() }, attention: { list: vi.fn().mockReturnValue([]), resolve: vi.fn(), onAttentionChanged: vi.fn().mockReturnValue(() => undefined) }, events, appVersion: "1.0.0",
      userDataPath: directory, tempPath: directory,
    });
    const emitSpy = vi.spyOn(events, "emit");

    await operations.refreshTerminal(info.id);

    expect(emitSpy).toHaveBeenCalledWith("terminalData", expect.objectContaining({
      terminalId: info.id, projectId: project.id, replace: true, data: "",
    }));
    expect(write).not.toHaveBeenCalled();
  });

  it("creates remote projects only inside configured roots", async () => {
    const operations = new AppOperations({
      repository, remoteRoots: [directory],
      terminals: { create: vi.fn(), write: vi.fn(), writeWhenShellReady: vi.fn(), resize: vi.fn(), rename: vi.fn(), markAgent: vi.fn(), setLabel: vi.fn(), markAgentOwned: vi.fn(), setNativeSessionId: vi.fn(), kill: vi.fn(), list: vi.fn(), snapshots: vi.fn(), get: vi.fn().mockReturnValue(null), getPtyState: vi.fn().mockReturnValue(null), getLastCommand: vi.fn().mockReturnValue(null), dashboardSnapshot: vi.fn().mockReturnValue([]), setTerminalKeepalive: vi.fn().mockReturnValue(null), listTerminalKeepaliveStates: vi.fn().mockReturnValue([]) },
      runs: { send: vi.fn(), cancel: vi.fn(), command: vi.fn() }, approvals: { resolve: vi.fn() },
      council: { start: vi.fn(), cancel: vi.fn() }, attention: { list: vi.fn().mockReturnValue([]), resolve: vi.fn(), onAttentionChanged: vi.fn().mockReturnValue(() => undefined) }, events, appVersion: "1.0.0",
      userDataPath: directory, tempPath: directory,
    });
    const canonicalDirectory = await realpath(directory);
    await expect(operations.pickWorkspace()).resolves.toBe(canonicalDirectory);
    await expect(operations.createProject({ name: "Remote", workspacePath: directory }))
      .resolves.toMatchObject({ name: "Remote", workspacePath: canonicalDirectory });
    await expect(operations.createProject({ name: "Denied", workspacePath: tmpdir() }))
      .rejects.toThrow();
  });

  // Hot model registry (stage 1, SPEC §D item 5): saving a customProfiles
  // change must, WITHOUT a restart, (a) regenerate the launcher shim for the
  // new profile and (b) push the derived agent option list on the bus so
  // every renderer / live-socket client sees it in the "＋" picker.
  it("hot-reloads custom profiles: shim regenerated + profilesChanged broadcast", async () => {
    const operations = new AppOperations({
      repository,
      runs: { send: vi.fn(), cancel: vi.fn(), command: vi.fn() },
      approvals: { resolve: vi.fn() },
      council: { start: vi.fn(), cancel: vi.fn() },
      attention: { list: vi.fn().mockReturnValue([]), resolve: vi.fn(), onAttentionChanged: vi.fn().mockReturnValue(() => undefined) },
      events,
      terminals: {
        create: vi.fn(), write: vi.fn(), writeWhenShellReady: vi.fn(), resize: vi.fn(), rename: vi.fn(), markAgent: vi.fn(), setLabel: vi.fn(), markAgentOwned: vi.fn(), setNativeSessionId: vi.fn(),
        kill: vi.fn(), list: vi.fn().mockReturnValue([]), snapshots: vi.fn().mockReturnValue([]), get: vi.fn().mockReturnValue(null), getPtyState: vi.fn().mockReturnValue(null), getLastCommand: vi.fn().mockReturnValue(null), dashboardSnapshot: vi.fn().mockReturnValue([]), setTerminalKeepalive: vi.fn().mockReturnValue(null), listTerminalKeepaliveStates: vi.fn().mockReturnValue([]),
      },
      appVersion: "1.0.0",
      userDataPath: directory,
      tempPath: directory,
    });

    const pushes: unknown[][] = [];
    const onProfilesChanged = (options: unknown[]): void => {
      pushes.push(options);
    };
    events.on("profilesChanged", onProfilesChanged);

    try {
      // 1. A no-op save never fires the event.
      await operations.setSettings({});
      expect(pushes).toHaveLength(0);

      // 2. Saving a custom profile fires once with the derived option list.
      // Stage 2: the entry carries its own provider URL/token (public users
      // filling OpenRouter/Groq-style creds). The token must reach the shim
      // but never the log.
      const logDir = await mkdtemp(join(tmpdir(), "coterm-operations-log-"));
      initLogger({ userDataDir: logDir, level: "debug" });
      const profileToken = "opaque-token-Zx91QvLm7g2k";
      await operations.setSettings({
        customProfiles: {
          "claude-hotprobe": {
            local: true,
            label: "Hot Probe 744",
            model: "hot-probe-model-x",
            baseUrl: "https://openrouter.example/api",
            authToken: profileToken,
            env: { ANTHROPIC_MODEL: "hot-probe-model-x" },
          },
        },
      });
      expect(pushes).toHaveLength(1);
      const pushed = pushes[0] as Array<{ id: string; label?: string; model?: string; local?: boolean }>;
      const probe = pushed.find((option) => option.id === "claude-hotprobe");
      expect(probe).toMatchObject({
        id: "claude-hotprobe",
        label: "Hot Probe 744",
        model: "hot-probe-model-x",
        local: true,
      });
      // The push carries the whole list, built-ins included (renderer replaces
      // its table wholesale, it does not merge).
      expect(pushed.map((option) => option.id)).toContain("claude-local-main");
      expect(pushed).toHaveLength(13); // 12 built-ins ⊕ 1 custom (codex-team #100 added 2026-10-07; recount when the built-in table changes)

      // 3. The shim exists on disk immediately (launch works without restart),
      //    baked with the profile's own URL/token.
      const shim = await readFile(join(directory, "agent-launchers", "claude-hotprobe.ps1"), "utf8");
      expect(shim).toContain("'--model', 'hot-probe-model-x'");
      expect(shim).toContain("$env:ANTHROPIC_MODEL='hot-probe-model-x'");
      expect(shim).toContain("$env:ANTHROPIC_BASE_URL='https://openrouter.example/api'");
      expect(shim).toContain(`$env:ANTHROPIC_AUTH_TOKEN='${profileToken}'`);

      // 3b. coterm.log records the change by id only — the token never
      //     appears in any log line (logging §A.2 / stage 2 security).
      const log = await readFile(join(logDir, "logs", "coterm.log"), "utf8");
      expect(log).toContain("claude-hotprobe");
      expect(log).not.toContain(profileToken);

      // 4. A subsequent save that does not touch customProfiles stays quiet.
      await operations.setSettings({});
      expect(pushes).toHaveLength(1);

      // 5. Removing the profile fires again with the built-in-only list.
      await operations.setSettings({ customProfiles: {} });
      expect(pushes).toHaveLength(2);
      expect((pushes[1] as Array<{ id: string }>).map((option) => option.id)).not.toContain("claude-hotprobe");
    } finally {
      events.off("profilesChanged", onProfilesChanged);
    }
  });
});
