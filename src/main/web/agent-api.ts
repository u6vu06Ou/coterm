// Agent API — localhost-only REST endpoints for external automation tools.
// Branches BEFORE the Cloudflare verifyAccess gate in web-server.ts so
// local agents don't need a JWT. Security layers (in order):
//   1. setSecurityHeaders (applied by caller before branching)
//   2. settings.agentApi.enabled flag (default ON since 1.5.4 → 404 hides existence when disabled)
//   3. Host-header allowlist (anti DNS-rebind: must be 127.0.0.1/localhost/[::1]:<port>)
//   4. Bearer token (timing-safe comparison with settings.agentApi.token)
//   5. rateLimited() on mutation endpoints (separate map, 30/min)
//   6. readBody (1MB cap) + JSON parse + per-route dispatch
// NEVER log the token or terminal contents to coterm.log.

import { timingSafeEqual } from "node:crypto";
import { readFileSync, statSync, openSync, readSync, closeSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { cpus } from "node:os";
import type { WebOperations } from "./routes";
import { readBody, json, MAX_BODY_BYTES } from "./web-server";
import { estimateAgentCapacity } from "../../shared/resource-estimate";
import type { AgentStateExplanation, AppSettings, DockLayout, TerminalHandoffRequest, TerminalInfo } from "../../shared/types";
import { agentStateExplanationSchema, commandResultSchema, terminalLabelSchema } from "../../shared/schema";
import { getLoggerHealth, getRecentLogEntries, getLogFilePath, getProcessMemory, logger, type LogLevel, type LogCategory } from "../core/logger";
import { redactEgress, redactEgressValue, safeErrorMessage } from "../security/redaction";
import { buildAgentLaunchCommand, supportedAgentProfiles } from "../providers/agent-launch";
import { buildActiveProfiles } from "../providers/profiles-config";
import {
  WAIT_DEFAULT_TIMEOUT_SECONDS,
  WAIT_MAX_MATCH_PATTERN_CHARS,
  WAIT_MAX_STALE_SECONDS,
  WAIT_MAX_TIMEOUT_SECONDS,
  WAIT_MIN_STALE_SECONDS,
  WAIT_MIN_TIMEOUT_SECONDS,
  type SessionWaitCoordinator,
} from "../core/session-wait-coordinator";
import { ptyStateSchema, type PtyState, type ScrollbackMode } from "../../shared/schema";
import { terminalHandoffRequestSchema } from "../../shared/schema";
import { TerminalHandoffError, type TerminalHandoffService } from "../core/terminal-handoff-service";
import { TerminalMutationConflictError } from "../core/app-operations";
import { redactSummaryText } from "../core/free-summary-pipeline";
import {
  AgentApiConflictError,
  AgentApiNotFoundError,
  type AgentApiOrchestrator,
} from "../core/agentapi-orchestrator";
import { ZodError } from "zod";
import type { BrowserRuntimeManager } from "../browser/browser-runtime-manager";
import { BrowserServiceError } from "../browser/browser-errors";
import { browserDiscoverySchema, dispatchBrowserAction, findBrowserAction } from "../browser/browser-action-registry";
import { AGENT_RATE_LIMIT_DEFAULTS } from "../../shared/schema";
import { createCotermMcpHandler, MCP_TERMINAL_TOOL_NAMES } from "../mcp/mcp-server";
import type { PtyManager } from "../terminal/pty-manager";

/** Context handed to agentApi.handle() by web-server.ts. */
export interface AgentApiContext {
  /** Bound RPC operations (same object as WebServerOptions.operations). */
  operations: WebOperations;
  /** Reads current settings (for agentApiEnabled + agentApiToken). */
  getSettings(): AppSettings;
  /** The port the server is listening on (for Host-header allowlist). */
  port: number;
  /** Optional session wait coordinator (issue #4). Absent when not wired. */
  waitCoordinator?: SessionWaitCoordinator;
  /** Privacy-safe terminal handoff generator (issue #5). */
  handoffService?: Pick<TerminalHandoffService, "create">;
  /** Persistent fixed claude-local-main -> codex-local-main workflow (issue #6). */
  agentapi?: Pick<AgentApiOrchestrator, "create" | "get" | "resume" | "pause" | "cancel">;
  browser?: BrowserRuntimeManager;
  /**
   * Bounded terminal views (issue #13): scrollback buffer mode from the
   * DecModeTracker and the cached screen text from the detection engine.
   * Optional so tests and non-terminal deployments can omit it.
   */
  terminals?: Pick<PtyManager, "getScrollbackMode" | "getScreenSnapshot">;
  /**
   * Per-server agent mutation buckets (issue #93). Owned by the web server the
   * way the RPC mutation maps are, so two servers in one process (tests, the
   * beta/stable pair) never share a quota.
   */
  rateBuckets: AgentRateBuckets;
}

const AGENT_PREFIX = "/api/v1/agent/";
/**
 * Mutation ceilings come from settings.agentApi.rateLimit (issue #93);
 * AGENT_RATE_LIMIT_DEFAULTS is the shared fallback so a caller with no persisted
 * settings behaves exactly as before.
 */
const RATE_LIMIT_WINDOW_MS = 60_000;
const MAX_TERMINALS = 12;
/**
 * Session-detail scrollback tail cap (issue #13). The wire payload must stay
 * bounded so a polling agent can never amplify a 2M byte ring per request;
 * the tail keeps the agent-relevant recent content.
 */
const AGENT_SCROLLBACK_MAX_CHARS = 64_000;
const DEFAULT_MAX_CHARS = 8000;
const HARD_MAX_CHARS = 64000;
const DEFAULT_LOG_LINES = 500;
const HARD_MAX_LOG_LINES = 2000;
const DEFAULT_WAIT_STOP_STATES: readonly PtyState[] = [
  "error",
  "blocked",
  "approval_required",
  "waiting_input",
];

/**
 * Agent mutation budgets (issue #93). Two independent buckets per client:
 *   "terminal" — terminal/workflow/worktree mutations (human-scale imperative work)
 *   "browser"  — browser session/page create + browser mutation actions
 * They are separate because one browser form flow is ~12 mutations while a
 * terminal dispatch is one; sharing a bucket meant whichever ran first starved
 * the other. Still separate from the RPC mutation quota.
 *
 * Token bucket, not a fixed window: a fixed window lets 2N requests through in
 * the second straddling a reset, and its retryAfterMs (time to window reset) is
 * wildly pessimistic — issue #93 measured 33s of forced idle when the truthful
 * answer was a few hundred ms. Refill is continuous at limit/60s.
 */
type RateBucketName = "terminal" | "browser";
type RateBucket = { tokens: number; updatedAt: number };
export type AgentRateBuckets = Record<RateBucketName, Map<string, RateBucket>>;

/**
 * Buckets are created PER SERVER (mirroring the RPC mutation maps in
 * web-server.ts), not module-global: tests, and the beta/stable pair, run
 * several servers in one process, and a shared map would let one server's
 * traffic consume another's quota.
 */
export function createAgentRateBuckets(): AgentRateBuckets {
  return { terminal: new Map(), browser: new Map() };
}

const agentOwnedTerminalIds = new Set<string>();

/**
 * Live limits for the request being handled (issue #93). Read from settings on
 * every request so a Settings change takes effect without a relaunch. Hung off
 * the request object rather than a module global: tests (and a beta + stable
 * pair) run several servers in one process, and a global would let the last
 * request's settings decide every other server's limits.
 */
const REQUEST_LIMITS = Symbol("agentRateLimits");
type AgentRateLimits = { terminalPerMinute: number; browserPerMinute: number };
type RequestRateState = { limits: AgentRateLimits; buckets: AgentRateBuckets };

/**
 * Fallback state for a request that never went through the enabled/token gate
 * (unit tests calling a helper directly). Both halves default so no code path
 * can read undefined.
 */
const FALLBACK_RATE_STATE: RequestRateState = {
  limits: AGENT_RATE_LIMIT_DEFAULTS,
  buckets: { terminal: new Map(), browser: new Map() },
};

function attachRateState(request: IncomingMessage, limits: AgentRateLimits, buckets: AgentRateBuckets): void {
  (request as IncomingMessage & { [REQUEST_LIMITS]?: RequestRateState })[REQUEST_LIMITS] = { limits, buckets };
}

function requestRateState(request: IncomingMessage): RequestRateState {
  return (request as IncomingMessage & { [REQUEST_LIMITS]?: RequestRateState })[REQUEST_LIMITS]
    ?? FALLBACK_RATE_STATE;
}

function limitFor(state: RequestRateState, bucket: RateBucketName): number {
  return Math.max(1, bucket === "browser" ? state.limits.browserPerMinute : state.limits.terminalPerMinute);
}

/**
 * Spend one token from `bucket` for `client`. Returns null when the request may
 * proceed, or a typed quota record when it may not — the caller turns that into
 * the 429/MCP-error body via agentRateLimitedResponse, so EVERY limited route
 * reports the same numbers.
 */
function consumeAgentBudget(
  request: IncomingMessage,
  client: string,
  bucket: RateBucketName,
): {
  limit: number;
  remaining: number;
  retryAfterMs: number;
} | null {
  const state = requestRateState(request);
  const limit = limitFor(state, bucket);
  const refillPerMs = limit / RATE_LIMIT_WINDOW_MS;
  const now = Date.now();
  const entries = state.buckets[bucket];
  const current = entries.get(client);
  // A fresh client starts full, so a burst of `limit` is always available.
  const entry = current ?? { tokens: limit, updatedAt: now };
  entry.tokens = Math.min(limit, entry.tokens + Math.max(0, now - entry.updatedAt) * refillPerMs);
  entry.updatedAt = now;
  if (entry.tokens < 1) {
    entries.set(client, entry);
    // The truthful wait: time until the NEXT token, not until a window reset.
    const deficit = 1 - entry.tokens;
    return { limit, remaining: 0, retryAfterMs: Math.max(1, Math.ceil(deficit / refillPerMs)) };
  }
  entry.tokens -= 1;
  entries.set(client, entry);
  return null;
}

/** Read-only view of remaining quota (no spend) — used for disclosure headers. */
function peekAgentBudget(request: IncomingMessage, client: string, bucket: RateBucketName): { limit: number; remaining: number } {
  const state = requestRateState(request);
  const limit = limitFor(state, bucket);
  const entry = state.buckets[bucket].get(client);
  if (!entry) return { limit, remaining: limit };
  const refillPerMs = limit / RATE_LIMIT_WINDOW_MS;
  const tokens = Math.min(limit, entry.tokens + Math.max(0, Date.now() - entry.updatedAt) * refillPerMs);
  return { limit, remaining: Math.max(0, Math.floor(tokens)) };
}

/**
 * Quota disclosure (issue #93 recommendation 1). Cheap and stateless: every
 * mutation response says what is left, so a client can throttle itself instead
 * of keeping its own guess of the server's books (which is always wrong when
 * other clients share the bucket).
 */
function setRateLimitHeaders(response: ServerResponse, request: IncomingMessage, client: string, bucket: RateBucketName): void {
  const { limit, remaining } = peekAgentBudget(request, client, bucket);
  response.setHeader("X-RateLimit-Limit", String(limit));
  response.setHeader("X-RateLimit-Remaining", String(remaining));
  response.setHeader("X-RateLimit-Policy", bucket);
}

/**
 * 429 carrying the remaining quota and a retry hint. A bare 429 with no reset
 * time is what sends weak agents into retry loops, so the body mirrors the
 * headers. `quota` comes from consumeAgentBudget so the numbers always describe
 * the bucket that actually refused.
 */
function agentRateLimitedResponse(
  response: ServerResponse,
  quota: { limit: number; remaining: number; retryAfterMs: number },
  bucket: RateBucketName,
): boolean {
  response.setHeader("Retry-After", String(Math.ceil(quota.retryAfterMs / 1000)));
  response.setHeader("X-RateLimit-Limit", String(quota.limit));
  response.setHeader("X-RateLimit-Remaining", "0");
  response.setHeader("X-RateLimit-Policy", bucket);
  return json(response, 429, {
    ok: false,
    error: "Too many requests.",
    code: "rate_limited",
    bucket,
    limit: quota.limit,
    remaining: 0,
    retryAfterMs: quota.retryAfterMs,
  }), true;
}

/**
 * Which bucket an MCP tools/call draws on, or null when it is unthrottled
 * (issue #93). The curated MCP tool set is browser actions plus two read-only
 * terminal tools, so a mutating tool always lands on the browser bucket; batch
 * is null because its steps consume the bucket individually via the dispatch
 * hook, and charging the call too would double-count every step.
 */
function mcpToolMutationBucket(name: string): RateBucketName | null {
  if ((MCP_TERMINAL_TOOL_NAMES as readonly string[]).includes(name)) return null;
  const definition = findBrowserAction(name, "mcp");
  if (!definition) return null;
  if (definition.composite === "batch") return null;
  return definition.mutability === "mutation" ? "browser" : null;
}

/**
 * One-shot rate gate for a simple route: consume, and answer 429 when refused.
 * Returns the quota that was spent (or null) so the caller can disclose the
 * remaining budget on the success path too. Returns undefined when the request
 * was already answered with a 429 — the caller returns true immediately.
 */
function takeAgentBudget(
  request: IncomingMessage,
  response: ServerResponse,
  bucket: RateBucketName,
): { refused: true } | { refused: false; client: string } {
  const client = request.socket.remoteAddress ?? "local";
  const refused = consumeAgentBudget(request, client, bucket);
  if (refused) {
    agentRateLimitedResponse(response, refused, bucket);
    return { refused: true };
  }
  setRateLimitHeaders(response, request, client, bucket);
  return { refused: false, client };
}

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

/**
 * Handles all requests under /api/v1/agent/*.
 * Called by handleRequest() BEFORE the verifyAccess gate.
 * Returns true if it handled the request (caller does nothing more);
 * returns false if the path was not an agent path (caller continues normally).
 */
export const agentApi = {
  async handle(
    request: IncomingMessage,
    response: ServerResponse,
    ctx: AgentApiContext,
  ): Promise<boolean> {
    // 1. Path guard — only claim /api/v1/agent/* paths.
    const url = new URL(request.url ?? "/", "http://localhost");
    if (!url.pathname.startsWith(AGENT_PREFIX)) return false;

    const settings = ctx.getSettings();
    const pathname = url.pathname;
    // Live rate-limit source (issue #93): read through the settings getter on
    // every request so a Settings change takes effect without a relaunch, the
    // same contract the browser network/approval policy providers use.
    // `?? defaults`: settings reach us through a getter that, in tests, may be a
    // partial fixture (or a settings file written before #93) — an undefined
    // bucket config must degrade to the shipped defaults, never to a 500.
    attachRateState(request, settings.agentApi.rateLimit ?? AGENT_RATE_LIMIT_DEFAULTS, ctx.rateBuckets);

    // /health is the only endpoint that doesn't require token or enabled flag.
    // It lets agents probe whether the API exists before asking the user to enable it.
    if (pathname === "/api/v1/agent/health" && request.method === "GET") {
      return json(response, 200, { ok: true, enabled: settings.agentApi.enabled }), true;
    }

    // 2. Enabled flag (default ON since 1.5.4). 404 hides existence when disabled.
    if (!settings.agentApi.enabled) {
      return json(response, 404, { ok: false, error: "Not found." }), true;
    }

    // 3. Host-header allowlist (anti DNS-rebind).
    const host = request.headers.host ?? "";
    const allowedHosts = new Set([
      `127.0.0.1:${ctx.port}`,
      `localhost:${ctx.port}`,
      `[::1]:${ctx.port}`,
    ]);
    if (!allowedHosts.has(host)) {
      return json(response, 403, { ok: false, error: "Host rejected." }), true;
    }

    // 4. Bearer token.
    const auth = request.headers.authorization;
    const token = typeof auth === "string" && auth.startsWith("Bearer ")
      ? auth.slice(7)
      : null;
    if (!token || !settings.agentApi.token || !safeEqual(token, settings.agentApi.token)) {
      return json(response, 401, { ok: false, error: "Invalid agent token." }), true;
    }

    // 5. Route dispatch.
    //    GET  /api/v1/agent/sessions
    //    GET  /api/v1/agent/session/:terminalId
    //    GET  /api/v1/agent/session/:terminalId/state-explain
    //    POST /api/v1/agent/terminals                  (rate-limited; can launch a free agent profile)
    //    POST /api/v1/agent/session/:terminalId/input   (rate-limited)
    //    POST /api/v1/agent/session/:terminalId/close   (rate-limited)
    const segments = pathname.slice(AGENT_PREFIX.length).split("/").filter(Boolean);

    // Browser runtime REST surface. It deliberately exposes one typed action
    // envelope instead of leaking Playwright objects or allowing arbitrary JS.
    if (segments[0] === "browser") {
      if (!ctx.browser) return json(response, 503, { ok: false, error: "Browser runtime unavailable." }), true;
      if (segments.length === 2 && segments[1] === "schema" && request.method === "GET") {
        return json(response, 200, {
          ok: true,
          schema: browserDiscoverySchema(
            ctx.browser.getLimits(),
            "1",
            ctx.browser.getFeatureFlags(),
            requestRateState(request).limits,
          ),
        }), true;
      }
      if (segments.length === 2 && segments[1] === "sessions" && request.method === "GET") {
        try { return json(response, 200, { ok: true, sessions: await dispatchBrowserAction(ctx.browser, "listSessions", {}, "http") }), true; }
        catch (error) { return browserErrorResponse(response, error, "Browser sessions unavailable."); }
      }
      if (segments.length === 2 && segments[1] === "session" && request.method === "POST") {
        return handleBrowserCreateSession(request, response, ctx.browser);
      }
      if (segments.length === 2 && segments[1] === "page" && request.method === "POST") {
        return handleBrowserNewPage(request, response, ctx.browser);
      }
      if (segments.length === 2 && segments[1] === "action" && request.method === "POST") {
        return handleBrowserAction(request, response, ctx.browser);
      }
      return json(response, 404, { ok: false, error: "Not found." }), true;
    }

    // MCP (streamable HTTP) — curated coterm tools for MCP-native agents
    // (AT-135). Stateless JSON responses; notifications get 202. The spec
    // REQUIRES 405 for the optional SSE GET stream we do not serve — a strict
    // client treats any other error on GET as fatal.
    if (segments.length === 1 && segments[0] === "mcp") {
      if (request.method !== "POST") {
        response.setHeader("Allow", "POST");
        return json(response, 405, { ok: false, error: "Method not allowed." }), true;
      }
      return handleMcp(request, response, ctx);
    }

    // --- AgentApi fixed orchestrator (issue #6) -----------------------------
    if (segments.length === 1 && segments[0] === "workflow" && request.method === "POST") {
      return handleCreateWorkflow(request, response, ctx);
    }
    if (segments.length === 2 && segments[0] === "workflow" && request.method === "GET") {
      return handleGetWorkflow(response, ctx, segments[1]!);
    }
    if (segments.length === 3 && segments[0] === "workflow" && segments[2] === "resume" && request.method === "POST") {
      return handleWorkflowMutation(request, response, ctx, segments[1]!, "resume");
    }
    if (segments.length === 3 && segments[0] === "workflow" && segments[2] === "pause" && request.method === "POST") {
      return handleWorkflowMutation(request, response, ctx, segments[1]!, "pause");
    }
    if (segments.length === 3 && segments[0] === "workflow" && segments[2] === "cancel" && request.method === "POST") {
      return handleWorkflowMutation(request, response, ctx, segments[1]!, "cancel");
    }

    // GET /sessions — list all terminals across all dock tiles
    if (segments.length === 1 && segments[0] === "sessions" && request.method === "GET") {
      return handleSessions(response, ctx);
    }

    // GET /resources — live machine load + how many more agent panes fit
    // (resource board). Read-only; not rate-limited. Agents should check this
    // before fanning out sub-agents (AGENTS.md Agent API section).
    if (segments.length === 1 && segments[0] === "resources" && request.method === "GET") {
      return handleResources(response, ctx);
    }

    // POST /terminals — open a new dock tile for agent work
    if (segments.length === 1 && segments[0] === "terminals" && request.method === "POST") {
      return handleCreateTerminal(request, response, ctx);
    }

    // --- A — Worktree sandbox + trusted resume ------------------------------
    //    GET  /api/v1/agent/worktrees?projectId=   — list active worktrees
    //    POST /api/v1/agent/worktrees              (rate-limited; create sandbox)
    //    GET  /api/v1/agent/worktrees/:id          — worktree detail
    //    GET  /api/v1/agent/worktrees/:id/diff     — pre-merge diff summary
    //    POST /api/v1/agent/worktrees/:id/merge    (rate-limited; requires confirm)
    //    POST /api/v1/agent/worktrees/:id/abort    (rate-limited)
    //    POST /api/v1/agent/worktrees/:id/cleanup  (rate-limited)
    //    POST /api/v1/agent/worktrees/:id/resume   (rate-limited; returns rebuilt command)
    if (segments.length === 1 && segments[0] === "worktrees" && request.method === "GET") {
      return handleListWorktrees(response, ctx, url);
    }
    if (segments.length === 1 && segments[0] === "worktrees" && request.method === "POST") {
      return handleCreateWorktree(request, response, ctx);
    }
    if (segments.length === 2 && segments[0] === "worktrees" && request.method === "GET") {
      return handleGetWorktree(response, ctx, segments[1]!);
    }
    if (segments.length === 3 && segments[0] === "worktrees" && segments[2] === "diff" && request.method === "GET") {
      return handleWorktreeDiff(response, ctx, segments[1]!);
    }
    if (segments.length === 3 && segments[0] === "worktrees" && segments[2] === "merge" && request.method === "POST") {
      return handleMergeWorktree(request, response, ctx, segments[1]!);
    }
    if (segments.length === 3 && segments[0] === "worktrees" && segments[2] === "abort" && request.method === "POST") {
      return handleAbortWorktree(request, response, ctx, segments[1]!);
    }
    if (segments.length === 3 && segments[0] === "worktrees" && segments[2] === "cleanup" && request.method === "POST") {
      return handleCleanupWorktree(request, response, ctx, segments[1]!);
    }
    if (segments.length === 3 && segments[0] === "worktrees" && segments[2] === "resume" && request.method === "POST") {
      return handleResumeWorktree(request, response, ctx, segments[1]!);
    }

    // GET /session/:id — terminal detail + scrollback
    if (segments.length === 2 && segments[0] === "session" && request.method === "GET") {
      return handleSessionDetail(response, ctx, segments[1]!);
    }

    // GET /session/:id/last-command — lightweight last CommandResult (no scrollback read)
    if (segments.length === 3 && segments[0] === "session" && segments[2] === "last-command" && request.method === "GET") {
      return handleSessionLastCommand(response, ctx, segments[1]!);
    }

    // GET /session/:id/state-explain — fixed metadata only; never PTY evidence.
    if (segments.length === 3 && segments[0] === "session" && segments[2] === "state-explain" && request.method === "GET") {
      return handleSessionStateExplain(response, ctx, segments[1]!);
    }

    // GET /session/:id/wait — event-driven, cancellable wait for a canonical
    // PtyState (issue #4). No polling; resolved by ptyStateChanged/terminalExit/
    // timeout/abort/shutdown. Read-only: never writes to the terminal.
    if (segments.length === 3 && segments[0] === "session" && segments[2] === "wait" && request.method === "GET") {
      return handleSessionWait(request, response, ctx, segments[1]!);
    }

    // POST /session/:id/handoff-packet — builds and persists a redacted packet.
    // It never writes to a PTY and never acknowledges attention state.
    if (segments.length === 3 && segments[0] === "session" && segments[2] === "handoff-packet" && request.method === "POST") {
      return handleTerminalHandoff(request, response, ctx, segments[1]!);
    }

    // POST /session/:id/input — write keystrokes to a terminal
    if (segments.length === 3 && segments[0] === "session" && segments[2] === "input" && request.method === "POST") {
      return handleSessionInput(request, response, ctx, segments[1]!);
    }

    // POST /session/:id/close — close an agent-owned terminal.
    // Non-agent-owned terminals require allowUserTerminal:true, so external
    // overseers ask before touching user-opened windows.
    if (segments.length === 3 && segments[0] === "session" && segments[2] === "close" && request.method === "POST") {
      return handleSessionClose(request, response, ctx, segments[1]!);
    }

    // --- Phase 2 read-only investigation endpoints (GET only) ---
    //    GET /api/v1/agent/logger-health  — logger health snapshot
    //    GET /api/v1/agent/incidents      — warn/error aggregation
    //    GET /api/v1/agent/state          — app state summary
    //    GET /api/v1/agent/logs           — ring buffer grep
    //    GET /api/v1/agent/logs/file      — coterm.log tail
    //    GET /api/v1/agent/diagnostics    — health + state + incidents
    //    GET /api/v1/agent/schema         — log schema (levels/categories/msgCodes)
    //    GET /api/v1/agent/audit          — audit trail (category=audit shortcut)
    if (request.method === "GET") {
      if (segments.length === 1 && segments[0] === "logger-health") {
        return handleLoggerHealth(response), true;
      }
      if (segments.length === 1 && segments[0] === "incidents") {
        return handleIncidents(response, url), true;
      }
      if (segments.length === 1 && segments[0] === "state") {
        return handleState(response, ctx), true;
      }
      if (segments.length === 1 && segments[0] === "logs") {
        return handleLogs(response, url), true;
      }
      if (segments.length === 2 && segments[0] === "logs" && segments[1] === "file") {
        return handleLogsFile(response, url), true;
      }
      if (segments.length === 1 && segments[0] === "diagnostics") {
        return handleDiagnostics(response, ctx), true;
      }
      if (segments.length === 1 && segments[0] === "schema") {
        return handleSchema(response), true;
      }
      if (segments.length === 1 && segments[0] === "audit") {
        return handleAuditTrail(response, url), true;
      }
    }

    return json(response, 404, { ok: false, error: "Not found." }), true;
  },
};

async function handleBrowserCreateSession(request: IncomingMessage, response: ServerResponse, browser: BrowserRuntimeManager): Promise<boolean> {
  if (takeAgentBudget(request, response, "browser").refused) return true;
  const body = await readBody(request);
  if (body === null) return json(response, 413, { ok: false, error: "Request too large." }), true;
  try {
    const input: unknown = body.trim() ? JSON.parse(body) : {};
    return json(response, 200, { ok: true, session: await dispatchBrowserAction(browser, "createSession", input, "http") }), true;
  } catch (error) { return browserErrorResponse(response, error, "Browser session creation failed."); }
}

async function handleBrowserNewPage(request: IncomingMessage, response: ServerResponse, browser: BrowserRuntimeManager): Promise<boolean> {
  if (takeAgentBudget(request, response, "browser").refused) return true;
  const body = await readBody(request);
  if (body === null) return json(response, 413, { ok: false, error: "Request too large." }), true;
  try {
    const parsed = JSON.parse(body) as { sessionId?: unknown; url?: unknown };
    return json(response, 200, { ok: true, page: await dispatchBrowserAction(browser, "newPage", parsed, "http") }), true;
  } catch (error) { return browserErrorResponse(response, error, "Browser page creation failed."); }
}

async function handleBrowserAction(request: IncomingMessage, response: ServerResponse, browser: BrowserRuntimeManager): Promise<boolean> {
  const body = await readBody(request);
  if (body === null) return json(response, 413, { ok: false, error: "Request too large." }), true;
  let parsed: { action?: unknown; input?: unknown };
  try { parsed = JSON.parse(body) as typeof parsed; } catch { return json(response, 400, { ok: false, error: "Invalid JSON." }), true; }
  if (typeof parsed.action !== "string") return json(response, 400, { ok: false, error: "Field 'action' is required." }), true;
  const definition = findBrowserAction(parsed.action, "http");
  if (!definition) return json(response, 400, { ok: false, error: "Unsupported browser action.", code: "invalid_input" }), true;
  // Batch steps consume the shared bucket individually (per-step rate_limited
  // errors), so the composite batch call itself skips the top-level slot.
  if (definition.mutability !== "read" && definition.composite !== "batch"
    && takeAgentBudget(request, response, "browser").refused) return true;
  const batchHooks = definition.composite === "batch"
    ? {
        consumeMutationBudget: () => {
          const client = request.socket.remoteAddress ?? "local";
          const quota = consumeAgentBudget(request, client, "browser");
          if (quota) {
            throw new BrowserServiceError("rate_limited", `Mutation budget exhausted; retry after ${quota.retryAfterMs}ms.`);
          }
          setRateLimitHeaders(response, request, client, "browser");
        },
      }
    : undefined;
  try {
    const result = await dispatchBrowserAction(browser, parsed.action, parsed.input, "http", batchHooks);
    return json(response, 200, { ok: true, result }), true;
  } catch (error) { return browserErrorResponse(response, error, "Browser action failed."); }
}

function browserErrorResponse(response: ServerResponse, error: unknown, fallback: string): boolean {
  const message = error instanceof Error ? error.message : fallback;
  const code = error instanceof BrowserServiceError ? error.code : undefined;
  const status = code === "busy" ? 503 : code === "captcha_wall" ? 451 : code === "policy_denied" || code === "permission_denied" || code === "approval_denied" || code === "approval_timeout" ? 403 : code === "not_found" ? 404 : code === "ambiguous" || code === "stale_snapshot" ? 409 : code === "timeout" ? 504 : 400;
  // Capacity errors carry a retry hint at the top level so a caller can back off instead of
  // parsing it out of the message (a hard error with no retry hint is what sends weak agents
  // into retry loops).
  const retryAfterMs = error instanceof BrowserServiceError && typeof (error as unknown as { retryAfterMs?: unknown }).retryAfterMs === "number" ? (error as unknown as { retryAfterMs: number }).retryAfterMs : undefined;
  if (retryAfterMs !== undefined) response.setHeader("Retry-After", String(Math.ceil(retryAfterMs / 1000)));
  // A bot wall is not retryable on the same host, so the reply carries where to go instead.
  const wall = error as { host?: unknown; suggestion?: unknown };
  const wallHint = code === "captcha_wall" && typeof wall.host === "string" && Array.isArray(wall.suggestion)
    ? { host: wall.host, suggestion: wall.suggestion } : undefined;
  return json(response, status, { ok: false, error: message, ...(code ? { code } : {}), ...(retryAfterMs !== undefined ? { retryAfterMs } : {}), ...(wallHint ?? {}) }), true;
}

// --- Route handlers ---------------------------------------------------------

/** GET /api/v1/agent/logger-health — logger health snapshot (ring buffer + file state). */
function handleLoggerHealth(response: ServerResponse): boolean {
  try {
    const health = getLoggerHealth();
    // logPath contains a user home path → redact before egressing.
    const safeHealth = { ...health, logPath: redactEgress(health.logPath) };
    return json(response, 200, { ok: true, health: safeHealth }), true;
  } catch {
    return json(response, 500, { ok: false, error: { code: "LOGGER_HEALTH_FAILED", message: "Failed to read logger health." } }), true;
  }
}

/** GET /api/v1/agent/state — app state summary (no terminal content/scrollback). */
async function handleState(response: ServerResponse, ctx: AgentApiContext): Promise<boolean> {
  try {
    const layout = await ctx.operations.getDockLayout?.() as DockLayout | undefined;
    const tileCount = layout?.tiles.length ?? 0;
    const selectedTerminalId = layout?.selectedTerminalId ?? null;

    // Count live terminals across projects (listTerminals is per-projectId).
    // We only need a count, so we sum across the distinct projectIds in the dock.
    let terminalCount = 0;
    if (layout) {
      const projectIds = new Set(layout.tiles.map((t) => t.projectId));
      for (const projectId of projectIds) {
        const infos = ctx.operations.listTerminals?.(projectId) as TerminalInfo[] | undefined;
        if (infos) terminalCount += infos.length;
      }
    }

    const settings = ctx.getSettings();
    const state = {
      terminals: terminalCount,
      dockLayout: { tileCount, selectedTerminalId },
      settings: {
        agentApiEnabled: settings.agentApi.enabled,
        defaultProvider: settings.defaultProvider,
        defaultShell: settings.defaultShell,
      },
    };

    // Redact defensively — selectedTerminalId is a UUID (no PII), but settings
    // values could theoretically contain paths in future expansions.
    return json(response, 200, { ok: true, state: redactEgressValue(state) }), true;
  } catch {
    return json(response, 500, { ok: false, error: { code: "STATE_FAILED", message: "Failed to read app state." } }), true;
  }
}

/** GET /api/v1/agent/logs — grep the in-memory ring buffer (already-redacted JSON lines). */
function handleLogs(response: ServerResponse, url: URL): boolean {
  try {
    const params = url.searchParams;
    const level = params.get("level") as LogLevel | null;
    const category = params.get("category") as LogCategory | null;
    const since = params.get("since");
    const q = params.get("q");
    const limitParam = params.get("limit");
    const limit = limitParam ? Math.min(Math.max(parseInt(limitParam, 10) || 200, 1), 200) : 200;
    const maxChars = clampMaxChars(params.get("maxChars"));

    const entries = getRecentLogEntries({
      ...(level ? { level } : {}),
      ...(category ? { category } : {}),
      ...(since ? { since } : {}),
      ...(q ? { q } : {}),
      limit,
    });

    // Each line is a JSON string built from the already-redacted ring entry.
    // We re-redact the msg field as defence in depth.
    const lines: string[] = [];
    let totalChars = 0;
    let truncated = false;
    for (const entry of entries) {
      const line = JSON.stringify({
        ts: entry.ts,
        level: entry.level,
        category: entry.category,
        msgCode: entry.msgCode,
        msg: redactEgress(entry.msg),
      });
      if (totalChars + line.length > maxChars) {
        truncated = true;
        break;
      }
      totalChars += line.length;
      lines.push(line);
    }

    return json(response, 200, { ok: true, lines, count: lines.length, truncated }), true;
  } catch {
    return json(response, 500, { ok: false, error: { code: "LOGS_QUERY_FAILED", message: "Failed to query logs." } }), true;
  }
}

/** GET /api/v1/agent/audit?since=&maxChars= — audit trail (category=audit shortcut). */
function handleAuditTrail(response: ServerResponse, url: URL): boolean {
  try {
    const params = url.searchParams;
    const since = params.get("since");
    const maxChars = clampMaxChars(params.get("maxChars"));

    // Audit entries are written via logger.audit() → level=info, category=audit.
    // We fix category=audit so agents can pull the audit trail in one call.
    const entries = getRecentLogEntries({
      category: "audit",
      ...(since ? { since } : {}),
      limit: 200,
    });

    const lines: string[] = [];
    let totalChars = 0;
    let truncated = false;
    for (const entry of entries) {
      const line = JSON.stringify({
        ts: entry.ts,
        level: entry.level,
        category: entry.category,
        msgCode: entry.msgCode,
        msg: redactEgress(entry.msg),
      });
      if (totalChars + line.length > maxChars) {
        truncated = true;
        break;
      }
      totalChars += line.length;
      lines.push(line);
    }

    return json(response, 200, { ok: true, entries: lines, count: lines.length, truncated }), true;
  } catch {
    return json(response, 500, { ok: false, error: { code: "AUDIT_TRAIL_FAILED", message: "Failed to query audit trail." } }), true;
  }
}

/** GET /api/v1/agent/logs/file — tail coterm.log (raw file), each line redacted. */
function handleLogsFile(response: ServerResponse, url: URL): boolean {
  try {
    const params = url.searchParams;
    const linesParam = params.get("lines");
    const lines = linesParam ? Math.min(Math.max(parseInt(linesParam, 10) || DEFAULT_LOG_LINES, 1), HARD_MAX_LOG_LINES) : DEFAULT_LOG_LINES;
    const maxChars = clampMaxChars(params.get("maxChars"));

    const logPath = getLogFilePath();
    if (!logPath) {
      return json(response, 503, { ok: false, error: { code: "LOG_FILE_UNAVAILABLE", message: "Log file is not available (logger in console fallback mode)." } }), true;
    }

    let content: string;
    try {
      content = readFileSyncTail(logPath);
    } catch {
      return json(response, 503, { ok: false, error: { code: "LOG_FILE_READ_FAILED", message: "Failed to read log file." } }), true;
    }

    // Redact each line, enforce the line-count limit, then the char budget.
    const allLines = content.split("\n").filter((line) => line.length > 0);
    const rawLines = allLines.slice(-lines);
    const safeLines: string[] = [];
    let totalChars = 0;
    let truncated = false;
    for (const line of rawLines) {
      const safe = redactEgress(line);
      if (totalChars + safe.length > maxChars) {
        truncated = true;
        break;
      }
      totalChars += safe.length;
      safeLines.push(safe);
    }

    const body = safeLines.join("\n") + (safeLines.length > 0 ? "\n" : "");
    response.statusCode = 200;
    response.setHeader("Content-Type", "text/plain; charset=utf-8");
    response.setHeader("X-Truncated", truncated ? "true" : "false");
    response.end(body);
    return true;
  } catch {
    if (!response.headersSent) {
      return json(response, 500, { ok: false, error: { code: "LOGS_FILE_FAILED", message: "Failed to tail log file." } }), true;
    }
    return true;
  }
}

/** GET /api/v1/agent/incidents?window=5m — aggregate warn/error entries in the ring buffer. */
function handleIncidents(response: ServerResponse, url: URL): boolean {
  try {
    const params = url.searchParams;
    const windowParam = params.get("window") ?? "5m";
    const windowMs = parseWindow(windowParam);
    const maxChars = clampMaxChars(params.get("maxChars"));

    // Scan ring buffer for warn/error entries within the time window.
    const sinceIso = new Date(Date.now() - windowMs).toISOString();
    const entries = getRecentLogEntries({ since: sinceIso, limit: 200 });
    const incidents = entries.filter((e) => e.level === "warn" || e.level === "error");

    // Aggregate by category and level.
    const byCategory: Record<string, number> = {};
    const byLevel: Record<string, number> = {};
    for (const entry of incidents) {
      byCategory[entry.category] = (byCategory[entry.category] ?? 0) + 1;
      byLevel[entry.level] = (byLevel[entry.level] ?? 0) + 1;
    }

    // Recent 10 entries (redacted, JSON-line strings) — enforce maxChars budget.
    const recent: string[] = [];
    let totalChars = 0;
    let truncated = false;
    for (const entry of incidents.slice(-10)) {
      const line = JSON.stringify({
        ts: entry.ts,
        level: entry.level,
        category: entry.category,
        msgCode: entry.msgCode,
        msg: redactEgress(entry.msg),
      });
      if (totalChars + line.length > maxChars) {
        truncated = true;
        break;
      }
      totalChars += line.length;
      recent.push(line);
    }

    const result = {
      ok: true,
      incidents: {
        count: incidents.length,
        window: windowParam,
        byCategory,
        byLevel,
        recent,
        truncated,
      },
    };
    return json(response, 200, result), true;
  } catch {
    return json(response, 500, { ok: false, error: { code: "INCIDENTS_FAILED", message: "Failed to aggregate incidents." } }), true;
  }
}

/** GET /api/v1/agent/diagnostics — one-shot health + state + incidents snapshot. */
async function handleDiagnostics(response: ServerResponse, ctx: AgentApiContext): Promise<boolean> {
  try {
    // health
    const health = getLoggerHealth();
    const safeHealth = { ...health, logPath: redactEgress(health.logPath) };

    // state (same logic as handleState, inlined to avoid a second RPC round-trip)
    const layout = await ctx.operations.getDockLayout?.() as DockLayout | undefined;
    const tileCount = layout?.tiles.length ?? 0;
    const selectedTerminalId = layout?.selectedTerminalId ?? null;
    let terminalCount = 0;
    if (layout) {
      const projectIds = new Set(layout.tiles.map((t) => t.projectId));
      for (const projectId of projectIds) {
        const infos = ctx.operations.listTerminals?.(projectId) as TerminalInfo[] | undefined;
        if (infos) terminalCount += infos.length;
      }
    }
    const settings = ctx.getSettings();
    const state = {
      terminals: terminalCount,
      dockLayout: { tileCount, selectedTerminalId },
      settings: {
        agentApiEnabled: settings.agentApi.enabled,
        defaultProvider: settings.defaultProvider,
        defaultShell: settings.defaultShell,
      },
    };

    // incidents (5m default, same as handleIncidents)
    const windowMs = 5 * 60_000;
    const sinceIso = new Date(Date.now() - windowMs).toISOString();
    const entries = getRecentLogEntries({ since: sinceIso, limit: 200 });
    const incidents = entries.filter((e) => e.level === "warn" || e.level === "error");
    const byCategory: Record<string, number> = {};
    const byLevel: Record<string, number> = {};
    for (const entry of incidents) {
      byCategory[entry.category] = (byCategory[entry.category] ?? 0) + 1;
      byLevel[entry.level] = (byLevel[entry.level] ?? 0) + 1;
    }

    const result = {
      ok: true,
      diagnostics: {
        health: safeHealth,
        state: redactEgressValue(state),
        memory: getProcessMemory(),
        incidents: {
          count: incidents.length,
          window: "5m",
          byCategory,
          byLevel,
        },
      },
    };
    return json(response, 200, result), true;
  } catch {
    return json(response, 500, { ok: false, error: { code: "DIAGNOSTICS_FAILED", message: "Failed to assemble diagnostics." } }), true;
  }
}

/** GET /api/v1/agent/schema — static log schema (levels, categories, msgCodes). */
function handleSchema(response: ServerResponse): boolean {
  try {
    const levels: LogLevel[] = ["debug", "info", "warn", "error"];
    const categories: LogCategory[] = [
      "app", "ipc", "web", "pty", "state", "provider", "storage", "run", "council", "security", "audit",
    ];
    // Known msgCode list (collected from logger.* call sites across src/main).
    const msgCodes = [
      "app.bootstrap",
      "app.start.failed",
      "app.shutdown",
      "app.shutdown.deadline",
      "app.shutdown.cleanupFailed",
      "app.dailySummary.completed",
      "app.dailySummary.failed",
      "app.window.reopenFailed",
      "app.window.recreateFailed",
      "agentApi.tokenFile",
      "window.create",
      "window.hide",
      "process.unhandledRejection",
      "process.uncaughtException",
      "dockLayout.persist.failed",
      "pty.spawn.failed",
      "pty.exit.abnormal",
      "terminal.workspace.saved",
      "terminal.event.appended",
      "terminal.output.flush.failed",
      "logger.initialized",
      "ui.action",
    ];
    return json(response, 200, { ok: true, schema: { levels, categories, msgCodes, browserSchema: "/api/v1/agent/browser/schema" } }), true;
  } catch {
    return json(response, 500, { ok: false, error: { code: "SCHEMA_FAILED", message: "Failed to return log schema." } }), true;
  }
}

/** Parse a duration string like "5m", "1h", "30s" into milliseconds. Defaults to 5m. */
function parseWindow(raw: string): number {
  const match = /^(\d+)([smh])$/.exec(raw);
  if (!match) return 5 * 60_000;
  const value = parseInt(match[1]!, 10);
  const unit = match[2];
  if (unit === "s") return value * 1_000;
  if (unit === "m") return value * 60_000;
  return value * 3_600_000; // h
}

/** Clamp the maxChars query param to [1, HARD_MAX_CHARS], defaulting to DEFAULT_MAX_CHARS. */
function clampMaxChars(raw: string | null): number {
  if (!raw) return DEFAULT_MAX_CHARS;
  const parsed = parseInt(raw, 10);
  if (Number.isNaN(parsed)) return DEFAULT_MAX_CHARS;
  return Math.min(Math.max(parsed, 1), HARD_MAX_CHARS);
}

/** Read the tail of a log file (last ~256KB or full file if smaller). */
function readFileSyncTail(filePath: string): string {
  const stats = statSync(filePath);
  const CHUNK = 256 * 1024;
  if (stats.size <= CHUNK) {
    return readFileSync(filePath, "utf8");
  }
  // Read the last chunk and drop the partial first line.
  const fd = openSync(filePath, "r");
  try {
    const buffer = Buffer.alloc(CHUNK);
    readSync(fd, buffer, 0, CHUNK, stats.size - CHUNK);
    const text = buffer.toString("utf8");
    const firstNewline = text.indexOf("\n");
    return firstNewline >= 0 ? text.slice(firstNewline + 1) : text;
  } finally {
    closeSync(fd);
  }
}

/** GET /api/v1/agent/sessions — all terminals in the dock, with layout weights. */
async function handleSessions(response: ServerResponse, ctx: AgentApiContext): Promise<boolean> {
  try {
    const { layout, terminals } = await listDockTerminals(ctx);

    // issue #13: per-terminal buffer mode so a caller can tell, before fetching
    // /session/:id, which terminals are on the alternate screen. Unknown
    // terminals default to "normal" (never alternate-screen by accident).
    const scrollbackModes: Record<string, ScrollbackMode> = {};
    for (const terminal of terminals) {
      scrollbackModes[terminal.id] = ctx.terminals?.getScrollbackMode(terminal.id) ?? "normal";
    }

    // 空位計數誠實化（1.5.44, next-rev board「空位計數謊言」): slot accounting
    // must follow the DOCK (layout.tiles), not the live-terminal list —
    // listDockTerminals intersects with the PtyManager registry, so a tile
    // whose PTY died (registry entry deleted) vanished from `terminals` while
    // still occupying a slot, and availableSlots reported free slots while
    // openTile refused with "dock is full". Live/dead split is exposed so
    // callers (eyes) can show 登記窗/人類窗/死格 without a second guess.
    const liveIds = new Set(terminals.map((terminal) => terminal.id));
    const deadTileIds = layout.tiles
      .filter((tile) => !liveIds.has(tile.terminalId))
      .map((tile) => tile.terminalId);
    const terminalCount = layout.tiles.length;

    return json(response, 200, {
      ok: true,
      selectedTerminalId: layout.selectedTerminalId,
      maxTerminals: MAX_TERMINALS,
      terminalCount,
      liveTerminalCount: terminals.length,
      deadTileCount: deadTileIds.length,
      deadTileIds,
      availableSlots: Math.max(0, MAX_TERMINALS - terminalCount),
      canCreate: terminalCount < MAX_TERMINALS,
      agentOwnedTerminalIds: [...agentOwnedTerminalIds].filter((id) => terminals.some((terminal) => terminal.id === id)),
      scrollbackModes,
      terminals,
    }), true;
  } catch {
    return json(response, 500, { ok: false, error: "Failed to list sessions." }), true;
  }
}

/** Resource-board payload shared by REST GET /resources and the MCP coterm_resources tool. */
export interface AgentResourceSnapshot {
  cpuPercent: number | null;
  cpuCores: number;
  memUsedBytes: number;
  memTotalBytes: number;
  memPercent: number;
  openTerminals: number;
  /** Live panes running an agent profile (isAgent && still running). */
  busyAgents: number;
  recommendedMaxNewAgents: number;
  sampledAt: number;
}

async function buildResourceSnapshot(ctx: AgentApiContext): Promise<AgentResourceSnapshot> {
  const { layout, terminals } = await listDockTerminals(ctx);
  const activity = ctx.operations.getSystemActivity?.() as
    | { cpuPercent: number | null; memPercent: number; memUsedBytes: number; memTotalBytes: number }
    | undefined;
  const openTerminals = layout.tiles.length;
  const busyAgents = terminals.filter((terminal) => terminal.isAgent && terminal.status === "running").length;
  const capacity = estimateAgentCapacity({
    cpuPercent: activity?.cpuPercent ?? null,
    memUsedBytes: activity?.memUsedBytes ?? 0,
    memTotalBytes: activity?.memTotalBytes ?? 0,
    openTerminals,
    maxTiles: MAX_TERMINALS,
  });
  return {
    cpuPercent: activity?.cpuPercent ?? null,
    cpuCores: cpus().length,
    memUsedBytes: activity?.memUsedBytes ?? 0,
    memTotalBytes: activity?.memTotalBytes ?? 0,
    memPercent: activity?.memPercent ?? capacity.memPercent,
    openTerminals,
    busyAgents,
    recommendedMaxNewAgents: capacity.recommendedMaxNewAgents,
    sampledAt: Date.now(),
  };
}

/**
 * GET /api/v1/agent/resources — resource board. Read-only, not rate-limited:
 * meant to be polled/checked before an overseer fans out sub-agents.
 */
async function handleResources(response: ServerResponse, ctx: AgentApiContext): Promise<boolean> {
  try {
    return json(response, 200, { ok: true, resources: await buildResourceSnapshot(ctx) }), true;
  } catch {
    return json(response, 500, { ok: false, error: "Failed to read resource snapshot." }), true;
  }
}

/** POST /api/v1/agent/terminals — open a new terminal tile for agent work. */
async function handleCreateTerminal(
  request: IncomingMessage,
  response: ServerResponse,
  ctx: AgentApiContext,
): Promise<boolean> {
  if (takeAgentBudget(request, response, "terminal").refused) return true;

  const body = await readBody(request);
  if (body === null) return json(response, 413, { ok: false, error: "Request too large." }), true;

  let parsed: {
    projectId?: unknown;
    agentProfile?: unknown;
    launch?: unknown;
    task?: unknown;
    resumeSessionId?: unknown;
    label?: unknown;
  };
  try {
    parsed = body.trim() ? JSON.parse(body) as typeof parsed : {};
  } catch {
    return json(response, 400, { ok: false, error: "Invalid JSON." }), true;
  }
  if (typeof parsed.projectId !== "string" || parsed.projectId.length === 0) {
    return json(response, 400, { ok: false, error: "Field 'projectId' must be a non-empty string." }), true;
  }
  const agentProfile = typeof parsed.agentProfile === "string" && parsed.agentProfile.length > 0
    ? parsed.agentProfile
    : null;
  const launch = parsed.launch === false ? false : Boolean(agentProfile);
  const task = typeof parsed.task === "string" && parsed.task.trim().length > 0
    ? parsed.task
    : null;
  const resumeSessionId = typeof parsed.resumeSessionId === "string" && parsed.resumeSessionId.length > 0
    ? parsed.resumeSessionId
    : null;
  // 1.5.45 warroom identity. OPTIONAL and additive: every existing caller omits
  // it and gets exactly today's behaviour (no band). A malformed label is a
  // 400 rather than a silent drop — the warroom expects the band it asked for.
  const labelResult = terminalLabelSchema.safeParse(parsed.label);
  if (parsed.label !== undefined && parsed.label !== null && !labelResult.success) {
    return json(response, 400, {
      ok: false,
      error: "Field 'label' must be { room: string (<=500), group: non-empty string (<=80) }.",
    }), true;
  }
  const label = labelResult.success ? labelResult.data : undefined;
  // Hot model registry: derive the allowlist from the ACTIVE profile table
  // (DEFAULT_PROFILES ⊕ settings.customProfiles) on every request.
  const activeProfiles = buildActiveProfiles(ctx.getSettings().customProfiles);
  if (agentProfile && !supportedAgentProfiles(activeProfiles).includes(agentProfile)) {
    return json(response, 400, {
      ok: false,
      error: `Unsupported agentProfile. Use one of: ${supportedAgentProfiles(activeProfiles).join(", ")}.`,
      supportedAgentProfiles: supportedAgentProfiles(activeProfiles),
    }), true;
  }

  // 殭屍格回收（1.5.44, next-rev board）: any failure after openTile created a
  // tile must give the slot back — otherwise the caller sees an error, retries,
  // and each retry leaves one more blank placeholder until the dock reports
  // full. Tracked via createdTerminalId + reclaimed best-effort below.
  let createdTerminalId: string | null = null;
  try {
    const before = await ctx.operations.getDockLayout?.() as DockLayout | undefined;
    if (!before) return json(response, 500, { ok: false, error: "Dock layout unavailable." }), true;
    if (before.tiles.length >= MAX_TERMINALS) {
      return json(response, 409, {
        ok: false,
        error: `The dock is full (max ${MAX_TERMINALS} terminals).`,
        maxTerminals: MAX_TERMINALS,
        terminalCount: before.tiles.length,
        availableSlots: 0,
        canCreate: false,
      }), true;
    }

    const openStartedAt = Date.now();
    const layout = await ctx.operations.openTile?.({
      projectId: parsed.projectId,
      ...(label ? { label } : {}),
    }) as DockLayout | undefined;
    if (!layout?.selectedTerminalId) return json(response, 500, { ok: false, error: "Failed to create terminal." }), true;
    const terminalId = layout.selectedTerminalId;
    createdTerminalId = terminalId;
    agentOwnedTerminalIds.add(terminalId);
    await ctx.operations.markTerminalAgentOwned?.({ terminalId });
    if (agentProfile) {
      await ctx.operations.markTerminalAgent?.({ terminalId, agentProfile });
    }
    const { terminals } = await listDockTerminals(ctx);
    const terminal = terminals.find((item) => item.id === terminalId);
    if (!terminal) {
      await reclaimCreatedTile(ctx, terminalId);
      createdTerminalId = null;
      return json(response, 500, { ok: false, error: "Created terminal is not available." }), true;
    }
    let launched = false;
    if (launch && !ctx.operations.writeTerminal) {
      await reclaimCreatedTile(ctx, terminalId);
      createdTerminalId = null;
      return json(response, 500, { ok: false, error: "Terminal input unavailable." }), true;
    }
    if (launch && agentProfile) {
      const command = buildAgentLaunchCommand(agentProfile, terminal.cwd, task, resumeSessionId, activeProfiles);
      if (command) {
        ctx.operations.writeTerminal?.({ terminalId, data: `${command}\r`, source: "automation", waitForShellReady: true });
        launched = true;
      }
      logger.info("web", "agent.terminal.launch", "Agent terminal launched.", {
        terminalId,
        agentProfile,
        durationMs: Date.now() - openStartedAt,
      });
    }
    // Slot accounting follows the DOCK (layout.tiles), not the live-terminal
    // list — a tile whose PTY already died still occupies a slot.
    const terminalCount = layout.tiles.length;
    return json(response, 200, {
      ok: true,
      terminal,
      selectedTerminalId: terminalId,
      launched,
      supportedAgentProfiles: supportedAgentProfiles(activeProfiles),
      maxTerminals: MAX_TERMINALS,
      terminalCount,
      availableSlots: Math.max(0, MAX_TERMINALS - terminalCount),
      canCreate: terminalCount < MAX_TERMINALS,
    }), true;
  } catch (error) {
    if (createdTerminalId) {
      await reclaimCreatedTile(ctx, createdTerminalId);
    }
    const message = error instanceof Error ? error.message : "Failed to create terminal.";
    return json(response, message.includes("full") ? 409 : 500, { ok: false, error: message }), true;
  }
}

/**
 * 殭屍格回收（1.5.44）: best-effort close of a tile created by
 * handleCreateTerminal whose follow-up steps failed. Never lets a reclaim
 * failure mask the original error.
 */
async function reclaimCreatedTile(ctx: AgentApiContext, terminalId: string): Promise<void> {
  agentOwnedTerminalIds.delete(terminalId);
  try {
    await ctx.operations.closeTile?.({ terminalId });
    logger.info("web", "agent.terminal.reclaim", "Reclaimed dock tile after a failed agent-terminal create.", {
      terminalId,
    });
  } catch {
    // Best-effort: the tile may be gone already (e.g. the PTY exited and the
    // terminalExit reclaimer beat us to it).
  }
}

/**
 * Shared bounded session view (REST /session/:id and the MCP coterm_terminal_read
 * tool). Throws SessionViewError(status) for 404/500 cases so both transports
 * keep ONE implementation of the issue #13 scrollbackMode contract.
 */
class SessionViewError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

async function readSessionView(ctx: AgentApiContext, terminalId: string, maxChars: number) {
  const layout = await ctx.operations.getDockLayout?.() as DockLayout | undefined;
  if (!layout) throw new SessionViewError(500, "Dock layout unavailable.");

  // Bridge terminalId → projectId via dock layout (the only lookup path).
  const tile = layout.tiles.find((t) => t.terminalId === terminalId);
  if (!tile) throw new SessionViewError(404, "Terminal not in dock.");

  const ws = await ctx.operations.getTerminalWorkspace?.(tile.projectId) as
    | { terminals: TerminalInfo[]; scrollback: Record<string, string> }
    | undefined;
  if (!ws) throw new SessionViewError(500, "Workspace unavailable.");

  const terminal = ws.terminals.find((t) => t.id === terminalId);
  if (!terminal) throw new SessionViewError(404, "Terminal not found.");

  // lastCommand: lightweight structured last command (null if the shell has
  // not emitted a rich OSC 633 lifecycle). Avoids reading full scrollback.
  const lastCommand = safeCommandResult(
    await Promise.resolve(ctx.operations.getLastCommand?.(terminalId) ?? null),
  );

  // issue #13 scrollbackMode contract: the payload is always bounded, so a
  // polling loop can never be fed garbage or unbounded payloads. On the
  // alternate screen (?1049h) the byte ring is full-repaint escape noise —
  // scrollback is fixed to "" and the bounded screen-cache text is the
  // readable substitute. screenText is null for untracked terminals.
  const scrollbackMode = ctx.terminals?.getScrollbackMode(terminalId) ?? "normal";
  const rawScrollback = ws.scrollback[terminalId] ?? "";
  const scrollback = scrollbackMode === "alternate-screen"
    ? ""
    : rawScrollback.slice(-Math.min(maxChars, AGENT_SCROLLBACK_MAX_CHARS));
  const screenText = scrollbackMode === "alternate-screen"
    ? ctx.terminals?.getScreenSnapshot(terminalId) ?? null
    : null;

  return {
    terminal,
    scrollbackMode,
    scrollback,
    screenText,
    truncated: rawScrollback.length > scrollback.length,
    lastCommand,
  };
}

/** GET /api/v1/agent/session/:terminalId — terminal detail + scrollback. */
async function handleSessionDetail(
  response: ServerResponse,
  ctx: AgentApiContext,
  terminalId: string,
): Promise<boolean> {
  try {
    const view = await readSessionView(ctx, terminalId, AGENT_SCROLLBACK_MAX_CHARS);
    return json(response, 200, { ok: true, ...view }), true;
  } catch (error) {
    if (error instanceof SessionViewError) return json(response, error.status, { ok: false, error: error.message }), true;
    return json(response, 500, { ok: false, error: "Failed to get session." }), true;
  }
}

/**
 * POST /api/v1/agent/mcp — MCP (streamable HTTP, stateless JSON) endpoint.
 * Same auth layers as every agent route (this function runs after them).
 * Curated core browser tools + two read-only terminal tools (AT-135); the
 * full action surface stays on the REST envelope + /browser/schema document.
 */
async function handleMcp(
  request: IncomingMessage,
  response: ServerResponse,
  ctx: AgentApiContext,
): Promise<boolean> {
  const body = await readBody(request);
  if (body === null) return json(response, 413, { ok: false, error: "Request too large." }), true;

  let rpc: { id?: string | number | null; method?: string; params?: Record<string, unknown> };
  try {
    rpc = JSON.parse(body.trim() || "{}") as typeof rpc;
  } catch {
    return json(response, 400, { jsonrpc: "2.0", id: null, error: { code: -32700, message: "Invalid JSON." } }), true;
  }
  // Reject non-object bodies (`null`, scalars) and JSON-RPC batch arrays:
  // a batch would otherwise read as id-less → "notification" → fake 202 success
  // with zero tool execution. Fail loudly instead.
  if (typeof rpc !== "object" || rpc === null || Array.isArray(rpc)) {
    return json(response, 400, { jsonrpc: "2.0", id: null, error: { code: -32600, message: "Invalid Request: single JSON-RPC object only, no batches." } }), true;
  }

  // Mutating tool calls share the 30/min agent-mutation bucket with the REST
  // mutation routes, so switching protocols cannot dodge backpressure. The
  // JSON-RPC error body carries the same retryAfterMs contract as HTTP 429s.
  if (rpc.method === "tools/call") {
    const name = typeof rpc.params?.name === "string" ? rpc.params.name : "";
    const client = request.socket.remoteAddress ?? "local";
    // A browser mutation drawing on the browser bucket is what makes MCP and
    // REST share backpressure per protocol surface (issue #93).
    const bucket = mcpToolMutationBucket(name);
    if (bucket) {
      const quota = consumeAgentBudget(request, client, bucket);
      if (quota) {
        response.setHeader("Retry-After", String(Math.ceil(quota.retryAfterMs / 1000)));
        response.setHeader("X-RateLimit-Limit", String(quota.limit));
        response.setHeader("X-RateLimit-Remaining", "0");
        response.setHeader("X-RateLimit-Policy", bucket);
        return json(response, 429, {
          jsonrpc: "2.0",
          id: rpc.id ?? null,
          error: {
            code: -32000,
            message: "Too many requests.",
            data: { code: "rate_limited", bucket, limit: quota.limit, remaining: 0, retryAfterMs: quota.retryAfterMs },
          },
        }), true;
      }
      setRateLimitHeaders(response, request, client, bucket);
    }
  }

  const handler = createCotermMcpHandler({
    browser: ctx.browser,
    // Batch steps hit this once per MUTATION step, so N batched mutations can
    // never ride the single top-level tools/call slot checked above; the throw
    // surfaces as a typed per-step rate_limited error inside the batch result.
    browserMutationBudget: () => {
      const client = request.socket.remoteAddress ?? "local";
      const quota = consumeAgentBudget(request, client, "browser");
      if (quota) {
        throw new BrowserServiceError("rate_limited", `Mutation budget exhausted; retry after ${quota.retryAfterMs}ms.`);
      }
      setRateLimitHeaders(response, request, client, "browser");
    },
    terminalSessions: async () => {
      const { layout, terminals } = await listDockTerminals(ctx);
      const scrollbackModes: Record<string, ScrollbackMode> = {};
      for (const terminal of terminals) {
        scrollbackModes[terminal.id] = ctx.terminals?.getScrollbackMode(terminal.id) ?? "normal";
      }
      return {
        selectedTerminalId: layout.selectedTerminalId,
        terminalCount: terminals.length,
        maxTerminals: MAX_TERMINALS,
        scrollbackModes,
        terminals,
      };
    },
    terminalRead: async ({ terminalId, tailChars }) => {
      try {
        return await readSessionView(ctx, terminalId, tailChars ?? 2000);
      } catch (error) {
        // Keep the status semantics: a missing terminal is not_found, but an
        // internal 500 (layout/workspace unavailable) must NOT read as
        // "terminal gone" — agents would stop retrying.
        if (error instanceof SessionViewError) {
          throw new BrowserServiceError(error.status === 404 ? "not_found" : "internal_error", error.message);
        }
        throw error;
      }
    },
    resources: () => buildResourceSnapshot(ctx),
  });

  const result = await handler(rpc);
  if (result === null) {
    // JSON-RPC notification (e.g. notifications/initialized) → 202, no body.
    response.writeHead(202);
    response.end();
    return true;
  }
  return json(response, 200, result), true;
}

/**
 * GET /api/v1/agent/session/:terminalId/last-command — the last completed
 * CommandResult for a terminal, or null. Lets an agent ask "what was the last
 * exit code?" without reading the full scrollback. 404 when the terminal is
 * not in the dock; 200 with null when it is but has no rich lifecycle yet.
 */
async function handleSessionLastCommand(
  response: ServerResponse,
  ctx: AgentApiContext,
  terminalId: string,
): Promise<boolean> {
  try {
    const layout = await ctx.operations.getDockLayout?.() as DockLayout | undefined;
    if (!layout) return json(response, 500, { ok: false, error: "Dock layout unavailable." }), true;
    if (!layout.tiles.some((t) => t.terminalId === terminalId)) {
      return json(response, 404, { ok: false, error: "Terminal not in dock." }), true;
    }
    const lastCommand = safeCommandResult(
      await Promise.resolve(ctx.operations.getLastCommand?.(terminalId) ?? null),
    );
    return json(response, 200, { ok: true, lastCommand }), true;
  } catch {
    return json(response, 500, { ok: false, error: "Failed to get last command." }), true;
  }
}

/**
 * GET /api/v1/agent/session/:terminalId/state-explain — explain the current
 * canonical state without exposing terminal text, regex matches, or evidence.
 */
async function handleSessionStateExplain(
  response: ServerResponse,
  ctx: AgentApiContext,
  terminalId: string,
): Promise<boolean> {
  try {
    const explanation = await readAgentStateExplanation(ctx, terminalId);
    if (explanation === null) {
      return json(response, 404, { ok: false, error: "Terminal not found." }), true;
    }
    return json(response, 200, { ok: true, explanation }), true;
  } catch {
    return json(response, 500, { ok: false, error: "Failed to explain terminal state." }), true;
  }
}

/** Reuse the v1.0.8 explanation operation and redact all free-form fields. */
async function readAgentStateExplanation(
  ctx: AgentApiContext,
  terminalId: string,
): Promise<AgentStateExplanation | null> {
  const raw = await Promise.resolve(
    ctx.operations.getAgentStateExplanation?.(terminalId) ?? null,
  );
  if (raw === null) return null;
  const parsed = agentStateExplanationSchema.parse(raw);
  const redactNullable = (value: string | null): string | null =>
    value === null ? null : redactEgress(value);
  return agentStateExplanationSchema.parse({
    ...parsed,
    agentProfile: redactNullable(parsed.agentProfile),
    matchedRuleId: redactNullable(parsed.matchedRuleId),
    fallbackReason: redactNullable(parsed.fallbackReason),
    manifestVersion: redactNullable(parsed.manifestVersion),
  });
}


/**
 * GET /api/v1/agent/session/:terminalId/wait?state=...&timeout=...&stopOn=...&match=...&staleAfterSec=...
 *
 * Event-driven, cancellable wait for a terminal. Resolves with one of:
 * matched | interrupted | timeout | closed | shutdown | match | stale.
 * Any condition resolving first wins (issue #61).
 *
 * Query params:
 *   state         (one of state/match/staleAfterSec required) — target
 *                 canonical PtyState (starting/running/...)
 *   timeout       (optional) — seconds, default 60, integer range [1, 300]
 *   stopOn        (optional) — comma-separated canonical states that resolve
 *                 "interrupted". Defaults to error, blocked,
 *                 approval_required, waiting_input, excluding target.
 *   match         (optional) — regex (multiline) over NEW scrollback output;
 *                 first hit resolves "match" with result.match = {line, offset}
 *                 (offset counts output appended since the wait began).
 *   staleAfterSec (optional) — resolves "stale" after N seconds without
 *                 scrollback growth, counted from wait start.
 *
 * Read-only: never writes to the terminal. The HTTP connection close aborts
 * the wait (resolved "interrupted"), so a caller can cancel with TCP FIN.
 *
 * Errors: 400 invalid state/timeout/stopOn/match/staleAfterSec; 404 terminal
 * not in dock or coordinator unavailable; 429 per-session (4) or global (32)
 * limit exceeded.
 */
async function handleSessionWait(
  request: IncomingMessage,
  response: ServerResponse,
  ctx: AgentApiContext,
  terminalId: string,
): Promise<boolean> {
  const coordinator = ctx.waitCoordinator;
  if (!coordinator) {
    return json(response, 404, { ok: false, error: { code: "WAIT_UNAVAILABLE", message: "Session wait is not available." } }), true;
  }

  const url = new URL(request.url ?? "/", "http://localhost");
  const params = url.searchParams;

  // --- Validate wait conditions (issue #61): at least one of
  // state / match / staleAfterSec. Any condition resolving first wins. ---
  const stateParam = params.get("state");
  const matchParam = params.get("match");
  const staleAfterParam = params.get("staleAfterSec");
  if (!stateParam && matchParam === null && staleAfterParam === null) {
    return json(response, 400, { ok: false, error: { code: "MISSING_STATE", message: "At least one of 'state', 'match', or 'staleAfterSec' is required." } }), true;
  }
  let targetState: PtyState | undefined;
  if (stateParam) {
    const targetParse = ptyStateSchema.safeParse(stateParam);
    if (!targetParse.success) {
      return json(response, 400, { ok: false, error: { code: "INVALID_STATE", message: `'state' must be a canonical PtyState: ${ptyStateSchema.options.join(", ")}.` } }), true;
    }
    targetState = targetParse.data;
  }

  // --- Validate match (regex over NEW scrollback output, multiline). ---
  let match: RegExp | undefined;
  if (matchParam !== null) {
    if (matchParam.length === 0 || matchParam.length > WAIT_MAX_MATCH_PATTERN_CHARS) {
      return json(response, 400, {
        ok: false,
        error: { code: "INVALID_MATCH", message: `'match' must be a non-empty regex of at most ${WAIT_MAX_MATCH_PATTERN_CHARS} chars.` },
      }), true;
    }
    try {
      match = new RegExp(matchParam, "m");
    } catch {
      return json(response, 400, { ok: false, error: { code: "INVALID_MATCH", message: "'match' is not a valid regular expression." } }), true;
    }
  }

  // --- Validate staleAfterSec (integer seconds, 1..300). ---
  let staleAfterMs: number | undefined;
  if (staleAfterParam !== null) {
    const parsed = Number(staleAfterParam);
    if (
      !Number.isSafeInteger(parsed)
      || parsed < WAIT_MIN_STALE_SECONDS
      || parsed > WAIT_MAX_STALE_SECONDS
    ) {
      return json(response, 400, {
        ok: false,
        error: {
          code: "INVALID_STALE_AFTER",
          message: `'staleAfterSec' must be an integer number of seconds from ${WAIT_MIN_STALE_SECONDS} to ${WAIT_MAX_STALE_SECONDS}.`,
        },
      }), true;
    }
    staleAfterMs = parsed * 1000;
  }

  // --- Validate timeout. ---
  const timeoutParam = params.get("timeout");
  let timeoutSeconds = WAIT_DEFAULT_TIMEOUT_SECONDS;
  if (timeoutParam !== null) {
    const parsed = Number(timeoutParam);
    if (
      !Number.isSafeInteger(parsed)
      || parsed < WAIT_MIN_TIMEOUT_SECONDS
      || parsed > WAIT_MAX_TIMEOUT_SECONDS
    ) {
      return json(response, 400, {
        ok: false,
        error: {
          code: "INVALID_TIMEOUT",
          message: `'timeout' must be an integer number of seconds from ${WAIT_MIN_TIMEOUT_SECONDS} to ${WAIT_MAX_TIMEOUT_SECONDS}.`,
        },
      }), true;
    }
    timeoutSeconds = parsed;
  }
  const timeoutMs = timeoutSeconds * 1000;

  // --- Validate stopOn (comma-separated canonical states). ---
  const stopOnParam = params.get("stopOn");
  let stopOn: Set<PtyState>;
  if (stopOnParam !== null) {
    stopOn = new Set();
    const tokens = stopOnParam.split(",").map((t) => t.trim()).filter((t) => t.length > 0);
    for (const token of tokens) {
      const parsed = ptyStateSchema.safeParse(token);
      if (!parsed.success) {
        return json(response, 400, { ok: false, error: { code: "INVALID_STOPON", message: `'stopOn' entry '${token}' is not a canonical PtyState.` } }), true;
      }
      stopOn.add(parsed.data);
    }
    // The target is always a match — never a stop state.
    if (targetState !== undefined) stopOn.delete(targetState);
    if (stopOn.size === 0) {
      return json(response, 400, { ok: false, error: { code: "EMPTY_STOPON", message: "'stopOn' must list at least one state other than the target." } }), true;
    }
  } else {
    stopOn = new Set(DEFAULT_WAIT_STOP_STATES);
    if (targetState !== undefined) stopOn.delete(targetState);
  }

  if (coordinator.isShutdown()) {
    return json(response, 503, {
      ok: false,
      error: { code: "WAIT_SHUTDOWN", message: "Session wait is shutting down." },
    }), true;
  }

  // --- Terminal must be in the dock (404 otherwise). ---
  try {
    const layout = await ctx.operations.getDockLayout?.() as DockLayout | undefined;
    if (!layout) return json(response, 500, { ok: false, error: "Dock layout unavailable." }), true;
    if (!layout.tiles.some((tile) => tile.terminalId === terminalId)) {
      return json(response, 404, { ok: false, error: "Terminal not in dock." }), true;
    }
    if (!coordinator.hasSession(terminalId)) {
      return json(response, 404, { ok: false, error: "Terminal not found." }), true;
    }
  } catch {
    return json(response, 500, { ok: false, error: "Failed to read dock layout." }), true;
  }

  // --- Concurrency limits: 4 per session, 32 global. ---
  if (coordinator.wouldExceedLimits(terminalId)) {
    const perSession = coordinator.pendingFor(terminalId);
    const total = coordinator.pendingTotal();
    const reason = perSession >= 4 ? "per-session" : "global";
    return json(response, 429, {
      ok: false,
      error: { code: "WAIT_LIMIT_EXCEEDED", message: `Too many concurrent waits (${reason}).` },
      limits: { perSession, perSessionMax: 4, global: total, globalMax: 32 },
    }), true;
  }

  // --- Abort on HTTP connection close (caller cancels via TCP FIN). ---
  const abortController = new AbortController();
  const onAbort = () => abortController.abort();
  request.on("aborted", onAbort);
  response.on("close", onAbort);

  try {
    const result = await coordinator.waitFor({
      terminalId,
      ...(targetState !== undefined ? { targetState } : {}),
      stopOn,
      timeoutMs,
      abortSignal: abortController.signal,
      ...(match ? { match } : {}),
      ...(staleAfterMs !== undefined ? { staleAfterMs } : {}),
    });
    if (!response.headersSent) {
      let explanation: AgentStateExplanation | Record<string, never> = {};
      try {
        explanation = await readAgentStateExplanation(ctx, terminalId) ?? {};
      } catch {
        // Waiting remains a normal outcome even if explanation generation is
        // unavailable. Keep the field present without exposing unvalidated data.
      }
      return json(response, 200, { ok: true, result: { ...result, explanation } }), true;
    }
    return true;
  } catch {
    if (!response.headersSent) {
      return json(response, 500, { ok: false, error: { code: "WAIT_FAILED", message: "Session wait failed." } }), true;
    }
    return true;
  } finally {
    request.off("aborted", onAbort);
    response.off("close", onAbort);
  }
}

/** POST /api/v1/agent/session/:id/handoff-packet — read-only PTY handoff. */
async function handleTerminalHandoff(
  request: IncomingMessage,
  response: ServerResponse,
  ctx: AgentApiContext,
  terminalId: string,
): Promise<boolean> {
  if (!ctx.handoffService) {
    return json(response, 404, { ok: false, error: "Terminal handoff is unavailable." }), true;
  }
  if (takeAgentBudget(request, response, "terminal").refused) return true;
  const body = await readBody(request);
  if (body === null) return json(response, 413, { ok: false, error: "Request too large." }), true;
  let parsed: TerminalHandoffRequest;
  try {
    parsed = terminalHandoffRequestSchema.parse(JSON.parse(body || "{}"));
  } catch (error) {
    const message = error instanceof ZodError ? "Invalid terminal handoff request." : "Invalid JSON.";
    return json(response, 400, { ok: false, error: message }), true;
  }

  const controller = new AbortController();
  const onAbort = () => controller.abort();
  const onResponseClose = () => { if (!response.writableEnded) controller.abort(); };
  request.on("aborted", onAbort);
  response.on("close", onResponseClose);
  try {
    const result = await ctx.handoffService.create(terminalId, parsed, controller.signal);
    if (!response.headersSent) return json(response, 200, { ok: true, ...result }), true;
    return true;
  } catch (error) {
    if (response.headersSent) return true;
    if (error instanceof TerminalHandoffError) {
      const status = error.code === "NOT_FOUND" ? 404
        : error.code === "BUSY" || error.code === "RATE_LIMITED" ? 429
          : error.code === "ABORTED" ? 499
            : error.code === "TIMEOUT" ? 504
              : 409;
      return json(response, status, { ok: false, error: { code: error.code, message: error.message } }), true;
    }
    return json(response, 500, { ok: false, error: "Terminal handoff failed." }), true;
  } finally {
    request.off("aborted", onAbort);
    response.off("close", onResponseClose);
  }
}
/** Runtime-validate and redact the complete command payload at Agent API egress. */
function safeCommandResult(value: unknown) {
  if (value === null || value === undefined) return null;
  const redacted = redactEgressValue(value);
  return commandResultSchema.parse(redacted);
}

/** POST /api/v1/agent/session/:terminalId/close — close a terminal tile. */
async function handleSessionClose(
  request: IncomingMessage,
  response: ServerResponse,
  ctx: AgentApiContext,
  terminalId: string,
): Promise<boolean> {
  if (takeAgentBudget(request, response, "terminal").refused) return true;

  const body = await readBody(request);
  if (body === null) return json(response, 413, { ok: false, error: "Request too large." }), true;

  let allowUserTerminal: boolean;
  try {
    const parsed = body.trim() ? JSON.parse(body) as { allowUserTerminal?: unknown } : {};
    allowUserTerminal = parsed.allowUserTerminal === true;
  } catch {
    return json(response, 400, { ok: false, error: "Invalid JSON." }), true;
  }

  try {
    const layout = await ctx.operations.getDockLayout?.() as DockLayout | undefined;
    if (!layout) return json(response, 500, { ok: false, error: "Dock layout unavailable." }), true;
    if (!layout.tiles.some((tile) => tile.terminalId === terminalId)) {
      return json(response, 404, { ok: false, error: "Terminal not in dock." }), true;
    }
    const ownedByAgentApi = agentOwnedTerminalIds.has(terminalId);
    if (!ownedByAgentApi && !allowUserTerminal) {
      return json(response, 409, {
        ok: false,
        error: "Refusing to close a user-opened terminal without explicit approval.",
        needsUserApproval: true,
      }), true;
    }
    const nextLayout = await ctx.operations.closeTile?.({ terminalId }) as DockLayout | undefined;
    agentOwnedTerminalIds.delete(terminalId);
    const terminalCount = nextLayout?.tiles.length ?? Math.max(0, layout.tiles.length - 1);
    return json(response, 200, {
      ok: true,
      selectedTerminalId: nextLayout?.selectedTerminalId ?? null,
      maxTerminals: MAX_TERMINALS,
      terminalCount,
      availableSlots: Math.max(0, MAX_TERMINALS - terminalCount),
      canCreate: terminalCount < MAX_TERMINALS,
    }), true;
  } catch (error) {
    const message = error instanceof Error ? error.message : "Close failed.";
    return json(response, message.includes("not found") ? 404 : 500, { ok: false, error: message }), true;
  }
}

async function listDockTerminals(ctx: AgentApiContext): Promise<{
  layout: DockLayout;
  terminals: Array<TerminalInfo & { weight: number; ownedByAgentApi: boolean }>;
}> {
  const layout = await ctx.operations.getDockLayout?.() as DockLayout | undefined;
  if (!layout) throw new Error("Dock layout unavailable.");

  const byProject = new Map<string, { terminalId: string; weight: number }[]>();
  for (const tile of layout.tiles) {
    const arr = byProject.get(tile.projectId) ?? [];
    arr.push({ terminalId: tile.terminalId, weight: tile.weight });
    byProject.set(tile.projectId, arr);
  }

  const terminals: Array<TerminalInfo & { weight: number; ownedByAgentApi: boolean }> = [];
  for (const [projectId, tiles] of byProject) {
    const infos = ctx.operations.listTerminals?.(projectId) as TerminalInfo[] | undefined;
    if (!infos) continue;
    const weightMap = new Map(tiles.map((tile) => [tile.terminalId, tile.weight]));
    for (const info of infos) {
      const weight = weightMap.get(info.id);
      if (weight !== undefined) {
        terminals.push({ ...info, weight, ownedByAgentApi: agentOwnedTerminalIds.has(info.id) });
      }
    }
  }
  for (const id of [...agentOwnedTerminalIds]) {
    if (!terminals.some((terminal) => terminal.id === id)) agentOwnedTerminalIds.delete(id);
  }
  return { layout, terminals };
}

// --- AgentApi fixed workflow handlers (issue #6) ----------------------------

async function handleCreateWorkflow(
  request: IncomingMessage,
  response: ServerResponse,
  ctx: AgentApiContext,
): Promise<boolean> {
  if (!ctx.agentapi) return json(response, 503, { ok: false, error: "AgentApi orchestrator is unavailable." }), true;
  if (takeAgentBudget(request, response, "terminal").refused) return true;
  const body = await readBody(request);
  if (body === null) return json(response, 413, { ok: false, error: "Request too large." }), true;
  try {
    const input = JSON.parse(body || "{}") as unknown;
    const workflow = await ctx.agentapi.create(input);
    return json(response, 202, { ok: true, workflow: redactAgentApiWorkflow(workflow) }), true;
  } catch (error) {
    if (error instanceof ZodError || error instanceof SyntaxError) {
      return json(response, 400, { ok: false, error: "Invalid workflow request." }), true;
    }
    if (error instanceof AgentApiConflictError || (error instanceof Error && error.message.includes("idempotency"))) {
      return json(response, 409, { ok: false, error: safeErrorMessage(error) }), true;
    }
    return json(response, 500, { ok: false, error: "Workflow creation failed." }), true;
  }
}

function handleGetWorkflow(
  response: ServerResponse,
  ctx: AgentApiContext,
  workflowId: string,
): boolean {
  if (!ctx.agentapi) return json(response, 503, { ok: false, error: "AgentApi orchestrator is unavailable." }), true;
  try {
    const result = ctx.agentapi.get(workflowId);
    return json(response, 200, {
      ok: true,
      workflow: redactAgentApiWorkflow(result.workflow),
      steps: result.steps.map((step) => ({
        ...step,
        outcome: redactAgentApiOutcome(step.outcome, result.workflow.worktreePath),
      })),
    }), true;
  } catch (error) {
    if (error instanceof AgentApiNotFoundError) {
      return json(response, 404, { ok: false, error: "AgentApi workflow not found." }), true;
    }
    return json(response, 500, { ok: false, error: "Workflow read failed." }), true;
  }
}

async function handleWorkflowMutation(
  request: IncomingMessage,
  response: ServerResponse,
  ctx: AgentApiContext,
  workflowId: string,
  action: "resume" | "pause" | "cancel",
): Promise<boolean> {
  if (!ctx.agentapi) return json(response, 503, { ok: false, error: "AgentApi orchestrator is unavailable." }), true;
  if (takeAgentBudget(request, response, "terminal").refused) return true;
  const body = await readBody(request);
  if (body === null) return json(response, 413, { ok: false, error: "Request too large." }), true;
  if (body.trim()) {
    try { JSON.parse(body); } catch { return json(response, 400, { ok: false, error: "Invalid JSON." }), true; }
  }
  try {
    const workflow = await ctx.agentapi[action](workflowId);
    return json(response, 200, { ok: true, workflow: redactAgentApiWorkflow(workflow) }), true;
  } catch (error) {
    if (error instanceof AgentApiNotFoundError) {
      return json(response, 404, { ok: false, error: "AgentApi workflow not found." }), true;
    }
    if (error instanceof AgentApiConflictError) {
      return json(response, 409, { ok: false, error: safeErrorMessage(error) }), true;
    }
    return json(response, 500, { ok: false, error: "Workflow mutation failed." }), true;
  }
}

function redactAgentApiWorkflow<T extends {
  task: string;
  worktreePath: string | null;
  lastOutcome: { code: string; reason: string; review?: unknown } | null;
}>(workflow: T): T {
  return {
    ...workflow,
    task: redactAgentApiText(workflow.task, workflow.worktreePath),
    worktreePath: workflow.worktreePath ? "[PATH REDACTED]" : null,
    lastOutcome: redactAgentApiOutcome(workflow.lastOutcome, workflow.worktreePath),
  };
}

function redactAgentApiOutcome<T>(outcome: T, workspacePath: string | null): T {
  if (!outcome || typeof outcome !== "object") return outcome;
  const value = outcome as Record<string, unknown>;
  const review = value.review && typeof value.review === "object"
    ? redactAgentApiReview(value.review as Record<string, unknown>, workspacePath)
    : value.review;
  return {
    ...value,
    reason: typeof value.reason === "string" ? redactAgentApiText(value.reason, workspacePath) : value.reason,
    ...(review === undefined ? {} : { review }),
  } as T;
}

function redactAgentApiReview(review: Record<string, unknown>, workspacePath: string | null): Record<string, unknown> {
  const text = (value: unknown): unknown => typeof value === "string" ? redactAgentApiText(value, workspacePath) : value;
  return {
    ...review,
    summary: text(review.summary),
    verification: Array.isArray(review.verification) ? review.verification.map(text) : review.verification,
    findings: Array.isArray(review.findings) ? (review.findings as unknown[]).map((finding) => {
      if (!finding || typeof finding !== "object") return finding;
      const value = finding as Record<string, unknown>;
      return { ...value, file: text(value.file), message: text(value.message), suggestedFix: text(value.suggestedFix) };
    }) : review.findings,
  };
}

function redactAgentApiText(value: string, workspacePath: string | null): string {
  return redactSummaryText(value, workspacePath ?? "__COTERM_NO_WORKSPACE_PATH__");
}

// --- A — Worktree sandbox handlers -----------------------------------------

/** GET /api/v1/agent/worktrees?projectId= — list worktrees for a project. */
async function handleListWorktrees(
  response: ServerResponse,
  ctx: AgentApiContext,
  url: URL,
): Promise<boolean> {
  try {
    const projectId = url.searchParams.get("projectId");
    if (!projectId) {
      return json(response, 400, { ok: false, error: "Query parameter 'projectId' is required." }), true;
    }
    const worktrees = await ctx.operations.listWorktrees?.({ projectId }) as unknown[];
    return json(response, 200, { ok: true, worktrees: worktrees ?? [] }), true;
  } catch (error) {
    return json(response, 500, { ok: false, error: error instanceof Error ? error.message : "Failed to list worktrees." }), true;
  }
}

/** POST /api/v1/agent/worktrees — create a worktree sandbox (rate-limited). */
async function handleCreateWorktree(
  request: IncomingMessage,
  response: ServerResponse,
  ctx: AgentApiContext,
): Promise<boolean> {
  if (takeAgentBudget(request, response, "terminal").refused) return true;
  const body = await readBody(request);
  if (body === null) return json(response, 413, { ok: false, error: "Request too large." }), true;
  let parsed: { projectId?: unknown; branch?: unknown; baseRef?: unknown; permissionsPreset?: unknown };
  try {
    parsed = body.trim() ? JSON.parse(body) as typeof parsed : {};
  } catch {
    return json(response, 400, { ok: false, error: "Invalid JSON." }), true;
  }
  if (typeof parsed.projectId !== "string" || parsed.projectId.length === 0) {
    return json(response, 400, { ok: false, error: "Field 'projectId' must be a non-empty string." }), true;
  }
  try {
    const worktree = await ctx.operations.createWorktree?.({
      projectId: parsed.projectId,
      ...(typeof parsed.branch === "string" && parsed.branch ? { branch: parsed.branch } : {}),
      ...(typeof parsed.baseRef === "string" && parsed.baseRef ? { baseRef: parsed.baseRef } : {}),
      ...(typeof parsed.permissionsPreset === "string" ? { permissionsPreset: parsed.permissionsPreset as "ask" | "trusted" } : {}),
    });
    return json(response, 200, { ok: true, worktree }), true;
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to create worktree.";
    return json(response, message.includes("not found") || message.includes("Invalid") ? 400 : 500, { ok: false, error: message }), true;
  }
}

/** GET /api/v1/agent/worktrees/:id — worktree detail. */
async function handleGetWorktree(
  response: ServerResponse,
  ctx: AgentApiContext,
  worktreeId: string,
): Promise<boolean> {
  try {
    const worktree = await ctx.operations.getWorktree?.({ worktreeId });
    if (!worktree) return json(response, 404, { ok: false, error: "Worktree not found." }), true;
    return json(response, 200, { ok: true, worktree }), true;
  } catch (error) {
    return json(response, 500, { ok: false, error: error instanceof Error ? error.message : "Failed to get worktree." }), true;
  }
}

/** GET /api/v1/agent/worktrees/:id/diff — pre-merge diff summary. */
async function handleWorktreeDiff(
  response: ServerResponse,
  ctx: AgentApiContext,
  worktreeId: string,
): Promise<boolean> {
  try {
    const summary = await ctx.operations.worktreeDiffSummary?.({ worktreeId });
    return json(response, 200, { ok: true, summary }), true;
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to compute diff.";
    return json(response, message.includes("not found") || message.includes("active") ? 409 : 500, { ok: false, error: message }), true;
  }
}

/** POST /api/v1/agent/worktrees/:id/merge — merge (rate-limited; requires confirm). */
async function handleMergeWorktree(
  request: IncomingMessage,
  response: ServerResponse,
  ctx: AgentApiContext,
  worktreeId: string,
): Promise<boolean> {
  if (takeAgentBudget(request, response, "terminal").refused) return true;
  const body = await readBody(request);
  if (body === null) return json(response, 413, { ok: false, error: "Request too large." }), true;
  let parsed: { confirm?: unknown };
  try {
    parsed = body.trim() ? JSON.parse(body) as typeof parsed : {};
  } catch {
    return json(response, 400, { ok: false, error: "Invalid JSON." }), true;
  }
  if (parsed.confirm !== true) {
    return json(response, 400, { ok: false, error: "Field 'confirm' must be true. Review the diff summary first." }), true;
  }
  try {
    const worktree = await ctx.operations.mergeWorktree?.({ worktreeId, confirm: true });
    return json(response, 200, { ok: true, worktree }), true;
  } catch (error) {
    const message = error instanceof Error ? error.message : "Merge failed.";
    const status = message.includes("conflict") ? 409
      : message.includes("not found") || message.includes("active") || message.includes("running") || message.includes("dirty") ? 400 : 500;
    return json(response, status, { ok: false, error: message }), true;
  }
}

/** POST /api/v1/agent/worktrees/:id/abort — abort (rate-limited). */
async function handleAbortWorktree(
  request: IncomingMessage,
  response: ServerResponse,
  ctx: AgentApiContext,
  worktreeId: string,
): Promise<boolean> {
  if (takeAgentBudget(request, response, "terminal").refused) return true;
  await readBody(request);
  try {
    const worktree = await ctx.operations.abortWorktree?.({ worktreeId });
    return json(response, 200, { ok: true, worktree }), true;
  } catch (error) {
    const message = error instanceof Error ? error.message : "Abort failed.";
    return json(response, message.includes("not found") || message.includes("active") || message.includes("running") ? 400 : 500, { ok: false, error: message }), true;
  }
}

/** POST /api/v1/agent/worktrees/:id/cleanup — cleanup (rate-limited). */
async function handleCleanupWorktree(
  request: IncomingMessage,
  response: ServerResponse,
  ctx: AgentApiContext,
  worktreeId: string,
): Promise<boolean> {
  if (takeAgentBudget(request, response, "terminal").refused) return true;
  await readBody(request);
  try {
    await ctx.operations.cleanupWorktree?.({ worktreeId });
    return json(response, 200, { ok: true }), true;
  } catch (error) {
    const message = error instanceof Error ? error.message : "Cleanup failed.";
    const status = /running|uncommitted|not found|refus/i.test(message) ? 400 : 500;
    return json(response, status, { ok: false, error: message }), true;
  }
}

/**
 * POST /api/v1/agent/worktrees/:id/resume — trusted resume (rate-limited).
 * Returns the rebuilt launch command for the bound session. The command is
 * rebuilt from the profile allowlist + sessionId; the persisted resume_command
 * is never executed verbatim.
 */
async function handleResumeWorktree(
  request: IncomingMessage,
  response: ServerResponse,
  ctx: AgentApiContext,
  worktreeId: string,
): Promise<boolean> {
  if (takeAgentBudget(request, response, "terminal").refused) return true;
  const body = await readBody(request);
  if (body === null) return json(response, 413, { ok: false, error: "Request too large." }), true;
  let terminalId: unknown;
  try {
    const parsed: unknown = body ? JSON.parse(body) : {};
    terminalId = parsed && typeof parsed === "object" && "terminalId" in parsed
      ? (parsed as { terminalId?: unknown }).terminalId
      : undefined;
  } catch {
    return json(response, 400, { ok: false, error: "Invalid JSON." }), true;
  }
  if (typeof terminalId !== "string") {
    return json(response, 400, { ok: false, error: "terminalId is required." }), true;
  }
  try {
    const result = await ctx.operations.resumeWorktree?.({ worktreeId, terminalId }) as { command: string; worktree: unknown } | undefined;
    if (!result) return json(response, 500, { ok: false, error: "Resume unavailable." }), true;
    return json(response, 200, { ok: true, command: result.command, worktree: result.worktree }), true;
  } catch (error) {
    const message = error instanceof Error ? error.message : "Resume failed.";
    return json(response, message.includes("not found") || message.includes("active") || message.includes("missing") || message.includes("allowed") ? 400 : 500, { ok: false, error: message }), true;
  }
}

/** POST /api/v1/agent/session/:terminalId/input — write keystrokes (rate-limited). */
async function handleSessionInput(
  request: IncomingMessage,
  response: ServerResponse,
  ctx: AgentApiContext,
  terminalId: string,
): Promise<boolean> {
  // Rate limit with a dedicated map (separate from RPC mutation quota).
  if (takeAgentBudget(request, response, "terminal").refused) return true;

  const body = await readBody(request);
  if (body === null) return json(response, 413, { ok: false, error: "Request too large." }), true;

  let parsed: { data?: unknown; enter?: unknown; clientMutationId?: unknown };
  try {
    parsed = JSON.parse(body) as { data?: unknown; enter?: unknown; clientMutationId?: unknown };
  } catch {
    return json(response, 400, { ok: false, error: "Invalid JSON." }), true;
  }

  if (typeof parsed.data !== "string" || parsed.data.length === 0) {
    return json(response, 400, { ok: false, error: "Field 'data' must be a non-empty string." }), true;
  }
  if (parsed.data.length > MAX_BODY_BYTES) {
    return json(response, 413, { ok: false, error: "Input too large." }), true;
  }

  // Phase 5 (§10.4): exact-once contract. Callers that retry over HTTP send a
  // stable clientMutationId; AppOperations dedupes same id + same payload and
  // conflicts same id + different payload. Optional to stay backwards
  // compatible with existing clients.
  let clientMutationId: string | undefined;
  if (parsed.clientMutationId !== undefined) {
    if (typeof parsed.clientMutationId !== "string" ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(parsed.clientMutationId)) {
      return json(response, 400, { ok: false, error: "Field 'clientMutationId' must be a UUID." }), true;
    }
    clientMutationId = parsed.clientMutationId;
  }

  const enter = parsed.enter === true;
  const data = parsed.data + (enter ? "\r" : "");

  try {
    const result = ctx.operations.writeTerminal?.({ terminalId, data, source: "automation", clientMutationId }) as
      { status?: string } | undefined;
    return json(response, 200, { ok: true, deduped: result?.status === "deduped" }), true;
  } catch (error) {
    const message = error instanceof Error ? error.message : "Write failed.";
    if (error instanceof TerminalMutationConflictError) {
      return json(response, 409, { ok: false, error: message, code: "mutation_conflict" }), true;
    }
    // PTY exited → 409 Conflict; other errors → 500.
    if (message.includes("exited") || message.includes("not found")) {
      return json(response, 409, { ok: false, error: message }), true;
    }
    return json(response, 500, { ok: false, error: "Write failed." }), true;
  }
}
