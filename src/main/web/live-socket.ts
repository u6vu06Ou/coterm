import type { Server, IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocketServer, WebSocket, type RawData } from "ws";
import type { AppEventBus } from "../core/event-bus";
import { logger } from "../core/logger";
import { isRpcMethod, type WebOperations } from "./routes";
import type { AccessVerifier } from "./access-auth";
import type { AttentionNotification, DockLayout, UsageSnapshot } from "@shared/types";

type LiveType = "event" | "terminalData" | "terminalExit" | "terminalListChanged" | "terminalCommand" | "dockLayout" | "ptyStateChanged" | "attentionChanged" | "usageChanged" | "browserArtifactSaved" | "agentapiWorldChanged" | "profilesChanged";

/**
 * Optional dock-layout accessor. When provided, the live socket sends the
 * current layout on connect (mirroring terminalListChanged replay) and pushes
 * `{ type: "dockLayout", payload: DockLayout }` on every mutation.
 */
export interface DockLayoutAccessor {
  get(): Promise<DockLayout>;
  subscribe(callback: (layout: DockLayout) => void): () => void;
}

/**
 * Optional attention-inbox accessor. When provided, the live socket replays
 * unresolved notifications on connect (so a reconnecting mobile client sees
 * the current inbox) and pushes `attentionChanged` on every file/resolve.
 */
export interface AttentionAccessor {
  list(): AttentionNotification[];
  subscribe(callback: (notification: AttentionNotification) => void): () => void;
}

/**
 * Optional usage-snapshot accessor. When provided, the live socket sends the
 * current paid-account usage snapshot on connect and pushes `usageChanged`
 * on every 10s poll tick.
 */
export interface UsageAccessor {
  get(): UsageSnapshot;
  subscribe(callback: (snapshot: UsageSnapshot) => void): () => void;
}

/**
 * Optional AgentApi world-state accessor (Phase 6): metadata-only snapshot on
 * connect + burst-coalesced pushes; mirrors the panel hydrate/push contract.
 */
export interface AgentApiWorldAccessor {
  get(): unknown[];
  subscribe(callback: (sessions: unknown[]) => void): () => void;
}

interface LiveSocketOptions {
  allowedOrigin: string;
  allowedHosts?: string[];
  verifyAccess: AccessVerifier;
  operations: WebOperations;
  events: AppEventBus;
  dockLayout?: DockLayoutAccessor;
  attention?: AttentionAccessor;
  usage?: UsageAccessor;
  agentapiWorld?: AgentApiWorldAccessor;
}

