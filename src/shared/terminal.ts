import type { TerminalCreateInput } from "./types";

/**
 * The default terminal title for a given shell profile. Used as the initial
 * info.title when a PTY is created, and as a guard in applyTitleToInfo /
 * displayTitle to prevent the shell default from overriding a real LLM work
 * summary. Shared between main process (pty-manager) and renderer
 * (TerminalDock) so both sides agree on what counts as a "default" title.
 */
export function shellTitle(profile: TerminalCreateInput["profile"]): string {
  if (profile === "cmd") return "Command Prompt";
  if (profile === "wsl") return "WSL";
  if (profile === "zsh") return "Zsh";
  if (profile === "bash") return "Bash";
  return "PowerShell";
}

/**
 * Titles a provider CLI writes into OSC 0 that are markers, not summaries.
 *  - "◐ Claude Code" / "✳ Claude Code": Claude Code's rotating spinner frame
 *    before (and often instead of) a real work summary.
 *  - "claude" / "claude.cmd" / "Claude.exe": the npm shim stamps its own
 *    program name as the window title on launch. It arrives right after the
 *    agent-launcher .ps1 starts and then sticks, so a pane whose CLI never
 *    publishes a real title (claude-team) kept showing the literal word
 *    "claude" in its header and top-bar tab instead of a summary.
 * Everything but letters/digits is stripped before the comparison, so any
 * spinner glyph (braille or star) and any punctuation prefix is covered.
 * Trade-off: a project or task literally named "Claude" can never be the
 * summary either — that is the same rule the cwd-basename filter applies.
 * Shared by main (pty-manager#applyTitleToInfo, agent-done-toast) and the
 * renderer (terminal-display-title) so all three stay in step.
 */
export function isPlaceholderSessionTitle(title: string | null | undefined): boolean {
  if (!title) return false;
  const bare = title.replace(/[^\p{L}\p{N}.]/gu, "").replace(/\.$/, "").toLowerCase();
  // A title made only of spinner glyphs yields "" — still a placeholder (it
  // carries no information), which is why the empty case is true here rather
  // than false.
  return bare === "" || bare === "claudecode" || bare === "claude" || bare === "claude.cmd" || bare === "claude.exe";
}

// Spinner/marker glyphs the CLIs prepend to the OSC title while a task runs
// ("✳ Fixing the pane", braille "⠂ …", "◐ …") — one frame per tick. The text
// behind the marker is the real summary; the marker itself is not.
// Repeated marker runs ("✳ ✳ Fixing") strip in one pass.
const LEADING_TITLE_MARKER_RUN = /^(?:[⠀-⣿✳✱✲❋◐◑◒◓●]+\s*)+/u;

// Characters a TUI rule/separator line is made of (box-drawing, dashes,
// repeat bullets). Whitespace joins the runs for counting. "." and "_" are
// deliberately NOT separators — short real labels like "__init__" or "Fix..."
// must not trip the majority rule.
const SEPARATOR_CHARS = new Set(("─━┄┅┈┉╌╍═║│┃|—–-‐=*~·•∙ " + "　").split(""));
const SEPARATOR_MAJORITY_MIN_LENGTH = 6;

/**
 * A candidate session summary that is actually terminal chrome — hook or
 * status-line output ("⚠parallel-guard: agents 2/20 (all sessions)…"), a TUI
 * separator rule ("——————…"), a provider placeholder, or an empty string.
 * Such text must never become the pane header / sidebar session name: it used
 * to flow in through the screen-text fallback when a pane had no real OSC
 * summary yet (claude-team especially), which is the 2026-11-04 junk-title
 * regression. Shared so main (pty-manager, semantic projector, toast) and the
 * renderer (header resolver, sidebar) all reject the same set.
 */
export function isJunkSessionTitle(title: string | null | undefined): boolean {
  const trimmed = title?.trim() ?? "";
  if (!trimmed) return true;
  if (isPlaceholderSessionTitle(trimmed)) return true;
  // Status-line / hook chatter is the CLI's own chrome, never a summary. The
  // guard-name check is anchored at the start so a summary merely MENTIONING
  // "team-guard:" in prose still passes.
  if (trimmed.startsWith("⚠")) return true;
  if (/^⚠?\s*(?:parallel|team)-guard:/iu.test(trimmed)) return true;
  // No letters or digits at all (CJK glyphs count as letters): a separator
  // rule or pure decoration.
  if (!/[\p{L}\p{N}]/u.test(trimmed)) return true;
  // Separator-majority text ("── note ──", "──── 80% ────"): a rule with a
  // small label is still a rule. Below the minimum length, short real titles
  // ("a==b") are left alone.
  const chars = [...trimmed];
  if (chars.length >= SEPARATOR_MAJORITY_MIN_LENGTH) {
    const separators = chars.filter((ch) => SEPARATOR_CHARS.has(ch)).length;
    if (separators * 2 >= chars.length) return true;
  }
  return false;
}

/**
 * Normalize a candidate session title for storage/display: strips the
 * spinner/marker frame prefix, then refuses provider placeholders and terminal
 * chrome. Returns null when nothing usable remains — callers then fall back
 * to cwd / blank instead of ever showing junk.
 */
export function cleanSessionTitle(title: string | null | undefined): string | null {
  const stripped = title?.trim().replace(LEADING_TITLE_MARKER_RUN, "").trim() ?? "";
  if (!stripped) return null;
  return isJunkSessionTitle(stripped) ? null : stripped;
}

export function quoteTerminalPath(
  inputPath: string,
  profile: TerminalCreateInput["profile"],
): string {
  if (profile === "wsl") {
    const drivePath = /^([A-Za-z]):[\\/](.*)$/.exec(inputPath);
    const driveLetter = drivePath?.[1];
    const driveRelativePath = drivePath?.[2];
    const converted =
      driveLetter !== undefined && driveRelativePath !== undefined
        ? `/mnt/${driveLetter.toLowerCase()}/${driveRelativePath.replaceAll("\\", "/")}`
        : inputPath.replaceAll("\\", "/");
    return `'${converted.replaceAll("'", "'\\''")}'`;
  }
  if (profile === "powershell") {
    return `'${inputPath.replaceAll("'", "''")}'`;
  }
  return `"${inputPath.replaceAll('"', '""')}"`;
}
