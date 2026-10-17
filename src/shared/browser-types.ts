export type BrowserMode = "headed" | "headless";
export type BrowserSessionId = string;
export type BrowserPageId = string;

export type BrowserLocator =
  | { strategy: "ref"; snapshotId: string; ref: string }
  | { strategy: "role"; role: string; name?: string | undefined; exact?: boolean | undefined }
  | { strategy: "text"; text: string; exact?: boolean | undefined }
  | { strategy: "label"; label: string; exact?: boolean | undefined }
  | { strategy: "placeholder"; placeholder: string; exact?: boolean | undefined }
  | { strategy: "testId"; testId: string }
  | { strategy: "css"; selector: string }
  | { strategy: "xpath"; selector: string };

export interface BrowserPageInfo {
  id: BrowserPageId;
  sessionId: BrowserSessionId;
  url: string;
  title: string;
  status: "loading" | "ready" | "error" | "closed";
  active: boolean;
}

export interface BrowserSessionInfo {
  id: BrowserSessionId;
  mode: BrowserMode;
  profileId: string | null;
  persistent: boolean;
  createdAt: string;
  status: "starting" | "ready" | "closing" | "closed" | "crashed";
  pages: BrowserPageInfo[];
  /**
   * Issue #93: true once the human answered "allow for this session" on any
   * risky action in this session — from here on browser actions (level 3
   * included) run without a dialog until the session closes or idles out.
   * Surfaced so the Agent API panel and the agent API can show at a glance that a
   * session is in no-questions mode. Absent/undefined means "asks as usual".
   */
  approvalGranted?: boolean;
}

export interface BrowserElementRef {
  ref: string;
  frameId: string;
  role?: string;
  name?: string;
  text?: string;
  tag?: string;
  locatorHint: Exclude<BrowserLocator, { strategy: "ref" }>;
  states?: {
    disabled?: boolean;
    checked?: boolean;
    selected?: boolean;
    expanded?: boolean;
    editable?: boolean;
    visible?: boolean;
  };
  boundingBox?: { x: number; y: number; width: number; height: number };
}

export interface BrowserFrameSnapshot {
  frameId: string;
  url: string;
  refs: string[];
}

export interface BrowserSnapshot {
  snapshotId: string;
  pageId: BrowserPageId;
  url: string;
  title: string;
  capturedAt: string;
  viewport: { width: number; height: number; deviceScaleFactor: number };
  scroll: { x: number; y: number };
  frames: BrowserFrameSnapshot[];
  refs: Record<string, BrowserElementRef>;
  format: "compact" | "full" | "interactive";
  /** P2 wall marker (§12.3): detection only — never bypassed, never auto-solved. */
  blocked?: boolean;
  blockedReason?: "captcha_wall";
}

/** Element identity for diffs: frameId + locatorHint + per-hint ordinal (same keying the resolver uses). */
export interface BrowserSnapshotDiffChange {
  ref: string;
  baselineRef: string;
  frameId: string;
  changes: string[];
}

export interface BrowserSnapshotDiffRemoved {
  ref: string;
  frameId: string;
  hint: string;
}

/**
 * Result of page.snapshotDiff: capture a fresh snapshot and compare it against
 * a still-live baseline. The fresh snapshot replaces every older snapshot of
 * the page (staleAfter: new_snapshot), so its refs are the only usable ones.
 */
export interface BrowserSnapshotDiff {
  kind: "diff";
  snapshotId: string;
  baselineSnapshotId: string;
  pageId: BrowserPageId;
  url: string;
  capturedAt: string;
  added: string[];
  changed: BrowserSnapshotDiffChange[];
  removed: BrowserSnapshotDiffRemoved[];
  counts: { baseline: number; current: number; addedTruncated: boolean; changedTruncated: boolean; removedTruncated: boolean };
}

/** One captured network response body (text/JSON only; never request headers/cookies). */
export interface BrowserNetworkLogEntry {
  id: number;
  url: string;
  method: string;
  status: number;
  contentType: string;
  bodyText?: string;
  truncated: boolean;
  capturedAt: string;
}

export interface BrowserNetworkLogResult {
  pageId: BrowserPageId;
  entries: BrowserNetworkLogEntry[];
  dropped: number;
  limits: { maxEntries: number; maxTotalChars: number; perBodyChars: number };
}

/** One bounded per-step outcome of page.batch (work order §12.1#2). */
export interface BrowserBatchStepResult {
  index: number;
  actionId: string;
  ok: boolean;
  code?: BrowserActionErrorCode;
  error?: string;
  /** Present on success; capped serialized size, replaced by a truncation marker when over. */
  result?: unknown;
  resultTruncated?: boolean;
}

export interface BrowserBatchResult {
  kind: "batch";
  /** False when any step failed or the run was halted early. */
  ok: boolean;
  steps: BrowserBatchStepResult[];
  /** True when stopOnError (or the time budget) halted the run before the last step. */
  stoppedEarly: boolean;
  stopOnError: boolean;
  /** Top-level risk = max of the resolved step risks; batch never lowers it. */
  risk: 0 | 1 | 2 | 3;
}


