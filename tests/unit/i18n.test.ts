import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { appSettingsSchema } from "../../src/shared/schema";
import {
  SUPPORTED_LOCALES,
  dictionaries,
  normalizeLocale,
  translate,
} from "../../src/renderer/src/i18n";

describe("typed i18n foundation", () => {
  it("keeps Traditional Chinese and English dictionary keys identical", () => {
    expect(SUPPORTED_LOCALES).toEqual(["zh-TW", "en-US"]);
    expect(Object.keys(dictionaries["en-US"]).sort())
      .toEqual(Object.keys(dictionaries["zh-TW"]).sort());
  });

  it("interpolates variables and falls back to Traditional Chinese", () => {
    expect(translate("en-US", "settings.dashboard.sessions", { count: 3 })).toBe("3 sessions");
    expect(normalizeLocale(undefined)).toBe("zh-TW");
    expect(normalizeLocale("unsupported")).toBe("zh-TW");
  });

  it("defaults existing settings to zh-TW and accepts only supported locales", () => {
    expect(appSettingsSchema.parse({}).locale).toBe("zh-TW");
    expect(appSettingsSchema.parse({}).terminalFontSize).toBe(16);
    expect(appSettingsSchema.parse({ terminalFontSize: 48 }).terminalFontSize).toBe(48);
    expect(() => appSettingsSchema.parse({ terminalFontSize: 49 })).toThrow();
    expect(appSettingsSchema.parse({ locale: "en-US" }).locale).toBe("en-US");
    expect(() => appSettingsSchema.parse({ locale: "fr-FR" })).toThrow();
  });

  it("defaults codeTheme to auto and accepts only supported palettes", () => {
    expect(appSettingsSchema.parse({}).codeTheme).toBe("auto");
    expect(appSettingsSchema.parse({ codeTheme: "github-light" }).codeTheme).toBe("github-light");
    expect(appSettingsSchema.parse({ codeTheme: "aurora-x" }).codeTheme).toBe("aurora-x");
    expect(() => appSettingsSchema.parse({ codeTheme: "solarized" })).toThrow();
  });

  it("wires the settings panel to the selected locale", () => {
    const settings = readFileSync(resolve("src/renderer/src/components/SettingsPanel.tsx"), "utf8");
    expect(settings).toContain("useI18n()");
    expect(settings).toContain('patch("locale"');
  });

  it("applies the operating-system locale the moment first run opens", () => {
    const wizard = readFileSync(resolve("src/renderer/src/components/FirstRunWizard.tsx"), "utf8");
    expect(wizard).toContain("function detectBrowserLocale");
    expect(wizard).toContain("if (settings.locale !== detected) void updateSettings({ locale: detected });");
  });});
