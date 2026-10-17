import { z, type ZodType } from "zod";
import { EVALUATE_SCRIPT_MAX_CHARS, NETWORK_BODY_MAX_CHARS, NETWORK_LOG_MAX_ENTRIES, NETWORK_LOG_MAX_TOTAL_CHARS, type BrowserRuntimeLimits, type BrowserRuntimeManager } from "./browser-runtime-manager";
import { BrowserServiceError } from "./browser-errors";
import type { BrowserRiskLevel } from "./browser-policy";
import {
  BROWSER_BATCH_MAX_STEPS,
  browserAssertInputSchema, browserBatchInputSchema, browserBatchFillInputSchema,
  browserClickInputSchema, browserConsoleInputSchema, browserCoordinateClickInputSchema,
  browserDialogInputSchema, browserDownloadInputSchema, browserElementScreenshotInputSchema,
  browserExtractInputSchema, browserFetchMarkdownInputSchema,
  browserFillInputSchema, browserLocatorSchema, browserNavigateInputSchema, browserPageIdSchema,
  browserPageNewInputSchema, browserPageSelectionInputSchema,
  browserSaveExtractionInputSchema, browserSessionCreateInputSchema, browserSessionIdSchema,
  browserSnapshotInputSchema, browserTypeInputSchema, browserPressInputSchema, browserUploadInputSchema,
  browserNetworkLogInputSchema, browserScrollInputSchema, browserSnapshotDiffInputSchema,
  browserTargetActionInputSchema, browserWaitForInputSchema,
} from "@shared/browser-schema";
import { browserActionErrorCodes, type BrowserBatchResult, type BrowserBatchStepResult } from "@shared/browser-types";
import { AGENT_RATE_LIMIT_DEFAULTS } from "@shared/schema";
import { browserCapabilities } from "@shared/browser-capabilities";

// BrowserRuntimeManager keeps artifacts private. This narrow typed view is the
// only surface the `related` action needs, keeping the cast local to registry.
interface BrowserRuntimeWithArtifacts {
  artifacts: { related(input: { url?: string; pageId?: string; sameHostOnly?: boolean; limit?: number }): unknown };
}

export type BrowserActionTransport = "http" | "mcp" | "ipc";
export interface BrowserActionDefinition {
  id: string;
  httpName: string;
  mcpName: string;
  description: string;
  schema: ZodType;
  mutability: "read" | "mutation";
  risk: BrowserRiskLevel;
  approval: "none" | "per-request";
  timeoutMs: number;
  /**
   * Phase 7 feature-flag tier (work order §14). Undefined = core: always
   * dispatchable. "p0"/"p1" actions fail closed (policy_denied) when the
   * matching Settings flag is off.
   */
  tier?: "p0" | "p1";
  /**
   * Composite actions (batch) are executed by dispatchBrowserAction itself,
   * not by a runtime method: the dispatcher loops the steps, re-running each
   * one through schema/tier/approval/timeout, and transports skip their
   * top-level rate-limit slot because every mutation step consumes the shared
   * bucket individually via BrowserDispatchHooks.
   */
  composite?: "batch";
  dispatch: (browser: BrowserRuntimeManager, input: unknown) => unknown;
}

const noInput = z.object({}).strict();
const screenshotInput = browserPageIdSchema.extend({
  fullPage: z.boolean().default(false),
  // MCP transport forces this on: the tool then returns { artifactPath, bytes }
  // instead of the base64 dataUrl, which would be a context bomb.
  artifactOnly: z.boolean().default(false),
  format: z.enum(["png", "jpeg"]).default("png"),
  quality: z.number().int().min(1).max(100).optional(),
  scale: z.enum(["css", "device"]).default("css"),
}).superRefine((value, context) => {
  // P2 strictness: quality is meaningless for png, so reject it up front.
  if (value.quality !== undefined && value.format !== "jpeg") {
    context.addIssue({ code: "custom", message: "quality applies to jpeg screenshots only." });
  }
});

// Inline schemas (T5): projectId is optional so external agents without a
// project list can still search.
const searchIndexInputSchema = z.object({
  query: z.string().min(1).max(500),
  projectId: z.string().uuid().nullable().optional(),
  host: z.string().max(255).optional(),
  crawlId: z.string().uuid().optional(),
  limit: z.number().int().min(1).max(100).default(20),
});
const searchWebInputSchema = z.object({
  query: z.string().min(1).max(500),
  limit: z.number().int().min(1).max(50).default(10),
});
const previewLocalFileInputSchema = z.object({ path: z.string().min(1).max(4096) });
// evaluate input is NOT in the shared browser-schema.ts: the runtime manager
// owns the script bounds (EVALUATE_SCRIPT_MAX_CHARS) and this registry is the
// only consumer.
const evaluateInputSchema = browserPageIdSchema.extend({
  script: z.string().min(1).max(EVALUATE_SCRIPT_MAX_CHARS),
  timeoutMs: z.number().int().min(100).max(60_000).optional(),
});
const relatedInputSchema = z.object({
  url: z.string().url().max(4096).optional(),
  pageId: z.string().min(1).max(128).optional(),
  sameHostOnly: z.boolean().default(false),
  limit: z.number().int().min(1).max(100).default(20),
}).refine((value) => value.url !== undefined || value.pageId !== undefined, "Provide url or pageId.");

