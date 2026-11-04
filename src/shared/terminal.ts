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

// Claude Code status line / footer phrases. These fragments are emitted only
// by the CLI's own chrome, so a CONTAINS check is safe: a real work summary
// never needs "shift+tab to cycle" or the permission-mode banner. (A prose
// sentence mentioning "permission" alone still passes — the needles are the
// full chrome phrases.)
const CLI_CHROME_NEEDLES = [
  "bypass permissions",
  "shift+tab to cycle",
  "esc to interrupt",
  "? for shortcuts",
];

// Permission-mode markers from the Claude Code status line ("▸▸ bypass
// permissions on", "⏵⏵ normal mode") — two or more consecutive marker glyphs.
const CLI_MODE_MARKER_RUN = /[▸⏵]{2}/u;

// Token-usage segment of the Claude Code status line ("69k/1000k (7%)").
const CLI_TOKEN_USAGE = /\d+(?:\.\d+)?[km]\s*\/\s*\d+(?:\.\d+)?[km]\s*\(\s*\d+%\s*\)/iu;

// claude-team roster rows: "● main", "○ beta-mate", "○ gamma-mate" — the
// team list Claude Code draws above the footer. Restricted to the actual
// roster names so a bullet-pointed real line ("○ 完成度") still passes.
const CLI_ROSTER_LINE = /^[●○]\s*(?:main|[\p{L}\p{N}][\p{L}\p{N}._-]*-mate)\b/iu;

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
  // Claude Code's status line / footer / claude-team roster are CLI chrome,
  // never the session summary (the 2026-11-04 claude-team header regression:
  // with no native ai-title the screen fallback surfaced exactly these lines).
  const lowered = trimmed.toLowerCase();
  if (CLI_CHROME_NEEDLES.some((needle) => lowered.includes(needle))) return true;
  if (CLI_MODE_MARKER_RUN.test(trimmed)) return true;
  if (CLI_TOKEN_USAGE.test(trimmed)) return true;
  if (CLI_ROSTER_LINE.test(trimmed)) return true;
  // Pipe-segmented status line ("Opus 5.5 | …/workspace/3jsfloder | 69k/1000k
  // (7%) | proxy ▸▸ …"). Two-or-more spaced pipes in one line is a status bar
  // or a table row, not prose — a real one-line summary never looks like that.
  if (trimmed.split(/\s\|\s/u).length >= 3) return true;
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
  const trimmed = title?.trim() ?? "";
  if (!trimmed) return null;
  // Junk-check the RAW text first: the marker strip below would turn the
  // claude-team roster row "● main" into the bare word "main", which is no
  // longer recognizable as chrome.
  if (isJunkSessionTitle(trimmed)) return null;
  const stripped = trimmed.replace(LEADING_TITLE_MARKER_RUN, "").trim();
  if (!stripped) return null;
  return isJunkSessionTitle(stripped) ? null : stripped;
}

/** Leaf segment of a cwd ("D:\workspace\sync_party" → "sync_party"). */
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
 * True when a native (OSC / persisted) title carries a real session summary —
 * rejects placeholders and chrome (cleanSessionTitle), the shell default
 * ("PowerShell"), the cwd basename (Codex writes only its workspace folder
 * into OSC 0), and post-exit executable paths. Shared so main's transcript
 * summary publisher (context-meter) and the renderer header resolver apply
 * the same rule to the same candidate.
 */
export function isUsableNativeSessionTitle(
  title: string | null | undefined,
  shellDefault: string,
  cwd: string | null | undefined,
): boolean {
  const cleaned = cleanSessionTitle(title);
  if (!cleaned) return false;
  if (cleaned === shellDefault) return false;
  if (cwdBasename(cwd) === cleaned) return false;
  if (shellExecutableName(cleaned)) return false;
  return true;
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
