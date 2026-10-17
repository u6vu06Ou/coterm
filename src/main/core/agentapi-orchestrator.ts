import { agentapiReviewResultSchema, agentapiWorkflowCreateSchema } from "@shared/schema";
import type {
  PtyState,
  TerminalHandoffPacket,
  AgentApiReviewResult,
  AgentApiStepKind,
  AgentApiWorkflow,
  AgentApiWorkflowCreate,
  AgentApiWorkflowOutcome,
  AgentApiWorkflowState,
  AgentApiWorkflowStep,
} from "@shared/types";
import type { Repository } from "../storage/repository";
import { safeErrorMessage } from "../security/redaction";
import { logger } from "./logger";

const ATTENTION_STATES = new Set<PtyState>([
  "waiting_input", "approval_required", "blocked", "error",
]);
const TERMINAL_STATES = new Set<AgentApiWorkflowState>([
  "ready_for_human_review", "canceled",
]);
const AMBIGUOUS_AFTER_RESTART = new Set<AgentApiWorkflowState>([
  "dispatching_implementation", "dispatching_review", "waiting_review",
]);
export const AGENTAPI_MAX_ACTIVE = 2;
export const AGENTAPI_MAX_REVIEW_LOOPS = 3;

export type AgentApiWaitOutcome = "matched" | "interrupted" | "timeout" | "closed" | "shutdown";

export interface AgentApiRuntimeWaitResult {
  outcome: AgentApiWaitOutcome;
  state: PtyState | null;
  reason?: string;
}

export interface AgentApiImplementationContext {
  worktreeId: string;
  worktreePath: string;
  terminalId: string;
  sessionId: string;
}

export interface AgentApiHandoffContext {
  handoffId: string;
  packet: TerminalHandoffPacket;
  formattedPrompt: string;
}

export interface AgentApiReviewRunResult {
  raw: string;
  sessionId: string;
}

/** Injectable boundary used by deterministic tests and the production PTY/provider adapter. */
export interface AgentApiRuntime {
  prepareAndDispatchImplementation(
    workflow: AgentApiWorkflow,
    idempotencyKey: string,
    signal: AbortSignal,
  ): Promise<AgentApiImplementationContext>;
  waitForImplementation(workflow: AgentApiWorkflow, signal: AbortSignal): Promise<AgentApiRuntimeWaitResult>;
  buildReviewHandoff(
    workflow: AgentApiWorkflow,
    idempotencyKey: string,
    signal: AbortSignal,
  ): Promise<AgentApiHandoffContext>;
  runReadOnlyReview(
    workflow: AgentApiWorkflow,
    handoff: AgentApiHandoffContext,
    idempotencyKey: string,
    signal: AbortSignal,
  ): Promise<AgentApiReviewRunResult>;
  dispatchCorrection(
    workflow: AgentApiWorkflow,
    review: AgentApiReviewResult,
    idempotencyKey: string,
    signal: AbortSignal,
  ): Promise<AgentApiRuntimeWaitResult>;
  getAgentState(terminalId: string): PtyState | null;
  cancel(workflow: AgentApiWorkflow): Promise<void>;
}

export class AgentApiNotFoundError extends Error {}
export class AgentApiConflictError extends Error {}

export class AgentApiOrchestrator {
  private readonly queue: string[] = [];
  private readonly queued = new Set<string>();
  private readonly active = new Map<string, AbortController>();
  private readonly runs = new Map<string, Promise<void>>();
  private stopped = false;

  constructor(
    private readonly repository: Repository,
    private readonly runtime: AgentApiRuntime,
    private readonly options: { maxActive?: number; now?: () => string } = {},
  ) {}