function action<T extends ZodType>(definition: Omit<BrowserActionDefinition, "schema"> & { schema: T }): BrowserActionDefinition {
  return definition;
}

/** Serialized-size cap for one batch step result; over the cap the step carries a typed truncation marker instead. */
export const BROWSER_BATCH_STEP_RESULT_MAX_CHARS = 8_192;
/** Total wall-clock budget for one batch run, shared across all steps (abort-checked before every mutation step). */
export const BROWSER_BATCH_TIMEOUT_MS = 300_000;

export const browserActionRegistry: readonly BrowserActionDefinition[] = [
  action({ id: "session.create", httpName: "createSession", mcpName: "coterm_browser_session_create", description: "Create an isolated browser session.", schema: browserSessionCreateInputSchema, mutability: "mutation", risk: 1, approval: "none", timeoutMs: 30_000, dispatch: (browser, input) => browser.createSession(input) }),
  action({ id: "session.list", httpName: "listSessions", mcpName: "coterm_browser_session_list", description: "List browser sessions without cookies or page bodies.", schema: noInput, mutability: "read", risk: 0, approval: "none", timeoutMs: 5_000, dispatch: (browser) => browser.listSessions() }),
  action({ id: "session.close", httpName: "closeSession", mcpName: "coterm_browser_session_close", description: "Close a browser session.", schema: browserSessionIdSchema, mutability: "mutation", risk: 1, approval: "none", timeoutMs: 30_000, dispatch: (browser, input) => browser.closeSession((input as { sessionId: string }).sessionId) }),
  action({ id: "page.new", httpName: "newPage", mcpName: "coterm_browser_page_new", description: "Create a page in a browser session.", schema: browserPageNewInputSchema, mutability: "mutation", risk: 1, approval: "none", timeoutMs: 30_000, dispatch: (browser, input) => { const value = input as { sessionId: string; url?: string }; return browser.newPage(value.sessionId, value.url); } }),
  action({ id: "page.list", httpName: "listPages", mcpName: "coterm_browser_page_list", description: "List pages in a browser session.", schema: browserSessionIdSchema, mutability: "read", risk: 0, approval: "none", timeoutMs: 5_000, dispatch: (browser, input) => browser.listPages((input as { sessionId: string }).sessionId) }),
  action({ id: "page.close", httpName: "closePage", mcpName: "coterm_browser_page_close", description: "Close a browser page.", schema: browserPageSelectionInputSchema, mutability: "mutation", risk: 1, approval: "none", timeoutMs: 30_000, dispatch: (browser, input) => { const value = input as { sessionId: string; pageId: string }; return browser.closePage(value.sessionId, value.pageId); } }),
  action({ id: "page.select", httpName: "selectPage", mcpName: "coterm_browser_page_select", description: "Select the active page in a session.", schema: browserPageSelectionInputSchema, mutability: "mutation", risk: 0, approval: "none", timeoutMs: 5_000, dispatch: (browser, input) => { const value = input as { sessionId: string; pageId: string }; return browser.selectPage(value.sessionId, value.pageId); } }),
  action({ id: "page.navigate", httpName: "navigate", mcpName: "coterm_browser_navigate", description: "Navigate a page using the URL policy.", schema: browserNavigateInputSchema, mutability: "mutation", risk: 1, approval: "none", timeoutMs: 30_000, dispatch: (browser, input) => { const value = input as { pageId: string; url: string; waitUntil?: "load" | "domcontentloaded" | "networkidle" | "commit" }; return browser.navigate(value.pageId, value.url, value.waitUntil); } }),
  action({ id: "page.back", httpName: "back", mcpName: "coterm_browser_back", description: "Navigate back.", schema: browserPageIdSchema, mutability: "mutation", risk: 1, approval: "none", timeoutMs: 30_000, dispatch: (browser, input) => browser.goBack((input as { pageId: string }).pageId) }),
  action({ id: "page.forward", httpName: "forward", mcpName: "coterm_browser_forward", description: "Navigate forward.", schema: browserPageIdSchema, mutability: "mutation", risk: 1, approval: "none", timeoutMs: 30_000, dispatch: (browser, input) => browser.goForward((input as { pageId: string }).pageId) }),
  action({ id: "page.reload", httpName: "reload", mcpName: "coterm_browser_reload", description: "Reload a page.", schema: browserPageIdSchema, mutability: "mutation", risk: 1, approval: "none", timeoutMs: 30_000, dispatch: (browser, input) => browser.reload((input as { pageId: string }).pageId) }),
  action({ id: "page.stop", httpName: "stop", mcpName: "coterm_browser_stop", description: "Stop page loading.", schema: browserPageIdSchema, mutability: "mutation", risk: 0, approval: "none", timeoutMs: 5_000, dispatch: (browser, input) => browser.stop((input as { pageId: string }).pageId) }),
  action({ id: "page.snapshot", httpName: "snapshot", mcpName: "coterm_browser_snapshot", description: "Capture a semantic page snapshot.", schema: browserSnapshotInputSchema, mutability: "read", risk: 0, approval: "none", timeoutMs: 30_000, dispatch: (browser, input) => browser.snapshotPage(input as Parameters<BrowserRuntimeManager["snapshotPage"]>[0]) }),
  action({ id: "page.screenshot", httpName: "screenshot", mcpName: "coterm_browser_screenshot", description: "Capture a bounded page screenshot (png/jpeg, quality pin, css/device scale; server-side pixel+byte caps fail closed).", schema: screenshotInput, mutability: "read", risk: 0, approval: "none", timeoutMs: 30_000, dispatch: (browser, input) => { const value = input as { pageId: string; fullPage?: boolean; artifactOnly?: boolean; format?: "png" | "jpeg"; quality?: number; scale?: "css" | "device" }; return browser.screenshot(value.pageId, { fullPage: value.fullPage === true, artifactOnly: value.artifactOnly === true, format: value.format ?? "png", scale: value.scale ?? "css", ...(value.quality !== undefined ? { quality: value.quality } : {}) }); } }),
  action({ id: "page.click", httpName: "click", mcpName: "coterm_browser_click", description: "Click a semantic locator or snapshot reference.", schema: browserClickInputSchema, mutability: "mutation", risk: 1, approval: "none", timeoutMs: 30_000, dispatch: (browser, input) => browser.click(input as Parameters<BrowserRuntimeManager["click"]>[0]) }),
  action({ id: "page.clickCoordinates", httpName: "clickCoordinates", mcpName: "coterm_browser_click_coordinates", description: "Click coordinates from a current snapshot.", schema: browserCoordinateClickInputSchema, mutability: "mutation", risk: 1, approval: "none", timeoutMs: 30_000, dispatch: (browser, input) => browser.clickCoordinates(input as Parameters<BrowserRuntimeManager["clickCoordinates"]>[0]) }),
  action({ id: "page.fill", httpName: "fill", mcpName: "coterm_browser_fill", description: "Fill a field; sensitive values require an opaque secret handle and approval.", schema: browserFillInputSchema, mutability: "mutation", risk: 1, approval: "per-request", timeoutMs: 30_000, dispatch: (browser, input) => browser.fill(input as Parameters<BrowserRuntimeManager["fill"]>[0]) }),
  action({ id: "page.type", httpName: "type", mcpName: "coterm_browser_type", description: "Type non-sensitive text into a field.", schema: browserTypeInputSchema, mutability: "mutation", risk: 1, approval: "none", timeoutMs: 30_000, dispatch: (browser, input) => browser.type(input as Parameters<BrowserRuntimeManager["type"]>[0]) }),
  action({ id: "page.press", httpName: "press", mcpName: "coterm_browser_press", description: "Press a key on a semantic locator.", schema: browserPressInputSchema, mutability: "mutation", risk: 1, approval: "none", timeoutMs: 30_000, dispatch: (browser, input) => browser.press(input as Parameters<BrowserRuntimeManager["press"]>[0]) }),
  // --- Phase 7 superpowers P0 (work order §12.1). tier p0 = Settings flag
  // browser.superpowersP0 gates dispatch; core actions above are untouched.
  action({ id: "page.waitFor", httpName: "waitFor", mcpName: "coterm_browser_wait_for", description: "Wait for an element to appear/disappear, text, a URL substring, or network idle, with a bounded timeout (code timeout/504 on miss).", schema: browserWaitForInputSchema, mutability: "read", risk: 0, approval: "none", timeoutMs: 70_000, tier: "p0", dispatch: (browser, input) => browser.waitFor(input as Parameters<BrowserRuntimeManager["waitFor"]>[0]) }),
  action({ id: "page.scroll", httpName: "scroll", mcpName: "coterm_browser_scroll", description: "Scroll the page by a bounded wheel delta and report the new position.", schema: browserScrollInputSchema, mutability: "mutation", risk: 1, approval: "none", timeoutMs: 10_000, tier: "p0", dispatch: (browser, input) => browser.scroll(input as Parameters<BrowserRuntimeManager["scroll"]>[0]) }),
  action({ id: "page.scrollIntoView", httpName: "scrollIntoView", mcpName: "coterm_browser_scroll_into_view", description: "Scroll a semantic locator or snapshot reference into view.", schema: browserTargetActionInputSchema, mutability: "mutation", risk: 1, approval: "none", timeoutMs: 30_000, tier: "p0", dispatch: (browser, input) => browser.scrollIntoView(input as Parameters<BrowserRuntimeManager["scrollIntoView"]>[0]) }),
  action({ id: "page.hover", httpName: "hover", mcpName: "coterm_browser_hover", description: "Hover a semantic locator or snapshot reference.", schema: browserTargetActionInputSchema, mutability: "mutation", risk: 1, approval: "none", timeoutMs: 30_000, tier: "p0", dispatch: (browser, input) => browser.hover(input as Parameters<BrowserRuntimeManager["hover"]>[0]) }),
  action({ id: "page.snapshotDiff", httpName: "snapshotDiff", mcpName: "coterm_browser_snapshot_diff", description: "Capture a fresh snapshot and diff it against a still-live baseline (added/changed/removed refs); a stale baseline fails 409 stale_snapshot.", schema: browserSnapshotDiffInputSchema, mutability: "read", risk: 0, approval: "none", timeoutMs: 30_000, tier: "p0", dispatch: (browser, input) => browser.snapshotDiff(input as Parameters<BrowserRuntimeManager["snapshotDiff"]>[0]) }),
  action({ id: "page.networkLog", httpName: "networkLog", mcpName: "coterm_browser_network_log", description: "Read the bounded per-page ring of captured text/JSON response bodies (query-redacted URLs, no request headers/cookies, truncation markers).", schema: browserNetworkLogInputSchema, mutability: "read", risk: 0, approval: "none", timeoutMs: 5_000, tier: "p0", dispatch: (browser, input) => browser.networkLog(input as Parameters<BrowserRuntimeManager["networkLog"]>[0]) }),
  action({ id: "page.batch", httpName: "batch", mcpName: "coterm_browser_batch", description: "Run up to 20 registry actions in order (step action names resolve per transport). Every step re-passes the registry schema/tier/approval/timeout gates, every mutation step consumes the shared rate-limit bucket individually, and a nested batch is rejected (policy_denied). stopOnError defaults to true; per-step results are size-capped with a truncation marker; the batch risk is the max step risk.", schema: browserBatchInputSchema, mutability: "mutation", risk: 3, approval: "per-request", timeoutMs: BROWSER_BATCH_TIMEOUT_MS, tier: "p0", composite: "batch", dispatch: () => { throw new BrowserServiceError("internal_error", "page.batch is executed by the dispatcher, not a runtime method."); } }),
  // --- Phase 7 superpowers P1 (work order §12.2). tier p1 = Settings flag browser.superpowersP1 (default
  // OFF) gates dispatch with policy_denied; approval/risk match the runtime gates these methods enforce.
  action({ id: "page.fetchToMarkdown", httpName: "fetchToMarkdown", mcpName: "coterm_browser_fetch_to_markdown", description: "Fetch a URL server-side (no browser, no cookies, no auth headers) and return bounded markdown; every redirect hop re-passes the DNS/SSRF policy, oversized bodies are never read off the wire, and a bot wall is reported as captcha_wall — never bypassed.", schema: browserFetchMarkdownInputSchema, mutability: "mutation", risk: 1, approval: "none", timeoutMs: 45_000, tier: "p1", dispatch: (browser, input) => browser.fetchToMarkdown(input as Parameters<BrowserRuntimeManager["fetchToMarkdown"]>[0]) }),
  action({ id: "page.elementScreenshot", httpName: "elementScreenshot", mcpName: "coterm_browser_element_screenshot", description: "Capture the element behind a CURRENT snapshot ref into an artifact and return { artifactPath, bytes } metadata only (never inline bytes); stale refs fail closed.", schema: browserElementScreenshotInputSchema, mutability: "read", risk: 0, approval: "none", timeoutMs: 30_000, tier: "p1", dispatch: (browser, input) => browser.elementScreenshot(input as Parameters<BrowserRuntimeManager["elementScreenshot"]>[0]) }),
  action({ id: "page.consoleLog", httpName: "consoleLog", mcpName: "coterm_browser_console_log", description: "Read the bounded per-page ring of console messages and uncaught page errors (egress-redacted at capture, truncation markers, read-only).", schema: browserConsoleInputSchema, mutability: "read", risk: 0, approval: "none", timeoutMs: 5_000, tier: "p1", dispatch: (browser, input) => browser.consoleLog(input as Parameters<BrowserRuntimeManager["consoleLog"]>[0]) }),
  action({ id: "page.assert", httpName: "assert", mcpName: "coterm_browser_assert", description: "Typed assertion (text/url/visible/value) returning a boolean plus the bounded redacted observation that decided it; ref targets fail closed on a stale snapshot.", schema: browserAssertInputSchema, mutability: "read", risk: 0, approval: "none", timeoutMs: 30_000, tier: "p1", dispatch: (browser, input) => browser.assert(input as Parameters<BrowserRuntimeManager["assert"]>[0]) }),
  action({ id: "page.dialog", httpName: "dialog", mcpName: "coterm_browser_dialog", description: "Answer the parked page dialog or await the next one within a bounded budget: accept/prompt are per-request level-2 approvals (a dialog can confirm page-side effects), dismiss is level 1; parked dialogs auto-dismiss after 30s so a page can never hang an agent.", schema: browserDialogInputSchema, mutability: "mutation", risk: 2, approval: "per-request", timeoutMs: 45_000, tier: "p1", dispatch: (browser, input) => browser.respondDialog(input as Parameters<BrowserRuntimeManager["respondDialog"]>[0]) }),
  action({ id: "page.download", httpName: "download", mcpName: "coterm_browser_download", description: "Claim the next parked download after per-request level-2 approval: saved only inside the browser-cache downloads root (sanitized basename, executable-extension denylist, size cap, post-write realpath containment), metadata-only reply with sha256.", schema: browserDownloadInputSchema, mutability: "mutation", risk: 2, approval: "per-request", timeoutMs: 75_000, tier: "p1", dispatch: (browser, input) => browser.downloadNext(input as Parameters<BrowserRuntimeManager["downloadNext"]>[0]) }),
  action({ id: "page.batchFill", httpName: "batchFill", mcpName: "coterm_browser_batch_fill", description: "Fill up to 20 fields in order; every field re-resolves its locator and re-runs its OWN per-field approval (a password-shaped target stays level 3), and secret handles are consumed one-time (a batch cannot replay or flatten them). The result carries field metadata only — never values.", schema: browserBatchFillInputSchema, mutability: "mutation", risk: 3, approval: "per-request", timeoutMs: BROWSER_BATCH_TIMEOUT_MS, tier: "p1", dispatch: (browser, input) => browser.batchFill(input as Parameters<BrowserRuntimeManager["batchFill"]>[0]) }),
  action({ id: "page.upload", httpName: "upload", mcpName: "coterm_browser_upload", description: "Upload workspace-contained files to a file input after approval.", schema: browserUploadInputSchema, mutability: "mutation", risk: 2, approval: "per-request", timeoutMs: 30_000, dispatch: async (browser, input) => { const value = input as { pageId: string; target: Parameters<BrowserRuntimeManager["setInputFiles"]>[1]; files: string[] }; return browser.setInputFiles(value.pageId, value.target, value.files); } }),
  action({ id: "page.extract", httpName: "extract", mcpName: "coterm_browser_extract", description: "Extract visible page content without cookies or secrets.", schema: browserExtractInputSchema, mutability: "read", risk: 0, approval: "none", timeoutMs: 30_000, dispatch: (browser, input) => browser.extractPage(input as Parameters<BrowserRuntimeManager["extractPage"]>[0]) }),
  action({ id: "page.evaluate", httpName: "evaluate", mcpName: "coterm_browser_evaluate", description: "Run a bounded JavaScript expression in the page context (e.g. steer a WebGL/three.js scene); always awaits a human approval decision.", schema: evaluateInputSchema, mutability: "mutation", risk: 3, approval: "per-request", timeoutMs: 30_000, dispatch: (browser, input) => browser.evaluate(input as Parameters<BrowserRuntimeManager["evaluate"]>[0]) }),
  action({ id: "page.saveExtraction", httpName: "saveExtraction", mcpName: "coterm_browser_save_extraction", description: "Save a bounded page extraction as a browser-cache artifact.", schema: browserSaveExtractionInputSchema, mutability: "mutation", risk: 1, approval: "none", timeoutMs: 30_000, dispatch: (browser, input) => browser.saveExtraction(input as Parameters<BrowserRuntimeManager["saveExtraction"]>[0]) }),
  action({ id: "artifact.searchIndex", httpName: "searchIndex", mcpName: "coterm_browser_search_index", description: "Search saved browser artifacts by chunk-level trigram FTS5.", schema: searchIndexInputSchema, mutability: "read", risk: 0, approval: "none", timeoutMs: 5_000, dispatch: (browser, input) => { const value = input as { query: string; projectId?: string | null; host?: string; crawlId?: string; limit?: number }; return browser.searchBrowserIndex({ query: value.query, projectId: value.projectId ?? "", ...(value.host ? { host: value.host } : {}), ...(value.crawlId ? { crawlId: value.crawlId } : {}), ...(value.limit !== undefined ? { limit: value.limit } : {}) }); } }),
  action({ id: "artifact.related", httpName: "related", mcpName: "coterm_browser_related", description: "Return pages linked to/from a given page (edges-table JOIN, no graph DB).", schema: relatedInputSchema, mutability: "read", risk: 0, approval: "none", timeoutMs: 5_000, dispatch: (browser, input) => { const value = input as { url?: string; pageId?: string; sameHostOnly?: boolean; limit?: number }; return (browser as unknown as BrowserRuntimeWithArtifacts).artifacts.related({ ...(value.url ? { url: value.url } : {}), ...(value.pageId ? { pageId: value.pageId } : {}), sameHostOnly: value.sameHostOnly === true, ...(value.limit !== undefined ? { limit: value.limit } : {}) }); } }),
  action({ id: "page.previewLocalFile", httpName: "previewLocalFile", mcpName: "coterm_browser_preview_local_file", description: "Turn a local .html file inside an approved root into a loopback URL this browser may open.", schema: previewLocalFileInputSchema, mutability: "mutation", risk: 1, approval: "none", timeoutMs: 10_000, dispatch: (browser, input) => browser.previewLocalFile(input as { path: string }) }),
  action({ id: "web.search", httpName: "search", mcpName: "coterm_browser_search", description: "Search the web in one call (DuckDuckGo Lite, falling back to Brave) and return title/url/snippet.", schema: searchWebInputSchema, mutability: "mutation", risk: 1, approval: "none", timeoutMs: 60_000, dispatch: (browser, input) => browser.searchWeb(input as { query: string; limit?: number }) }),
] as const;

