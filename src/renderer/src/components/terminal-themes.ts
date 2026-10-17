import type { ITheme } from "@xterm/xterm";
import type { AppSettings } from "@shared/types";

/** 日月版型（uiSkin=sunmoon）專用的兩組色票，不開放在設定裡單選。 */
export type SkinTerminalThemeId = "coterm-sun" | "coterm-moon";
export type TerminalThemePreference = AppSettings["terminalTheme"] | SkinTerminalThemeId;
export type TerminalThemeId = Exclude<TerminalThemePreference, "auto">;

export interface ResolvedTerminalTheme {
  id: TerminalThemeId;
  isLight: boolean;
  palette: ITheme;
  /**
   * 背景交給 CSS 漸層畫（xterm 本身畫透明）。palette.background 的 RGB 仍是
   * 漸層的中間色，xterm 拿它算對比度；alpha=00 只在 allowTransparency 下生效。
   */
  transparentBackground?: boolean;
  /** 送出（Enter）的那行在回捲歷史裡的淡橘底色（decoration bottom 層，字色不動）。只 sun 版型給。 */
  typedLine?: string;
  /** 字重覆寫（淺色紙底上細字難讀）；沒給就用 TERMINAL_TYPOGRAPHY 預設 400/600。 */
  fontWeight?: number;
  fontWeightBold?: number;
  /** 中文改用內建可變字重的思源黑體（正黑體只有 400/700，給 500 也不會變粗）。 */
  heavyCjk?: boolean;
}

