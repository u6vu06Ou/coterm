import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ALL_SHIM_PROFILES, codexHomeForProfile, codexProfileHomesFor, ensureAgentShims, pruneTempLauncherEntries } from "../../src/main/providers/agent-shims";
import { buildActiveProfiles } from "../../src/main/providers/profiles-config";
import { buildAgentLaunchCommand } from "../../src/main/providers/agent-launch";
import { MYGLMMAX_MODEL } from "../../src/shared/types";

/** #51a: shim generation + launch-command shrink. */
describe("agent launcher shims", () => {
  it("keeps Codex Team interactive and on the official account", () => {
    const table = buildActiveProfiles({ "codex-team": {label: "Codex Team", local: false, configProfile: "codex-team", env: {}} });
    ensureAgentShims(userData, "http://127.0.0.1:8787", {registerPath: false, profileTable: table});
    const content = readFileSync(join(userData, "agent-launchers", "codex-team.ps1"), "utf8");
    expect(content).toContain("'--profile', 'codex-team'");
    expect(content).toContain("$env:CODEX_HOME=$null");
    expect(content).not.toContain("TEAM_API_KEY");
    expect(content).not.toContain("model_provider");
    expect(content).not.toContain("'exec'");
    expect(existsSync(join(userData, "codex-homes", "codex-team"))).toBe(false);
  });
  let userData: string;

  beforeEach(() => {
    userData = mkdtempSync(join(tmpdir(), "coterm-shims-"));
    ensureAgentShims(userData, "http://127.0.0.1:8787", { registerPath: false });
  });

  afterEach(() => {
    rmSync(userData, { recursive: true, force: true });
  });

  it("writes one shim per shimmed profile (8 free + 4 paid/local)", () => {
    expect(ALL_SHIM_PROFILES.length).toBe(12);
    for (const profile of ALL_SHIM_PROFILES) {
      const content = readFileSync(join(userData, "agent-launchers", `${profile}.ps1`), "utf8");
      expect(content.charCodeAt(0)).toBe(0xfeff);
      expect(content.length).toBeGreaterThan(0);
    }
  });

  // #92: the home map handed to the context meter must be derived from the
  // ACTIVE table, not a hardcoded builtin list — a hot-registered codex profile
  // gets its own private home from the shim writer, so the meter has to read
  // that same home or it falls back to ~/.codex and loses the thread title.
  it("derives private Codex homes from the ACTIVE profile table, including hot-registered profiles", () => {
    const table = buildActiveProfiles({
      "codex-local-deep": { local: true, model: "my-ds", env: {} },
    });
    const homes = codexProfileHomesFor(userData, table);
    expect(homes["codex-local-deep"]).toBe(join(userData, "codex-homes", "codex-local-deep"));
    // Builtins stay present — overlay, not replace.
    expect(homes["codex-local-main"]).toBe(join(userData, "codex-homes", "codex-local-main"));
    // The legacy shared-home profile gets no private home, and neither does
    // the paid official CLI.
    expect(homes["codex-local-long"]).toBeUndefined();
    expect(homes["codex-official"]).toBeUndefined();
    // And the shim writer really does seed the same directory it advertises.
    ensureAgentShims(userData, "http://127.0.0.1:8787", { registerPath: false, profileTable: table });
    expect(existsSync(join(userData, "codex-homes", "codex-local-deep", "config.toml"))).toBe(true);
  });

  it("derives private Codex homes from the same profile mapping used by shims", () => {
        expect(codexHomeForProfile(userData, "codex-local-main")).toBe(join(userData, "codex-homes", "codex-local-main"));
    expect(codexHomeForProfile(userData, "codex-local-max")).toBe(join(userData, "codex-homes", "codex-local-max"));
    expect(codexHomeForProfile(userData, "codex-official")).toBeNull();
  });

  // The launcher flag alone does not survive the Codex TUI's first-run trust
  // flow in a virgin CODEX_HOME: the session lands on approval_policy
  // "on-request" + workspace-write + network off, so the window starts asking
  // for approvals. config.toml is what actually pins the yolo posture.
  it("seeds each private CODEX_HOME with a yolo config.toml", () => {
    for (const profile of ["codex-local-long2", "codex-local-main", "codex-local-max"]) {
      const config = readFileSync(join(userData, "codex-homes", profile, "config.toml"), "utf8");
      expect(config).toContain('approval_policy = "never"');
      expect(config).toContain('sandbox_mode = "danger-full-access"');
      expect(config).toContain('preferred_auth_method = "apikey"');
    }
  });

  it("does not clobber an existing Codex config.toml or duplicate its keys", () => {
    const target = join(userData, "codex-homes", "codex-local-long2", "config.toml");
    const before = readFileSync(target, "utf8");
    writeFileSync(target, `${before}\n[projects.'d:\\Coterm']\ntrust_level = "trusted"\n`, "utf8");
    ensureAgentShims(userData, "http://127.0.0.1:8787", { registerPath: false });
    const after = readFileSync(target, "utf8");
    expect(after).toContain('trust_level = "trusted"');
    expect(after.match(/^\s*approval_policy\s*=/gm)).toHaveLength(1);
  });

  it("claude-local-main shim carries the proxy env and model", () => {
    const content = readFileSync(join(userData, "agent-launchers", "claude-local-main.ps1"), "utf8");
    expect(content).toContain("$env:ANTHROPIC_BASE_URL='http://127.0.0.1:8787'");
    expect(content).toContain("$env:ANTHROPIC_MODEL='my-glm-flash'");
    expect(content).toContain("$env:CLAUDE_CODE_MAX_CONTEXT_TOKENS='200000'");
    expect(content).toContain("$env:CLAUDE_CODE_AUTO_COMPACT_WINDOW='200000'");
    expect(content).toContain("$env:CLAUDE_AUTOCOMPACT_PCT_OVERRIDE='85'");
    expect(content).toContain("$env:CLAUDE_CODE_DISABLE_AGENT_VIEW='1'");
    expect(content).toContain("claude @cmdArgs");
  });

  it("codex-local-long2 shim carries the qwen provider config and key", () => {
    const content = readFileSync(join(userData, "agent-launchers", "codex-local-long2.ps1"), "utf8");
    expect(content).toContain("$env:MYQWEN_API_KEY=");
    expect(content).toContain("model_provider=\"myqwen\"");
    expect(content).toContain("model=\"my-qwen\"");
    expect(content).toContain("model_context_window=190000");
    expect(content).toContain("model_auto_compact_token_limit=170000");
    expect(content).toContain("model_auto_compact_token_limit_scope=\"total\"");
    expect(content).toContain("codex @cmdArgs");
  });

  it("codex-local-main shim uses its private Coterm CODEX_HOME and GLM Local Flash", () => {
    const content = readFileSync(join(userData, "agent-launchers", "codex-local-main.ps1"), "utf8");
    expect(content).toContain(`$env:CODEX_HOME='${join(userData, "codex-homes", "codex-local-main")}'`);
    expect(content).toContain("$env:GLM_API_KEY=");
    expect(content).toContain('model="my-glm-flash"');
    expect(content).toContain("model_context_window=170000");
  });

  it("codex-local-max shim uses its private Coterm CODEX_HOME and GLM Local Max", () => {
    const content = readFileSync(join(userData, "agent-launchers", "codex-local-max.ps1"), "utf8");
    expect(content).toContain(`$env:CODEX_HOME='${join(userData, "codex-homes", "codex-local-max")}'`);
    expect(content).toContain("$env:MYGLMMAX_API_KEY=");
    expect(content).toContain(`model="${MYGLMMAX_MODEL}"`);
    expect(content).toContain("model_context_window=170000");
  });

  it("buildAgentLaunchCommand shrinks to a shim call once shims exist", () => {
    const command = buildAgentLaunchCommand("claude-local-main", "D:\\proj", null, null);
    expect(command).toContain("agent-launchers\\claude-local-main.ps1'");
    expect(command).not.toContain("ANTHROPIC_BASE_URL=");
    const resumed = buildAgentLaunchCommand("codex-local-main", "D:\\proj", null, "11111111-2222-3333-4444-555555555555");
    expect(resumed).toContain("-Resume '11111111-2222-3333-4444-555555555555'");
  });

  it("official/gemini shims carry their pay-side semantics", () => {
    const claudeOfficial = readFileSync(join(userData, "agent-launchers", "claude-official.ps1"), "utf8");
    expect(claudeOfficial).toContain("$env:ANTHROPIC_BASE_URL=$null");
    expect(claudeOfficial).toContain("if ($Model)");
    const codexOfficial = readFileSync(join(userData, "agent-launchers", "codex-official.ps1"), "utf8");
    expect(codexOfficial).toContain("$env:CODEX_HOME=$null");
    expect(codexOfficial).toContain("resume $Resume");
    const gemini = readFileSync(join(userData, "agent-launchers", "gemini.ps1"), "utf8");
    expect(gemini).toContain("GEMINI_API_KEY");
    expect(gemini).toContain("gemini --yolo");
  });

  // 11 real pwsh spawns serialized; during `dist` the build keeps CPU hot and
  // each cold pwsh start crawls — needs a timeout far past the 15s default.
  it("every generated shim parses as valid PowerShell", { timeout: 120_000 }, () => {
    // pwsh ships with the desktop app flow; skip where absent (CI linux).
    const probe = spawnSync("pwsh", ["-NoProfile", "-Command", "$PSVersionTable.PSVersion"], { encoding: "utf8" });
    if (probe.status !== 0) return;
    // Cover the proxy-watchdog bootstrap line, which only renders when set.
    const previousProxyDir = process.env.COTERM_PROXY_DIR;
    process.env.COTERM_PROXY_DIR = userData;
    try {
      ensureAgentShims(userData, "http://127.0.0.1:8787", { registerPath: false });
    } finally {
      if (previousProxyDir === undefined) delete process.env.COTERM_PROXY_DIR;
      else process.env.COTERM_PROXY_DIR = previousProxyDir;
    }
    for (const profile of ALL_SHIM_PROFILES) {
      const file = join(userData, "agent-launchers", `${profile}.ps1`).replaceAll("'", "''");
      const result = spawnSync("pwsh", [
        "-NoProfile", "-Command",
        `$errs = $null; [void][System.Management.Automation.Language.Parser]::ParseFile('${file}', [ref]$null, [ref]$errs); if ($errs.Count) { $errs | ForEach-Object { $_.Message }; exit 1 }`,
      ], { encoding: "utf8" });
      expect(result.status, `${profile}.ps1: ${result.stdout}`).toBe(0);
    }
  });
});

describe("pruneTempLauncherEntries (private #62)", () => {
  it("drops e2e temp launcher dirs, keeps everything else", () => {
    const root = "C:\\Users\\User\\AppData\\Local\\Temp";
    const entries = [
      "C:\\Windows\\System32",
      "C:\\Users\\User\\AppData\\Roaming\\npm",
      `${root}\\coterm-action-vy2ybg\\agent-launchers`,
      `${root}\\ai-terminal-packaged-e2e-7te8LU\\agent-launchers`,
      "C:\\Users\\User\\AppData\\Roaming\\Coterm\\agent-launchers",
      `${root}\\other-tool-cache`,
    ];
    const pruned = pruneTempLauncherEntries(entries, root);
    expect(pruned).toEqual([
      "C:\\Windows\\System32",
      "C:\\Users\\User\\AppData\\Roaming\\npm",
      "C:\\Users\\User\\AppData\\Roaming\\Coterm\\agent-launchers",
      `${root}\\other-tool-cache`,
    ]);
  });
});
