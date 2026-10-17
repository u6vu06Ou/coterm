import { describe, expect, it } from "vitest";
import { enUS } from "../../src/renderer/src/i18n/locales/en-US";
import { zhTW } from "../../src/renderer/src/i18n/locales/zh-TW";

// Verdict gap 4: TopBar primary labels/titles/aria text must follow zh-TW/en-US.
// These keys cover every hard-coded TopBar string the user can see or hear
// (title attributes, aria-labels, visible button text).
const TOPBAR_KEYS = [
  "topbar.switcher.aria",
  "topbar.switcher.title",
  "topbar.switcher.solo",
  "topbar.switcher.showAll",
  "topbar.enter.title",
  "topbar.keys.toggle",
  "topbar.keys.up",
  "topbar.keys.down",
  "topbar.keys.left",
  "topbar.keys.right",
  "topbar.keys.esc",
  "topbar.keys.tab",
  "topbar.keys.stop",
  "topbar.keys.paste",
  "topbar.keys.attach",
  "topbar.refresh.title",
  "topbar.theme.toggleDark",
  "topbar.theme.toggleLight",
  "topbar.explorer.title",
  "topbar.settings",
  "topbar.voice.recording",
  "topbar.voice.holdToSpeak",
] as const;

describe("TopBar i18n coverage", () => {
  it("zh-TW dictionary defines every TopBar key", () => {
    for (const key of TOPBAR_KEYS) {
      expect(zhTW, `zh-TW missing ${key}`).toHaveProperty(key);
      expect(typeof zhTW[key as keyof typeof zhTW]).toBe("string");
    }
  });

  it("en-US dictionary defines every TopBar key", () => {
    for (const key of TOPBAR_KEYS) {
      expect(enUS, `en-US missing ${key}`).toHaveProperty(key);
      expect(typeof enUS[key as keyof typeof enUS]).toBe("string");
    }
  });

  it("no TopBar key is identical between locales (each is actually translated)", () => {
    for (const key of TOPBAR_KEYS) {
      const zh = zhTW[key as keyof typeof zhTW];
      const en = enUS[key as keyof typeof enUS];
      // CJK-heavy strings may legitimately match if both keep a brand name,
      // but the majority must differ. Flag only exact full-string equality.
      if (zh === en) {
        // Allow a small allowlist of intentionally-shared labels (e.g. "Esc").
        const ALLOWED_MATCH = ["topbar.keys.esc", "topbar.keys.tab"];
        expect(ALLOWED_MATCH, `unexpected identical translation for ${key}: "${zh}"`).toContain(key);
      }
    }
  });
});
