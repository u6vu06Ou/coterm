import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AppEventBus } from "../../src/main/core/event-bus";
import { CouncilScheduler } from "../../src/main/providers/council-scheduler";
import type {
  ProviderAdapter,
  ProviderRunContext,
  ProviderRunResult,
} from "../../src/main/providers/types";
import { AppDatabase } from "../../src/main/storage/database";
import { Repository } from "../../src/main/storage/repository";

class FakeCouncilProvider implements Pick<ProviderAdapter, "run"> {
  run(context: ProviderRunContext): Promise<ProviderRunResult> {
    if (context.prompt.includes("Independently analyze")) {
      return Promise.resolve({
        nativeSessionId: null,
        finalText: `Independent answer from ${context.profileId}`,
      });
    }
    if (context.prompt.includes("Return only valid JSON")) {
      // Reviewers only receive peer answers (their own is excluded). Return
      // rankings for exactly the labels present in the prompt.
      const labels = [...context.prompt.matchAll(/<ANSWER label="([A-Z])">/g)].map(
        (match) => match[1]!,
      );
      const scoreByLabel: Record<string, { score: number; reason: string }> = {
        A: { score: 8, reason: "sound" },
        B: { score: 7, reason: "useful" },
        C: { score: 9, reason: "strongest" },
      };
      return Promise.resolve({
        nativeSessionId: null,
        finalText: JSON.stringify({
          rankings: labels.map((label) => ({ label, ...scoreByLabel[label] })),
        }),
      });
    }
    return Promise.resolve({
      nativeSessionId: null,
      finalText: "主席結論：採用可驗證、可回滾的方案。",
    });
  }
}

class DegradedCouncilProvider extends FakeCouncilProvider {
  override run(context: ProviderRunContext): Promise<ProviderRunResult> {
    if (
      context.profileId === "claude-local-freeform" &&
      context.prompt.includes("Independently analyze")
    ) {
      return Promise.reject(new Error("ANTHROPIC_AUTH_TOKEN=super-secret-value"));
    }
    return super.run(context);
  }
}

class FencedRankingProvider extends FakeCouncilProvider {
  override run(context: ProviderRunContext): Promise<ProviderRunResult> {
    if (context.prompt.includes("Return only valid JSON")) {
      const labels = [...context.prompt.matchAll(/<ANSWER label="([A-Z])">/g)].map(
        (match) => match[1]!,
      );
      const scoreByLabel: Record<string, { score: number; reason: string }> = {
        A: { score: 8, reason: "sound" },
        B: { score: 7, reason: "useful" },
        C: { score: 9, reason: "strongest" },
      };
      return Promise.resolve({
        nativeSessionId: null,
        finalText: `Review complete.
\`\`\`json
${JSON.stringify({
  rankings: labels.map((label) => ({ label, ...scoreByLabel[label] })),
})}
\`\`\``,
      });
    }
    return super.run(context);
  }
}

class IncompleteRankingProvider extends FakeCouncilProvider {
  override run(context: ProviderRunContext): Promise<ProviderRunResult> {
    if (context.prompt.includes("Return only valid JSON")) {
      return Promise.resolve({
        nativeSessionId: null,
        finalText: JSON.stringify({
          rankings: [{ label: "A", score: 8, reason: "incomplete" }],
        }),
      });
    }
    return super.run(context);
  }
}

class BlockingCouncilProvider implements Pick<ProviderAdapter, "run"> {
  run(context: ProviderRunContext): Promise<ProviderRunResult> {
    if (context.signal.aborted) return Promise.reject(new Error("cancelled"));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => resolve({ nativeSessionId: null, finalText: "late" }),
        10_000,
      );
      context.signal.addEventListener(
        "abort",
        () => {
          clearTimeout(timer);
          reject(new Error("cancelled"));
        },
        { once: true },
      );
    });
  }
}

class ChairmanFailureProvider extends FakeCouncilProvider {
  override run(context: ProviderRunContext): Promise<ProviderRunResult> {
    if (context.prompt.includes("You are the chairman")) {
      return Promise.reject(new Error("chairman unavailable"));
    }
    return super.run(context);
  }
}

