// Agent mailbox — cross-pane "@ mentions" between agent sessions (Claude Code,
// Codex, any profile mix). Main-process single source of truth.
//
// Identity: every spawned PTY gets a random per-pane mail token (env
// COTERM_MAIL_TOKEN) that ONLY authorizes sending mail as that pane — never the
// full agent-API token. Agent panes additionally get a short stable handle
// (COTERM_AGENT_HANDLE, e.g. "claude-1") from their profile family plus the
// lowest free index, shown in the pane header. Plain shells get no handle until
// they are marked as an agent (paste-launched) or send mail themselves.
//
// Delivery: a message is written into the target PTY as one line
// `[@handle] text` + "\r" via the same automation write path as Agent API /input.
// Like Claude Code's native SendMessage, mail lands even while the target is
// BUSY (running): both Claude Code and Codex accept typed input mid-turn and
// queue it for the next step — we never send Esc/Ctrl+C, so a working agent is
// handed a line, never interrupted. Mail HOLDS (FIFO queue) only while typing
// could corrupt a dialog: approval prompts (approval_required), an open
// menu/picker (waiting_input owned by a screen menu rule), plus transient
// starting / blocked / error states. Queued messages from the same sender
// coalesce into one line. TTL 30 min; expired/exited-target drops surface to
// the sender as a notice on their next send/who call.
//
// Loop guards: 10 messages/minute per sender; >20 messages between a pair in
// 10 minutes pauses that pair and raises an attention notification so the user
// sees it.
//
// Logging contract §A.2: audit lines carry from/to/length/outcome metadata
// only — NEVER the message text.

import { randomBytes, timingSafeEqual } from "node:crypto";
import { basename } from "node:path";
import type { AppEventBus } from "./event-bus";
import { logger } from "./logger";
import type { PtyState } from "@shared/types";

export const MAIL_MESSAGE_MAX_CHARS = 500;
export const MAIL_TTL_MS = 30 * 60_000;
export const MAIL_RATE_LIMIT_PER_MINUTE = 10;
export const MAIL_PAIR_PAUSE_THRESHOLD = 20;
export const MAIL_PAIR_WINDOW_MS = 10 * 60_000;
const MAX_NOTICES_PER_PANE = 10;

/**
 * States where injecting a line + Enter is safe to do IMMEDIATELY:
 * - done / waiting_input: idle prompt, the classic delivery point.
 * - running: busy but queueing — both TUIs accept typed text mid-turn and feed
 *   it in at the next step (native SendMessage semantics).
 * starting / approval_required / blocked / error hold in the queue instead.
 */
const IMMEDIATE_STATES: ReadonlySet<PtyState> = new Set(["done", "waiting_input", "running"]);

/**
 * Screen-detection rule ids meaning a MENU/PICKER is open although the state
 * reads waiting_input ("Enter to select", "Choose an option", …): typed text +
 * Enter could pick a menu item, so mail holds until the menu closes. Only
 * meaningful while the screen source owns the state — pty-manager clears the
 * rule id the moment another source takes over. (The same rules also match
 * rare plain-text prompts like "Type your response"; holding those is the
 * conservative side of the blur.)
 */
const MENU_HOLD_RULE_IDS: ReadonlySet<string> = new Set([
  "claude_waiting_input",
  "codex_waiting_input",
]);

export interface MailboxTerminalContext {
  agentProfile: string | null;
  cwd: string;
  projectId: string;
}

export interface AgentMailboxDeps {
  events: AppEventBus;
  /** Injectable clock for TTL / rate-window tests. */
  now?: () => number;
  /** Raised once when a pane pair trips the loop guard. */
  onPairPaused?: (aTerminalId: string, bTerminalId: string) => void;
}

/** Late-bound terminal accessors (terminals is constructed after the mailbox). */
export interface AgentMailboxBindings {
  getState(terminalId: string): PtyState | null;
  getContext(terminalId: string): MailboxTerminalContext | null;
  /**
   * The screen-detection rule id currently owning the pane's state, or null
   * when a non-screen source owns it (or detection has no read). Used to tell
   * "waiting at a plain prompt" apart from "a menu/picker is open".
   */
  getScreenRuleId?(terminalId: string): string | null;
  /** Write one delivery line (including trailing "\r"). Returns success. */
  deliver(terminalId: string, data: string): boolean;
}

export interface MailboxWhoRow {
  handle: string;
  profile: string;
  state: PtyState | "unknown";
  cwd: string;
}

