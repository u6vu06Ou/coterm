import { mkdtemp, realpath, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { spawn } from "@lydell/node-pty";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AppEventBus } from "../../src/main/core/event-bus";
import { PtyManager } from "../../src/main/terminal/pty-manager";

describe.skipIf(process.platform !== "win32")("Windows ConPTY profiles", () => {
  const profiles = [
    ["powershell", "Write-Output 'PTY_POWERSHELL_OK'; exit\r", "PTY_POWERSHELL_OK"],
    ["cmd", "echo PTY_CMD_OK&exit\r", "PTY_CMD_OK"],
    ...(hasWslDistribution()
      ? [["wsl", "echo PTY_WSL_OK; exit\r", "PTY_WSL_OK"] as const]
      : []),
  ] as const;
  let directory: string;
  let manager: PtyManager;
  let events: AppEventBus;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "ai-terminal-pty-"));
    events = new AppEventBus();
    manager = new PtyManager(events);
  });

  afterEach(async () => {
    manager.dispose();
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  it.each(profiles)(
    "runs Unicode-safe commands in %s",
    async (profile, command, marker) => {
      const terminal = manager.create({
        projectId: "69bf5cf4-f48a-46d8-8c65-a77f049e07e8",
        profile,
        cwd: directory,
        isAgent: false,
        agentProfile: null,
      });
      manager.resize(terminal.id, 90, 26);
      const output = await new Promise<string>((resolve, reject) => {
        let value = "";
        let exited = false;
        const timer = setTimeout(
          () => reject(new Error(`${profile} timed out: ${value}`)),
          25_000,
        );
        const cleanup = () => {
          clearTimeout(timer);
          events.off("terminalData", onData);
          events.off("terminalExit", onExit);
        };
        const complete = () => {
          if (!exited || !value.includes(marker)) return;
          cleanup();
          resolve(value);
        };
        const onData = (payload: { terminalId: string; data: string }) => {
          if (payload.terminalId !== terminal.id) return;
          value += payload.data;
          complete();
        };
        const onExit = (payload: { terminalId: string; exitCode: number }) => {
          if (payload.terminalId !== terminal.id) return;
          exited = true;
          complete();
        };
        events.on("terminalData", onData);
        events.on("terminalExit", onExit);
        manager.write(terminal.id, command);
      });

      expect(output).toContain(marker);
    },
    30_000,
  );

  // D — Structured shell integration (OSC 633). The pwsh bootstrap injects
  // markers; a successful and a failing command must each yield a
  // CommandResult with the exact (redacted) command and correct exit code.
  // cmd.exe has no markers → getLastCommand stays null (fallback).
  // NOTE: D is emitted by the wrapped prompt on the NEXT render, so test
  // commands must NOT call `exit` (that terminates the shell before the prompt
  // re-renders). Use commands that complete and return to the prompt.
  describe("OSC 633 shell integration", () => {
    it.skipIf(!hasSpawneablePwsh())("captures a successful pwsh command with exit code 0", async () => {
      const terminal = manager.create({
        projectId: "69bf5cf4-f48a-46d8-8c65-a77f049e07e8",
        profile: "pwsh",
        cwd: directory,
        isAgent: false,
        agentProfile: null,
      });
      const done = new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("pwsh OSC success timed out")), 25_000);
        const onCommand = (payload: { terminalId: string; result: { command: string; exitCode: number | null } }) => {
          if (payload.terminalId !== terminal.id) return;
          clearTimeout(timer);
          events.off("terminalCommand", onCommand);
          try {
            expect(payload.result.command).toContain("Write-Output");
            expect(payload.result.exitCode).toBe(0);
            expect(manager.getLastCommand(terminal.id)?.exitCode).toBe(0);
            resolve();
          } catch (error) { reject(error instanceof Error ? error : new Error(String(error))); }
        };
        events.on("terminalCommand", onCommand);
      });
      // Wait for the first prompt (markers injected), then run a command.
      await new Promise((r) => setTimeout(r, 1500));
      manager.write(terminal.id, "Write-Output 'OSC_OK'\r");
      await done;
    }, 30_000);

    it.skipIf(!hasSpawneablePwsh())("captures a failing pwsh command with non-zero exit code", async () => {
      const terminal = manager.create({
        projectId: "69bf5cf4-f48a-46d8-8c65-a77f049e07e8",
        profile: "pwsh",
        cwd: directory,
        isAgent: false,
        agentProfile: null,
      });
      const done = new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("pwsh OSC fail timed out")), 25_000);
        const onCommand = (payload: { terminalId: string; result: { exitCode: number | null } }) => {
          if (payload.terminalId !== terminal.id) return;
          clearTimeout(timer);
          events.off("terminalCommand", onCommand);
          try {
            expect(payload.result.exitCode).toBe(1);
            resolve();
          } catch (error) { reject(error instanceof Error ? error : new Error(String(error))); }
        };
        events.on("terminalCommand", onCommand);
      });
      await new Promise((r) => setTimeout(r, 1500));
      // cmd /c exit 1 runs a subprocess that exits 1, setting $LASTEXITCODE=1
      // and returning to the pwsh prompt (which emits the D marker).
      manager.write(terminal.id, "cmd /c exit 1\r");
      await done;
    }, 30_000);

    it("cmd fallback: getLastCommand is null (no OSC markers)", async () => {
      const terminal = manager.create({
        projectId: "69bf5cf4-f48a-46d8-8c65-a77f049e07e8",
        profile: "cmd",
        cwd: directory,
        isAgent: false,
        agentProfile: null,
      });
      await new Promise((r) => setTimeout(r, 800));
      manager.write(terminal.id, "echo CMD_NO_OSC\r");
      await new Promise((r) => setTimeout(r, 1500));
      expect(manager.getLastCommand(terminal.id)).toBeNull();
    }, 20_000);

    it.skipIf(!hasSpawneablePwsh())("updates cwd and does not carry a native failure into a later successful cmdlet", async () => {
      const terminal = manager.create({
        projectId: "69bf5cf4-f48a-46d8-8c65-a77f049e07e8",
        profile: "pwsh",
        cwd: directory,
        isAgent: false,
        agentProfile: null,
      });
      const nextResult = () => new Promise<{ command: string; cwd: string; exitCode: number | null }>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("pwsh OSC sequence timed out")), 25_000);
        const listener = (payload: { terminalId: string; result: { command: string; cwd: string; exitCode: number | null } }) => {
          if (payload.terminalId !== terminal.id) return;
          clearTimeout(timer);
          events.off("terminalCommand", listener);
          resolve(payload.result);
        };
        events.on("terminalCommand", listener);
      });

      await new Promise((resolve) => setTimeout(resolve, 1_500));
      let pending = nextResult();
      manager.write(terminal.id, "cmd /c exit 7\r");
      const failed = await pending;
      expect(failed.exitCode).toBe(1);

      pending = nextResult();
      manager.write(terminal.id, "Set-Location ..\r");
      const changedDirectory = await pending;
      expect(changedDirectory.exitCode).toBe(0);
      expect(changedDirectory.cwd).toBe(await realpath(directory));

      pending = nextResult();
      manager.write(terminal.id, "Write-Output 'AFTER_FAILURE'\r");
      const afterFailure = await pending;
      expect(afterFailure.exitCode).toBe(0);
      expect(afterFailure.cwd).toBe(await realpath(join(directory, "..")));
    }, 40_000);
  });
});

// A Store app-exec-alias pwsh.exe spawns fine via conpty on a normal desktop
// PATH but can fail under a heavily trimmed test PATH — skip rather than fail.
let pwshSpawnable: boolean | null = null;
function hasSpawneablePwsh(): boolean {
  if (process.platform !== "win32") return false;
  if (pwshSpawnable !== null) return pwshSpawnable;
  try {
    const p = spawn("pwsh.exe", ["-NoProfile", "-Command", "exit 0"], {
      name: "xterm-color",
      cols: 80,
      rows: 24,
      cwd: process.cwd(),
      env: process.env as Record<string, string>,
    });
    try {
      p.kill();
    } catch {
      // Already exited — still proves spawnability.
    }
    pwshSpawnable = true;
  } catch {
    pwshSpawnable = false;
  }
  return pwshSpawnable;
}

function hasWslDistribution(): boolean {
  if (process.platform !== "win32") return false;
  try {
    return execFileSync("wsl.exe", ["--list", "--quiet"], {
      encoding: "utf8",
      windowsHide: true,
      timeout: 5_000,
    }).replace(/\0/g, "").trim().length > 0;
  } catch {
    return false;
  }
}
