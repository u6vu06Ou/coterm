import { describe, expect, it } from "vitest";
import type { CustomProfileEntry } from "../../src/shared/schema";
import {
  EMPTY_CUSTOM_MODEL_DRAFT,
  applyHarnessPrefix,
  draftFromEntry,
  harnessFromId,
  removeCustomProfile,
  upsertCustomProfile,
  validateCustomModelDraft,
  type CustomModelDraft,
} from "../../src/renderer/src/components/settings-custom-model-draft";

// Hot model registry (stage 3): the settings-panel form's pure logic. The
// schema (shared/schema.ts customProfilesSchema) is the single validation
// authority — these tests pin the draft/preview/payload contracts the UI
// relies on, including the token-masking guarantee.

/** Not sk- prefixed on purpose — see the stage 2 redaction precedent. */
const STORED_TOKEN = "opaque-token-Zx91QvLm7g2k";

function draft(overrides: Partial<CustomModelDraft> = {}): CustomModelDraft {
  return { ...EMPTY_CUSTOM_MODEL_DRAFT, env: [], ...overrides };
}

describe("custom model form (stage 3)", () => {
  describe("harness derivation and prefix", () => {
    it("derives the harness from the id (codex- prefix → codex, rest → claude)", () => {
      expect(harnessFromId("codex-myx")).toBe("codex");
      expect(harnessFromId("codex-official")).toBe("codex");
      expect(harnessFromId("claude-local-main")).toBe("claude");
      expect(harnessFromId("my-model")).toBe("claude");
    });

    it("(e) draftFromEntry recovers the harness from a stored id", () => {
      expect(draftFromEntry("codex-myx", { local: true, env: {} }).harness).toBe("codex");
      expect(
        draftFromEntry("claude-openroute", { local: true, env: {} }).harness,
      ).toBe("claude");
    });

    it("(b) applyHarnessPrefix adds codex- for codex and strips it for claude", () => {
      expect(applyHarnessPrefix("codex", "myx")).toBe("codex-myx");
      expect(applyHarnessPrefix("codex", "codex-already")).toBe("codex-already");
      expect(applyHarnessPrefix("claude", "codex-myx")).toBe("myx");
      expect(applyHarnessPrefix("claude", "myx")).toBe("myx");
    });
  });

  describe("payload assembly", () => {
    it("(a) a claude form produces an unprefixed id and the right payload shape", () => {
      const result = validateCustomModelDraft(
        draft({ id: "my-claude", label: "My Model", model: "test-model-x" }),
        { profiles: {}, editingId: null },
      );
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.id).toBe("my-claude");
      // Optional empty fields drop out of the payload; env is always present.
      expect(result.entry).toEqual({ local: true, label: "My Model", model: "test-model-x", env: {} });
    });

    it("(b) a codex form auto-prefixes the id and maps the codex knobs", () => {
      const result = validateCustomModelDraft(
        draft({
          harness: "codex",
          id: "myx",
          label: "My Codex Model",
          baseUrl: "https://openrouter.example/api",
          authToken: "sk-or-v1-abc",
          contextWindow: "400000",
          reasoningEffort: "high",
          env: [{ key: "MYX_API_KEY", value: "env-token" }],
        }),
        { profiles: {}, editingId: null },
      );
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.id).toBe("codex-myx");
      expect(result.entry).toEqual({
        local: true,
        label: "My Codex Model",
        baseUrl: "https://openrouter.example/api",
        authToken: "sk-or-v1-abc",
        contextWindow: 400000,
        reasoningEffort: "high",
        env: { MYX_API_KEY: "env-token" },
      });
    });

    it("trims env keys and skips blank key rows", () => {
      const result = validateCustomModelDraft(
        draft({
          id: "my-claude",
          env: [
            { key: "  A_KEY  ", value: "v" },
            { key: "   ", value: "ignored" },
          ],
        }),
        { profiles: {}, editingId: null },
      );
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.entry.env).toEqual({ A_KEY: "v" });
    });
  });

  describe("validation errors (zod-mapped)", () => {
    it("(c) a reserved id is rejected with the reserved reason", () => {
      const result = validateCustomModelDraft(draft({ id: "claude-official" }), { profiles: {}, editingId: null });
      expect(result).toEqual({
        ok: false,
        errors: { id: "settings.customModel.draft.error.idReserved" },
      });
    });

    it("(c) a malformed id is rejected with the format reason", () => {
      const result = validateCustomModelDraft(draft({ id: "Bad_Id!" }), { profiles: {}, editingId: null });
      expect(result).toMatchObject({ ok: false, errors: { id: "settings.customModel.draft.error.idFormat" } });
    });

    it("(c) an empty id is rejected before the prefix can mask it", () => {
      // "codex-" alone satisfies the id regex, so the required check must see
      // the raw id, not the prefixed one.
      const result = validateCustomModelDraft(draft({ harness: "codex", id: "" }), { profiles: {}, editingId: null });
      expect(result).toEqual({
        ok: false,
        errors: { id: "settings.customModel.draft.error.idRequired" },
      });
    });

    it("(c) a non-positive-integer context window is rejected on that field", () => {
      for (const bad of ["0", "-3", "1.5", "abc"]) {
        const result = validateCustomModelDraft(draft({ id: "my-claude", contextWindow: bad }), { profiles: {}, editingId: null });
        expect(result).toMatchObject({ ok: false, errors: { contextWindow: "settings.customModel.draft.error.contextWindow" } });
      }
    });

    it("(c) a malformed baseUrl is rejected on that field", () => {
      const result = validateCustomModelDraft(draft({ id: "my-claude", baseUrl: "notaurl" }), { profiles: {}, editingId: null });
      expect(result).toMatchObject({ ok: false, errors: { baseUrl: "settings.customModel.draft.error.baseUrl" } });
    });

    it("an over-long label and an over-long token map to their fields", () => {
      const longLabel = "x".repeat(81);
      const longToken = "y".repeat(501);
      const result = validateCustomModelDraft(draft({ id: "my-claude", label: longLabel, authToken: longToken }), { profiles: {}, editingId: null });
      expect(result).toMatchObject({
        ok: false,
        errors: {
          label: "settings.customModel.draft.error.label",
          authToken: "settings.customModel.draft.error.authToken",
        },
      });
    });

    it("rejects a duplicate id unless it is the entry being edited", () => {
      const profiles: Record<string, CustomProfileEntry> = {
        "claude-taken": { local: true, env: {} },
      };
      const duplicate = validateCustomModelDraft(draft({ id: "claude-taken" }), { profiles, editingId: null });
      expect(duplicate).toEqual({ ok: false, errors: { id: "settings.customModel.draft.error.idTaken" } });

      const editingSelf = validateCustomModelDraft(draft({ id: "claude-taken" }), { profiles, editingId: "claude-taken" });
      expect(editingSelf.ok).toBe(true);

      const movingToTaken = validateCustomModelDraft(draft({ id: "claude-taken" }), {
        profiles,
        editingId: "claude-other",
      });
      expect(movingToTaken).toEqual({ ok: false, errors: { id: "settings.customModel.draft.error.idTaken" } });
    });
  });

  describe("token masking", () => {
    const stored: Record<string, CustomProfileEntry> = {
      "claude-openroute": {
        local: true,
        env: {},
        baseUrl: "https://openrouter.example/api",
        authToken: STORED_TOKEN,
      },
    };

    it("(d) draftFromEntry never carries the stored token in clear text", () => {
      const storedEntry = stored["claude-openroute"];
      if (!storedEntry) throw new Error("fixture entry missing");
      const draftState = draftFromEntry("claude-openroute", storedEntry);
      expect(draftState.authToken).toBe("");
      // Belt and braces: the whole draft (values, keys, nesting) — not just the
      // authToken field — must be free of the secret.
      expect(JSON.stringify(draftState)).not.toContain(STORED_TOKEN);
    });

    it("(d) validation error objects never contain the token string", () => {
      // Force a field error on an entry that HAS a stored token.
      const result = validateCustomModelDraft(
        draft({ id: "claude-openroute", baseUrl: "still-not-a-url" }),
        { profiles: stored, editingId: "claude-openroute" },
      );
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(JSON.stringify(result.errors)).not.toContain(STORED_TOKEN);
    });

    it("an untouched password box preserves the persisted token in the payload", () => {
      const result = validateCustomModelDraft(
        draft({ id: "claude-openroute", baseUrl: "https://openrouter.example/api", authToken: "" }),
        { profiles: stored, editingId: "claude-openroute" },
      );
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.entry.authToken).toBe(STORED_TOKEN);
    });

    it("a newly typed token replaces, never merges with, the persisted one", () => {
      const result = validateCustomModelDraft(
        draft({ id: "claude-openroute", authToken: "fresh-token-123" }),
        { profiles: stored, editingId: "claude-openroute" },
      );
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.entry.authToken).toBe("fresh-token-123");
    });
  });

  describe("settings patch assembly", () => {
    const current: Record<string, CustomProfileEntry> = {
      "claude-a": { local: true, env: {} },
      "codex-b": { local: false, env: {} },
    };

    it("upsert adds a new entry without touching the others", () => {
      const next = upsertCustomProfile(current, "claude-new", { local: true, env: {} }, null);
      expect(Object.keys(next)).toEqual(["claude-a", "codex-b", "claude-new"]);
      expect(next["claude-a"]).toEqual({ local: true, env: {} });
    });

    it("upsert with a previousId renames (old key removed, new key added)", () => {
      const next = upsertCustomProfile(current, "codex-renamed", { local: false, env: {} }, "codex-b");
      expect(Object.keys(next)).toEqual(["claude-a", "codex-renamed"]);
    });

    it("remove drops only the targeted entry", () => {
      const next = removeCustomProfile(current, "codex-b");
      expect(Object.keys(next)).toEqual(["claude-a"]);
    });
  });
});
