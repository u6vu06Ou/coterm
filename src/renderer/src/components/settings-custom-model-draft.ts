import { customProfilesSchema, type CustomProfileEntry } from "@shared/schema";
import type { MessageKey } from "../i18n";

// Hot model registry (stage 3): pure draft/validation/payload logic for the
// "custom models" settings block. The component only renders — every rule
// below defers to the shared zod schema, so the form can never accept a
// payload the backend settings patch would reject.
//
// Secret handling: a stored authToken never enters the draft. Editing an
// existing entry shows "已設定" (token preset) instead of the value; an
// untouched password box keeps the persisted token when the payload is
// assembled from the profiles context — the value only ever travels from
// settings straight back into the next settings patch.

export type CustomModelHarness = "claude" | "codex";

export type CustomModelDraftField =
  | "harness"
  | "id"
  | "label"
  | "model"
  | "baseUrl"
  | "authToken"
  | "local"
  | "contextWindow"
  | "reasoningEffort"
  | "env";

export interface CustomModelEnvPair {
  key: string;
  value: string;
}

export interface CustomModelDraft {
  harness: CustomModelHarness;
  /** full id as shown to the user (includes the codex- prefix when codex) */
  id: string;
  label: string;
  model: string;
  baseUrl: string;
  /** plaintext only while the user is typing a NEW token; never pre-filled */
  authToken: string;
  local: boolean;
  /** number-as-string so the input stays simple; parsed at payload time */
  contextWindow: string;
  reasoningEffort: "" | "low" | "high" | "max";
  env: CustomModelEnvPair[];
}

export type CustomModelDraftErrors = Partial<Record<CustomModelDraftField, MessageKey>>;

export interface CustomModelValidationContext {
  /** persisted entries (id → entry); also the token source of truth */
  profiles: Readonly<Record<string, CustomProfileEntry>>;
  /** full id being edited; null when the form is creating a new entry */
  editingId: string | null;
}

export type CustomModelValidation =
  | { ok: true; id: string; entry: CustomProfileEntry }
  | { ok: false; errors: CustomModelDraftErrors };

const FIELD_ERROR_KEYS: Record<string, MessageKey> = {
  label: "settings.customModel.draft.error.label",
  model: "settings.customModel.draft.error.model",
  baseUrl: "settings.customModel.draft.error.baseUrl",
  authToken: "settings.customModel.draft.error.authToken",
  contextWindow: "settings.customModel.draft.error.contextWindow",
  reasoningEffort: "settings.customModel.draft.error.reasoningEffort",
  env: "settings.customModel.draft.error.env",
};

export const EMPTY_CUSTOM_MODEL_DRAFT: CustomModelDraft = {
  harness: "claude",
  id: "",
  label: "",
  model: "",
  baseUrl: "",
  authToken: "",
  local: true,
  contextWindow: "",
  reasoningEffort: "",
  env: [],
};

/** Backend dispatch rule: `codex-*` ids run on the codex harness, the rest on claude. */
export function harnessFromId(id: string): CustomModelHarness {
  return id.startsWith("codex-") ? "codex" : "claude";
}

/**
 * Keep the visible id consistent with the chosen harness so users never have
 * to memorize the prefix rule: codex adds the `codex-` prefix, claude strips it
 * (a claude-form id carrying the prefix would dispatch to codex anyway).
 */
export function applyHarnessPrefix(harness: CustomModelHarness, id: string): string {
  if (harness === "codex") return id.startsWith("codex-") ? id : `codex-${id}`;
  return id.startsWith("codex-") ? id.slice("codex-".length) : id;
}

/** Stored entry → editable draft. The stored token is dropped on purpose. */
export function draftFromEntry(id: string, entry: CustomProfileEntry): CustomModelDraft {
  return {
    harness: harnessFromId(id),
    id,
    label: entry.label ?? "",
    model: entry.model ?? "",
    baseUrl: entry.baseUrl ?? "",
    authToken: "",
    local: entry.local,
    contextWindow: entry.contextWindow !== undefined ? String(entry.contextWindow) : "",
    reasoningEffort: entry.reasoningEffort ?? "",
    env: Object.entries(entry.env ?? {}).map(([key, value]) => ({ key, value })),
  };
}

