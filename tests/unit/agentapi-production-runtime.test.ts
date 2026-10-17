import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildAgentApiImplementerCommand } from "../../src/main/providers/agent-launch";
import { boundedGitDiff, AgentApiProductionRuntime } from "../../src/main/core/agentapi-production-runtime";
import type { AgentApiWorkflow } from "../../src/shared/types";

describe("AgentApi production runtime security helpers", () => {
  const cleanup: string[] = [];
  afterEach(async () => {
    await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true })));
  });

  it("pins the first Claude turn to a UUID and corrections to --resume", () => {
    const sessionId = "11111111-1111-4111-8111-111111111111";
    const first = buildAgentApiImplementerCommand({
      cwd: "D:\\safe worktree",
      prompt: "implement 'quoted' task",
      sessionId,
      proxyUrl: "http://127.0.0.1:8787",
      resume: false,
    });
    const correction = buildAgentApiImplementerCommand({
      cwd: "D:\\safe worktree",
      prompt: "fix review",
      sessionId,
      proxyUrl: "http://127.0.0.1:8787",
      resume: true,
    });
    expect(first).toContain(`--session-id '${sessionId}'`);
    expect(first).not.toContain("--resume");
    expect(first).not.toContain("dangerously-skip-permissions");
    expect(correction).toContain(`--resume '${sessionId}'`);
    expect(correction).not.toContain("--session-id");
    expect(first).toContain("implement ''quoted'' task");
    expect(() => buildAgentApiImplementerCommand({
      cwd: "D:\\safe",
      prompt: "task",
      sessionId: "missing-stable-id",
      proxyUrl: "http://127.0.0.1:8787",
      resume: false,
    })).toThrow("stable UUID");
  });

  it("collects bounded no-color committed, staged, unstaged, and untracked context", async () => {
    const directory = await mkdtemp(join(tmpdir(), "coterm-review-diff-"));
    cleanup.push(directory);
    await git(["init", "-b", "main"], directory);
    await git(["config", "user.email", "test@example.com"], directory);
    await git(["config", "user.name", "Test"], directory);
    await writeFile(join(directory, "tracked.txt"), "base\n", "utf8");
    await git(["add", "tracked.txt"], directory);
    await git(["commit", "-m", "base"], directory);
    await writeFile(join(directory, "tracked.txt"), "base\nunstaged\n", "utf8");
    await writeFile(join(directory, "staged.txt"), "staged\n", "utf8");
    await git(["add", "staged.txt"], directory);
    await writeFile(join(directory, "untracked.txt"), "untracked\n", "utf8");

    const diff = await boundedGitDiff(directory, "HEAD");
    expect(diff).toContain("## unstaged");
    expect(diff).toContain("+unstaged");
    expect(diff).toContain("## staged");
    expect(diff).toContain("staged.txt");
    expect(diff).toContain("?? untracked.txt");
    expect(diff).not.toMatch(/\x1b\[/);
    expect(diff.length).toBeLessThanOrEqual(40_100);
  });

  it("subscribes to the correction running edge before writing the resume command", async () => {
    const order: string[] = [];
    const worktreeId = "33333333-3333-4333-8333-333333333333";
    const terminalId = "44444444-4444-4444-8444-444444444444";
    const runtime = new AgentApiProductionRuntime({
      repository: {
        getSettings: () => ({ proxyUrl: "http://127.0.0.1:8787" }),
      } as never,
      operations: {
        writeTerminal: (input: { data: string }) => {
          order.push("write");
          expect(input.data).toContain("--resume '11111111-1111-4111-8111-111111111111'");
        },
      } as never,
      worktrees: {
        get: () => ({ id: worktreeId, status: "active", worktreePath: "D:\\safe-worktree" }),
      } as never,
      waits: {
        waitFor: async () => {
          order.push("wait");
          return {
            sessionId: terminalId,
            targetState: "running",
            state: "running",
            outcome: "matched",
            observedAt: "2026-07-20T00:00:00.000Z",
          };
        },
      } as never,
      handoffs: {} as never,
      reviewer: {} as never,
    });
    const result = await runtime.dispatchCorrection(workflow(worktreeId, terminalId), changesReview(), "step", new AbortController().signal);
    expect(order).toEqual(["wait", "write"]);
    expect(result).toMatchObject({ outcome: "matched", state: "running" });
  });

  it("does not send an implementation prompt when cancel wins the openTile race", async () => {
    const worktreeId = "33333333-3333-4333-8333-333333333333";
    const terminalId = "44444444-4444-4444-8444-444444444444";
    let releaseOpen!: (layout: { selectedTerminalId: string }) => void;
    const openGate = new Promise<{ selectedTerminalId: string }>((resolve) => { releaseOpen = resolve; });
    const writeTerminal = vi.fn();
    const setTerminalNativeSessionId = vi.fn(async () => undefined);
    const openTile = vi.fn(() => openGate);
    const runtime = new AgentApiProductionRuntime({
      repository: { getSettings: () => ({ proxyUrl: "http://127.0.0.1:8787" }) } as never,
      operations: { openTile, writeTerminal, setTerminalNativeSessionId } as never,
      worktrees: {
        create: async () => ({ id: worktreeId, worktreePath: "D:\\safe-worktree" }),
      } as never,
      waits: {} as never,
      handoffs: {} as never,
      reviewer: {} as never,
    });
    const controller = new AbortController();
    const dispatch = runtime.prepareAndDispatchImplementation(
      workflow(worktreeId, terminalId),
      "dispatch",
      controller.signal,
    );
    await vi.waitFor(() => expect(openTile).toHaveBeenCalledOnce());
    controller.abort();
    releaseOpen({ selectedTerminalId: terminalId });

    await expect(dispatch).rejects.toThrow("canceled after terminal creation");
    expect(setTerminalNativeSessionId).not.toHaveBeenCalled();
    expect(writeTerminal).not.toHaveBeenCalled();
  });

  it("bounds a stuck read-only reviewer with one job deadline", async () => {
    const worktreeId = "33333333-3333-4333-8333-333333333333";
    const terminalId = "44444444-4444-4444-8444-444444444444";
    const workspacePath = process.cwd();
    const reviewer = {
      run: vi.fn((context: { signal: AbortSignal }) => new Promise((_resolve, reject) => {
        context.signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      })),
    };
    const runtime = new AgentApiProductionRuntime({
      repository: { getSettings: () => ({ proxyUrl: "http://127.0.0.1:8787" }) } as never,
      operations: {} as never,
      worktrees: {
        get: () => ({ id: worktreeId, status: "active", worktreePath: workspacePath, baseRef: "HEAD" }),
      } as never,
      waits: {} as never,
      handoffs: {} as never,
      reviewer: reviewer as never,
      reviewTimeoutMs: 200,
      gitDiff: async () => "(no diff)",
    });

    await expect(runtime.runReadOnlyReview(
      workflow(worktreeId, terminalId, workspacePath),
      { handoffId: "77777777-7777-4777-8777-777777777777", packet: {} as never, formattedPrompt: "handoff" },
      "review",
      new AbortController().signal,
    )).rejects.toThrow("Read-only reviewer timed out");
    expect(reviewer.run).toHaveBeenCalledOnce();
  });
});

