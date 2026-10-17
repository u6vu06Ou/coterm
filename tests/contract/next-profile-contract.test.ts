import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  MYQWEN_CLAUDE_CONTEXT_WINDOW,
  MYQWEN_CODEX_AUTO_COMPACT_TOKEN_LIMIT,
  MYQWEN_CODEX_CONTEXT_WINDOW,
  MYQWEN_MODEL,
} from "@shared/types";
import { providerProfileIdSchema } from "@shared/schema";
import { buildProfileEnv } from "../../src/main/providers/profiles-config";
import { ALL_SHIM_PROFILES, ensureAgentShims } from "../../src/main/providers/agent-shims";
import { buildCodexAppServerArguments, codexAppServerEnvironment } from "../../src/main/providers/codex-app-server";
import { supportedAgentProfiles } from "../../src/main/providers/agent-launch";
import { interactiveAgent, setInteractiveLauncherDir } from "../../src/renderer/src/components/interactive-agent";

const userData = mkdtempSync(join(tmpdir(), "coterm-next-profiles-"));
const launcherDir = ensureAgentShims(userData, "http://127.0.0.1:8787", { registerPath: false });
const nextProfiles = ["claude-local-long2", "codex-local-long2"] as const;

afterAll(() => {
  setInteractiveLauncherDir(null);
  rmSync(userData, { recursive: true, force: true });
});

