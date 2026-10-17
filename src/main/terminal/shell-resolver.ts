// Shell executable resolution (public #10). Two hard rules:
//
// 1. profile "powershell" means Windows PowerShell 5.1 — resolved EXPLICITLY
//    (%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe, then PATH),
//    never silently upgraded to pwsh 7. Users who want 7 pick "pwsh".
// 2. profile "pwsh" keeps the v1.4 LEGACY passthrough: known install paths are
//    preferred (MSI path → Microsoft Store via Appx query → PATH scan), but
//    when none verify on disk we return the bare "pwsh.exe" and let conpty's
//    own PATH resolution decide. Verification-by-existsSync was tried in
//    v1.5.0 and broke Microsoft Store installs (app-exec-aliases are invisible
//    to existsSync but spawn fine) — the maintainer overrode the strict gate. The Appx
//    query (v1.5.3) sidesteps both the alias and a corrupt user PATH.
//
// All lookups are injectable (exists/env/platform) so the shell matrix is
// unit-testable without touching the host machine.

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { delimiter, join } from "node:path";
import type { TerminalCreateInput } from "@shared/types";

export type ShellProfile = TerminalCreateInput["profile"];
export type ShellKind = "powershell5" | "pwsh7" | "cmd" | "wsl" | "zsh" | "bash";

export interface ShellResolution {
  profile: ShellProfile;
  kind: ShellKind;
  executable: string;
  /** Candidate paths/names checked, in order. Error-message safe. */
  attempted: string[];
}

export interface ShellResolverDeps {
  exists?: (path: string) => boolean;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  /** Test hook: return the Store pwsh real path (or null). Production runs the Appx query. */
  queryStorePwsh?: () => string | null;
}

// The Microsoft Store pwsh lives behind an app-exec-alias reparse point that
// existsSync cannot see, and its real path sits under an ACL-locked WindowsApps
// dir — but Get-AppxPackage answers without touching either, and it does not
// depend on PATH. Store updates can replace the versioned directory while
// Coterm is still running, so a cached positive path must be revalidated.
let storePwshCache: string | null | undefined;

function cachedStorePwshQuery(
  query: () => string | null,
  exists: (path: string) => boolean,
): string | null {
  if (storePwshCache) {
    try {
      if (exists(storePwshCache)) return storePwshCache;
    } catch {
      // A stale or newly inaccessible Store path must be queried again.
    }
  }
  storePwshCache = query();
  return storePwshCache;
}

function defaultQueryStorePwsh(env: NodeJS.ProcessEnv, exists: (path: string) => boolean): string | null {
  const powershell = join(
    env.SystemRoot ?? "C:\\Windows",
    "System32", "WindowsPowerShell", "v1.0", "powershell.exe",
  );
  try {
    const result = spawnSync(powershell, [
      "-NoProfile", "-Command",
      "(Get-AppxPackage -Name Microsoft.PowerShell -ErrorAction SilentlyContinue | Select-Object -Last 1).InstallLocation",
    ], { encoding: "utf8", timeout: 10_000, windowsHide: true });
    const location = result.stdout?.trim().split(/\r?\n/).filter(Boolean).pop();
    if (result.status === 0 && location) {
      const exe = join(location, "pwsh.exe");
      return exists(exe) ? exe : null;
    }
  } catch {
    // powershell 5.1 absent/unrunnable — treat as no Store install.
  }
  return null;
}

function findOnPath(
  name: string,
  env: NodeJS.ProcessEnv,
  exists: (path: string) => boolean,
): { found: string | null; searched: string[] } {
  const searched: string[] = [];
  for (const dir of (env.PATH ?? env.Path ?? "").split(delimiter)) {
    const trimmed = dir.trim();
    if (!trimmed) continue;
    const candidate = join(trimmed, name);
    searched.push(candidate);
    try {
      if (exists(candidate)) return { found: candidate, searched };
    } catch {
      // Unreadable PATH entry — treat as absent.
    }
  }
  return { found: null, searched };
}

function resolvePowerShell5(deps: ShellResolverDeps): ShellResolution | null {
  const exists = deps.exists ?? existsSync;
  const env = deps.env ?? process.env;
  const attempted: string[] = [];
  const systemRoot = env.SystemRoot ?? "C:\\Windows";
  const system32 = join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  attempted.push(system32);
  if (exists(system32)) {
    return { profile: "powershell", kind: "powershell5", executable: system32, attempted };
  }
  const onPath = findOnPath("powershell.exe", env, exists);
  attempted.push(...onPath.searched);
  if (onPath.found) {
    return { profile: "powershell", kind: "powershell5", executable: onPath.found, attempted };
  }
  attempted.push("powershell.exe");
  return null;
}

