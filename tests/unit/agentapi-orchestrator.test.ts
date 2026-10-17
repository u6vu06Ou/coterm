import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AppDatabase } from "../../src/main/storage/database";
import { Repository } from "../../src/main/storage/repository";
import {
  AgentApiConflictError,
  AgentApiOrchestrator,
  type AgentApiHandoffContext,
  type AgentApiImplementationContext,
  type AgentApiReviewRunResult,
  type AgentApiRuntime,
  type AgentApiRuntimeWaitResult,
} from "../../src/main/core/agentapi-orchestrator";
import type { PtyState, TerminalHandoffPacket, AgentApiReviewResult, AgentApiWorkflow } from "../../src/shared/types";

const approved: AgentApiReviewResult = {
  verdict: "approved",
  summary: "Focused verification passed.",
  findings: [],
  verification: ["unit tests passed"],
};

const changes: AgentApiReviewResult = {
  verdict: "changes_requested",
  summary: "Fix the major finding.",
  findings: [{ severity: "major", file: "src/a.ts", line: 2, message: "Missing guard." }],
  verification: [],
};

class FakeRuntime implements AgentApiRuntime {
  prepareCount = 0;
  correctionCount = 0;
  reviewCount = 0;
  cancelCount = 0;
  handoffKeys: string[] = [];
  dispatchSessionIds: string[] = [];
  reviews: Array<AgentApiReviewResult | string> = [approved];
  waits: AgentApiRuntimeWaitResult[] = [];
  correctionRunning: AgentApiRuntimeWaitResult[] = [];
  states = new Map<string, PtyState>();
  blockImplementationWait = false;
  waitStarted: (() => void) | null = null;
  activeWaits = 0;
  maxActiveWaits = 0;
  onWaitCount: ((count: number) => void) | null = null;

  constructor(private readonly repository: Repository, private readonly root: string) {}

  async prepareAndDispatchImplementation(workflow: AgentApiWorkflow): Promise<AgentApiImplementationContext> {
    this.prepareCount += 1;
    const worktreeId = randomUUID();
    const terminalId = randomUUID();
    const sessionId = randomUUID();
    const worktreePath = join(this.root, worktreeId);
    await this.repository.createWorktree({
      id: worktreeId,
      projectId: workflow.projectId,
      branch: `codex/test-${worktreeId.slice(0, 8)}`,
      worktreePath,
      baseRef: "main",
      permissionsPreset: "ask",
    });
    this.states.set(terminalId, "running");
    this.dispatchSessionIds.push(sessionId);
    return { worktreeId, worktreePath, terminalId, sessionId };
  }

  async waitForImplementation(workflow: AgentApiWorkflow, signal: AbortSignal): Promise<AgentApiRuntimeWaitResult> {
    this.waitStarted?.();
    if (this.blockImplementationWait) {
      this.activeWaits += 1;
      this.maxActiveWaits = Math.max(this.maxActiveWaits, this.activeWaits);
      this.onWaitCount?.(this.activeWaits);
      return new Promise((resolve) => {
        signal.addEventListener("abort", () => {
          this.activeWaits -= 1;
          resolve({ outcome: "interrupted", state: this.states.get(workflow.terminalId!) ?? null });
        }, { once: true });
      });
    }
    const result = this.waits.shift() ?? { outcome: "matched", state: "done" };
    if (workflow.terminalId && result.state) this.states.set(workflow.terminalId, result.state);
    return result;
  }

  buildReviewHandoff(workflow: AgentApiWorkflow, key: string): Promise<AgentApiHandoffContext> {
    this.handoffKeys.push(key);
    return Promise.resolve({
      handoffId: randomUUID(),
      packet: packet(workflow),
      formattedPrompt: "<terminal_handoff>safe packet</terminal_handoff>",
    });
  }

  runReadOnlyReview(): Promise<AgentApiReviewRunResult> {
    this.reviewCount += 1;
    const result = this.reviews.shift() ?? approved;
    return Promise.resolve({
      raw: typeof result === "string" ? result : JSON.stringify(result),
      sessionId: `review-${this.reviewCount}`,
    });
  }

  dispatchCorrection(workflow: AgentApiWorkflow): Promise<AgentApiRuntimeWaitResult> {
    this.correctionCount += 1;
    this.dispatchSessionIds.push(workflow.sessionId!);
    if (workflow.terminalId) this.states.set(workflow.terminalId, "done");
    const result = this.correctionRunning.shift() ?? { outcome: "matched", state: "running" };
    if (workflow.terminalId && result.state) this.states.set(workflow.terminalId, result.state);
    return Promise.resolve(result);
  }

  getAgentState(terminalId: string): PtyState | null {
    return this.states.get(terminalId) ?? null;
  }

  cancel(): Promise<void> {
    this.cancelCount += 1;
    return Promise.resolve();
  }
}

