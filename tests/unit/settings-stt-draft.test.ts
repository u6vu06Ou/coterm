import { describe, expect, it } from "vitest";
import { appSettingsSchema } from "../../src/shared/schema";
import {
  SttDraftController,
  validateSttDraftField,
  type SttDraftSnapshot,
} from "../../src/renderer/src/components/settings-stt-draft";

const persistedVoice = appSettingsSchema.parse({
  voice: {
    enabled: true,
    lang: "zh-TW",
    sttUrl: "http://127.0.0.1:8765/v1/audio/transcriptions",
    sttModel: "whisper-large-v3",
    sttApiKey: "unit-test-placeholder-stt-key",
  },
}).voice;

interface Harness {
  ctl: SttDraftController;
  commits: Array<Record<string, string>>;
  snapshots: SttDraftSnapshot[];
}

function harness(commitImpl?: () => Promise<void>): Harness {
  const commits: Array<Record<string, string>> = [];
  const snapshots: SttDraftSnapshot[] = [];
  const ctl = new SttDraftController(
    persistedVoice,
    async (patch) => {
      if (commitImpl) await commitImpl();
      commits.push(patch as Record<string, string>);
    },
    (snapshot) => snapshots.push(snapshot),
  );
  return { ctl, commits, snapshots };
}

describe("stt draft/commit UX (#60)", () => {
  it("typing sttUrl character by character never hits IPC", () => {
    const { ctl, commits } = harness();
    for (const fragment of ["h", "ht", "http", "http:", "http://1", "http://127.0.0.1:9000"]) {
      ctl.change("sttUrl", fragment);
    }
    expect(commits).toHaveLength(0);
  });

  it("commit on an intermediate invalid URL shows an inline error and keeps the draft", async () => {
    const { ctl, commits, snapshots } = harness();
    ctl.change("sttUrl", "http://localh");
    // mid-typing value that fails scheme validation after trim+paste glitch
    ctl.change("sttUrl", "htp://broken");
    await expect(ctl.commit("sttUrl")).resolves.toBe(false);
    expect(commits).toHaveLength(0);
    const last = snapshots.at(-1);
    expect(last?.values.sttUrl).toBe("htp://broken");
    expect(last?.errors.sttUrl).toBe("settings.voice.draft.error.urlScheme");
  });

  it("pasting a value with zero-width characters is rejected inline", async () => {
    const { ctl, commits, snapshots } = harness();
    ctl.change("sttUrl", "http://127.0.0.1:9000\u200B/v1");
    await expect(ctl.commit("sttUrl")).resolves.toBe(false);
    expect(commits).toHaveLength(0);
    expect(snapshots.at(-1)?.errors.sttUrl).toBe("settings.voice.draft.error.forbiddenChars");
    expect(snapshots.at(-1)?.values.sttUrl).toContain("9000");
  });

  it("valid commit trims and persists exactly once", async () => {
    const { ctl, commits, snapshots } = harness();
    ctl.change("sttModel", "  whisper-large-v3-turbo  ");
    await expect(ctl.commit("sttModel")).resolves.toBe(true);
    expect(commits).toEqual([{ sttModel: "whisper-large-v3-turbo" }]);
    expect(snapshots.at(-1)?.saved.sttModel).toBe(true);
    expect(snapshots.at(-1)?.errors.sttModel).toBeUndefined();
  });

  it("blank model is rejected; empty url and key remain valid explicit clears", () => {
    expect(validateSttDraftField("sttModel", "   ")).toEqual({
      ok: false,
      errorKey: "settings.voice.draft.error.modelRequired",
    });
    expect(validateSttDraftField("sttUrl", "")).toEqual({ ok: true, value: "" });
    expect(validateSttDraftField("sttApiKey", "")).toEqual({ ok: true, value: "" });
  });

  it("explicit empty key commit is the only clear path for sttApiKey", async () => {
    const { ctl, commits } = harness();
    ctl.change("sttApiKey", "");
    await expect(ctl.commit("sttApiKey")).resolves.toBe(true);
    expect(commits).toEqual([{ sttApiKey: "" }]);
  });

  it("escape cancels back to the last persisted value", () => {
    const { ctl, snapshots } = harness();
    ctl.change("sttUrl", "http://changed.example/v1");
    ctl.cancel("sttUrl");
    expect(snapshots.at(-1)?.values.sttUrl).toBe(persistedVoice.sttUrl);
  });

  it("failed persist keeps the draft and flags a recoverable inline error", async () => {
    const { ctl, commits, snapshots } = harness(async () => {
      throw new Error("disk full");
    });
    ctl.change("sttApiKey", "edited-but-not-saved");
    await expect(ctl.commit("sttApiKey")).resolves.toBe(false);
    expect(commits).toHaveLength(0);
    const last = snapshots.at(-1);
    expect(last?.values.sttApiKey).toBe("edited-but-not-saved");
    expect(last?.errors.sttApiKey).toBe("settings.voice.draft.error.persist");
  });

  it("external sync updates clean fields but never overwrites a dirty draft", () => {
    const { ctl, commits } = harness();
    ctl.change("sttUrl", "http://local-editing:1/v1");
    ctl.syncFromPersisted({ ...persistedVoice, sttUrl: "http://from-elsewhere:2/v1", sttModel: "new-model" });
    expect(ctl.snapshot().values.sttUrl).toBe("http://local-editing:1/v1");
    expect(ctl.snapshot().values.sttModel).toBe("new-model");
    expect(commits).toHaveLength(0);
  });

  it("committing an unchanged field does not persist again", async () => {
    const { ctl, commits } = harness();
    await expect(ctl.commit("sttUrl")).resolves.toBe(true);
    expect(commits).toHaveLength(0);
  });

  it("committing a different field never clears a saved key", async () => {
    const { ctl, commits } = harness();
    ctl.change("sttModel", "other-model");
    await expect(ctl.commit("sttModel")).resolves.toBe(true);
    expect(commits).toEqual([{ sttModel: "other-model" }]);
    expect(ctl.snapshot().values.sttApiKey).toBe(persistedVoice.sttApiKey);
  });
});