  async recover(): Promise<void> {
    for (const workflow of this.repository.listRecoverableAgentApiWorkflows()) {
      if (AMBIGUOUS_AFTER_RESTART.has(workflow.state)) {
        await this.moveToHuman(
          workflow,
          "restart_ambiguous_dispatch",
          "Coterm restarted during an ambiguous dispatch/review step; no prompt was resent.",
          null,
        );
        continue;
      }
      if (["queued", "waiting_implementation", "building_review_packet", "changes_requested"].includes(workflow.state)) {
        this.enqueue(workflow.id);
      }
    }
    this.pump();
  }

  async create(input: unknown): Promise<AgentApiWorkflow> {
    if (this.stopped) throw new AgentApiConflictError("AgentApi orchestrator is shutting down.");
    const parsed: AgentApiWorkflowCreate = agentapiWorkflowCreateSchema.parse(input);
    const workflow = await this.repository.createAgentApiWorkflow(parsed);
    if (!TERMINAL_STATES.has(workflow.state) && !["needs_human", "blocked", "failed"].includes(workflow.state)) {
      this.enqueue(workflow.id);
      this.pump();
    }
    return this.requireWorkflow(workflow.id);
  }

  get(id: string): { workflow: AgentApiWorkflow; steps: AgentApiWorkflowStep[] } {
    const workflow = this.requireWorkflow(id);
    return { workflow, steps: this.repository.listAgentApiSteps(id) };
  }

  async resume(id: string): Promise<AgentApiWorkflow> {
    let workflow = this.requireWorkflow(id);
    if (!["needs_human", "blocked", "failed"].includes(workflow.state) || !workflow.resumeState) {
      throw new AgentApiConflictError("Workflow is not paused at a resumable state.");
    }
    if (workflow.terminalId) {
      const state = this.runtime.getAgentState(workflow.terminalId);
      if (state && ATTENTION_STATES.has(state)) {
        throw new AgentApiConflictError(`Agent attention remains unresolved (${state}).`);
      }
    }
    workflow = await this.transition(workflow, {
      state: workflow.resumeState,
      resumeState: null,
      lastOutcome: { code: "resumed", reason: "Workflow resumed by a human." },
      completedAt: null,
    });
    this.enqueue(id);
    this.pump();
    return workflow;
  }

  async pause(id: string): Promise<AgentApiWorkflow> {
    this.active.get(id)?.abort();
    const workflow = this.requireWorkflow(id);
    if (TERMINAL_STATES.has(workflow.state) || ["needs_human", "blocked", "failed"].includes(workflow.state)) {
      return workflow;
    }
    const resumeState = safeResumeState(workflow.state);
    const paused = await this.moveToHuman(
      workflow,
      "paused_by_human",
      "Workflow paused by a human. No terminal input was sent.",
      resumeState,
    );
    this.queued.delete(id);
    const index = this.queue.indexOf(id);
    if (index >= 0) this.queue.splice(index, 1);
    return paused;
  }

  async cancel(id: string): Promise<AgentApiWorkflow> {
    this.active.get(id)?.abort();
    let workflow = this.requireWorkflow(id);
    if (workflow.state === "canceled") return workflow;
    if (workflow.state === "ready_for_human_review") {
      throw new AgentApiConflictError("A completed workflow cannot be canceled.");
    }
    workflow = await this.transition(workflow, {
      state: "canceled",
      resumeState: null,
      lastOutcome: { code: "canceled", reason: "Workflow canceled by a human." },
      completedAt: this.now(),
    });
    this.queued.delete(id);
    const index = this.queue.indexOf(id);
    if (index >= 0) this.queue.splice(index, 1);
    await this.runtime.cancel(workflow);
    return workflow;
  }

  async waitForIdle(id: string): Promise<AgentApiWorkflow> {
    // A workflow can enqueue a follow-up run while the previous promise is
    // settling, so observe until neither queue nor active/runs owns it.
    for (;;) {
      const run = this.runs.get(id);
      if (run) await run;
      await Promise.resolve();
      if (!this.runs.has(id) && !this.active.has(id) && !this.queued.has(id)) break;
    }
    return this.requireWorkflow(id);
  }

