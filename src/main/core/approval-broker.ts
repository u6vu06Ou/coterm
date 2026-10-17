import { createId } from "./ids";

type ApprovalDecision = "accept" | "acceptForSession" | "decline" | "cancel";

/**
 * Optional terminal context for a pending approval/input. When a caller knows
 * which terminal a provider session belongs to (e.g. the Agent API agent API path),
 * it passes terminalId + projectId so AttentionCenter can file a notification.
 * When absent (interactive conversation path, no terminal), the signal is NOT
 * mapped to any terminal — we never guess the association.
 */
export interface TerminalContext {
  terminalId: string;
  projectId: string;
}

/**
 * Browser approval context (AT-133): a risky built-in-browser action needs a
 * human decision, but it has no owning PTY — deliberately a separate shape from
 * TerminalContext so signal consumers (index.ts dual-paths on context type)
 * never confuse it for a terminal association.
 */
export interface BrowserApprovalContext {
  kind: "browser";
  origin: string;
  sessionId: string;
  pageId: string;
}

export type ApprovalContext = TerminalContext | BrowserApprovalContext | null;

/**
 * Display payload carried next to a signal (AT-133). The broker only routes
 * requestId + decision; WHAT to show (browser action/level/origin/locator, …)
 * belongs to the requester and rides along as an opaque record. Never required
 * — callers that have nothing to display omit it.
 */
export type ApprovalSignalPayload = Record<string, unknown>;

export type ApprovalSignalListener = (event: {
  kind: "approval" | "input";
  state: "pending" | "resolved";
  requestId: string;
  context: ApprovalContext;
  payload?: ApprovalSignalPayload | undefined;
}) => void;

interface PendingApproval {
  resolve: (decision: ApprovalDecision) => void;
  timer: NodeJS.Timeout;
  context: ApprovalContext;
  payload?: ApprovalSignalPayload | undefined;
}

export type UserInputAnswers = Record<string, string[]>;

interface PendingInput {
  resolve: (answers: UserInputAnswers | null) => void;
  timer: NodeJS.Timeout;
  context: ApprovalContext;
  payload?: ApprovalSignalPayload | undefined;
}

export class ApprovalBroker {
  private readonly pending = new Map<string, PendingApproval>();
  private readonly pendingInputs = new Map<string, PendingInput>();
  private readonly signalListeners = new Set<ApprovalSignalListener>();

  /** Subscribe to pending/resolved signals. Returns an unsubscribe. */
  onSignal(listener: ApprovalSignalListener): () => void {
    this.signalListeners.add(listener);
    return () => this.signalListeners.delete(listener);
  }

  private emit(kind: "approval" | "input", state: "pending" | "resolved", requestId: string, context: ApprovalContext, payload?: ApprovalSignalPayload): void {
    for (const listener of this.signalListeners) {
      try { listener({ kind, state, requestId, context, payload }); } catch { /* listener must not throw the broker */ }
    }
  }

  request(timeoutMs = 300_000, context: ApprovalContext = null, payload?: ApprovalSignalPayload): { requestId: string; decision: Promise<ApprovalDecision> } {
    const requestId = createId();
    const decision = new Promise<ApprovalDecision>((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        this.emit("approval", "resolved", requestId, context, payload);
        resolve("cancel");
      }, timeoutMs);
      this.pending.set(requestId, { resolve, timer, context, payload });
    });
    this.emit("approval", "pending", requestId, context, payload);
    return { requestId, decision };
  }

  resolve(requestId: string, decision: ApprovalDecision): void {
    const pending = this.pending.get(requestId);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pending.delete(requestId);
    this.emit("approval", "resolved", requestId, pending.context, pending.payload);
    pending.resolve(decision);
  }

  requestInput(timeoutMs = 300_000, context: ApprovalContext = null, payload?: ApprovalSignalPayload): { requestId: string; answers: Promise<UserInputAnswers | null> } {
    const requestId = createId();
    const answers = new Promise<UserInputAnswers | null>((resolve) => {
      const timer = setTimeout(() => {
        this.pendingInputs.delete(requestId);
        this.emit("input", "resolved", requestId, context, payload);
        resolve(null);
      }, timeoutMs);
      this.pendingInputs.set(requestId, { resolve, timer, context, payload });
    });
    this.emit("input", "pending", requestId, context, payload);
    return { requestId, answers };
  }

  resolveInput(requestId: string, answers: UserInputAnswers | null): void {
    const pending = this.pendingInputs.get(requestId);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pendingInputs.delete(requestId);
    this.emit("input", "resolved", requestId, pending.context, pending.payload);
    pending.resolve(answers);
  }

  cancelAll(): void {
    for (const [requestId, pending] of this.pending) {
      clearTimeout(pending.timer);
      this.emit("approval", "resolved", requestId, pending.context, pending.payload);
      pending.resolve("cancel");
      this.pending.delete(requestId);
    }
    for (const [requestId, pending] of this.pendingInputs) {
      clearTimeout(pending.timer);
      this.emit("input", "resolved", requestId, pending.context, pending.payload);
      pending.resolve(null);
      this.pendingInputs.delete(requestId);
    }
  }
}