const themes: Record<TerminalThemeId, ResolvedTerminalTheme> = {
  "coterm-sun": {
    id: "coterm-sun",
    isLight: true,
    transparentBackground: true,
    // 淡杏色（2026-10-03 maintainer：舊 #b0541c 配白字太橘）；字色維持原本 ANSI 色。
    typedLine: "#eecdab",
    // 紙底＋灰階反鋸齒會讓深色細字發虛：一般字 600、粗體 800（可變字重，Cascadia/思源黑體都吃）。
    fontWeight: 600,
    fontWeightBold: 800,
    heavyCjk: true,
    palette: {
      // 書頁米色（漸層在 skin-sunmoon.css）。
      // 選取色一定要帶 alpha：xterm 會把「不透明」的 selectionBackground 自動
      // 降成 30% 再疊到紙色上，#e8975f 實際只剩 #f0d2b6，跟紙色幾乎一樣——
      // 這就是「框選看不出選到哪」。改成霧藍 90%，跟打字行的杏色也分得開。
      background: "#f3ebdc00", foreground: "#2b2420", cursor: "#d98a2b", cursorAccent: "#ffffff",
      selectionBackground: "#7fa6d0e6", selectionInactiveBackground: "#7fa6d066",
      black: "#2b2420", brightBlack: "#8c7f73",
      red: "#b4462b", brightRed: "#c85a3c", green: "#55773c", brightGreen: "#4b6a33",
      yellow: "#9e7318", brightYellow: "#86610f", blue: "#3b678c", brightBlue: "#2f5a7e",
      magenta: "#87579b", brightMagenta: "#744a87", cyan: "#2f7d78", brightCyan: "#256b66",
      white: "#7d7268", brightWhite: "#1f1a17",
    },
  },
  "coterm-moon": {
    id: "coterm-moon",
    isLight: false,
    transparentBackground: true,
    palette: {
      // 灰黑（接近經典 One Half Dark），漸層在 skin-sunmoon.css。選取色帶
      // alpha，理由同 sun（不透明色會被 xterm 降成 30%，幾乎看不見）。
      background: "#262a3200", foreground: "#dcdcea", cursor: "#fff7ee", cursorAccent: "#a24a1b",
      selectionBackground: "#5a7bc8a6", selectionInactiveBackground: "#5a7bc855",
      black: "#3a3f4b", brightBlack: "#6b7092",
      red: "#f2907c", brightRed: "#f7a898", green: "#a4d38b", brightGreen: "#b8e0a2",
      yellow: "#e9c27d", brightYellow: "#f2d49a", blue: "#93afff", brightBlue: "#adc3ff",
      magenta: "#cba8f2", brightMagenta: "#d9bdf7", cyan: "#80d3c8", brightCyan: "#9be0d7",
      white: "#b6b8cf", brightWhite: "#f2f2fa",
    },
  },
  "github-light": {
    id: "github-light",
    isLight: true,
    palette: {
      background: "#ffffff", foreground: "#24292f", cursor: "#0969da", cursorAccent: "#ffffff",
      selectionBackground: "#b6d7ff", black: "#24292f", brightBlack: "#57606a",
      red: "#cf222e", brightRed: "#a40e26", green: "#116329", brightGreen: "#1a7f37",
      yellow: "#4d2d00", brightYellow: "#633c01", blue: "#0969da", brightBlue: "#218bff",
      magenta: "#8250df", brightMagenta: "#a475f9", cyan: "#1b7c83", brightCyan: "#3192aa",
      white: "#6e7781", brightWhite: "#24292f",
    },
  },
  "github-dark": {
    id: "github-dark",
    isLight: false,
    palette: {
      background: "#0d1117", foreground: "#c9d1d9", cursor: "#58a6ff", cursorAccent: "#0d1117",
      selectionBackground: "#264f78", black: "#484f58", brightBlack: "#6e7681",
      red: "#ff7b72", brightRed: "#ffa198", green: "#3fb950", brightGreen: "#56d364",
      yellow: "#d29922", brightYellow: "#e3b341", blue: "#58a6ff", brightBlue: "#79c0ff",
      magenta: "#bc8cff", brightMagenta: "#d2a8ff", cyan: "#39c5cf", brightCyan: "#56d4dd",
      white: "#b1bac4", brightWhite: "#f0f6fc",
    },
  },
  "one-half-light": {
    id: "one-half-light",
    isLight: true,
    palette: {
      background: "#faf8f3", foreground: "#383a42", cursor: "#526fff", cursorAccent: "#faf8f3",
      selectionBackground: "#dce6f2", black: "#383a42", brightBlack: "#696c77",
      red: "#e45649", brightRed: "#c33d32", green: "#50a14f", brightGreen: "#3f8f3e",
      yellow: "#986801", brightYellow: "#806000", blue: "#4078f2", brightBlue: "#2f67db",
      magenta: "#a626a4", brightMagenta: "#8f1f8d", cyan: "#0184bc", brightCyan: "#00739f",
      white: "#6f7078", brightWhite: "#202124",
    },
  },
  "one-half-dark": {
    id: "one-half-dark",
    isLight: false,
    palette: {
      background: "#282c34", foreground: "#abb2bf", cursor: "#528bff", cursorAccent: "#282c34",
      selectionBackground: "#3e4451", black: "#282c34", brightBlack: "#5a6374",
      red: "#e06c75", brightRed: "#e06c75", green: "#98c379", brightGreen: "#98c379",
      yellow: "#e5c07b", brightYellow: "#e5c07b", blue: "#61afef", brightBlue: "#61afef",
      magenta: "#c678dd", brightMagenta: "#c678dd", cyan: "#56b6c2", brightCyan: "#56b6c2",
      white: "#abb2bf", brightWhite: "#ffffff",
    },
  },
  "solarized-light": {
    id: "solarized-light",
    isLight: true,
    palette: {
      background: "#fdf6e3", foreground: "#586e75", cursor: "#268bd2", cursorAccent: "#fdf6e3",
      selectionBackground: "#eee8d5", black: "#073642", brightBlack: "#657b83",
      red: "#dc322f", brightRed: "#cb4b16", green: "#859900", brightGreen: "#586e75",
      yellow: "#b58900", brightYellow: "#657b83", blue: "#268bd2", brightBlue: "#839496",
      magenta: "#d33682", brightMagenta: "#6c71c4", cyan: "#2aa198", brightCyan: "#93a1a1",
      white: "#839496", brightWhite: "#002b36",
    },
  },
  "solarized-dark": {
    id: "solarized-dark",
    isLight: false,
    palette: {
      background: "#002b36", foreground: "#839496", cursor: "#93a1a1", cursorAccent: "#002b36",
      selectionBackground: "#073642", black: "#073642", brightBlack: "#657b83",
      red: "#dc322f", brightRed: "#cb4b16", green: "#859900", brightGreen: "#586e75",
      yellow: "#b58900", brightYellow: "#657b83", blue: "#268bd2", brightBlue: "#839496",
      magenta: "#d33682", brightMagenta: "#6c71c4", cyan: "#2aa198", brightCyan: "#93a1a1",
      white: "#eee8d5", brightWhite: "#fdf6e3",
    },
  },
  dracula: {
    id: "dracula",
    isLight: false,
    palette: {
      background: "#282a36", foreground: "#f8f8f2", cursor: "#f8f8f0", cursorAccent: "#282a36",
      selectionBackground: "#44475a", black: "#21222c", brightBlack: "#6272a4",
      red: "#ff5555", brightRed: "#ff6e6e", green: "#50fa7b", brightGreen: "#69ff94",
      yellow: "#f1fa8c", brightYellow: "#ffffa5", blue: "#bd93f9", brightBlue: "#d6acff",
      magenta: "#ff79c6", brightMagenta: "#ff92df", cyan: "#8be9fd", brightCyan: "#a4ffff",
      white: "#f8f8f2", brightWhite: "#ffffff",
    },
  },
  monokai: {
    id: "monokai",
    isLight: false,
    palette: {
      background: "#272822", foreground: "#f8f8f2", cursor: "#f8f8f0", cursorAccent: "#272822",
      selectionBackground: "#49483e", black: "#272822", brightBlack: "#75715e",
      red: "#f92672", brightRed: "#f92672", green: "#a6e22e", brightGreen: "#a6e22e",
      yellow: "#f4bf75", brightYellow: "#f4bf75", blue: "#66d9ef", brightBlue: "#66d9ef",
      magenta: "#ae81ff", brightMagenta: "#ae81ff", cyan: "#a1efe4", brightCyan: "#a1efe4",
      white: "#f8f8f2", brightWhite: "#ffffff",
    },
  },
  nord: {
    id: "nord",
    isLight: false,
    palette: {
      background: "#2e3440", foreground: "#d8dee9", cursor: "#88c0d0", cursorAccent: "#2e3440",
      selectionBackground: "#434c5e", black: "#3b4252", brightBlack: "#4c566a",
      red: "#bf616a", brightRed: "#bf616a", green: "#a3be8c", brightGreen: "#a3be8c",
      yellow: "#ebcb8b", brightYellow: "#ebcb8b", blue: "#81a1c1", brightBlue: "#81a1c1",
      magenta: "#b48ead", brightMagenta: "#b48ead", cyan: "#88c0d0", brightCyan: "#8fbcbb",
      white: "#e5e9f0", brightWhite: "#eceff4",
    },
  },
};

// 經典 skin 已移除 — 日月（sunmoon）是唯一 skin，auto 色票恆為日／月兩組。
export function resolveTerminalTheme(
  preference: TerminalThemePreference | undefined,
  appTheme: "dark" | "light",
): ResolvedTerminalTheme {
  const auto = !preference || preference === "auto";
  const id: TerminalThemeId = auto
    ? (appTheme === "light" ? "coterm-sun" : "coterm-moon")
    : preference;
  return themes[id];
}