describe("CouncilScheduler", () => {
  let directory: string;
  let database: AppDatabase;
  let repository: Repository;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "ai-terminal-council-"));
    database = new AppDatabase(join(directory, "state.sqlite"));
    await database.open();
    repository = new Repository(database);
  });

  afterEach(async () => {
    database.close();
    // Windows releases sqlite/member-run file handles a tick after close();
    // without retries the rmdir races them and flakes ENOTEMPTY (#32).
    await rm(directory, { recursive: true, force: true, maxRetries: 8, retryDelay: 150 });
  });

  it("runs three opinions, anonymous scoring, and chairman synthesis", async () => {
    const project = await repository.createProject("Council", directory);
    const conversation = await repository.createConversation(
      project.id,
      "Review",
      "claude-local-main",
    );
    const scheduler = new CouncilScheduler(
      repository,
      new AppEventBus(),
      new FakeCouncilProvider(),
    );

    const run = await scheduler.start(
      {
        conversationId: conversation.id,
        question: "Choose a safe architecture.",
        chairman: "glm",
        executeWith: null,
      },
      directory,
    );

    await vi.waitFor(
      () => {
        expect(
          repository
            .listEvents(conversation.id)
            .some((event) => event.type === "assistant.final"),
        ).toBe(true);
      },
      { timeout: 5_000, interval: 20 },
    );

    const events = repository.listEvents(conversation.id);
    expect(events.filter((event) => event.type === "council.member.completed")).toHaveLength(3);
    expect(events.filter((event) => event.type === "council.review.completed")).toHaveLength(3);
    expect(events.at(-1)?.turnId).toBe(run.turnId);
    expect(
      events.find((event) => event.type === "assistant.final")?.payload.text,
    ).toContain("主席結論");

    const group = database.queryOne<{ status: string }>(
      "SELECT status FROM turn_groups WHERE id = $id",
      { $id: run.turnGroupId },
    );
    const scores = database.queryAll<{ score: number }>(
      "SELECT score FROM turn_group_members WHERE turn_group_id = $id ORDER BY anonymous_label",
      { $id: run.turnGroupId },
    );
    expect(group?.status).toBe("completed");
    expect(scores.map((row) => row.score)).toEqual([8, 7, 9]);
  });

  it("cancels all active member runs", async () => {
    const { conversation, scheduler } = await createCouncil(
      repository,
      directory,
      new BlockingCouncilProvider(),
    );
    const run = await scheduler.start(councilInput(conversation.id), directory);

    scheduler.cancel(run.turnGroupId);
    await waitForEvent(repository, conversation.id, "council.cancelled");

    expect(
      database.queryOne<{ status: string }>(
        "SELECT status FROM turn_groups WHERE id = $id",
        { $id: run.turnGroupId },
      )?.status,
    ).toBe("cancelled");
  });

  it("completes in degraded mode when one member fails", async () => {
    const { conversation, scheduler } = await createCouncil(
      repository,
      directory,
      new DegradedCouncilProvider(),
    );
    const run = await scheduler.start(councilInput(conversation.id), directory);

    await waitForEvent(repository, conversation.id, "assistant.final");

    expect(
      database.queryOne<{ status: string }>(
        "SELECT status FROM turn_groups WHERE id = $id",
        { $id: run.turnGroupId },
      )?.status,
    ).toBe("degraded");
    expect(
      repository
        .listEvents(conversation.id)
        .some((event) => event.type === "council.degraded"),
    ).toBe(true);
    const warning = repository
      .listEvents(conversation.id)
      .find((event) => event.type === "warning");
    expect(warning?.payload.error).toContain("[REDACTED]");
    expect(warning?.payload.error).not.toContain("super-secret-value");
  });

  it("accepts a complete rankings object inside a fenced response", async () => {
    const { conversation, scheduler } = await createCouncil(
      repository,
      directory,
      new FencedRankingProvider(),
    );
    const run = await scheduler.start(councilInput(conversation.id), directory);

    await waitForEvent(repository, conversation.id, "assistant.final");

    expect(
      database
        .queryAll<{ score: number }>(
          "SELECT score FROM turn_group_members WHERE turn_group_id = $id ORDER BY anonymous_label",
          { $id: run.turnGroupId },
        )
        .map((row) => row.score),
    ).toEqual([8, 7, 9]);
  });

  it("rejects incomplete rankings without turning missing scores into zeroes", async () => {
    const { conversation, scheduler } = await createCouncil(
      repository,
      directory,
      new IncompleteRankingProvider(),
    );
    const run = await scheduler.start(councilInput(conversation.id), directory);

    await waitForEvent(repository, conversation.id, "assistant.final");

    expect(
      database.queryOne<{ status: string }>(
        "SELECT status FROM turn_groups WHERE id = $id",
        { $id: run.turnGroupId },
      )?.status,
    ).toBe("degraded");
    expect(
      database
        .queryAll<{ score: number | null }>(
          "SELECT score FROM turn_group_members WHERE turn_group_id = $id ORDER BY anonymous_label",
          { $id: run.turnGroupId },
        )
        .map((row) => row.score),
    ).toEqual([null, null, null]);
  });

  it("records a failed turn when chairman synthesis fails", async () => {
    const { conversation, scheduler } = await createCouncil(
      repository,
      directory,
      new ChairmanFailureProvider(),
    );
    const run = await scheduler.start(councilInput(conversation.id), directory);

    await waitForEvent(repository, conversation.id, "error");

    expect(
      database.queryOne<{ status: string }>(
        "SELECT status FROM turn_groups WHERE id = $id",
        { $id: run.turnGroupId },
      )?.status,
    ).toBe("failed");
  });
});

function councilInput(conversationId: string) {
  return {
    conversationId,
    question: "Choose a safe architecture.",
    chairman: "glm" as const,
    executeWith: null,
  };
}

async function createCouncil(
  repository: Repository,
  directory: string,
  provider: Pick<ProviderAdapter, "run">,
) {
  const project = await repository.createProject(`Council-${crypto.randomUUID()}`, directory);
  const conversation = await repository.createConversation(
    project.id,
    "Review",
    "claude-local-main",
  );
  return {
    conversation,
    scheduler: new CouncilScheduler(repository, new AppEventBus(), provider),
  };
}

async function waitForEvent(
  repository: Repository,
  conversationId: string,
  type: Parameters<Repository["appendEvent"]>[0]["type"],
): Promise<void> {
  await vi.waitFor(
    () => {
      expect(repository.listEvents(conversationId).some((event) => event.type === type)).toBe(true);
    },
    { timeout: 5_000, interval: 20 },
  );
}
