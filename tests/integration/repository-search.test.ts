import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AppDatabase } from "../../src/main/storage/database";
import { Repository } from "../../src/main/storage/repository";

async function waitForSearchIndex(repository: Repository, timeoutMs = 10_000): Promise<void> {
  repository.requestSearchIndexSync();
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const status = repository.searchIndexStatus();
    if (!status.syncing && !status.dirty) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("Search index did not become ready before timeout.");
}

describe("Repository global search (FTS5 trigram)", () => {
  let directory: string;
  let database: AppDatabase;
  let repository: Repository;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "coterm-search-"));
    database = new AppDatabase(join(directory, "state.sqlite"));
    await database.open();
    repository = new Repository(database);
  });

  afterEach(async () => {
    await repository.closeSearchIndex();
    database.close();
    await rm(directory, { recursive: true, force: true });
  });

  it("does not start the search worker before search is activated", async () => {
    await repository.createProject("lazy search", directory);

    expect(repository.searchIndexStatus()).toEqual({ syncing: false, dirty: true });
    repository.requestSearchIndexSync();
    expect(repository.searchIndexStatus().syncing).toBe(true);
  });

  // The pre-FTS implementation scanned only the newest 2000 events, so an
  // older match was unfindable. Seed >2000 events and search a marker planted
  // in the very first one.
  it("finds the first event after more than 2000 events exist", async () => {
    const project = await repository.createProject("專案", directory);
    const conversation = await repository.createConversation(project.id, "對話", "claude-official");
    const session = await repository.getOrCreateProviderSession(conversation.id, "claude-official");
    const turnId = await repository.startTurn(conversation.id, session.id);

    let firstEventId = "";
    await database.transaction(async () => {
      for (let index = 0; index < 2100; index++) {
        const event = await repository.appendEvent({
          conversationId: conversation.id,
          turnId,
          providerSessionId: session.id,
          turnGroupId: null,
          type: "assistant.progress",
          summary: index === 0 ? "seed-甲乙丙 marker in the oldest event" : `routine event ${index}`,
          payload: { index },
        });
        if (index === 0) firstEventId = event.id;
      }
    });

    const count = database.queryOne<{ n: number }>("SELECT COUNT(*) AS n FROM events");
    expect(count?.n).toBeGreaterThan(2000);

    await waitForSearchIndex(repository);
    const hits = repository.search({ query: "seed-甲乙丙", limit: 50 });
    expect(hits.map((hit) => hit.id)).toContain(firstEventId);
    expect(hits.find((hit) => hit.id === firstEventId)?.kind).toBe("event");
  }, 30_000);

  it("ANDs multiple keywords, including CJK and mixed case", async () => {
    const project = await repository.createProject("專案", directory);
    const conversation = await repository.createConversation(project.id, "對話", "claude-official");
    const session = await repository.getOrCreateProviderSession(conversation.id, "claude-official");
    const turnId = await repository.startTurn(conversation.id, session.id);
    const append = (summary: string) =>
      repository.appendEvent({
        conversationId: conversation.id,
        turnId,
        providerSessionId: session.id,
        turnGroupId: null,
        type: "assistant.progress",
        summary,
        payload: {},
      });

    const both = await append("台北市 Weather 天氣預報 良好");
    const onlyFirst = await append("台北市 只有這個");
    const onlySecond = await append("天氣預報 只有這個");
    await waitForSearchIndex(repository);

    // Both terms >= 3 codepoints → trigram MATCH path, case-insensitive.
    const ftsHits = repository.search({ query: "台北市 weather", limit: 50 });
    expect(ftsHits.map((hit) => hit.id)).toEqual([both.id]);

    const cjkHits = repository.search({ query: "台北市 天氣預報", limit: 50 });
    expect(cjkHits.map((hit) => hit.id)).toEqual([both.id]);

    // A <3-codepoint term forces the LIKE fallback; AND semantics must hold.
    const shortHits = repository.search({ query: "北市 天氣預報", limit: 50 });
    expect(shortHits.map((hit) => hit.id)).toEqual([both.id]);
    expect(shortHits.map((hit) => hit.id)).not.toContain(onlyFirst.id);
    expect(shortHits.map((hit) => hit.id)).not.toContain(onlySecond.id);
  });

  it("covers handoffs, artifacts, and terminal events", async () => {
    const project = await repository.createProject("專案", directory);
    const conversation = await repository.createConversation(project.id, "對話", "claude-official");

    await repository.addHandoff(conversation.id, "claude-local-main", "codex-local-main", {
      title: "交接 rabbit-hole 計畫",
    });
    const attachment = await repository.addAttachment(
      conversation.id,
      "週報-quarterly.txt",
      "text/plain",
      join(directory, "週報-quarterly.txt"),
      10,
    );
    const terminalEvent = await repository.appendTerminalEvent({
      projectId: project.id,
      terminalId: "term-1",
      type: "terminal.output",
      summary: "編譯 finished successfully",
    });
    await waitForSearchIndex(repository);

    const handoffHits = repository.search({ query: "rabbit-hole", limit: 50 });
    expect(handoffHits.map((hit) => hit.kind)).toContain("handoff");

    const artifactHits = repository.search({ query: "quarterly", limit: 50 });
    expect(artifactHits.map((hit) => hit.id)).toContain(attachment.id);

    const terminalHits = repository.search({ query: "編譯 finished", limit: 50 });
    expect(terminalHits.map((hit) => hit.id)).toContain(terminalEvent.id);
  });

  it("returns the last completed snapshot while a dirty refresh is pending", async () => {
    const project = await repository.createProject("背景索引", directory);

    // Query hot path does not synchronously rebuild the sidecar.
    expect(repository.search({ query: "背景索引", limit: 20 })).toEqual([]);
    expect(repository.searchIndexStatus().syncing || repository.searchIndexStatus().dirty).toBe(true);

    await waitForSearchIndex(repository);
    expect(repository.search({ query: "背景索引", limit: 20 }).map((hit) => hit.id)).toContain(project.id);
  });

  it("keeps the main event loop responsive while rebuilding the search sidecar", async () => {
    const project = await repository.createProject("event-loop-budget", directory);
    const conversation = await repository.createConversation(project.id, "background worker", "claude-official");
    const session = await repository.getOrCreateProviderSession(conversation.id, "claude-official");
    const turnId = await repository.startTurn(conversation.id, session.id);
    await database.transaction(async () => {
      for (let index = 0; index < 3_000; index++) {
        await repository.appendEvent({
          conversationId: conversation.id,
          turnId,
          providerSessionId: session.id,
          turnGroupId: null,
          type: "assistant.progress",
          summary: `worker budget row ${index}`,
          payload: { index },
        });
      }
    });

    repository.requestSearchIndexSync();
    const started = performance.now();
    await new Promise<void>((resolve) => setTimeout(resolve, 25));
    // A main-thread SQLite rebuild delays this timer by the full rebuild. The
    // worker implementation leaves enough margin for loaded Windows CI while
    // still detecting the old synchronous setTimeout(syncSearchIndex) path.
    expect(performance.now() - started).toBeLessThan(250);
    expect(repository.searchIndexStatus().syncing || repository.searchIndexStatus().dirty).toBe(true);
    await waitForSearchIndex(repository);
  }, 30_000);

  it("skips the ledger sidecar entirely when searchIndexEnabled is off", async () => {
    const project = await repository.createProject("search-switch-off", directory);

    await repository.updateSettings({ searchIndexEnabled: false });
    repository.requestSearchIndexSync();
    const status = repository.searchIndexStatus();
    expect(status.syncing).toBe(false);
    expect(status.dirty).toBe(false);
    expect(repository.search({ query: "search-switch-off", limit: 20 })).toEqual([]);

    await repository.updateSettings({ searchIndexEnabled: true });
    await waitForSearchIndex(repository);
    expect(repository.search({ query: "search-switch-off", limit: 20 }).map((hit) => hit.id)).toContain(project.id);
  }, 30_000);
});