  async shutdown(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    this.queue.splice(0);
    this.queued.clear();
    for (const controller of this.active.values()) controller.abort();
    await Promise.allSettled([...this.runs.values()]);
  }

  private enqueue(id: string): void {
    if (this.stopped || this.queued.has(id) || this.active.has(id)) return;
    this.queued.add(id);
    this.queue.push(id);
  }

  private pump(): void {
    const maxActive = this.options.maxActive ?? AGENTAPI_MAX_ACTIVE;
    while (!this.stopped && this.active.size < maxActive && this.queue.length > 0) {
      const id = this.queue.shift()!;
      this.queued.delete(id);
      const controller = new AbortController();
      this.active.set(id, controller);
      const run = this.drive(id, controller.signal)
        .catch((error) => this.handleDriveFailure(id, error))
        .finally(() => {
          this.active.delete(id);
          this.runs.delete(id);
          this.pump();
        });
      this.runs.set(id, run);
    }
  }

  private async drive(id: string, signal: AbortSignal): Promise<void> {
    for (let guard = 0; guard < 40 && !signal.aborted; guard += 1) {
      const workflow = this.requireWorkflow(id);
      switch (workflow.state) {
        case "queued":
          await this.dispatchInitial(workflow, signal);
          break;
        case "waiting_implementation":
          await this.waitForImplementation(workflow, signal, workflow.reviewLoop > 0);
          break;
        case "building_review_packet":
          await this.buildAndReview(workflow, signal);
          break;
        case "changes_requested":
          await this.dispatchCorrection(workflow, signal);
          break;
        case "dispatching_implementation":
        case "dispatching_review":
        case "waiting_review":
          await this.moveToHuman(
            workflow,
            "ambiguous_dispatch",
            "An ambiguous dispatch state was encountered; Coterm refused to resend automatically.",
            null,
          );
          return;
        default:
          return;
      }
    }
  }

  private async dispatchInitial(workflow: AgentApiWorkflow, signal: AbortSignal): Promise<void> {
    const key = `${workflow.id}:implementation:1:dispatch`;
    let step = await this.beginStep(workflow, "implementation_dispatch", 1, key, "dispatching");
    let current = await this.transition(workflow, {
      state: "dispatching_implementation",
      startedAt: workflow.startedAt ?? this.now(),
      lastOutcome: { code: "dispatching_implementation", reason: "Creating isolated worktree and implementer session." },
    });
    try {
      const context = await this.runtime.prepareAndDispatchImplementation(current, key, signal);
      assertImplementationContext(context);
      step = await this.finishStep(step, "completed", {
        code: "implementation_dispatched",
        reason: "Implementer dispatched in an isolated worktree.",
      }, { terminalId: context.terminalId, sessionId: context.sessionId });
      current = await this.transition(current, {
        state: "waiting_implementation",
        worktreeId: context.worktreeId,
        worktreePath: context.worktreePath,
        terminalId: context.terminalId,
        sessionId: context.sessionId,
        lastOutcome: { code: "waiting_implementation", reason: "Waiting for implementer completion." },
      });
      void step;
    } catch (error) {
      if (signal.aborted) return;
      await this.failStep(step, error);
      await this.moveToHuman(current, "implementation_dispatch_failed", safeMessage(error), null);
    }
  }