export type MailSendOutcome =
  | { ok: true; status: "delivered" | "queued"; to: string; notice?: string | null }
  | { ok: false; code: "unknown_target" | "self_send" | "rate_limited" | "pair_paused" | "empty_message" };

interface PaneRecord {
  terminalId: string;
  token: string;
  handle: string | null;
  family: string | null;
}

interface QueuedMessage {
  fromTerminalId: string;
  fromHandle: string;
  text: string;
  enqueuedAt: number;
}

/** Stable lowercase family prefix derived from a profile id (claude/codex/gemini/…). */
export function profilePrefix(agentProfile: string | null): string {
  const first = (agentProfile ?? "").split(/[-:.]/)[0]?.toLowerCase() ?? "";
  const cleaned = first.replaceAll(/[^a-z0-9]/g, "");
  return cleaned.length > 0 ? cleaned : "pane";
}

/** One-line safety: strip control chars / ANSI escapes / newlines, cap length. */
export function sanitizeMailText(raw: string): string {
  // Control bytes are built from char codes so this file stays printable
  // ASCII. Drops ANSI OSC (BEL/ST), CSI, lone ESC, 8-bit C1 OSC/DCS, then
  // flattens any remaining control char (incl. newline/tab) to a space.
  const ESC = String.fromCharCode(27);
  const BEL = String.fromCharCode(7);
  const C1_DCS = String.fromCharCode(144);
  const C1_OSC = String.fromCharCode(157);
  const C1_ST = String.fromCharCode(156);
  const noAnsi = raw
    .replaceAll(new RegExp(ESC + "][^" + BEL + ESC + "]*(?:" + BEL + "|" + ESC + "\\\\)", "g"), "")
    .replaceAll(new RegExp(ESC + "\\[[0-9;?]*[ -/]*[@-~]", "g"), "")
    .replaceAll(new RegExp(ESC + "[@-_]", "g"), "")
    .replaceAll(new RegExp("[" + C1_DCS + C1_OSC + "][^" + C1_ST + "]*" + C1_ST + "?", "g"), "")
    .replaceAll(new RegExp(ESC, "g"), "")
  const flattened = [...noAnsi]
    .map((ch) => {
      const code = ch.codePointAt(0) ?? 0;
      return code < 0x20 || (code >= 0x7f && code <= 0x9f) ? " " : ch;
    })
    .join("")
    .replaceAll(/ +/g, " ")
    .trim();
  return [...flattened].slice(0, MAIL_MESSAGE_MAX_CHARS).join("");
}

export class AgentMailbox {
  private readonly events: AppEventBus;
  private readonly now: () => number;
  private readonly onPairPaused: AgentMailboxDeps["onPairPaused"];
  private baseUrl: string | null = null;
  private bindings: AgentMailboxBindings | null = null;

  private readonly panes = new Map<string, PaneRecord>(); // terminalId → record
  private readonly tokens = new Map<string, string>(); // token buffer hex → terminalId
  private readonly handles = new Map<string, string>(); // handle → terminalId
  private readonly nextNumbers = new Map<string, number>(); // family → next index (monotonic)
  private readonly queues = new Map<string, QueuedMessage[]>(); // target terminalId → FIFO
  private readonly notices = new Map<string, string[]>(); // sender terminalId → one-line notices
  private readonly sentAt = new Map<string, number[]>(); // sender terminalId → timestamps (rate)
  private readonly pairSentAt = new Map<string, number[]>(); // "idA|idB" (sorted) → timestamps
  private readonly pausedPairs = new Set<string>();
  private readonly disposers: Array<() => void> = [];
  private sweepTimer: NodeJS.Timeout | null = null;

  constructor(deps: AgentMailboxDeps) {
    this.events = deps.events;
    this.now = deps.now ?? Date.now;
    this.onPairPaused = deps.onPairPaused;

    const onState = (change: { terminalId: string }) => {
      if (this.isDeliverableNow(change.terminalId)) this.flush(change.terminalId);
    };
    const onExit = (change: { terminalId: string }) => {
      this.release(change.terminalId);
    };
    this.events.on("ptyStateChanged", onState);
    this.events.on("terminalExit", onExit);
    this.disposers.push(() => {
      this.events.off("ptyStateChanged", onState);
      this.events.off("terminalExit", onExit);
    });
    this.sweepTimer = setInterval(() => this.sweepExpired(), 60_000);
    this.sweepTimer.unref?.();
  }

  /** Point mail URLs at the live web server port once it is listening. */
  setBaseUrl(baseUrl: string): void {
    this.baseUrl = baseUrl.replace(/\/+$/, "");
  }

