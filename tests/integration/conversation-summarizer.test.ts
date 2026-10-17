import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ConversationSummarizer,
  SUMMARY_FRAGMENT_LIMIT,
  SUMMARY_MERGE_INPUT_LIMIT,
  SUMMARY_PROMPT_LIMIT,
  SUMMARY_TIMEOUT_MS,
  SUMMARY_TRANSCRIPT_CHAR_LIMIT,
} from "../../src/main/core/conversation-summarizer";
import { CONVERSATION_SUMMARY_TEXT_LIMIT } from "../../src/main/storage/repository";
import type {
  ProviderAdapter,
  ProviderRunContext,
  ProviderRunResult,
} from "../../src/main/providers/types";
import { AppDatabase } from "../../src/main/storage/database";
import { Repository } from "../../src/main/storage/repository";

const finalJson = JSON.stringify({
  name: "完成摘要功能",
  brief: "完成對話摘要",
  longTermGoal: "提供可持續追蹤的 Coterm 對話",
  recentSummary: "摘要器已完成並驗證",
});

class RecordingAdapter implements ProviderAdapter {
  readonly profiles = ["claude-local-main", "claude-local-long"] as const;
  readonly calls: Array<{ profileId: string; prompt: string }> = [];

  constructor(
    private readonly answer: (context: ProviderRunContext, call: number) => string | Promise<string>,
  ) {}

