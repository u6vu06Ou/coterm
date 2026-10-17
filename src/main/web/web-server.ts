import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { readFile } from "node:fs/promises";
import { extname, resolve, sep } from "node:path";
import { isRpcMethod, type WebOperations } from "./routes";
import type { AppEventBus } from "../core/event-bus";
import { attachLiveSocket, type DockLayoutAccessor, type AttentionAccessor, type UsageAccessor, type AgentApiWorldAccessor } from "./live-socket";
import { agentApi, createAgentRateBuckets, type AgentRateBuckets } from "./agent-api";
import { handleAgentMailRequest } from "./agent-mail";
import type { AgentMailbox } from "../core/agent-mailbox";
import { resolveArtifactPreviewToken } from "./artifact-preview-tokens";
import type { SessionWaitCoordinator } from "../core/session-wait-coordinator";
import type { TerminalHandoffService } from "../core/terminal-handoff-service";
import type { AgentApiOrchestrator } from "../core/agentapi-orchestrator";
import type { AccessVerifier } from "./access-auth";
import type { AppSettings } from "../../shared/types";
import type { BrowserRuntimeManager } from "../browser/browser-runtime-manager";
import type { PtyManager } from "../terminal/pty-manager";

const HOST = "127.0.0.1";
export const MAX_BODY_BYTES = 1_000_000;

interface WebServerOptions {
  port: number;
  allowedOrigin: string;
  allowedHosts?: string[];
  verifyAccess: AccessVerifier;
  operations: WebOperations;
  rendererPath?: string;
  mutationLimit?: number;
  uiActionLimit?: number;
  events?: AppEventBus;
  /** Resolved listening port (set after server.listen). Used for Host-header allowlist. */
  agentApiPort?: number;
  /** Reads current settings for agentApi enabled flag + token. */
  getSettings?: () => AppSettings;
  /** Optional session wait coordinator (issue #4). Closed on server shutdown. */
  waitCoordinator?: SessionWaitCoordinator;
  /** Optional privacy-safe Terminal Handoff Packet service (issue #5). */
  handoffService?: Pick<TerminalHandoffService, "create">;
  /** Optional persistent AgentApi workflow service (issue #6). */
  agentapi?: Pick<AgentApiOrchestrator, "create" | "get" | "resume" | "pause" | "cancel" | "shutdown">;
  /** Pushes dock-layout mutations (incl. tile selection) to web clients over WS. */
  dockLayout?: DockLayoutAccessor;
  /** Pushes attention notifications (file/resolve) + replays unresolved on connect. */
  attention?: AttentionAccessor;
  /** Pushes paid-account usage snapshot (10s poll) + sends current on connect. */
  usage?: UsageAccessor;
  /** Phase 6: AgentApi world snapshot on connect + coalesced pushes. */
  agentapiWorld?: AgentApiWorldAccessor;
  browser?: BrowserRuntimeManager;
  /** Bounded terminal views for the agent API scrollbackMode contract (issue #13). */
  terminals?: Pick<PtyManager, "getScrollbackMode" | "getScreenSnapshot">;
  /** Cross-pane agent mail (@-mentions). Loopback + per-pane token, independent
   *  of the agentApi enabled toggle. */
  mailbox?: AgentMailbox;
}

export interface RunningWebServer {
  host: typeof HOST;
  port: number;
  close(): Promise<void>;
}

export async function startWebServer(options: WebServerOptions): Promise<RunningWebServer> {
  const mutations = new Map<string, { count: number; resetAt: number }>();
  const uiActions = new Map<string, { count: number; resetAt: number }>();
  // Issue #93: the agent API's two mutation buckets live per server, exactly
  // like the RPC maps above — a module-global would leak quota between servers.
  const agentRateBuckets = createAgentRateBuckets();
  const server = createServer((request, response) => {
    void handleRequest(request, response, options, mutations, uiActions, agentRateBuckets);
  });
  const closeLiveSocket = options.events ? attachLiveSocket(server, {
    allowedOrigin: options.allowedOrigin,
    ...(options.allowedHosts ? { allowedHosts: options.allowedHosts } : {}),
    verifyAccess: options.verifyAccess,
    operations: options.operations,
    events: options.events,
    ...(options.dockLayout ? { dockLayout: options.dockLayout } : {}),
    ...(options.attention ? { attention: options.attention } : {}),
    ...(options.usage ? { usage: options.usage } : {}),
    ...(options.agentapiWorld ? { agentapiWorld: options.agentapiWorld } : {}),
  }) : () => undefined;
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port, HOST, () => resolve());
  });
  const port = (server.address() as AddressInfo).port;
  options.agentApiPort = port;
  return {
    host: HOST,
    port,
    close: async () => {
      closeLiveSocket();
      await options.agentapi?.shutdown();
      options.waitCoordinator?.shutdown();
      return new Promise<void>((resolve, reject) =>
        server.close((error) => error ? reject(error) : resolve()),
      );
    },
  };
}

