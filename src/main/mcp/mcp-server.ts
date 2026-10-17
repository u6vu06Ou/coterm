import { createInterface } from "node:readline";
import type { BrowserRuntimeManager } from "../browser/browser-runtime-manager";
import { BrowserServiceError } from "../browser/browser-errors";
import {
  browserActionRegistry,
  browserActionSchema,
  dispatchBrowserAction,
  findBrowserAction,
  type BrowserDispatchHooks,
} from "../browser/browser-action-registry";

export const browserMcpToolDefinitions = browserActionRegistry.map((item) => [item.mcpName, item.description] as const);

type JsonRpcRequest = { jsonrpc?: string; id?: string | number | null; method?: string; params?: Record<string, unknown> };
type JsonRpcResponse = Record<string, unknown>;

// ---------------------------------------------------------------------------
// Coterm MCP over HTTP (AT-135) — POST /api/v1/agent/mcp on the agent API.
//
// Token budget is a design constraint: MCP tool definitions ride along with
// EVERY prompt in the client session, so this endpoint exposes a curated core
// subset of the browser registry (not all 25+ actions) plus two read-only
// terminal tools. The full registry stays available over the REST action
// envelope and the machine-readable /api/v1/agent/browser/schema document.
//
// No-rot rule: the subset below references registry ids, and
// tests/unit/mcp-http.test.ts pins that every id resolves against the live
// registry — when an action is renamed/removed the test fails, forcing the
// subset to be updated in the same commit. Adding a NEW registry action does
// NOT auto-add it here (that is the point of curation); decide deliberately.
// ---------------------------------------------------------------------------

/** Curated browser surface for MCP clients (registry ids → subset of registry). */
export const MCP_BROWSER_CORE_ACTION_IDS = [
  "web.search",
  "session.create",
  "session.close",
  "page.navigate",
  "page.snapshot",
  "page.screenshot",
  "page.extract",
  "page.click",
  "page.fill",
  "page.type",
  "page.evaluate",
  "page.previewLocalFile",
  "artifact.searchIndex",
  // Phase 7 P0 (work order §15.2#12): full HTTP/MCP parity for the P0 set. The
  // token tax of six more tool definitions is accepted — these are the actions
  // an agent needs in every loop turn (wait, scroll, hover, diff, network).
  "page.waitFor",
  "page.scroll",
  "page.scrollIntoView",
  "page.hover",
  "page.snapshotDiff",
  "page.networkLog",
  // §12.1#2: batch rides the curated subset too — same schema, same tier gate;
  // its steps consume the shared rate-limit bucket per mutation (see deps).
  "page.batch",
  // §12.2 P1 set (unit test pins: every tiered action rides the curated subset).
  "page.fetchToMarkdown",
  "page.elementScreenshot",
  "page.consoleLog",
  "page.assert",
  "page.dialog",
  "page.download",
  "page.batchFill",
] as const;

export const MCP_TERMINAL_TOOL_NAMES = ["coterm_terminal_sessions", "coterm_terminal_read", "coterm_resources"] as const;

const MCP_TERMINAL_TOOLS = [
  {
    name: "coterm_terminal_sessions",
    description:
      "List Coterm terminals: id, cwd, profile, status, isAgent, scrollbackMode. " +
      "Check cwd before dispatching repo work; only drive claude-local-long/claude-local-main/codex-local-main profiles.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: "coterm_terminal_read",
    description:
      "Read one terminal, bounded. scrollbackMode 'normal' → tail of scrollback (tailChars, default 2000, max 8000); " +
      "'alternate-screen' (fullscreen TUI like Claude Code/vim) → scrollback is '' by design, read screenText instead and NEVER poll for more history.",
    inputSchema: {
      type: "object",
      properties: {
        terminalId: { type: "string", description: "Terminal id from coterm_terminal_sessions." },
        tailChars: { type: "number", description: "Scrollback tail size in normal mode (default 2000, max 8000).", default: 2000, maximum: 8000 },
      },
      required: ["terminalId"],
      additionalProperties: false,
    },
  },
  {
    name: "coterm_resources",
    description:
      "Machine resource board: cpuPercent, memPercent, openTerminals, busyAgents, recommendedMaxNewAgents " +
      "(each pane ~0.6 GiB RAM / ~8% CPU, 20% RAM and 25% CPU headroom kept). " +
      "CHECK THIS before spawning several sub-agents and stay at or below recommendedMaxNewAgents.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
  },
] as const;

