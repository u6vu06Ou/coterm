import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { appSettingsPatchSchema, appSettingsSchema } from "../../src/shared/schema";
import {
  onboardingCompletePatch,
  terminalFontSizePatch,
  themeTogglePatch,
} from "../../src/renderer/src/store/settings-patches";
import { useAppStore } from "../../src/renderer/src/store/app-store";

const originalState = useAppStore.getState();
const defaultSettings = appSettingsSchema.parse({
  voice: {
    enabled: true,
    lang: "zh-TW",
    sttUrl: "http://127.0.0.1:8765/v1/audio/transcriptions",
    sttModel: "whisper-large-v3",
    sttApiKey: "unit-test-placeholder-stt-key",
  },
});

beforeAll(() => {
  Object.defineProperty(globalThis, "window", { configurable: true, value: {} });
});

afterEach(() => {
  useAppStore.setState(originalState, true);
  vi.restoreAllMocks();
});

function expectNoVoiceLeak(payload: Record<string, unknown>): void {
  expect(payload).not.toHaveProperty("voice");
  expect(JSON.stringify(payload)).not.toContain("sttApiKey");
  expect(JSON.stringify(payload)).not.toContain("sttUrl");
  expect(JSON.stringify(payload)).not.toContain("sttModel");
}

describe("narrow settings patches (#60 P2)", () => {
  it("theme toggle patch carries only the theme key", () => {
    expect(themeTogglePatch("light")).toEqual({ theme: "dark" });
    expect(themeTogglePatch("dark")).toEqual({ theme: "light" });
    expectNoVoiceLeak(themeTogglePatch("dark"));
  });

  it("font size patch carries only terminalFontSize", () => {
    expect(terminalFontSizePatch(18)).toEqual({ terminalFontSize: 18 });
    expectNoVoiceLeak(terminalFontSizePatch(18));
  });

  it("onboarding patch carries only completion fields, never the wizard draft", () => {
    const patch = onboardingCompletePatch("D:\\workspace");
    expect(patch).toEqual({
      onboardingCompleted: true,
      defaultShell: "pwsh",
      defaultWorkspacePath: "D:\\workspace",
    });
    expectNoVoiceLeak(patch);
    expectNoVoiceLeak(onboardingCompletePatch(null));
  });

  it("store seam: non-STT updates hit setSettings IPC without voice payload", async () => {
    const setSettings = vi.fn((patch: Record<string, unknown>) => {
      void patch;
      return Promise.resolve(defaultSettings);
    });
    Object.defineProperty(window, "aiTerminal", { configurable: true, value: { setSettings } });
    useAppStore.setState({ settings: defaultSettings });

    await useAppStore.getState().updateSettings(themeTogglePatch("dark"));
    await useAppStore.getState().updateSettings(terminalFontSizePatch(20));
    await useAppStore.getState().updateSettings(onboardingCompletePatch(null));

    expect(setSettings).toHaveBeenCalledTimes(3);
    for (const call of setSettings.mock.calls) {
      expectNoVoiceLeak(call[0]);
    }
    expect(setSettings.mock.calls[0]?.[0]).toEqual({ theme: "light" });
    expect(setSettings.mock.calls[1]?.[0]).toEqual({ terminalFontSize: 20 });
  });

  it("renderer callers never spread the settings snapshot into updateSettings", async () => {
    const root = join(__dirname, "..", "..");
    const files = [
      "src/renderer/src/components/SettingsPanel.tsx",
      "src/renderer/src/components/TopBar.tsx",
      "src/renderer/src/components/TerminalDock.tsx",
      "src/renderer/src/components/FirstRunWizard.tsx",
    ];
    for (const file of files) {
      const source = await readFile(join(root, file), "utf8");
      expect(source, file).not.toMatch(/updateSettings\(\{\s*\.\.\./);
      expect(source, file).not.toMatch(/patch\("voice", \{\s*\.\.\./);
    }
  });

  it("malformed defaultProvider still coerces to claude-official in patches (#60 P3)", () => {
    // Hot model registry (stage 1): the id space is an open string pattern, so
    // pattern-valid unknown ids now pass through instead of coercing. Only ids
    // violating the pattern still fall back via .catch("claude-official").
    expect(appSettingsPatchSchema.parse({ defaultProvider: "legacy-provider-x" }))
      .toEqual({ defaultProvider: "legacy-provider-x" });
    expect(appSettingsSchema.parse({ defaultProvider: "legacy-provider-x" }).defaultProvider)
      .toBe("legacy-provider-x");
    // Malformed ids (uppercase/underscore/empty) still coerce, never fail parse.
    expect(appSettingsPatchSchema.parse({ defaultProvider: "Legacy_Provider X" }))
      .toEqual({ defaultProvider: "claude-official" });
    expect(appSettingsSchema.parse({ defaultProvider: "Legacy_Provider X" }).defaultProvider)
      .toBe("claude-official");
  });
});
