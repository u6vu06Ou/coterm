import { z } from "zod";

/**
 * Built-in agent mutation ceilings, per client per minute (issue #93). Single
 * source of truth: the settings schema defaults here, agent-api falls back
 * here, and the browser discovery schema reports these when it has no live
 * limits. Keep both numbers meaningful — these are the backpressure that stops
 * a runaway agent retry loop from flooding the browser session.
 */
export const AGENT_RATE_LIMIT_DEFAULTS = { terminalPerMinute: 30, browserPerMinute: 30 } as const;

export const idSchema = z.string().uuid();

// Hot model registry (stage 1): the id is an open string pattern instead of a
// closed enum so custom profiles stored in settings can cross the IPC/DB
// boundary. Known ids keep passing; unknown ids are no longer a parse error
// (callers that need a closed set — e.g. agentapi supervisor — pin their own
// enum). Pattern matches the profiles-config / customProfiles record keys.
export const providerProfileIdSchema = z.string().regex(
  /^[a-z][a-z0-9.-]{1,40}$/,
  "Provider profile id must be 2-41 chars of [a-z][a-z0-9.-].",
);

export const claudeModelSchema = z.enum(["default", "opus", "sonnet", "haiku"]);

export type ProviderProfileId = z.infer<typeof providerProfileIdSchema>;

// Hot model registry (stage 1): user-defined claude-harness profiles stored
// in settings and merged over the built-in DEFAULT_PROFILES table at consume
// time (see main/providers/profiles-config.ts buildActiveProfiles). Shape
// mirrors ClaudeProfile (contextWindow/reasoningEffort are codex-side knobs,
// see the entry schema below).
// `local: true` routes through the loopback proxy like the free built-ins.
// Keys may not shadow special-cased shim ids — those dispatch through
// hand-written branches that ignore the table. Stage 2 (codex half) lifted
// the old codex- prefix ban: the four codex if-chains are tableized
// (shared/codex-profiles.ts) so codex-harness custom profiles are now legal.
const RESERVED_CUSTOM_PROFILE_IDS = new Set(["claude-official", "codex-official", "gemini", "council"]);

const customProfileEntrySchema = z.object({
  configProfile: z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/).optional(),
  label: z.string().trim().min(1).max(80).optional(),
  model: z.string().trim().min(1).max(200).optional(),
  local: z.boolean(),
  // Stage 2: per-provider endpoint/token for public users (OpenRouter/Groq/…).
  // Absent keeps the loopback-proxy behavior; precedence lives in
  // buildProfileEnv (explicit env > these fields > global fallback).
  baseUrl: z.string().url().max(500).optional(),
  authToken: z.string().trim().min(1).max(500).optional(),
  // Stage 2 (codex half): codex-harness knobs, mapped to
  // -c model_context_window / -c model_reasoning_effort (SPEC Q6). Also
  // accepted on claude entries for forward-compat.
  contextWindow: z.number().int().positive().max(10_000_000).optional(),
  // Codex-harness-only overrides (2026-09-09): let a customProfile entry tune
  // max output tokens and the auto-compact limit/scope WITHOUT a new Coterm
  // release — the overlay in resolveCodexProfileSpec now forwards these.
  maxOutputTokens: z.number().int().positive().max(1_000_000).optional(),
  autoCompactTokenLimit: z.number().int().positive().max(10_000_000).optional(),
  autoCompactScope: z.string().trim().min(1).max(40).optional(),
  reasoningEffort: z.enum(["low", "high", "max"]).optional(),
  env: z.record(z.string().trim().min(1).max(64), z.string().max(2000)),
});

export const customProfilesSchema = z.record(
  z.string().regex(
    /^[a-z][a-z0-9.-]{1,40}$/,
    "Custom profile id must be 2-41 chars of [a-z][a-z0-9.-].",
  ),
  customProfileEntrySchema,
).refine(
  (entries) => {
    for (const id of Object.keys(entries)) {
      if (RESERVED_CUSTOM_PROFILE_IDS.has(id)) return false;
    }
    return true;
  },
  "Custom profile ids cannot shadow claude-official / codex-official / gemini / council.",
);

export type CustomProfileEntry = z.infer<typeof customProfileEntrySchema>;

// What a probe actually observed. `online` alone could not tell "quota spent
// until the daily reset" from "that model is gone", so both wrong readings kept
// appearing in the list; `source` says what the judgement came from so a wrong
// reading is traceable to a probe instead of to a guess.
export const providerProbeStateSchema = z.enum(["online", "rate_limited", "offline", "retired", "unknown"]);
export const providerProbeSourceSchema = z.enum([
  "cli",
  "proxy",
  "direct",
  "inherited",
  "registry",
]);
export type ProviderProbeState = z.infer<typeof providerProbeStateSchema>;
export type ProviderProbeSource = z.infer<typeof providerProbeSourceSchema>;

export const providerStatusSchema = z.object({
  id: providerProfileIdSchema,
  label: z.string(),
  installed: z.boolean(),
  authenticated: z.boolean().nullable(),
  online: z.boolean().nullable(),
  version: z.string().nullable(),
  detail: z.string(),
  // Optional so older cached snapshots and third-party diagnostics payloads
  // still parse; the detector always fills both on a fresh probe.
  state: providerProbeStateSchema.optional(),
  source: providerProbeSourceSchema.optional(),
  /** Backend family key this route resolves to (shared/model-families.ts). */
  backend: z.string().optional(),
  /** Backend display name for the family. */
  backendLabel: z.string().optional(),
  /** Epoch ms of the probe behind `state`; absent = never probed. */
  checkedAt: z.number().int().nonnegative().optional(),
  capabilities: z.object({
    sessions: z.boolean(),
    structuredEvents: z.boolean(),
    tools: z.boolean(),
    mcp: z.boolean(),
    skills: z.boolean(),
    images: z.boolean(),
    approvals: z.boolean(),
    tokenUsage: z.boolean(),
  }),
});

export type ProviderStatus = z.infer<typeof providerStatusSchema>;

// Renderer → main: 「重探」bumps past every TTL; `focus` is what the user is
// looking at, so those routes get this call's ping budget. Both optional: the
// silent poll and every diagnostic caller send nothing and read the cache.
export const providerRefreshInputSchema = z.object({
  force: z.boolean().optional(),
  focus: z.array(providerProfileIdSchema).max(24).optional(),
});

export type ProviderRefreshInput = z.infer<typeof providerRefreshInputSchema>;

export const eventTypeSchema = z.enum([
  "user.message",
  "assistant.progress",
  "assistant.final",
  "reasoning.summary",
  "plan.updated",
  "tool.started",
  "tool.progress",
  "tool.completed",
  "command.started",
  "command.output",
  "command.completed",
  "file.changed",
  "approval.requested",
  "approval.resolved",
  "user_input.requested",
  "user_input.resolved",
  "artifact.created",
  "agent.started",
  "agent.updated",
  "agent.completed",
  "council.started",
  "council.member.started",
  "council.member.completed",
  "council.review.completed",
  "council.synthesis.started",
  "council.synthesis.completed",
  "council.degraded",
  "council.cancelled",
  "warning",
  "error",
]);

export type EventType = z.infer<typeof eventTypeSchema>;

export const eventPayloadSchema = z.record(z.string(), z.unknown());

export const normalizedEventSchema = z.object({
  id: idSchema,
  conversationId: idSchema,
  turnId: idSchema,
  providerSessionId: idSchema.nullable(),
  turnGroupId: idSchema.nullable(),
  type: eventTypeSchema,
  createdAt: z.string().datetime(),
  sequence: z.number().int().nonnegative(),
  summary: z.string(),
  payload: eventPayloadSchema,
});

export type NormalizedEvent = z.infer<typeof normalizedEventSchema>;