async function handleRequest(
  request: IncomingMessage,
  response: ServerResponse,
  options: WebServerOptions,
  mutations: Map<string, { count: number; resetAt: number }>,
  uiActions: Map<string, { count: number; resetAt: number }>,
  agentRateBuckets: AgentRateBuckets,
): Promise<void> {
  try {
    setSecurityHeaders(response);
    if (request.method === "GET" && request.url === "/health") {
      return json(response, 200, { status: "ok" });
    }
    // Agent API branches BEFORE verifyAccess so local agents don't need a Cloudflare JWT.
    if (request.url?.startsWith("/api/v1/agent/")) {
      const handled = await agentApi.handle(request, response, {
        operations: options.operations,
        getSettings: () => options.getSettings?.() as AppSettings,
        port: options.agentApiPort ?? options.port,
        ...(options.waitCoordinator ? { waitCoordinator: options.waitCoordinator } : {}),
        ...(options.handoffService ? { handoffService: options.handoffService } : {}),
        ...(options.agentapi ? { agentapi: options.agentapi } : {}),
        ...(options.browser ? { browser: options.browser } : {}),
        ...(options.terminals ? { terminals: options.terminals } : {}),
        rateBuckets: agentRateBuckets,
      });
      if (handled) return;
    }
    // Agent mail (@-mentions between agent panes). Loopback-only + per-pane
    // token minted by the mailbox itself, so it must work even when the
    // Settings "Agent API" toggle is off — it deliberately bypasses
    // agentApi.handle's enabled gate. Same pre-verifyAccess slot as
    // /artifact-preview/ below.
    if (options.mailbox && request.url?.startsWith("/api/v1/mail/")) {
      if (!isLoopback(request.socket.remoteAddress)) {
        return json(response, 403, { ok: false, error: "Agent mail is loopback-only." });
      }
      if (!hostAllowed(request, options.allowedHosts)) {
        return json(response, 403, { ok: false, error: "Host not allowed." });
      }
      return handleAgentMailRequest(request, response, { mailbox: options.mailbox });
    }
    // Artifact preview is loopback-only and the token IS the authorisation (minted in-process
    // after assertAllowedPath), so it runs before verifyAccess like the agent API does.
    if (request.method === "GET" && request.url?.startsWith("/artifact-preview/")) {      return serveArtifactPreview(request, response);
    }
    if (!hostAllowed(request, options.allowedHosts)) {
      return json(response, 403, { ok: false, error: "Host rejected." });
    }
    try {
      await options.verifyAccess(header(request, "cf-access-jwt-assertion"), request);
    } catch {
      return json(response, 401, { ok: false, error: "Access authentication required." });
    }
    if (request.method === "GET" && options.rendererPath) {
      return serveRenderer(request.url, response, options.rendererPath);
    }
    if (request.method !== "POST" || request.url !== "/api/rpc") {
      return json(response, 404, { ok: false, error: "Not found." });
    }
    if (!originAllowed(request, options.allowedOrigin, options.allowedHosts)) {
      return json(response, 403, { ok: false, error: "Origin rejected." });
    }
    const body = await readBody(request);
    if (body === null) return json(response, 413, { ok: false, error: "Request too large." });
    try {
      const payload = JSON.parse(body) as { method?: unknown; args?: unknown };
      if (!isRpcMethod(payload.method) || !Array.isArray(payload.args)) {
        return json(response, 400, { ok: false, error: "Invalid request." });
      }
      const client = request.socket.remoteAddress ?? "local";
      const uiActionLimited = payload.method === "recordUiAction"
        && rateLimited(client, uiActions, options.uiActionLimit ?? 600);
      const mutationLimited = payload.method !== "recordUiAction"
        && isMutation(payload.method)
        && rateLimited(client, mutations, options.mutationLimit ?? 120);
      if (uiActionLimited || mutationLimited) {
        return json(response, 429, { ok: false, error: "Too many requests." });
      }
      const operation = options.operations[payload.method];
      if (!operation) return json(response, 404, { ok: false, error: "Method unavailable." });
      const args: unknown[] = payload.args;
      const result = await operation(...args);
      return json(response, 200, { ok: true, result });
    } catch {
      return json(response, 500, { ok: false, error: "Coterm request failed." });
    }
  } catch {
    if (!response.headersSent) {
      return json(response, 500, { ok: false, error: "Coterm request failed." });
    }
  }
}