/** The persisted entry behind the form (token source) — undefined for new ids. */
function existingEntryFor(ctx: CustomModelValidationContext, currentId: string): CustomProfileEntry | undefined {
  if (ctx.editingId !== null && ctx.editingId === currentId) return ctx.profiles[ctx.editingId];
  return undefined;
}

function buildPayload(
  draft: CustomModelDraft,
  existing: CustomProfileEntry | undefined,
): CustomProfileEntry {
  const text = (value: string): string | undefined => {
    const trimmed = value.trim();
    return trimmed === "" ? undefined : trimmed;
  };
  const contextWindowRaw = draft.contextWindow.trim();
  const env: Record<string, string> = {};
  for (const pair of draft.env) {
    const key = pair.key.trim();
    if (key !== "") env[key] = pair.value;
  }
  const typedToken = draft.authToken.trim();
  return {
    local: draft.local,
    label: text(draft.label),
    model: text(draft.model),
    baseUrl: text(draft.baseUrl),
    // Untouched password box keeps the persisted token (never re-rendered).
    authToken: typedToken !== "" ? typedToken : existing?.authToken,
    // NaN passes through deliberately — zod rejects it as a field error.
    contextWindow: contextWindowRaw === "" ? undefined : Number(contextWindowRaw),
    reasoningEffort: draft.reasoningEffort === "" ? undefined : draft.reasoningEffort,
    env,
  };
}

/**
 * Validate the draft against the shared customProfilesSchema (single source
 * of truth — no parallel rule set here) and return the submittable payload.
 * Token guarantee: the returned entry only carries the persisted token the
 * settings already hold, or the one the user just typed; error objects never
 * contain either.
 */
export function validateCustomModelDraft(
  draft: CustomModelDraft,
  ctx: CustomModelValidationContext,
): CustomModelValidation {
  const rawId = draft.id.trim();
  if (rawId === "") {
    return { ok: false, errors: { id: "settings.customModel.draft.error.idRequired" } };
  }
  const id = applyHarnessPrefix(draft.harness, rawId);
  const entry = buildPayload(draft, existingEntryFor(ctx, id));
  const errors: CustomModelDraftErrors = {};

  const parsed = customProfilesSchema.safeParse({ [id]: entry });
  if (parsed.success) {
    if (ctx.editingId !== id && ctx.profiles[id] !== undefined) {
      return { ok: false, errors: { id: "settings.customModel.draft.error.idTaken" } };
    }
    return { ok: true, id, entry };
  }

  for (const issue of parsed.error.issues) {
    const path = issue.path.map(String);
    // The record-level refine only exists for reserved ids.
    if (path.length === 0) {
      errors.id ??= "settings.customModel.draft.error.idReserved";
      continue;
    }
    if (issue.code === "invalid_key" && path.length === 1) {
      errors.id ??= "settings.customModel.draft.error.idFormat";
      continue;
    }
    const field = path[1] ?? "";
    if (path.length >= 3 && field === "env") {
      errors.env ??= "settings.customModel.draft.error.env";
      continue;
    }
    const errorKey = FIELD_ERROR_KEYS[field];
    if (errorKey !== undefined) {
      (errors as Record<string, MessageKey>)[field] ??= errorKey;
    }
  }
  if (errors.id === undefined && ctx.editingId !== id && ctx.profiles[id] !== undefined) {
    errors.id = "settings.customModel.draft.error.idTaken";
  }
  return { ok: false, errors };
}

/** Whole-record replacement for the settings patch (one field = one patch). */
export function upsertCustomProfile(
  current: Readonly<Record<string, CustomProfileEntry>>,
  id: string,
  entry: CustomProfileEntry,
  previousId: string | null,
): Record<string, CustomProfileEntry> {
  const next: Record<string, CustomProfileEntry> = {};
  for (const [key, value] of Object.entries(current)) {
    if (previousId !== null && key === previousId) continue;
    next[key] = value;
  }
  next[id] = entry;
  return next;
}

export function removeCustomProfile(
  current: Readonly<Record<string, CustomProfileEntry>>,
  id: string,
): Record<string, CustomProfileEntry> {
  const next: Record<string, CustomProfileEntry> = {};
  for (const [key, value] of Object.entries(current)) {
    if (key === id) continue;
    next[key] = value;
  }
  return next;
}
