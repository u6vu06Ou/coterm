import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AppDatabase } from "../../src/main/storage/database";
import { Repository } from "../../src/main/storage/repository";
import { migrations } from "../../src/main/storage/migrations";
import { conversationSchema, type ConversationSummary } from "../../src/shared/schema";

describe("SQLite repository", () => {
  let directory: string;
  let databasePath: string;
  let database: AppDatabase;
  let repository: Repository;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "ai-terminal-db-"));
    databasePath = join(directory, "state.sqlite");
    database = new AppDatabase(databasePath);
    await database.open();
    repository = new Repository(database);
  });

  afterEach(async () => {
    await repository.closeSearchIndex();
    database.close();
    await rm(directory, { recursive: true, force: true });
  });

  it("persists projects, provider lanes, settings, and ordered concurrent events", async () => {
    const project = await repository.createProject("測試專案", directory);
    const conversation = await repository.createConversation(
      project.id,
      "繁體中文對話",
      "claude-official",
    );
    const session = await repository.getOrCreateProviderSession(
      conversation.id,
      "claude-official",
    );
    const concurrentSessions = await Promise.all(
      Array.from({ length: 8 }, () =>
        repository.getOrCreateProviderSession(conversation.id, "claude-official"),
      ),
    );
    expect(concurrentSessions.every((item) => item.id === session.id)).toBe(true);

    const turnId = await repository.startTurn(conversation.id, session.id);
    await Promise.all(
      Array.from({ length: 24 }, (_, index) =>
        repository.appendEvent({
          conversationId: conversation.id,
          turnId,
          providerSessionId: session.id,
          turnGroupId: null,
          type: "assistant.progress",
          summary: `event-${index}`,
          payload: { index },
        }),
      ),
    );
    const events = repository.listEvents(conversation.id);
    expect(events.map((event) => event.sequence)).toEqual(
      Array.from({ length: 24 }, (_, index) => index),
    );

    const settings = repository.getSettings();
    await repository.setSettings({ ...settings, theme: "light" });
    await repository.saveTerminalWorkspace(
      project.id,
      { split: "vertical", activeIndex: 0, secondaryIndex: 1 },
      [
        {
          id: "b65f930b-a464-4718-841e-5749416248c9",
          profile: "powershell",
          title: "主控台",
          cwd: directory,
          cols: 100,
          rows: 28,
          scrollback: "測試輸出",
        },
        {
          id: "3619a2de-0b00-48e4-889d-c214d68549cb",
          profile: "cmd",
          title: "CMD",
          cwd: directory,
          cols: 80,
          rows: 24,
          scrollback: "",
        },
      ],
    );
    database.close();

    database = new AppDatabase(databasePath);
    await database.open();
    repository = new Repository(database);

    expect(repository.listProjects()[0]?.name).toBe("測試專案");
    expect(repository.listEvents(conversation.id)).toHaveLength(24);
    expect(repository.getSettings()).toMatchObject({ theme: "light" });
    expect(repository.loadTerminalWorkspace(project.id)).toMatchObject({
      split: "vertical",
      activeIndex: 0,
      secondaryIndex: 1,
      panes: [{ title: "主控台", scrollback: "測試輸出" }, { title: "CMD" }],
    });
    expect(database.schemaVersion).toBe(migrations.at(-1)!.version);
  });

  it("migrates existing conversations with a nullable summary", async () => {
    const project = await repository.createProject("legacy", directory);
    const conversation = await repository.createConversation(
      project.id,
      "Preserved v3 conversation",
      "claude-official",
    );
    database.run("ALTER TABLE conversations DROP COLUMN summary_json");
    database.run("ALTER TABLE conversations DROP COLUMN claude_model");
    database.run("ALTER TABLE conversations DROP COLUMN primary_provider");
    database.run("ALTER TABLE conversations DROP COLUMN continued_from_conversation_id");
    database.run("ALTER TABLE conversations DROP COLUMN handoff_source_conversation_id");
    dropTerminalV8(database);
    database.run("DELETE FROM schema_migrations WHERE version >= 4");
    await database.persist();
    database.close();

    database = new AppDatabase(databasePath);
    await database.open();
    repository = new Repository(database);
    const columns = database.queryAll<{ name: string }>("PRAGMA table_info(conversations)");

    expect(columns.map((column) => column.name)).toContain("summary_json");
    expect(database.schemaVersion).toBe(migrations.at(-1)!.version);
    expect(repository.getConversation(conversation.id)).toMatchObject({
      name: "Preserved v3 conversation",
      summary: null,
    });
  });

  it("migrates retired DeepSeek provider IDs to GLM", async () => {
    const project = await repository.createProject("legacy GLM", directory);
    const conversation = await repository.createConversation(
      project.id,
      "Legacy provider",
      "claude-local-main",
    );
    const session = await repository.getOrCreateProviderSession(conversation.id, "claude-local-main");
    const groupId = crypto.randomUUID();
    await repository.setSettings({ ...repository.getSettings(), defaultProvider: "claude-local-main" });
    await repository.addHandoff(conversation.id, "claude-local-main", "claude-local-long", {
      sourceProfile: "claude-local-main",
      targetProfile: "claude-local-long",
    });
    database.run("UPDATE conversations SET active_provider = 'claude-local-deep' WHERE id = ?", [conversation.id]);
    database.run("UPDATE provider_sessions SET profile_id = 'claude-local-deep' WHERE id = ?", [session.id]);
    database.run("UPDATE handoffs SET source_profile = 'claude-local-deep', packet_json = replace(packet_json, 'claude-local-main', 'claude-local-deep') WHERE conversation_id = ?", [conversation.id]);
    database.run("UPDATE settings SET value_json = replace(value_json, 'claude-local-main', 'claude-local-deep')");
    database.run("ALTER TABLE conversations DROP COLUMN primary_provider");
    database.run("ALTER TABLE conversations DROP COLUMN continued_from_conversation_id");
    database.run("ALTER TABLE conversations DROP COLUMN handoff_source_conversation_id");
    dropTerminalV8(database);
    database.run(
      "INSERT INTO turn_groups(id, conversation_id, type, status, chairman, created_at) VALUES (?, ?, 'council', 'completed', 'deepseek', ?)",
      [groupId, conversation.id, new Date().toISOString()],
    );
    database.run(
      "INSERT INTO turn_group_members(id, turn_group_id, profile_id, anonymous_label, status) VALUES (?, ?, 'claude-local-deep', 'C', 'completed')",
      [crypto.randomUUID(), groupId],
    );
    database.run(
      "INSERT INTO peer_reviews(id, turn_group_id, reviewer_profile_id, rankings_json, created_at) VALUES (?, ?, 'claude-local-deep', '[]', ?)",
      [crypto.randomUUID(), groupId, new Date().toISOString()],
    );
    database.run(
      "INSERT INTO chairman_syntheses(id, turn_group_id, chairman_profile_id, content, created_at) VALUES (?, ?, 'claude-local-deep', 'done', ?)",
      [crypto.randomUUID(), groupId, new Date().toISOString()],
    );
    database.run("DELETE FROM schema_migrations WHERE version >= 6");
    await database.persist();
    database.close();

    database = new AppDatabase(databasePath);
    await database.open();
    repository = new Repository(database);

    expect(database.schemaVersion).toBe(migrations.at(-1)!.version);
    expect(repository.getConversation(conversation.id)?.activeProvider).toBe("claude-local-main");
    expect(database.queryOne<{ profile_id: string }>(
      "SELECT profile_id FROM provider_sessions WHERE id = ?", [session.id],
    )?.profile_id).toBe("claude-local-main");
    expect(database.queryOne<{ chairman: string }>(
      "SELECT chairman FROM turn_groups WHERE id = ?", [groupId],
    )?.chairman).toBe("glm");
    expect(database.queryOne<{ profile_id: string }>(
      "SELECT profile_id FROM turn_group_members WHERE turn_group_id = ?", [groupId],
    )?.profile_id).toBe("claude-local-main");
    expect(database.queryOne<{ reviewer_profile_id: string }>(
      "SELECT reviewer_profile_id FROM peer_reviews WHERE turn_group_id = ?", [groupId],
    )?.reviewer_profile_id).toBe("claude-local-main");
    expect(database.queryOne<{ chairman_profile_id: string }>(
      "SELECT chairman_profile_id FROM chairman_syntheses WHERE turn_group_id = ?", [groupId],
    )?.chairman_profile_id).toBe("claude-local-main");
    const handoff = database.queryOne<{ source_profile: string; packet_json: string }>(
      "SELECT source_profile, packet_json FROM handoffs WHERE conversation_id = ?", [conversation.id],
    );
    expect(handoff?.source_profile).toBe("claude-local-main");
    expect(handoff?.packet_json).not.toContain("claude-local-deep");
    expect(repository.getSettings().defaultProvider).toBe("claude-local-main");
  });

  it("defaults missing conversation summaries to null", () => {
    expect(
      conversationSchema.parse({
        id: "668aa3c2-0eac-40e4-b623-5ed57313278f",
        projectId: "2934a520-a112-4132-8731-05e51e9be9ba",
        name: "Legacy payload",
        activeProvider: "claude-official",
        archived: false,
        createdAt: "2026-06-21T03:00:00.000Z",
        updatedAt: "2026-06-21T03:00:00.000Z",
      }),
    ).toMatchObject({
      summary: null,
      claudeModel: "default",
      primaryProvider: "claude-official",
      continuedFromConversationId: null,
      handoffSourceConversationId: null,
    });
  });

  it("lists project history sessions with resumable native IDs and summaries", async () => {
    const project = await repository.createProject("history", directory);
    const otherProject = await repository.createProject("other", directory);
    const activeConversation = await repository.createConversation(
      project.id,
      "Active work",
      "claude-local-main",
    );
    const archivedConversation = await repository.createConversation(
      project.id,
      "Archived work",
      "claude-local-long",
    );
    const otherConversation = await repository.createConversation(
      otherProject.id,
      "Other work",
      "claude-local-main",
    );
    const session = await repository.getOrCreateProviderSession(activeConversation.id, "claude-local-main");
    const archivedSession = await repository.getOrCreateProviderSession(archivedConversation.id, "claude-local-long");
    await repository.getOrCreateProviderSession(otherConversation.id, "claude-local-main");
    await repository.updateProviderSession(session.id, {
      nativeSessionId: "native-history-session",
      status: "idle",
    });
    await repository.saveConversationSummary(activeConversation.id, "Active work", {
      brief: "Brief summary",
      longTermGoal: "Goal",
      recentSummary: "Recent summary",
      updatedAt: "2026-06-30T01:02:03.000Z",
      partial: false,
    });
    await repository.setConversationArchived(archivedConversation.id, true);

    const sessions = repository.listProjectSessions(project.id);
    expect(sessions).toEqual(expect.arrayContaining([
      expect.objectContaining({
        providerSessionId: session.id,
        conversationId: activeConversation.id,
        projectId: project.id,
        conversationName: "Active work",
        profileId: "claude-local-main",
        nativeSessionId: "native-history-session",
        status: "idle",
        summary: expect.objectContaining({ recentSummary: "Recent summary" }) as unknown as ConversationSummary,
        conversationUpdatedAt: "2026-06-30T01:02:03.000Z",
      }),
    ]));
    expect(sessions).not.toEqual(expect.arrayContaining([
      expect.objectContaining({
        providerSessionId: archivedSession.id,
        conversationId: archivedConversation.id,
      }),
    ]));
  });

  it("creates provider continuations as separate conversations", async () => {
    const project = await repository.createProject("handoff", directory);
    const source = await repository.createConversation(
      project.id,
      "Source lane",
      "claude-official",
    );
    await repository.getOrCreateProviderSession(source.id, "claude-official");

    const continuation = await repository.createContinuationConversation(
      source.id,
      "codex-official",
    );

    expect(continuation).toMatchObject({
      projectId: project.id,
      name: "Source lane",
      activeProvider: "codex-official",
      primaryProvider: "codex-official",
      continuedFromConversationId: source.id,
      handoffSourceConversationId: source.id,
    });
    expect(continuation.id).not.toBe(source.id);
    expect(repository.getConversation(source.id)).toMatchObject({
      activeProvider: "claude-official",
      primaryProvider: "claude-official",
      continuedFromConversationId: null,
      handoffSourceConversationId: null,
    });
    expect(repository.findProviderSession(source.id, "codex-official")).toBeNull();
  });

  it("persists a Claude model per conversation", async () => {
    const project = await repository.createProject("models", directory);
    const conversation = await repository.createConversation(
      project.id,
      "Model lane",
      "claude-official",
    );

    await expect(repository.setConversationClaudeModel(conversation.id, "haiku"))
      .resolves.toMatchObject({ claudeModel: "haiku" });
    expect(repository.getConversation(conversation.id)?.claudeModel).toBe("haiku");
  });

  it("stores redacted terminal events outside chat turns", async () => {
    const project = await repository.createProject("terminal-ledger", directory);

    await repository.appendTerminalEvent({
      projectId: project.id,
      terminalId: "b65f930b-a464-4718-841e-5749416248c9",
      type: "terminal.session.started",
      summary: "PowerShell started.",
      payload: { cwd: directory },
    });
    await repository.appendTerminalEvent({
      projectId: project.id,
      terminalId: "b65f930b-a464-4718-841e-5749416248c9",
      type: "terminal.output",
      summary: "Bearer super-secret-token-value",
      payload: { text: "api_key=super-secret-token-value" },
    });

    const terminalEvents = repository.listRecentTerminalEvents(project.id);
    expect(terminalEvents).toMatchObject([
      { type: "terminal.session.started", sequence: 0 },
      {
        type: "terminal.output",
        sequence: 1,
      },
    ]);
    expect(terminalEvents[1]?.summary).toContain("[REDACTED]");
    expect(JSON.stringify(terminalEvents)).not.toContain("super-secret-token-value");
  });

  it("searches conversations, events, terminal output, handoffs, and artifacts", async () => {
    const project = await repository.createProject("微台 tick 交易", directory);
    const conversation = await repository.createConversation(project.id, "策略紀錄", "claude-official");
    const turnId = await repository.startTurn(conversation.id, null);
    await repository.appendEvent({
      conversationId: conversation.id,
      turnId,
      providerSessionId: null,
      turnGroupId: null,
      type: "assistant.final",
      summary: "微台 tick 交易完成",
      payload: { text: "terminal-first ledger" },
    });
    await repository.appendTerminalEvent({
      projectId: project.id,
      terminalId: "b65f930b-a464-4718-841e-5749416248c9",
      type: "terminal.output",
      summary: "微台 tick 交易 log",
      payload: { text: "profit" },
    });
    await repository.addAttachment(
      conversation.id,
      "微台-tick.md",
      "text/markdown",
      join(directory, "微台-tick.md"),
      4,
    );
    await repository.addHandoff(conversation.id, "claude-official", "codex-official", {
      note: "微台 tick 交易 handoff",
    });

    repository.requestSearchIndexSync();
    for (let i = 0; i < 2_000; i += 1) {
      const status = repository.searchIndexStatus();
      if (!status.syncing && !status.dirty) break;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    expect(repository.search({ query: "微台 tick", limit: 20 }).map((item) => item.kind))
      .toEqual(expect.arrayContaining(["project", "event", "terminal", "handoff", "artifact"]));
  });

  it("keeps manual project order independent of latest events and exposes running sessions", async () => {
    const firstProject = await repository.createProject("first", join(directory, "first"));
    const first = await repository.createConversation(firstProject.id, "first", "claude-official");
    const secondProject = await repository.createProject("second", join(directory, "second"));
    await repository.createConversation(secondProject.id, "second", "claude-official");
    database.run("UPDATE projects SET updated_at = '2020-01-01T00:00:00.000Z' WHERE id = $id", { $id: firstProject.id });
    database.run("UPDATE conversations SET updated_at = '2020-01-01T00:00:00.000Z' WHERE id = $id", { $id: first.id });
    const session = await repository.getOrCreateProviderSession(first.id, "claude-official");
    const turnId = await repository.startTurn(first.id, session.id);

    await repository.appendEvent({
      conversationId: first.id,
      turnId,
      providerSessionId: session.id,
      turnGroupId: null,
      type: "user.message",
      summary: "started",
      payload: { text: "hello" },
    });

    expect(repository.listProjects()[0]?.id).toBe(secondProject.id);
    await repository.reorderProjects([firstProject.id, secondProject.id]);
    expect(repository.listProjects().map((project) => project.id)).toEqual([firstProject.id, secondProject.id]);
    expect(repository.listConversations()[0]?.id).toBe(first.id);
    expect(repository.listRunningConversationIds()).toEqual([first.id]);
  });

  it("marks persisted running work interrupted when a new core starts", async () => {
    const project = await repository.createProject("recovery", directory);
    const conversation = await repository.createConversation(project.id, "running", "claude-official");
    const session = await repository.getOrCreateProviderSession(conversation.id, "claude-official");
    await repository.updateProviderSession(session.id, { status: "running" });
    await repository.startTurn(conversation.id, session.id);

    await repository.recoverInterruptedRuns();

    expect(repository.listRunningConversationIds()).toEqual([]);
    expect((await repository.getOrCreateProviderSession(conversation.id, "claude-official")).status)
      .toBe("failed");
  });

  it("defaults legacy conversation summary partial state to false", () => {
    expect(conversationSchema.parse({
      id: "668aa3c2-0eac-40e4-b623-5ed57313278f",
      projectId: "2934a520-a112-4132-8731-05e51e9be9ba",
      name: "Legacy summary", activeProvider: "claude-official", archived: false,
      summary: {
        brief: "brief", longTermGoal: "goal", recentSummary: "recent",
        updatedAt: "2026-06-21T03:00:00.000Z",
      },
      createdAt: "2026-06-21T03:00:00.000Z",
      updatedAt: "2026-06-21T03:00:00.000Z",
    }).summary?.partial).toBe(false);
  });

  it("persists conversation name and summary atomically", async () => {
    const project = await repository.createProject("summary", directory);
    const conversation = await repository.createConversation(
      project.id,
      "Original name",
      "claude-local-main",
    );
    const firstSummary = {
      brief: "Short description",
      longTermGoal: "Ship the project",
      recentSummary: "Storage work is complete",
      updatedAt: "2026-06-21T03:00:00.000Z",
      partial: false,
    };

    await expect(
      repository.saveConversationSummary(conversation.id, "Storage summary", firstSummary),
    ).resolves.toMatchObject({ name: "Storage summary", summary: firstSummary });

    await expect(
      repository.saveConversationSummary(conversation.id, "Must not persist", {
        ...firstSummary,
        updatedAt: "not-a-date",
      }),
    ).rejects.toThrow();
    expect(repository.getConversation(conversation.id)).toMatchObject({
      name: "Storage summary",
      summary: firstSummary,
    });

    const beforePersistFailure = repository.getConversation(conversation.id);

    // node:sqlite durability: COMMIT is the durability point — the on-disk
    // file IS the state, no export/.tmp step that could fail with EISDIR.
    // (The old sql.js persist-failure recovery this test used to exercise is
    // gone with the engine swap, 2026-08-06.)
    database.close();
    database = new AppDatabase(databasePath);
    await database.open();
    repository = new Repository(database);
    expect(repository.getConversation(conversation.id)).toEqual(beforePersistFailure);
  });

  it("rejects operations after close", async () => {
    const project = await repository.createProject("closed", directory);
    database.close();
    expect(() => repository.getProject(project.id)).toThrow("Database is not open");
  });

  it("does not resolve attachment IDs from another conversation", async () => {
    const project = await repository.createProject("attachments", directory);
    const first = await repository.createConversation(project.id, "first", "claude-official");
    const second = await repository.createConversation(project.id, "second", "claude-official");
    const attachment = await repository.addAttachment(
      second.id,
      "private.png",
      "image/png",
      join(directory, "private.png"),
      4,
    );

    expect(() => repository.getAttachmentPaths(first.id, [attachment.id])).toThrow(
      "Attachment selection is invalid",
    );
    expect(() => repository.getAttachmentPaths(second.id, [attachment.id, attachment.id])).toThrow(
      "Attachment selection is invalid",
    );
    expect(() =>
      repository.getAttachmentPaths(second.id, [
        attachment.id,
        "7a9f4879-23fb-4804-9d86-c2cda8863b89",
      ]),
    ).toThrow("Attachment selection is invalid");
    expect(repository.getAttachmentPaths(second.id, [attachment.id])).toEqual([
      join(directory, "private.png"),
    ]);
  });

  it("keeps archived projects and conversations restorable", async () => {
    const project = await repository.createProject("archive", directory);
    const conversation = await repository.createConversation(
      project.id,
      "kept session",
      "codex-official",
    );

    await repository.setProjectArchived(project.id, true);
    expect(repository.listProjects()).toHaveLength(0);
    expect(repository.listConversations()).toHaveLength(0);
    expect(repository.listArchivedProjects()).toMatchObject([{ id: project.id }]);
    expect(repository.listArchivedConversations()).toMatchObject([{ id: conversation.id }]);

    await repository.setProjectArchived(project.id, false);
    await repository.setConversationArchived(conversation.id, true);
    expect(repository.listProjects()).toMatchObject([{ id: project.id }]);
    expect(repository.listConversations()).toHaveLength(0);
    expect(repository.listArchivedConversations()).toMatchObject([
      { id: conversation.id, archived: true },
    ]);
  });

  it("rolls back failed transactions without poisoning the queue", async () => {
    await expect(
      database.transaction(() => {
        database.run(
          "INSERT INTO projects(id, name, workspace_path, pinned, archived, created_at, updated_at) VALUES ('bad', 'bad', 'bad', 0, 0, 'bad', 'bad')",
        );
        throw new Error("stop");
      }),
    ).rejects.toThrow("stop");

    const project = await repository.createProject("after rollback", directory);
    expect(repository.getProject(project.id)?.name).toBe("after rollback");
    expect(database.queryOne("SELECT id FROM projects WHERE id = 'bad'")).toBeNull();
  });

  it("keeps foreign key enforcement enabled after database exports", async () => {
    expect(database.queryOne<{ foreign_keys: number }>("PRAGMA foreign_keys")).toEqual({
      foreign_keys: 1,
    });

    await repository.createProject("foreign keys", directory);

    expect(database.queryOne<{ foreign_keys: number }>("PRAGMA foreign_keys")).toEqual({
      foreign_keys: 1,
    });
  });

  it("allows nested operations to share the outer transaction without deadlocking", async () => {
    await database.transaction(async () => {
      database.run(
        "INSERT INTO projects(id, name, workspace_path, pinned, archived, created_at, updated_at) VALUES ('outer', 'outer', 'outer', 0, 0, 'now', 'now')",
      );
      await database.transaction(() => {
        database.run(
          "INSERT INTO projects(id, name, workspace_path, pinned, archived, created_at, updated_at) VALUES ('inner', 'inner', 'inner', 0, 0, 'now', 'now')",
        );
      });
    });

    expect(database.queryOne("SELECT id FROM projects WHERE id = 'outer'")).not.toBeNull();
    expect(database.queryOne("SELECT id FROM projects WHERE id = 'inner'")).not.toBeNull();
  });

  it("waits for queued transactions before closing the database", async () => {
    let releaseTransaction!: () => void;
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const blocker = new Promise<void>((resolve) => {
      releaseTransaction = resolve;
    });
    const transaction = database.transaction(async () => {
      markStarted();
      await blocker;
      database.run(
        "INSERT INTO projects(id, name, workspace_path, pinned, archived, created_at, updated_at) VALUES ('closing', 'closing', $path, 0, 0, 'now', 'now')",
        { $path: directory },
      );
    });
    await started;

    let closed = false;
    const closing = database.closeWhenIdle().then(() => {
      closed = true;
    });
    await expect(database.transaction(() => undefined)).rejects.toThrow("Database is closing");
    expect(closed).toBe(false);

    releaseTransaction();
    await transaction;
    await closing;

    database = new AppDatabase(databasePath);
    await database.open();
    expect(
      database.queryOne<{ name: string }>("SELECT name FROM projects WHERE id = 'closing'"),
    ).toMatchObject({ name: "closing" });
  });

  it("creates and restores a validated local backup", async () => {
    await repository.createProject("keep", directory);
    const backupPath = join(directory, "backup.sqlite");
    await database.backup(backupPath);
    await repository.createProject("remove after restore", directory);
    expect(repository.listProjects()).toHaveLength(2);

    await database.restore(backupPath);

    expect(repository.listProjects().map((project) => project.name)).toEqual(["keep"]);
  });

  it("deletes attachment rows and returns only redacted recent errors", async () => {
    const project = await repository.createProject("diagnostics", directory);
    const conversation = await repository.createConversation(
      project.id,
      "diagnostics",
      "claude-official",
    );
    const attachment = await repository.addAttachment(
      conversation.id,
      "screen.png",
      "image/png",
      join(directory, "screen.png"),
      128,
    );
    await expect(repository.deleteAttachment(attachment.id)).resolves.toBe(
      join(directory, "screen.png"),
    );
    await expect(repository.deleteAttachment(attachment.id)).resolves.toBeNull();

    const turnId = await repository.startTurn(conversation.id, null);
    await repository.appendEvent({
      conversationId: conversation.id,
      turnId,
      providerSessionId: null,
      turnGroupId: null,
      type: "error",
      summary: "Provider failed.",
      payload: { message: "auth_token=super-secret-value" },
    });

    expect(repository.listRecentErrors()).toEqual([
      expect.stringContaining("[REDACTED]"),
    ]);
    expect(repository.listRecentErrors()[0]).not.toContain("super-secret-value");
  });

  it("prunes old events and terminal_events while preserving conversations", async () => {
    const project = await repository.createProject("prune", directory);
    const conversation = await repository.createConversation(
      project.id,
      "prune convo",
      "claude-official",
    );
    const session = await repository.getOrCreateProviderSession(
      conversation.id,
      "claude-official",
    );
    const turnId = await repository.startTurn(conversation.id, session.id);

    // Insert an old event (20 days ago) and a recent event (now).
    const oldTs = new Date(Date.now() - 20 * 86_400_000).toISOString();
    database.run(
      `INSERT INTO events(id, conversation_id, turn_id, provider_session_id, turn_group_id, type, created_at, sequence, summary, payload_json)
       VALUES ('a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d', ?, ?, NULL, NULL, 'user.message', ?, 0, 'old', '{}')`,
      [conversation.id, turnId, oldTs],
    );
    await repository.appendEvent({
      conversationId: conversation.id,
      turnId,
      providerSessionId: session.id,
      turnGroupId: null,
      type: "assistant.final",
      summary: "recent",
      payload: { text: "recent" },
    });

    // Insert an old terminal event and a recent one.
    database.run(
      `INSERT INTO terminal_events(id, project_id, terminal_id, type, created_at, sequence, summary, payload_json)
       VALUES ('c3d4e5f6-a7b8-4c9d-0e1f-2a3b4c5d6e7f', ?, 'term-1', 'terminal.output', ?, 0, 'old output', '{}')`,
      [project.id, oldTs],
    );
    await repository.appendTerminalEvent({
      projectId: project.id,
      terminalId: "term-1",
      type: "terminal.output",
      summary: "recent output",
      payload: { text: "recent" },
    });

    expect(repository.listEvents(conversation.id)).toHaveLength(2);

    // Prune anything older than 7 days.
    const result = await repository.pruneOldData({ days: 7 });
    expect(result.deletedEvents).toBe(1);
    expect(result.deletedTerminalEvents).toBe(1);

    const remaining = repository.listEvents(conversation.id);
    expect(remaining).toHaveLength(1);
    expect(remaining[0]?.summary).toBe("recent");

    // Conversation and project are untouched.
    expect(repository.getConversation(conversation.id)?.name).toBe("prune convo");
    expect(repository.getProject(project.id)?.name).toBe("prune");
  });

  it("rolls back prune when the transaction fails", async () => {
    const project = await repository.createProject("rollback", directory);
    const conversation = await repository.createConversation(
      project.id,
      "rollback convo",
      "claude-official",
    );
    const session = await repository.getOrCreateProviderSession(
      conversation.id,
      "claude-official",
    );
    const turnId = await repository.startTurn(conversation.id, session.id);
    const oldTs = new Date(Date.now() - 20 * 86_400_000).toISOString();
    database.run(
      `INSERT INTO events(id, conversation_id, turn_id, provider_session_id, turn_group_id, type, created_at, sequence, summary, payload_json)
       VALUES ('b2c3d4e5-f6a7-4b8c-9d0e-1f2a3b4c5d6e', ?, ?, NULL, NULL, 'user.message', ?, 0, 'old', '{}')`,
      [conversation.id, turnId, oldTs],
    );
    expect(repository.listEvents(conversation.id)).toHaveLength(1);

    // Sabotage the transaction by making the terminal_events DELETE fail
    // (terminal_events table still exists, so we drop it to force an error).
    database.run("DROP TABLE terminal_events");

    await expect(repository.pruneOldData({ days: 7 })).rejects.toThrow();
    // The events row should still be there because the transaction rolled back.
    // (Re-create terminal_events so listEvents doesn't fail on unrelated queries.)
    database.run(
      `CREATE TABLE terminal_events(id TEXT PRIMARY KEY, project_id TEXT, terminal_id TEXT, type TEXT, created_at TEXT, sequence INTEGER, summary TEXT, payload_json TEXT)`,
    );
    expect(repository.listEvents(conversation.id)).toHaveLength(1);
  });

  it("defaults retention.pruneOnStart to true on a fresh install", () => {
    expect(repository.getSettings().retention.pruneOnStart).toBe(true);
  });

  it("migration 15 flips an existing retention.pruneOnStart=false row to true", async () => {
    await repository.setSettings({
      ...repository.getSettings(),
      retention: { days: 45, pruneOnStart: false },
    });
    expect(repository.getSettings().retention.pruneOnStart).toBe(false);
    database.run("DELETE FROM schema_migrations WHERE version >= 15");
    await database.persist();
    database.close();

    database = new AppDatabase(databasePath);
    await database.open();
    repository = new Repository(database);

    const migrated = repository.getSettings();
    expect(migrated.retention.pruneOnStart).toBe(true);
    expect(migrated.retention.days).toBe(45);
  });

  it("enforces the terminal_events rolling row cap, keeping the newest rows", async () => {
    const project = await repository.createProject("caps", directory);
    for (let i = 0; i < 30; i++) {
      database.run(
        `INSERT INTO terminal_events(id, project_id, terminal_id, type, created_at, sequence, summary, payload_json)
         VALUES (?, ?, 'term-1', 'terminal.output', ?, ?, ?, '{}')`,
        [
          `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`,
          project.id,
          new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString(),
          i,
          `ev-${i}`,
        ],
      );
    }
    const result = await repository.pruneTerminalEventsOverflow("test", { maxRows: 10 });
    expect(result.deleted).toBe(20);
    expect(result.remainingRows).toBe(10);
    const remaining = repository.listRecentTerminalEvents(project.id, 100);
    expect(remaining).toHaveLength(10);
    expect(remaining[0]?.summary).toBe("ev-20");
    expect(remaining.at(-1)?.summary).toBe("ev-29");
  });

  it("enforces the terminal_events rolling payload cap", async () => {
    const project = await repository.createProject("caps-bytes", directory);
    for (let i = 0; i < 10; i++) {
      const payload = JSON.stringify({ text: `${i}-${"x".repeat(1_000)}` });
      database.run(
        `INSERT INTO terminal_events(id, project_id, terminal_id, type, created_at, sequence, summary, payload_json)
         VALUES (?, ?, 'term-1', 'terminal.output', ?, 0, ?, ?)`,
        [
          `10000000-0000-4000-8000-${String(i).padStart(12, "0")}`,
          project.id,
          new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString(),
          `big-${i}`,
          payload,
        ],
      );
    }
    // Each payload is 1,013 bytes; a 3,100-byte cap keeps the newest 4 rows
    // (4×1013=4052 > cap: the newest row that tips over the cap survives).
    const result = await repository.pruneTerminalEventsOverflow("test", { maxPayloadBytes: 3_100 });
    expect(result.deleted).toBe(6);
    expect(result.remainingRows).toBe(4);
    expect(result.remainingPayloadBytes).toBeGreaterThan(3_100); // one-row overshoot by design
    const remaining = repository.listRecentTerminalEvents(project.id, 100);
    expect(remaining.map((event) => event.summary)).toEqual(["big-6", "big-7", "big-8", "big-9"]);
  });
});

function dropTerminalV8(database: AppDatabase): void {
  database.run("DROP TABLE IF EXISTS terminal_events");
  database.run("ALTER TABLE terminal_panes DROP COLUMN started_at");
  database.run("ALTER TABLE terminal_panes DROP COLUMN closed_at");
  database.run("ALTER TABLE terminal_panes DROP COLUMN last_exit_code");
  database.run("ALTER TABLE terminal_panes DROP COLUMN is_agent");
  database.run("ALTER TABLE terminal_panes DROP COLUMN agent_profile");
}
