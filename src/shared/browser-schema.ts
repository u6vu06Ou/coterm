import { z } from "zod";

const uuid = z.string().uuid();

export const browserLocatorSchema = z.discriminatedUnion("strategy", [
  z.object({ strategy: z.literal("ref"), snapshotId: uuid, ref: z.string().regex(/^e\d+$/) }),
  z.object({ strategy: z.literal("role"), role: z.string().min(1).max(80), name: z.string().max(500).optional(), exact: z.boolean().optional() }),
  z.object({ strategy: z.literal("text"), text: z.string().min(1).max(500), exact: z.boolean().optional() }),
  z.object({ strategy: z.literal("label"), label: z.string().min(1).max(500), exact: z.boolean().optional() }),
  z.object({ strategy: z.literal("placeholder"), placeholder: z.string().min(1).max(500), exact: z.boolean().optional() }),
  z.object({ strategy: z.literal("testId"), testId: z.string().min(1).max(200) }),
  z.object({ strategy: z.literal("css"), selector: z.string().min(1).max(1000) }),
  z.object({ strategy: z.literal("xpath"), selector: z.string().min(1).max(1000) }),
]);

export const browserSessionCreateInputSchema = z.object({
  mode: z.enum(["headed", "headless"]).default("headless"),
  profileId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/).nullable().optional(),
  persistent: z.boolean().default(false),
  url: z.string().url().max(4096).optional(),
});
export const browserSessionIdSchema = z.object({ sessionId: uuid });
export const browserPageIdSchema = z.object({ pageId: uuid });
export const browserPageNewInputSchema = browserSessionIdSchema.extend({ url: z.string().url().max(4096).optional() });
export const browserPageSelectionInputSchema = z.object({ sessionId: uuid, pageId: uuid });
export const browserNavigateInputSchema = browserPageIdSchema.extend({
  url: z.string().url().max(4096),
  waitUntil: z.enum(["load", "domcontentloaded", "networkidle", "commit"]).optional(),
});
export const browserSnapshotInputSchema = browserPageIdSchema.extend({
  mode: z.enum(["compact", "full", "interactive"]).default("compact"),
  includeBoundingBoxes: z.boolean().default(false),
  maxChars: z.number().int().min(100).max(100_000).default(20_000),
});
export const browserExtractInputSchema = browserPageIdSchema.extend({
  format: z.enum(["json", "markdown", "text"]).default("json"),
  scope: browserLocatorSchema.optional(),
  mainContentOnly: z.boolean().default(false),
  includeLinks: z.boolean().default(false),
  includeImages: z.boolean().default(true),
  includeForms: z.boolean().default(false),
  maxChars: z.number().int().min(100).max(200_000).default(4000),
  mode: z.enum(["semantic", "readability", "interactive"]).default("semantic"),
});
export const browserClickInputSchema = browserPageIdSchema.extend({
  target: browserLocatorSchema,
  button: z.enum(["left", "right", "middle"]).optional(),
  modifiers: z.array(z.enum(["Alt", "Control", "Meta", "Shift"])).max(4).optional(),
  timeoutMs: z.number().int().min(100).max(60_000).optional(),
  returnSnapshot: z.boolean().default(true),
});
export const browserTargetActionInputSchema = browserPageIdSchema.extend({
  target: browserLocatorSchema,
  timeoutMs: z.number().int().min(100).max(60_000).optional(),
  returnSnapshot: z.boolean().default(true),
});
export const browserFillInputSchema = browserTargetActionInputSchema.extend({
  value: z.string().max(1_000_000).optional(),
  secretRef: z.string().regex(/^secret:\/\/[A-Za-z0-9._-]+$/).optional(),
}).refine((value) => (value.value !== undefined) !== (value.secretRef !== undefined), "Provide value or secretRef, not both.");
export const browserTypeInputSchema = browserTargetActionInputSchema.extend({ text: z.string().max(1_000_000) });
export const browserPressInputSchema = browserPageIdSchema.extend({ target: browserLocatorSchema, key: z.string().min(1).max(100), returnSnapshot: z.boolean().default(true) });
export const browserCoordinateClickInputSchema = browserPageIdSchema.extend({
  x: z.number().finite(), y: z.number().finite(),
  coordinateSpace: z.enum(["viewport", "document", "screenshot"]),
  snapshotId: uuid,
  screenshotWidth: z.number().positive().optional(), screenshotHeight: z.number().positive().optional(),
  returnSnapshot: z.boolean().default(true),
});
export const browserSaveExtractionInputSchema = z.object({
  pageId: uuid, format: z.enum(["json", "markdown", "text"]), projectId: uuid.optional(), destinationPath: z.string().max(4096).optional(),
});
export const browserUploadInputSchema = browserPageIdSchema.extend({
  target: browserLocatorSchema,
  files: z.array(z.string().min(1).max(4096)).min(1).max(10),
});
export const browserSearchIndexInputSchema = z.object({ projectId: uuid.optional(), query: z.string().min(1).max(500), host: z.string().max(255).optional(), crawlId: uuid.optional(), limit: z.number().int().min(1).max(100).default(20) });