  private async waitForImplementation(
    workflow: AgentApiWorkflow,
    signal: AbortSignal,
    correction: boolean,
  ): Promise<void> {
    if (!workflow.terminalId || !workflow.sessionId || !workflow.worktreeId) {
      await this.moveToHuman(workflow, "missing_implementation_context", "Workflow is missing its stable implementation context.", null);
      return;
    }
    const attempt = Math.max(1, workflow.reviewLoop + (correction ? 1 : 0));
    const kind: AgentApiStepKind = correction ? "correction_done_wait" : "implementation_wait";
    const key = `${workflow.id}:${kind}:${attempt}`;
    const step = await this.beginStep(workflow, kind, attempt, key, "waiting");
    const result = await this.runtime.waitForImplementation(workflow, signal);
    if (signal.aborted) return;
    if (result.outcome === "matched" && result.state === "done") {
      await this.finishStep(step, "completed", { code: "implementation_done", reason: "Implementer reached done." });
      await this.transition(this.requireWorkflow(workflow.id), {
        state: "building_review_packet",
        lastOutcome: { code: "implementation_done", reason: "Building a redacted review packet." },
      });
      return;
    }
    const reason = result.reason ?? `Implementation wait ended: ${result.outcome}${result.state ? ` (${result.state})` : ""}.`;
    await this.finishStep(step, "needs_human", { code: `implementation_${result.outcome}`, reason });
    const current = this.requireWorkflow(workflow.id);
    if (result.state === "blocked") {
      await this.transition(current, {
        state: "blocked",
        resumeState: "waiting_implementation",
        lastOutcome: { code: "agent_blocked", reason },
      });
    } else if (result.outcome === "shutdown") {
      await this.transition(current, {
        state: "failed",
        resumeState: "waiting_implementation",
        lastOutcome: { code: "wait_shutdown", reason },
      });
    } else {
      await this.moveToHuman(current, `implementation_${result.outcome}`, reason, "waiting_implementation");
    }
  }

  private async buildAndReview(workflow: AgentApiWorkflow, signal: AbortSignal): Promise<void> {
    const attempt = workflow.reviewLoop + 1;
    if (attempt > AGENTAPI_MAX_REVIEW_LOOPS) {
      await this.moveToHuman(workflow, "review_loop_limit", "Review requested more than 3 correction loops.", null);
      return;
    }
    const handoffKey = `${workflow.id}:review:${attempt}:handoff`;
    let handoffStep = await this.beginStep(workflow, "handoff", attempt, handoffKey, "dispatching");
    let handoff: AgentApiHandoffContext;
    try {
      handoff = await this.runtime.buildReviewHandoff(workflow, handoffKey, signal);
      if (!handoff.handoffId) throw new Error("Terminal handoff ledger did not return a stable ID.");
      handoffStep = await this.finishStep(handoffStep, "completed", {
        code: "handoff_built",
        reason: "Redacted terminal handoff packet is ready.",
      }, { handoffId: handoff.handoffId });
    } catch (error) {
      if (signal.aborted) return;
      await this.failStep(handoffStep, error);
      await this.moveToHuman(workflow, "handoff_failed", safeMessage(error), "building_review_packet");
      return;
    }

    let current = await this.transition(this.requireWorkflow(workflow.id), {
      state: "dispatching_review",
      handoffId: handoff.handoffId,
      lastOutcome: { code: "dispatching_review", reason: "Dispatching forced read-only codex-local-main review." },
    });
    const reviewKey = `${workflow.id}:review:${attempt}:dispatch`;
    let reviewStep = await this.beginStep(current, "review_dispatch", attempt, reviewKey, "dispatching");
    current = await this.transition(current, {
      state: "waiting_review",
      lastOutcome: { code: "waiting_review", reason: "Waiting for strict reviewer JSON." },
    });
    try {
      const reviewRun = await this.runtime.runReadOnlyReview(current, handoff, reviewKey, signal);
      if (signal.aborted) return;
      if (!reviewRun.sessionId) throw new Error("Reviewer did not return a stable session ID.");
      const review = parseStrictReviewResult(reviewRun.raw);
      reviewStep = await this.finishStep(reviewStep, "completed", {
        code: "review_completed",
        reason: "Reviewer returned a schema-valid verdict.",
        review,
      }, { sessionId: reviewRun.sessionId });
      const needsChanges = review.verdict === "changes_requested"
        || review.findings.some((finding) => finding.severity === "critical" || finding.severity === "major");
      if (review.verdict === "blocked") {
        await this.transition(this.requireWorkflow(workflow.id), {
          state: "needs_human",
          resumeState: "building_review_packet",
          reviewLoop: attempt,
          lastOutcome: { code: "review_blocked", reason: review.summary, review },
        });
      } else if (needsChanges && attempt >= AGENTAPI_MAX_REVIEW_LOOPS) {
        await this.transition(this.requireWorkflow(workflow.id), {
          state: "needs_human",
          resumeState: null,
          reviewLoop: attempt,
          lastOutcome: { code: "review_loop_limit", reason: "Three review loops completed without approval.", review },
        });
      } else if (needsChanges) {
        await this.transition(this.requireWorkflow(workflow.id), {
          state: "changes_requested",
          reviewLoop: attempt,
          lastOutcome: { code: "changes_requested", reason: review.summary, review },
        });
      } else {
        await this.transition(this.requireWorkflow(workflow.id), {
          state: "ready_for_human_review",
          resumeState: null,
          reviewLoop: attempt,
          lastOutcome: { code: "approved", reason: review.summary, review },
          completedAt: this.now(),
        });
      }
      void handoffStep;
      void reviewStep;
    } catch (error) {
      if (signal.aborted) return;
      await this.failStep(reviewStep, error);
      await this.moveToHuman(
        this.requireWorkflow(workflow.id),
        "review_failed_or_invalid",
        safeMessage(error),
        "building_review_packet",
      );
    }
  }

