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
