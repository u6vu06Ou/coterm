import { describe, expect, it } from "vitest";
import {
  TERMINAL_FONT_FAMILY,
  TERMINAL_TYPOGRAPHY,
  TERMINAL_FONT_SIZE_MIN,
  TERMINAL_FONT_SIZE_MAX,
} from "../../src/renderer/src/components/terminal-typography";

describe("terminal typography", () => {
  it("keeps a monospace Latin fallback ahead of proportional CJK faces", () => {
    expect(TERMINAL_FONT_FAMILY.startsWith('"Cascadia Code Variable"')).toBe(true);
    expect(TERMINAL_FONT_FAMILY.indexOf("Consolas")).toBeLessThan(
      TERMINAL_FONT_FAMILY.indexOf("Microsoft JhengHei UI"),
    );
  });

  it("uses restrained desktop weights and native glyph spacing", () => {
    expect(TERMINAL_TYPOGRAPHY).toMatchObject({
      desktopLineHeight: 1.3,
      mobileLineHeight: 1.15,
      letterSpacing: 0,
      fontWeight: 400,
      fontWeightBold: 600,
      rescaleOverlappingGlyphs: true,
    });
  });

  it("exposes the user-facing font-size bounds (8–48)", () => {
    // ctrl+wheel, A−/A+, and the settings slider all clamp to this range.
    // 8 covers dense-detailed; 48 covers accessibility-large without breaking
    // the cell grid. schema.ts and SettingsPanel mirror these exactly.
    expect(TERMINAL_FONT_SIZE_MIN).toBe(8);
    expect(TERMINAL_FONT_SIZE_MAX).toBe(48);
  });
});
