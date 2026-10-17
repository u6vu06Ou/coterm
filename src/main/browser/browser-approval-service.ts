import type { BrowserApprovalRequest } from "./browser-runtime-manager";
import { BrowserServiceError } from "./browser-errors";
import type { ApprovalBroker } from "../core/approval-broker";

/**
 * Shared approval gate for HTTP/IPC/MCP adapters. Level 0/1 are safe browser
 * reads/navigation; level 2/3 require an explicit UI decision. Without a
 * connected UI prompt the safe default is deny rather than auto-approve.
 *
 * Issue #93 — one approval per session, not per action. A browser automation
 * flow is dozens of mutations (one LINE message is ~12), so per-request
 * confirmation meant a human clicking Allow every few seconds, or an
 * approval_timeout failure when nobody was watching. Decision reversed
 * 2026-09-20: the FIRST risky action of a browser session prompts once, and
 * answering "allow for this session" puts that session in a granted state where
 * every later action — level 3 included — passes without a dialog.
 *
 * Deliberately NOT a global switch and deliberately NOT persisted:
 *  - the grant dies with the session (close or idle TTL), so "granted" can
 *    never outlive the thing it was granted for;
 *  - a new session asks again, so no setting can rot into permanent
 *    no-questions-asked (the failure mode the earlier global-toggle proposal
 *    had);
 *  - every auto-passed action is still reported through `onAutoApprove`, so the
 *    audit trail keeps one line per action even though the human was asked once.
 */
export class BrowserApprovalService {
  /**
   * Sessions the human has answered "allow for this session". Keyed by browser
   * session id — a session is the unit of consent because it is also the unit
   * of teardown.
   */
  private readonly grantedSessions = new Set<string>();

  constructor(private readonly options: {
    broker?: ApprovalBroker;
    prompt?: (request: BrowserApprovalRequest) => Promise<boolean>;
    timeoutMs?: number;
    approvalModeProvider?: () => "ask" | "auto";
    /** Called for every action that passed on an existing session grant. */
    onAutoApprove?: (request: BrowserApprovalRequest) => void;
    /** Called when a session becomes granted (the human said "for this session"). */
    onGrant?: (sessionId: string, request: BrowserApprovalRequest) => void;
  } = {}) {}

  async request(request: BrowserApprovalRequest): Promise<boolean> {
    if (request.level < 2) return true;
    // Issue #93: an already-granted session skips the dialog entirely, at every
    // level. This check is FIRST so a stale approval-mode setting can never
    // re-prompt a session the human already waved through.
    if (this.grantedSessions.has(request.sessionId)) {
      this.options.onAutoApprove?.(request);
      return true;
    }
    // Level 3 (evaluate/password-shaped fill) always remains human-gated for
    // the first request of a session — the "auto" approval mode covers level 2
    // only, so switching it on is not a blanket bypass of arbitrary scripts.
    if (request.level < 3 && this.options.approvalModeProvider?.() === "auto") return true;
    if (this.options.prompt) return this.options.prompt(request);
    // A broker-backed request is visible to the existing approval channel. If
    // no renderer resolves it before the bounded timeout, broker returns cancel.
    if (!this.options.broker) return false;
    // AT-133: carry an explicit browser context — NOT a terminalId. Browser
    // actions have no owning PTY, and index.ts's signal listener dual-paths on
    // the context shape. The display payload lets the renderer approval dialog
    // show what is being requested and resolve it by requestId.
    const pending = this.options.broker.request(
      this.options.timeoutMs ?? 30_000,
      { kind: "browser", origin: request.origin, sessionId: request.sessionId, pageId: request.pageId },
      {
        action: request.action,
        level: request.level,
        origin: request.origin,
        ...(request.locatorStrategy ? { locatorStrategy: request.locatorStrategy } : {}),
        // evaluate carries a bounded script preview so the human sees what they
        // approve — script text only, never resolved secret values.
        ...(request.previewScript !== undefined ? { previewScript: request.previewScript, previewTruncated: request.previewTruncated === true } : {}),
      },
    );
    const decision = await pending.decision;
    // "cancel" is the broker's resolution when the bounded wait elapsed (or the
    // channel went away) — the action failed closed without a human decision,
    // which is approval_timeout, not a denial and certainly not policy_denied.
    if (decision === "cancel") throw new BrowserServiceError("approval_timeout", "Browser approval was not resolved within the timeout.");
    // Issue #93: this is now the DEFAULT meaning of the Allow button in the
    // browser dialog, so one click covers the rest of the automation run. The
    // dialog says so on the button; consent stays informed.
    if (decision === "acceptForSession") {
      this.grantSession(request.sessionId);
      this.options.onGrant?.(request.sessionId, request);
    }
    return decision === "accept" || decision === "acceptForSession";
  }

  /** Mark a session granted. Idempotent. */
  grantSession(sessionId: string): void {
    this.grantedSessions.add(sessionId);
  }

  isSessionGranted(sessionId: string): boolean {
    return this.grantedSessions.has(sessionId);
  }

  /**
   * Drop a session's grant. Called when the session closes and when the idle
   * sweep reaps it, so a grant can never outlive its session — that is the
   * whole safety argument for making it this permissive.
   */
  revokeSession(sessionId: string): void {
    this.grantedSessions.delete(sessionId);
  }

  /** Granted session ids, for exposing state to the Agent API panel / agent API. */
  grantedSessionIds(): string[] {
    return [...this.grantedSessions];
  }
}
