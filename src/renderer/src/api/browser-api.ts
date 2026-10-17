import type { AiTerminalApi } from "@shared/ipc";

interface BrowserApiOptions {
  fetch?: typeof globalThis.fetch;
  createSocket?: () => WebSocket;
}

type LiveType = "event" | "terminalData" | "terminalExit" | "terminalListChanged" | "terminalCommand" | "dockLayout" | "ptyStateChanged" | "attentionChanged" | "usageChanged" | "browserArtifactSaved" | "agentapiWorldChanged" | "profilesChanged";

export function createBrowserApi(options: BrowserApiOptions = {}): AiTerminalApi {
  const fetcher = options.fetch ?? globalThis.fetch.bind(globalThis);
  const live = new LiveConnection(options.createSocket ?? defaultSocket);
  return new Proxy({} as AiTerminalApi, {
    get(_target, property) {
      if (property === "isBrowser") return true;
      // Desktop-only (Electron webUtils); a browser File has no disk path.
      if (property === "getPathForFile") return undefined;
      if (property === "onEvent") return (callback: (value: unknown) => void) => live.on("event", callback);
      if (property === "onTerminalData") return (callback: (value: unknown) => void) => live.on("terminalData", callback);
      if (property === "onTerminalExit") return (callback: (value: unknown) => void) => live.on("terminalExit", callback);
      if (property === "onTerminalListChanged") return (callback: (value: unknown) => void) => live.on("terminalListChanged", callback);
      if (property === "onTerminalCommand") return (callback: (value: unknown) => void) => live.on("terminalCommand", callback);
      if (property === "onDockLayout") return (callback: (value: unknown) => void) => live.on("dockLayout", callback);
      if (property === "onProfilesChanged") return (callback: (value: unknown) => void) => live.on("profilesChanged", callback);
      if (property === "onPtyStateChanged") return (callback: (value: unknown) => void) => live.on("ptyStateChanged", callback);
      if (property === "onAttentionChanged") return (callback: (value: unknown) => void) => live.on("attentionChanged", callback);
      if (property === "onUsageChanged") return (callback: (value: unknown) => void) => live.on("usageChanged", callback);
      if (property === "onBrowserArtifactSaved") return (callback: (value: unknown) => void) => live.on("browserArtifactSaved", callback);
      if (property === "onAgentApiWorldChanged") return (callback: (value: unknown) => void) => live.on("agentapiWorldChanged", callback);
      // ponytail: web clients must NOT resize the shared PTY — only the desktop
      // (Electron preload) owns PTY dimensions. Competing resize calls re-wrap
      // output at conflicting column counts and garble every other client's
      // display. Mirrors the mock-api precedent (mock-api.ts:435).
      if (property === "resizeTerminal") return () => Promise.resolve();
      return (...args: unknown[]) => rpc(fetcher, String(property), args);
    },
  });
}

const SLOW_RPC_METHODS = new Set([
  "openTile",
  "createTerminal",
  "getTerminalWorkspace",
  "getTerminalTranscript",
]);

async function rpc(fetcher: typeof globalThis.fetch, method: string, args: unknown[]) {
  const response = await fetcher("/api/rpc", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ method, args }),
    // SLOW_RPC set, not per-method tuning — launch/workspace snapshot/
    // transcript hydration can legitimately exceed 10s on a cold host; give
    // them 60s. Tighten per-method only if one of these measurably hangs.
    signal: AbortSignal.timeout(SLOW_RPC_METHODS.has(method) ? 60_000 : 10_000),
  });
  const payload = await response.json() as { ok?: boolean; result?: unknown; error?: string };
  if (!response.ok || !payload.ok) throw new Error(payload.error ?? "Coterm request failed.");
  return payload.result;
}

class LiveConnection {
  private socket: WebSocket | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private wasConnected = false;
  private readonly listeners = new Map<LiveType, Set<(value: never) => void>>();

  constructor(private readonly createSocket: () => WebSocket) {}

  on(type: LiveType, callback: (value: never) => void): () => void {
    const listeners = this.listeners.get(type) ?? new Set();
    listeners.add(callback);
    this.listeners.set(type, listeners);
    this.connect();
    return () => {
      listeners.delete(callback);
      if ([...this.listeners.values()].every((items) => items.size === 0)) this.disconnect();
    };
  }

  private connect(): void {
    if (this.socket) return;
    const socket = this.createSocket();
    this.socket = socket;
    socket.onopen = () => {
      // A re-open after a drop means any RPC that failed mid-outage (terminal
      // hydrate included) can succeed now — tell listeners to re-pull (#24).
      if (this.wasConnected) window.dispatchEvent(new Event("coterm:rehydrate"));
      this.wasConnected = true;
    };
    socket.onmessage = (message) => {
      try {
        const value = JSON.parse(String(message.data)) as { type?: LiveType; payload?: never };
        if (value.type && value.payload !== undefined) {
          for (const callback of this.listeners.get(value.type) ?? []) callback(value.payload);
        }
      } catch {
        // Ignore malformed remote events.
      }
    };
    socket.onclose = () => {
      if (this.socket === socket) this.socket = null;
      if ([...this.listeners.values()].some((items) => items.size > 0)) {
        this.reconnectTimer = setTimeout(() => this.connect(), 1_000);
      }
    };
  }

  private disconnect(): void {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.socket?.close();
    this.socket = null;
  }
}

function defaultSocket(): WebSocket {
  const protocol = location.protocol === "https:" ? "wss:" : "ws:";
  return new WebSocket(`${protocol}//${location.host}/live`);
}
