import type { AppSettings, AppSettingsPatch } from "@shared/types";
import type { MessageKey } from "../i18n";

// #60 Bug A: draft/commit separation for the three STT fields. Typing only
// mutates the local draft -- no IPC, no global toast. Commit happens on blur /
// Enter / explicit clear; cancel (Escape) restores the last persisted value.
export type SttDraftField = "sttUrl" | "sttModel" | "sttApiKey";

export const STT_DRAFT_FIELDS: readonly SttDraftField[] = ["sttUrl", "sttModel", "sttApiKey"];

type VoiceSettings = AppSettings["voice"];
type VoicePatch = NonNullable<AppSettingsPatch["voice"]>;

export interface SttDraftSnapshot {
  values: Record<SttDraftField, string>;
  errors: Partial<Record<SttDraftField, MessageKey>>;
  saved: Partial<Record<SttDraftField, boolean>>;
}

export type SttFieldValidation =
  | { ok: true; value: string }
  | { ok: false; errorKey: MessageKey };

// Control chars and zero-width invisible chars never belong in a URL, model
// id, or API key; they arrive via copy-paste and silently break the endpoint.
// eslint-disable-next-line no-control-regex
const FORBIDDEN_CHARS = /[\u0000-\u001F\u007F\u200B-\u200D\u2060\uFEFF]/u;

export function validateSttDraftField(field: SttDraftField, raw: string): SttFieldValidation {
  const value = raw.trim();
  if (FORBIDDEN_CHARS.test(value)) return { ok: false, errorKey: "settings.voice.draft.error.forbiddenChars" };
  if (field === "sttUrl") {
    if (value !== "" && !/^https?:\/\//i.test(value)) {
      return { ok: false, errorKey: "settings.voice.draft.error.urlScheme" };
    }
    return { ok: true, value };
  }
  if (field === "sttModel") {
    if (value === "") return { ok: false, errorKey: "settings.voice.draft.error.modelRequired" };
    if (value.length > 200) return { ok: false, errorKey: "settings.voice.draft.error.tooLong" };
    return { ok: true, value };
  }
  if (value.length > 500) return { ok: false, errorKey: "settings.voice.draft.error.tooLong" };
  return { ok: true, value };
}

export class SttDraftController {
  private persisted: VoiceSettings;
  private values: Record<SttDraftField, string>;
  private errors: Partial<Record<SttDraftField, MessageKey>> = {};
  private saved: Partial<Record<SttDraftField, boolean>> = {};
  private readonly dirty = new Set<SttDraftField>();

  constructor(
    persisted: VoiceSettings,
    private readonly commitPatch: (patch: VoicePatch) => Promise<void>,
    private readonly notify: (snapshot: SttDraftSnapshot) => void,
  ) {
    this.persisted = persisted;
    this.values = {
      sttUrl: persisted.sttUrl ?? "",
      sttModel: persisted.sttModel ?? "",
      sttApiKey: persisted.sttApiKey ?? "",
    };
  }

  snapshot(): SttDraftSnapshot {
    return { values: { ...this.values }, errors: { ...this.errors }, saved: { ...this.saved } };
  }

  change(field: SttDraftField, value: string): void {
    this.values[field] = value;
    delete this.errors[field];
    delete this.saved[field];
    this.dirty.add(field);
    this.notify(this.snapshot());
  }

  cancel(field: SttDraftField): void {
    this.values[field] = this.persisted[field] ?? "";
    delete this.errors[field];
    delete this.saved[field];
    this.dirty.delete(field);
    this.notify(this.snapshot());
  }

  // Returns true when the value is persisted (or already matched). Invalid or
  // failed commits keep the draft untouched and surface an inline error key.
  async commit(field: SttDraftField): Promise<boolean> {
    const validation = validateSttDraftField(field, this.values[field]);
    if (!validation.ok) {
      this.errors[field] = validation.errorKey;
      delete this.saved[field];
      this.notify(this.snapshot());
      return false;
    }
    if (!this.dirty.has(field) && validation.value === (this.persisted[field] ?? "")) {
      this.notify(this.snapshot());
      return true;
    }
    try {
      await this.commitPatch({ [field]: validation.value });
    } catch {
      this.errors[field] = "settings.voice.draft.error.persist";
      delete this.saved[field];
      this.notify(this.snapshot());
      return false;
    }
    const persisted: Record<string, unknown> = { ...this.persisted };
    persisted[field] = validation.value;
    this.persisted = persisted as VoiceSettings;
    this.values[field] = validation.value;
    delete this.errors[field];
    this.saved[field] = true;
    this.dirty.delete(field);
    this.notify(this.snapshot());
    return true;
  }

  // External settings refresh (another client, load, etc.). Dirty fields are
  // user edits in progress and win over the incoming state.
  syncFromPersisted(persisted: VoiceSettings): void {
    this.persisted = persisted;
    for (const field of STT_DRAFT_FIELDS) {
      if (!this.dirty.has(field)) this.values[field] = persisted[field] ?? "";
    }
    this.notify(this.snapshot());
  }
}
