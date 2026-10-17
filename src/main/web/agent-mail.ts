// Agent mail routes — POST /api/v1/mail/send and /api/v1/mail/who.
//
// Deliberately NOT part of agentApi.handle: mail must work even when the
// Settings "Agent API" toggle is OFF (panes talk to each other regardless of
// whether the user exposed the Agent API channel). Authorisation is the per-pane
// COTERM_MAIL_TOKEN minted by AgentMailbox at spawn — never the full agent-API
// token — so web-server.ts gates these routes with loopback + Host checks and
// hands off here before verifyAccess, same as /artifact-preview/.
//
// Text/plain responses (Accept: text/plain, what the `cot` CLI shim sends) are
// at most a couple of short lines so a pane burns almost no tokens reading
// them. Message text is never echoed back (logging contract §A.2).

import type { IncomingMessage, ServerResponse } from "node:http";
import { json, readBody } from "./web-server";
import type { AgentMailbox, MailSendOutcome } from "../core/agent-mailbox";
import { logger } from "../core/logger";

export interface AgentMailRouteDeps {
  mailbox: AgentMailbox;
}

function bearerToken(request: IncomingMessage): string | null {
  const header = request.headers.authorization;
  if (!header) return null;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match?.[1]?.trim() ?? null;
}

function wantsText(request: IncomingMessage): boolean {
  return (request.headers.accept ?? "").includes("text/plain");
}

function text(response: ServerResponse, status: number, body: string): void {
  response.writeHead(status, { "Content-Type": "text/plain; charset=utf-8" });
  response.end(body + "\n");
}

function sendOutcomeText(outcome: MailSendOutcome): string {
  if (outcome.ok) return outcome.status === "delivered" ? `sent -> @${outcome.to}` : `queued -> @${outcome.to}`;
  switch (outcome.code) {
    case "unknown_target":
      return "error: unknown handle (run: cot who)";
    case "self_send":
      return "error: cannot mail yourself";
    case "rate_limited":
      return "error: rate limit (10/min), slow down";
    case "pair_paused":
      return "error: this pane pair is paused (loop guard) — talk to the user";
    case "empty_message":
      return "error: empty message";
  }
}

export async function handleAgentMailRequest(
  request: IncomingMessage,
  response: ServerResponse,
  deps: AgentMailRouteDeps,
): Promise<void> {
  const pathname = new URL(request.url ?? "/", "http://localhost").pathname;
  if (request.method !== "POST") {
    return json(response, 405, { ok: false, error: "POST only." });
  }
  const pane = deps.mailbox.authenticate(bearerToken(request));
  if (!pane) {
    // Indistinguishable from a missing mailbox: no oracle about token shape.
    return json(response, 401, { ok: false, error: "Invalid pane token." });
  }

  if (pathname === "/api/v1/mail/who") {
    const result = deps.mailbox.who(pane.terminalId);
    if (wantsText(request)) {
      const lines = result.rows.map(
        (row) => `${row.handle}\t${row.profile}\t${row.state}\t${row.cwd}`,
      );
      if (result.selfHandle) lines.unshift(`you: ${result.selfHandle}`);
      lines.push(...result.notices);
      return text(response, 200, lines.join("\n") || "no agent panes open");
    }
    return json(response, 200, { ok: true, ...result });
  }

  if (pathname === "/api/v1/mail/send") {
    const body = await readBody(request);
    if (body === null) {
      return json(response, 413, { ok: false, error: "Body too large." });
    }
    let parsed: { to?: unknown; text?: unknown };
    try {
      parsed = JSON.parse(body) as { to?: unknown; text?: unknown };
    } catch {
      return json(response, 400, { ok: false, error: "Expected JSON body {to, text}." });
    }
    if (typeof parsed.to !== "string" || typeof parsed.text !== "string") {
      return json(response, 400, { ok: false, error: "Expected JSON body {to, text}." });
    }
    const outcome = deps.mailbox.send(pane.terminalId, parsed.to, parsed.text);
    const notices = deps.mailbox.takeNotices(pane.terminalId);
    const statusCode = outcome.ok
      ? 200
      : outcome.code === "rate_limited"
        ? 429
        : outcome.code === "unknown_target"
          ? 404
          : 400;
    if (!outcome.ok) {
      logger.audit("audit", "agentMail.rejected", "Agent mail rejected.", { code: outcome.code });
    }
    if (wantsText(request)) {
      const lines = [sendOutcomeText(outcome), ...notices];
      return text(response, statusCode, lines.join("\n"));
    }
    return json(response, statusCode, outcome.ok ? { ...outcome, notices } : { ...outcome, notices });
  }

  return json(response, 404, { ok: false, error: "Not found." });
}