  private async dispatchCorrection(workflow: AgentApiWorkflow, signal: AbortSignal): Promise<void> {
    const review = workflow.lastOutcome?.review;
    if (!review || !workflow.terminalId || !workflow.sessionId || !workflow.worktreeId) {
      await this.moveToHuman(workflow, "missing_correction_context", "Correction dispatch is missing review/session/worktree context.", null);
      return;
    }
    const attempt = workflow.reviewLoop;
    const key = `${workflow.id}:correction:${attempt}:dispatch`;
    let step = await this.beginStep(workflow, "correction_dispatch", attempt, key, "dispatching");
    let runningStep: AgentApiWorkflowStep | null = null;
    let current = await this.transition(workflow, {
      state: "dispatching_implementation",
      lastOutcome: { code: "dispatching_correction", reason: "Sending structured reviewer findings to the original implementer.", review },
    });
    try {
      const runningKey = `${workflow.id}:correction:${attempt}:running`;
      runningStep = await this.beginStep(current, "correction_running_wait", attempt, runningKey, "waiting");
      // Runtime subscribes to the running edge before writing the correction,
      // so a very fast done->running->done cycle cannot be missed.
      const running = await this.runtime.dispatchCorrection(current, review, key, signal);
      step = await this.finishStep(step, "completed", {
        code: "correction_dispatched",
        reason: "Correction sent to the original stable Claude session.",
        review,
      });
      if (signal.aborted) return;
      if (running.outcome !== "matched" || running.state !== "running") {
        const reason = running.reason ?? `Correction did not leave the previous done state (${running.outcome}).`;
        await this.finishStep(runningStep, "needs_human", { code: "correction_not_running", reason });
        await this.moveToHuman(this.requireWorkflow(workflow.id), "correction_not_running", reason, "changes_requested");
        return;
      }
      await this.finishStep(runningStep, "completed", {
        code: "correction_running",
        reason: "Observed running after correction dispatch; stale done cannot satisfy the next wait.",
      });
      current = await this.transition(this.requireWorkflow(workflow.id), {
        state: "waiting_implementation",
        lastOutcome: { code: "waiting_correction", reason: "Waiting for correction completion after observing running." },
      });
      void step;
      void current;
    } catch (error) {
      if (signal.aborted) return;
      await this.failStep(step, error);
      if (runningStep && runningStep.status !== "completed") await this.failStep(runningStep, error);
      await this.moveToHuman(current, "correction_dispatch_failed", safeMessage(error), "changes_requested");
    }
  }