// --- Phase 7 superpowers (P0): bounded wait/scroll/diff/network primitives ---

export const BROWSER_WAIT_TIMEOUT_MAX_MS = 60_000;
export const browserWaitForInputSchema = browserPageIdSchema.extend({
  condition: z.enum(["appear", "disappear", "text", "url", "networkidle"]),
  target: browserLocatorSchema.optional(),
  text: z.string().min(1).max(500).optional(),
  exact: z.boolean().default(false),
  // Substring match against the current URL (not a regex — no ReDoS surface).
  url: z.string().min(1).max(4096).optional(),
  timeoutMs: z.number().int().min(100).max(BROWSER_WAIT_TIMEOUT_MAX_MS).default(15_000),
}).superRefine((value, context) => {
  if ((value.condition === "appear" || value.condition === "disappear") && value.target === undefined) {
    context.addIssue({ code: "custom", message: "condition appear/disappear requires target." });
  }
  if (value.condition === "text" && value.text === undefined) {
    context.addIssue({ code: "custom", message: "condition text requires text." });
  }
  if (value.condition === "url" && value.url === undefined) {
    context.addIssue({ code: "custom", message: "condition url requires url." });
  }
});
export const browserScrollInputSchema = browserPageIdSchema.extend({
  deltaX: z.number().int().min(-10_000).max(10_000).default(0),
  deltaY: z.number().int().min(-10_000).max(10_000).default(0),
}).refine((value) => value.deltaX !== 0 || value.deltaY !== 0, "Provide a non-zero deltaX or deltaY.");
export const browserSnapshotDiffInputSchema = browserPageIdSchema.extend({
  changedSinceSnapshotId: uuid,
  includeBoundingBoxes: z.boolean().default(false),
});
export const browserNetworkLogInputSchema = browserPageIdSchema.extend({
  limit: z.number().int().min(1).max(50).default(50),
  urlContains: z.string().min(1).max(200).optional(),
});

// --- Phase 7 superpowers B3 (work order §12.1#2) ---

export const BROWSER_BATCH_MAX_STEPS = 20;
/** One batch step. The action name is resolved against the registry per transport (httpName/mcpName). */
export const browserBatchStepSchema = z.object({
  action: z.string().min(1).max(64),
  input: z.record(z.string(), z.unknown()).default({}),
});
export const browserBatchInputSchema = z.object({
  steps: z.array(browserBatchStepSchema).min(1).max(BROWSER_BATCH_MAX_STEPS),
  stopOnError: z.boolean().default(true),
});
// --- Phase 7 superpowers B4 (work order §12.2, §12.3) ---

