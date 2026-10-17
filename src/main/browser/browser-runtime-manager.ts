import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, realpath, rm, stat } from "node:fs/promises";
import { basename, dirname, extname, join } from "node:path";
import type { Browser, BrowserContext, ConsoleMessage, Dialog, Download, Frame, Locator, Page, Response } from "playwright";
import type {
  BrowserActionResult, BrowserDocument, BrowserElementRef, BrowserExtractionOptions, BrowserFrameSnapshot,
  BrowserLocator, BrowserNetworkLogEntry, BrowserNetworkLogResult, BrowserPageId, BrowserPageInfo, BrowserSearchHit,
  BrowserSearchResult, BrowserSessionId, BrowserSessionInfo, BrowserSnapshot, BrowserSnapshotDiff,
  BrowserSnapshotDiffChange, BrowserSnapshotDiffRemoved,
  BrowserAssertResult, BrowserBatchFillResult, BrowserConsoleLogEntry, BrowserConsoleLogResult, BrowserDialogResult, BrowserDownloadResult,
  BrowserFetchMarkdownResult,
} from "@shared/browser-types";
import { BROWSER_DOWNLOAD_MAX_BYTES, BROWSER_FETCH_MARKDOWN_MAX_BYTES, browserExtractInputSchema, browserLocatorSchema, browserSessionCreateInputSchema } from "@shared/browser-schema";
import type { BrowserArtifactSaved } from "@shared/types";
import { BrowserArtifactStore } from "./browser-artifact-store";
import { browserErrorCode, BrowserServiceError } from "./browser-errors";
import { browserRisk, validateBrowserRequestUrl, validateBrowserUrl, validateProfileId } from "./browser-policy";
import { assertAllowedPath } from "../security/path-policy";
import { redactEgress, redactUrlQuery } from "../security/redaction";

export interface BrowserApprovalRequest {
  action: string;
  level: 0 | 1 | 2 | 3;
  sessionId: BrowserSessionId;
  pageId: BrowserPageId;
  origin: string;
  locatorStrategy?: string;
  /**
   * Bounded script preview (first ~500 chars) for evaluate approvals — the
   * human must see what they approve. Script text only, never resolved secret
   * values. previewTruncated flags that the full script is longer.
   */
  previewScript?: string;
  previewTruncated?: boolean;
}

export interface BrowserRuntimeOptions {
  userDataPath: string;
  workspaceRoot?: string;
  maxSessions?: number;
  maxPagesPerSession?: number;
  maxTotalPages?: number;
  allowPrivateNetwork?: boolean;
  /** Hosts (or host:port) exempt from the private-network block (COTERM_BROWSER_ALLOW_HOSTS). */
  allowHosts?: ReadonlySet<string>;
  /**
   * Live policy source (issue #48): when set, the manager reads the current
   * browser-network settings from here on every navigation so a Settings toggle
   * takes effect without a relaunch. Falls back to the static allow* options.
   */
  policyProvider?: () => { allowPrivateNetwork?: boolean; allowHosts?: ReadonlySet<string> };
  /**
   * Coterm's own web-server port. Resolved per call because the server starts after this manager.
   * Only `127.0.0.1:<port>` / `localhost:<port>` open up, so the agent can screenshot the local
   * artifact preview it just produced without every other loopback service opening with it.
   */
  loopbackPort?: () => number | null;
  /**
   * Directories an agent may expose to its own browser via `previewLocalFile`. Deliberately NOT
   * the whole home directory: the preview route serves a whole folder for ten minutes, so this is
   * scoped to project workspaces plus temp/userData — where generated artifacts actually land.
   */
  previewRoots?: () => string[];
  resolveSecret?: (secretRef: string) => Promise<string>;
  /**
   * One-time secret consumption (batchFill, §12.2): the handle is destroyed
   * on first use so an agent cannot replay it. Falls back to resolveSecret in
   * harnesses without a consuming vault — production wiring provides this.
   */
  consumeSecret?: (secretRef: string) => Promise<string>;
  /** Injectable fetch for fetchToMarkdown (tests substitute a stub). Defaults to global fetch. */
  fetchImpl?: typeof globalThis.fetch;
  requestApproval?: (request: BrowserApprovalRequest) => Promise<boolean>;
  /**
   * Live feature-flag source for the Phase 7 superpower tiers (work order §14).
   * Read per dispatch so a Settings toggle takes effect without a relaunch.
   * Absent = both tiers on (tests, stdio MCP dev harness).
   */
  superpowersProvider?: () => { p0?: boolean; p1?: boolean };
  /** Called after a screenshot is persisted to the artifact cache (issue #18). */
  onScreenshotSaved?: (artifact: BrowserArtifactSaved) => void;
  /**
   * Live view of which sessions are in no-questions mode (issue #93). Read on
   * every session listing so the reported approvalGranted flag cannot drift
   * from the approval service's own state, which is the thing actually
   * enforcing it.
   */
  isSessionApprovalGranted?: (sessionId: string) => boolean;
  /**
   * Fired when a session goes away (explicit close or idle sweep), so its
   * issue #93 approval grant dies with it. Separate from the read-only
   * isSessionApprovalGranted probe: the manager owns teardown, the approval
   * service owns the grant, and only this callback lets the former tell the
   * latter.
   */
  onSessionClosed?: (sessionId: string) => void;
  /**
   * Agent browser popout (user request 2026-10-09): true when agent-created
   * sessions WITHOUT an explicit mode should run as a real (headed) Chromium
   * window instead of the headless sidebar browser. Sessions that pass an
   * explicit mode are never upgraded.
   */
  popoutWindowProvider?: () => boolean;
  /**
   * Placement rect for the popped-out window, from window-placement.ts wiring.
   * The rect is applied once at first launch via --window-position/--window-size.
   * Null/absent = no placement args.
   */
  windowPlacementProvider?: () => { x: number; y: number; width: number; height: number } | null;
  /**
   * Deliberate opt-in exception to the new-session-asks-again default: when
   * true (agentBrowserFullAccess setting), every NEW browser session starts
   * granted (issue #93 grantSession at creation), so no risky action prompts.
   * secretRef handles and download containment are NOT affected.
   */
  newSessionAutoGrantProvider?: () => boolean;
  /** Marks a session granted. Reuses the #93 approval service — no parallel bypass. */
  grantSession?: (sessionId: string) => void;
}

type NetworkRing = { entries: BrowserNetworkLogEntry[]; totalChars: number; dropped: number; nextId: number };
type ConsoleRing = { entries: BrowserConsoleLogEntry[]; totalChars: number; dropped: number; nextId: number };
/** A parked page dialog. autoTimer fires the bounded auto-dismiss so a page can
 * never wedge the agent loop on an unanswered modal. */
type PendingDialog = {
  dialog: Dialog;
  kind: "alert" | "confirm" | "prompt" | "beforeunload";
  message: string;
  arrivedAt: number;
  settled: boolean;
  autoTimer: NodeJS.Timeout;
};
type DialogState = {
  pending: PendingDialog | null;
  /** Bounded audit ring (most recent last), metadata only. */
  ring: { kind: string; message: string; resolution: string; at: string }[];
  waiters: (() => void)[];
};
/** A parked Playwright download. Held (not saved) until a per-request approved
 * download action claims it; auto-cancelled after the bounded TTL otherwise. */
type PendingDownload = {
  download: Download;
  url: string;
  fileName: string;
  arrivedAt: number;
  resolved: boolean;
  autoTimer: NodeJS.Timeout;
};
type ManagedPage = {
  info: BrowserPageInfo;
  page: Page;
  network: NetworkRing;
  consoleRing: ConsoleRing;
  dialogs: DialogState;
  downloads: PendingDownload[];
  downloadWaiters: (() => void)[];
};
type SnapshotRecord = { pageId: string; snapshot: BrowserSnapshot; frames: Map<string, Frame>; refNth: Map<string, number> };
type ManagedSession = {
  info: BrowserSessionInfo;
  browser: Browser | null;
  context: BrowserContext;
  pages: Map<string, ManagedPage>;
  profilePath: string | null;
  lastActivityAt: number;
  pendingPages: number;
  shared: SharedBrowser | null;
};

type SnapshotNode = {
  selector: string; tag: string; role?: string; name?: string; text?: string;
  /** True when the node lives inside an open shadow root (selector is a composed piercing chain). */
  inShadow?: boolean;
  disabled?: boolean; checked?: boolean; selected?: boolean; expanded?: boolean;
  editable?: boolean; visible?: boolean; boundingBox?: { x: number; y: number; width: number; height: number };
};

const IDLE_TTL_MS = 10 * 60 * 1000;
const LEASE_TIMEOUT_MS = 30_000;
const LEASE_POLL_MS = 100;
const MAX_TOTAL_PAGES_DEFAULT = 24;
/** Default ceiling for snapshotPage() when the caller passes no maxChars. */
export const SNAPSHOT_MAX_CHARS_DEFAULT = 20_000;
/** evaluate() script/body bounds (AT-133): arbitrary JS is approval-gated, but size stays bounded regardless. */
export const EVALUATE_SCRIPT_MAX_CHARS = 64_000;
export const EVALUATE_RESULT_MAX_CHARS = 64_000;
const EVALUATE_DEFAULT_TIMEOUT_MS = 30_000;
/** Preview bound for the approval dialog: enough to judge intent, bounded so the dialog stays readable. */
export const EVALUATE_PREVIEW_MAX_CHARS = 500;

// Phase 7 network-body ring bounds (work order §12.1.4): at most 50 bodies and
// 5 MiB aggregate per page, each body cut at 64 KiB. Anything with a declared
// length past 8 MiB is never even read from the wire.
export const NETWORK_LOG_MAX_ENTRIES = 50;
export const NETWORK_LOG_MAX_TOTAL_CHARS = 5 * 1024 * 1024;
export const NETWORK_BODY_MAX_CHARS = 65_536;
export const NETWORK_RESPONSE_SKIP_BYTES = 8 * 1024 * 1024;
/** Per-list cap for snapshot-diff arrays so a page rewrite stays bounded. */
export const SNAPSHOT_DIFF_MAX_LIST = 200;

// --- Phase 7 B3/B4 bounds (work order §12.2/§12.3) ---
/** A pending dialog auto-dismisses after this; a page can never hang an agent forever. */
export const DIALOG_AUTO_DISMISS_MS = 30_000;
export const DIALOG_MESSAGE_MAX_CHARS = 1_000;
export const DIALOG_RING_MAX = 20;
/** Pending (unclaimed) downloads per page and their bounded park TTL. */
export const DOWNLOAD_MAX_PENDING = 5;
export const DOWNLOAD_AUTO_CANCEL_MS = 30_000;
/** Executable-type denylist for captured downloads (Windows-execution risk). */
export const DOWNLOAD_BLOCKED_EXTENSIONS: ReadonlySet<string> = new Set([".exe", ".msi", ".bat", ".cmd", ".com", ".scr", ".ps1", ".vbs", ".lnk", ".dll", ".jar"]);
/** Console/pageerror ring: bounded, redacted, read-only. */
export const CONSOLE_LOG_MAX_ENTRIES = 100;
export const CONSOLE_LOG_MAX_TOTAL_CHARS = 256_000;
export const CONSOLE_ENTRY_MAX_CHARS = 2_048;
/** Screenshot pixel ceiling (document-side, before capture) and byte ceiling (after). */
export const SCREENSHOT_MAX_PIXELS = 4096 * 4096;
export const SCREENSHOT_MAX_BYTES = 10_000_000;
/** fetchToMarkdown redirect discipline: every hop is re-validated for SSRF. */
export const FETCH_MARKDOWN_MAX_REDIRECTS = 5;
/** assert text search horizon: never scans an unbounded document body. */
const ASSERT_TEXT_SCAN_CHARS = 50_000;

/** Live capacity limits, published verbatim by the browser discovery schema. */
export interface BrowserRuntimeLimits {
  maxSessions: number;
  maxPagesPerSession: number;
  maxTotalPages: number;
  snapshotMaxChars: number;
}

/**
 * A bot wall answers HTTP 200 with a "prove you are human" page. Returned verbatim it reads like
 * a result set, and a weak model responds by rephrasing the query and retrying — the 235-retry
 * loop this code exists to stop. Fail loudly with somewhere else to go instead.
 */
export class BrowserWallError extends BrowserServiceError {
  readonly host: string;
  readonly suggestion = ["https://lite.duckduckgo.com/lite/?q=", "https://search.brave.com/search?q="];
  constructor(host: string, message?: string) {
    super("captcha_wall", message ?? `${host} answered with a bot check instead of content. Do not retry this host — use a different engine.`);
    this.name = "BrowserServiceError";
    this.host = host;
  }
}

const WALL_URL = /\/sorry\/|\/captcha|challenge/i;
// Engines serve the challenge in the browser's Accept-Language, so English-only patterns miss it:
// Brave hands a zh-TW client "正在驗證您不是機器人". `captcha` is safe as a bare token because the
// length gate below already restricts this to pages too short to be real content.
const WALL_TEXT = /select all squares|解決以下挑戰|包含鴨子|automated queries|unable to verify|are you a robot|enable javascript and cookies|403 - forbidden|verifying you'?re not a bot|quick check before you continue|captcha|不是機器人|不是机器人|人機驗證|人机验证/i;

function hostOf(value: string): string { try { return new URL(value).host; } catch { return value; } }

/**
 * Engines to try, in order. Selectors lean on structure (`data-type`, a result row) rather than
 * class names: Brave ships Svelte-hashed classes like `svelte-on1hvy` that change every deploy,
 * so anything class-based rots within weeks. Brave is first because it answers plain GET queries;
 * DuckDuckGo Lite is the fallback and returns a short error page when it is throttling a caller,
 * which simply reads as "no results" and falls through.
 */
interface SearchEngine {
  host: string;
  url: (query: string) => string;
  /** One node per result. */
  item: string;
  /** Title within an item; falls back to the anchor's own text. */
  title: string;
  /** Snippet nodes, zipped by index against items, when they live outside the item. */
  snippetList?: string;
}

const SEARCH_ENGINES: readonly SearchEngine[] = [
  { host: "search.brave.com", url: (q) => `https://search.brave.com/search?q=${encodeURIComponent(q)}`, item: "#results [data-type=web]", title: ".title" },
  { host: "lite.duckduckgo.com", url: (q) => `https://lite.duckduckgo.com/lite/?q=${encodeURIComponent(q)}`, item: "tr:has(a.result-link)", title: "a.result-link", snippetList: ".result-snippet" },
];