function git(args: string[], cwd: string): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile("git", args, { cwd, windowsHide: true }, (error) => error ? reject(error) : resolve());
  });
}

function workflow(worktreeId: string, terminalId: string, worktreePath = "D:\\safe-worktree"): AgentApiWorkflow {
  return {
    id: "55555555-5555-4555-8555-555555555555",
    projectId: "66666666-6666-4666-8666-666666666666",
    task: "task",
    idempotencyKey: "key",
    branch: null,
    baseRef: null,
    implementer: "claude-local-main",
    reviewer: "codex-local-main",
    state: "changes_requested",
    resumeState: null,
    reviewLoop: 1,
    worktreeId,
    worktreePath,
    terminalId,
    sessionId: "11111111-1111-4111-8111-111111111111",
    handoffId: "77777777-7777-4777-8777-777777777777",
    lastOutcome: null,
    revision: 1,
    createdAt: "2026-07-20T00:00:00.000Z",
    updatedAt: "2026-07-20T00:00:00.000Z",
    startedAt: "2026-07-20T00:00:00.000Z",
    completedAt: null,
  };
}

function changesReview() {
  return {
    verdict: "changes_requested" as const,
    summary: "fix",
    findings: [{ severity: "major" as const, message: "guard" }],
    verification: [],
  };
}