export const browserBatchFillFieldSchema = z.object({
  target: browserLocatorSchema,
  value: z.string().max(1_000_000).optional(),
  // Opaque one-time handle issued by the local human UI (renderer-only IPC);
  // the raw secret can never travel over HTTP/MCP.
  secretRef: z.string().regex(/^secret:\/\/[A-Za-z0-9._-]+$/).optional(),
  timeoutMs: z.number().int().min(100).max(60_000).optional(),
}).refine((value) => (value.value !== undefined) !== (value.secretRef !== undefined), "Provide value or secretRef, not both.");
export const browserBatchFillInputSchema = browserPageIdSchema.extend({
  fields: z.array(browserBatchFillFieldSchema).min(1).max(BROWSER_BATCH_MAX_STEPS),
  stopOnError: z.boolean().default(true),
  returnSnapshot: z.boolean().default(false),
});
export const browserDialogInputSchema = browserPageIdSchema.extend({
  // "prompt" = accept with promptText as the dialog's answer value.
  response: z.enum(["accept", "dismiss", "prompt"]),
  promptText: z.string().max(2_000).optional(),
  // Wait budget for the NEXT dialog when none is pending. 0 = answer the
  // pending dialog now or fail not_found. Never waits forever.
  awaitMs: z.number().int().min(0).max(30_000).default(0),
});
export const BROWSER_DOWNLOAD_MAX_BYTES = 64 * 1024 * 1024;
export const browserDownloadInputSchema = browserPageIdSchema.extend({
  // Wait budget for a download to start when none is parked. Bounded; a miss
  // is code "timeout", never a permanently-hung page.
  timeoutMs: z.number().int().min(100).max(60_000).default(10_000),
});
export const BROWSER_FETCH_MARKDOWN_MAX_BYTES = 1_048_576;
export const browserFetchMarkdownInputSchema = z.object({
  // http(s) only at the schema layer too; the DNS/SSRF policy still runs in the runtime.
  url: z.url({ protocol: /^https?$/ }).max(4096),
  maxChars: z.number().int().min(100).max(100_000).default(4_000),
  timeoutMs: z.number().int().min(100).max(30_000).default(15_000),
});
export const browserElementScreenshotInputSchema = browserPageIdSchema.extend({
  // "by current ref" (§12.2): semantic re-locating is deliberately rejected so
  // the capture always hits the element the agent saw in the live snapshot.
  target: browserLocatorSchema.refine((locator) => locator.strategy === "ref", "Element screenshots require a current snapshot ref."),
  format: z.enum(["png", "jpeg"]).default("png"),
  quality: z.number().int().min(1).max(100).optional(),
  timeoutMs: z.number().int().min(100).max(30_000).optional(),
}).superRefine((value, context) => {
  if (value.quality !== undefined && value.format !== "jpeg") {
    context.addIssue({ code: "custom", message: "quality applies to jpeg screenshots only." });
  }
});
export const BROWSER_CONSOLE_MAX_ENTRIES = 100;
export const browserConsoleInputSchema = browserPageIdSchema.extend({
  limit: z.number().int().min(1).max(BROWSER_CONSOLE_MAX_ENTRIES).default(50),
  source: z.enum(["console", "pageerror"]).optional(),
  level: z.enum(["error", "warning", "info", "debug", "log"]).optional(),
});
export const browserAssertInputSchema = browserPageIdSchema.extend({
  kind: z.enum(["text", "url", "visible", "value"]),
  target: browserLocatorSchema.optional(),
  text: z.string().min(1).max(500).optional(),
  // Substring match against the current URL (not a regex — no ReDoS surface).
  url: z.string().min(1).max(4096).optional(),
  expected: z.string().max(2_000).optional(),
  exact: z.boolean().default(false),
}).superRefine((value, context) => {
  if ((value.kind === "visible" || value.kind === "value") && value.target === undefined) {
    context.addIssue({ code: "custom", message: `kind ${value.kind} requires target.` });
  }
  if (value.kind === "text" && value.text === undefined) {
    context.addIssue({ code: "custom", message: "kind text requires text." });
  }
  if (value.kind === "url" && value.url === undefined) {
    context.addIssue({ code: "custom", message: "kind url requires url." });
  }
  if (value.kind === "value" && value.expected === undefined) {
    context.addIssue({ code: "custom", message: "kind value requires expected." });
  }
});
export type BrowserSessionCreateInput = z.infer<typeof browserSessionCreateInputSchema>;
export type BrowserLocatorInput = z.infer<typeof browserLocatorSchema>;