/** A wall is either an unmistakable URL, or wall wording on a page too short to be real content. */
export function detectBotWall(finalUrl: string, text: string): boolean {
  if (WALL_URL.test(finalUrl)) return true;
  return text.length < 1500 && WALL_TEXT.test(text);
}

/** Raised when session/page capacity is full after waiting. Carries retryAfterMs. */
export class BrowserBusyError extends BrowserServiceError {
  readonly retryAfterMs: number;
  constructor(message: string, retryAfterMs = LEASE_TIMEOUT_MS) {
    super("busy", message);
    this.name = "BrowserServiceError";
    this.retryAfterMs = retryAfterMs;
  }
}

export class BrowserRuntimeManager {
  private readonly sessions = new Map<BrowserSessionId, ManagedSession>();
  private readonly snapshots = new Map<string, SnapshotRecord>();
  private readonly profileLocks = new Set<string>();
  private readonly artifacts: BrowserArtifactStore;
  private readonly options: Required<Pick<BrowserRuntimeOptions, "maxSessions" | "maxPagesPerSession" | "maxTotalPages" | "allowPrivateNetwork">> & BrowserRuntimeOptions;
  // Shared lazy-launched browsers (one headless, one headed). Refcount = number of non-persistent
  // sessions using each. Persistent sessions own their own BrowserContext and never touch these.
  private sharedBrowsers: { headless: SharedBrowser | null; headed: SharedBrowser | null } = { headless: null, headed: null };
  // In-flight launches, memoized per slot: without this, N concurrent createSession calls all
  // see a null slot and each launches its own Chromium — the last one wins the slot and the
  // rest are orphaned with an untracked refcount, i.e. the exact leak T1 exists to prevent.
  private sharedLaunches: { headless: Promise<SharedBrowser> | null; headed: Promise<SharedBrowser> | null } = { headless: null, headed: null };
  // Slots reserved by in-flight create calls. Without these, N concurrent createSession/newPage
  // calls all read the map BEFORE any of them registers, so every one passes the cap check and
  // the limit is silently bypassed under exactly the parallel load it exists to bound.
  private pendingSessions = 0;
  private pendingPages = 0;
  private searchPage: { sessionId: string; pageId: string } | null = null;
  private idleSweeper: NodeJS.Timeout | null = null;

  constructor(options: BrowserRuntimeOptions) {
    this.options = { maxSessions: 12, maxPagesPerSession: 4, maxTotalPages: MAX_TOTAL_PAGES_DEFAULT, allowPrivateNetwork: false, ...options };
    this.artifacts = new BrowserArtifactStore(options.userDataPath);
    // ponytail: single interval, 1min sweep; cheap and bounds idle leakage to ~1min of overstay.
    this.idleSweeper = setInterval(() => { void this.sweepIdle().catch(() => undefined); }, 60_000);
    this.idleSweeper.unref?.();
  }

  private get networkPolicy(): { allowPrivateNetwork: boolean; allowHosts: ReadonlySet<string> } {
    const live = this.options.policyProvider?.();
    const allowPrivateNetwork = live?.allowPrivateNetwork ?? this.options.allowPrivateNetwork;
    const allowHosts = new Set(live?.allowHosts ?? this.options.allowHosts ?? []);
    const port = this.options.loopbackPort?.();
    if (port) { allowHosts.add(`127.0.0.1:${port}`); allowHosts.add(`localhost:${port}`); }
    return { allowPrivateNetwork: allowPrivateNetwork ?? false, allowHosts };
  }

  private countTotalPages(): number { let n = this.pendingPages; for (const s of this.sessions.values()) n += s.pages.size; return n; }

  /** Live limits for the discovery schema (agent-api.ts) — never hand-copied literals. */
  getLimits(): BrowserRuntimeLimits {
    return {
      maxSessions: this.options.maxSessions,
      maxPagesPerSession: this.options.maxPagesPerSession,
      maxTotalPages: this.options.maxTotalPages,
      snapshotMaxChars: SNAPSHOT_MAX_CHARS_DEFAULT,
    };
  }

  /** Live feature-flag check for superpower tiers; dispatch fails closed when off. */
  superpowersEnabled(tier: "p0" | "p1"): boolean {
    const flags = this.options.superpowersProvider?.();
    if (!flags) return true;
    return tier === "p0" ? flags.p0 !== false : flags.p1 !== false;
  }

  getFeatureFlags(): { superpowersP0: boolean; superpowersP1: boolean } {
    return { superpowersP0: this.superpowersEnabled("p0"), superpowersP1: this.superpowersEnabled("p1") };
  }

  private async acquireSessionSlot(): Promise<void> {
    const deadline = Date.now() + LEASE_TIMEOUT_MS;
    while (this.sessions.size + this.pendingSessions >= this.options.maxSessions) {
      if (Date.now() >= deadline) throw new BrowserBusyError("Browser session capacity is busy.", LEASE_TIMEOUT_MS);
      await sleep(LEASE_POLL_MS);
    }
    this.pendingSessions += 1;
  }

  private async acquirePageSlot(session: ManagedSession): Promise<void> {
    const deadline = Date.now() + LEASE_TIMEOUT_MS;
    while (session.pages.size + session.pendingPages >= this.options.maxPagesPerSession || this.countTotalPages() >= this.options.maxTotalPages) {
      if (Date.now() >= deadline) throw new BrowserBusyError("Browser page capacity is busy.", LEASE_TIMEOUT_MS);
      await sleep(LEASE_POLL_MS);
    }
    this.pendingPages += 1;
    session.pendingPages += 1;
  }

  private releasePageSlot(session: ManagedSession, held: { value: boolean }): void {
    if (!held.value) return;
    held.value = false;
    this.pendingPages -= 1;
    session.pendingPages -= 1;
  }

  private async sweepIdle(): Promise<void> {
    const now = Date.now();
    for (const [id, session] of [...this.sessions.entries()]) {
      if (session.info.status !== "ready") continue;
      if (now - session.lastActivityAt > IDLE_TTL_MS) await this.closeSession(id).catch(() => undefined);
    }
  }

  async createSession(input: unknown = {}): Promise<BrowserSessionInfo> {
    // Popout setting on = every agent session is a visible window, even when
    // the agent names mode "headless": the MCP/registry path always supplies a
    // mode (schema default), so honoring it would mean popout never fires.
    const wantsPopout = this.options.popoutWindowProvider?.() === true;
    const placement = wantsPopout ? this.options.windowPlacementProvider?.() ?? null : null;
    const windowArgs = placement
      ? [`--window-position=${placement.x},${placement.y}`, `--window-size=${placement.width},${placement.height}`]
      : [];
    const parsed = browserSessionCreateInputSchema.parse(input);
    const mode = wantsPopout ? "headed" : parsed.mode;
    await this.acquireSessionSlot();
    let slotHeld = true;
    const releaseSlot = (): void => { if (slotHeld) { slotHeld = false; this.pendingSessions -= 1; } };
    const id = randomUUID();
    const profileId = parsed.persistent ? validateProfileId(parsed.profileId ?? "default") : null;
    const profilePath = profileId ? join(this.options.userDataPath, "browser-profiles", profileId) : null;
    if (profilePath && this.profileLocks.has(profilePath.toLowerCase())) { releaseSlot(); throw new BrowserServiceError("policy_denied", "This persistent browser profile is already in use."); }
    if (profilePath) {
      await mkdir(profilePath, { recursive: true });
      this.profileLocks.add(profilePath.toLowerCase());
    }
    const info: BrowserSessionInfo = { id, mode, profileId, persistent: parsed.persistent, createdAt: new Date().toISOString(), status: "starting", pages: [] };
    let createdShared: SharedBrowser | null = null;
    let ownsShared = false;
    let createdContext: BrowserContext | null = null;
    try {
      const { chromium } = await import("playwright");
      const headless = mode === "headless";
      const launchArgs = ["--disable-blink-features=AutomationControlled", ...windowArgs];
      const context = profilePath
        ? await chromium.launchPersistentContext(profilePath, {
            headless,
            // B3: downloads are parked and TTL-cancelled; nothing is saved without per-request approval.
            acceptDownloads: true, ignoreHTTPSErrors: false, args: launchArgs,
            locale: "zh-TW", timezoneId: "Asia/Taipei", permissions: [], javaScriptEnabled: true,
            // Popout: pages follow the OS window size instead of Playwright's default viewport.
            ...(wantsPopout ? { viewport: null } : {}),
            ...channelLaunchOptions(),
          })
        : await (async () => {
            createdShared = await this.acquireSharedBrowser(headless, windowArgs);
            ownsShared = true;
            return createdShared.browser.newContext({
              // B3: downloads are parked and TTL-cancelled; nothing is saved without per-request approval.
              acceptDownloads: true, ignoreHTTPSErrors: false, permissions: [],
              locale: "zh-TW", timezoneId: "Asia/Taipei", javaScriptEnabled: true,
              ...(wantsPopout ? { viewport: null } : {}),
              ...stealthContextOptions(headless),
            });
          })();
      createdContext = context;
      await context.route("**/*", async (route) => {
        const request = route.request();
        if (!request.isNavigationRequest()) { await route.continue(); return; }
        try {
          await validateBrowserRequestUrl(request.url(), this.networkPolicy);
          await route.continue();
        } catch {
          await route.abort("blockedbyclient").catch(() => undefined);
        }
      });
      const session: ManagedSession = { info, browser: ownsShared ? createdShared!.browser : null, context, pages: new Map(), profilePath, lastActivityAt: Date.now(), pendingPages: 0, shared: ownsShared ? createdShared : null };
      this.sessions.set(id, session);
      releaseSlot();
      context.on("close", () => { if (session.info.status === "ready") session.info.status = "crashed"; });
      info.status = "ready";
      await this.newPage(id, parsed.url);
      // agentBrowserFullAccess (deliberate opt-in exception to the
      // new-session-asks-again default): mark the brand-new session granted
      // NOW, after the session actually exists, reusing the #93 grantSession —
      // not a parallel bypass. Granting here rather than earlier because the
      // catch path deletes the session without onSessionClosed, so an earlier
      // grant could outlive the thing it was granted for.
      if (this.options.newSessionAutoGrantProvider?.() === true) this.options.grantSession?.(id);
      return this.withApprovalState(info);
    } catch (error) {
      releaseSlot();
      this.sessions.delete(id);
      // The context may already exist (e.g. the initial navigate failed) — closing the shared
      // browser is not enough when other sessions still hold it, so close the context too.
      if (createdContext) await createdContext.close().catch(() => undefined);
      if (ownsShared && createdShared) this.releaseSharedBrowser(createdShared);
      if (profilePath) this.profileLocks.delete(profilePath.toLowerCase());
      throw error;
    }
  }

  /**
   * Issue #93: stamp the live approval-grant state onto the reported info.
   * Derived here rather than stored on the session so a revoked grant (session
   * close, idle sweep) can never leave a stale "granted" flag on the wire.
   */
  private withApprovalState(info: BrowserSessionInfo): BrowserSessionInfo {
    return { ...cloneSession(info), approvalGranted: this.options.isSessionApprovalGranted?.(info.id) === true };
  }

  listSessions(): BrowserSessionInfo[] { return [...this.sessions.values()].map((session) => this.withApprovalState(session.info)); }
  getSession(sessionId: string): BrowserSessionInfo { return this.withApprovalState(this.requireSession(sessionId).info); }

  async closeSession(sessionId: string): Promise<void> {
    // Raw lookup: requireSession() refuses crashed/non-ready sessions, but those
    // are exactly the sessions that must still be closable.
    const session = this.sessions.get(sessionId);
    if (!session) throw new BrowserServiceError("not_found", "Browser session not found.");
    session.info.status = "closing";
    this.sessions.delete(sessionId);
    await session.context.close().catch(() => undefined);
    // Non-persistent sessions shared a Browser; release the refcount. Persistent sessions owned
    // their own context (and thus their own browser process); nothing to release here.
    // Release the exact SharedBrowser this session took a count on. Looking it up by slot would
    // drift the refcount if the slot has since been replaced by a fresh launch.
    if (session.shared) { this.releaseSharedBrowser(session.shared); session.shared = null; }
    if (session.profilePath) this.profileLocks.delete(session.profilePath.toLowerCase());
    session.info.status = "closed";
    // Issue #93: the approval grant is scoped to THIS session, so closing it
    // revokes the grant — the next session must ask again.
    this.options.onSessionClosed?.(sessionId);
  }

  async newPage(sessionId: string, url?: string): Promise<BrowserPageInfo> {
    const session = this.requireSession(sessionId);
    await this.acquirePageSlot(session);
    const pageSlot = { value: true };
    session.lastActivityAt = Date.now();
    let page: Page;
    try {
      page = await session.context.newPage();
    } catch (error) {
      this.releasePageSlot(session, pageSlot);
      throw error;
    }
    const id = randomUUID();
    const info: BrowserPageInfo = { id, sessionId, url: "about:blank", title: "", status: "loading", active: session.pages.size === 0 };
    const managed: ManagedPage = {
      info,
      page,
      network: { entries: [], totalChars: 0, dropped: 0, nextId: 1 },
      consoleRing: { entries: [], totalChars: 0, dropped: 0, nextId: 1 },
      dialogs: { pending: null, ring: [], waiters: [] },
      downloads: [],
      downloadWaiters: [],
    };
    session.pages.set(id, managed);
    this.releasePageSlot(session, pageSlot);
    page.on("framenavigated", (frame) => {
      // staleAfter=navigation: a main-frame navigation invalidates every
      // snapshot record of this page, so old refs/coordinates can never act on
      // the new document (discovery contract — previously only aspirational).
      if (frame === page.mainFrame()) this.dropPageSnapshots(id);
      void this.refreshPageInfo(managed);
    });
    page.on("response", (response) => { void this.recordNetworkResponse(managed, response).catch(() => undefined); });
    // B3: dialog/download parking and the console/pageerror ring. Every handler
    // is bounded (auto-dismiss / auto-cancel / ring eviction) — nothing a page
    // emits can park an agent forever or grow memory without a cap.
    page.on("dialog", (dialog) => { try { this.parkDialog(managed, dialog); } catch { /* capture must not throw into the event loop */ } });
    page.on("download", (download) => { try { this.parkDownload(managed, download); } catch { /* bounded capture: drop on failure */ } });
    page.on("console", (message) => { try { this.recordConsoleMessage(managed, message); } catch { /* bounded capture */ } });
    page.on("pageerror", (error) => { try { this.recordPageError(managed, error); } catch { /* bounded capture */ } });
    page.on("close", () => {
      info.status = "closed";
      session.pages.delete(id);
      if (managed.dialogs.pending) this.settleDialog(managed, managed.dialogs.pending, "page-closed", () => undefined);
      for (const pending of managed.downloads.splice(0)) this.cancelPendingDownload(managed, pending, "page-closed");
    });
    if (url) await this.navigate(id, url);
    else { await this.refreshPageInfo(managed); info.status = "ready"; }
    this.syncSessionPages(session);
    return { ...info };
  }