/** Deps for the HTTP MCP endpoint. Terminal callbacks are injected by agent-api. */
export interface CotermMcpDeps {
  browser?: BrowserRuntimeManager | undefined;
  /** Per-mutation-step budget hook for composite batch dispatch (wired to the same 30/min bucket as the REST routes). */
  browserMutationBudget?: (() => void) | undefined;
  /** Compact dock/terminal list (no scrollback bodies). */
  terminalSessions?: () => Promise<unknown>;
  /** Bounded read honoring the scrollbackMode contract (issue #13/AT-138). */
  terminalRead?: (input: { terminalId: string; tailChars?: number }) => Promise<unknown>;
  /** Live machine load + agent capacity (resource board; see shared/resource-estimate.ts). */
  resources?: () => Promise<unknown>;
}

function mcpCoreBrowserTools() {
  const ids = new Set<string>(MCP_BROWSER_CORE_ACTION_IDS);
  return browserActionRegistry
    .filter((item) => ids.has(item.id))
    .map((item) => ({ name: item.mcpName, description: item.description, inputSchema: browserActionSchema(item) }));
}

/** True when an MCP tools/call name maps to a mutation (rate-limit bucket). */
export function mcpToolIsMutation(name: string): boolean {
  if ((MCP_TERMINAL_TOOL_NAMES as readonly string[]).includes(name)) return false;
  const definition = findBrowserAction(name, "mcp");
  if (!definition) return false;
  // Batch mutates, but its steps consume the shared bucket individually via
  // the dispatch hook, so the tools/call itself must not also take a slot.
  if (definition.composite === "batch") return false;
  return definition.mutability === "mutation";
}

/**
 * JSON-RPC handler for the HTTP MCP endpoint. Returns null for notifications
 * (route answers 202). Stateless: browser state lives in the runtime, keyed by
 * the sessionId/pageId arguments the client passes.
 */
export function createCotermMcpHandler(deps: CotermMcpDeps) {
  return async (request: JsonRpcRequest): Promise<JsonRpcResponse | null> => {
    const id = request.id;
    const isNotification = id === undefined || id === null;

    if (request.method === "initialize") {
      return { jsonrpc: "2.0", id: id ?? null, result: { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "coterm", version: "1" } } };
    }
    if (request.method === "notifications/initialized" || request.method === "notifications/cancelled") return null;
    if (request.method === "ping") return { jsonrpc: "2.0", id: id ?? null, result: {} };
    if (request.method === "tools/list") {
      return { jsonrpc: "2.0", id: id ?? null, result: { tools: [...mcpCoreBrowserTools(), ...MCP_TERMINAL_TOOLS] } };
    }
    if (request.method === "tools/call") {
      // An id-less tools/call is a notification: JSON-RPC semantics would run
      // it fire-and-forget, but we deliberately do NOT execute tools without a
      // response channel — a client that never sees the result can neither
      // confirm success nor react to an approval prompt. 202, no execution.
      if (isNotification) return null;
      const name = typeof request.params?.name === "string" ? request.params.name : "";
      const input = request.params?.arguments ?? {};
      try {
        if (name === "coterm_terminal_sessions") {
          if (!deps.terminalSessions) throw new BrowserServiceError("internal_error", "Terminal listing unavailable.");
          const result = await deps.terminalSessions();
          return { jsonrpc: "2.0", id, result: { content: [{ type: "text", text: JSON.stringify(result) }] } };
        }
        if (name === "coterm_resources") {
          if (!deps.resources) throw new BrowserServiceError("internal_error", "Resource snapshot unavailable.");
          const result = await deps.resources();
          return { jsonrpc: "2.0", id, result: { content: [{ type: "text", text: JSON.stringify(result) }] } };
        }
        if (name === "coterm_terminal_read") {
          if (!deps.terminalRead) throw new BrowserServiceError("internal_error", "Terminal read unavailable.");
          const args = (input ?? {}) as { terminalId?: unknown; tailChars?: unknown };
          if (typeof args.terminalId !== "string" || args.terminalId.length === 0) {
            throw new BrowserServiceError("invalid_input", "Field 'terminalId' is required.");
          }
          const tailChars = typeof args.tailChars === "number" && Number.isFinite(args.tailChars)
            ? Math.max(1, Math.min(8000, Math.trunc(args.tailChars)))
            : 2000;
          const result = await deps.terminalRead({ terminalId: args.terminalId, tailChars });
          return { jsonrpc: "2.0", id, result: { content: [{ type: "text", text: JSON.stringify(result) }] } };
        }
        const definition = findBrowserAction(name, "mcp");
        if (!definition || !MCP_BROWSER_CORE_ACTION_IDS.includes(definition.id as (typeof MCP_BROWSER_CORE_ACTION_IDS)[number])) {
          throw new BrowserServiceError("invalid_input", "Unknown browser tool.");
        }
        if (!deps.browser) throw new BrowserServiceError("internal_error", "Browser runtime unavailable.");
        // Screenshots over MCP always land on disk — never inline base64.
        const args = definition.id === "page.screenshot"
          ? { ...(input as Record<string, unknown>), artifactOnly: true }
          : input;
        const hooks: BrowserDispatchHooks = { consumeMutationBudget: deps.browserMutationBudget };
        const result = await dispatchBrowserAction(deps.browser, name, args, "mcp", hooks);
        return { jsonrpc: "2.0", id, result: { content: [{ type: "text", text: JSON.stringify(result) }] } };
      } catch (error) {
        const code = error instanceof BrowserServiceError ? error.code : "invalid_input";
        const message = error instanceof BrowserServiceError ? error.message : "MCP tool request was invalid.";
        return { jsonrpc: "2.0", id, error: { code: -32000, message, data: { code } } };
      }
    }
    if (isNotification) return null;
    return { jsonrpc: "2.0", id, error: { code: -32601, message: "MCP method not found." } };
  };
}

