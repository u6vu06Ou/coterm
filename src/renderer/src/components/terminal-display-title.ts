import type { TerminalInfo, AgentApiSessionSemanticState } from "@shared/types";
import { shellTitle } from "@shared/terminal";

type DisplayTitleInfo = Pick<TerminalInfo, "isAgent" | "profile" | "cwd" | "title" | "agentSummaryTitle">
  & { agentProfile?: TerminalInfo["agentProfile"] };

/**
 * The recap marquee belongs to the MOBILE PTY switcher button only — never the
 * pane header, which must keep showing the short amber session summary
 * (v1.5.19 regression: the marquee was mounted in the header and covered it).
 */
export function shouldMarqueeSessionSummary(input: {
  mobile: boolean;
  active: boolean;
  overflowPx: number;
  inViewport: boolean;
  documentVisible: boolean;
  reducedMotion: boolean;
}): boolean {
  return input.mobile
    && input.active
    && input.overflowPx > 0
    && input.inViewport
    && input.documentVisible
    && !input.reducedMotion;
}

/**
 * Seconds for one right-to-left pass plus the end/start holds (8% each end of
 * the keyframes). Speed adapts to the glyph size: ~5.5 characters per second is a
 * comfortable pace for scrolling text, so a bigger font scrolls proportionally
 * faster in px/s. Clamped so a tiny overflow still creeps and a huge one ends.
 */
export function marqueeDurationSeconds(overflowPx: number, fontPx = 13): number {
  const MIN_SECONDS = 6;
  const MAX_SECONDS = 60;
  const CHARS_PER_SECOND = 5.5;
  const pxPerSecond = Math.min(110, Math.max(45, fontPx * CHARS_PER_SECOND));
  if (overflowPx <= 0) return MIN_SECONDS;
  const moving = overflowPx / pxPerSecond;
  return Math.min(MAX_SECONDS, Math.max(MIN_SECONDS, Math.round(moving / 0.84 + 0.5)));
}

export function cwdBasename(cwd: string | null | undefined): string | null {
  if (!cwd) return null;
  return cwd.replace(/[\\/]+$/, "").split(/[\\/]/).pop() || null;
}

/**
 * After an agent exits, pwsh/cmd put their own executable path in the window
 * title ("C:\Program Files\WindowsApps\Microsoft.PowerShell_7…\pwsh.exe").
 * That is not a summary — return the bare program name ("pwsh") instead.
 */
export function shellExecutableName(title: string | null | undefined): string | null {
  const trimmed = title?.trim();
  if (!trimmed || !/^(?:[a-z]:)?[\\/]/i.test(trimmed)) return null;
  const leaf = trimmed.replace(/[\\/]+$/, "").split(/[\\/]/).pop() ?? "";
  if (!/\.exe$/i.test(leaf) && !/^(?:pwsh|powershell|cmd|bash|wsl)$/i.test(leaf)) return null;
  return leaf.replace(/\.exe$/i, "") || null;
}

/**
 * Short cwd for the top-bar browser tabs: the leaf segment prefixed with its
 * parent ("…/parent/leaf") when the path is deeper, so a shallow tree still
 * shows context without flooding a ~200px tab. Normalizes backslashes.
 */
export function shortCwd(cwd: string | null | undefined): string | null {
  if (!cwd) return null;
  const parts = cwd.replace(/\\/g, "/").replace(/[\\/]+$/, "").split("/").filter(Boolean);
  if (parts.length === 0) return null;
  if (parts.length <= 2) return parts.join("/");
  return `…/${parts.slice(-2).join("/")}`;
}

/**
 * Two-row top-bar tabs: the row contents adapt to the MEASURED tab width. The
 * visual switch is driven by container queries in styles.css (the tab is the
 * query container), and these are the mirrored breakpoints — keep both in
 * sync. Row 1 = signal lamp + tile number + short cwd; row 2 = session summary.
 *   full     (>= 120px): both rows complete.
 *   compact  (80-119px): the cwd hides; the summary row stays.
 *   minimal  (< 80px):  single centered row, lamp + number only.
 */
export const TOPBAR_TAB_BREAKPOINTS = { compact: 80, full: 120 } as const;
export type TopbarTabMode = "full" | "compact" | "minimal";

export function tabDisplayMode(widthPx: number): TopbarTabMode {
  if (widthPx >= TOPBAR_TAB_BREAKPOINTS.full) return "full";
  if (widthPx >= TOPBAR_TAB_BREAKPOINTS.compact) return "compact";
  return "minimal";
}

export function isPlaceholderSessionTitle(title: string | null | undefined): boolean {
  return Boolean(title && /^[^\p{L}\p{N}]*Claude Code$/iu.test(title.trim()));
}

/**
 * Pick the header session summary for a tile. A title equal to the cwd
 * basename is no summary (Codex only writes its workspace folder into OSC 0)
 * — show nothing rather than letting a folder name masquerade as a summary.
 */
export function resolveDisplayTitle(
  info: DisplayTitleInfo,
  sessionTitle: string | null,
): string | null {
  if (!info.isAgent) return null;
  const shellDefault = shellTitle(info.profile);
  const base = cwdBasename(info.cwd);
  // No provider-specific early return here. v1.5.19 added one that accepted
  // ONLY agentSummaryTitle for claude-*/codex-*, which silently blanked the
  // header for every Claude pane (Claude Code publishes its work summary
  // through OSC 0 / info.title, and agentSummaryTitle is null unless the
  // provider wrote a recap). The shared fallback chain below already refuses
  // shell defaults, the cwd basename and placeholder titles, so it is safe for
  // every provider.
  // Codex's state DB title is authoritative: its OSC title normally stays at
  // the cwd basename, while this field updates when Codex generates/renames
  // the task summary after the first prompt.
  return [info.agentSummaryTitle, sessionTitle, info.title].find((title) =>
    Boolean(title && title !== shellDefault && title !== base && !isPlaceholderSessionTitle(title) && !shellExecutableName(title)),
  ) ?? null;
}

/** Prefer the task currently being worked on, then the latest completed turn. */
export function resolveSemanticSessionSummary(
  state: AgentApiSessionSemanticState | null | undefined,
): string | null {
  const value = state?.task.summary ?? state?.lastTurn.summary ?? null;
  if (!value) return null;
  const compact = value.replace(/\s+/g, " ").trim();
  return compact ? compact.slice(0, 180) : null;
}

/**
 * Header title for a tile. The native OSC title (Claude Code/Codex set a
 * concise work summary) always wins; the semantic projection is raw
 * assistant-sentence fallback for agents that never set a title. Letting
 * semantic override the native title replaces a real summary with live
 * narration — regression shipped in v1.5.13-beta.0, do not re-invert.
 */
export function resolvePaneDisplayTitle(
  info: DisplayTitleInfo,
  sessionTitle: string | null,
  semanticSessionSummary: string | null,
  isActive: boolean,
): string | null {
  return resolveDisplayTitle(info, sessionTitle)
    ?? (isActive && info.isAgent ? semanticSessionSummary : null);
}
