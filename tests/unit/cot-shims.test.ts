import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ensureAgentShims, renderCotScripts } from "../../src/main/providers/agent-shims";

const cleanups: string[] = [];

afterEach(() => {
  for (const dir of cleanups.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("renderCotScripts", () => {
  const { ps1, cmd, bash } = renderCotScripts();

  it("cot.ps1 is the single implementation with the mail contract inlined", () => {
    // The failure path agents branch on.
    expect(ps1).toContain("function Cot-Fail");
    expect(ps1).toContain("exit 2");
    // Identity comes from the per-PTY env, never from arguments.
    expect(ps1).toContain("$env:COTERM_MAIL_URL");
    expect(ps1).toContain("$env:COTERM_MAIL_TOKEN");
    expect(ps1).toContain("Authorization = ('Bearer ' + $env:COTERM_MAIL_TOKEN)");
    // Text mode keeps agent-visible output to short lines.
    expect(ps1).toContain("Accept = 'text/plain'");
    expect(ps1).toContain("Invoke-RestMethod -Method Post");
    expect(ps1).toContain("'/send'");
    expect(ps1).toContain("'/who'");
    // PowerShell + .cmd keep CRLF line endings.
    expect(ps1).toContain("\r\n");
    expect(ps1.endsWith("\r\n")).toBe(true);
  });

  it("cot.cmd forwards to cot.ps1 and propagates the exit code", () => {
    expect(cmd).toContain("cot.ps1");
    expect(cmd).toContain("exit /b %ERRORLEVEL%");
  });

  it("the Git Bash forwarder is LF-only and resolves cot.ps1 via cygpath", () => {
    // CRLF under a shebang is brittle in Git Bash — the forwarder stays LF.
    expect(bash).not.toContain("\r");
    expect(bash.startsWith("#!/usr/bin/env bash")).toBe(true);
    expect(bash).toContain("cygpath");
    expect(bash).toContain("cot.ps1");
  });
});

describe("ensureAgentShims cot files", () => {
  it("writes cot.ps1 (with a BOM for PowerShell 5.1), cot.cmd, and cot, idempotently", () => {
    const userData = mkdtempSync(join(tmpdir(), "coterm-cot-shims-"));
    cleanups.push(userData);
    const dir = ensureAgentShims(userData, "http://127.0.0.1:8787", { registerPath: false });

    const ps1 = readFileSync(join(dir, "cot.ps1"), "utf8");
    // PS 5.1 mis-decodes UTF-8 without a BOM.
    expect(ps1.charCodeAt(0)).toBe(0xfeff);
    expect(ps1).toContain("function Cot-Fail");

    const cmd = readFileSync(join(dir, "cot.cmd"), "utf8");
    expect(cmd).toContain('powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0cot.ps1" %*');

    const bash = readFileSync(join(dir, "cot"), "utf8");
    expect(bash.startsWith("#!/usr/bin/env bash")).toBe(true);

    // Re-run with a different proxy URL: files must be rewritten, not skipped.
    const dir2 = ensureAgentShims(userData, "http://127.0.0.1:4999", { registerPath: false });
    expect(dir2).toBe(dir);
    expect(readFileSync(join(dir, "cot.ps1"), "utf8").charCodeAt(0)).toBe(0xfeff);
  });
});
