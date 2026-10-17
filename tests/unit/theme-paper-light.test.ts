import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { resolveTerminalTheme } from "../../src/renderer/src/components/terminal-themes";

// Verdict gap 5: light theme must use a warm gray paper palette with NO
// pure-white main surface, and the xterm light ANSI palette must be adapted
// for legibility. We read the CSS as text (vitest runs in node) and assert
// the light-theme block's surface values.

const STYLES = readFileSync(resolve("src/renderer/src/styles.css"), "utf8");

// Extract the :root[data-theme="light"] block body.
const LIGHT_BLOCK_MATCH = STYLES.match(/:root\[data-theme="light"\]\s*\{([\s\S]*?)\n\}/);
const LIGHT_BLOCK = LIGHT_BLOCK_MATCH?.[1] ?? "";

function lightVar(name: string): string | undefined {
  const re = new RegExp(`--${name}\\s*:\\s*([^;]+);`);
  const m = LIGHT_BLOCK.match(re);
  return m?.[1]?.trim();
}

describe("light theme: warm paper palette, no pure-white main surface", () => {
  it("defines a light-theme block", () => {
    expect(LIGHT_BLOCK.length, "light-theme block not found in styles.css").toBeGreaterThan(0);
  });

  it("main surfaces are NOT pure white (#fff / #ffffff)", () => {
    // --bg, --surface, --sidebar are the main visible surfaces. None may be
    // pure white — the paper palette is warm off-white to reduce glare.
    for (const v of ["bg", "surface", "sidebar"]) {
      const val = lightVar(v);
      expect(val, `--${v} undefined in light theme`).toBeDefined();
      expect(val!.toLowerCase()).not.toBe("#fff");
      expect(val!.toLowerCase()).not.toBe("#ffffff");
      expect(val!.toLowerCase()).not.toBe("white");
    }
  });

  it("elevated surface is also not pure white", () => {
    const val = lightVar("bg-elevated");
    expect(val, "--bg-elevated undefined in light theme").toBeDefined();
    expect(val!.toLowerCase()).not.toBe("#fff");
    expect(val!.toLowerCase()).not.toBe("#ffffff");
  });

  it("uses a warm (non-gray) paper base for --bg", () => {
    // Warm paper = a hint of yellow/red, not a neutral gray. #f4f2ec is warm.
    // Assert the base bg is a warm-ish off-white by checking it's not a neutral
    // #f0f0f0 / #eeeeee style gray.
    const bg = lightVar("bg")!.toLowerCase();
    expect(bg).toMatch(/^#f[0-9a-f]{5}$/);
    // Warmth: the blue channel should be the lowest (paper leans yellow/red).
    const r = parseInt(bg.slice(1, 3), 16);
    const g = parseInt(bg.slice(3, 5), 16);
    const b = parseInt(bg.slice(5, 7), 16);
    expect(b).toBeLessThan(r);
    expect(b).toBeLessThan(g);
  });
});

describe("xterm light ANSI palette adaptation", () => {
  const LIGHT_PALETTE = resolveTerminalTheme("one-half-light", "light").palette;

  it("defines a ONE_HALF_LIGHT palette", () => {
    expect(LIGHT_PALETTE.background).toBeTruthy();
    expect(LIGHT_PALETTE.foreground).toBeTruthy();
  });

  it("light terminal background is NOT pure white", () => {
    const bg = String(LIGHT_PALETTE.background).toLowerCase();
    expect(bg).not.toBe("#fff");
    expect(bg).not.toBe("#ffffff");
  });

  it("light terminal foreground is dark (legible on paper)", () => {
    const fg = String(LIGHT_PALETTE.foreground).toLowerCase();
    const r = parseInt(fg.slice(1, 3), 16);
    const g = parseInt(fg.slice(3, 5), 16);
    const b = parseInt(fg.slice(5, 7), 16);
    // Dark foreground: all channels below mid-range.
    expect(r).toBeLessThan(128);
    expect(g).toBeLessThan(128);
    expect(b).toBeLessThan(128);
  });
});