export function createBrowserMcpHandler(browser: BrowserRuntimeManager) {
  return async (request: JsonRpcRequest): Promise<Record<string, unknown>> => {
    const id = request.id ?? null;
    if (request.method === "initialize") return { jsonrpc: "2.0", id, result: { protocolVersion: "2025-06-18", capabilities: { tools: {}, resources: {} }, serverInfo: { name: "coterm-browser", version: "1" } } };
    if (request.method === "notifications/initialized") return { jsonrpc: "2.0", id, result: {} };
    if (request.method === "tools/list") {
      return {
        jsonrpc: "2.0",
        id,
        result: {
          tools: browserActionRegistry.map((item) => ({
            name: item.mcpName,
            description: item.description,
            inputSchema: browserActionSchema(item),
          })),
        },
      };
    }
    if (request.method === "resources/list") return { jsonrpc: "2.0", id, result: { resources: [{ uri: "coterm-browser://sessions", name: "Browser sessions", mimeType: "application/json" }] } };
    if (request.method === "resources/read") return { jsonrpc: "2.0", id, result: { contents: [{ uri: "coterm-browser://sessions", mimeType: "application/json", text: JSON.stringify(browser.listSessions()) }] } };
    if (request.method === "tools/call") {
      const name = typeof request.params?.name === "string" ? request.params.name : "";
      const input = request.params?.arguments ?? {};
      try {
        if (!findBrowserAction(name, "mcp")) throw new BrowserServiceError("invalid_input", "Unknown browser tool.");
        const result = await dispatchBrowserAction(browser, name, input, "mcp");
        return { jsonrpc: "2.0", id, result: { content: [{ type: "text", text: JSON.stringify(result) }] } };
      } catch (error) {
        const code = error instanceof BrowserServiceError ? error.code : "invalid_input";
        const message = error instanceof BrowserServiceError ? error.message : "Browser tool request was invalid.";
        return { jsonrpc: "2.0", id, error: { code: -32000, message, data: { code } } };
      }
    }
    return { jsonrpc: "2.0", id, error: { code: -32601, message: "MCP method not found." } };
  };
}

export function runBrowserMcpServer(browser: BrowserRuntimeManager): void {
  const handler = createBrowserMcpHandler(browser);
  const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
  input.on("line", (line) => { void (async () => { try { process.stdout.write(`${JSON.stringify(await handler(JSON.parse(line) as JsonRpcRequest))}\n`); } catch { process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Invalid JSON." } })}\n`); } })(); });
}