export const projectSchema = z.object({
  id: idSchema,
  name: z.string().min(1).max(120),
  workspacePath: z.string().min(1),
  pinned: z.boolean(),
  order: z.number().int(),
  archived: z.boolean(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

export type Project = z.infer<typeof projectSchema>;

export const conversationSummarySchema = z.object({
  brief: z.string().min(1),
  longTermGoal: z.string().min(1),
  recentSummary: z.string().min(1),
  updatedAt: z.string().datetime(),
  partial: z.boolean().default(false),
});

export type ConversationSummary = z.infer<typeof conversationSummarySchema>;

export const conversationSchema = z.object({
  id: idSchema,
  projectId: idSchema,
  name: z.string().min(1).max(160),
  activeProvider: providerProfileIdSchema,
  primaryProvider: providerProfileIdSchema.optional(),
  claudeModel: claudeModelSchema.default("default"),
  continuedFromConversationId: idSchema.nullable().default(null),
  handoffSourceConversationId: idSchema.nullable().default(null),
  archived: z.boolean(),
  summary: conversationSummarySchema.nullable().default(null),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
}).transform((conversation) => ({
  ...conversation,
  primaryProvider: conversation.primaryProvider ?? conversation.activeProvider,
}));

export type Conversation = z.infer<typeof conversationSchema>;

export const providerSessionSchema = z.object({
  id: idSchema,
  conversationId: idSchema,
  profileId: providerProfileIdSchema,
  nativeSessionId: z.string().nullable(),
  status: z.enum(["idle", "running", "waiting", "failed"]),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

export type ProviderSession = z.infer<typeof providerSessionSchema>;

export const projectHistorySessionSchema = z.object({
  source: z.enum(["coterm", "claude-history"]).default("coterm"),
  providerSessionId: idSchema.nullable(),
  conversationId: idSchema.nullable(),
  projectId: idSchema,
  conversationName: z.string(),
  profileId: providerProfileIdSchema,
  nativeSessionId: z.string().nullable(),
  historyKey: z.string().nullable().default(null),
  sizeBytes: z.number().int().nonnegative().nullable().default(null),
  status: providerSessionSchema.shape.status,
  summary: conversationSummarySchema.nullable(),
  tokenTotals: z.object({
    tokensIn: z.number(),
    tokensOut: z.number(),
    cacheRead: z.number(),
    cacheCreation: z.number(),
  }).nullable().default(null),
  conversationUpdatedAt: z.string().datetime(),
  sessionUpdatedAt: z.string().datetime(),
});

export type ProjectHistorySession = z.infer<typeof projectHistorySessionSchema>;

export const attachmentSchema = z.object({
  id: idSchema,
  conversationId: idSchema,
  name: z.string(),
  mimeType: z.string(),
  localPath: z.string(),
  size: z.number().int().nonnegative(),
  createdAt: z.string().datetime(),
});

export type Attachment = z.infer<typeof attachmentSchema>;

export const attachmentMimeTypeSchema = z.enum([
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
  "application/pdf",
  "text/csv",
  "text/plain",
  "text/markdown",
  "text/html",
  "application/json",
  "text/javascript",
  "text/typescript",
  "text/css",
  "text/x-python",
  "text/x-powershell",
  "text/x-shellscript",
]);

export const attachmentSaveInputSchema = z.object({
  conversationId: idSchema,
  name: z.string().min(1).max(240),
  mimeType: attachmentMimeTypeSchema,
  dataBase64: z.string().min(1).max(28_000_000),
});

// Terminal-first upload: saves an image to <userData>/uploads/<uuid><ext>
// without requiring a conversation. Returns { localPath } so the renderer can
// inject the path into the active PTY for the inner LLM to read.
export const uploadSaveInputSchema = z.object({
  name: z.string().min(1).max(240),
  mimeType: z.enum(["image/png", "image/jpeg", "image/webp", "image/gif"]),
  dataBase64: z.string().min(1).max(28_000_000),
});

export type UploadSaveInput = z.infer<typeof uploadSaveInputSchema>;

export const artifactReadInputSchema = z.object({
  projectId: idSchema,
  path: z.string().min(1),
});

export const artifactWriteInputSchema = artifactReadInputSchema.extend({
  text: z.string().max(2_000_000),
});

const artifactBaseSchema = {
  mimeType: z.string(),
  path: z.string(),
  size: z.number().int().nonnegative(),
};

export const spreadsheetCellSchema = z.object({
  row: z.number().int().nonnegative(),
  column: z.number().int().nonnegative(),
  value: z.union([z.string(), z.number(), z.boolean(), z.null()]),
  formula: z.string().optional(),
});

export const spreadsheetSheetSchema = z.object({
  name: z.string(),
  index: z.number().int().nonnegative(),
  rowCount: z.number().int().nonnegative(),
  columnCount: z.number().int().nonnegative(),
  truncated: z.boolean(),
  cells: z.array(spreadsheetCellSchema),
  mergedRanges: z.array(z.object({
    startRow: z.number().int().nonnegative(),
    startColumn: z.number().int().nonnegative(),
    endRow: z.number().int().nonnegative(),
    endColumn: z.number().int().nonnegative(),
  })),
});

export const spreadsheetModelSchema = z.object({
  format: z.enum(["xlsx", "csv", "tsv"]),
  limited: z.boolean(),
  sheets: z.array(spreadsheetSheetSchema),
});

export const presentationElementSchema = z.object({
  kind: z.enum(["text", "image", "shape", "unsupported"]),
  x: z.number().nonnegative(),
  y: z.number().nonnegative(),
  width: z.number().positive(),
  height: z.number().positive(),
  text: z.string().optional(),
  imageDataUrl: z.string().optional(),
  fillColor: z.string().optional(),
  label: z.string().optional(),
});

export const presentationSlideSchema = z.object({
  index: z.number().int().nonnegative(),
  elements: z.array(presentationElementSchema),
});

export const presentationModelSchema = z.object({
  width: z.number().positive(),
  height: z.number().positive(),
  limited: z.boolean(),
  slides: z.array(presentationSlideSchema),
});

export const artifactTokenInputSchema = z.object({ token: z.string().uuid() });
export const browserArtifactInputSchema = z.object({ url: z.string().min(1).max(4096) });

export const artifactPreviewSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.enum(["image", "video", "pdf"]), ...artifactBaseSchema, dataUrl: z.string() }),
  z.object({ kind: z.enum(["markdown", "html", "code", "text"]), ...artifactBaseSchema, text: z.string(), language: z.string().optional(), previewUrl: z.string().url().optional() }),
  z.object({ kind: z.literal("spreadsheet"), ...artifactBaseSchema, workbookToken: z.string().uuid(), metadata: spreadsheetModelSchema.pick({ format: true, limited: true }).extend({ sheets: z.array(spreadsheetSheetSchema.pick({ name: true, index: true, rowCount: true, columnCount: true, truncated: true })) }) }),
  z.object({ kind: z.literal("presentation"), ...artifactBaseSchema, presentationToken: z.string().uuid(), metadata: presentationModelSchema.pick({ width: true, height: true, limited: true }).extend({ slideCount: z.number().int().nonnegative() }) }),
  z.object({ kind: z.literal("browser"), mimeType: z.literal("text/uri-list"), path: z.string(), size: z.literal(0), url: z.string().url() }),
  z.object({ kind: z.literal("unsupported"), ...artifactBaseSchema, reason: z.string() }),
]);

export const workspaceListInputSchema = z.object({
  projectId: idSchema,
  path: z.string().min(1).nullable().default(null),
});

export const workspaceSearchInputSchema = z.object({
  projectId: idSchema,
  query: z.string().max(500),
  maxResults: z.number().int().min(1).max(300).optional(),
  includeDirectories: z.boolean().optional(),
  includeHidden: z.boolean().optional(),
});

export const workspaceSearchResultSchema = z.object({
  name: z.string(), path: z.string(), relativePath: z.string(), type: z.enum(["file", "directory"]), score: z.number(),
});

export const workspacePathInputSchema = z.object({
  projectId: idSchema,
  path: z.string().min(1),
});

export const workspaceRenameInputSchema = workspacePathInputSchema.extend({
  newName: z.string().min(1).max(255),
  newParentPath: z.string().min(1).nullable().default(null),
});

export const workspaceCreateInputSchema = z.object({
  projectId: idSchema,
  parentPath: z.string().min(1).nullable().default(null),
  name: z.string().min(1).max(255),
});

export const workspaceDuplicateInputSchema = workspacePathInputSchema.extend({
  destinationPath: z.string().min(1).nullable().default(null),
});

export const workspaceEntrySchema = z.object({
  name: z.string(),
  path: z.string(),
  type: z.enum(["file", "directory"]),
  relativePath: z.string().optional(),
});

export const createProjectInputSchema = z.object({
  name: z.string().min(1).max(120),
  workspacePath: z.string().min(1),
});

export const renameProjectInputSchema = z.object({
  projectId: idSchema,
  name: z.string().min(1).max(120),
});

export const projectStateInputSchema = z.object({
  projectId: idSchema,
  value: z.boolean(),
});

export const reorderProjectsInputSchema = z.object({
  projectIds: z.array(idSchema).min(1),
});

export const deleteProjectInputSchema = z.object({
  projectId: idSchema,
});

export const renameConversationInputSchema = z.object({
  conversationId: idSchema,
  name: z.string().min(1).max(160),
});

export const conversationStateInputSchema = z.object({
  conversationId: idSchema,
  value: z.boolean(),
});

export const conversationModelInputSchema = z.object({
  conversationId: idSchema,
  model: claudeModelSchema,
}).strict();

export const conversationSummaryInputSchema = z.object({
  conversationId: idSchema,
}).strict();

export const claudeHistorySessionSchema = z.object({
  key: z.string().regex(/^[a-f0-9]{64}$/),
  projectId: idSchema,
  title: z.string().min(1).max(100),
  updatedAt: z.string().datetime(),
});

export const claudeHistoryListInputSchema = z.object({ projectId: idSchema }).strict();
export const claudeHistoryReadInputSchema = z.object({
  projectId: idSchema,
  key: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();
export const claudeHistoryTranscriptSchema = z.object({
  session: claudeHistorySessionSchema,
  messages: z.array(z.object({
    role: z.enum(["user", "assistant"]),
    text: z.string().max(20_000),
  })).max(200),
  truncated: z.boolean(),
});

export const createConversationInputSchema = z.object({
  projectId: idSchema,
  name: z.string().min(1).max(160),
  provider: providerProfileIdSchema.default("claude-official"),
});

export const globalSearchInputSchema = z.object({
  query: z.string().min(1).max(200),
  limit: z.number().int().min(1).max(100).default(50),
}).strict();

export const globalSearchResultSchema = z.object({
  id: z.string(),
  kind: z.enum(["project", "conversation", "event", "terminal", "handoff", "artifact", "session"]),
  title: z.string(),
  snippet: z.string(),
  projectId: idSchema.nullable().default(null),
  conversationId: idSchema.nullable().default(null),
  terminalId: idSchema.nullable().default(null),
  nativeSessionId: z.string().nullable().default(null),
  projectName: z.string().nullable().default(null),
  updatedAt: z.string().nullable().default(null),
});

export type GlobalSearchResult = z.infer<typeof globalSearchResultSchema>;

export const continueConversationInputSchema = z.object({
  sourceConversationId: idSchema,
  targetProvider: providerProfileIdSchema,
}).strict();

export const messageInputSchema = z.object({
  conversationId: idSchema,
  profileId: providerProfileIdSchema,
  text: z.string().min(1).max(200_000),
  attachmentIds: z
    .array(idSchema)
    .max(20)
    .refine((ids) => new Set(ids).size === ids.length, "Attachment IDs must be unique.")
    .default([]),
  nativeWorkflow: z.boolean().optional(),
});

export const terminalCommandNameSchema = z.enum([
  "status",
  "session",
  "compact-status",
  "capabilities",
  "health",
  "handoff",
]);

export const terminalCommandInputSchema = z.object({
  conversationId: idSchema,
  command: terminalCommandNameSchema,
});

export type MessageInput = z.infer<typeof messageInputSchema>;

export const approvalResolveInputSchema = z.object({
  requestId: z.string().min(1),
  decision: z.enum(["accept", "acceptForSession", "decline", "cancel"]),
});

export const userInputResolveInputSchema = z.object({
  requestId: z.string().min(1),
  answers: z.record(
    z.string().min(1).max(200),
    z.array(z.string().min(1).max(20_000)).min(1).max(20),
  ).nullable(),
}).strict();

export const councilInputSchema = z.object({
  conversationId: idSchema,
  question: z.string().min(1).max(200_000),
  chairman: z.enum(["auto", "qwen", "glm"]).default("glm"),
  executeWith: providerProfileIdSchema.nullable().default(null),
});

export type CouncilInput = z.infer<typeof councilInputSchema>;

export const handoffPacketSchema = z.object({
  version: z.literal(1),
  generatedAt: z.string().datetime(),
  sourceProfile: providerProfileIdSchema,
  targetProfile: providerProfileIdSchema,
  objective: z.string(),
  facts: z.array(z.string()),
  decisions: z.array(z.string()),
  completed: z.array(z.string()),
  pending: z.array(z.string()),
  recentTerminal: z.array(z.string()).default([]),
  recentMessages: z.array(
    z.object({
      role: z.enum(["user", "assistant"]),
      content: z.string(),
    }),
  ),
  attachments: z.array(
    z.object({
      name: z.string(),
      mimeType: z.string(),
      localPath: z.string(),
    }),
  ),
  constraints: z.array(z.string()),
  workspace: z.object({
    path: z.string(),
    branch: z.string().nullable(),
    head: z.string().nullable(),
    status: z.string(),
    diffStat: z.string(),
  }),
  tokenEstimate: z.number().int().nonnegative(),
});

export type HandoffPacket = z.infer<typeof handoffPacketSchema>;

const codePointString = (max: number) => z.string().refine(
  (value) => Array.from(value).length <= max,
  { message: `Must contain at most ${max} Unicode code points.` },
);

const terminalHandoffListSchema = z.array(codePointString(280)).max(12);

/** Versioned PTY-to-PTY packet. Raw transcript/scrollback is never part of it. */
export const terminalHandoffPacketSchema = z.object({
  version: z.literal(1),
  // Privacy-safe stable reference (sha256-derived), never the live terminal id.
  sourceSessionId: z.string().min(1).max(80),
  sourceProfile: z.string().min(1).max(80).nullable(),
  targetProfile: providerProfileIdSchema,
  projectId: z.string().min(1).max(80).nullable(),
  worktree: z.object({
    branch: codePointString(200).optional(),
    head: z.string().max(80).optional(),
    diffStat: codePointString(600).optional(),
    dirty: z.boolean(),
  }).strict(),
  brief: codePointString(200).refine((value) => value.trim().length > 0, "Brief is required."),
  completed: terminalHandoffListSchema,
  changedFiles: terminalHandoffListSchema,
  verification: terminalHandoffListSchema,
  pending: terminalHandoffListSchema,
  nextAction: codePointString(400),
  risks: terminalHandoffListSchema,
  state: z.object({
    canonical: z.enum(["starting", "running", "waiting_input", "approval_required", "blocked", "done", "error"]).nullable(),
    authoritativeSource: z.enum(["heuristic", "screen", "jev", "osc", "broker", "provider", "process"]).nullable(),
    matchedRuleId: z.string().max(64).nullable(),
  }).strict(),
  lastCommand: z.object({
    command: codePointString(500),
    exitCode: z.number().int().nullable(),
    endedAt: z.string().datetime(),
  }).strict().nullable(),
  // "screen-snapshot" (issue #13): source was the VT screen-cache text because the
  // terminal was on the alternate screen (?1049h), where byte scrollback is noise.
  source: z.enum(["native-transcript", "sanitized-scrollback", "screen-snapshot", "mixed"]),
  partial: z.boolean(),
  createdAt: z.string().datetime(),
}).strict();

export const terminalHandoffRequestSchema = z.object({
  targetProfile: providerProfileIdSchema,
  objective: codePointString(2_000).refine((value) => value.trim().length > 0, "Objective is required."),
  idempotencyKey: z.string().trim().min(1).max(200),
}).strict();

export type TerminalHandoffPacket = z.infer<typeof terminalHandoffPacketSchema>;
export type TerminalHandoffRequest = z.infer<typeof terminalHandoffRequestSchema>;

// --- AgentApi fixed orchestrator workflow (issue #6) -------------------------

export const agentapiWorkflowStateSchema = z.enum([
  "queued",
  "dispatching_implementation",
  "waiting_implementation",
  "building_review_packet",
  "dispatching_review",
  "waiting_review",
  "changes_requested",
  "ready_for_human_review",
  "needs_human",
  "blocked",
  "failed",
  "canceled",
]);

export const agentapiReviewResultSchema = z.object({
  verdict: z.enum(["approved", "changes_requested", "blocked"]),
  summary: codePointString(2_000),
  findings: z.array(z.object({
    severity: z.enum(["critical", "major", "minor"]),
    file: codePointString(500).optional(),
    line: z.number().int().positive().optional(),
    message: codePointString(2_000),
    suggestedFix: codePointString(2_000).optional(),
  }).strict()).max(100),
  verification: z.array(codePointString(1_000)).max(50),
}).strict();

export const agentapiWorkflowOutcomeSchema = z.object({
  code: z.string().min(1).max(80),
  reason: codePointString(2_000),
  review: agentapiReviewResultSchema.optional(),
}).strict();

export const agentapiWorkflowCreateSchema = z.object({
  projectId: idSchema,
  task: codePointString(200_000).refine((value) => value.trim().length > 0, "Task is required."),
  idempotencyKey: z.string().trim().min(1).max(200),
  branch: z.string().min(1).max(200).optional(),
  baseRef: z.string().min(1).max(200).optional(),
  implementer: z.literal("claude-local-main").default("claude-local-main"),
  reviewer: z.literal("codex-local-main").default("codex-local-main"),
}).strict();

export const agentapiWorkflowSchema = z.object({
  id: idSchema,
  projectId: idSchema,
  task: z.string().min(1),
  idempotencyKey: z.string().min(1).max(200),
  branch: z.string().nullable(),
  baseRef: z.string().nullable(),
  implementer: z.literal("claude-local-main"),
  reviewer: z.literal("codex-local-main"),
  state: agentapiWorkflowStateSchema,
  resumeState: agentapiWorkflowStateSchema.nullable(),
  reviewLoop: z.number().int().min(0).max(3),
  worktreeId: idSchema.nullable(),
  worktreePath: z.string().nullable(),
  terminalId: idSchema.nullable(),
  sessionId: z.string().min(1).max(120).nullable(),
  handoffId: idSchema.nullable(),
  lastOutcome: agentapiWorkflowOutcomeSchema.nullable(),
  revision: z.number().int().nonnegative(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  startedAt: z.string().datetime().nullable(),
  completedAt: z.string().datetime().nullable(),
}).strict();

export const agentapiStepKindSchema = z.enum([
  "implementation_dispatch",
  "implementation_wait",
  "handoff",
  "review_dispatch",
  "review_wait",
  "correction_dispatch",
  "correction_running_wait",
  "correction_done_wait",
]);

export const agentapiStepStatusSchema = z.enum([
  "pending",
  "dispatching",
  "waiting",
  "completed",
  "needs_human",
  "failed",
  "canceled",
]);

export const agentapiWorkflowStepSchema = z.object({
  id: idSchema,
  workflowId: idSchema,
  kind: agentapiStepKindSchema,
  attempt: z.number().int().positive(),
  idempotencyKey: z.string().min(1).max(240),
  status: agentapiStepStatusSchema,
  terminalId: idSchema.nullable(),
  sessionId: z.string().min(1).max(120).nullable(),
  handoffId: idSchema.nullable(),
  outcome: agentapiWorkflowOutcomeSchema.nullable(),
  revision: z.number().int().nonnegative(),
  createdAt: z.string().datetime(),
  startedAt: z.string().datetime().nullable(),
  completedAt: z.string().datetime().nullable(),
}).strict();

export type AgentApiWorkflowState = z.infer<typeof agentapiWorkflowStateSchema>;
export type AgentApiReviewResult = z.infer<typeof agentapiReviewResultSchema>;
export type AgentApiWorkflowOutcome = z.infer<typeof agentapiWorkflowOutcomeSchema>;
export type AgentApiWorkflowCreate = z.infer<typeof agentapiWorkflowCreateSchema>;
export type AgentApiWorkflow = z.infer<typeof agentapiWorkflowSchema>;
export type AgentApiStepKind = z.infer<typeof agentapiStepKindSchema>;
export type AgentApiStepStatus = z.infer<typeof agentapiStepStatusSchema>;
export type AgentApiWorkflowStep = z.infer<typeof agentapiWorkflowStepSchema>;

// --- Terminal label (warroom identity) --------------------------------------
// 1.5.45: the warroom (eyes) opens an agent window with a label so the pane is
// identifiable at a glance — a thin colour band on the TOP edge of the tile,
// coloured stably by `group` (same group ⇒ same colour). `room` is the warroom
// folder the window belongs to (tooltip only); it stays optional so a plain
// terminal can be hand-coloured from the pane header with no room context.
// Memory-only by design: PTYs do not survive an app restart (dock-layout.ts
// deliberately persists fractions only), so the label needs no DB column.
export const terminalLabelSchema = z.object({
  room: z.string().max(500).default(""),
  group: z.string().min(1).max(80),
});

export const terminalSetLabelInputSchema = z.object({
  terminalId: idSchema,
  // null clears a hand-applied colour.
  label: terminalLabelSchema.nullable(),
}).strict();

export const terminalCreateInputSchema = z.object({
  projectId: idSchema,
  profile: z.enum(["powershell", "cmd", "wsl", "pwsh", "zsh", "bash"]),
  cwd: z.string().min(1),
  title: z.string().min(1).max(80).optional(),
  isAgent: z.boolean().default(false),
  agentProfile: z.string().min(1).max(80).nullable().default(null),
  // Env vars injected at pty.spawn (no terminal echo). Caller builds per-profile
  // env (proxy URL, model, feature flags, AUTH_TOKEN). Keys must be non-empty
  // ASCII env names; values are strings.
  agentEnv: z.record(z.string().min(1), z.string()).optional(),
  // A — worktree sandbox id when this terminal runs inside a worktree.
  worktreeId: idSchema.optional(),
  // 1.5.45 warroom identity (see terminalLabelSchema). Only the dock's openTile
  // path sets it; the plain createTerminal RPC never does.
  label: terminalLabelSchema.optional(),
});

export const terminalWriteInputSchema = z.object({
  terminalId: idSchema,
  data: z.string().max(1_000_000),
  source: z.enum(["human", "automation", "mobile-composer", "voice"]).optional(),
  clientMutationId: z.string().uuid().optional(),
  // Hold the write until the shell has shown its first prompt (canonical state
  // leaves "starting"), so a launch command typed into a still-booting shell
  // cannot have its trailing Enter swallowed (#50). Times out and writes anyway.
  waitForShellReady: z.boolean().optional(),
});

export const terminalResizeInputSchema = z.object({
  terminalId: idSchema,
  cols: z.number().int().min(2).max(1000),
  rows: z.number().int().min(1).max(500),
});

export const terminalIdInputSchema = z.object({
  terminalId: idSchema,
});

export const terminalRenameInputSchema = z.object({
  terminalId: idSchema,
  title: z.string().min(1).max(80),
});

export const terminalMarkAgentInputSchema = z.object({
  terminalId: idSchema,
  agentProfile: z.string().min(1).max(80),
}).strict();

export const terminalSetNativeSessionIdInputSchema = z.object({
  terminalId: idSchema,
  nativeSessionId: z.string().min(1).max(120),
}).strict();

export const terminalWorkspaceSaveInputSchema = z.object({
  projectId: idSchema,
  split: z.enum(["single", "vertical", "horizontal", "grid"]),
  terminalIds: z.array(idSchema).max(8),
  activeId: idSchema.nullable(),
  secondaryId: idSchema.nullable(),
});

// Type-only schema: never used for runtime parse, only consumed via z.infer for
// the TerminalInfo type. Kept (not deleted) to preserve field-level type safety.
export const terminalInfoSchema = z.object({
  id: idSchema,
  projectId: idSchema,
  profile: z.enum(["powershell", "cmd", "wsl", "pwsh", "zsh", "bash"]),
  title: z.string(),
  cwd: z.string(),
  cols: z.number().int(),
  rows: z.number().int(),
  status: z.enum(["running", "exited"]),
  startedAt: z.string().datetime(),
  closedAt: z.string().datetime().nullable(),
  lastExitCode: z.number().int().nullable(),
  isAgent: z.boolean().default(false),
  agentProfile: z.string().nullable().default(null),
  ownedByAgentApi: z.boolean().default(false),
  pid: z.number().int().default(0),
  // The claude --session-id Coterm generated for this terminal agent (null for
  // plain shells / codex / gemini). Lets context-meter + clean-view resolve the
  // EXACT .jsonl by id instead of cwd+mtime (which collides across same-project
  // agent panes).
  nativeSessionId: z.string().nullable().default(null),
  // Codex Desktop/CLI stores its generated task title in state_5.sqlite, not
  // OSC 0 (which usually remains the cwd basename). Optional for snapshots
  // produced by older clients; main fills it after binding the rollout.
  agentSummaryTitle: z.string().nullable().optional(),
  // Provider-authored "away recap" (Claude Code writes it as system/away_summary).
  // Deliberately a SEPARATE field from agentSummaryTitle: the recap is a long,
  // volatile sentence meant for the mobile PTY-switcher marquee, while the
  // header keeps the short amber session summary. Writing the recap into
  // agentSummaryTitle blanked the header whenever no recap existed and pasted
  // proxy error text over it when one did (v1.5.19 regression).
  agentRecap: z.string().nullable().optional(),
  // A — when this terminal was spawned inside a worktree sandbox, the worktree
  // id. Null for plain project-cwd terminals. Drives the running-PTY guard
  // (WorktreeManager refuses destructive ops while a PTY is bound here).
  worktreeId: idSchema.nullable().default(null),
  // Context battery: metadata-only used/window token counts for official
  // Claude/Codex profiles. GLM/Qwen profiles and plain shells stay
  // null because their usage reports are unreliable. Main-owned and refreshed
  // every 10s by ContextBatteryMonitor.
  contextUsage: z
    .object({
      usedTokens: z.number().int().nonnegative(),
      windowTokens: z.number().int().positive().nullable(),
      percent: z.number().min(0).max(100).nullable(),
      model: z.string().nullable().optional(),
    })
    .nullable()
    .default(null),
  // Warroom identity (see terminalLabelSchema). null/absent = no band, the
  // common case for hand-opened plain shells. Deliberately NOT `.default(null)`
  // — that makes the inferred field required and breaks every existing
  // TerminalInfo literal in the test suite. Same pattern as agentSummaryTitle.
  label: terminalLabelSchema.nullable().optional(),
  // Agent mail handle (@-mentions): "claude-1", "codex-2", … Unique among open
  // panes, family-prefixed, lowest free index. Null for plain shells that have
  // never mailed. Same not-defaulted pattern as `label` (test literals).
  agentHandle: z.string().nullable().optional(),
});

export type TerminalInfo = z.infer<typeof terminalInfoSchema>;

// Type-only schema: never parsed at runtime, only consumed via z.infer for the
// UsageSnapshot type. The main-process UsageMonitor publishes this; the TopBar
// HUD (desktop/web/mobile) renders it. All fields are metadata — percentages,
// reset epochs, source file mtime. Never the file body (logging §A.2).
export const usageSlotSchema = z.object({
  percent: z.number().min(0).max(100).nullable(),
  resetAt: z.number().int().nullable(),
  updatedAt: z.number().nullable(),
  source: z.enum(["claude", "codex"]),
});
export const usageSnapshotSchema = z.object({
  claude5h: usageSlotSchema.nullable(),
  claude7d: usageSlotSchema.nullable(),
  codex7d: usageSlotSchema.nullable(),
  fetchedAt: z.number().int(),
});
export type UsageSlot = z.infer<typeof usageSlotSchema>;
export type UsageSnapshot = z.infer<typeof usageSnapshotSchema>;

// Type-only schema: never used for runtime parse, only consumed via z.infer for
// the TerminalWorkspaceState type. Kept to preserve field-level type safety.
export const terminalWorkspaceStateSchema = z.object({
  terminals: z.array(terminalInfoSchema),
  split: z.enum(["single", "vertical", "horizontal", "grid"]),
  activeId: idSchema.nullable(),
  secondaryId: idSchema.nullable(),
  scrollback: z.record(idSchema, z.string()),
  scrollbackRevision: z.record(idSchema, z.number().int().nonnegative()),
  restored: z.boolean(),
});

export type TerminalWorkspaceState = z.infer<typeof terminalWorkspaceStateSchema>;

// Type-only schema: never used for runtime parse, only consumed via z.infer for
// the BootstrapData type. Kept to preserve field-level type safety.
export const bootstrapDataSchema = z.object({
  projects: z.array(projectSchema),
  conversations: z.array(conversationSchema),
  runningConversationIds: z.array(idSchema).default([]),
  archivedProjects: z.array(projectSchema).default([]),
  archivedConversations: z.array(conversationSchema).default([]),
  providers: z.array(providerStatusSchema),
  appVersion: z.string(),
  userDataPath: z.string(),
  startupAlerts: z.string().default(""),
});

export type BootstrapData = z.infer<typeof bootstrapDataSchema>;

export const appSettingsSchema = z.object({
  theme: z.enum(["dark", "light"]).default("dark"),
  // 閱讀模式排版預設 (2026-10-02)：工具列一鍵切換格數版面。值域與
  // reading-mode.ts 的 READING_PRESETS 同步；壞 id 由 renderer 端退回 2-halves。
  readingPreset: z.enum([
    "1-full", "2-halves", "2-stacked", "3-left-big",
    "4-left-big-tri", "4-grid", "6-grid",
  ]).default("2-halves"),
  // DOM code blocks and xterm use separate renderers, so they intentionally
  // have separate theme preferences. Both default to auto for migrations from
  // older settings files.
  codeTheme: z.enum([
    "auto", "github-light", "github-dark", "solarized-light", "solarized-dark",
    "dracula", "monokai", "nord", "aurora-x",
  ]).default("auto"),
  terminalTheme: z.enum([
    "auto", "github-light", "github-dark", "one-half-light", "one-half-dark",
    "solarized-light", "solarized-dark", "dracula", "monokai", "nord",
  ]).default("auto"),
  locale: z.enum(["zh-TW", "en-US"]).default("zh-TW"),
  defaultProvider: providerProfileIdSchema.catch("claude-official").default("claude-official"),
  defaultShell: z.enum(["powershell", "cmd", "wsl", "pwsh", "zsh", "bash"]).default("pwsh"),
  terminalFontSize: z.number().int().min(8).max(48).default(16),
  // PTY 字體：curated monospace 清單＋系統預設。每個字型的 fallback 鏈固定接
  // CJK 備援（Microsoft JhengHei UI → Noto Sans TC → monospace），選不到的字型
  // 由 CSS 逐級退回；壞值經 .catch 退回系統預設（同 defaultProvider 路線）。
  terminalFont: z.enum([
    "default", "cascadia-mono", "cascadia-code", "consolas", "jetbrains-mono",
    "fira-code", "source-code-pro", "geist-mono", "ibm-plex-mono", "roboto-mono", "lxgw-wenkai-mono",
    "sarasa-mono-tc", "mingliu",
  ]).catch("default").default("default"),
  claudeKeepaliveHours: z.union([
    z.literal(0), z.literal(2), z.literal(4), z.literal(6), z.literal(8),
  ]).default(2),
  proxyUrl: z.string().url().default("http://127.0.0.1:8787"),
  // Hot model registry (stage 1): optional user-defined profiles; empty default
  // keeps old settings files parsing unchanged (Q7 migration pattern).
  customProfiles: customProfilesSchema.default({}),
  permissionPreset: z.enum(["ask", "trusted"]).default("ask"),
  onboardingCompleted: z.boolean().default(false),
  defaultWorkspacePath: z.string().nullable().default(null),
  telemetry: z.literal(false).default(false),
  // 全域搜尋背景索引：關閉時不建/不更新 ledger FTS sidecar（搜尋只剩 session 索引）。
  searchIndexEnabled: z.boolean().default(true),
  // 代理視窗完成／需要人工時的 Windows 原生通知（右下角 toast）。預設開。
  agentDoneToast: z.boolean().default(true),
  // 重開時還原上次的 dock：窗格＋版面＋選取窗格，代理窗以原生 resume 接續對話。預設開。
  restoreSessionOnLaunch: z.boolean().default(true),
  agentApi: z.object({
    enabled: z.boolean().default(true),
    token: z.string().default(""),
    // Issue #93: the agent mutation budget is two independent token buckets,
    // because terminal mutations are human-scale while one browser form flow is
    // ~12 mutations. Sharing one bucket meant a browser script ate the terminal
    // dispatch quota (and vice versa). Defaults preserve the pre-#93 ceiling of
    // 30/min per client on each bucket; range bound keeps a typo from
    // effectively disabling the backpressure that stops a runaway retry loop.
    rateLimit: z.object({
      terminalPerMinute: z.number().int().min(1).max(10_000).default(AGENT_RATE_LIMIT_DEFAULTS.terminalPerMinute),
      browserPerMinute: z.number().int().min(1).max(10_000).default(AGENT_RATE_LIMIT_DEFAULTS.browserPerMinute),
    }).default(AGENT_RATE_LIMIT_DEFAULTS),
    // The outer default must spell out rateLimit too: a zod .default() object
    // replaces the WHOLE value rather than filling in the inner defaults, so
    // omitting it here left base.agentApi.rateLimit undefined for any settings
    // object parsed without an explicit agentApi (legacy files, fresh installs)
    // — and the per-field patch merge then dereferenced it.
  }).default({ enabled: true, token: "", rateLimit: { ...AGENT_RATE_LIMIT_DEFAULTS } }),
  retention: z.object({
    days: z.number().int().min(1).max(3650).default(30),
    pruneOnStart: z.boolean().default(true),
  }).default({ days: 30, pruneOnStart: true }),
  // Browser navigation policy (issue #48). Default stays safe (block private
  // networks) so SSRF protection holds unless the user explicitly opts in.
  browserNetwork: z.object({
    mode: z.enum(["block", "allow-private", "allow-hosts"]).default("block"),
    allowHosts: z.array(z.string().trim().toLowerCase()).default([]),
  }).default({ mode: "block", allowHosts: [] }),
  browserApproval: z.object({
    mode: z.enum(["ask", "auto"]).default("ask"),
  }).default({ mode: "ask" }),
  // Phase 7 feature flags (work order §14). P0 is enabled for the Beta;
  // unfinished P1 capabilities stay opt-in. Both remain user-toggleable and
  // fail closed without affecting the core browser actions.
  browser: z.object({
    superpowersP0: z.boolean().default(true),
    superpowersP1: z.boolean().default(true),
  }).default({ superpowersP0: true, superpowersP1: true }),
  // Agent browser popout (user request 2026-10-09): agent-created sessions
  // without an explicit mode run as a real Chromium window, placed by
  // window-placement.ts away from the Coterm main window. "embedded" keeps the
  // old headless sidebar behavior.
  agentBrowserWindow: z.enum(["popout", "embedded"]).default("popout"),
  // Full access for agent browser sessions: every new session starts in
  // no-questions mode (issue #93 grantSession at creation) — the deliberate
  // opt-in exception to the new-session-asks-again default. secretRef handles
  // and download path containment are untouched.
  agentBrowserFullAccess: z.boolean().default(false),
  voice: z.object({
    enabled: z.boolean().default(true),
    lang: z.enum(["zh-TW", "zh-CN", "en-US"]).default("zh-TW"),
    // Live Voice decouples STT detection from response/TTS language. `lang`
    // remains for legacy dictation compatibility; new hands-free flows use the
    // explicit fields below.
    sttLanguageMode: z.enum(["auto", "zh-TW", "zh-CN", "en-US"]).default("auto"),
    responseLanguage: z.enum(["zh-TW", "zh-CN", "en-US"]).default("zh-TW"),
    // Desktop dictation posts the clip to an OpenAI-shaped
    // /v1/audio/transcriptions endpoint (whisper.cpp whisper-server, speaches,
    // or any server that speaks the same request). Empty = desktop mic hidden;
    // the browser/mobile build keeps using Web Speech either way.
    sttUrl: z.string().trim().refine(
      (value) => value === "" || /^https?:\/\//i.test(value),
      "Speech-to-text URL must use http or https.",
    ).default(""),
    // whisper.cpp ignores this; speaches and OpenAI require a real model id.
    sttModel: z.string().trim().min(1).max(200).default("whisper-1"),
    // Bearer key for hosted endpoints (Groq/OpenAI); empty = no Authorization
    // header, which is what local whisper servers expect.
    sttApiKey: z.string().trim().max(500).default(""),
    // Phase 4: streaming dictation sends rolling 5s previews while recording
    // (partial draft updates), then a final full-utterance transcription on stop.
    streamingDictation: z.boolean().default(true),
    // LiveKit realtime duplex voice (work order 2026-08-16-livekit-duplex-voice).
    // apiKey/apiSecret are generated locally on first enable (>=32 chars) and are
    // never logged; the UI shows masked presence only.
    // `provider` selects the Live Voice brain: "cascade" keeps the local
    // whisper → supervisor → Edge TTS chain; "gemini" forwards the mic to the
    // Gemini Live API (speech-to-speech) and plays its 24k PCM replies back.
    live: z.object({
      enabled: z.boolean().default(true),
      provider: z.enum(["cascade", "gemini"]).default("cascade"),
      serverUrl: z.string().trim().refine(
        (value) => /^wss?:\/\//i.test(value),
        "Live Voice server URL must use ws or wss.",
      ).default("ws://127.0.0.1:7880"),
      apiKey: z.string().max(128).default(""),
      apiSecret: z.string().max(256).default(""),
      ttsVoice: z.string().trim().min(1).max(100).default("zh-TW-HsiaoChenNeural"),
      // Google AI Studio key for the Gemini Live API. Empty = gemini provider
      // cannot start and the session degrades to chunked dictation. Stored
      // locally only, never logged, and never synced.
      geminiApiKey: z.string().trim().max(200).default(""),
      geminiModel: z.string().trim().min(1).max(100).default("gemini-3.1-flash-live-preview"),
    }).default({
      enabled: true,
      provider: "cascade",
      serverUrl: "ws://127.0.0.1:7880",
      apiKey: "",
      apiSecret: "",
      ttsVoice: "zh-TW-HsiaoChenNeural",
      geminiApiKey: "",
      geminiModel: "gemini-3.1-flash-live-preview",
    }),
  }).default({
    enabled: true,
    lang: "zh-TW",
    sttLanguageMode: "auto",
    responseLanguage: "zh-TW",
    sttUrl: "",
    sttModel: "whisper-1",
    sttApiKey: "",
    streamingDictation: true,
    live: {
      enabled: true,
      provider: "cascade",
      serverUrl: "ws://127.0.0.1:7880",
      apiKey: "",
      apiSecret: "",
      ttsVoice: "zh-TW-HsiaoChenNeural",
      geminiApiKey: "",
      geminiModel: "gemini-3.1-flash-live-preview",
    },
  }),
  // 2026-09-26 maintainer: Jev 注意力複判. When an agent window goes quiet, the
  // last screen lines are sent to typesafe-ai/jev (Vercel AI Gateway) for a
  // "waiting on you / done / still working" second opinion. Opt-in (default
  // off) because screen text leaves the machine; apiKey = AI Gateway key.
  jev: z.object({
    enabled: z.boolean().default(false),
    apiKey: z.string().trim().max(500).default(""),
  }).default({
    enabled: false,
    apiKey: "",
  }),
  // 2026-09-24 maintainer: topbar 檢查點按鈕的顯示開關。功能保留,按鈕可藏;
  // 2026-09-27: 預設改關（很少用）;要用時到設定打開。
  checkpoint: z.object({
    topbarButton: z.boolean().default(false),
  }).default({
    topbarButton: false,
  }),
  // 2026-10-06 maintainer: 閱讀模式（書本鈕）會強制重排、困住視窗，太難用。
  // 功能保留，按鈕預設藏起來；要用時把 topbarButton 打開。
  readingMode: z.object({
    topbarButton: z.boolean().default(false),
  }).default({
    topbarButton: false,
  }),
  // Task center (任務中心) removed 2026-10-15. `agentapi.voiceAgent` stays:
  // the live-voice orchestrator (kept for speech-to-speech) gates its deep
  // paths on it, so old settings files keep parsing unchanged.
  agentapi: z.object({
    voiceAgent: z.boolean().default(false),
  }).default({
    voiceAgent: false,
  }),
});

export type AppSettings = z.infer<typeof appSettingsSchema>;

// #60: patch schema for `settings:set`. Unlike appSettingsSchema it has no
// defaults, so absent fields stay absent and are NOT turned into "reset to
// default" on merge. Never parse a partial payload with appSettingsSchema.
// Keep the field shapes in sync with appSettingsSchema (defaults stripped,
// every field optional, nested objects deep-optional).
export const appSettingsPatchSchema = z.object({
  theme: z.enum(["dark", "light"]).optional(),
  readingPreset: z.enum([
    "1-full", "2-halves", "2-stacked", "3-left-big",
    "4-left-big-tri", "4-grid", "6-grid",
  ]).optional(),
  codeTheme: z.enum([
    "auto", "github-light", "github-dark", "solarized-light", "solarized-dark",
    "dracula", "monokai", "nord", "aurora-x",
  ]).optional(),
  terminalTheme: z.enum([
    "auto", "github-light", "github-dark", "one-half-light", "one-half-dark",
    "solarized-light", "solarized-dark", "dracula", "monokai", "nord",
  ]).optional(),
  locale: z.enum(["zh-TW", "en-US"]).optional(),
  // Same .catch as the base schema: unknown legacy provider ids coerce to
  // claude-official instead of failing the whole patch.
  defaultProvider: providerProfileIdSchema.catch("claude-official").optional(),
  defaultShell: z.enum(["powershell", "cmd", "wsl", "pwsh", "zsh", "bash"]).optional(),
  terminalFontSize: z.number().int().min(8).max(48).optional(),
  terminalFont: z.enum([
    "default", "cascadia-mono", "cascadia-code", "consolas", "jetbrains-mono",
    "fira-code", "source-code-pro", "geist-mono", "ibm-plex-mono", "roboto-mono", "lxgw-wenkai-mono",
    "sarasa-mono-tc", "mingliu",
  ]).catch("default").optional(),
  claudeKeepaliveHours: z.union([
    z.literal(0), z.literal(2), z.literal(4), z.literal(6), z.literal(8),
  ]).optional(),
  proxyUrl: z.string().url().optional(),
  customProfiles: customProfilesSchema.optional(),
  permissionPreset: z.enum(["ask", "trusted"]).optional(),
  onboardingCompleted: z.boolean().optional(),
  defaultWorkspacePath: z.string().nullable().optional(),
  telemetry: z.literal(false).optional(),
  searchIndexEnabled: z.boolean().optional(),
  agentDoneToast: z.boolean().optional(),
  restoreSessionOnLaunch: z.boolean().optional(),
  agentApi: z.object({
    enabled: z.boolean().optional(),
    token: z.string().optional(),
    rateLimit: z.object({
      terminalPerMinute: z.number().int().min(1).max(10_000).optional(),
      browserPerMinute: z.number().int().min(1).max(10_000).optional(),
    }).optional(),
  }).optional(),
  retention: z.object({
    days: z.number().int().min(1).max(3650).optional(),
    pruneOnStart: z.boolean().optional(),
  }).optional(),
  browserNetwork: z.object({
    mode: z.enum(["block", "allow-private", "allow-hosts"]).optional(),
    allowHosts: z.array(z.string().trim().toLowerCase()).optional(),
  }).optional(),
  browserApproval: z.object({
    mode: z.enum(["ask", "auto"]).optional(),
  }).optional(),
  browser: z.object({
    superpowersP0: z.boolean().optional(),
    superpowersP1: z.boolean().optional(),
  }).optional(),
  agentBrowserWindow: z.enum(["popout", "embedded"]).optional(),
  agentBrowserFullAccess: z.boolean().optional(),
  voice: z.object({
    enabled: z.boolean().optional(),
    lang: z.enum(["zh-TW", "zh-CN", "en-US"]).optional(),
    sttLanguageMode: z.enum(["auto", "zh-TW", "zh-CN", "en-US"]).optional(),
    responseLanguage: z.enum(["zh-TW", "zh-CN", "en-US"]).optional(),
    sttUrl: z.string().trim().refine(
      (value) => value === "" || /^https?:\/\//i.test(value),
      "Speech-to-text URL must use http or https.",
    ).optional(),
    sttModel: z.string().trim().min(1).max(200).optional(),
    sttApiKey: z.string().trim().max(500).optional(),
    streamingDictation: z.boolean().optional(),
    live: z.object({
      enabled: z.boolean().optional(),
      provider: z.enum(["cascade", "gemini"]).optional(),
      serverUrl: z.string().trim().refine(
        (value) => /^wss?:\/\//i.test(value),
        "Live Voice server URL must use ws or wss.",
      ).optional(),
      apiKey: z.string().max(128).optional(),
      apiSecret: z.string().max(256).optional(),
      ttsVoice: z.string().trim().min(1).max(100).optional(),
      geminiApiKey: z.string().trim().max(200).optional(),
      geminiModel: z.string().trim().min(1).max(100).optional(),
    }).optional(),
  }).optional(),
  checkpoint: z.object({
    topbarButton: z.boolean().optional(),
  }).optional(),
  readingMode: z.object({
    topbarButton: z.boolean().optional(),
  }).optional(),
  jev: z.object({
    enabled: z.boolean().optional(),
    apiKey: z.string().trim().max(500).optional(),
  }).optional(),
  agentapi: z.object({
    voiceAgent: z.boolean().optional(),
  }).optional(),
});

export type AppSettingsPatch = z.infer<typeof appSettingsPatchSchema>;

// Type-only schema: never used for runtime parse, only consumed via z.infer for
// the Diagnostics type. Kept to preserve field-level type safety.
export const diagnosticsSchema = z.object({
  generatedAt: z.string().datetime(),
  appVersion: z.string(),
  platform: z.string(),
  arch: z.string(),
  providers: z.array(providerStatusSchema),
  database: z.object({
    path: z.string(),
    schemaVersion: z.number().int(),
  }),
  recentErrors: z.array(z.string()),
});

export type Diagnostics = z.infer<typeof diagnosticsSchema>;

// --- Dock layout (terminal-first overhaul) ---------------------------------
// Single source of truth for the terminal dock. Owned by the main process,
// broadcast to all clients (desktop renderer + web/mobile via WS).
// See docs/superpowers/specs/2026-06-28-terminal-first-overhaul-design.md.

export const dockTileSchema = z.object({
  terminalId: idSchema,
  projectId: idSchema,
  weight: z.number().positive().default(1),
  agentProfile: z.string().nullable().optional().default(null),
  // Warroom identity. Carried on the tile as well as on TerminalInfo so a tile
  // whose PTY is still hydrating can paint its band from the layout broadcast.
  // Optional (not defaulted) for the same reason as terminalInfoSchema.label.
  label: terminalLabelSchema.nullable().optional(),
});

export const dockLayoutSchema = z.object({
  // Lockstep with MAX_TILES (dock-layout.ts) / MAX_TERMINALS (agent-api.ts) / DOCK_MAX_TILES (sidebar-sessions.ts).
  tiles: z.array(dockTileSchema).max(12),
  selectedTerminalId: idSchema.nullable(),
  // C3: exclusive (solo) view override — when set, renderer shows only this
  // terminal full-pane. Temporary: not persisted, cleared on close/open/select.
  exclusiveTerminalId: idSchema.nullable().default(null),
  rows: z.array(z.number().min(0).max(1)),
  cols: z.array(z.array(z.number().min(0).max(1))),
  // Shared PTY geometry (main-process SoT). All clients render to this size.
  // Defaults match PtyManager's initial 100x28 so old persisted layouts upgrade.
  ptyCols: z.number().int().min(2).max(1000).default(100),
  ptyRows: z.number().int().min(1).max(500).default(28),
});

export const dockOpenTileInputSchema = z.object({
  projectId: idSchema,
  // When set, the new tile is spawned as an agent PTY with these env vars
  // injected at spawn (no terminal echo). Empty/absent = plain shell tile.
  agentProfile: z.string().min(1).max(80).optional(),
  agentEnv: z.record(z.string().min(1), z.string()).optional(),
  // A — when set, the tile is spawned inside this worktree sandbox (cwd becomes
  // the worktree path). The WorktreeManager must report the worktree active.
  worktreeId: idSchema.optional(),
  // 1.5.45 warroom identity — optional; absent for every existing caller.
  label: terminalLabelSchema.optional(),
}).strict();

export const dockCloseTileInputSchema = z.object({
  terminalId: idSchema,
}).strict();

export const dockSelectTileInputSchema = z.object({
  terminalId: idSchema,
}).strict();

export const dockSetLayoutInputSchema = z.object({
  rows: z.array(z.number().min(0).max(1)),
  cols: z.array(z.array(z.number().min(0).max(1))),
}).strict();

export const dockSetExclusiveInputSchema = z.object({
  terminalId: idSchema.nullable(),
}).strict();

export const dockReorderTileInputSchema = z.object({
  terminalId: idSchema,
  toIndex: z.number().int().min(0).max(11),
}).strict();

// --- Structured shell integration (OSC 133/633) -----------------------------
// A privacy-safe record of one executed shell command. Built ONLY when the
// shell emits a rich lifecycle (OSC 633 E=command + C=pre-exec + D=finished).
// Shells without the E marker (OSC 133, cmd.exe) never produce a result —
// getLastCommand returns null rather than guessing command/exit.
// command is already redactEgress'd + length-capped by PtyManager before this
// record is ever built; repository.appendTerminalEvent re-sanitizes as defence
// in depth. Never logged with command in coterm.log metadata.
export const commandResultSchema = z.object({
  id: idSchema,
  cwd: z.string(),
  command: z.string().min(1).max(4_001),
  // null when the shell's D marker carried no exit value (e.g. OSC 133 D).
  exitCode: z.number().int().nullable(),
  startedAt: z.string().datetime(),
  endedAt: z.string().datetime(),
  durationMs: z.number().int().nonnegative(),
}).strict();

export type CommandResult = z.infer<typeof commandResultSchema>;

// --- Agent Attention Center (canonical PtyState + notifications) ------------
// Canonical terminal state machine. Legacy 3-state (idle/shell-ready/llm-running)
// is preserved via toLegacyPtyState() in shared/pty-state.ts — the wire type is
// canonical, old consumers map back. PtyState is NOT stored on TerminalInfo; the
// dashboard snapshot + the ptyStateChanged event are the single source of truth.
//
// Attention states (need a human): waiting_input, approval_required, blocked,
// error. AttentionCenter only files notifications for these.
export const ptyStateSchema = z.enum([
  "starting",
  "running",
  "waiting_input",
  "approval_required",
  "blocked",
  "done",
  "error",
]);

export type PtyState = z.infer<typeof ptyStateSchema>;

export const ptyStateSourceSchema = z.enum([
  "heuristic", // ANSI title / prompt detection (lowest reliability)
  "screen", // live main-owned bottom-buffer rule engine
  "jev", // model second-opinion consulted from the quiet heuristic
  "osc", // OSC 633 lifecycle + OSC 9/99/777 notification markers
  "broker", // ApprovalBroker pending/resolved signal (terminal-scoped)
  "provider", // NormalizedEvent from the adapter (terminal-scoped)
  "process", // PTY exit/kill/dispose (reliable terminal lifecycle)
]);

export type PtyStateSource = z.infer<typeof ptyStateSourceSchema>;

/**
 * Scrollback buffer mode (issue #13 / AT-138). Whether a terminal is currently on
 * the normal buffer or the alternate screen (DEC private mode 1049) — from the
 * PtyManager DecModeTracker, NOT from any handoff source string. Under
 * "alternate-screen" the raw byte scrollback is full-repaint escape noise, so
 * text consumers must read screenText instead.
 */
export const scrollbackModeSchema = z.enum(["normal", "alternate-screen"]);

export type ScrollbackMode = z.infer<typeof scrollbackModeSchema>;

/**
 * Privacy boundary for Agent state explanations. This is deliberately a
 * strict metadata-only shape: no PTY text, regex evidence, command, or prompt
 * can cross the RPC/REST boundary as an accidental extra property.
 */
export const agentStateExplanationSchema = z.object({
  canonicalState: ptyStateSchema,
  authoritativeSource: ptyStateSourceSchema.nullable(),
  agentProfile: z.string().max(80).nullable(),
  matchedRuleId: z.string().max(64).nullable(),
  fallbackReason: z.string().max(128).nullable(),
  evaluatedRegion: z.enum([
    "bottom_non_empty",
    "after_last_horizontal_rule",
    "osc_title",
    "prompt_box_body",
    "whole_recent",
  ]).nullable(),
  gateSummary: z.object({
    allPassed: z.boolean(),
    allCount: z.number().int().nonnegative().max(16),
    anyPassed: z.boolean(),
    anyCount: z.number().int().nonnegative().max(16),
    nonePassed: z.boolean(),
    noneCount: z.number().int().nonnegative().max(16),
  }).strict().nullable(),
  manifestVersion: z.string().max(64).nullable(),
  evaluatedAt: z.string().datetime(),
}).strict();

export type AgentStateExplanation = z.infer<typeof agentStateExplanationSchema>;

export const ptyStateChangedSchema = z.object({
  terminalId: idSchema,
  projectId: idSchema,
  state: ptyStateSchema,
  previousState: ptyStateSchema.nullable(),
  source: ptyStateSourceSchema,
}).strict();

export type PtyStateChanged = z.infer<typeof ptyStateChangedSchema>;

// --- Per-window prompt-cache keepalive (pane header +/-) ---------------------
// Paid official profiles only (claude-official / codex-official). The engine
// lives in main (ClaudeKeepaliveManager); this is its wire shape for the
// pane-header control. effectiveHours = overrideHours ?? global setting.
export const terminalKeepaliveStateSchema = z.object({
  terminalId: idSchema,
  profile: z.string().max(80).nullable(),
  eligible: z.boolean(),
  overrideHours: z.number().int().min(0).max(8).nullable(),
  effectiveHours: z.number().int().min(0).max(8),
  // #91 freshness guard: true once a due tick found the prompt cache past its
  // TTL — keepalive injection is paused until the human talks again. The pane
  // header badge surfaces this ("已冷卻停續") rather than silently idling.
  cooled: z.boolean(),
}).strict();

export type TerminalKeepaliveState = z.infer<typeof terminalKeepaliveStateSchema>;

export const terminalKeepaliveSetInputSchema = z.object({
  terminalId: idSchema,
  // null clears the per-window override (window follows the global setting again).
  hours: z.number().int().min(0).max(8).nullable(),
}).strict();

export type TerminalKeepaliveSetInput = z.infer<typeof terminalKeepaliveSetInputSchema>;

// Pushed when the built-in browser persists a screenshot to disk. Metadata
// only: file path + page URL/title, never the image bytes (the rail re-reads
// the file through readArtifact when the user opens it).
export const browserArtifactSavedSchema = z.object({
  path: z.string().min(1).max(4096),
  pageUrl: z.string().max(4096),
  title: z.string().max(300),
  savedAt: z.string().datetime(),
}).strict();

export type BrowserArtifactSaved = z.infer<typeof browserArtifactSavedSchema>;

// Metadata-only notification record. Never carries the prompt, approval
// question text, command, or raw PTY output — only the state + terminal id +
// source. The message that triggered classification is used transiently inside
// PtyManager/AttentionCenter and discarded (logging-api §A.2 layering).
export const attentionNotificationSchema = z.object({
  id: idSchema,
  terminalId: idSchema,
  projectId: idSchema,
  state: ptyStateSchema,
  source: ptyStateSourceSchema,
  createdAt: z.string().datetime(),
  resolvedAt: z.string().datetime().nullable(),
}).strict();

export type AttentionNotification = z.infer<typeof attentionNotificationSchema>;

export const attentionResolveInputSchema = z.object({
  notificationId: idSchema,
}).strict();

// --- A — Worktree sandbox + trusted resume ----------------------------------
// A git worktree bound to a project. native_session_id + resume_command are
// populated in two phases: null at create, set after the agent emits its
// session id. resume_command is metadata-only (profile + sessionId) rebuilt
// from an allowlist at resume time — never a persisted arbitrary shell command,
// never a secret/token.
export const worktreeStatusSchema = z.enum([
  "active",
  "merged",
  "aborted",
  "conflict",
  "closed",
]);

export type WorktreeStatus = z.infer<typeof worktreeStatusSchema>;

export const worktreePermissionsPresetSchema = z.enum(["ask", "trusted"]);

export type WorktreePermissionsPreset = z.infer<typeof worktreePermissionsPresetSchema>;

export const worktreeSchema = z.object({
  id: idSchema,
  projectId: idSchema,
  branch: z.string().min(1).max(200),
  worktreePath: z.string().min(1),
  baseRef: z.string().min(1).max(200),
  status: worktreeStatusSchema,
  nativeSessionId: z.string().nullable().default(null),
  // Metadata-only resume hint (profile + sessionId). Never executed verbatim;
  // resume rebuilds the launch argv from the profile allowlist + sessionId.
  resumeCommand: z.string().nullable().default(null),
  prUrl: z.string().url().nullable().default(null),
  permissionsPreset: worktreePermissionsPresetSchema.default("ask"),
  // True when a running PTY is currently bound to this worktree. Filled by
  // WorktreeManager.list/get (not persisted) so the renderer can disable
  // merge/abort/cleanup without guessing terminal state.
  hasRunningTerminal: z.boolean().default(false),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  closedAt: z.string().datetime().nullable().default(null),
});

export type Worktree = z.infer<typeof worktreeSchema>;

export const worktreeCreateInputSchema = z.object({
  projectId: idSchema,
  // Branch name; runtime-validated by WorktreeManager (git ref rules). The
  // default UI prefix is `codex/` but callers may pass any valid ref.
  branch: z.string().min(1).max(200).optional(),
  baseRef: z.string().min(1).max(200).optional(),
  permissionsPreset: worktreePermissionsPresetSchema.optional(),
}).strict();

export type WorktreeCreateInput = z.infer<typeof worktreeCreateInputSchema>;

export const worktreeListInputSchema = z.object({
  projectId: idSchema,
}).strict();

export const worktreeIdInputSchema = z.object({
  worktreeId: idSchema,
}).strict();

export const worktreeMergeInputSchema = z.object({
  worktreeId: idSchema,
  // Explicit confirmation token: caller must have reviewed the diff summary
  // before merging. The WorktreeManager returns a diff summary first; merge
  // only proceeds when this flag is true.
  confirm: z.boolean(),
}).strict();

export const worktreeBindSessionInputSchema = z.object({
  worktreeId: idSchema,
  terminalId: idSchema,
  nativeSessionId: z.string().min(1).max(120),
  // The agent profile that owns this session (allowlisted at resume time).
  agentProfile: z.string().min(1).max(80),
}).strict();

export const worktreeResumeInputSchema = z.object({
  worktreeId: idSchema,
  // Resume is only returned for a live terminal already bound to this exact
  // worktree/cwd. This prevents callers from writing the rebuilt command into
  // an unrelated project terminal.
  terminalId: idSchema,
}).strict();

// --- B — Checkpoint / diff / undo-redo rail ---------------------------------
// A checkpoint is a restorable snapshot of a workspace taken before (pre) and
// after (post) an app conversation turn, or explicitly for a worktree/PTY.
// Git workspaces use a pinned ref (worktree branch commit or a dangling stash
// object) — the working tree/index is NEVER mutated to build a checkpoint.
// Non-Git workspaces use a bounded file snapshot under userData/checkpoints.
//
// Restore is preview-first: createCheckpoint returns a previewToken; restore
// requires confirm:true + that exact token + a matching workspaceFingerprint,
// refusing stale previews and dirty drift so a changed workspace is never
// silently overwritten. Hunk restore identifies a backend-recomputed hunk by
// file path + index; callers never supply executable patch text.
export const checkpointPhaseSchema = z.enum(["pre", "post"]);
export type CheckpointPhase = z.infer<typeof checkpointPhaseSchema>;

export const checkpointKindSchema = z.enum([
  "worktree-commit", // git worktree sandbox: commit on the isolated branch
  "git-stash", // git non-worktree: pinned dangling stash object (no WT mutation)
  "file-snapshot", // non-git: bounded file copy under userData
]);
export type CheckpointKind = z.infer<typeof checkpointKindSchema>;

export const checkpointStatusSchema = z.enum([
  "active", // restorable
  "failed", // snapshot could not be built; turn still proceeds with a warning
  "restored", // a restore was applied from this checkpoint
  "superseded", // a later restore made this one non-current for its turn
]);
export type CheckpointStatus = z.infer<typeof checkpointStatusSchema>;

export const checkpointSchema = z.object({
  id: idSchema,
  turnId: idSchema.nullable(),
  conversationId: idSchema.nullable(),
  projectId: idSchema,
  worktreeId: idSchema.nullable(),
  phase: checkpointPhaseSchema,
  kind: checkpointKindSchema,
  status: checkpointStatusSchema,
  // Git ref (branch/commit/stash object id) for git kinds; null for file-snapshot.
  ref: z.string().nullable().default(null),
  // Snapshot directory under userData/checkpoints. Required for non-Git; Git
  // checkpoints may also use it for bounded untracked-file capture.
  snapshotPath: z.string().nullable().default(null),
  // Workspace fingerprint at snapshot time (git: HEAD sha + porcelain hash;
  // non-git: file count + total bytes). Restore refuses on drift.
  workspaceFingerprint: z.string().nullable().default(null),
  fileCount: z.number().int().nonnegative().default(0),
  sizeBytes: z.number().int().nonnegative().default(0),
  // True when the snapshot hit a cap (file/size/count) and is partial.
  partial: z.boolean().default(false),
  createdAt: z.string().datetime(),
  finalizedAt: z.string().datetime().nullable().default(null),
});

export type Checkpoint = z.infer<typeof checkpointSchema>;

// One changed file in a checkpoint diff. binary/oversize files carry metadata
// only (no diff body). path is workspace-relative.
export const checkpointFileChangeSchema = z.object({
  path: z.string().min(1),
  status: z.enum(["added", "modified", "deleted", "renamed"]),
  // For renamed: the previous path.
  oldPath: z.string().nullable().default(null),
  additions: z.number().int().nonnegative().default(0),
  deletions: z.number().int().nonnegative().default(0),
  binary: z.boolean().default(false),
  oversize: z.boolean().default(false),
  // Unified diff body (capped). Null for binary/oversize/renamed-without-body.
  diff: z.string().nullable().default(null),
});

export type CheckpointFileChange = z.infer<typeof checkpointFileChangeSchema>;

export const checkpointDiffSchema = z.object({
  checkpointId: idSchema,
  // "pre..post" within a turn, or "checkpoint..working" for a live diff.
  base: z.enum(["pre", "working", "ref"]),
  stat: z.string(),
  files: z.array(checkpointFileChangeSchema),
  truncated: z.boolean().default(false),
});

export type CheckpointDiff = z.infer<typeof checkpointDiffSchema>;

export const checkpointListInputSchema = z.object({
  conversationId: idSchema.nullable().optional(),
  projectId: idSchema.optional(),
  worktreeId: idSchema.nullable().optional(),
}).strict();

export type CheckpointListInput = z.infer<typeof checkpointListInputSchema>;

export const checkpointIdInputSchema = z.object({
  checkpointId: idSchema,
}).strict();

export type CheckpointIdInput = z.infer<typeof checkpointIdInputSchema>;

export const checkpointDiffInputSchema = z.object({
  checkpointId: idSchema,
  base: z.enum(["pre", "working"]).default("working"),
}).strict();

export type CheckpointDiffInput = z.infer<typeof checkpointDiffInputSchema>;

// Preview-first restore: the caller first calls restorePreview to get a token
// + current fingerprint, then restoreCheckpoint with confirm:true + that token.
// The manager refuses if the workspace has drifted since the preview.
export const checkpointRestorePreviewInputSchema = z.object({
  checkpointId: idSchema,
}).strict();

export const checkpointRestorePreviewSchema = z.object({
  checkpointId: idSchema,
  previewToken: z.string().min(1),
  workspaceFingerprint: z.string().nullable(),
  // Files that will be overwritten/restored (metadata only, no content).
  affectedFiles: z.array(z.string()),
  driftDetected: z.boolean(),
});

export type CheckpointRestorePreview = z.infer<typeof checkpointRestorePreviewSchema>;

export const checkpointRestoreInputSchema = z.object({
  checkpointId: idSchema,
  confirm: z.boolean(),
  previewToken: z.string().min(1),
}).strict();

export type CheckpointRestoreInput = z.infer<typeof checkpointRestoreInputSchema>;

export const checkpointHunkRestoreInputSchema = z.object({
  checkpointId: idSchema,
  filePath: z.string().min(1).max(1_024),
  hunkIndex: z.number().int().nonnegative(),
  confirm: z.boolean(),
  previewToken: z.string().min(1),
}).strict();

export type CheckpointHunkRestoreInput = z.infer<typeof checkpointHunkRestoreInputSchema>;

export const checkpointRestoreRecordSchema = z.object({
  id: idSchema,
  checkpointId: idSchema,
  turnId: idSchema.nullable(),
  conversationId: idSchema.nullable(),
  projectId: idSchema,
  worktreeId: idSchema.nullable(),
  status: z.enum(["applied", "refused", "failed"]),
  reason: z.string().nullable().default(null),
  createdAt: z.string().datetime(),
});

export type CheckpointRestoreRecord = z.infer<typeof checkpointRestoreRecordSchema>;

// Undo/redo operate over a conversation's checkpoint chain. undo restores the
// pre-checkpoint of turn N; redo re-applies the post-checkpoint of turn N.
// Both are whole-checkpoint restores under the same preview-first contract.
export const checkpointUndoInputSchema = z.object({
  conversationId: idSchema,
  confirm: z.boolean(),
  previewToken: z.string().min(1),
}).strict();

export type CheckpointUndoInput = z.infer<typeof checkpointUndoInputSchema>;

// Explicit checkpoint for a worktree/PTY (not tied to a RunCoordinator turn).
// caller must supply projectId + worktreeId; the manager validates the worktree
// is active and its path matches.
export const checkpointCreateExplicitInputSchema = z.object({
  projectId: idSchema,
  worktreeId: idSchema.nullable().optional(),
  phase: checkpointPhaseSchema.default("pre"),
}).strict();

export type CheckpointCreateExplicitInput = z.infer<typeof checkpointCreateExplicitInputSchema>;