  bind(bindings: AgentMailboxBindings): void {
    this.bindings = bindings;
  }

  dispose(): void {
    if (this.sweepTimer) clearInterval(this.sweepTimer);
    this.sweepTimer = null;
    for (const dispose of this.disposers.splice(0)) dispose();
  }

  // --- PtyManager hook: identity allocation at spawn -------------------------

  /**
   * Called by PtyManager.create BEFORE pty.spawn so the identity lands in the
   * shell env (paste-launched agents inherit it from the hosting shell).
   * Returns env vars + the pane handle (null for plain shells).
   */
  onSpawn(input: { terminalId: string; isAgent: boolean; agentProfile: string | null }): {
    env: Record<string, string>;
    handle: string | null;
  } {
    const token = randomBytes(24).toString("hex");
    const family = input.isAgent ? profilePrefix(input.agentProfile) : null;
    const handle = family ? this.allocateHandle(input.terminalId, family) : null;
    this.panes.set(input.terminalId, { terminalId: input.terminalId, token, handle, family });
    this.tokens.set(token, input.terminalId);
    const env: Record<string, string> = {
      COTERM_TERMINAL_ID: input.terminalId,
      COTERM_MAIL_TOKEN: token,
    };
    if (this.baseUrl) env.COTERM_MAIL_URL = `${this.baseUrl}/api/v1/mail`;
    if (handle) env.COTERM_AGENT_HANDLE = handle;
    return { env, handle };
  }

  /** Paste-launched agents: assign a handle once the pane is marked as one. */
  onMarkedAgent(input: { terminalId: string; agentProfile: string }): string | null {
    const pane = this.panes.get(input.terminalId);
    if (!pane) return null;
    if (pane.handle) return pane.handle;
    const family = profilePrefix(input.agentProfile);
    pane.family = family;
    pane.handle = this.allocateHandle(input.terminalId, family);
    return pane.handle;
  }

  /** Free the handle's mail routing + token, drop any mail queued for this pane.
   * The handle NUMBER itself stays taken for the whole app lifetime — see
   * allocateHandle (monotonic allocation, no recycling). */
  release(terminalId: string): void {
    const pane = this.panes.get(terminalId);
    if (!pane) return;
    if (pane.handle) this.handles.delete(pane.handle);
    this.tokens.delete(pane.token);
    this.sentAt.delete(terminalId);
    this.notices.delete(terminalId);
    // Drop queued mail BEFORE removing the pane record so dropQueued can still
    // name the target handle in its notice/audit line.
    const queued = this.queues.get(terminalId);
    if (queued?.length) {
      this.queues.delete(terminalId);
      this.dropQueued(terminalId, queued, "target exited");
    }
    this.panes.delete(terminalId);
    for (const [target, list] of this.queues) {
      const kept = list.filter((message) => message.fromTerminalId !== terminalId);
      if (kept.length !== list.length) this.queues.set(target, kept);
    }
  }

  // --- HTTP-facing API --------------------------------------------------------

  /** Resolve a bearer mail token to its pane. Constant-time per candidate. */
  authenticate(token: string | null | undefined): PaneRecord | null {
    if (!token) return null;
    const candidate = Buffer.from(token, "utf8");
    for (const [stored, terminalId] of this.tokens) {
      const storedBuffer = Buffer.from(stored, "utf8");
      if (storedBuffer.length === candidate.length && timingSafeEqual(storedBuffer, candidate)) {
        return this.panes.get(terminalId) ?? null;
      }
    }
    return null;
  }