  async run(context: ProviderRunContext): Promise<ProviderRunResult> {
    this.calls.push({ profileId: context.profileId, prompt: context.prompt });
    return {
      nativeSessionId: null,
      finalText: await this.answer(context, this.calls.length),
    };
  }
}
describe("ConversationSummarizer", () => {
  let directory: string;
  let database: AppDatabase;
  let repository: Repository;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "coterm-summary-"));
    database = new AppDatabase(join(directory, "state.sqlite"));
    await database.open();
    repository = new Repository(database);
  });

  afterEach(async () => {
    await repository.closeSearchIndex();
    database.close();
    await rm(directory, { recursive: true, force: true });
  });

  async function conversationWith(events: Array<{ type: "user.message" | "assistant.final" | "tool.completed"; payload: Record<string, unknown> }>) {
    const project = await repository.createProject("summary", directory);
    const conversation = await repository.createConversation(project.id, "Original", "claude-local-main");
    const turnId = await repository.startTurn(conversation.id, null);
    for (const event of events) {
      await repository.appendEvent({
        conversationId: conversation.id,
        turnId,
        providerSessionId: null,
        turnGroupId: null,
        type: event.type,
        summary: "event metadata must not leak",
        payload: event.payload,
      });
    }
    return conversation;
  }

  it("fits any two accepted fragments in one reduction group", () => {
    expect((SUMMARY_FRAGMENT_LIMIT + 8) * 2).toBeLessThanOrEqual(SUMMARY_MERGE_INPUT_LIMIT);
  });

  it("builds the transcript only from persisted user and final assistant text", async () => {
    const uuid = "123e4567-e89b-12d3-a456-426614174000";
    const apiKey = "sk-abcdefghijklmnop";
    const conversation = await conversationWith([
      { type: "user.message", payload: { text: `USER_ONLY ${apiKey} D:\\private\\inside.txt ${uuid}`, attachments: ["PRIVATE_ATTACHMENT"], env: "SECRET_ENV" } },
      { type: "tool.completed", payload: { text: "PRIVATE_TOOL_OUTPUT", localPath: "C:\\private\\file.txt", sessionId: "secret-session" } },
      { type: "assistant.final", payload: { text: "ASSISTANT_ONLY", sessionId: "secret-session" } },
    ]);
    const adapter = new RecordingAdapter((_context, call) => call === 1 ? "fragment" : finalJson);

    await new ConversationSummarizer(repository, [adapter]).summarize(conversation.id);

    const prompts = adapter.calls.map((call) => call.prompt).join("\n");
    expect(prompts).toContain("USER_ONLY");
    expect(prompts).toContain("ASSISTANT_ONLY");
    expect(prompts).not.toContain("PRIVATE_ATTACHMENT");
    expect(prompts).not.toContain("PRIVATE_TOOL_OUTPUT");
    expect(prompts).not.toContain("SECRET_ENV");
    expect(prompts).not.toContain("secret-session");
    expect(prompts).not.toContain("C:\\private");
    expect(prompts).not.toContain(apiKey);
    expect(prompts).not.toContain(uuid);
  });

  it("redacts drive and UNC paths containing spaces without swallowing surrounding prose", async () => {
    const conversation = await conversationWith([{
      type: "user.message",
      payload: { text: "before D:\\Coterm\\secret.ts after; beforeUNC \\\\server name\\share folder\\report.md afterUNC" },
    }]);
    const adapter = new RecordingAdapter((_context, call) => call === 1 ? "fragment" : finalJson);

    await new ConversationSummarizer(repository, [adapter]).summarize(conversation.id);

    const prompts = adapter.calls.map((call) => call.prompt).join("\n");
    expect(prompts).not.toContain("terminal\\secret.ts");
    expect(prompts).not.toContain("server name\\share folder\\report.md");
    expect(prompts).toContain("before");
    expect(prompts).toContain("afterUNC");
  });

  it("redacts the project root, extensionless paths, and UUIDs with any version nibble", async () => {
    const project = await repository.createProject("private root", "D:\\Coterm");
    const conversation = await repository.createConversation(project.id, "Original", "claude-local-main");
    const turnId = await repository.startTurn(conversation.id, null);
    await repository.appendEvent({
      conversationId: conversation.id, turnId, providerSessionId: null, turnGroupId: null,
      type: "user.message", summary: "message",
      payload: { text: "workspace is d:\\Coterm; drive C:\\Private Folder; remote \\\\server name\\private folder; id 123e4567-e89b-f2d3-a456-426614174000; keep this" },
    });
    const adapter = new RecordingAdapter((_context, call) => call === 1 ? "fragment" : finalJson);

    await new ConversationSummarizer(repository, [adapter]).summarize(conversation.id);

    const prompts = adapter.calls.map((call) => call.prompt).join("\n");
    expect(prompts).not.toContain("TERMINAL");
    expect(prompts).not.toContain("Private Folder");
    expect(prompts).not.toContain("server name\\private folder");
    expect(prompts).not.toContain("123e4567-e89b-f2d3-a456-426614174000");
    expect(prompts).toContain("keep this");
  });

  it("uses deterministic bounded hierarchical prompts for long conversations", async () => {
    const messages = Array.from({ length: 4 }, (_, group) => ({
      type: "user.message" as const,
      payload: { text: Array.from({ length: 20 }, (_, offset) => {
        const index = group * 20 + offset;
        return `${index.toString().padStart(3, "0")}:${"x".repeat(500)}`;
      }).join("\n") },
    }));
    const conversation = await conversationWith(messages);
    const adapter = new RecordingAdapter((context) =>
      context.prompt.includes("FINAL_JSON") ? finalJson : "s".repeat(2_500),
    );

    await new ConversationSummarizer(repository, [adapter]).summarize(conversation.id);

    expect(adapter.calls.length).toBeGreaterThan(10);
    expect(adapter.calls.some((call) => call.prompt.includes("REDUCE_FRAGMENTS"))).toBe(true);
    expect(adapter.calls.every((call) => call.prompt.length <= SUMMARY_PROMPT_LIMIT)).toBe(true);
    const mapPrompts = adapter.calls.filter((call) => call.prompt.includes("MAP_TRANSCRIPT"));
    expect(mapPrompts[0]?.prompt).toContain("000:");
    expect(mapPrompts.at(-1)?.prompt).toContain("079:");
  });

  it("terminates reduction when every fragment is at the accepted size boundary", async () => {
    const conversation = await conversationWith([{ type: "user.message", payload: { text: "x".repeat(13_000) } }]);
    const adapter = new RecordingAdapter((context) =>
      context.prompt.includes("FINAL_JSON") ? finalJson : "s".repeat(SUMMARY_FRAGMENT_LIMIT),
    );

    await expect(new ConversationSummarizer(repository, [adapter]).summarize(conversation.id)).resolves.toBeDefined();
    expect(adapter.calls.some((call) => call.prompt.includes("REDUCE_FRAGMENTS"))).toBe(true);
    expect(adapter.calls.every((call) => call.prompt.length <= SUMMARY_PROMPT_LIMIT)).toBe(true);
  });

  it("includes the latest message when a conversation has more than 2000 events", async () => {
    const project = await repository.createProject("full session", directory);
    const conversation = await repository.createConversation(project.id, "Original", "claude-local-main");
    const turnId = await repository.startTurn(conversation.id, null);
    await database.transaction(async () => {
      for (let index = 0; index < 2_001; index += 1) {
        await repository.appendEvent({
          conversationId: conversation.id,
          turnId,
          providerSessionId: null,
          turnGroupId: null,
          type: "assistant.final",
          summary: "final",
          payload: { text: index === 2_000 ? "LATEST_MESSAGE" : `message-${index}` },
        });
      }
    });
    const adapter = new RecordingAdapter((context) => context.prompt.includes("FINAL_JSON") ? finalJson : "fragment");

    await new ConversationSummarizer(repository, [adapter]).summarize(conversation.id);

    expect(adapter.calls.map((call) => call.prompt).join("\n")).toContain("LATEST_MESSAGE");
  });

  it("caps transcript memory while preserving the earliest and latest context", async () => {
    const project = await repository.createProject("bounded", directory);
    const conversation = await repository.createConversation(project.id, "Original", "claude-local-main");
    const turnId = await repository.startTurn(conversation.id, null);
    await database.transaction(async () => {
      for (let index = 0; index < 30; index += 1) {
        const marker = index === 0 ? "EARLIEST_CONTEXT" : index === 29 ? "LATEST_CONTEXT" : `MIDDLE_${index}`;
        await repository.appendEvent({
          conversationId: conversation.id, turnId, providerSessionId: null, turnGroupId: null,
          type: "user.message", summary: "message",
          payload: { text: `${marker}:${"x".repeat(CONVERSATION_SUMMARY_TEXT_LIMIT)}PER_TEXT_TAIL` },
        });
      }
    });
    const adapter = new RecordingAdapter((context) => context.prompt.includes("FINAL_JSON") ? finalJson : "fragment");

    await new ConversationSummarizer(repository, [adapter]).summarize(conversation.id);

    const mapped = adapter.calls.filter((call) => call.prompt.includes("MAP_TRANSCRIPT")).map((call) =>
      call.prompt.match(/<conversation>\n([\s\S]*)\n<\/conversation>/)?.[1] ?? "",
    ).join("");
    expect(mapped.length).toBeLessThanOrEqual(SUMMARY_TRANSCRIPT_CHAR_LIMIT);
    expect(mapped).toContain("EARLIEST_CONTEXT");
    expect(mapped).toContain("LATEST_CONTEXT");
    expect(mapped).toContain("omitted");
    expect(mapped).not.toContain("PER_TEXT_TAIL");
  });

  it("marks a summary partial when one message exceeds the per-event cap", async () => {
    const conversation = await conversationWith([{
      type: "user.message",
      payload: { text: "x".repeat(CONVERSATION_SUMMARY_TEXT_LIMIT + 10_000) },
    }]);
    const adapter = new RecordingAdapter((context) => context.prompt.includes("FINAL_JSON") ? finalJson : "fragment");

    const result = await new ConversationSummarizer(repository, [adapter]).summarize(conversation.id);

    expect(result.summary?.partial).toBe(true);
    expect(adapter.calls.map((call) => call.prompt).join("\n")).toContain("omitted");
  });

  it("switches permanently to qwen after the first glm failure", async () => {
    const conversation = await conversationWith([{ type: "user.message", payload: { text: "A".repeat(20_000) } }]);
    const adapter = new RecordingAdapter((context) => {
      if (context.profileId === "claude-local-main") throw new Error("offline");
      return context.prompt.includes("FINAL_JSON") ? finalJson : "qwen fragment";
    });

    await new ConversationSummarizer(repository, [adapter]).summarize(conversation.id);

    expect(adapter.calls[0]?.profileId).toBe("claude-local-main");
    expect(adapter.calls.slice(1).every((call) => call.profileId === "claude-local-long")).toBe(true);
  });

  it("times out stalled glm, falls back to qwen, and releases the job lock", async () => {
    const timeout = immediateAbortTimeout();
    try {
      const conversation = await conversationWith([{ type: "user.message", payload: { text: "timeout" } }]);
      const adapter = new RecordingAdapter((context) => {
        if (context.profileId === "claude-local-main") return rejectWhenAborted(context.signal);
        return context.prompt.includes("FINAL_JSON") ? finalJson : "qwen fragment";
      });
      const summarizer = new ConversationSummarizer(repository, [adapter]);

      const first = summarizer.summarize(conversation.id);
      await expect(first).resolves.toBeDefined();
      await expect(summarizer.summarize(conversation.id)).resolves.toBeDefined();
      expect(timeout).toHaveBeenCalledWith(SUMMARY_TIMEOUT_MS);
    } finally {
      timeout.mockRestore();
    }
  });

  it("rejects a stalled qwen run and releases the job lock", async () => {
    const timeout = immediateAbortTimeout();
    try {
      const conversation = await conversationWith([{ type: "user.message", payload: { text: "timeout" } }]);
      let stallQwen = true;
      const adapter = new RecordingAdapter((context) => {
        if (context.profileId === "claude-local-main") throw new Error("offline");
        if (stallQwen) return rejectWhenAborted(context.signal);
        return context.prompt.includes("FINAL_JSON") ? finalJson : "qwen fragment";
      });
      const summarizer = new ConversationSummarizer(repository, [adapter]);

      const first = summarizer.summarize(conversation.id);
      await expect(first).rejects.toThrow();
      stallQwen = false;
      await expect(summarizer.summarize(conversation.id)).resolves.toBeDefined();
      expect(timeout).toHaveBeenCalledWith(SUMMARY_TIMEOUT_MS);
    } finally {
      timeout.mockRestore();
    }
  });

  it("rejects invalid final output and preserves the previous summary", async () => {
    const conversation = await conversationWith([{ type: "user.message", payload: { text: "summarize me" } }]);
    const oldSummary = {
      brief: "old brief",
      longTermGoal: "old goal",
      recentSummary: "old recent",
      updatedAt: "2026-06-21T01:00:00.000Z",
      partial: false,
    };
    await repository.saveConversationSummary(conversation.id, "Old name", oldSummary);
    const adapter = new RecordingAdapter((context) =>
      context.prompt.includes("FINAL_JSON") ? "not json" : "fragment",
    );

    await expect(new ConversationSummarizer(repository, [adapter]).summarize(conversation.id))
      .rejects.toThrow("valid summary JSON");
    expect(repository.getConversation(conversation.id)).toMatchObject({ name: "Old name", summary: oldSummary });
    expect(adapter.calls.map((call) => call.profileId)).toContain("claude-local-long");
  });

  it("rejects a duplicate in-flight job for the same conversation", async () => {
    const conversation = await conversationWith([{ type: "user.message", payload: { text: "summarize me" } }]);
    let release!: (value: string) => void;
    const pending = new Promise<string>((resolve) => { release = resolve; });
    const adapter = new RecordingAdapter((context) => context.prompt.includes("FINAL_JSON") ? finalJson : pending);
    const summarizer = new ConversationSummarizer(repository, [adapter]);

    const first = summarizer.summarize(conversation.id);
    await expect(summarizer.summarize(conversation.id)).rejects.toThrow("already in progress");
    release("fragment");
    await first;
  });

  it("uses the completion time only after a successful save", async () => {
    const conversation = await conversationWith([{ type: "user.message", payload: { text: "summarize me" } }]);
    const adapter = new RecordingAdapter((context) => context.prompt.includes("FINAL_JSON") ? finalJson : "fragment");
    const completion = new Date("2026-06-21T08:09:10.000Z");

    const result = await new ConversationSummarizer(repository, [adapter], () => completion).summarize(conversation.id);

    expect(result.summary?.updatedAt).toBe(completion.toISOString());
    expect(result.summary?.partial).toBe(false);
  });

  it("batch summarizes only sessions changed since their last summary", async () => {
    const conversation = await conversationWith([{
      type: "user.message",
      payload: { text: "first activity" },
    }]);
    const adapter = new RecordingAdapter((context) =>
      context.prompt.includes("FINAL_JSON") ? finalJson : "fragment",
    );
    const summarizer = new ConversationSummarizer(repository, [adapter]);
    database.run("UPDATE turns SET status = 'completed'");

    await expect(summarizer.summarizeStale()).resolves.toEqual({ summarized: 1, skipped: 0, failed: 0 });
    await expect(summarizer.summarizeStale()).resolves.toEqual({ summarized: 0, skipped: 1, failed: 0 });
    const turnId = await repository.startTurn(conversation.id, null);
    await repository.appendEvent({
      conversationId: conversation.id, turnId, providerSessionId: null, turnGroupId: null,
      type: "user.message", summary: "new", payload: { text: "new activity" },
    });
    await repository.completeTurn(turnId, "completed");
    await expect(summarizer.summarizeStale()).resolves.toEqual({ summarized: 1, skipped: 0, failed: 0 });
  });
});

function rejectWhenAborted(signal: AbortSignal): Promise<string> {
  return new Promise((_resolve, reject) => {
    signal.addEventListener("abort", () => reject(new Error("timed out")), { once: true });
  });
}
function immediateAbortTimeout() {
  return vi.spyOn(AbortSignal, "timeout").mockImplementation(() => {
    const controller = new AbortController();
    queueMicrotask(() => controller.abort());
    return controller.signal;
  });
}