describe("AgentApi fixed orchestrator", () => {
  let directory: string;
  let database: AppDatabase;
  let repository: Repository;
  let projectId: string;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "coterm-agentapi-"));
    database = new AppDatabase(join(directory, "state.sqlite"));
    await database.open();
    repository = new Repository(database);
    projectId = (await repository.createProject("AgentApi", directory)).id;
  });

  afterEach(async () => {
    database.close();
    await rm(directory, { recursive: true, force: true });
  });

  it("runs implementation -> stable handoff -> read-only review -> human review", async () => {
    const runtime = new FakeRuntime(repository, directory);
    const orchestrator = new AgentApiOrchestrator(repository, runtime);
    const created = await orchestrator.create(input(projectId, "happy"));
    const final = await orchestrator.waitForIdle(created.id);

    expect(final.state).toBe("ready_for_human_review");
    expect(final.reviewLoop).toBe(1);
    expect(final.worktreeId).toBeTruthy();
    expect(final.sessionId).toBe(runtime.dispatchSessionIds[0]);
    expect(runtime.prepareCount).toBe(1);
    expect(runtime.reviewCount).toBe(1);
    expect(repository.listAgentApiSteps(final.id).map((step) => step.kind)).toEqual([
      "implementation_dispatch", "implementation_wait", "handoff", "review_dispatch",
    ]);
  });

  it("returns one requested correction to the same worktree/session and observes running before done", async () => {
    const runtime = new FakeRuntime(repository, directory);
    runtime.reviews = [changes, approved];
    const orchestrator = new AgentApiOrchestrator(repository, runtime);
    const created = await orchestrator.create(input(projectId, "one-correction"));
    const final = await orchestrator.waitForIdle(created.id);

    expect(final.state).toBe("ready_for_human_review");
    expect(final.reviewLoop).toBe(2);
    expect(runtime.correctionCount).toBe(1);
    expect(runtime.dispatchSessionIds[1]).toBe(runtime.dispatchSessionIds[0]);
    expect(runtime.handoffKeys).toHaveLength(2);
    expect(new Set(runtime.handoffKeys).size).toBe(2);
    expect(repository.listAgentApiSteps(final.id).some((step) => step.kind === "correction_running_wait" && step.status === "completed")).toBe(true);
  });

  it("stops after three non-approving review loops", async () => {
    const runtime = new FakeRuntime(repository, directory);
    runtime.reviews = [changes, changes, changes];
    const orchestrator = new AgentApiOrchestrator(repository, runtime);
    const final = await orchestrator.waitForIdle((await orchestrator.create(input(projectId, "loop-cap"))).id);

    expect(final.state).toBe("needs_human");
    expect(final.reviewLoop).toBe(3);
    expect(final.lastOutcome?.code).toBe("review_loop_limit");
    expect(runtime.correctionCount).toBe(2);
  });

  it("pauses on approval_required and resume refuses while attention remains", async () => {
    const runtime = new FakeRuntime(repository, directory);
    runtime.waits = [{ outcome: "interrupted", state: "approval_required" }];
    const orchestrator = new AgentApiOrchestrator(repository, runtime);
    const final = await orchestrator.waitForIdle((await orchestrator.create(input(projectId, "attention"))).id);

    expect(final.state).toBe("needs_human");
    expect(final.resumeState).toBe("waiting_implementation");
    expect(runtime.reviewCount).toBe(0);
    await expect(orchestrator.resume(final.id)).rejects.toBeInstanceOf(AgentApiConflictError);
  });

  it("recovers an ambiguous dispatch by pausing without resending", async () => {
    const runtime = new FakeRuntime(repository, directory);
    const created = await repository.createAgentApiWorkflow(input(projectId, "restart"));
    await repository.saveAgentApiWorkflow({
      ...created,
      state: "dispatching_implementation",
      startedAt: new Date().toISOString(),
    }, created.revision);

    const recovered = new AgentApiOrchestrator(repository, runtime);
    await recovered.recover();
    const state = recovered.get(created.id).workflow;
    expect(state.state).toBe("needs_human");
    expect(state.lastOutcome?.code).toBe("restart_ambiguous_dispatch");
    expect(runtime.prepareCount).toBe(0);
  });

  it("reattaches to an existing implementation wait after restart without creating a worktree or resending", async () => {
    const runtime = new FakeRuntime(repository, directory);
    const created = await repository.createAgentApiWorkflow(input(projectId, "restart-wait"));
    const worktreeId = randomUUID();
    const terminalId = randomUUID();
    const sessionId = randomUUID();
    const worktreePath = join(directory, worktreeId);
    await repository.createWorktree({
      id: worktreeId,
      projectId,
      branch: `codex/restart-${worktreeId.slice(0, 8)}`,
      worktreePath,
      baseRef: "main",
      permissionsPreset: "ask",
    });
    runtime.states.set(terminalId, "running");
    await repository.saveAgentApiWorkflow({
      ...created,
      state: "waiting_implementation",
      worktreeId,
      worktreePath,
      terminalId,
      sessionId,
      startedAt: new Date().toISOString(),
    }, created.revision);

    const recovered = new AgentApiOrchestrator(repository, runtime);
    await recovered.recover();
    const final = await recovered.waitForIdle(created.id);
    expect(final.state).toBe("ready_for_human_review");
    expect(runtime.prepareCount).toBe(0);
    expect(runtime.reviewCount).toBe(1);
  });

  it("cancel aborts the wait but preserves terminal/worktree context", async () => {
    const runtime = new FakeRuntime(repository, directory);
    runtime.blockImplementationWait = true;
    let started!: () => void;
    const waitStarted = new Promise<void>((resolve) => { started = resolve; });
    runtime.waitStarted = started;
    const orchestrator = new AgentApiOrchestrator(repository, runtime);
    const created = await orchestrator.create(input(projectId, "cancel"));
    await waitStarted;
    const canceled = await orchestrator.cancel(created.id);
    await orchestrator.waitForIdle(created.id);

    expect(canceled.state).toBe("canceled");
    expect(canceled.worktreeId).toBeTruthy();
    expect(canceled.terminalId).toBeTruthy();
    expect(runtime.cancelCount).toBe(1);
    expect(runtime.activeWaits).toBe(0);
  });

  it("runs at most two active agent workflows and leaves excess work queued", async () => {
    const runtime = new FakeRuntime(repository, directory);
    runtime.blockImplementationWait = true;
    let reachedTwo!: () => void;
    const twoActive = new Promise<void>((resolve) => { reachedTwo = resolve; });
    runtime.onWaitCount = (count) => { if (count === 2) reachedTwo(); };
    const orchestrator = new AgentApiOrchestrator(repository, runtime);
    const workflows = await Promise.all([
      orchestrator.create(input(projectId, "capacity-a")),
      orchestrator.create(input(projectId, "capacity-b")),
      orchestrator.create(input(projectId, "capacity-c")),
    ]);
    await twoActive;

    expect(runtime.maxActiveWaits).toBe(2);
    expect(workflows.map((item) => repository.getAgentApiWorkflow(item.id)?.state).filter((state) => state === "queued")).toHaveLength(1);

    await Promise.all(workflows.map((item) => orchestrator.cancel(item.id)));
    await Promise.all(workflows.map((item) => orchestrator.waitForIdle(item.id)));
  });

  it("fails closed on invalid review JSON and treats approved+major as changes", async () => {
    const invalidRuntime = new FakeRuntime(repository, directory);
    invalidRuntime.reviews = ["```json\n{}\n```"];
    const invalidOrchestrator = new AgentApiOrchestrator(repository, invalidRuntime);
    const invalid = await invalidOrchestrator.waitForIdle((await invalidOrchestrator.create(input(projectId, "invalid"))).id);
    expect(invalid.state).toBe("needs_human");
    expect(invalid.lastOutcome?.code).toBe("review_failed_or_invalid");

    const majorRuntime = new FakeRuntime(repository, directory);
    majorRuntime.reviews = Array.from({ length: 3 }, () => ({ ...changes, verdict: "approved" as const }));
    const majorOrchestrator = new AgentApiOrchestrator(repository, majorRuntime);
    const major = await majorOrchestrator.waitForIdle((await majorOrchestrator.create(input(projectId, "major"))).id);
    expect(major.state).toBe("needs_human");
    expect(major.reviewLoop).toBe(3);
  });

  it("uses idempotency and revision CAS in the persisted ledger", async () => {
    const request = input(projectId, "ledger");
    const first = await repository.createAgentApiWorkflow(request);
    const duplicate = await repository.createAgentApiWorkflow(request);
    expect(duplicate.id).toBe(first.id);
    const updated = await repository.saveAgentApiWorkflow({ ...first, state: "needs_human" }, first.revision);
    await expect(repository.saveAgentApiWorkflow({ ...first, state: "failed" }, first.revision))
      .rejects.toThrow("revision conflict");
    expect(updated.revision).toBe(first.revision + 1);
  });
});

function input(projectId: string, suffix: string) {
  return {
    projectId,
    task: `Implement ${suffix}`,
    idempotencyKey: `workflow-${suffix}-${randomUUID()}`,
    implementer: "claude-local-main" as const,
    reviewer: "codex-local-main" as const,
  };
}

function packet(workflow: AgentApiWorkflow): TerminalHandoffPacket {
  return {
    version: 1,
    sourceSessionId: "ref-safe",
    sourceProfile: "claude-local-main",
    targetProfile: "codex-local-main",
    projectId: "project-safe",
    worktree: { branch: "codex/test", head: "abc", dirty: true },
    brief: "Implementation ready for review.",
    completed: ["implemented"],
    changedFiles: ["src/a.ts"],
    verification: ["tests passed"],
    pending: [],
    nextAction: "review",
    risks: [],
    state: { canonical: "done", authoritativeSource: "provider", matchedRuleId: null },
    lastCommand: null,
    source: "sanitized-scrollback",
    partial: false,
    createdAt: workflow.updatedAt,
  };
}
