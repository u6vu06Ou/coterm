import { existsSync } from "node:fs";
import { join } from "node:path";

export type CliName = "claude" | "codex" | "gemini";

export function resolveCliExecutable(name: CliName): string {
  if (process.platform !== "win32") return name;

  if (name === "claude") {
    const appData = process.env.APPDATA;
    if (appData) {
      const executable = join(
        appData,
        "npm",
        "node_modules",
        "@anthropic-ai",
        "claude-code",
        "bin",
        "claude.exe",
      );
      if (existsSync(executable)) return executable;
    }
  }

  if (name === "codex") {
    const appData = process.env.APPDATA;
    if (appData) {
      const architecture = process.arch === "arm64" ? "aarch64" : "x86_64";
      const packageArchitecture = process.arch === "arm64" ? "arm64" : "x64";
      const executable = join(
        appData,
        "npm",
        "node_modules",
        "@openai",
        "codex",
        "node_modules",
        "@openai",
        `codex-win32-${packageArchitecture}`,
        "vendor",
        `${architecture}-pc-windows-msvc`,
        "bin",
        "codex.exe",
      );
      if (existsSync(executable)) return executable;
    }
  }

  return `${name}.exe`;
}