/** Bounded outcome of batchFill: field metadata only, never filled values. */
export interface BrowserBatchFillResult {
  kind: "batchFill";
  pageId: BrowserPageId;
  ok: boolean;
  fields: { index: number; ok: boolean; code?: BrowserActionErrorCode; error?: string }[];
  stoppedEarly: boolean;
  snapshot?: BrowserSnapshot;
}

/** Answer to a parked or awaited page dialog (work order §12.2). */
export interface BrowserDialogResult {
  pageId: BrowserPageId;
  kind: "alert" | "confirm" | "prompt" | "beforeunload";
  /** Redacted, bounded message text. */
  message: string;
  responded: "accept" | "dismiss";
  waitedMs: number;
}

/** Download saved into the browser cache root. Metadata only, never file bytes. */
export interface BrowserDownloadResult {
  pageId: BrowserPageId;
  fileName: string;
  path: string;
  bytes: number;
  sha256: string;
  /** Source URL with the query string redacted. */
  url: string;
}

export interface BrowserFetchMarkdownResult {
  kind: "markdown";
  url: string;
  finalUrl: string;
  status: number;
  title: string;
  markdown: string;
  truncated: boolean;
  bytes: number;
  redirects: number;
}

/** One captured console message or uncaught page error (read-only ring). */
export interface BrowserConsoleLogEntry {
  id: number;
  source: "console" | "pageerror";
  level: string;
  /** Egress-redacted text; absent when the aggregate budget evicted the body. */
  text?: string;
  /** Query-redacted source location URL when known. */
  location?: string;
  truncated: boolean;
  capturedAt: string;
}

export interface BrowserConsoleLogResult {
  pageId: BrowserPageId;
  entries: BrowserConsoleLogEntry[];
  dropped: number;
  limits: { maxEntries: number; maxTotalChars: number; perEntryChars: number };
}

export interface BrowserAssertResult {
  pageId: BrowserPageId;
  kind: "text" | "url" | "visible" | "value";
  passed: boolean;
  expected?: string;
  /** Bounded, redacted observation that decided the assertion. */
  actual?: string;
  /** Current page URL (query-redacted) for agent context. */
  url: string;
}
export interface BrowserTextBlock { text: string; format?: "paragraph" | "code" | "quote"; }
export interface BrowserList { ordered: boolean; items: string[]; }
export interface BrowserTable { headers: string[]; rows: string[][]; }
export interface BrowserLink { text: string; url: string; }
export interface BrowserImage { alt: string; src: string; }
export interface BrowserFormSummary { method: string; action: string; fields: string[]; }

export interface BrowserDocument {
  version: 1;
  source: {
    url: string;
    finalUrl: string;
    title: string;
    fetchedAt: string;
    contentType: string | null;
  };
  metadata: {
    description?: string;
    lang?: string;
    canonicalUrl?: string;
    author?: string;
    publishedAt?: string;
    modifiedAt?: string;
  };
  headings: { level: number; text: string; anchor?: string }[];
  paragraphs: BrowserTextBlock[];
  lists: BrowserList[];
  tables: BrowserTable[];
  links: BrowserLink[];
  images: BrowserImage[];
  forms?: BrowserFormSummary[];
  text: string;
}

// Single source of truth for action error codes: the discovery schema
// (GET /api/v1/agent/browser/schema) publishes this array verbatim, so a new
// code added here reaches agents without touching hand-written literals.
export const browserActionErrorCodes = [
  "invalid_input", "session_not_ready", "approval_denied", "approval_timeout",
  "secret_unavailable", "timeout", "internal_error",
  "not_found", "ambiguous", "detached", "not_visible", "not_enabled",
  "covered", "navigation_timeout", "download_blocked", "permission_denied",
  "policy_denied", "stale_snapshot", "browser_crashed", "busy", "captcha_wall",
  // Batch per-step budget exhaustion (§12.1#2): a typed step code inside a
  // 200 batch result; top-level transport 429s use the same code string.
  "rate_limited",
] as const;

export type BrowserActionErrorCode = (typeof browserActionErrorCodes)[number];

export interface BrowserSearchHit {
  title: string;
  url: string;
  snippet: string;
}

export interface BrowserActionResult {
  ok: boolean;
  actionId: string;
  pageId: BrowserPageId;
  urlBefore: string;
  urlAfter: string;
  navigationOccurred: boolean;
  snapshot?: BrowserSnapshot;
  screenshotResource?: string;
  warnings: string[];
}

export interface BrowserExtractionOptions {
  pageId: BrowserPageId;
  format: "json" | "markdown" | "text";
  scope?: BrowserLocator | undefined;
  mainContentOnly?: boolean;
  includeLinks?: boolean;
  includeImages?: boolean;
  includeForms?: boolean;
  maxChars?: number;
  mode?: "semantic" | "readability" | "interactive";
}

export interface BrowserSearchResult {
  title: string;
  url: string;
  snippet: string;
  sourceFile: string;
  chunkId: string;
  score: number;
}