function resolvePwsh7(deps: ShellResolverDeps): ShellResolution | null {
  const exists = deps.exists ?? existsSync;
  const env = deps.env ?? process.env;
  const attempted: string[] = [];
  const programFiles = env.ProgramFiles;
  if (programFiles) {
    const candidate = join(programFiles, "PowerShell", "7", "pwsh.exe");
    attempted.push(candidate);
    if (exists(candidate)) {
      return { profile: "pwsh", kind: "pwsh7", executable: candidate, attempted };
    }
  }
  // Store install: resolved via Appx (env-independent) before trusting PATH,
  // because a corrupt/missing user PATH must not break the default shell.
  const storeExe = deps.queryStorePwsh !== undefined
    ? cachedStorePwshQuery(deps.queryStorePwsh, exists)
    : deps.exists === undefined
      ? cachedStorePwshQuery(() => defaultQueryStorePwsh(env, exists), exists)
      : null;
  if (storeExe) {
    attempted.push(storeExe);
    return { profile: "pwsh", kind: "pwsh7", executable: storeExe, attempted };
  }
  const onPath = findOnPath("pwsh.exe", env, exists);
  attempted.push(...onPath.searched);
  if (onPath.found) {
    return { profile: "pwsh", kind: "pwsh7", executable: onPath.found, attempted };
  }
  attempted.push("pwsh.exe");
  // Legacy passthrough: existsSync cannot see Microsoft Store app-exec-aliases
  // (ENOENT on the reparse point) but conpty/CreateProcess resolve them fine.
  // Return the bare name and let spawn decide; a genuinely missing pwsh fails
  // in node-pty with profile+executable context from the caller's wrapper.
  return { profile: "pwsh", kind: "pwsh7", executable: "pwsh.exe", attempted };
}

/**
 * Resolve the executable for a terminal profile. Returns null only when the
 * requested shell cannot be verified on this machine (win32 pwsh/powershell).
 * Non-win32 platforms keep the historical bare-name behavior (node-pty
 * resolves via the login shell PATH).
 */
export function resolveShell(profile: ShellProfile, deps: ShellResolverDeps = {}): ShellResolution | null {
  const platform = deps.platform ?? process.platform;
  const env = deps.env ?? process.env;
  if (platform === "win32") {
    if (profile === "powershell") return resolvePowerShell5(deps);
    if (profile === "pwsh") return resolvePwsh7(deps);
    if (profile === "cmd") {
      const comspec = env.ComSpec ?? "cmd.exe";
      return { profile, kind: "cmd", executable: comspec, attempted: [comspec] };
    }
    if (profile === "wsl") return { profile, kind: "wsl", executable: "wsl.exe", attempted: ["wsl.exe"] };
  }
  const bare: Record<string, { kind: ShellKind; executable: string }> = {
    powershell: { kind: "powershell5", executable: "powershell.exe" },
    pwsh: { kind: "pwsh7", executable: "pwsh.exe" },
    cmd: { kind: "cmd", executable: env.ComSpec ?? "cmd.exe" },
    wsl: { kind: "wsl", executable: "wsl.exe" },
    zsh: { kind: "zsh", executable: "zsh" },
    bash: { kind: "bash", executable: "bash" },
  };
  const entry = bare[profile];
  if (!entry) return null;
  return { profile, kind: entry.kind, executable: entry.executable, attempted: [entry.executable] };
}

/** Error text for a failed resolution: profile + kind + candidates. No env values. */
export function formatShellUnavailable(profile: ShellProfile, attempted: string[]): string {
  const kinds: Record<ShellProfile, string> = {
    powershell: "Windows PowerShell 5.1",
    pwsh: "PowerShell 7 (pwsh)",
    cmd: "Command Prompt",
    wsl: "WSL",
    zsh: "zsh",
    bash: "bash",
  };
  return `Shell unavailable for profile "${profile}" (${kinds[profile]}). Tried: ${attempted.join("; ")}`;
}

/** Candidates a failed resolution would have tried (for error paths). */
export function attemptedCandidates(profile: ShellProfile, deps: ShellResolverDeps = {}): string[] {
  const platform = deps.platform ?? process.platform;
  if (platform !== "win32") return [profile];
  if (profile === "powershell") {
    const env = deps.env ?? process.env;
    return [join(env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe")];
  }
  if (profile === "pwsh") {
    const env = deps.env ?? process.env;
    const out: string[] = [];
    if (env.ProgramFiles) out.push(join(env.ProgramFiles, "PowerShell", "7", "pwsh.exe"));
    out.push("pwsh.exe");
    return out;
  }
  return [profile];
}