  send(senderTerminalId: string, targetHandle: string, rawText: string): MailSendOutcome {
    const sender = this.panes.get(senderTerminalId);
    if (!sender) return { ok: false, code: "unknown_target" };
    const text = sanitizeMailText(rawText);
    if (!text) return { ok: false, code: "empty_message" };

    const handle = targetHandle.trim().replace(/^@/, "").trim().toLowerCase();
    const targetId = this.handles.get(handle);
    if (!targetId || !this.panes.has(targetId)) return { ok: false, code: "unknown_target" };
    if (targetId === senderTerminalId) return { ok: false, code: "self_send" };

    if (!this.takeRate(senderTerminalId)) return { ok: false, code: "rate_limited" };
    if (this.isPairPaused(senderTerminalId, targetId)) {
      logger.audit("audit", "agentMail.paused", "Agent mail rejected: pane pair paused by loop guard.", {
        from: this.displayHandle(senderTerminalId),
        to: handle,
      });
      return { ok: false, code: "pair_paused" };
    }
    this.recordPairMessage(senderTerminalId, targetId);

    const fromHandle = sender.handle ?? this.allocateHandle(senderTerminalId, "pane");
    if (!sender.handle) {
      // Plain-shell sender lazily becomes "pane-N" (monotonic — the number is
      // not reused after the pane exits).
      sender.handle = fromHandle;
      sender.family = "pane";
    }
    if (this.isDeliverableNow(targetId)) {
      this.writeLine(targetId, fromHandle, text);
      logger.audit("audit", "agentMail.delivered", "Agent mail delivered.", {
        from: fromHandle,
        to: handle,
        length: text.length,
      });
      return { ok: true, status: "delivered", to: handle };
    }
    const queue = this.queues.get(targetId) ?? [];
    queue.push({ fromTerminalId: senderTerminalId, fromHandle, text, enqueuedAt: this.now() });
    this.queues.set(targetId, queue);
    logger.audit("audit", "agentMail.queued", "Agent mail queued: target is awaiting approval, has a menu open, or is starting/blocked/errored.", {
      from: fromHandle,
      to: handle,
      length: text.length,
    });
    return { ok: true, status: "queued", to: handle };
  }

  who(requesterTerminalId: string): { rows: MailboxWhoRow[]; selfHandle: string | null; notices: string[] } {
    const rows: MailboxWhoRow[] = [];
    for (const pane of this.panes.values()) {
      if (!pane.handle) continue;
      const context = this.bindings?.getContext(pane.terminalId) ?? null;
      rows.push({
        handle: pane.handle,
        profile: context?.agentProfile ?? pane.family ?? "unknown",
        state: this.bindings?.getState(pane.terminalId) ?? "unknown",
        cwd: context?.cwd ? basename(context.cwd) : "",
      });
    }
    rows.sort((a, b) => a.handle.localeCompare(b.handle));
    return {
      rows,
      selfHandle: this.panes.get(requesterTerminalId)?.handle ?? null,
      notices: this.takeNotices(requesterTerminalId),
    };
  }

  /** Consume per-pane notices (TTL drops, target exits) for the next reply. */
  takeNotices(terminalId: string): string[] {
    const list = this.notices.get(terminalId) ?? [];
    this.notices.delete(terminalId);
    return list;
  }

  /**
   * Re-evaluate a pane whose delivery-blocking detail changed WITHOUT a state
   * transition — e.g. a picker closed while the state stayed waiting_input
   * (screen rule id swapped). PtyManager calls this on screen-rule changes;
   * ptyStateChanged alone would not fire.
   */
  refresh(terminalId: string): void {
    if (this.isDeliverableNow(terminalId)) this.flush(terminalId);
  }

  // --- internals ---------------------------------------------------------------

  /**
   * May a line be typed into this pane right now? done/waiting_input/running
   * are immediate; a waiting_input that a screen menu rule owns is a picker,
   * so it holds. Unknown state (unbound/unknown pane) holds.
   */
  private isDeliverableNow(terminalId: string): boolean {
    const state = this.bindings?.getState(terminalId) ?? null;
    if (!state || !IMMEDIATE_STATES.has(state)) return false;
    if (state === "waiting_input") {
      const ruleId = this.bindings?.getScreenRuleId?.(terminalId) ?? null;
      if (ruleId && MENU_HOLD_RULE_IDS.has(ruleId)) return false;
    }
    return true;
  }

  private displayHandle(terminalId: string): string {
    return this.panes.get(terminalId)?.handle ?? "pane";
  }

  /**
   * Monotonic per family for the app lifetime. A closed pane's number is NOT
   * recycled: a new pane inheriting "@claude-2" would silently receive mail
   * meant for the closed conversation (agents keep long references to those
   * addresses). The handle's mail routing dies in release(); the number never
   * comes back.
   */
  private allocateHandle(terminalId: string, family: string): string {
    let index = this.nextNumbers.get(family) ?? 1;
    while (this.handles.has(`${family}-${index}`)) index += 1; // defensive: skip live handles
    this.nextNumbers.set(family, index + 1);
    const handle = `${family}-${index}`;
    this.handles.set(handle, terminalId);
    return handle;
  }

  private takeRate(senderTerminalId: string): boolean {
    const cutoff = this.now() - 60_000;
    const list = (this.sentAt.get(senderTerminalId) ?? []).filter((at) => at >= cutoff);
    if (list.length >= MAIL_RATE_LIMIT_PER_MINUTE) {
      this.sentAt.set(senderTerminalId, list);
      return false;
    }
    list.push(this.now());
    this.sentAt.set(senderTerminalId, list);
    return true;
  }