describe("Issue #24 next profile contract", () => {
  it("registers every next-profile in the picker and shims", () => {
    for (const profile of nextProfiles) {
      expect(providerProfileIdSchema.parse(profile)).toBe(profile);
      expect(supportedAgentProfiles()).toContain(profile);
      expect(ALL_SHIM_PROFILES).toContain(profile);
    }
  });

  it("uses exact Claude aliases and correct context env per model", () => {
    const qwen = buildProfileEnv("claude-local-long2", "http://127.0.0.1:8787");
    expect(MYQWEN_MODEL).toBe("my-qwen");
    // Layered under the proxy clamp: 255,000 x 85% = 216,750 < ~219,545.
    expect(MYQWEN_CLAUDE_CONTEXT_WINDOW).toBe(255_000);
    expect(qwen.ANTHROPIC_MODEL).toBe(MYQWEN_MODEL);
    expect(qwen.CLAUDE_CODE_MAX_CONTEXT_TOKENS).toBe("255000");
    expect(qwen.CLAUDE_CODE_AUTO_COMPACT_WINDOW).toBe("255000");
    expect(qwen.CLAUDE_AUTOCOMPACT_PCT_OVERRIDE).toBe("85");
  });

  it("pins Codex model, CODEX_HOME, output and total-scope compaction", () => {
    for (const [profile, model] of [["codex-local-long2", MYQWEN_MODEL]] as const) {
      const shim = readFileSync(join(launcherDir, `${profile}.ps1`), "utf8");
      expect(shim).toContain(`$env:CODEX_HOME='${join(userData, "codex-homes", profile)}'`);
      expect(shim).toContain(`model="${model}"`);
      expect(shim).toContain("model_context_window=190000");
      expect(shim).toContain("model_max_output_tokens=32768");
      expect(shim).toContain("model_auto_compact_token_limit=170000");
      expect(shim).toContain('model_auto_compact_token_limit_scope="total"');
      expect(shim).not.toContain(`model="claude-${model}`);
    }
    expect(MYQWEN_CODEX_CONTEXT_WINDOW).toBe(190_000);
    expect(MYQWEN_CODEX_AUTO_COMPACT_TOKEN_LIMIT).toBe(170_000);
  });

  it("keeps app-server args/env isolated from paid Codex", () => {
    const source = { PATH: "bin", OPENAI_API_KEY: "paid-secret" };
    for (const [profile, model, key] of [
      ["codex-local-long2", MYQWEN_MODEL, "MYQWEN_API_KEY"],
    ] as const) {
      const args = buildCodexAppServerArguments(profile, "http://127.0.0.1:8787");
      expect(args).toContain(`model="${model}"`);
      expect(args).toContain("model_context_window=190000");
      expect(args).toContain("model_max_output_tokens=32768");
      expect(args).toContain("model_auto_compact_token_limit=170000");
      const env = codexAppServerEnvironment(profile, source);
      expect(env[key]).toBe("coterm-local-dev");
      expect(env.OPENAI_API_KEY).toBeUndefined();
    }
  });

  it("routes both interactive launch paths through their generated shims", () => {
    setInteractiveLauncherDir(launcherDir);
    for (const profile of nextProfiles) {
      const launch = interactiveAgent(profile, "http://127.0.0.1:8787");
      expect(launch?.command).toContain(`${profile}.ps1`);
      expect(launch?.agentProfile).toBe(profile);
    }
  });

  it("passes the exact model, context and isolated CODEX_HOME at PowerShell runtime", { timeout: 30_000 }, () => {
    const probe = spawnSync("pwsh", ["-NoProfile", "-Command", "$PSVersionTable.PSVersion"], { encoding: "utf8" });
    if (probe.status !== 0) return;

    for (const [profile, model] of [["codex-local-long2", MYQWEN_MODEL]] as const) {
      const output = join(userData, `${profile}-runtime.json`);
      const shim = join(launcherDir, `${profile}.ps1`);
      const script = [
        "function codex {",
        `  $payload = [ordered]@{ home = $env:CODEX_HOME; args = @($args) }`,
        `  [IO.File]::WriteAllText('${ps(output)}', ($payload | ConvertTo-Json -Compress), [Text.UTF8Encoding]::new($false))`,
        "}",
        `& '${ps(shim)}' -Task 'runtime-probe'`,
      ].join("; ");
      const result = spawnSync("pwsh", ["-NoProfile", "-Command", script], { encoding: "utf8" });
      expect(result.status, result.stderr || result.stdout).toBe(0);
      const actual = JSON.parse(readFileSync(output, "utf8")) as { home: string; args: string[] };
      expect(actual.home).toBe(join(userData, "codex-homes", profile));
      expect(actual.args).toContain(`model="${model}"`);
      expect(actual.args).toContain("model_context_window=190000");
      expect(actual.args).toContain("model_max_output_tokens=32768");
      expect(actual.args).toContain("model_auto_compact_token_limit=170000");
      expect(actual.args).toContain('model_auto_compact_token_limit_scope="total"');
      expect(actual.args).not.toContain("model_provider=\"openai\"");
    }

    for (const [profile, model] of [["claude-local-long2", MYQWEN_MODEL]] as const) {
      const output = join(userData, `${profile}-runtime.json`);
      const shim = join(launcherDir, `${profile}.ps1`);
      const script = [
        "function claude {",
        "  $payload = [ordered]@{ model = $env:ANTHROPIC_MODEL; max = $env:CLAUDE_CODE_MAX_CONTEXT_TOKENS; compact = $env:CLAUDE_CODE_AUTO_COMPACT_WINDOW; pct = $env:CLAUDE_AUTOCOMPACT_PCT_OVERRIDE; args = @($args) }",
        `  [IO.File]::WriteAllText('${ps(output)}', ($payload | ConvertTo-Json -Compress), [Text.UTF8Encoding]::new($false))`,
        "}",
        `& '${ps(shim)}' -Task 'runtime-probe'`,
      ].join("; ");
      const result = spawnSync("pwsh", ["-NoProfile", "-Command", script], { encoding: "utf8" });
      expect(result.status, result.stderr || result.stdout).toBe(0);
      const actual = JSON.parse(readFileSync(output, "utf8")) as {
        model: string; max: string; compact: string; pct: string; args: string[];
      };
      expect(actual.model).toBe(model);
      // 255,000 keeps client compaction under the proxy clamp (~219,545).
      const expectedMax = "255000";
      expect(actual.max).toBe(expectedMax);
      expect(actual.compact).toBe(expectedMax);
      expect(actual.pct).toBe("85");
      expect(actual.args).toContain(model);
    }
  });
});

function ps(value: string): string {
  return value.replaceAll("'", "''");
}