export function originAllowed(request: IncomingMessage, allowedOrigin: string, allowedHosts?: string[]): boolean {
  const origin = request.headers.origin;
  if (!origin) return false;
  if (allowedOrigin !== "self") return origin === allowedOrigin;
  // "self": origin must match the request's own host (any scheme). Tunnel clients
  // arrive as https://<host>; hard-coding http:// here rejected them. Compare host only.
  const host = request.headers.host ?? "";
  try {
    if (new URL(origin).host === new URL(`http://${host}`).host) return true;
  } catch {
    return false;
  }
  // Tailscale Serve can forward the loopback backend Host while the browser's
  // Origin remains the public ts.net name. Compare hostnames so a private Serve
  // port such as :8443 does not need to be duplicated in configuration.
  if (allowedHosts && allowedHosts.length > 0) {
    try {
      const originHostname = new URL(origin).hostname.toLowerCase();
      return allowedHosts.some((allowed) => normalizeHostname(allowed) === originHostname);
    } catch {
      return false;
    }
  }
  return false;
}

function hostAllowed(request: IncomingMessage, allowedHosts?: string[]): boolean {
  if (!allowedHosts || allowedHosts.length === 0) return true;
  const hostname = normalizeHostname(request.headers.host ?? "");
  if (!hostname) return false;
  if (hostname === "127.0.0.1" || hostname === "localhost" || hostname === "::1" || hostname === "[::1]") {
    return true;
  }
  return allowedHosts.some((allowed) => normalizeHostname(allowed) === hostname);
}

function normalizeHostname(value: string): string {
  const trimmed = value.trim().toLowerCase();
  if (!trimmed) return "";
  try {
    return new URL(trimmed.includes("://") ? trimmed : `http://${trimmed}`).hostname.toLowerCase();
  } catch {
    return "";
  }
}

const rateLimitExemptMethods = new Set([
  "bootstrap",
  "getSettings",
  "getDockLayout",
  "getTerminalWorkspace",
  "getTerminalTranscript",
  "getPtyState",
  "getLastCommand",
  "getTerminalDashboard",
  "listAttention",
  "getUsageSnapshot",
  "getSystemActivity",
  "getAgentFileActivity",
  "getWorktreeRegistry",
  "listWorkspace",
  "listEvents",
  "listProjectSessions",
  "listTerminals",
  "listAttachments",
  "listClaudeHistory",
  "readClaudeHistory",
  "readArtifact",
  "refreshProviders",
  "search",
  "getConversationSession",
  // UI view-state changes can be repeated by touch jitter or reconnect replay.
  // Keep heavy actions rate-limited, but do not let tab selection brick mobile.
  "selectTile",
  "setExclusive",
  // A — worktree reads are safe; mutations (create/merge/abort/cleanup/bind/resume) stay rate-limited.
  "listWorktrees",
  "getWorktree",
  "worktreeDiffSummary",
  "getAgentLauncherDir",
]);
function isMutation(method: string): boolean { return !rateLimitExemptMethods.has(method); }