  private pairKey(a: string, b: string): string {
    return [a, b].sort().join("|");
  }

  private isPairPaused(a: string, b: string): boolean {
    const key = this.pairKey(a, b);
    if (!this.pausedPairs.has(key)) return false;
    // Auto-unpause once the pair has been quiet for the whole window.
    const cutoff = this.now() - MAIL_PAIR_WINDOW_MS;
    const recent = (this.pairSentAt.get(key) ?? []).filter((at) => at >= cutoff);
    if (recent.length === 0) {
      this.pausedPairs.delete(key);
      return false;
    }
    return true;
  }

  private recordPairMessage(a: string, b: string): void {
    const key = this.pairKey(a, b);
    const cutoff = this.now() - MAIL_PAIR_WINDOW_MS;
    const list = (this.pairSentAt.get(key) ?? []).filter((at) => at >= cutoff);
    list.push(this.now());
    this.pairSentAt.set(key, list);
    if (list.length > MAIL_PAIR_PAUSE_THRESHOLD) {
      this.pausedPairs.add(key);
      this.onPairPaused?.(a, b);
      logger.audit("audit", "agentMail.pairPaused", "Agent mail pane pair paused by loop guard.", {
        a: this.displayHandle(a),
        b: this.displayHandle(b),
        count: list.length,
      });
    }
  }

  /** Flush the FIFO queue for a pane that just became deliverable. */
  private flush(targetTerminalId: string): void {
    const queue = this.queues.get(targetTerminalId);
    if (!queue?.length) return;
    const now = this.now();
    const fresh: QueuedMessage[] = [];
    const expired: QueuedMessage[] = [];
    for (const message of queue) {
      (now - message.enqueuedAt >= MAIL_TTL_MS ? expired : fresh).push(message);
    }
    this.queues.delete(targetTerminalId);
    if (expired.length) this.dropQueued(targetTerminalId, expired, "ttl");
    if (!fresh.length) return;
    // Coalesce per sender, preserving first-seen sender order.
    const bySender = new Map<string, { handle: string; texts: string[] }>();
    for (const message of fresh) {
      const bucket = bySender.get(message.fromTerminalId) ?? { handle: message.fromHandle, texts: [] };
      bucket.texts.push(message.text);
      bySender.set(message.fromTerminalId, bucket);
    }
    for (const { handle, texts } of bySender.values()) {
      this.writeLine(targetTerminalId, handle, texts.join(" | "));
      logger.audit("audit", "agentMail.delivered", "Agent mail delivered.", {
        from: handle,
        to: this.displayHandle(targetTerminalId),
        length: texts.join(" | ").length,
        coalesced: texts.length,
      });
    }
  }

  private writeLine(targetTerminalId: string, fromHandle: string, text: string): boolean {
    const ok = this.bindings?.deliver(targetTerminalId, `[@${fromHandle}] ${text}\r`) ?? false;
    if (!ok) {
      logger.warn("audit", "agentMail.writeFailed", "Agent mail write failed; message lost.", {
        from: fromHandle,
        to: this.displayHandle(targetTerminalId),
        length: text.length,
      });
    }
    return ok;
  }

  private sweepExpired(): void {
    const now = this.now();
    for (const [target, list] of this.queues) {
      const fresh = list.filter((message) => now - message.enqueuedAt < MAIL_TTL_MS);
      if (fresh.length === list.length) continue;
      this.queues.set(target, fresh);
      this.dropQueued(target, list.filter((message) => now - message.enqueuedAt >= MAIL_TTL_MS), "ttl");
    }
  }

  private dropQueued(targetTerminalId: string, dropped: QueuedMessage[], reason: string): void {
    const targetHandle = this.panes.get(targetTerminalId)?.handle ?? "pane";
    const perSender = new Map<string, { handle: string; count: number }>();
    for (const message of dropped) {
      const bucket = perSender.get(message.fromTerminalId) ?? { handle: message.fromHandle, count: 0 };
      bucket.count += 1;
      perSender.set(message.fromTerminalId, bucket);
    }
    for (const [senderId, { handle, count }] of perSender) {
      const notice = `${count} message${count > 1 ? "s" : ""} to ${targetHandle} dropped (${reason}).`;
      const list = this.notices.get(senderId) ?? [];
      if (list.length < MAX_NOTICES_PER_PANE) list.push(notice);
      this.notices.set(senderId, list);
      logger.audit("audit", "agentMail.dropped", "Agent mail dropped.", {
        from: handle,
        to: targetHandle,
        count,
        reason,
      });
    }
  }
}
