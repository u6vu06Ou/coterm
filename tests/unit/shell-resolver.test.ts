// public #10: powershell = Windows PowerShell 5.1 EXPLICITLY (never pwsh 7).
// pwsh uses the v1.4 legacy passthrough: preferred paths first, bare name last
// — verification-by-existsSync was reverted because Store app-exec-aliases are
// invisible to stat but spawn fine through conpty (maintainer's call, 2026-08-04).
import { afterEach, describe, expect, it, vi } from "vitest";
import { delimiter, join } from "node:path";
import {
  attemptedCandidates,
  formatShellUnavailable,
  resolveShell,
} from "../../src/main/terminal/shell-resolver";

const PF = "C:\\Program Files";
const SYS32_PS = join("C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
const PWSH7_MSI = join(PF, "PowerShell", "7", "pwsh.exe");
const SCOOP_PWSH = join("C:\\Tools", "pwsh.exe");

function deps(existing: string[], envOverrides: NodeJS.ProcessEnv = {}) {
  return {
    exists: (path: string) => existing.includes(path),
    env: {
      SystemRoot: "C:\\Windows",
      ProgramFiles: PF,
      PATH: `C:\\Windows\\System32${delimiter}C:\\Tools`,
      ComSpec: "C:\\Windows\\System32\\cmd.exe",
      ...envOverrides,
    } as NodeJS.ProcessEnv,
    platform: "win32" as const,
  };
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("shell resolver matrix (public #10)", () => {
  it("powershell resolves Windows PowerShell 5.1 explicitly, never pwsh", () => {
    const resolution = resolveShell("powershell", deps([SYS32_PS, PWSH7_MSI]));
    expect(resolution).not.toBeNull();
    expect(resolution!.kind).toBe("powershell5");
    expect(resolution!.executable).toBe(SYS32_PS);
    expect(resolution!.executable).not.toContain("PowerShell\\7");
  });

  it("powershell falls back to a PATH-verified powershell.exe", () => {
    const pathPs = join("C:\\Windows\\System32", "powershell.exe");
    const resolution = resolveShell("powershell", deps([pathPs]));
    expect(resolution!.kind).toBe("powershell5");
    expect(resolution!.executable).toBe(pathPs);
  });

  it("pwsh prefers the well-known PowerShell/7 install", () => {
    const resolution = resolveShell("pwsh", deps([PWSH7_MSI, SCOOP_PWSH]));
    expect(resolution!.kind).toBe("pwsh7");
    expect(resolution!.executable).toBe(PWSH7_MSI);
  });

  it("pwsh resolves from PATH when installed outside ProgramFiles", () => {
    const resolution = resolveShell("pwsh", deps([SCOOP_PWSH]));
    expect(resolution!.kind).toBe("pwsh7");
    expect(resolution!.executable).toBe(SCOOP_PWSH);
  });

  it("pwsh prefers the Microsoft Store install (Appx query) over PATH entries", () => {
    const STORE = "C:\\Program Files\\WindowsApps\\Microsoft.PowerShell_7.6.4.0_x64__8wekyb3d8bbwe\\pwsh.exe";
    const resolution = resolveShell("pwsh", { ...deps([SCOOP_PWSH]), queryStorePwsh: () => STORE });
    expect(resolution!.kind).toBe("pwsh7");
    expect(resolution!.executable).toBe(STORE);
  });

  it("re-queries the Microsoft Store path when an update removes the cached version", async () => {
    vi.resetModules();
    const { resolveShell: freshResolveShell } = await import("../../src/main/terminal/shell-resolver");
    const OLD = "C:\\Program Files\\WindowsApps\\Microsoft.PowerShell_7.6.4.0_x64__8wekyb3d8bbwe\\pwsh.exe";
    const CURRENT = "C:\\Program Files\\WindowsApps\\Microsoft.PowerShell_7.6.5.0_x64__8wekyb3d8bbwe\\pwsh.exe";
    let installed = OLD;
    let queries = 0;
    const d = {
      ...deps([]),
      exists: (path: string) => path === installed,
      queryStorePwsh: () => {
        queries += 1;
        return installed;
      },
    };

    expect(freshResolveShell("pwsh", d)!.executable).toBe(OLD);
    installed = CURRENT;
    expect(freshResolveShell("pwsh", d)!.executable).toBe(CURRENT);
    expect(queries).toBe(2);
  });

  it("a null Appx query still falls through to the PATH scan", () => {
    const resolution = resolveShell("pwsh", { ...deps([SCOOP_PWSH]), queryStorePwsh: () => null });
    expect(resolution!.executable).toBe(SCOOP_PWSH);
  });

  it("unverifiable pwsh falls back to the bare name (legacy passthrough — Store aliases spawn fine via conpty)", () => {
    const resolution = resolveShell("pwsh", deps([]));
    expect(resolution).not.toBeNull();
    expect(resolution!.kind).toBe("pwsh7");
    expect(resolution!.executable).toBe("pwsh.exe");
    expect(resolution!.attempted).toContain("pwsh.exe");
    expect(resolveShell("pwsh", deps([], { ProgramFiles: undefined }))!.executable).toBe("pwsh.exe");
  });

  it("missing powershell (theoretical) is also a detectable failure", () => {
    expect(resolveShell("powershell", deps([], { PATH: "" }))).toBeNull();
  });

  it("cmd/wsl/zsh/bash keep their existing behavior", () => {
    expect(resolveShell("cmd", deps([]))!.executable).toBe("C:\\Windows\\System32\\cmd.exe");
    expect(resolveShell("wsl", deps([]))!.executable).toBe("wsl.exe");
    expect(resolveShell("zsh", deps([], {} ), )!.executable).toBe("zsh");
    expect(resolveShell("bash", deps([]))!.executable).toBe("bash");
  });

  it("non-win32 keeps bare-name behavior", () => {
    const resolution = resolveShell("pwsh", { platform: "darwin", env: {} });
    expect(resolution!.executable).toBe("pwsh.exe");
  });

  it("failure text names profile + shell kind + candidates, and leaks no env values", () => {
    const secretPath = "D:\\secret-path-with-token";
    const d = deps([], { PATH: secretPath, SystemRoot: undefined });
    expect(resolveShell("powershell", d)).toBeNull();
    const message = formatShellUnavailable("powershell", attemptedCandidates("powershell", { env: {} }));
    expect(message).toContain('"powershell"');
    expect(message).toContain("Windows PowerShell 5.1");
    expect(message).toContain(SYS32_PS);
    expect(message).not.toContain(secretPath);
  });
});