  listPages(sessionId: string): BrowserPageInfo[] { return [...this.requireSession(sessionId).pages.values()].map((page) => ({ ...page.info })); }
  async selectPage(sessionId: string, pageId: string): Promise<BrowserPageInfo> {
    const session = this.requireSession(sessionId);
    const selected = this.requirePage(session, pageId);
    for (const page of session.pages.values()) page.info.active = page.info.id === pageId;
    await this.refreshPageInfo(selected);
    return { ...selected.info };
  }
  async closePage(sessionId: string, pageId: string): Promise<void> { await this.requirePage(this.requireSession(sessionId), pageId).page.close(); }

  async navigate(pageId: string, value: string, waitUntil: "load" | "domcontentloaded" | "networkidle" | "commit" = "domcontentloaded"): Promise<BrowserPageInfo> {
    const managed = this.requirePageById(pageId);
    const url = await validateBrowserRequestUrl(value, this.networkPolicy);
    await this.approve("navigate", managed, 1);
    managed.info.status = "loading";
    try {
      await managed.page.goto(url.toString(), { waitUntil, timeout: 30_000 });
      managed.info.status = "ready";
      await this.refreshPageInfo(managed);
      return { ...managed.info };
    } catch (error) {
      managed.info.status = "error";
      throw new BrowserServiceError(browserErrorCode(error), error instanceof Error ? error.message : "Navigation failed.");
    }
  }
  async goBack(pageId: string): Promise<BrowserPageInfo> { const page = this.requirePageById(pageId); await this.approve("back", page, 1); await page.page.goBack({ waitUntil: "domcontentloaded", timeout: 30_000 }).catch((error) => { throw new BrowserServiceError(browserErrorCode(error), "Back navigation failed."); }); await this.refreshPageInfo(page); return { ...page.info }; }
  async goForward(pageId: string): Promise<BrowserPageInfo> { const page = this.requirePageById(pageId); await this.approve("forward", page, 1); await page.page.goForward({ waitUntil: "domcontentloaded", timeout: 30_000 }).catch((error) => { throw new BrowserServiceError(browserErrorCode(error), "Forward navigation failed."); }); await this.refreshPageInfo(page); return { ...page.info }; }
  async reload(pageId: string): Promise<BrowserPageInfo> { const page = this.requirePageById(pageId); await page.page.reload({ waitUntil: "domcontentloaded", timeout: 30_000 }); await this.refreshPageInfo(page); return { ...page.info }; }
  async stop(pageId: string): Promise<void> { await this.requirePageById(pageId).page.evaluate(() => window.stop()).catch(() => undefined); }

  async snapshotPage(input: { pageId: string; mode?: "compact" | "full" | "interactive"; includeBoundingBoxes?: boolean; maxChars?: number }): Promise<BrowserSnapshot> {
    const managed = this.requirePageById(input.pageId);
    const snapshotId = randomUUID();
    const refs: Record<string, BrowserElementRef> = {};
    const frameSnapshots: BrowserFrameSnapshot[] = [];
    const frameMap = new Map<string, Frame>();
    const refNth = new Map<string, number>();
    let refNumber = 1;
    const frames = managed.page.frames();
    for (let index = 0; index < frames.length; index += 1) {
      const frame = frames[index];
      if (!frame) continue;
      const frameId = index === 0 ? "main" : `frame-${index}`;
      frameMap.set(frameId, frame);
      const collected = await frame.evaluate(collectSnapshotNodes, { includeBoundingBoxes: input.includeBoundingBoxes ?? false, interactive: input.mode === "interactive" });
      const nodes = collected.nodes;
      const frameRefs: string[] = [];
      // ponytail: per-frame hint occurrence counter. When two refs share a locatorHint (e.g. two
      // inputs with the same role+name), nthIndex disambiguates them at resolve time via .nth().
      const hintCounts = new Map<string, number>();
      for (const node of nodes) {
        const ref = `e${refNumber++}`;
        // Shadow-identity rule (§12.2): a shadow-hosted node resolves ONLY through
        // its composed css chain, and light nodes on a frame containing any open
        // shadow root get a :light-scoped css hint — a role/text hint could match
        // a same-named element across the boundary and click the wrong one.
        const locatorHint: Exclude<BrowserLocator, { strategy: "ref" }> = !node.inShadow && !collected.hasOpenShadowRoots && node.role && node.name
          ? { strategy: "role", role: node.role, name: node.name, exact: true }
          : { strategy: "css", selector: node.selector };
        const hintKey = JSON.stringify(locatorHint);
        const nthIndex = hintCounts.get(hintKey) ?? 0;
        hintCounts.set(hintKey, nthIndex + 1);
        refNth.set(ref, nthIndex);
        refs[ref] = {
          ref, frameId, ...(node.role ? { role: node.role } : {}), ...(node.name ? { name: node.name } : {}), ...(node.text ? { text: node.text } : {}), tag: node.tag,
          locatorHint,
          states: { ...(node.disabled !== undefined ? { disabled: node.disabled } : {}), ...(node.checked !== undefined ? { checked: node.checked } : {}), ...(node.selected !== undefined ? { selected: node.selected } : {}), ...(node.expanded !== undefined ? { expanded: node.expanded } : {}), ...(node.editable !== undefined ? { editable: node.editable } : {}), ...(node.visible !== undefined ? { visible: node.visible } : {}) },
          ...(node.boundingBox ? { boundingBox: node.boundingBox } : {}),
        };
        frameRefs.push(ref);
      }
      frameSnapshots.push({ frameId, url: frame.url(), refs: frameRefs });
    }
    const viewport = managed.page.viewportSize() ?? { width: 1280, height: 720 };
    // staleAfter=new_snapshot: a fresh snapshot supersedes every older record
    // of this page. Agents must always act on refs from the latest snapshot.
    for (const [existingId, existing] of [...this.snapshots.entries()]) {
      if (existing.pageId === input.pageId) this.snapshots.delete(existingId);
    }
    // P2 wall marker (§12.3): detect and report a captcha/blocked page in the
    // snapshot — never bypass, never auto-solve, never drop the flag.
    const wallText = await managed.page.evaluate(() => document.body?.innerText ?? "").catch(() => "");
    const blocked = detectBotWall(managed.page.url(), wallText.slice(0, 1_500));
    const snapshot: BrowserSnapshot = { ...(blocked ? { blocked, blockedReason: "captcha_wall" as const } : {}), snapshotId, pageId: input.pageId, url: managed.page.url(), title: await managed.page.title().catch(() => ""), capturedAt: new Date().toISOString(), viewport: { ...viewport, deviceScaleFactor: 1 }, scroll: await managed.page.evaluate(() => ({ x: window.scrollX, y: window.scrollY })).catch(() => ({ x: 0, y: 0 })), frames: frameSnapshots, refs, format: input.mode ?? "compact" };
    this.snapshots.set(snapshotId, { pageId: input.pageId, snapshot, frames: frameMap, refNth });
    if (this.snapshots.size > 200) this.snapshots.delete(this.snapshots.keys().next().value!);
    return trimSnapshot(snapshot, input.maxChars ?? SNAPSHOT_MAX_CHARS_DEFAULT);
  }

  async click(input: { pageId: string; target: BrowserLocator; button?: "left" | "right" | "middle"; modifiers?: ("Alt" | "Control" | "Meta" | "Shift")[]; timeoutMs?: number; returnSnapshot?: boolean }): Promise<BrowserActionResult> {
    return this.runLocatorAction("click", input.pageId, input.target, async (locator) => locator.click({ ...(input.button ? { button: input.button } : {}), ...(input.modifiers ? { modifiers: input.modifiers } : {}), ...(input.timeoutMs !== undefined ? { timeout: input.timeoutMs } : {}) }), input.returnSnapshot !== false);
  }
  async doubleClick(pageId: string, target: BrowserLocator): Promise<BrowserActionResult> { return this.runLocatorAction("doubleClick", pageId, target, (locator) => locator.dblclick(), true); }
  async hover(input: { pageId: string; target: BrowserLocator; timeoutMs?: number; returnSnapshot?: boolean }): Promise<BrowserActionResult> { return this.runLocatorAction("hover", input.pageId, input.target, (locator) => locator.hover(input.timeoutMs === undefined ? {} : { timeout: input.timeoutMs }), input.returnSnapshot !== false); }
  async scrollIntoView(input: { pageId: string; target: BrowserLocator; timeoutMs?: number; returnSnapshot?: boolean }): Promise<BrowserActionResult> { return this.runLocatorAction("scrollIntoView", input.pageId, input.target, (locator) => locator.scrollIntoViewIfNeeded(input.timeoutMs === undefined ? {} : { timeout: input.timeoutMs }), input.returnSnapshot !== false); }

  async scroll(input: { pageId: string; deltaX?: number; deltaY?: number }): Promise<{ ok: boolean; scroll: { x: number; y: number } }> {
    const managed = this.requirePageById(input.pageId);
    await managed.page.mouse.wheel(input.deltaX ?? 0, input.deltaY ?? 0);
    // wheel lands asynchronously in the renderer; give the scroll handler a beat
    // so the reported position reflects the wheel, not the pre-scroll state.
    await managed.page.waitForTimeout(50);
    const position = await managed.page.evaluate(() => ({ x: window.scrollX, y: window.scrollY })).catch(() => ({ x: 0, y: 0 }));
    return { ok: true, scroll: position };
  }

  /**
   * Bounded wait primitive (Phase 7 P0). Playwright auto-waits inside a single
   * deadline; a missed deadline is code "timeout" (504), never a retry hint on
   * the wrong element. appear/disappear build the locator WITHOUT resolving it
   * (the element may legitimately not exist yet), but ref targets still go
   * through the snapshot record so a stale ref fails closed.
   */
  async waitFor(input: { pageId: string; condition: "appear" | "disappear" | "text" | "url" | "networkidle"; target?: BrowserLocator; text?: string; exact?: boolean; url?: string; timeoutMs?: number }): Promise<{ satisfied: boolean; condition: string; url: string }> {
    const managed = this.requirePageById(input.pageId);
    const timeout = input.timeoutMs ?? 15_000;
    if ((input.condition === "appear" || input.condition === "disappear") && input.target === undefined) throw new BrowserServiceError("invalid_input", "waitFor requires target for appear/disappear.");
    if (input.condition === "text" && input.text === undefined) throw new BrowserServiceError("invalid_input", "waitFor requires text.");
    if (input.condition === "url" && input.url === undefined) throw new BrowserServiceError("invalid_input", "waitFor requires url.");
    try {
      switch (input.condition) {
        case "appear":
          await this.buildLocator(managed, input.target!).locator.first().waitFor({ state: "visible", timeout });
          break;
        case "disappear":
          await this.buildLocator(managed, input.target!).locator.first().waitFor({ state: "hidden", timeout });
          break;
        case "text":
          await managed.page.getByText(input.text!, { exact: input.exact === true }).first().waitFor({ state: "visible", timeout });
          break;
        case "url":
          await managed.page.waitForURL((url) => url.toString().includes(input.url!), { timeout });
          break;
        case "networkidle":
          await managed.page.waitForLoadState("networkidle", { timeout });
          break;
      }
    } catch (error) {
      if (error instanceof BrowserServiceError) throw error;
      const message = error instanceof Error ? error.message : String(error);
      throw new BrowserServiceError(/timeout/i.test(message) ? "timeout" : browserErrorCode(error), `waitFor (${input.condition}) failed: ${message}`);
    }
    await this.refreshPageInfo(managed);
    return { satisfied: true, condition: input.condition, url: managed.page.url() };
  }

  /**
   * Snapshot diff (Phase 7 P0): baseline must still be live (evicted/superseded
   * → stale_snapshot/409). The fresh capture supersedes every older snapshot of
   * the page, so its refs are the ones to act on afterwards. Identity keying is
   * the same frameId+locatorHint+nthOrdinal the resolver uses.
   */
  async snapshotDiff(input: { pageId: string; changedSinceSnapshotId: string; includeBoundingBoxes?: boolean }): Promise<BrowserSnapshotDiff> {
    // Presence/activity check (and the reason a dead page fails not_found).
    this.requirePageById(input.pageId);
    const baseline = this.snapshots.get(input.changedSinceSnapshotId);
    if (!baseline || baseline.pageId !== input.pageId) {
      throw new BrowserServiceError("stale_snapshot", "Baseline snapshot is stale (evicted or superseded); take a new snapshot and diff against that.");
    }
    const baselineByKey = new Map<string, { ref: string; frameId: string; hint: string; text?: string; states: string; box: string }>();
    for (const [ref, entry] of Object.entries(baseline.snapshot.refs)) {
      const key = snapshotIdentityKey(entry, baseline.refNth.get(ref) ?? 0);
      baselineByKey.set(key, { ref, frameId: entry.frameId, hint: JSON.stringify(entry.locatorHint), ...(entry.text !== undefined ? { text: entry.text } : {}), states: JSON.stringify(entry.states ?? {}), box: entry.boundingBox ? JSON.stringify(entry.boundingBox) : "" });
    }
    const fresh = await this.snapshotPage({ pageId: input.pageId, mode: "full", includeBoundingBoxes: input.includeBoundingBoxes ?? false, maxChars: 100_000 });
    const freshRecord = this.snapshots.get(fresh.snapshotId);
    if (!freshRecord) throw new BrowserServiceError("internal_error", "Fresh snapshot was evicted before the diff completed.");
    const added: string[] = [];
    const changed: BrowserSnapshotDiffChange[] = [];
    const matched = new Set<string>();
    for (const [ref, entry] of Object.entries(fresh.refs)) {
      const key = snapshotIdentityKey(entry, freshRecord.refNth.get(ref) ?? 0);
      const before = baselineByKey.get(key);
      if (!before) { added.push(ref); continue; }
      matched.add(key);
      const changes: string[] = [];
      if ((entry.text ?? undefined) !== before.text) changes.push("text");
      if (JSON.stringify(entry.states ?? {}) !== before.states) changes.push("states");
      if (input.includeBoundingBoxes === true && (entry.boundingBox ? JSON.stringify(entry.boundingBox) : "") !== before.box) changes.push("boundingBox");
      if (changes.length > 0) changed.push({ ref, baselineRef: before.ref, frameId: entry.frameId, changes });
    }
    const removed: BrowserSnapshotDiffRemoved[] = [];
    for (const [key, entry] of baselineByKey) {
      if (!matched.has(key)) removed.push({ ref: entry.ref, frameId: entry.frameId, hint: entry.hint });
    }
    return {
      kind: "diff", snapshotId: fresh.snapshotId, baselineSnapshotId: input.changedSinceSnapshotId,
      pageId: input.pageId, url: fresh.url, capturedAt: fresh.capturedAt,
      added: added.slice(0, SNAPSHOT_DIFF_MAX_LIST),
      changed: changed.slice(0, SNAPSHOT_DIFF_MAX_LIST),
      removed: removed.slice(0, SNAPSHOT_DIFF_MAX_LIST),
      counts: {
        baseline: baselineByKey.size, current: Object.keys(fresh.refs).length,
        addedTruncated: added.length > SNAPSHOT_DIFF_MAX_LIST,
        changedTruncated: changed.length > SNAPSHOT_DIFF_MAX_LIST,
        removedTruncated: removed.length > SNAPSHOT_DIFF_MAX_LIST,
      },
    };
  }