export function attachLiveSocket(server: Server, options: LiveSocketOptions): () => void {
  const sockets = new WebSocketServer({ noServer: true, maxPayload: 1_000_000 });
  const onUpgrade = (request: IncomingMessage, socket: Duplex, head: Buffer) => {
    void authorizeUpgrade(request, options).then((allowed) => {
      if (!allowed) {
        socket.end("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
        return;
      }
      sockets.handleUpgrade(request, socket, head, (client) => sockets.emit("connection", client));
    }).catch(() => undefined);
  };
  server.on("upgrade", onUpgrade);
  sockets.on("connection", (client) => bindClient(client, options));
  return () => {
    server.off("upgrade", onUpgrade);
    for (const client of sockets.clients) client.terminate();
    sockets.close();
  };
}

async function authorizeUpgrade(request: IncomingMessage, options: LiveSocketOptions): Promise<boolean> {
  if (request.url !== "/live") return false;
  if (!hostAllowed(request, options.allowedHosts)) return false;
  const origin = request.headers.origin;
  if (!origin) return false;
  let originOk: boolean;
  if (options.allowedOrigin !== "self") {
    originOk = origin === options.allowedOrigin;
  } else {
    // "self": match request host, any scheme (tunnel clients are https://<host>).
    const host = request.headers.host ?? "";
    try {
      originOk = new URL(origin).host === new URL(`http://${host}`).host;
    } catch {
      originOk = false;
    }
    // Tailscale Serve: origin host may be a ts.net hostname that does not match
    // the loopback Host header Serve forwards. Allow any explicitly-configured host.
    if (!originOk && options.allowedHosts && options.allowedHosts.length > 0) {
      try {
        const originHost = new URL(origin).hostname.toLowerCase();
        originOk = options.allowedHosts.some(
          (allowed) => normalizeHostname(allowed) === originHost,
        );
      } catch {
        originOk = false;
      }
    }
  }
  if (!originOk) return false;
  const header = request.headers["cf-access-jwt-assertion"];
  const assertion = Array.isArray(header) ? header[0] : header;
  try {
    await options.verifyAccess(assertion, request);
    return true;
  } catch {
    return false;
  }
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

function bindClient(client: WebSocket, options: LiveSocketOptions): void {
  client.on("error", () => undefined);
  let replaying = true;
  let isAlive = true;
  const pending: Array<{ type: LiveType; payload: unknown }> = [];
  // Latest-wins coalescing (2026-09-27) for high-rate state events: ptyStateChanged
  // (per terminal) and terminalListChanged (per project) collapse to the newest
  // payload over a short window; everything else goes out immediately.
  const pendingState = new Map<string, { type: LiveType; payload: unknown }>();
  let stateTimer: NodeJS.Timeout | null = null;
  const flushState = () => {
    stateTimer = null;
    if (pendingState.size === 0) return;
    const queued = [...pendingState.values()];
    pendingState.clear();
    for (const message of queued) send(client, message);
  };
  const queueState = (key: string, type: LiveType, payload: unknown) => {
    pendingState.set(key, { type, payload });
    if (!stateTimer) stateTimer = setTimeout(flushState, 24);
  };
  const subscriptions = ["event", "terminalData", "terminalExit", "terminalListChanged", "terminalCommand", "ptyStateChanged", "browserArtifactSaved", "profilesChanged"] as const;
  const listeners = subscriptions.map((type) => {
    const listener = (payload: unknown) => {
      if (replaying) {
        pending.push({ type, payload });
        return;
      }
      if (type === "ptyStateChanged") {
        queueState(`pty:${(payload as { terminalId?: string } | undefined)?.terminalId ?? ""}`, type, payload);
      } else if (type === "terminalListChanged") {
        queueState(`list:${(payload as { projectId?: string } | undefined)?.projectId ?? ""}`, type, payload);
      } else {
        send(client, { type, payload });
      }
    };
    options.events.on(type, listener);
    return { type, listener };
  });
  // Dock layout: subscribe to live mutations (pushed after replay finishes).
  const dockUnsubscribe = options.dockLayout?.subscribe((layout) => {
    if (replaying) pending.push({ type: "dockLayout", payload: layout });
    else send(client, { type: "dockLayout", payload: layout });
  });
  // Attention: subscribe to live file/resolve (pushed after replay finishes).
  const attentionUnsubscribe = options.attention?.subscribe((notification) => {
    if (replaying) pending.push({ type: "attentionChanged", payload: notification });
    else send(client, { type: "attentionChanged", payload: notification });
  });
  // Usage: subscribe to the 10s snapshot poll (pushed after replay finishes).
  const usageUnsubscribe = options.usage?.subscribe((snapshot) => {
    if (replaying) pending.push({ type: "usageChanged", payload: snapshot });
    else send(client, { type: "usageChanged", payload: snapshot });
  });
  // AgentApi world state (Phase 6): metadata-only; conservative push cadence
  // lives in AgentApiStateService (burst-coalesced), nothing extra here.
  const worldUnsubscribe = options.agentapiWorld?.subscribe((sessions) => {
    if (replaying) pending.push({ type: "agentapiWorldChanged", payload: sessions });
    else send(client, { type: "agentapiWorldChanged", payload: sessions });
  });
  client.on("message", (bytes) => {
    void handleMessage(client, rawText(bytes), options.operations);
  });
  client.on("pong", () => { isAlive = true; });
  const heartbeat = setInterval(() => {
    if (client.readyState !== WebSocket.OPEN) return;
    if (!isAlive) {
      client.terminate();
      return;
    }
    isAlive = false;
    client.ping();
  }, 30_000);
  client.once("close", () => {
    if (stateTimer) {
      clearTimeout(stateTimer);
      stateTimer = null;
    }
    pendingState.clear();
    clearInterval(heartbeat);
    for (const { type, listener } of listeners) options.events.off(type, listener);
    dockUnsubscribe?.();
    attentionUnsubscribe?.();
    usageUnsubscribe?.();
    worldUnsubscribe?.();
  });
  void replayPersistedEvents(client, options.operations, options.dockLayout).finally(() => {
    replaying = false;
    for (const message of pending) send(client, message);
  });
  // Send the current dock layout on connect (mirrors terminalListChanged replay).
  if (options.dockLayout) {
    void options.dockLayout.get().then((layout) => {
      send(client, { type: "dockLayout", payload: layout });
    }).catch(() => undefined);
  }
  // Replay unresolved attention notifications on connect so a reconnecting
  // mobile client sees the current inbox without a separate RPC round-trip.
  if (options.attention) {
    for (const notification of options.attention.list()) {
      send(client, { type: "attentionChanged", payload: notification });
    }
  }
  // Send the current usage snapshot on connect so the HUD hydrates immediately
  // rather than waiting up to 10s for the next poll tick.
  if (options.usage) {
    send(client, { type: "usageChanged", payload: options.usage.get() });
  }
  // Send the current world snapshot on connect so a reconnecting mobile panel
  // hydrates without a separate RPC round-trip.
  if (options.agentapiWorld) {
    send(client, { type: "agentapiWorldChanged", payload: options.agentapiWorld.get() });
  }
}

/**
 * Resolves the set of docked project ids from a dock-layout accessor, or null
 * when the layout is absent/empty (then the caller replays every conversation).
 * Best-effort: a torn layout read yields null so we never strand a client's
 * on-connect replay instead of reporting it.
 */
async function dockedProjectIds(dockLayout?: DockLayoutAccessor): Promise<Set<unknown> | null> {
  if (!dockLayout) return null;
  try {
    const tiles = (await dockLayout.get()).tiles ?? [];
    return tiles.length > 0
      ? new Set(tiles.map((tile) => (tile as { projectId?: unknown }).projectId))
      : null;
  } catch {
    return null;
  }
}

/**
 * On-connect replay of persisted conversation events + scrollback, then push
 * live bus events. Both phases push tiny JSON payloads one WS frame at a time
 * to every socket; the delivery wall-clock is the thing under observation.
 */
async function replayPersistedEvents(
  client: WebSocket,
  operations: WebOperations,
  dockLayout?: DockLayoutAccessor,
): Promise<void> {
  const startedAt = Date.now();
  let eventsDelivered = 0;
  try {
    const bootstrap = await operations.bootstrap?.();
    if (!bootstrap || typeof bootstrap !== "object") return;
    const conversations = (bootstrap as { conversations?: unknown }).conversations;
    if (!Array.isArray(conversations)) return;
    const conversationItems: unknown[] = conversations;
    const totalConversations = conversationItems.length;

    // Scope conversation-event replay to DOCKED projects (issue #87). Without a
    // dock-layout accessor we can't know which terminals will render, so we must
    // replay every conversation to preserve prior behavior. If any fetched
    // conversation lacks a projectId we can't trust the scoping key, so also
    // fall back to replaying all. Undocked history is never lost: the client
    // keeps pulling it through the listEvents RPC it already uses.
    const dockedProjects = await dockedProjectIds(dockLayout);
    const carriesNoPid = conversationItems.some(
      (c) => c && typeof c === "object" &&
        typeof (c as { id?: unknown }).id === "string" &&
        typeof (c as { projectId?: unknown }).projectId !== "string",
    );
    let replayConversations: unknown[] = conversationItems;
    if (dockedProjects && !carriesNoPid) {
      replayConversations = conversationItems.filter((c) =>
        c && typeof c === "object" &&
        typeof (c as { id?: unknown }).id === "string" &&
        dockedProjects.has((c as { projectId: unknown }).projectId),
      );
    }
    const replayedConversations = replayConversations.length;

    // Phase 1 — conversation events.
    const phaseStart = Date.now();
    if (operations.listEvents) {
      for (const conversation of replayConversations) {
        if (!conversation || typeof conversation !== "object") continue;
        const id = (conversation as { id?: unknown }).id;
        if (typeof id !== "string") continue;
        const events = await operations.listEvents(id);
        if (!Array.isArray(events)) continue;
        const persistedEvents: unknown[] = events;
        eventsDelivered += persistedEvents.length;
        for (const event of persistedEvents) send(client, { type: "event", payload: event });
      }
    }
    const conversationMs = Date.now() - phaseStart;

    // Phase 2 — scrollback replay is scoped to DOCKED terminals only (commit
    // 705b333). Replaying every project's scrollback pushed ~4.5 MB on connect
    // here (20 projects, 5 of them docked) — past the backpressure ceiling
    // below, so the server killed the socket, the client reconnected after 1s,
    // and mobile never finished loading. Only tiled terminals are rendered, so
    // the rest was pure waste; undocked projects stay fetchable via the
    // getTerminalWorkspace RPC.
    const sbStart = Date.now();
    if (operations.getTerminalWorkspace) {
      const tiles = dockLayout ? (await dockLayout.get()).tiles : [];
      if (tiles.length > 0) {
        const dockedTerminalIds = new Set(tiles.map((tile) => tile.terminalId));
        for (const projectId of new Set(tiles.map((tile) => tile.projectId))) {
          const workspace = await operations.getTerminalWorkspace(projectId);
          if (!workspace || typeof workspace !== "object") continue;
          const scrollback = (workspace as { scrollback?: unknown }).scrollback;
          const revisions = (workspace as { scrollbackRevision?: unknown }).scrollbackRevision;
          if (!scrollback || typeof scrollback !== "object") continue;
          for (const [terminalId, data] of Object.entries(scrollback)) {
            if (typeof data !== "string" || !dockedTerminalIds.has(terminalId)) continue;
            const revision = revisions && typeof revisions === "object"
              ? (revisions as Record<string, unknown>)[terminalId]
              : 0;
            send(client, {
              type: "terminalData",
              payload: {
                terminalId,
                data,
                replace: true,
                revision: typeof revision === "number" ? revision : 0,
              },
            });
          }
        }
      }
    }
    const scrollbackMs = Date.now() - sbStart;

    logger.info("live", "live.replay.timing",
      "Connect-time replay delivered. metadata-only (delivery counts + per-phase ms; no event content).",
      {
        totalMs: Date.now() - startedAt,
        conversationMs,
        scrollbackMs,
        conversationCount: totalConversations,
        replayedConversations,
        eventsDelivered,
      });
  } catch {
    // A failed replay must not tear down the live connection.
  }
}

async function handleMessage(client: WebSocket, text: string, operations: WebOperations): Promise<void> {
  let id: unknown;
  try {
    const message = JSON.parse(text) as { type?: unknown; id?: unknown; method?: unknown; args?: unknown };
    id = message.id;
    if (message.type !== "rpc" || typeof id !== "string" ||
        !isRpcMethod(message.method) || !Array.isArray(message.args)) throw new Error("Invalid request.");
    const operation = operations[message.method];
    if (!operation) throw new Error("Unavailable.");
    const args: unknown[] = message.args;
    const result = await operation(...args);
    send(client, { type: "rpc", id, ok: true, ...(result === undefined ? {} : { result }) });
  } catch {
    send(client, { type: "rpc", id: typeof id === "string" ? id : null, ok: false, error: "Coterm request failed." });
  }
}

function rawText(data: RawData): string {
  if (Array.isArray(data)) return Buffer.concat(data).toString("utf8");
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString("utf8");
  return data.toString("utf8");
}

// ponytail: runaway-client guard, not a rate limit. One authoritative scrollback
// snapshot JSON-escapes to well over 1 MB (a 250K-char PTY buffer of ANSI can
// reach ~1.5 MB), so a 1 MB ceiling tripped on the FIRST replay message of any
// non-loopback client — the phone got close(1013), reconnected after 1s, and
// looped forever. The real bound is 8 docked terminals × one snapshot each;
// 16 MB clears that with headroom while still catching a genuinely dead socket.
// Upgrade path: chunk snapshots and await drain instead of raising this.
const MAX_BUFFERED_BYTES = 16_000_000;

function send(client: WebSocket, value: unknown): void {
  if (client.readyState !== WebSocket.OPEN) return;
  if (client.bufferedAmount > MAX_BUFFERED_BYTES) {
    client.close(1013, "Client is too slow.");
    return;
  }
  client.send(JSON.stringify(value));
}