const byHttp = new Map(browserActionRegistry.map((item) => [item.httpName, item]));
const byMcp = new Map(browserActionRegistry.map((item) => [item.mcpName, item]));

export function findBrowserAction(name: string, transport: BrowserActionTransport): BrowserActionDefinition | null {
  return (transport === "mcp" ? byMcp : byHttp).get(name) ?? null;
}

/**
 * Single dispatch path for every transport: schema parse, superpower-tier flag
 * gate (fail closed with policy_denied — core actions never gated), and a REAL
 * race on the registry-declared timeoutMs with timer cleanup. The race cannot
 * cancel in-flight Playwright work; it bounds how long the caller waits. The
 * caller-visible miss is code "timeout" (HTTP 504) so agents can back off and
 * re-snapshot instead of hanging on the connection.
 */
export interface BrowserDispatchHooks {
  /**
   * Composite actions (batch) invoke this once per MUTATION step immediately
   * before the step runs, so N batched mutations cannot fit into a single
   * transport-level rate-limit slot. Transports implement it against the same
   * bucket their top-level mutation routes use and throw
   * BrowserServiceError("rate_limited", ...retryAfterMs hint...) when the
   * bucket is exhausted; the throw becomes a typed per-step error. Transports
   * without a hook (ipc) run batch mutations unthrottled, exactly like their
   * unthrottled single-mutation dispatches.
   */
  consumeMutationBudget?: (() => void) | undefined;
}