  /**
   * Read the per-page network body ring. Only text/JSON responses are captured
   * (binaries excluded at the door), URLs carry redacted query values, and the
   * result passes egress redaction at read time. Request headers/cookies are
   * never read, so they can never leak.
   */
  networkLog(input: { pageId: string; limit?: number; urlContains?: string }): BrowserNetworkLogResult {
    const managed = this.requirePageById(input.pageId);
    let entries = [...managed.network.entries].reverse();
    if (input.urlContains !== undefined) entries = entries.filter((entry) => entry.url.includes(input.urlContains!));
    entries = entries.slice(0, input.limit ?? NETWORK_LOG_MAX_ENTRIES);
    // Entry URLs are already query-redacted at capture time (redactUrlQuery);
    // re-running the generic secret patterns over them would match the
    // surviving `api_key=[REDACTED]` key=value tail and nuke the whole query.
    // Only the captured bodies still need full egress redaction here.
    return {
      pageId: input.pageId,
      entries: entries.map((entry) => {
        const redacted = { ...entry };
        if (entry.bodyText === undefined) delete redacted.bodyText;
        else redacted.bodyText = redactEgress(entry.bodyText);
        return redacted;
      }),
      dropped: managed.network.dropped,
      limits: { maxEntries: NETWORK_LOG_MAX_ENTRIES, maxTotalChars: NETWORK_LOG_MAX_TOTAL_CHARS, perBodyChars: NETWORK_BODY_MAX_CHARS },
    };
  }
  /**
   * Dialog policy (§12.2): accept/prompt is a level-2 per-request approval
   * (it can confirm a page-side action); dismiss is a safe interaction. The
   * pending dialog — or the next one within a bounded wait — is answered and
   * recorded; an unanswered dialog can never hang the page for more than
   * DIALOG_AUTO_DISMISS_MS thanks to the parked auto-dismiss.
   */
  async respondDialog(input: { pageId: string; response: "accept" | "dismiss" | "prompt"; promptText?: string; awaitMs?: number }): Promise<BrowserDialogResult> {
    const managed = this.requirePageById(input.pageId);
    const started = Date.now();
    let pending = managed.dialogs.pending;
    if (!pending && (input.awaitMs ?? 0) > 0) pending = await this.awaitDialog(managed, input.awaitMs!);
    if (!pending) {
      throw new BrowserServiceError((input.awaitMs ?? 0) > 0 ? "timeout" : "not_found", "No dialog is pending on this page.");
    }
    try {
      await this.approve("dialog", managed, input.response === "dismiss" ? 1 : 2);
    } catch (error) {
      // A denied/failed approval must not leave the renderer modal wedged until
      // the 30s safety timer. Dismiss is the fail-closed interpretation of a
      // refusal to accept/prompt and never confirms the page-side action.
      if (managed.dialogs.pending === pending) {
        this.settleDialog(managed, pending, "approval-denied", () => {
          void pending.dialog.dismiss().catch(() => undefined);
        });
      }
      throw error;
    }
    // TOCTOU: if the dialog was settled while approval was pending, fail closed
    // instead of answering a different dialog than the one the human saw.
    if (managed.dialogs.pending !== pending) throw new BrowserServiceError("not_found", "The dialog was already settled.");
    const responded: "accept" | "dismiss" = input.response === "dismiss" ? "dismiss" : "accept";
    this.settleDialog(managed, pending, `agent-${responded}`, () => {
      const answer = input.response === "prompt"
        ? pending.dialog.accept(input.promptText)
        : responded === "accept"
          ? pending.dialog.accept()
          : pending.dialog.dismiss();
      void answer.catch(() => undefined);
    });
    return { pageId: managed.info.id, kind: pending.kind, message: pending.message, responded, waitedMs: Date.now() - started };
  }

  /**
   * Download capture (§12.2): ALWAYS per-request level-2 approval; the file is
   * saved only under the browser cache downloads root inside userDataPath, with
   * a sanitized basename, extension denylist, size cap and post-write realpath
   * containment check. The reply is metadata only — never file bytes.
   */
  async downloadNext(input: { pageId: string; timeoutMs?: number }): Promise<BrowserDownloadResult> {
    const managed = this.requirePageById(input.pageId);
    await this.approve("download", managed, 2);
    let pending: PendingDownload | null | undefined = managed.downloads.find((candidate) => !candidate.resolved);
    if (!pending) pending = await this.awaitDownload(managed, input.timeoutMs ?? 10_000);
    if (!pending) throw new BrowserServiceError("timeout", "No download started within the bounded wait.");
    const extension = extname(pending.fileName).toLowerCase();
    if (DOWNLOAD_BLOCKED_EXTENSIONS.has(extension)) {
      this.cancelPendingDownload(managed, pending, "blocked-extension");
      throw new BrowserServiceError("permission_denied", "This download type is blocked by policy.");
    }
    const root = await realpath(this.options.userDataPath).catch(() => this.options.userDataPath);
    const directory = join(this.options.userDataPath, "browser-cache", "downloads");
    await mkdir(directory, { recursive: true });
    // The destination is constructed here (never caller-supplied): sanitized
    // basename + random suffix, then confined with the shared lexical+realpath
    // policy so traversal/symlink attempts fail closed.
    const destination = join(directory, `${pending.fileName.slice(0, 120)}-${randomUUID().slice(0, 8)}`);
    await assertAllowedPath(destination, { roots: [this.options.userDataPath], mustExist: false });
    try {
      await Promise.resolve(pending.download.saveAs(destination));
    } catch (error) {
      this.cancelPendingDownload(managed, pending, "save-failed");
      throw new BrowserServiceError(browserErrorCode(error), error instanceof Error ? error.message : "Download save failed.");
    }
    const written = await stat(destination).catch(() => null);
    if (!written) { this.cancelPendingDownload(managed, pending, "save-failed"); throw new BrowserServiceError("internal_error", "Download save produced no file."); }
    if (written.size > BROWSER_DOWNLOAD_MAX_BYTES) {
      await rm(destination, { force: true }).catch(() => undefined);
      this.cancelPendingDownload(managed, pending, "oversize");
      throw new BrowserServiceError("permission_denied", "Download exceeds the size limit.");
    }
    // Post-write containment: a symlink that appeared under the cache root
    // between the pre-check and the write must not smuggle bytes out of it.
    const real = await realpath(destination).catch(() => null);
    if (!real || !real.startsWith(root)) {
      await rm(destination, { force: true }).catch(() => undefined);
      this.cancelPendingDownload(managed, pending, "path-policy");
      throw new BrowserServiceError("policy_denied", "Download destination escaped the browser cache root.");
    }
    const sha256 = createHash("sha256").update(await readFile(destination)).digest("hex");
    pending.resolved = true;
    clearTimeout(pending.autoTimer);
    managed.downloads.splice(managed.downloads.indexOf(pending), 1);
    return { pageId: managed.info.id, fileName: pending.fileName, path: destination, bytes: written.size, sha256, url: pending.url };
  }

  /**
   * Plain fetch → markdown (§12.2): no browser, no browser cookies, no
   * credentials. Same DNS/SSRF policy as navigation, re-validated on every
   * redirect hop; bounded time and bytes; reply URLs are query-redacted; a
   * bot wall is reported as captcha_wall, never bypassed.
   */
  async fetchToMarkdown(input: { url: string; maxChars?: number; timeoutMs?: number }): Promise<BrowserFetchMarkdownResult> {
    const fetcher = this.options.fetchImpl ?? globalThis.fetch;
    if (!fetcher) throw new BrowserServiceError("internal_error", "fetch is unavailable in this runtime.");
    const timeoutMs = input.timeoutMs ?? 15_000;
    const maxChars = input.maxChars ?? 4_000;
    let current = (await validateBrowserRequestUrl(input.url, this.networkPolicy)).toString();
    let redirects = 0;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let response: Awaited<ReturnType<typeof globalThis.fetch>> | null;
    try {
      for (;;) {
        const hop = await fetcher(current, {
          redirect: "manual",
          signal: controller.signal,
          // Deliberately minimal: no cookies, no auth headers, no client hints.
          headers: { accept: "text/html,application/xhtml+xml;q=0.9", "user-agent": "Coterm/1.5 fetchToMarkdown" },
        }).catch((error) => {
          if (controller.signal.aborted || (error instanceof Error && error.name === "AbortError")) {
            throw new BrowserServiceError("timeout", "fetchToMarkdown timed out.");
          }
          throw new BrowserServiceError("navigation_timeout", error instanceof Error ? error.message : "fetchToMarkdown request failed.");
        });
        const location = hop.headers.get("location");
        if (hop.status >= 300 && hop.status < 400 && location) {
          if (redirects >= FETCH_MARKDOWN_MAX_REDIRECTS) { void hop.body?.cancel().catch(() => undefined); throw new BrowserServiceError("policy_denied", "fetchToMarkdown hit the redirect limit."); }
          redirects += 1;
          void hop.body?.cancel().catch(() => undefined);
          const next = new URL(location, current).toString();
          current = (await validateBrowserRequestUrl(next, this.networkPolicy)).toString();
          continue;
        }
        response = hop;
        break;
      }
      if (!response) throw new BrowserServiceError("internal_error", "fetchToMarkdown produced no response.");
      const contentType = (response.headers.get("content-type") ?? "").toLowerCase();
      if (!contentType.includes("text/html") && !contentType.includes("application/xhtml")) {
        void response.body?.cancel().catch(() => undefined);
        throw new BrowserServiceError("policy_denied", "fetchToMarkdown only accepts HTML documents.");
      }
      const declared = Number(response.headers.get("content-length") ?? "");
      let html = "";
      let truncated = false;
      let bytes = 0;
      if (Number.isFinite(declared) && declared > BROWSER_FETCH_MARKDOWN_MAX_BYTES) {
        // Never even read an oversized body off the wire (same discipline as the network ring).
        void response.body?.cancel().catch(() => undefined);
        truncated = true;
        bytes = declared;
      } else {
        const body = response.body;
        if (body) {
          const reader = body.getReader();
          const decoder = new TextDecoder("utf-8", { fatal: false });
          const parts: string[] = [];
          try {
            for (;;) {
              const chunk = await reader.read().catch((error: unknown) => {
                if (controller.signal.aborted) throw new BrowserServiceError("timeout", "fetchToMarkdown timed out.");
                throw new BrowserServiceError("navigation_timeout", error instanceof Error ? error.message : "fetchToMarkdown read failed.");
              });
              if (chunk.done) break;
              bytes += chunk.value.byteLength;
              if (bytes > BROWSER_FETCH_MARKDOWN_MAX_BYTES) { truncated = true; void reader.cancel().catch(() => undefined); break; }
              parts.push(decoder.decode(chunk.value, { stream: true }));
            }
          } finally {
            reader.releaseLock();
          }
          parts.push(decoder.decode());
          html = parts.join("");
        }
      }
      const { htmlToMarkdown } = await import("./browser-markdown");
      const rendered = htmlToMarkdown(html, current);
      // No-bypass wall detection (§12.3): report a wall, never solve it.
      if (html !== "" && detectBotWall(current, rendered.text.slice(0, 1_500))) throw new BrowserWallError(hostOf(current));
      const markdown = redactEgress(rendered.markdown);
      return {
        kind: "markdown",
        url: redactUrlQuery(input.url),
        finalUrl: redactUrlQuery(current),
        status: response.status,
        title: rendered.title.slice(0, 300),
        markdown: markdown.slice(0, maxChars),
        truncated: truncated || markdown.length > maxChars,
        bytes,
        redirects,
      };
    } finally {
      clearTimeout(timer);
    }
  }

  /** Read-only console/pageerror ring (§12.2): bounded, redacted at capture, never writable. */
  consoleLog(input: { pageId: string; limit?: number; source?: "console" | "pageerror"; level?: string }): BrowserConsoleLogResult {
    const managed = this.requirePageById(input.pageId);
    let entries = [...managed.consoleRing.entries].reverse();
    if (input.source !== undefined) entries = entries.filter((entry) => entry.source === input.source);
    if (input.level !== undefined) entries = entries.filter((entry) => entry.level === input.level);
    entries = entries.slice(0, input.limit ?? 50);
    // Entries were egress-redacted at capture time (raw page text), so no
    // read-time re-redaction: re-running the generic patterns would match the
    // surviving key=[REDACTED] tails and destroy the record (B1 lesson).
    return {
      pageId: input.pageId,
      entries: entries.map((entry) => {
        const copy = { ...entry };
        if (copy.text === undefined) delete copy.text;
        if (copy.location === undefined) delete copy.location;
        return copy;
      }),
      dropped: managed.consoleRing.dropped,
      limits: { maxEntries: CONSOLE_LOG_MAX_ENTRIES, maxTotalChars: CONSOLE_LOG_MAX_TOTAL_CHARS, perEntryChars: CONSOLE_ENTRY_MAX_CHARS },
    };
  }

