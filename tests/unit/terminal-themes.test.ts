import { describe, expect, it } from "vitest";
import { resolveTerminalTheme } from "../../src/renderer/src/components/terminal-themes";

describe("terminal themes", () => {
  it("auto resolves to the hardwired sunmoon palettes", () => {
    expect(resolveTerminalTheme("auto", "light").id).toBe("coterm-sun");
    expect(resolveTerminalTheme("auto", "dark").id).toBe("coterm-moon");
  });

  it("reports whether explicit themes are light for ANSI normalization", () => {
    expect(resolveTerminalTheme("github-light", "dark").isLight).toBe(true);
    expect(resolveTerminalTheme("dracula", "light").isLight).toBe(false);
  });

  it("provides complete foreground/background and 16-color palettes", () => {
    const palette = resolveTerminalTheme("nord", "dark").palette;
    expect(palette.background).toBe("#2e3440");
    expect(palette.foreground).toBeTruthy();
    expect(palette.black).toBeTruthy();
    expect(palette.brightWhite).toBeTruthy();
  });
});