  private async beginStep(
    workflow: AgentApiWorkflow,
    kind: AgentApiStepKind,
    attempt: number,
    idempotencyKey: string,
    status: AgentApiWorkflowStep["status"],
  ): Promise<AgentApiWorkflowStep> {
    return this.repository.createAgentApiStep({
      workflowId: workflow.id,
      kind,
      attempt,
      idempotencyKey,
      status,
      terminalId: workflow.terminalId,
      sessionId: workflow.sessionId,
    });
  }

  private async finishStep(
    step: AgentApiWorkflowStep,
    status: AgentApiWorkflowStep["status"],
    outcome: AgentApiWorkflowOutcome,
    ids: Partial<Pick<AgentApiWorkflowStep, "terminalId" | "sessionId" | "handoffId">> = {},
  ): Promise<AgentApiWorkflowStep> {
    if (step.status === "completed" && status === "completed") return step;
    return this.repository.saveAgentApiStep({
      ...step,
      ...ids,
      status,
      outcome,
      completedAt: this.now(),
    }, step.revision);
  }

  private failStep(step: AgentApiWorkflowStep, error: unknown): Promise<AgentApiWorkflowStep> {
    return this.finishStep(step, "failed", { code: "step_failed", reason: safeMessage(error) });
  }

  private async transition(
    workflow: AgentApiWorkflow,
    patch: Partial<Pick<AgentApiWorkflow,
      "state" | "resumeState" | "reviewLoop" | "worktreeId" | "worktreePath" |
      "terminalId" | "sessionId" | "handoffId" | "lastOutcome" | "startedAt" | "completedAt"
    >>,
  ): Promise<AgentApiWorkflow> {
    return this.repository.saveAgentApiWorkflow({ ...workflow, ...patch }, workflow.revision);
  }

  private moveToHuman(
    workflow: AgentApiWorkflow,
    code: string,
    reason: string,
    resumeState: AgentApiWorkflowState | null,
  ): Promise<AgentApiWorkflow> {
    return this.transition(workflow, {
      state: "needs_human",
      resumeState,
      lastOutcome: { code, reason },
    });
  }

  private async handleDriveFailure(id: string, error: unknown): Promise<void> {
    if (this.active.get(id)?.signal.aborted) return;
    const workflow = this.repository.getAgentApiWorkflow(id);
    if (!workflow || TERMINAL_STATES.has(workflow.state) || workflow.state === "needs_human") return;
    logger.error("app", "agentapi.workflow.failed", "AgentApi workflow stopped safely", {
      workflowId: id,
      state: workflow.state,
      error: safeMessage(error),
    });
    await this.moveToHuman(workflow, "orchestrator_error", safeMessage(error), safeResumeState(workflow.state));
  }

  private requireWorkflow(id: string): AgentApiWorkflow {
    const workflow = this.repository.getAgentApiWorkflow(id);
    if (!workflow) throw new AgentApiNotFoundError("AgentApi workflow not found.");
    return workflow;
  }

  private now(): string {
    return this.options.now?.() ?? new Date().toISOString();
  }
}

export function parseStrictReviewResult(raw: string): AgentApiReviewResult {
  const parsed = JSON.parse(raw) as unknown;
  return agentapiReviewResultSchema.parse(parsed);
}

function safeResumeState(state: AgentApiWorkflowState): AgentApiWorkflowState | null {
  if (state === "waiting_implementation") return state;
  if (state === "building_review_packet" || state === "changes_requested") return state;
  // Dispatch/review states are ambiguous and deliberately not auto-resumable.
  return null;
}

function assertImplementationContext(context: AgentApiImplementationContext): void {
  if (!context.worktreeId || !context.worktreePath || !context.terminalId || !context.sessionId) {
    throw new Error("Implementer runtime failed to return stable worktree/terminal/session IDs.");
  }
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(context.sessionId)) {
    throw new Error("Implementer session ID is missing or is not a stable UUID.");
  }
}

function safeMessage(error: unknown): string {
  return safeErrorMessage(error).slice(0, 2_000);
}