function rateLimited(
  client: string,
  entries: Map<string, { count: number; resetAt: number }>,
  limit: number,
): boolean {
  const now = Date.now();
  const current = entries.get(client);
  const entry = !current || current.resetAt <= now ? { count: 0, resetAt: now + 60_000 } : current;
  entry.count += 1;
  entries.set(client, entry);
  return entry.count > limit;
}

function isLoopback(address: string | undefined): boolean {
  if (!address) return false;
  const host = address.replace(/^::ffff:/i, "");
  return host === "127.0.0.1" || host === "::1" || host.startsWith("127.");
}

/** GET /artifact-preview/<token>/<relative path> — loopback + unexpired token + inside the grant. */
async function serveArtifactPreview(request: IncomingMessage, response: ServerResponse): Promise<void> {
  if (!isLoopback(request.socket.remoteAddress)) {
    return json(response, 403, { ok: false, error: "Artifact preview is loopback-only." });
  }
  const pathname = decodeURIComponent(new URL(request.url ?? "/", "http://localhost").pathname);
  const [, , token, ...rest] = pathname.split("/");
  const directory = token ? resolveArtifactPreviewToken(token) : null;
  if (!directory) return json(response, 404, { ok: false, error: "Preview expired." });
  // Re-encode: serveRenderer decodes once more, and a literal ? or # in a filename would
  // otherwise be parsed as a query/fragment and truncate the name.
  return serveRenderer(`/${rest.map(encodeURIComponent).join("/")}`, response, directory);
}

async function serveRenderer(url: string | undefined, response: ServerResponse, root: string): Promise<void> {
  const pathname = decodeURIComponent(new URL(url ?? "/", "http://localhost").pathname);
  const relative = pathname === "/" ? "index.html" : pathname.slice(1);
  const file = resolve(root, relative);
  const canonicalRoot = resolve(root);
  if (file !== canonicalRoot && !file.startsWith(`${canonicalRoot}${sep}`)) {
    return json(response, 404, { ok: false, error: "Not found." });
  }
  try {
    const bytes = await readFile(file);
    const mime: Record<string, string> = {
      ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
      ".mjs": "text/javascript; charset=utf-8", ".json": "application/json; charset=utf-8",
      ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png",
      ".ico": "image/x-icon", ".woff2": "font/woff2", ".woff": "font/woff",
      ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp",
      ".avif": "image/avif", ".mp4": "video/mp4", ".webm": "video/webm", ".txt": "text/plain; charset=utf-8",
    };
    response.statusCode = 200;
    response.setHeader("Content-Type", mime[extname(file).toLowerCase()] ?? "application/octet-stream");
    // index.html must never be cached, or a phone keeps running the previous
    // release's bundle after an update ("still broken" reports that were
    // already fixed). Vite's hashed assets are safe to cache forever.
    response.setHeader("Cache-Control", relative === "index.html" ? "no-cache" : /-[A-Za-z0-9_-]{8}\.(js|css)$/.test(relative) ? "public, max-age=31536000, immutable" : "no-cache");
    response.end(new Uint8Array(bytes));
  } catch {
    json(response, 404, { ok: false, error: "Not found." });
  }
}

function header(request: IncomingMessage, name: string): string | undefined {
  const value = request.headers[name];
  return Array.isArray(value) ? value[0] : value;
}

export async function readBody(request: IncomingMessage): Promise<string | null> {
  const chunks: Buffer[] = [];
  let size = 0;
  let tooLarge = false;
  for await (const bytes of request as AsyncIterable<Buffer>) {
    size += bytes.length;
    if (size > MAX_BODY_BYTES) tooLarge = true;
    else chunks.push(bytes);
  }
  return tooLarge ? null : Buffer.concat(chunks).toString("utf8");
}

function setSecurityHeaders(response: ServerResponse): void {
  response.setHeader("Content-Security-Policy", "default-src 'self'; object-src 'none'; frame-ancestors 'none'; style-src 'self' 'unsafe-inline'; font-src 'self' data:; img-src 'self' data: blob:; connect-src 'self' ws://127.0.0.1:* http://127.0.0.1:*");
  response.setHeader("Referrer-Policy", "no-referrer");
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("X-Frame-Options", "DENY");
}

export function json(response: ServerResponse, status: number, value: unknown): void {
  response.statusCode = status;
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.end(JSON.stringify(value));
}