  /**
   * Typed assertion (§12.2): text/url/visible/value → a boolean plus the
   * bounded redacted observation that decided it. Ref targets still fail
   * closed on a stale snapshot — an assert must never guess a selector.
   */
  async assert(input: { pageId: string; kind: "text" | "url" | "visible" | "value"; target?: BrowserLocator; text?: string; url?: string; expected?: string; exact?: boolean }): Promise<BrowserAssertResult> {
    const managed = this.requirePageById(input.pageId);
    const pageUrl = redactUrlQuery(managed.page.url());
    const base = { pageId: managed.info.id, kind: input.kind, url: pageUrl };
    if (input.kind === "url") {
      const passed = managed.page.url().includes(input.url!);
      return { ...base, passed, ...(input.url !== undefined ? { expected: input.url } : {}), actual: pageUrl.slice(0, 500) };
    }
    if (input.kind === "text") {
      const body = await managed.page.evaluate((cap) => (document.body?.innerText ?? "").slice(0, cap), ASSERT_TEXT_SCAN_CHARS).catch(() => "");
      const text = input.text!;
      const index = input.exact ? (body.trim() === text.trim() ? 0 : -1) : body.indexOf(text);
      const passed = index >= 0;
      const actual = passed
        ? redactEgress(body.slice(Math.max(0, index - 100), index + text.length + 100)).slice(0, 500)
        : undefined;
      return { ...base, passed, expected: text, ...(actual !== undefined ? { actual } : {}) };
    }
    const { locator } = this.buildLocator(managed, input.target!);
    if (input.kind === "visible") {
      const visible = await locator.isVisible().catch(() => false);
      return { ...base, passed: visible, actual: String(visible) };
    }
    const value = await locator.inputValue().catch(() => undefined);
    const expected = input.expected!;
    return { ...base, passed: value !== undefined && value === expected, expected: redactEgress(expected).slice(0, 500), ...(value !== undefined ? { actual: redactEgress(value).slice(0, 500) } : {}) };
  }

  /** Element screenshot by current ref (§12.2): artifact metadata only, never inline bytes. */
  async elementScreenshot(input: { pageId: string; target: BrowserLocator; format?: "png" | "jpeg"; quality?: number; timeoutMs?: number }): Promise<{ artifactPath: string; bytes: number }> {
    const managed = this.requirePageById(input.pageId);
    const locator = await this.resolveLocator(managed, input.target); // stale ref → fail closed
    const box = await locator.boundingBox().catch(() => null);
    if (!box) throw new BrowserServiceError("not_visible", "The element has no visible bounding box.");
    if (box.width * box.height > SCREENSHOT_MAX_PIXELS) throw new BrowserServiceError("invalid_input", "Element screenshot exceeds the pixel limit.");
    const format = input.format ?? "png";
    const data = await locator.screenshot({
      type: format,
      ...(format === "jpeg" && input.quality !== undefined ? { quality: input.quality } : {}),
      ...(input.timeoutMs !== undefined ? { timeout: input.timeoutMs } : {}),
    }).catch((error: unknown) => { throw new BrowserServiceError(browserErrorCode(error), error instanceof Error ? error.message : "Element screenshot failed."); });
    if (data.byteLength > SCREENSHOT_MAX_BYTES) throw new BrowserServiceError("permission_denied", "Element screenshot exceeds the size limit.");
    const artifactPath = await this.artifacts.saveScreenshot({ data, pageUrl: managed.page.url(), title: managed.info.title, extension: format });
    return { artifactPath, bytes: data.byteLength };
  }

  /**
   * Batch fill (§12.2): each field re-runs the locator + per-field approval
   * (a password-shaped field is level 3), secret handles are consumed
   * one-time. The result carries field metadata only — never values.
   */
  async batchFill(input: { pageId: string; fields: { target: BrowserLocator; value?: string; secretRef?: string; timeoutMs?: number }[]; stopOnError?: boolean; returnSnapshot?: boolean }): Promise<BrowserBatchFillResult> {
    const managed = this.requirePageById(input.pageId);
    const stopOnError = input.stopOnError !== false;
    const fields: BrowserBatchFillResult["fields"] = [];
    let ok = true;
    let stoppedEarly = false;
    for (let index = 0; index < input.fields.length; index += 1) {
      const field = input.fields[index]!;
      try {
        const locator = await this.resolveLocator(managed, field.target);
        const info = await locator.evaluate((element) => ({ role: element.getAttribute("role") ?? element.tagName.toLowerCase(), name: element.getAttribute("aria-label") ?? element.getAttribute("name") ?? element.getAttribute("placeholder") ?? "" })).catch(() => ({}));
        // Per-field approval (§12.2): the human decides on every field, and
        // password-shaped targets stay level 3 — a batch cannot flatten risk.
        await this.approve("fill", managed, browserRisk("fill", info), field.target.strategy);
        const value = field.secretRef ? await this.takeSecret(field.secretRef) : field.value;
        if (value === undefined) throw new BrowserServiceError("permission_denied", "Secret handle cannot be resolved.");
        await locator.fill(value, field.timeoutMs === undefined ? {} : { timeout: field.timeoutMs });
        fields.push({ index, ok: true });
      } catch (error) {
        ok = false;
        const code = error instanceof BrowserServiceError ? error.code : browserErrorCode(error);
        fields.push({ index, ok: false, code, error: (error instanceof Error ? error.message : "fill failed").slice(0, 300) });
        if (stopOnError) { stoppedEarly = true; break; }
      }
    }
    await this.refreshPageInfo(managed);
    const result: BrowserBatchFillResult = { kind: "batchFill", pageId: managed.info.id, ok, fields, stoppedEarly };
    if (input.returnSnapshot === true) result.snapshot = await this.snapshotPage({ pageId: managed.info.id, mode: "compact", maxChars: 20_000 });
    return result;
  }
  async focus(pageId: string, target: BrowserLocator): Promise<BrowserActionResult> { return this.runLocatorAction("focus", pageId, target, (locator) => locator.focus(), true); }
  async fill(input: { pageId: string; target: BrowserLocator; value?: string; secretRef?: string; timeoutMs?: number; returnSnapshot?: boolean }): Promise<BrowserActionResult> {
    const page = this.requirePageById(input.pageId);
    const locator = await this.resolveLocator(page, input.target);
    const info = await locator.evaluate((element) => ({ role: element.getAttribute("role") ?? element.tagName.toLowerCase(), name: element.getAttribute("aria-label") ?? element.getAttribute("name") ?? element.getAttribute("placeholder") ?? "" })).catch(() => ({}));
    await this.approve("fill", page, browserRisk("fill", info), input.target.strategy);
    const value = input.secretRef ? await this.resolveSecret(input.secretRef) : input.value;
    if (value === undefined) throw new BrowserServiceError("permission_denied", "Secret handle cannot be resolved.");
    return this.finishLocatorAction("fill", page, async () => locator.fill(value, input.timeoutMs === undefined ? {} : { timeout: input.timeoutMs }), input.returnSnapshot !== false);
  }
  async type(input: { pageId: string; target: BrowserLocator; text: string; timeoutMs?: number | undefined; returnSnapshot?: boolean | undefined }): Promise<BrowserActionResult> { return this.runLocatorAction("type", input.pageId, input.target, (locator) => locator.pressSequentially(input.text, input.timeoutMs === undefined ? {} : { timeout: input.timeoutMs }), input.returnSnapshot !== false); }
  async press(input: { pageId: string; target: BrowserLocator; key: string; returnSnapshot?: boolean }): Promise<BrowserActionResult> { return this.runLocatorAction("press", input.pageId, input.target, (locator) => locator.press(input.key), input.returnSnapshot !== false); }
  async check(pageId: string, target: BrowserLocator): Promise<BrowserActionResult> { return this.runLocatorAction("check", pageId, target, (locator) => locator.check(), true); }
  async uncheck(pageId: string, target: BrowserLocator): Promise<BrowserActionResult> { return this.runLocatorAction("uncheck", pageId, target, (locator) => locator.uncheck(), true); }
  async selectOption(pageId: string, target: BrowserLocator, value: string | string[]): Promise<BrowserActionResult> { return this.runLocatorAction("select", pageId, target, (locator) => locator.selectOption(value), true); }
  async setInputFiles(pageId: string, target: BrowserLocator, files: string | string[]): Promise<BrowserActionResult> {
    this.requirePageById(pageId);
    const sourceFiles = Array.isArray(files) ? files : [files];
    const allowedRoot = this.options.workspaceRoot ?? this.options.userDataPath;
    const allowedFiles = await Promise.all(sourceFiles.map((file) => assertAllowedPath(file, { roots: [allowedRoot] })));
    return this.runLocatorAction("upload", pageId, target, (locator) => locator.setInputFiles(allowedFiles), true);
  }

  async clickCoordinates(input: { pageId: string; x: number; y: number; coordinateSpace: "viewport" | "document" | "screenshot"; snapshotId: string; screenshotWidth?: number; screenshotHeight?: number; returnSnapshot?: boolean }): Promise<BrowserActionResult> {
    const managed = this.requirePageById(input.pageId);
    const record = this.snapshots.get(input.snapshotId);
    if (!record || record.pageId !== input.pageId) throw new BrowserServiceError("stale_snapshot", "Coordinate action requires a current snapshot.");
    // Coordinates are only meaningful on the exact document they were captured
    // from: same URL, same scroll. (Navigation also deletes the record outright.)
    if (managed.page.url() !== record.snapshot.url) throw new BrowserServiceError("stale_snapshot", "The page URL changed since the snapshot was captured.");
    const currentScroll = await managed.page.evaluate(() => ({ x: window.scrollX, y: window.scrollY }));
    if (currentScroll.x !== record.snapshot.scroll.x || currentScroll.y !== record.snapshot.scroll.y) throw new BrowserServiceError("stale_snapshot", "The page moved since the snapshot was captured.");
    const viewport = managed.page.viewportSize() ?? { width: 1280, height: 720 };
    let x = input.x; let y = input.y;
    if (input.coordinateSpace === "document") { x -= currentScroll.x; y -= currentScroll.y; }
    if (input.coordinateSpace === "screenshot") {
      if (!input.screenshotWidth || !input.screenshotHeight) throw new BrowserServiceError("stale_snapshot", "Screenshot dimensions are required for screenshot coordinates.");
      x *= viewport.width / input.screenshotWidth; y *= viewport.height / input.screenshotHeight;
    }
    if (x < 0 || y < 0 || x > viewport.width || y > viewport.height) throw new BrowserServiceError("not_found", "Coordinate is outside the page viewport.");
    await this.approve("clickCoordinates", managed, 1, "coordinates");
    const before = managed.page.url();
    await managed.page.mouse.move(x, y); await managed.page.mouse.click(x, y);
    return this.finishAction(managed, before, input.returnSnapshot !== false, [`Coordinate fallback used at ${Math.round(x)},${Math.round(y)}.`]);
  }

