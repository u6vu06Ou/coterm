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
