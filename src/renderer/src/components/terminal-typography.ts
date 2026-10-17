/**
 * Stable xterm typography defaults.
 *
 * Keep a true monospace Latin fallback before the CJK faces. Otherwise a
 * machine without Cascadia renders every ASCII glyph through a proportional
 * CJK UI font, which makes the terminal grid look uneven.
 */
export const TERMINAL_FONT_FAMILY =
  '"Cascadia Code Variable", "Cascadia Mono", Consolas, "Microsoft JhengHei UI", "Noto Sans TC", monospace';

// User-facing font size bounds (ctrl+wheel, A−/A+, settings slider all clamp
// to this). 8–48 covers tiny-dense and accessibility-large without breaking
// the cell grid. Mobile auto-fill (fontSizeForViewport) keeps its own max.
export const TERMINAL_FONT_SIZE_MIN = 8;
export const TERMINAL_FONT_SIZE_MAX = 48;

/** Tail appended to every font stack so CJK glyphs never fall to a Latin face. */
const TERMINAL_CJK_FALLBACK = '"Microsoft JhengHei UI", "Noto Sans TC", monospace';

export interface TerminalFontOption {
  id: string;
  /** Family name for document.fonts.check; null → default stack, always available. */
  cssName: string | null;
  stack: string;
}

/**
 * Curated PTY font menu (Settings → appearance). Every entry keeps a true
 * monospace Latin face at the front and TERMINAL_CJK_FALLBACK at the tail, so
 * a machine without the picked font falls back one step at a time (per the
 * docstring above) instead of rendering ASCII through a proportional CJK UI
 * font. CJK-centric picks (Sarasa/MingLiU) keep Consolas before the CJK face
 * so ASCII cells stay even.
 */
export const TERMINAL_FONT_OPTIONS: readonly TerminalFontOption[] = [
  { id: "default", cssName: null, stack: TERMINAL_FONT_FAMILY },
  // Cascadia / JetBrains / Fira / Source Code Pro ship bundled with the app
  // (@fontsource-variable, imported in main.tsx), so every pick renders even on
  // a machine that only has Consolas. xterm draws no ligatures, so Mono vs Code
  // differ only by the installed static face when present.
  { id: "cascadia-mono", cssName: "Cascadia Code Variable", stack: `"Cascadia Mono", "Cascadia Code Variable", Consolas, ${TERMINAL_CJK_FALLBACK}` },
  { id: "cascadia-code", cssName: "Cascadia Code Variable", stack: `"Cascadia Code Variable", Consolas, ${TERMINAL_CJK_FALLBACK}` },
  { id: "consolas", cssName: "Consolas", stack: `Consolas, ${TERMINAL_CJK_FALLBACK}` },
  { id: "jetbrains-mono", cssName: "JetBrains Mono Variable", stack: `"JetBrains Mono Variable", Consolas, ${TERMINAL_CJK_FALLBACK}` },
  { id: "fira-code", cssName: "Fira Code Variable", stack: `"Fira Code Variable", Consolas, ${TERMINAL_CJK_FALLBACK}` },
  { id: "source-code-pro", cssName: "Source Code Pro Variable", stack: `"Source Code Pro Variable", Consolas, ${TERMINAL_CJK_FALLBACK}` },
  // 2026-10-03 maintainer要更多好讀的字型：這三套也跟著 app 打包（@fontsource）。
  { id: "geist-mono", cssName: "Geist Mono Variable", stack: `"Geist Mono Variable", Consolas, ${TERMINAL_CJK_FALLBACK}` },
  { id: "ibm-plex-mono", cssName: "IBM Plex Mono", stack: `"IBM Plex Mono", Consolas, ${TERMINAL_CJK_FALLBACK}` },
  { id: "roboto-mono", cssName: "Roboto Mono Variable", stack: `"Roboto Mono Variable", Consolas, ${TERMINAL_CJK_FALLBACK}` },
  // 霞鶩文楷 Mono：中英文都由它畫（自帶半形等寬英文），溫和的楷書風，長文好讀。
  { id: "lxgw-wenkai-mono", cssName: "LXGW WenKai Mono TC", stack: `"LXGW WenKai Mono TC", Consolas, ${TERMINAL_CJK_FALLBACK}` },
  { id: "sarasa-mono-tc", cssName: "Sarasa Mono TC", stack: `"Sarasa Mono TC", Consolas, ${TERMINAL_CJK_FALLBACK}` },
  // MingLiU first: its own monospace Latin keeps the grid even and makes the
  // pick visibly different from Consolas (Consolas-first hid it entirely).
  { id: "mingliu", cssName: "MingLiU", stack: `"MingLiU", Consolas, ${TERMINAL_CJK_FALLBACK}` },
];

/**
 * Bundled webfonts load lazily; xterm measures cells and builds its glyph atlas
 * from whatever face is ready at that moment, so a font swap before load looks
 * like "nothing changed". Resolve once the picked face (or its failure) settles.
 */
export async function loadTerminalFont(id: string, sizePx = 16): Promise<void> {
  const found = TERMINAL_FONT_OPTIONS.find((option) => option.id === id);
  const family = found?.cssName ?? "Cascadia Code Variable";
  try {
    await Promise.all([
      document.fonts.load(`${sizePx}px "${family}"`),
      document.fonts.load(`500 ${sizePx}px "${family}"`),
      document.fonts.load(`bold ${sizePx}px "${family}"`),
    ]);
  } catch {
    // CSS fallback still applies.
  }
}

/**
 * Unknown id (hand-edited settings) → system default stack.
 *
 * heavyCjk: Microsoft JhengHei only ships 400/700, so a 500 terminal weight
 * leaves every Chinese glyph as thin as before. Put the bundled variable Noto
 * Sans TC in front of it so the CJK text actually gets the heavier weight.
 */
export function resolveTerminalFontStack(id: string, heavyCjk = false): string {
  const found = TERMINAL_FONT_OPTIONS.find((option) => option.id === id);
  const stack = found ? found.stack : TERMINAL_FONT_FAMILY;
  if (!heavyCjk || stack.includes("Noto Sans TC Variable")) return stack;
  return stack.replace('"Microsoft JhengHei UI"', '"Noto Sans TC Variable", "Microsoft JhengHei UI"');
}

/** Best-effort install probe; on any error assume installed (CSS still falls back). */
const BUNDLED_TERMINAL_FONTS = new Set([
  "Cascadia Code Variable", "JetBrains Mono Variable", "Fira Code Variable", "Source Code Pro Variable",
  "Geist Mono Variable", "IBM Plex Mono", "Roboto Mono Variable", "LXGW WenKai Mono TC",
]);

export function isTerminalFontInstalled(cssName: string): boolean {
  if (BUNDLED_TERMINAL_FONTS.has(cssName)) return true;
  try {
    return document.fonts.check(`12px "${cssName}"`);
  } catch {
    return true;
  }
}

export const TERMINAL_TYPOGRAPHY = {
  desktopLineHeight: 1.3,
  mobileLineHeight: 1.15,
  letterSpacing: 0,
  fontWeight: 400,
  fontWeightBold: 600,
  rescaleOverlappingGlyphs: true,
} as const;