  /**
   * Run a bounded JavaScript expression in the page context (AT-133). Risk level 3
   * — arbitrary JS can read and mutate everything on the page — so it always goes
   * through per-request approval. Playwright's evaluate has no timeout of its own,
   * so the call races a timer; on timeout the in-page script still runs to
   * completion but the caller gets a typed error. The result must be
   * JSON-serializable and stays size-bounded.
   */
  async evaluate(input: { pageId: string; script: string; timeoutMs?: number }): Promise<unknown> {
    const managed = this.requirePageById(input.pageId);
    if (input.script.length === 0 || input.script.length > EVALUATE_SCRIPT_MAX_CHARS) {
      throw new BrowserServiceError("invalid_input", `evaluate script must be 1..${EVALUATE_SCRIPT_MAX_CHARS} characters.`);
    }
    // Origin TOCTOU: the human approves the script for THIS origin; a page that
    // navigated mid-approval must not run a script approved for a different
    // origin. Fail closed with no auto re-request — the caller starts over.
    const approvedOrigin = new URL(managed.page.url()).origin;
    await this.approve("evaluate", managed, 3, undefined, {
      previewScript: input.script.slice(0, EVALUATE_PREVIEW_MAX_CHARS),
      previewTruncated: input.script.length > EVALUATE_PREVIEW_MAX_CHARS,
    });
    const currentOrigin = new URL(managed.page.url()).origin;
    if (currentOrigin !== approvedOrigin) {
      throw new BrowserServiceError("policy_denied", `evaluate aborted: the page origin changed during approval (${approvedOrigin} -> ${currentOrigin}); re-request approval on the new origin.`);
    }
    let timer: NodeJS.Timeout | null = null;
    try {
      const value = await Promise.race([
        managed.page.evaluate(input.script),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(new BrowserServiceError("timeout", "evaluate script timed out.")), input.timeoutMs ?? EVALUATE_DEFAULT_TIMEOUT_MS);
        }),
      ]);
      // JSON round-trip: BigInt / circular / DOM handle results must fail loudly
      // instead of silently degrading into `{}` across the HTTP/MCP boundary.
      try {
        const serialized = JSON.stringify(value === undefined ? null : value);
        if (serialized.length > EVALUATE_RESULT_MAX_CHARS) throw new BrowserServiceError("invalid_input", `evaluate result exceeds ${EVALUATE_RESULT_MAX_CHARS} characters when serialized.`);
        return JSON.parse(serialized) as unknown;
      } catch (error) {
        if (error instanceof BrowserServiceError) throw error;
        throw new BrowserServiceError("internal_error", "evaluate result is not JSON-serializable.");
      }
    } catch (error) {
      if (error instanceof BrowserServiceError) throw error;
      throw new BrowserServiceError(browserErrorCode(error), error instanceof Error ? error.message : "evaluate failed.");
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  async screenshot(
    pageId: string,
    options: { fullPage?: boolean; artifactOnly?: boolean; format?: "png" | "jpeg"; quality?: number; scale?: "css" | "device" } = {},
  ): Promise<string | { artifactPath: string; bytes: number }> {
    const managed = this.requirePageById(pageId);
    const format = options.format ?? "png";
    // P2 pixel ceiling (§12.3): a full-page shot of a 100 000px document is a
    // memory bomb even before the byte check; bound the DOCUMENT-side area
    // (scaled) and fail closed with invalid_input so the caller fixes the ask.
    const viewport = managed.page.viewportSize() ?? { width: 1280, height: 720 };
    const subject = options.fullPage === true
      ? await managed.page.evaluate(() => ({ width: Math.max(document.documentElement?.scrollWidth ?? 0, document.body?.scrollWidth ?? 0), height: Math.max(document.documentElement?.scrollHeight ?? 0, document.body?.scrollHeight ?? 0), dsf: window.devicePixelRatio || 1 })).catch(() => null)
      : { ...viewport, dsf: 1 };
    if (subject) {
      const factor = options.scale === "device" ? subject.dsf : 1;
      if (subject.width * subject.height * factor * factor > SCREENSHOT_MAX_PIXELS) {
        throw new BrowserServiceError("invalid_input", "Screenshot exceeds the pixel limit for this page.");
      }
    }
    const data = await managed.page.screenshot({
      type: format,
      ...(format === "jpeg" && options.quality !== undefined ? { quality: options.quality } : {}),
      scale: options.scale ?? "css",
      fullPage: options.fullPage ?? false,
    });
    if (data.byteLength > SCREENSHOT_MAX_BYTES) throw new BrowserServiceError("permission_denied", "Screenshot exceeds the size limit.");
    // MCP transport uses artifactOnly: the base64 dataUrl is a context bomb
    // (~100KB+), so the tool returns the artifact path and the agent Reads the
    // file. Persist unconditionally in this mode (the UI rail callback is
    // unrelated to whether the agent needs the file).
    if (options.artifactOnly === true) {
      const artifactPath = await this.artifacts.saveScreenshot({
        data,
        pageUrl: managed.page.url(),
        title: managed.info.title,
        extension: format,
      });
      return { artifactPath, bytes: data.byteLength };
    }
    // Persist beside returning the dataUrl so the shot surfaces in the artifact
    // rail without the agent pasting anything. A cache write failure must never
    // fail the screenshot itself (same rule as the extract cache below).
    await this.saveScreenshotArtifact(managed, data, options.format ?? "png").catch((error: unknown) => {
      console.warn("[browser] screenshot artifact save failed:", error);
    });
    return `data:image/${format};base64,${data.toString("base64")}`;
  }

  private async saveScreenshotArtifact(managed: ManagedPage, data: Buffer, format: "png" | "jpeg"): Promise<void> {
    const notify = this.options.onScreenshotSaved;
    if (!notify) return;
    const pageUrl = managed.page.url();
    const path = await this.artifacts.saveScreenshot({ data, pageUrl, title: managed.info.title, extension: format });
    notify({ path, pageUrl, title: managed.info.title, savedAt: new Date().toISOString() });
  }

  async extractPage(input: BrowserExtractionOptions): Promise<BrowserExtractResult> {
    const parsed = browserExtractInputSchema.parse(input);
    const managed = this.requirePageById(input.pageId);
    // Links are always collected so the index can build its `related` edges; without them the
    // links table stays empty and `related` silently returns nothing. They are stripped from the
    // reply unless the caller asked, because a link dump is expensive context.
    const document = await managed.page.evaluate(collectDocument, { mainContentOnly: parsed.mainContentOnly, includeLinks: true, includeImages: parsed.includeImages, includeForms: parsed.includeForms, maxChars: parsed.maxChars, mode: parsed.mode });
    const fullText = document.text;
    // Detect before caching: a captcha page must not land in the index as if it were the site.
    if (detectBotWall(document.source.finalUrl, fullText)) throw new BrowserWallError(hostOf(document.source.finalUrl));
    const truncated = fullText.length > parsed.maxChars;
    const textLen = fullText.length;
    // The reply is capped at maxChars, so the full text has to land somewhere or it is simply
    // lost. Cache + index it here; the caller gets a path it can read back or search. A cache
    // failure must never fail the extract itself.
    const artifactPath = await this.artifacts.save({ projectId: null, document, format: "markdown" }).catch((error) => {
      console.warn("[browser] extract cache failed:", error);
      return undefined;
    });
    const reply = parsed.includeLinks ? document : { ...document, links: [] };
    const base = { title: document.source.title, finalUrl: document.source.finalUrl, textLen, truncated, ...(artifactPath ? { artifactPath } : {}) };
    if (parsed.format === "json") return { ...base, document: reply };
    if (parsed.format === "text") return { ...base, text: fullText.slice(0, parsed.maxChars) };
    const { documentToMarkdown } = await import("./browser-markdown");
    return { ...base, text: documentToMarkdown(reply, parsed.maxChars) };
  }

  /**
   * One call = one WebSearch. Without this an agent needs three curls and a parser to do what a
   * search API does in one shot, which is most of why the built-in browser was not actually usable
   * as a search tool. Engines are tried in order and a wall on one falls through to the next.
   */
  async searchWeb(input: { query: string; limit?: number }): Promise<BrowserSearchHit[]> {
    const limit = input.limit ?? 10;
    const pageId = await this.searchPageId();
    const failures: string[] = [];
    for (const engine of SEARCH_ENGINES) {
      try {
        await this.navigate(pageId, engine.url(input.query));
        const page = this.requirePageById(pageId).page;
        // Results render client-side; without this the parser reads an empty shell and the engine
        // looks like it returned nothing. A miss here is fine — the wall check below explains why.
        await page.waitForSelector(engine.item, { timeout: 8_000 }).catch(() => undefined);
        const text = await page.evaluate(() => document.body?.innerText ?? "");
        // A search page with no results and almost no text is a block page in some language we do
        // not have a pattern for — treat it as a wall rather than "this query found nothing".
        if (detectBotWall(page.url(), text) || text.trim().length < 300) { failures.push(`${engine.host}: bot wall`); continue; }
        const hits = await page.evaluate(collectSearchHits, { item: engine.item, title: engine.title, ...(engine.snippetList ? { snippetList: engine.snippetList } : {}) });
        if (hits.length > 0) return hits.slice(0, limit);
        failures.push(`${engine.host}: no results`);
      } catch (error) {
        failures.push(`${engine.host}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    throw new BrowserWallError(SEARCH_ENGINES.map((engine) => engine.host).join(", "), `Every search engine failed or was walled (${failures.join("; ")}). Both throttle by IP — wait rather than retry immediately.`);
  }

  /**
   * Turn a local HTML file into a loopback URL this browser is allowed to open. Without this an
   * agent can generate a three.js page but never look at it: `file:` is a blocked scheme and the
   * private-network rule covers 127.0.0.1, so there was no path from "I wrote it" to "I can see it".
   */
  async previewLocalFile(input: { path: string }): Promise<{ url: string }> {
    const port = this.options.loopbackPort?.();
    if (!port) throw new BrowserServiceError("policy_denied", "Local preview needs Coterm's web server to be running.");
    const roots = this.options.previewRoots?.() ?? [];
    if (roots.length === 0) throw new BrowserServiceError("policy_denied", "No directory is approved for local preview.");
    const allowedPath = await assertAllowedPath(input.path, { roots });
    if (!/\.html?$/i.test(allowedPath)) throw new BrowserServiceError("policy_denied", "Local preview is limited to .html files.");
    const { mintArtifactPreviewToken } = await import("../web/artifact-preview-tokens");
    const token = mintArtifactPreviewToken(dirname(allowedPath));
    return { url: `http://127.0.0.1:${port}/artifact-preview/${token}/${encodeURIComponent(basename(allowedPath))}` };
  }

  /** One long-lived page for search, so N queries do not cost N sessions out of the pool. */
  private async searchPageId(): Promise<string> {
    const existing = this.searchPage;
    if (existing && this.sessions.get(existing.sessionId)?.pages.has(existing.pageId)) return existing.pageId;
    const session = await this.createSession({ mode: "headless" });
    const pageId = session.pages[0]?.id;
    if (!pageId) throw new BrowserServiceError("internal_error", "Search session has no page.");
    this.searchPage = { sessionId: session.id, pageId };
    return pageId;
  }

  async saveExtraction(input: { pageId: string; format: "json" | "markdown" | "text"; projectId?: string; destinationPath?: string }): Promise<string> {
    await this.approve("saveExtraction", this.requirePageById(input.pageId), 1);
    const result = await this.extractPage({ pageId: input.pageId, format: "json", includeLinks: true });
    const document = (result as { document: BrowserDocument }).document;
    return this.artifacts.save({ projectId: input.projectId ?? null, document, format: input.format, ...(input.destinationPath ? { destinationPath: input.destinationPath } : {}) });
  }
  searchBrowserIndex(input: { projectId?: string; query: string; host?: string; crawlId?: string; limit?: number }): BrowserSearchResult[] { return this.artifacts.search({ projectId: input.projectId ?? null, query: input.query, ...(input.host !== undefined ? { host: input.host } : {}), ...(input.crawlId !== undefined ? { crawlId: input.crawlId } : {}), ...(input.limit !== undefined ? { limit: input.limit } : {}) }); }

  async crawlSite(input: { sessionId: string; startUrl: string; projectId: string; sameOriginOnly?: boolean; maxPages?: number; maxDepth?: number; outputDirectory?: string }): Promise<{ crawlId: string; startUrl: string; pages: { url: string; markdownPath?: string; jsonPath?: string; sha256: string }[] }> {
    const crawlId = randomUUID(); const start = validateBrowserUrl(input.startUrl, this.networkPolicy); const origin = start.origin; const queue: { url: string; depth: number }[] = [{ url: start.toString(), depth: 0 }]; const seen = new Set<string>(); const pages: { url: string; markdownPath?: string; jsonPath?: string; sha256: string }[] = []; const page = await this.newPage(input.sessionId);
    try {
      while (queue.length > 0 && pages.length < Math.min(input.maxPages ?? 50, 50)) {
        const next = queue.shift()!; const normalized = new URL(next.url); normalized.hash = ""; const url = normalized.toString(); if (seen.has(url) || (input.sameOriginOnly !== false && normalized.origin !== origin)) continue; seen.add(url);
        try { await this.navigate(page.id, url); const extractResult = await this.extractPage({ pageId: page.id, format: "json", includeLinks: true }); const document = (extractResult as { document: BrowserDocument }).document; const markdownPath = input.outputDirectory ? join(input.outputDirectory, `${pages.length + 1}.md`) : undefined; const jsonPath = input.outputDirectory ? join(input.outputDirectory, `${pages.length + 1}.json`) : undefined; await this.artifacts.addDocument(input.projectId, document, { ...(markdownPath ? { markdownPath } : {}), ...(jsonPath ? { jsonPath } : {}) }, crawlId); pages.push({ url, ...(markdownPath ? { markdownPath } : {}), ...(jsonPath ? { jsonPath } : {}), sha256: createHash("sha256").update(document.text).digest("hex") }); if (next.depth < (input.maxDepth ?? 3)) for (const link of document.links) { try { const child = new URL(link.url, url); child.hash = ""; if (child.protocol === "http:" || child.protocol === "https:") queue.push({ url: child.toString(), depth: next.depth + 1 }); } catch { /* malformed link */ } } } catch { /* one failed page must not abort a bounded crawl */ }
      }
    } finally { await this.closePage(input.sessionId, page.id).catch(() => undefined); }
    return { crawlId, startUrl: input.startUrl, pages };
  }

  async dispose(): Promise<void> {
    for (const id of [...this.sessions.keys()]) await this.closeSession(id);
    this.snapshots.clear();
    if (this.idleSweeper) { clearInterval(this.idleSweeper); this.idleSweeper = null; }
    for (const shared of [this.sharedBrowsers.headless, this.sharedBrowsers.headed]) {
      if (shared && shared.refcount > 0) await shared.browser.close().catch(() => undefined);
    }
    this.sharedBrowsers = { headless: null, headed: null };
    this.artifacts.close();
  }

  private async acquireSharedBrowser(headless: boolean, windowArgs: string[] = []): Promise<SharedBrowser> {
    const slot: "headless" | "headed" = headless ? "headless" : "headed";
    const existing = this.sharedBrowsers[slot];
    if (existing) { existing.refcount += 1; return existing; }
    const inFlight = this.sharedLaunches[slot];
    if (inFlight) { const shared = await inFlight; shared.refcount += 1; return shared; }
    const launch = (async (): Promise<SharedBrowser> => {
      const { chromium } = await import("playwright");
      const launchOptions: Record<string, unknown> = {
        headless,
        // B3: downloads are parked and TTL-cancelled; nothing is saved without per-request approval.
        acceptDownloads: true, ignoreHTTPSErrors: false,
        // windowArgs carries the popout placement (--window-position/--window-size)
        // on the FIRST launch of this slot; later contexts are OS-placed by Chromium.
        args: ["--disable-blink-features=AutomationControlled", ...windowArgs],
      };
      const browser = await chromium.launch({ ...launchOptions, ...channelLaunchOptions() });
      const shared: SharedBrowser = { browser, refcount: 0 };
      this.sharedBrowsers[slot] = shared;
      return shared;
    })().finally(() => { this.sharedLaunches[slot] = null; });
    this.sharedLaunches[slot] = launch;
    const shared = await launch;
    shared.refcount += 1;
    return shared;
  }

  private releaseSharedBrowser(shared: SharedBrowser): void {
    shared.refcount -= 1;
    if (shared.refcount > 0) return;
    const slot: "headless" | "headed" = this.sharedBrowsers.headless === shared ? "headless" : "headed";
    this.sharedBrowsers[slot] = null;
    void shared.browser.close().catch(() => undefined);
  }

  private async runLocatorAction(action: string, pageId: string, target: BrowserLocator, operation: (locator: Locator) => Promise<unknown>, returnSnapshot: boolean): Promise<BrowserActionResult> { const page = this.requirePageById(pageId); const locator = await this.resolveLocator(page, target); await this.approve(action, page, browserRisk(action), target.strategy); return this.finishLocatorAction(action, page, () => operation(locator), returnSnapshot); }
  private async finishLocatorAction(action: string, managed: ManagedPage, operation: () => Promise<unknown>, returnSnapshot: boolean): Promise<BrowserActionResult> { const before = managed.page.url(); try { await operation(); } catch (error) { throw new BrowserServiceError(browserErrorCode(error), error instanceof Error ? error.message : `${action} failed.`); } await this.refreshPageInfo(managed); return this.finishAction(managed, before, returnSnapshot); }
  private async finishAction(managed: ManagedPage, before: string, returnSnapshot: boolean, warnings: string[] = []): Promise<BrowserActionResult> { const after = managed.page.url(); const result: BrowserActionResult = { ok: true, actionId: randomUUID(), pageId: managed.info.id, urlBefore: before, urlAfter: after, navigationOccurred: before !== after, warnings }; if (returnSnapshot) result.snapshot = await this.snapshotPage({ pageId: managed.info.id, mode: "compact", maxChars: 20_000 }); return result; }
  /**
   * Build the raw locator for a target WITHOUT resolving it. Ref targets still
   * go through the snapshot record (stale → stale_snapshot) — this is what
   * waitFor uses for elements that may legitimately not exist yet. Existence /
   * ambiguity counting stays in resolveLocator below.
   */
  private buildLocator(managed: ManagedPage, target: BrowserLocator): { locator: Locator; refNthIndex?: number } {
    const parsed = browserLocatorSchema.parse(target);
    if (parsed.strategy !== "ref") return { locator: this.locatorFrom(managed.page.mainFrame(), parsed) };
    const record = this.snapshots.get(parsed.snapshotId);
    const ref = record?.snapshot.refs[parsed.ref];
    const frame = record?.frames.get(ref?.frameId ?? "");
    if (!record || record.pageId !== managed.info.id || !ref || !frame) throw new BrowserServiceError("stale_snapshot", "The element ref is stale.");
    const nth = record.refNth.get(parsed.ref);
    return { locator: this.locatorFrom(frame, ref.locatorHint), ...(nth !== undefined ? { refNthIndex: nth } : {}) };
  }

  private async resolveLocator(managed: ManagedPage, target: BrowserLocator): Promise<Locator> {
    const parsed = browserLocatorSchema.parse(target);
    const { locator, refNthIndex } = this.buildLocator(managed, parsed);
    const count = await locator.count().catch((error) => { throw new BrowserServiceError(browserErrorCode(error), "Failed to resolve browser locator."); });
    if (count === 0) throw new BrowserServiceError("not_found", "No element matched the locator.");
    // ponytail: ref strategy uses the snapshot-time ordinal so a hint that matches N elements still
    // resolves to the one the agent saw. Non-ref strategies keep the hard ambiguous error — callers
    // wrote those selectors themselves and a loose match is their bug to fix.
    if (count > 1) {
      if (parsed.strategy === "ref" && refNthIndex !== undefined && refNthIndex < count) return locator.nth(refNthIndex);
      throw new BrowserServiceError("ambiguous", `Locator matched ${count} elements.`);
    }
    return locator;
  }
  private locatorFrom(frame: Frame, target: Exclude<BrowserLocator, { strategy: "ref" }>): Locator { switch (target.strategy) { case "role": return frame.getByRole(target.role as never, target.name === undefined ? {} : { name: target.name, ...(target.exact !== undefined ? { exact: target.exact } : {}) }); case "text": return frame.getByText(target.text, target.exact === undefined ? {} : { exact: target.exact }); case "label": return frame.getByLabel(target.label, target.exact === undefined ? {} : { exact: target.exact }); case "placeholder": return frame.getByPlaceholder(target.placeholder, target.exact === undefined ? {} : { exact: target.exact }); case "testId": return frame.getByTestId(target.testId); case "css": return frame.locator(target.selector); case "xpath": return frame.locator(`xpath=${target.selector}`); } }
  // NOTE on TOCTOU: the post-approval origin re-check lives in evaluate() only;
  // click/fill keep the pre-existing behavior (no re-check) for now.
  // Typed error codes (work order B1): a denial is approval_denied, a broker
  // timeout surfaces from the service as approval_timeout — policy_denied is
  // reserved for actual policy blocks (URL scheme, SSRF, disabled superpowers).
  private async approve(action: string, managed: ManagedPage, level: 0 | 1 | 2 | 3, locatorStrategy?: string, preview?: { previewScript: string; previewTruncated: boolean }): Promise<void> {
    if (level === 0) return;
    if (!this.options.requestApproval) {
      if (level >= 2) throw new BrowserServiceError("approval_denied", "Browser action requires approval but no approval channel is connected.");
      return;
    }
    let allowed: boolean;
    try {
      allowed = await this.options.requestApproval({ action, level, sessionId: managed.info.sessionId, pageId: managed.info.id, origin: new URL(managed.page.url()).origin, ...(locatorStrategy ? { locatorStrategy } : {}), ...(preview ?? {}) });
    } catch (error) {
      if (error instanceof BrowserServiceError) throw error;
      throw new BrowserServiceError("internal_error", "Browser approval request failed.");
    }
    if (!allowed) throw new BrowserServiceError("approval_denied", "Browser action was denied by the approver.");
  }
  private async resolveSecret(secretRef: string): Promise<string> {
    if (!this.options.resolveSecret) throw new BrowserServiceError("secret_unavailable", "Secret is unavailable.");
    try { return await this.options.resolveSecret(secretRef); }
    catch { throw new BrowserServiceError("secret_unavailable", "Secret is unavailable."); }
  }
  private requireSession(id: string): ManagedSession {
    const session = this.sessions.get(id);
    if (!session) throw new BrowserServiceError("not_found", "Browser session not found.");
    // Typed state errors (work order B1): acting on a half-built or dead session
    // must not surface as a generic crash/policy error.
    if (session.info.status === "crashed") throw new BrowserServiceError("browser_crashed", "Browser session crashed; create a new session.");
    if (session.info.status !== "ready") throw new BrowserServiceError("session_not_ready", `Browser session is ${session.info.status}.`);
    session.lastActivityAt = Date.now();
    return session;
  }

  private dropPageSnapshots(pageId: string): void {
    for (const [snapshotId, record] of [...this.snapshots.entries()]) {
      if (record.pageId === pageId) this.snapshots.delete(snapshotId);
    }
  }

  private async recordNetworkResponse(managed: ManagedPage, response: Response): Promise<void> {
    const headers = await response.allHeaders().catch(() => ({}));
    const contentType = String(headers["content-type"] ?? "").toLowerCase();
    // Only text-shaped bodies are useful to an agent and safe to store; media,
    // fonts and archives are excluded at the door.
    const isText = contentType.startsWith("text/") || contentType.includes("json") || contentType.includes("javascript") || contentType.includes("xml");
    if (!isText) return;
    const ring = managed.network;
    const entry: BrowserNetworkLogEntry = {
      id: ring.nextId,
      url: redactUrlQuery(response.url()),
      method: response.request().method(),
      status: response.status(),
      contentType: contentType.split(";")[0] ?? contentType,
      truncated: false,
      capturedAt: new Date().toISOString(),
    };
    ring.nextId += 1;
    const declaredLengthHeader = String(headers["content-length"] ?? "");
    const declaredLength = Number(declaredLengthHeader);
    if (declaredLengthHeader === "" || !Number.isFinite(declaredLength) || declaredLength < 0) {
      // Playwright exposes response bodies as an all-at-once Buffer/string. A
      // chunked or malformed response has no trustworthy upper bound, so keep
      // only metadata instead of risking an unbounded allocation.
      entry.truncated = true;
    } else if (declaredLength > NETWORK_RESPONSE_SKIP_BYTES) {
      // Never even read a huge body off the wire just to truncate it later.
      entry.truncated = true;
    } else {
      const raw = await response.text().catch(() => undefined);
      if (raw === undefined) {
        entry.truncated = true;
      } else {
        entry.truncated = raw.length > NETWORK_BODY_MAX_CHARS;
        entry.bodyText = raw.slice(0, NETWORK_BODY_MAX_CHARS);
      }
    }
    ring.entries.push(entry);
    ring.totalChars += entry.bodyText?.length ?? 0;
    // Bounds: max entries AND aggregate size. Oldest bodies are dropped first
    // (entry stays, body gone); the wrap counter tells callers the ring moved.
    while (ring.entries.length > NETWORK_LOG_MAX_ENTRIES) {
      const evicted = ring.entries.shift()!;
      ring.totalChars -= evicted.bodyText?.length ?? 0;
      ring.dropped += 1;
    }
    while (ring.totalChars > NETWORK_LOG_MAX_TOTAL_CHARS && ring.entries.length > 0) {
      const oldest = ring.entries[0]!;
      if (oldest.bodyText !== undefined) {
        ring.totalChars -= oldest.bodyText.length;
        delete oldest.bodyText;
        oldest.truncated = true;
      } else {
        ring.entries.shift();
        ring.dropped += 1;
      }
    }
  }
  // --- B3 bounded capture helpers -------------------------------------------------

  private parkDialog(managed: ManagedPage, dialog: Dialog): void {
    // Bounded capture: a second dialog while one is pending supersedes (and
    // dismisses) the older one — the page never gets two unanswered modals.
    if (managed.dialogs.pending) { const stale = managed.dialogs.pending; this.settleDialog(managed, stale, "superseded", () => { void stale.dialog.dismiss().catch(() => undefined); }); }
    const kind = dialog.type();
    const pending: PendingDialog = {
      dialog,
      kind: kind === "alert" || kind === "confirm" || kind === "prompt" || kind === "beforeunload" ? kind : "alert",
      message: redactEgress(dialog.message()).slice(0, DIALOG_MESSAGE_MAX_CHARS),
      arrivedAt: Date.now(),
      settled: false,
      autoTimer: setTimeout(() => { this.settleDialog(managed, pending, "auto-dismissed", () => { void pending.dialog.dismiss().catch(() => undefined); }); }, DIALOG_AUTO_DISMISS_MS),
    };
    pending.autoTimer.unref?.();
    managed.dialogs.pending = pending;
    const waiters = managed.dialogs.waiters.splice(0);
    for (const wake of waiters) wake();
  }

  private settleDialog(managed: ManagedPage, pending: PendingDialog, resolution: string, act: () => void): void {
    if (pending.settled) return;
    pending.settled = true;
    clearTimeout(pending.autoTimer);
    if (managed.dialogs.pending === pending) managed.dialogs.pending = null;
    managed.dialogs.ring.push({ kind: pending.kind, message: pending.message, resolution, at: new Date().toISOString() });
    if (managed.dialogs.ring.length > DIALOG_RING_MAX) managed.dialogs.ring.shift();
    try { act(); } catch { /* dialog already gone — bounded capture */ }
  }

  private awaitDialog(managed: ManagedPage, awaitMs: number): Promise<PendingDialog | null> {
    if (managed.dialogs.pending) return Promise.resolve(managed.dialogs.pending);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { cleanup(); resolve(null); }, awaitMs);
      const wake = (): void => { cleanup(); resolve(managed.dialogs.pending); };
      const cleanup = (): void => { clearTimeout(timer); const index = managed.dialogs.waiters.indexOf(wake); if (index >= 0) managed.dialogs.waiters.splice(index, 1); };
      managed.dialogs.waiters.push(wake);
      if (managed.page.isClosed()) { cleanup(); reject(new BrowserServiceError("not_found", "Browser page was closed.")); }
    });
  }

  private parkDownload(managed: ManagedPage, download: Download): void {
    // Bounded capture: cap the pending queue; the oldest unclaimed download is
    // discarded (and cancelled) when the ring would overflow.
    while (managed.downloads.length >= DOWNLOAD_MAX_PENDING) {
      this.cancelPendingDownload(managed, managed.downloads[0]!, "overflow");
    }
    const pending: PendingDownload = {
      download,
      url: redactUrlQuery(download.url()),
      fileName: sanitizeDownloadName(download.suggestedFilename()),
      arrivedAt: Date.now(),
      resolved: false,
      autoTimer: setTimeout(() => { this.cancelPendingDownload(managed, pending, "auto-cancelled"); }, DOWNLOAD_AUTO_CANCEL_MS),
    };
    pending.autoTimer.unref?.();
    managed.downloads.push(pending);
    const waiters = managed.downloadWaiters.splice(0);
    for (const wake of waiters) wake();
  }

  private cancelPendingDownload(managed: ManagedPage, pending: PendingDownload, _reason: string): void {
    if (pending.resolved) return;
    pending.resolved = true;
    clearTimeout(pending.autoTimer);
    const index = managed.downloads.indexOf(pending);
    if (index >= 0) managed.downloads.splice(index, 1);
    void pending.download.cancel().catch(() => undefined);
  }

  private awaitDownload(managed: ManagedPage, timeoutMs: number): Promise<PendingDownload | null> {
    const existing = managed.downloads.find((candidate) => !candidate.resolved);
    if (existing) return Promise.resolve(existing);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { cleanup(); resolve(null); }, timeoutMs);
      const wake = (): void => { cleanup(); resolve(managed.downloads.find((candidate) => !candidate.resolved) ?? null); };
      const cleanup = (): void => { clearTimeout(timer); const index = managed.downloadWaiters.indexOf(wake); if (index >= 0) managed.downloadWaiters.splice(index, 1); };
      managed.downloadWaiters.push(wake);
      if (managed.page.isClosed()) { cleanup(); reject(new BrowserServiceError("not_found", "Browser page was closed.")); }
    });
  }

  private recordConsoleMessage(managed: ManagedPage, message: ConsoleMessage): void {
    const text = redactEgress(message.text());
    const entry: BrowserConsoleLogEntry = {
      id: managed.consoleRing.nextId,
      source: "console",
      level: message.type(),
      truncated: text.length > CONSOLE_ENTRY_MAX_CHARS,
      capturedAt: new Date().toISOString(),
    };
    managed.consoleRing.nextId += 1;
    entry.text = text.slice(0, CONSOLE_ENTRY_MAX_CHARS);
    const location = message.location();
    if (location && typeof location.url === "string" && location.url !== "") entry.location = redactUrlQuery(location.url);
    this.pushConsoleEntry(managed.consoleRing, entry);
  }

  private recordPageError(managed: ManagedPage, error: Error): void {
    const text = redactEgress(error instanceof Error ? `${error.name}: ${error.message}` : String(error));
    const entry: BrowserConsoleLogEntry = {
      id: managed.consoleRing.nextId,
      source: "pageerror",
      level: "error",
      truncated: text.length > CONSOLE_ENTRY_MAX_CHARS,
      capturedAt: new Date().toISOString(),
    };
    managed.consoleRing.nextId += 1;
    entry.text = text.slice(0, CONSOLE_ENTRY_MAX_CHARS);
    this.pushConsoleEntry(managed.consoleRing, entry);
  }

  private pushConsoleEntry(ring: ConsoleRing, entry: BrowserConsoleLogEntry): void {
    ring.entries.push(entry);
    ring.totalChars += entry.text?.length ?? 0;
    while (ring.entries.length > CONSOLE_LOG_MAX_ENTRIES) {
      const evicted = ring.entries.shift()!;
      ring.totalChars -= evicted.text?.length ?? 0;
      ring.dropped += 1;
    }
    // Aggregate cap: oldest bodies go first, entry metadata survives.
    while (ring.totalChars > CONSOLE_LOG_MAX_TOTAL_CHARS && ring.entries.length > 0) {
      const oldest = ring.entries[0]!;
      if (oldest.text !== undefined) {
        ring.totalChars -= oldest.text.length;
        delete oldest.text;
        oldest.truncated = true;
      } else {
        ring.entries.shift();
        ring.dropped += 1;
      }
    }
  }

  /** One-time secret handle consumption (batchFill). Harnesses without a consuming vault fall back to resolve. */
  private async takeSecret(secretRef: string): Promise<string> {
    const taker = this.options.consumeSecret ?? this.options.resolveSecret;
    if (!taker) throw new BrowserServiceError("secret_unavailable", "Secret is unavailable.");
    try { return await taker(secretRef); }
    catch { throw new BrowserServiceError("secret_unavailable", "Secret is unavailable."); }
  }
  private requirePage(session: ManagedSession, id: string): ManagedPage { const page = session.pages.get(id); if (!page) throw new BrowserServiceError("not_found", "Browser page not found."); return page; }
  // Touching activity here (not just on create) is what keeps the idle sweeper from closing a
  // session that is busy: every page action resolves through this lookup.
  private requirePageById(id: string): ManagedPage { for (const session of this.sessions.values()) { const page = session.pages.get(id); if (page) { session.lastActivityAt = Date.now(); return page; } } throw new BrowserServiceError("not_found", "Browser page not found."); }
  private async refreshPageInfo(managed: ManagedPage): Promise<void> { managed.info.url = managed.page.url(); managed.info.title = await managed.page.title().catch(() => ""); if (managed.info.status !== "closed") managed.info.status = "ready"; }
  private syncSessionPages(session: ManagedSession): void { session.info.pages = [...session.pages.values()].map((page) => ({ ...page.info })); }
}