/** Per-step error message cap: Playwright/zod messages can run long. */
const BATCH_STEP_ERROR_MAX_CHARS = 500;

function batchStepError(index: number, actionId: string, error: unknown): BrowserBatchStepResult {
  const code = error instanceof BrowserServiceError ? error.code : "internal_error";
  const message = error instanceof Error ? error.message : String(error);
  return { index, actionId, ok: false, code, error: message.slice(0, BATCH_STEP_ERROR_MAX_CHARS) };
}

function capBatchStepResult(index: number, actionId: string, result: unknown): BrowserBatchStepResult {
  let serialized: string;
  try {
    serialized = JSON.stringify(result ?? null);
  } catch {
    serialized = "";
  }
  if (serialized.length <= BROWSER_BATCH_STEP_RESULT_MAX_CHARS) {
    return { index, actionId, ok: true, result: result ?? null };
  }
  return { index, actionId, ok: true, resultTruncated: true, result: { truncated: true, serializedChars: serialized.length, limit: BROWSER_BATCH_STEP_RESULT_MAX_CHARS } };
}

/** One batch step with its own registry timeoutMs race (same shape as a standalone dispatch). */
async function runBatchStep(definition: BrowserActionDefinition, browser: BrowserRuntimeManager, parsed: unknown, index: number): Promise<BrowserBatchStepResult> {
  let timer: NodeJS.Timeout | null = null;
  try {
    const result = await Promise.race([
      Promise.resolve(definition.dispatch(browser, parsed)),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new BrowserServiceError("timeout", `Batch step ${definition.id} exceeded its ${definition.timeoutMs}ms budget; the batch halts so no later mutation can start after a timeout.`)), definition.timeoutMs);
      }),
    ]);
    return capBatchStepResult(index, definition.id, result);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Batch executor (work order §12.1#2). Every step re-passes the registry
 * gates a standalone dispatch would hit: schema, feature tier, approval (via
 * the runtime method itself, so level 2/3 steps can never skip it) and
 * timeout. Budget/latency rules:
 * - mutation steps consume the shared rate-limit bucket individually;
 * - a step timeout (or the overall batch timeout, surfaced through
 *   shouldAbort) halts the run and the abort check before every mutation
 *   step guarantees no late mutation starts after the caller saw a timeout.
 * The top-level risk reported in the result is the max of the resolved step
 * risks — batch aggregation can never lower it.
 */
async function runBrowserBatch(
  browser: BrowserRuntimeManager,
  input: { steps: { action: string; input: Record<string, unknown> }[]; stopOnError: boolean },
  transport: BrowserActionTransport,
  shouldAbort: () => boolean,
  hooks?: BrowserDispatchHooks,
): Promise<BrowserBatchResult> {
  const steps: BrowserBatchStepResult[] = [];
  let risk: BrowserRiskLevel = 0;
  let stoppedEarly = false;
  const lastIndex = input.steps.length - 1;
  for (const [index, step] of input.steps.entries()) {
    let outcome: BrowserBatchStepResult;
    if (shouldAbort()) {
      outcome = { index, actionId: step.action, ok: false, code: "timeout", error: "The batch time budget ran out before this step ran; no further steps were started." };
    } else {
      const definition = findBrowserAction(step.action, transport);
      if (!definition) {
        outcome = batchStepError(index, step.action, new BrowserServiceError("invalid_input", `Unknown ${transport} browser action: ${step.action}`));
      } else if (definition.composite === "batch") {
        outcome = batchStepError(index, step.action, new BrowserServiceError("policy_denied", "Nested batch is not allowed."));
      } else {
        risk = Math.max(risk, definition.risk) as BrowserRiskLevel;
        if (definition.tier !== undefined && !browser.superpowersEnabled(definition.tier)) {
          outcome = batchStepError(index, step.action, new BrowserServiceError("policy_denied", `Browser superpowers (${definition.tier.toUpperCase()}) are disabled in Settings.`));
        } else {
          const parsedStep = definition.schema.safeParse(step.input ?? {});
          if (!parsedStep.success) {
            outcome = batchStepError(index, step.action, new BrowserServiceError("invalid_input", parsedStep.error.issues[0]?.message ?? "Invalid step input."));
          } else {
            try {
              if (definition.mutability === "mutation") hooks?.consumeMutationBudget?.();
              if (shouldAbort()) throw new BrowserServiceError("timeout", "The batch time budget ran out before this step ran; no further steps were started.");
              outcome = await runBatchStep(definition, browser, parsedStep.data, index);
            } catch (error) {
              outcome = batchStepError(index, step.action, error);
            }
          }
        }
      }
    }
    steps.push(outcome);
    if (!outcome.ok && index < lastIndex && (outcome.code === "timeout" || input.stopOnError)) {
      stoppedEarly = true;
      break;
    }
  }
  return { kind: "batch", ok: stoppedEarly === false && steps.every((step) => step.ok), steps, stoppedEarly, stopOnError: input.stopOnError, risk };
}

export async function dispatchBrowserAction(browser: BrowserRuntimeManager, name: string, input: unknown, transport: BrowserActionTransport, hooks?: BrowserDispatchHooks): Promise<unknown> {
  const definition = findBrowserAction(name, transport);
  if (!definition) throw new Error(`Unsupported browser action: ${name}`);
  if (definition.tier !== undefined && !browser.superpowersEnabled(definition.tier)) {
    throw new BrowserServiceError("policy_denied", `Browser superpowers (${definition.tier.toUpperCase()}) are disabled in Settings.`);
  }
  const parsed = definition.schema.parse(input ?? {});
  let timer: NodeJS.Timeout | null = null;
  // Generation guard for composite runs: when the overall budget fires this
  // flips first, and the batch loop checks it before every mutation step so
  // no late mutation can start in the background after a timeout.
  let budgetExhausted = false;
  try {
    const work = definition.composite === "batch"
      ? runBrowserBatch(browser, parsed as { steps: { action: string; input: Record<string, unknown> }[]; stopOnError: boolean }, transport, () => budgetExhausted, hooks)
      : Promise.resolve(definition.dispatch(browser, parsed));
    return await Promise.race([
      work,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => { budgetExhausted = true; reject(new BrowserServiceError("timeout", `Browser action ${definition.id} exceeded its ${definition.timeoutMs}ms budget.`)); }, definition.timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export function browserActionSchema(definition: BrowserActionDefinition): Record<string, unknown> {
  return z.toJSONSchema(definition.schema);
}

// Locator strategies are derived from the locator schema's discriminated union,
// not a hand-maintained list — the no-rot guard test pins this.
const LOCATOR_STRATEGIES: readonly string[] = browserLocatorSchema.options.map(
  (option) => (option.shape.strategy as z.ZodLiteral<string>).value,
);

/** The live REST surface of the browser runtime (agent-api.ts route dispatch order). */
const BROWSER_ENDPOINTS = [
  { method: "GET", path: "/api/v1/agent/browser/schema", purpose: "This discovery document." },
  { method: "GET", path: "/api/v1/agent/browser/sessions", purpose: "List browser sessions (no cookies, no page bodies)." },
  { method: "POST", path: "/api/v1/agent/browser/session", purpose: "Create a session; input = session.create." },
  { method: "POST", path: "/api/v1/agent/browser/page", purpose: "Create a page; input = page.new." },
  { method: "POST", path: "/api/v1/agent/browser/action", purpose: "Dispatch any action by httpName; envelope { action, input }." },
  { method: "POST", path: "/api/v1/agent/mcp", purpose: "MCP (streamable HTTP, stateless JSON-RPC): curated core browser tools + read-only terminal tools for MCP-native clients." },
] as const;

/**
 * Machine-readable browser capability schema (GET /api/v1/agent/browser/schema).
 * Everything below is generated from declarative sources (registry, locator
 * schema, error-code array, injected live limits) — hand-maintained literals
 * here rot, so add new facts to their sources instead. Limits come from the
 * running BrowserRuntimeManager via getLimits().
 */
export function browserDiscoverySchema(
  limits: BrowserRuntimeLimits,
  runtimeVersion = "1",
  flags?: { superpowersP0: boolean; superpowersP1: boolean },
  /**
   * Live agent mutation ceilings (issue #93). Optional so existing callers keep
   * working; when omitted the schema reports the built-in defaults rather than
   * a stale hardcoded number.
   */
  rateLimit?: { terminalPerMinute: number; browserPerMinute: number },
): Record<string, unknown> {
  const effectiveRateLimit = rateLimit ?? AGENT_RATE_LIMIT_DEFAULTS;
  return {
    schemaVersion: "1.2",
    runtimeVersion,
    generatedAt: new Date().toISOString(),
    endpoints: { routes: BROWSER_ENDPOINTS, action: "/api/v1/agent/browser/action", schema: "/api/v1/agent/browser/schema" },
    auth: { required: true, hostPolicy: "loopback-only", bearerToken: true },
    envelope: { http: { action: "string", input: "object" }, mcp: { name: "string", arguments: "object" } },
    actions: browserActionRegistry.map((item) => ({ id: item.id, httpName: item.httpName, mcpName: item.mcpName, description: item.description, inputSchema: browserActionSchema(item), mutability: item.mutability, risk: item.risk, approval: item.approval, timeoutMs: item.timeoutMs, tier: item.tier ?? "core" })),
    locatorStrategies: [...LOCATOR_STRATEGIES],
    snapshotRefs: { format: "e<number>", staleAfter: ["navigation", "new_snapshot"] },
    riskLevels: { "0": "read-only", "1": "safe-interaction", "2": "external-side-effect-or-secret", "3": "high-risk" },
    approvalModes: ["none", "per-request"],
    errorCodes: [...browserActionErrorCodes],
    limits,
    // Reality, not aspiration (issue #93): browser mutations ride their OWN
    // per-client token bucket, separate from terminal mutations — one browser
    // form flow is ~12 mutations, so a shared bucket let a browser script starve
    // terminal dispatch. Only browser read actions (and the GET schema/sessions
    // routes) are unthrottled. 429s carry the remaining quota and a retry hint
    // computed from the token refill, so agents back off instead of looping.
    rateLimits: {
      terminalMutationsPerMinute: effectiveRateLimit.terminalPerMinute,
      browserMutationsPerMinute: effectiveRateLimit.browserPerMinute,
      // Kept for clients written against the pre-#93 single-number schema. It
      // reports the browser ceiling, which is the bucket this schema's actions
      // actually draw on — not a lie for old readers, and unambiguous for new
      // ones that read the two named fields.
      mutationsPerMinute: effectiveRateLimit.browserPerMinute,
      buckets: ["terminal", "browser"],
      mutationBucket: "two independent per-client token buckets: 'terminal' (terminal/workflow/worktree mutations) and 'browser' (browser session/page create + browser mutation actions)",
      bucketRefusal: "429/MCP error carries bucket, limit, remaining and retryAfterMs; retryAfterMs is the time to the NEXT token, not a window reset",
      disclosure: "X-RateLimit-Limit / X-RateLimit-Remaining / X-RateLimit-Policy on mutation responses",
      browserReadActions: "unthrottled",
      onLimited: "429 with body { ok: false, code: 'rate_limited', bucket, limit, remaining, retryAfterMs } and a Retry-After header — back off retryAfterMs, do not retry immediately",
    },
    capabilities: browserCapabilities,
    // Live feature-flag state (work order §14): p0/p1 actions exist in actions[]
    // regardless, but dispatch fails closed (policy_denied) while a tier is off.
    featureFlags: flags ?? { superpowersP0: true, superpowersP1: true },
    // Phase 7 P0 network-body ring bounds, straight from the runtime constants.
    networkLog: { maxEntries: NETWORK_LOG_MAX_ENTRIES, maxTotalChars: NETWORK_LOG_MAX_TOTAL_CHARS, perBodyChars: NETWORK_BODY_MAX_CHARS, bodies: "text/JSON only; query values redacted; no request headers or cookies" },
    // Phase 7 P0 batch contract (work order §12.1#2).
    batch: {
      maxSteps: BROWSER_BATCH_MAX_STEPS,
      stopOnErrorDefault: true,
      totalTimeoutMs: BROWSER_BATCH_TIMEOUT_MS,
      perStepResultMaxChars: BROWSER_BATCH_STEP_RESULT_MAX_CHARS,
      stepNames: "step.action resolves against httpName on http, mcpName on mcp",
      nested: "a batch step is rejected per-step with policy_denied",
      risk: "result.risk = max of the resolved step risks; level 2/3 steps still hit their own per-step approval gate",
      rateLimit: "every mutation step consumes the shared mutation bucket individually; an exhausted bucket is a per-step rate_limited error, not a transport 429",
    },
    // AT-135: MCP-native clients (Claude Code, Codex, Cursor) can skip this REST
    // envelope entirely — tools/list exposes a curated core subset of these
    // actions plus read-only terminal tools. Deliberately NOT the full action
    // list: MCP tool definitions are injected into every client prompt, so the
    // subset keeps the per-message token tax low. Full surface = this document.
    mcp: {
      url: "/api/v1/agent/mcp",
      transport: "streamable-http (stateless JSON-RPC; POST only, notifications get 202)",
      surface: "curated core subset of actions[] by id, plus coterm_terminal_sessions / coterm_terminal_read",
      auth: "same Bearer token",
      notes: "screenshot returns { artifactPath, bytes } on disk, never inline base64; terminal_read honors scrollbackMode (alternate-screen → read screenText, never poll scrollback)",
    },
    // Log/event schema lives elsewhere; the two schemas deliberately stay separate.
    logSchema: "/api/v1/agent/schema",
  };
}
