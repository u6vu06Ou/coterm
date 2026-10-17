import { describe, expect, it } from "vitest";
import { appSettingsPatchSchema, appSettingsSchema } from "../../src/shared/schema";
import { mergeAppSettingsPatch } from "../../src/shared/settings-patch";

const base = appSettingsSchema.parse({
  voice: {
    enabled: true,
    lang: "zh-TW",
    sttUrl: "http://127.0.0.1:8765/v1/audio/transcriptions",
    sttModel: "whisper-large-v3",
    sttApiKey: "unit-test-placeholder-stt-key",
  },
  browserNetwork: { mode: "allow-hosts", allowHosts: ["127.0.0.1:43127"] },
  defaultWorkspacePath: "D:\\workspace",
});

describe("appSettingsPatchSchema (#60)", () => {
  it("has no default side effects: absent fields stay absent", () => {
    expect(appSettingsPatchSchema.parse({})).toEqual({});
    expect(appSettingsPatchSchema.parse({ theme: "light" })).toEqual({ theme: "light" });
    const voice = appSettingsPatchSchema.parse({ voice: { lang: "en-US" } });
    expect(voice.voice).toEqual({ lang: "en-US" });
    expect(voice.voice).not.toHaveProperty("sttUrl");
    expect(voice.voice).not.toHaveProperty("sttApiKey");
  });

  it("accepts a full AppSettings payload as a valid patch (old client compat)", () => {
    const parsed = appSettingsPatchSchema.parse(base);
    expect(parsed.voice?.sttModel).toBe("whisper-large-v3");
  });

  it("rejects invalid patches without touching stored settings", () => {
    expect(() => appSettingsPatchSchema.parse({ voice: { sttUrl: "file:///tmp/x" } })).toThrow();
    expect(() => appSettingsPatchSchema.parse({ terminalFontSize: 99 })).toThrow();
    expect(() => appSettingsPatchSchema.parse({ voice: { sttModel: " " } })).toThrow();
    expect(() => appSettingsPatchSchema.parse({ telemetry: true })).toThrow();
  });
});

describe("mergeAppSettingsPatch (#60)", () => {
  it("deep-merges nested partials and preserves siblings", () => {
    const merged = mergeAppSettingsPatch(base, { voice: { lang: "en-US" } });
    expect(merged.voice).toEqual({ ...base.voice, lang: "en-US" });
    expect(merged.theme).toBe(base.theme);
  });

  it("deep-merges the surviving agentapi.voiceAgent flag without clearing siblings", () => {
    const flipped = mergeAppSettingsPatch(base, { agentapi: { voiceAgent: true } });
    expect(flipped.agentapi.voiceAgent).toBe(true);
    expect(flipped.theme).toBe(base.theme);
    const kept = mergeAppSettingsPatch(flipped, { theme: "light" });
    expect(kept.agentapi.voiceAgent).toBe(true);
  });

  it("treats undefined as keep and explicit empty values as clear", () => {
    const cleared = mergeAppSettingsPatch(base, { voice: { sttApiKey: "" } });
    expect(cleared.voice.sttApiKey).toBe("");
    expect(cleared.voice.sttUrl).toBe(base.voice.sttUrl);
    expect(cleared.voice.sttModel).toBe(base.voice.sttModel);
    const nulled = mergeAppSettingsPatch(base, { defaultWorkspacePath: null });
    expect(nulled.defaultWorkspacePath).toBeNull();
    const falsed = mergeAppSettingsPatch(base, { onboardingCompleted: false });
    expect(falsed.onboardingCompleted).toBe(false);
  });

  it("replaces arrays wholesale instead of concatenating", () => {
    const merged = mergeAppSettingsPatch(base, { browserNetwork: { allowHosts: [] } });
    expect(merged.browserNetwork.allowHosts).toEqual([]);
    expect(merged.browserNetwork.mode).toBe("allow-hosts");
  });

  it("defaults and deep-merges browser approval mode", () => {
    expect(appSettingsSchema.parse({}).browserApproval.mode).toBe("ask");
    expect(appSettingsSchema.parse({ browserApproval: { mode: "auto" } }).browserApproval.mode).toBe("auto");
    expect(mergeAppSettingsPatch(base, { browserApproval: { mode: "auto" } }).browserApproval.mode).toBe("auto");
  });

  it("defaults the agent-browser popout keys and merges single-field patches", () => {
    const fresh = appSettingsSchema.parse({});
    expect(fresh.agentBrowserWindow).toBe("popout");
    expect(fresh.agentBrowserFullAccess).toBe(false);
    // A single-field patch preserves the untouched sibling key.
    expect(mergeAppSettingsPatch(base, { agentBrowserFullAccess: true }).agentBrowserWindow).toBe("popout");
    expect(mergeAppSettingsPatch(base, { agentBrowserWindow: "embedded" }).agentBrowserFullAccess).toBe(false);
    expect(mergeAppSettingsPatch(base, { agentBrowserFullAccess: true }).agentBrowserFullAccess).toBe(true);
    expect(mergeAppSettingsPatch(base, { agentBrowserWindow: "embedded" }).agentBrowserWindow).toBe("embedded");
  });
});

describe("agent rate limits (issue #93)", () => {
  it("defaults both buckets to 30/min on a fresh settings object", () => {
    const fresh = appSettingsSchema.parse({});
    expect(fresh.agentApi.rateLimit).toEqual({ terminalPerMinute: 30, browserPerMinute: 30 });
  });

  it("a one-bucket patch keeps the sibling bucket instead of resetting it", () => {
    const tuned = mergeAppSettingsPatch(base, { agentApi: { rateLimit: { terminalPerMinute: 120 } } });
    expect(tuned.agentApi.rateLimit.terminalPerMinute).toBe(120);
    // The whole point of the per-field merge: the untouched bucket survives.
    expect(tuned.agentApi.rateLimit.browserPerMinute).toBe(30);
    expect(tuned.agentApi.enabled).toBe(base.agentApi.enabled);
    expect(tuned.agentApi.token).toBe(base.agentApi.token);
  });

  it("rejects out-of-range limits rather than letting a typo disable backpressure", () => {
    expect(() => appSettingsPatchSchema.parse({ agentApi: { rateLimit: { terminalPerMinute: 0 } } })).toThrow();
    expect(() => appSettingsPatchSchema.parse({ agentApi: { rateLimit: { browserPerMinute: 10_001 } } })).toThrow();
    expect(() => appSettingsPatchSchema.parse({ agentApi: { rateLimit: { terminalPerMinute: 1.5 } } })).toThrow();
  });

  it("a legacy settings file with no rateLimit still loads with usable numbers", () => {
    const legacy = appSettingsSchema.parse({ agentApi: { enabled: true, token: "t" } });
    expect(legacy.agentApi.rateLimit).toEqual({ terminalPerMinute: 30, browserPerMinute: 30 });
  });
});