/** Download filenames come from the server — tame them to basename-shaped segments (no directories, control chars, or dot-prefixed names). */
function sanitizeDownloadName(value: string): string {
  const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;
  // eslint-disable-next-line no-control-regex -- filename sanitizing intentionally strips C0 controls
  const cleaned0 = basename(value.replace(/[\\/]+/g, "-")).replace(/[\u0000-\u001f<>:"|?*]+/g, "-");
  // Traversal hardening: dot runs (.., ...) never survive, and leading dots
  // (hidden files), trailing dots/spaces (Windows), and reserved DOS names are
  // neutralized — the on-disk name always sits strictly inside the root.
  const cleaned = cleaned0.replace(/\.{2,}/g, "-").replace(/^[.\s_-]+/, "").replace(/[.\s]+$/, "");
  const safe = cleaned === "" || WINDOWS_RESERVED.test(cleaned) ? "download" : cleaned;
  return safe.slice(0, 120);
}

function cloneSession(info: BrowserSessionInfo): BrowserSessionInfo { return { ...info, pages: info.pages.map((page) => ({ ...page })) }; }

/** Diff identity: the same frameId+locatorHint+nthOrdinal keying the ref resolver uses. */
function snapshotIdentityKey(entry: BrowserElementRef, nth: number): string {
  return `${entry.frameId}|${JSON.stringify(entry.locatorHint)}|${nth}`;
}

function trimSnapshot(snapshot: BrowserSnapshot, maxChars: number): BrowserSnapshot {
  const refs = { ...snapshot.refs }; while (JSON.stringify({ ...snapshot, refs }).length > maxChars && Object.keys(refs).length > 1) delete refs[Object.keys(refs).at(-1)!]; return { ...snapshot, refs };
}

function collectSnapshotNodes({ includeBoundingBoxes, interactive }: { includeBoundingBoxes: boolean; interactive: boolean }): { nodes: SnapshotNode[]; hasOpenShadowRoots: boolean } {
  const interactiveSelector = "a,button,input,textarea,select,option,[contenteditable=true],[role=button],[role=link],[role=textbox],[role=checkbox],[role=combobox],[role=tab],[role=menuitem]";
  const selector = interactive ? interactiveSelector : `${interactiveSelector},h1,h2,h3,h4,h5,h6,main,article,nav,header,footer,table,[role]`;
  const roleFor = (element: Element): string | undefined => { const explicit = element.getAttribute("role"); if (explicit) return explicit; const tag = element.tagName.toLowerCase(); return ({ a: "link", button: "button", input: ["checkbox", "radio"].includes((element as HTMLInputElement).type) ? (element as HTMLInputElement).type : "textbox", textarea: "textbox", select: "combobox", heading: "heading" } as Record<string, string>)[tag]; };
  const nameFor = (element: Element): string => { const html = element as HTMLElement; const label = (html as HTMLInputElement).labels?.[0]?.innerText; return (element.getAttribute("aria-label") || label || element.getAttribute("title") || element.getAttribute("placeholder") || html.innerText || element.textContent || "").trim().replace(/\s+/g, " ").slice(0, 300); };
  const idSelector = (element: Element): string | null => { const id = element.getAttribute("id"); return id && /^[A-Za-z_][A-Za-z0-9_-]*$/.test(id) ? `#${id}` : null; };
  // Unique sibling segment: nth-of-type chains make same-tag siblings distinct,
  // so a hint never drifts onto a same-structured neighbour.
  const segmentFor = (element: Element): string => {
    const viaId = idSelector(element);
    if (viaId) return viaId;
    const parent = element.parentElement;
    if (!parent) return element.tagName.toLowerCase();
    const siblings = [...parent.children].filter((child) => child.tagName === element.tagName);
    return `${element.tagName.toLowerCase()}:nth-of-type(${siblings.indexOf(element) + 1})`;
  };
  // Path inside the current root scope only (stops at body or a shadow boundary).
  const scopedPathFor = (element: Element): string => {
    const viaId = idSelector(element);
    if (viaId) return viaId;
    const parts: string[] = [];
    let current: Element | null = element;
    while (current && current !== document.body && parts.length < 8) {
      parts.unshift(segmentFor(current));
      current = current.parentElement;
    }
    return parts.join(" > ");
  };
  // :light() opts each light-DOM segment out of Playwright's default shadow
  // piercing — used whenever any open shadow root exists on the frame, so a
  // light node can never resolve to a same-shaped element inside a shadow tree.
  const lightWrap = (path: string): string => path.split(" > ").map((segment) => `:light(${segment})`).join(" > ");
  const nodes: SnapshotNode[] = [];
  let hasOpenShadowRoots = false;
  const visit = (element: Element, chain: string | null): void => {
    if (element.matches(selector)) {
      const html = element as HTMLElement;
      const style = getComputedStyle(html);
      const rect = html.getBoundingClientRect();
      // closest() does not cross shadow boundaries; for shadow nodes walk up manually.
      let hiddenByAria = false;
      let probe: Element | null = element;
      while (probe) { if (probe.getAttribute("aria-hidden") === "true") { hiddenByAria = true; break; } probe = probe.parentElement ?? (probe.parentNode instanceof ShadowRoot ? probe.parentNode.host : null); }
      const visible = style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0 && !hiddenByAria;
      if (visible) {
        const role = roleFor(element);
        const name = nameFor(element);
        const tag = element.tagName.toLowerCase();
        const input = element as HTMLInputElement;
        const selected = tag === "option" ? (element as HTMLOptionElement).selected : undefined;
        nodes.push({
          selector: chain === null ? scopedPathFor(element) : `${chain} >> ${scopedPathFor(element)}`,
          tag,
          ...(role ? { role } : {}),
          ...(name ? { name } : {}),
          text: (html.innerText || "").trim().replace(/\s+/g, " ").slice(0, 300),
          ...(chain !== null ? { inShadow: true } : {}),
          disabled: "disabled" in input ? input.disabled : false,
          checked: "checked" in input ? input.checked : false,
          ...(selected !== undefined ? { selected } : {}),
          expanded: element.getAttribute("aria-expanded") === "true",
          editable: tag === "input" || tag === "textarea" || html.isContentEditable,
          visible: true,
          ...(includeBoundingBoxes ? { boundingBox: { x: rect.x, y: rect.y, width: rect.width, height: rect.height } } : {}),
        });
      }
    }
    if (element.shadowRoot) {
      hasOpenShadowRoots = true;
      const hostChain = chain === null ? scopedPathFor(element) : `${chain} >> ${scopedPathFor(element)}`;
      for (const child of element.shadowRoot.children) visit(child, hostChain);
    }
    for (const child of element.children) visit(child, chain);
  };
  if (document.documentElement) visit(document.documentElement, null);
  if (hasOpenShadowRoots) {
    for (const node of nodes) {
      const parts = node.selector.split(" >> ");
      node.selector = parts.map((part, index) => (index === parts.length - 1 && node.inShadow ? part : lightWrap(part))).join(" >> ");
    }
  }
  return { nodes, hasOpenShadowRoots };
}
/** Runs in the page. Structure-driven so hashed CSS class names cannot break it. */
function collectSearchHits(selectors: { item: string; title: string; snippetList?: string }): BrowserSearchHit[] {
  const externalSnippets = selectors.snippetList
    ? [...document.querySelectorAll(selectors.snippetList)].map((node) => (node.textContent ?? "").trim())
    : null;
  const seen = new Set<string>();
  const hits: BrowserSearchHit[] = [];
  const items = [...document.querySelectorAll<HTMLElement>(selectors.item)];
  items.forEach((item, index) => {
    const anchor = item.querySelector<HTMLAnchorElement>("a[href^='http']");
    if (!anchor) return;
    // DDG sometimes wraps results in /l/?uddg=<encoded>; hand back the destination, not the hop.
    let url = anchor.href;
    try {
      const redirect = new URL(url).searchParams.get("uddg");
      if (redirect) url = redirect;
    } catch { /* leave the href as-is */ }
    const title = (item.querySelector(selectors.title)?.textContent ?? anchor.textContent ?? "").trim();
    if (title === "" || seen.has(url)) return;
    seen.add(url);
    // No stable snippet class exists on either engine, so take the item's own lines and drop the
    // chrome: the title, short labels, and the "site.com › a › b" breadcrumb Brave renders above
    // every result (long enough to survive a length filter, but not content).
    const snippet = externalSnippets
      ? externalSnippets[index] ?? ""
      : (item.innerText ?? "").split("\n").map((line) => line.trim())
        .filter((line) => line.length > 40 && line !== title && !line.includes(" › "))
        .join(" ").slice(0, 400);
    hits.push({ title, url, snippet });
  });
  return hits;
}

function collectDocument(options: { mainContentOnly: boolean; includeLinks: boolean; includeImages: boolean; includeForms: boolean; maxChars: number; mode: "semantic" | "readability" | "interactive" }): BrowserDocument {
  const root = options.mainContentOnly ? (document.querySelector("main,article,[role=main]") ?? document.body) : document.body;
  const excluded = (element: Element): boolean => { const tag = element.tagName.toLowerCase(); const marker = `${element.id} ${element.className}`.toLowerCase(); return ["script", "style", "noscript", "template", "svg"].includes(tag) || element.getAttribute("aria-hidden") === "true" || /cookie|consent|advert|ads-|\bad-slot\b|\bfooter\b|\bnavbar\b/.test(marker); };
  const text = (element: Element): string => (element.textContent || "").replace(/\s+/g, " ").trim();
  const headings = [...root.querySelectorAll("h1,h2,h3,h4,h5,h6")].filter((e) => !excluded(e)).map((e) => ({ level: Number(e.tagName.slice(1)), text: text(e), ...(e.id ? { anchor: e.id } : {}) })).filter((e) => e.text);
  const paragraphs = [...root.querySelectorAll("p,pre,blockquote")].filter((e) => !excluded(e)).map((e) => ({ text: text(e), ...(e.tagName.toLowerCase() === "pre" ? { format: "code" as const } : e.tagName.toLowerCase() === "blockquote" ? { format: "quote" as const } : {}) })).filter((e) => e.text);
  const lists = [...root.querySelectorAll("ol,ul")].filter((e) => !excluded(e)).map((e) => ({ ordered: e.tagName.toLowerCase() === "ol", items: [...e.querySelectorAll(":scope > li")].map(text).filter(Boolean) })).filter((e) => e.items.length);
  const tables = [...root.querySelectorAll("table")].filter((e) => !excluded(e)).map((table) => { const rows = [...table.querySelectorAll("tr")].map((row) => [...row.querySelectorAll("th,td")].map(text)); return { headers: rows.shift() ?? [], rows }; }).filter((e) => e.headers.length || e.rows.length);
  const links = options.includeLinks ? [...root.querySelectorAll("a[href]")].filter((e) => !excluded(e)).map((e) => ({ text: text(e), url: (e as HTMLAnchorElement).href })).filter((e) => e.url) : [];
  const images = options.includeImages ? [...root.querySelectorAll("img[src]")].filter((e) => !excluded(e)).map((e) => ({ alt: e.getAttribute("alt") ?? "", src: (e as HTMLImageElement).src })).filter((e) => e.src) : [];
  const forms = options.includeForms ? [...root.querySelectorAll("form")].map((form) => ({ method: (form.getAttribute("method") ?? "get").toUpperCase(), action: form.action, fields: [...form.querySelectorAll("input,textarea,select")].map((field) => field.getAttribute("name") || field.getAttribute("aria-label") || field.tagName.toLowerCase()).filter(Boolean) })) : undefined;
  const plainText = (root as HTMLElement).innerText?.replace(/\n{3,}/g, "\n\n").trim() || text(root);
  return { version: 1, source: { url: location.href, finalUrl: location.href, title: document.title, fetchedAt: new Date().toISOString(), contentType: document.contentType }, metadata: { ...(document.querySelector("meta[name=description]")?.getAttribute("content") ? { description: document.querySelector("meta[name=description]")!.getAttribute("content")! } : {}), ...(document.documentElement.lang ? { lang: document.documentElement.lang } : {}), ...(document.querySelector("link[rel=canonical]")?.getAttribute("href") ? { canonicalUrl: (document.querySelector("link[rel=canonical]") as HTMLLinkElement).href } : {}) }, headings, paragraphs, lists, tables, links, images, ...(forms ? { forms } : {}), text: plainText };
}

type SharedBrowser = { browser: Browser; refcount: number };

export interface BrowserExtractResult {
  title: string;
  finalUrl: string;
  textLen: number;
  truncated: boolean;
  text?: string;
  document?: BrowserDocument;
  /** Cached full-text artifact for this page; read it back or search it instead of re-extracting. */
  artifactPath?: string;
}

function sleep(ms: number): Promise<void> { return new Promise((resolve) => setTimeout(resolve, ms)); }

// ponytail: T2 — prefer a real Chrome channel (UA is clean out of the box). If the channel isn't
// installed, channelLaunchOptions returns {} and we fall back to stealthContextOptions which rewrites
// HeadlessChrome→Chrome in the UA and aligns sec-ch-ua to match. Only changing UA but not sec-ch-ua
// is more suspicious than doing neither, so both move together. No CAPTCHA bypass — Google staying
// blocked is expected.
function channelLaunchOptions(): { channel?: string } {
  // ponytail: real Chrome detection is platform-specific and flaky in a sandbox; return {} to take
  // the UA-rewrite fallback. Upgrade path: probe Program Files\Google\Chrome\Application\chrome.exe.
  return {};
}

function stealthContextOptions(headless: boolean): { userAgent?: string; extraHTTPHeaders?: Record<string, string> } {
  if (!headless) return {};
  // Headless Chromium advertises "HeadlessChrome/VERSION" in both UA and sec-ch-ua. Rewrite both
  // to the headed Chrome strings so they are internally consistent.
  const userAgent = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36";
  const secChUa = '"Google Chrome";v="149", "Chromium";v="149", "Not)A;Brand";v="24"';
  return { userAgent, extraHTTPHeaders: { "sec-ch-ua": secChUa, "sec-ch-ua-mobile": "?0", "sec-ch-ua-platform": '"Windows"', "accept-language": "zh-TW,zh;q=0.9,en-US;q=0.8,en;q=0.7" } };
}
