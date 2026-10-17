import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import {
  resolveCodexAuthToken,
  resolveCodexBaseUrl,
  resolveCodexProfileSpec,
} from "@shared/codex-profiles";
import { logger } from "../core/logger";
import { ensureCodexTeamConfig } from "./codex-team-setup";
import {
  DEFAULT_AUTH_TOKEN,
  DEFAULT_PROXY_URL,
  DEFAULT_PROFILES,
  type ClaudeProfile,
  buildProfileEnv,
} from "./profiles-config";

/**
 * Built-in codex free profiles. The hot model registry (stage 2, codex half)
 * also admits registered `codex-` entries from the ACTIVE table below — a
 * custom codex profile entry with `local: true` is API-launchable; `local:
 * false` (public provider) stays off the allowlist (fail-closed boundary).
 */
export const CODEX_AGENT_PROFILES = [
  "codex-local-main",
  "codex-local-max",
  "codex-local-long",
  "codex-local-long2",
] as const;

/**
 * Agent API/API launch allowlist derived from an ACTIVE profile table: every
 * profile flagged local (loopback proxy) — claude AND registered custom codex
 * entries — plus the static codex free list (Set-deduped: a custom entry
 * shadowing a builtin codex id must not list it twice). `local: false`
 * profiles never enter — paid/official providers must stay non-API-launchable
 * (fail-closed boundary, agent-api relies on this).
 */
export function supportedAgentProfilesFor(profileTable: Record<string, ClaudeProfile>): string[] {
  const free = Object.keys(profileTable).filter((id) => profileTable[id]?.local);
  return [...new Set([...free, ...CODEX_AGENT_PROFILES])];
}

/**
 * Shim filename allowlist for an ACTIVE profile table: the table's keys (claude
 * harness) plus the codex free list and the paid/local CLI extras.
 */
export function allShimProfilesFor(profileTable: Record<string, ClaudeProfile>): string[] {
  return [
    ...new Set([...Object.keys(profileTable), ...CODEX_AGENT_PROFILES, ...EXTRA_SHIM_PROFILES]),
  ];
}

/** Paid/local CLIs get shims too (typing `claude-official` beats an env wall),
 *  but stay OFF the Agent API launch allowlist — only free profiles are API-launchable. */
export const EXTRA_SHIM_PROFILES = ["claude-official", "codex-official", "gemini"] as const;

/** Free proxy profiles built from the built-in table — also the Agent API/allowlist boundary. */
export const SUPPORTED_AGENT_PROFILES = supportedAgentProfilesFor(DEFAULT_PROFILES);

export const ALL_SHIM_PROFILES = allShimProfilesFor(DEFAULT_PROFILES);

/**
 * Per-profile PowerShell launcher shims (#51). The inline launch command used
 * to paste a dozen `$env:` assignments plus a long flags line into the PTY;
 * now main generates `<userData>/agent-launchers/<profile>.ps1` once per app
 * start and the visible command shrinks to `& '<shim>' [-Resume id] [-Task t]`.
 * The shim dir is appended to the user PATH (registry) and process.env.PATH so
 * typing `claude-local-main` in any Coterm pwsh tile also works.
 */

let launcherDir: string | null = null;

/**
 * Codex profiles that get their own private CODEX_HOME under userData.
 *
 * Derived from the SAME predicate the shim writer uses (spec.home ===
 * "private" over the ACTIVE shim profile set) instead of a hardcoded list.
 * The old three-entry constant drifted the moment a profile was hot-registered:
 * `ensureAgentShims` created a private home for every private-spec profile
 * (agent-shims.ts, the `ensureCodexYoloConfig` call), while the context meter
 * was only ever handed the three builtins — so a registered `codex-local-deep` /
 * `codex-local-big` wrote its rollouts into its own home and the meter fell back to
 * `~/.codex`, read the wrong threads table, and lost the generated title
 * (#92). One source of truth now: whatever the shim seeds, the meter reads.
 */
export function privateCodexHomeProfilesFor(
  profileTable: Record<string, ClaudeProfile> = DEFAULT_PROFILES,
): string[] {
  return allShimProfilesFor(profileTable).filter(
    (profile) => resolveCodexProfileSpec(profile, profileTable)?.home === "private",
  );
}

export function codexHomeForProfile(
  userDataPath: string,
  profile: string,
  profileTable: Record<string, ClaudeProfile> = DEFAULT_PROFILES,
): string | null {
  return privateCodexHomeProfilesFor(profileTable).includes(profile)
    ? join(userDataPath, "codex-homes", profile)
    : null;
}

/**
 * userData path map for every private-home profile in the ACTIVE table — the
 * shape ContextBatteryMonitor consumes. Re-derive per call (main wires it as a
 * getter): a profile registered after startup must land in the map without a
 * restart, exactly like the shim regeneration on `profilesChanged`.
 */
export function codexProfileHomesFor(
  userDataPath: string,
  profileTable: Record<string, ClaudeProfile> = DEFAULT_PROFILES,
): Record<string, string> {
  const homes: Record<string, string> = {};
  for (const profile of privateCodexHomeProfilesFor(profileTable)) {
    homes[profile] = join(userDataPath, "codex-homes", profile);
  }
  return homes;
}

/**
 * Seed a private CODEX_HOME with the same yolo posture the other Codex homes
 * already carry (`~/.codex`, `codex_long`).
 *
 * Why the CLI flag is not enough: a virgin CODEX_HOME has no config.toml, and
 * the interactive TUI then runs its first-launch trust flow, which lands the
 * session on `approval_policy = "on-request"` +
 * `sandbox_policy = workspace-write` + `network_access = false` — measured in
 * the rollout's own turn_context — even though the launcher passes
 * `--dangerously-bypass-approvals-and-sandbox`. `codex exec` in the same home
 * does honour the flag, so the wall only shows up in the window the user
 * actually types into: it asks to approve commands and blocks network.
 *
 * Written once. An existing config.toml is left alone (the TUI writes trust and
 * NUX state into it), and only the missing top-level keys are appended, so a
 * hand-edited home is never clobbered.
 */
function ensureCodexYoloConfig(codexHome: string): void {
  const target = join(codexHome, "config.toml");
  const required: Array<[string, string]> = [
    ["approval_policy", 'approval_policy = "never"'],
    ["sandbox_mode", 'sandbox_mode = "danger-full-access"'],
    ["preferred_auth_method", 'preferred_auth_method = "apikey"'],
  ];
  try {
    const existing = existsSync(target) ? readFileSync(target, "utf8") : "";
    // Only top-level assignments count: a `key = ...` inside a [table] means
    // something else entirely, and every required key here is top-level.
    const topLevel = existing.split(/\r?\n/).findIndex((line) => /^\s*\[/.test(line));
    const preamble = topLevel === -1 ? existing : existing.split(/\r?\n/).slice(0, topLevel).join("\n");
    const missing = required.filter(([key]) => !new RegExp(`^\\s*${key}\\s*=`, "m").test(preamble));
    if (existing && missing.length === 0) return;
    const header = "# Coterm-managed defaults for this profile's private CODEX_HOME.\n"
      + "# Keeps the window yolo (no approval prompts, no sandbox, network on);\n"
      + "# the launcher flag alone does not survive the TUI's first-run trust flow.\n";
    const block = missing.map(([, line]) => line).join("\n");
    writeFileSync(target, existing ? `${header}${block}\n${existing}` : `${header}${block}\n`, "utf8");
    logger.info("provider", "agent.shims.codex_home_seeded", "Seeded Codex home defaults.", {
      codexHome,
      added: missing.map(([key]) => key),
    });
  } catch (error) {
    logger.warn("provider", "agent.shims.codex_home_failed", "Could not seed Codex home defaults.", {
      codexHome,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

export function getLauncherDir(): string | null {
  return launcherDir;
}

export function shimCommand(profile: string, dir: string, args: string[] = []): string {
  const shim = join(dir, `${profile}.ps1`).replaceAll("'", "''");
  return [`& '${shim}'`, ...args].filter(Boolean).join(" ");
}

export function ensureAgentShims(
  userDataPath: string,
  proxyUrl = DEFAULT_PROXY_URL,
  options: {
    registerPath?: boolean;
    profileTable?: Record<string, ClaudeProfile>;
    codexTeamTemplateDir?: string | undefined;
  } = {},
): string {
  // Hot model registry: shim names + claude shim bodies derive from the ACTIVE
  // table (DEFAULT_PROFILES \u2295 settings.customProfiles) so custom profiles get
  // their own <id>.ps1 with their own model/env.
  const profileTable = options.profileTable ?? DEFAULT_PROFILES;
  const shimProfiles = allShimProfilesFor(profileTable);
  const dir = join(userDataPath, "agent-launchers");
  mkdirSync(dir, { recursive: true });
  for (const profile of shimProfiles) {
    const target = join(dir, `${profile}.ps1`);
    // Stage 2 (codex half): private CODEX_HOME gating is spec-driven now \u2014
    // the three private-home builtins plus any registered custom codex- entry
    // (their derived specs say home: "private"); the legacy qwen-home and
    // unregistered ids skip mkdir/yolo exactly as before.
    const spec = resolveCodexProfileSpec(profile, profileTable);
    // Only a "private" spec reads this argument (the qwen/legacy branches use
    // their own env-provided home), so it is safe to compute it unconditionally.
    const codexHome = join(userDataPath, "codex-homes", profile);
    if (spec?.home === "private") {
      mkdirSync(codexHome, { recursive: true });
      ensureCodexYoloConfig(codexHome);
    }
    // Codex Team bootstrap (#100 follow-up): official-home codex profiles using
    // the codex-team configProfile get ~/.codex/codex-team.config.toml rendered
    // from the bundled template. Defensive: a failed render never breaks shim
    // generation, and callers without a template dir (tests) skip cleanly.
    if (spec?.home === "official" && spec.configProfile === "codex-team" && options.codexTeamTemplateDir) {
      try {
        const status = ensureCodexTeamConfig({
          templateDir: options.codexTeamTemplateDir,
          execPath: process.execPath,
          proxyUrl,
        });
        logger.info("provider", "codex-team.config.envelope", "Codex Team config setup attempted.", { status });
      } catch (error) {
        logger.warn("provider", "codex-team.setup-error", "Codex Team config setup threw unexpectedly.", {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    // Windows PowerShell 5.1 requires a BOM to decode the Chinese diagnostics.
    writeFileSync(target, `\uFEFF${renderShim(profile, proxyUrl, codexHome, profileTable)}`, "utf8");
  }
  // Cross-pane agent mail CLI: cot.ps1 is the single implementation (pwsh 7 and
  // Windows PowerShell 5.1 resolve `cot` → cot.ps1 natively); cot.cmd for cmd,
  // extensionless cot for Git Bash both forward to it. Additive on purpose —
  // the profile shims above stay byte-pinned by tests/unit/agent-shims.test.ts.
  const cot = renderCotScripts();
  const BOM = String.fromCharCode(0xfeff); // PS 5.1 needs a BOM for clean decoding.
  writeFileSync(join(dir, "cot.ps1"), `${BOM}${cot.ps1}`, "utf8");
  writeFileSync(join(dir, "cot.cmd"), cot.cmd, "utf8");
  writeFileSync(join(dir, "cot"), cot.bash, "utf8");
  launcherDir = dir;
  if (options.registerPath !== false) injectPath(dir);
  logger.info("provider", "agent.shims.ready", "Agent launcher shims refreshed.", {
    dir,
    profiles: shimProfiles.length,
  });
  return dir;
}

function renderShim(
  profile: string,
  proxyUrl: string,
  codexHome: string,
  profileTable: Record<string, ClaudeProfile>,
): string {
  const header = `# Coterm agent launcher: ${profile}. Regenerated at app start; edit profiles.json, not this file.`;
  const bootstrap = [
    header,
    profile === "claude-official"
      ? "param([string]$Resume = '', [string]$Task = '', [string]$SessionId = '', [string]$Model = '')"
      : "param([string]$Resume = '', [string]$Task = '', [string]$SessionId = '')",
    "$ErrorActionPreference = 'Stop'",
  ];
  // Proxy watchdog bootstrap only for proxy-routed free profiles — paid/local
  // CLIs shouldn't sleep 3s waiting on a proxy they never call.
  const proxyDir = process.env.COTERM_PROXY_DIR?.trim() ?? "";
  if (proxyDir && supportedAgentProfilesFor(profileTable).includes(profile)) {
    const watchdog = join(proxyDir, "llm-proxy", "proxy_watchdog.py").replaceAll("'", "''");
    bootstrap.push(
      `if (-not (netstat -an | Select-String ':8787 .*LISTENING')) { Start-Process -WindowStyle Hidden -FilePath 'cmd.exe' -ArgumentList '/c', 'python', '"${watchdog}"'; Start-Sleep -Seconds 3 }`,
    );
  }
  const body =
    profile === "gemini" ? geminiShimBody()
    : profile === "claude-official" ? claudeOfficialShimBody()
    : profile === "codex-official" ? codexOfficialShimBody()
    : profile.startsWith("codex-") ? codexShimBody(profile, proxyUrl, codexHome, profileTable)
    : claudeShimBody(profile, proxyUrl, profileTable);
  return `${[...bootstrap, ...body].join("\r\n")}\r\n`;
}

function claudeOfficialShimBody(): string[] {
  return [
    `if (-not (Get-Command claude -ErrorAction SilentlyContinue)) { Write-Host '找不到 claude CLI（npm i -g @anthropic-ai/claude-code，或執行 claude auth login）' -ForegroundColor Yellow; return }`,
    "$env:ANTHROPIC_BASE_URL=$null; $env:ANTHROPIC_AUTH_TOKEN=$null; $env:ANTHROPIC_MODEL=$null; $env:ANTHROPIC_SMALL_FAST_MODEL=$null",
    "$env:CLAUDE_CODE_WORKFLOWS='1'",
    "$env:CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS='1'",
    "$env:CLAUDE_CODE_DISABLE_AGENT_VIEW='1'",
    "$cmdArgs = @('--dangerously-skip-permissions', '--teammate-mode', 'in-process')",
    "if ($Model) { $cmdArgs = @('--model', $Model) + $cmdArgs }",
    "if ($Resume) { $cmdArgs += @('--resume', $Resume) }",
    "if ($SessionId) { $cmdArgs += @('--session-id', $SessionId) }",
    "if ($Task) { $cmdArgs += @('-p', $Task) }",
    "claude @cmdArgs",
  ];
}

function codexOfficialShimBody(): string[] {
  return [
    `if (-not (Get-Command codex -ErrorAction SilentlyContinue)) { Write-Host '找不到 codex CLI（npm i -g @openai/codex，或執行 codex login）' -ForegroundColor Yellow; return }`,
    "$env:CODEX_HOME=$null",
    "if ($Resume) { codex --dangerously-bypass-approvals-and-sandbox resume $Resume }",
    "else { codex --dangerously-bypass-approvals-and-sandbox }",
  ];
}

// ponytail: key file path mirrors renderer interactive-agent.ts; overridable
// via COTERM_GEMINI_KEY_FILE. Falls back to an inherited GEMINI_API_KEY so the
// shim also works on machines without the key file.
function geminiShimBody(): string[] {
  const keyFile = (process.env.COTERM_GEMINI_KEY_FILE?.trim() || "D:\\Coterm\\.gitnexus\\.gitignore").replaceAll("'", "''");
  return [
    `if (-not (Get-Command gemini -ErrorAction SilentlyContinue)) { Write-Host '找不到 gemini CLI（npm i -g @google/gemini-cli）' -ForegroundColor Yellow; return }`,
    `if (Test-Path -LiteralPath '${keyFile}') {`,
    `  $env:GEMINI_API_KEY=@(((Get-Content -LiteralPath '${keyFile}' | Where-Object { $_ -match 'AIza' } | Select-Object -First 1) -replace '^[*]','').Trim())`,
    "} elseif (-not $env:GEMINI_API_KEY) {",
    `  Write-Host '[Coterm] Gemini key 檔不存在且 GEMINI_API_KEY 未設定' -ForegroundColor Yellow`,
    "}",
    "gemini --yolo",
  ];
}

function claudeShimBody(
  profile: string,
  proxyUrl: string,
  profileTable: Record<string, ClaudeProfile>,
): string[] {
  const model = profileTable[profile]?.model ?? "claude-3-5-sonnet-latest";
  const env = buildProfileEnv(profile, proxyUrl, profileTable);
  env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS = "1";
  env.CLAUDE_CODE_DISABLE_AGENT_VIEW = "1";
  const lines = Object.entries(env).map(
    ([key, value]) => `$env:${key}='${value.replaceAll("'", "''")}'`,
  );
  return [
    `if (-not (Get-Command claude -ErrorAction SilentlyContinue)) { Write-Host '找不到 claude CLI（npm i -g @anthropic-ai/claude-code）' -ForegroundColor Yellow; return }`,
    ...lines,
    `$cmdArgs = @('--model', '${model}', '--dangerously-skip-permissions', '--teammate-mode', 'in-process')`,
    "if ($Resume) { $cmdArgs += @('--resume', $Resume) }",
    "if ($SessionId) { $cmdArgs += @('--session-id', $SessionId) }",
    "if ($Task) { $cmdArgs += @('-p', $Task) }",
    "claude @cmdArgs",
  ];
}

/**
 * Codex shim body, spec-driven (stage 2 codex half). The built-in rows are
 * token-verbatim the old if-chain (identity pinned by tests/unit/
 * agent-shims.test.ts); registered custom codex- entries get the private-home
 * posture with their own env key/token and -c args baked from the spec.
 */
function codexShimBody(
  profile: string,
  proxyUrl: string,
  codexHome: string,
  profileTable: Record<string, ClaudeProfile>,
): string[] {
  const spec = resolveCodexProfileSpec(profile, profileTable);
  if (spec?.home === "official") {
    // #100 follow-up: a missing <profile>.config.toml makes Codex silently run
    // as plain Codex (same argv, no error). Guard: fail loudly instead.
    const profileName = (spec.configProfile ?? profile).replaceAll("'", "''");
    const missing = spec.configProfile === "codex-team"
      ? "Codex Team 設定檔不存在，請重開 Coterm 讓它自動產生"
      : `Codex 設定檔 ~/.codex/${profileName}.config.toml 不存在，請確認檔案或在 Codex Team 設定新增此設定檔。`;
    return [
      "$env:CODEX_HOME=$null",
      `$profileToml = Join-Path $env:USERPROFILE ('.codex/${profileName}.config.toml')`,
      `if (-not (Test-Path $profileToml)) { Write-Host '${missing}' -ForegroundColor Yellow; return }`,
      `$cmdArgs = @('--profile', '${spec.configProfile}', ${CODEX_NO_UPDATE_ARGS})`,
      "if ($Resume) { $cmdArgs += @('resume', $Resume) }",
      "if ($Task) { $cmdArgs += $Task }",
      "codex @cmdArgs",
    ];
  }
  const token = resolveCodexAuthToken(profile, spec, profileTable, DEFAULT_AUTH_TOKEN);
  const lines: string[] = [];
  if (!spec) {
    // Unregistered codex- id: legacy global-home GLM posture (old dead else).
    const home = process.env.COTERM_CODEX_HOME?.trim() ?? "";
    if (home) lines.push(`$env:CODEX_HOME='${home.replaceAll("'", "''")}'`);
    lines.push(`$env:GLM_API_KEY='${token}'`);
  } else if (spec.home === "qwen") {
    const home = process.env.COTERM_CODEX_LONG_HOME?.trim()
      || (process.env.COTERM_PROXY_DIR?.trim() ? join(process.env.COTERM_PROXY_DIR.trim(), "codex_long") : "");
    if (home) lines.push(`$env:CODEX_HOME='${home.replaceAll("'", "''")}'`);
    lines.push(`$env:${spec.launcherEnvKey ?? spec.envKey}='${token}'`);
  } else {
    lines.push(`$env:CODEX_HOME='${codexHome.replaceAll("'", "''")}'`);
    lines.push(`$env:${spec.envKey}='${token}'`);
  }
  // Array-literal context: each token must be a quoted string of its own
  // (bare `-c` reads as parameter syntax in @(...) — caught by parse test).
  // The legacy qwen home ships its own config.toml with the provider wiring,
  // so it gets NO -c args, exactly like the old hardcoded list.
  const baseUrl = `${resolveCodexBaseUrl(profile, proxyUrl, profileTable).replace(/\/+$/, "")}/v1`;
  const configArgs = spec && spec.home !== "qwen"
    ? [
        "'-c'", `'model_provider="${spec.provider}"'`,
        ...(spec.model !== undefined ? ["'-c'", `'model="${spec.model}"'`] : []),
        ...(spec.contextWindow !== undefined ? ["'-c'", `'model_context_window=${spec.contextWindow}'`] : []),
        ...(spec.maxOutputTokens !== undefined ? ["'-c'", `'model_max_output_tokens=${spec.maxOutputTokens}'`] : []),
        ...(spec.autoCompactTokenLimit !== undefined ? ["'-c'", `'model_auto_compact_token_limit=${spec.autoCompactTokenLimit}'`] : []),
        ...(spec.autoCompactScope !== undefined ? ["'-c'", `'model_auto_compact_token_limit_scope="${spec.autoCompactScope}"'`] : []),
        ...(spec.reasoningEffort !== undefined ? ["'-c'", `'model_reasoning_effort="${spec.reasoningEffort}"'`] : []),
        ...(spec.providerName !== undefined ? ["'-c'", `'model_providers.${spec.provider}.name="${spec.providerName}"'`] : []),
        "'-c'", `'model_providers.${spec.provider}.base_url="${baseUrl}"'`,
        "'-c'", `'model_providers.${spec.provider}.env_key="${spec.envKey}"'`,
        "'-c'", `'model_providers.${spec.provider}.wire_api="responses"'`,
      ]
    : [];
  return [
    `if (-not (Get-Command codex -ErrorAction SilentlyContinue)) { Write-Host '找不到 codex CLI（npm i -g @openai/codex）' -ForegroundColor Yellow; return }`,
    ...lines,
    `$cmdArgs = @('--dangerously-bypass-approvals-and-sandbox', ${CODEX_NO_UPDATE_ARGS}${configArgs.length ? `, ${configArgs.join(", ")}` : ""})`,
    "if ($Resume) { $cmdArgs += @('resume', $Resume); if ($Task) { $cmdArgs += $Task } }",
    "elseif ($Task) { $cmdArgs += @('exec', '--skip-git-repo-check', '--cd', $PWD.Path, $Task) }",
    "codex @cmdArgs",
  ];
}

// Codex checks npm for a newer CLI at startup and offers to self-update. The
// update runs `npm install -g @openai/codex`, which on Windows fails with EBUSY
// whenever another pane is already running codex.exe — and the pane then exits
// instead of starting. Coterm runs many codex panes at once, so its launchers
// skip the check; updating stays a manual `npm i -g @openai/codex`.
const CODEX_NO_UPDATE_ARGS = "'-c', 'check_for_update_on_startup=false'";

/** Temp-isolated launcher dirs (e2e userData) must never enter the global PATH. */
const JUNK_TEMP_MARKERS = ["coterm-action", "ai-terminal-packaged-e2e"];

/** Remove e2e/test temp launcher dirs from a PATH entry list (private #62). */
export function pruneTempLauncherEntries(entries: string[], tempRoot: string): string[] {
  const root = tempRoot.toLowerCase().replaceAll("/", "\\");
  return entries.filter((entry) => {
    const low = entry.toLowerCase().replaceAll("/", "\\");
    return !(low.startsWith(root) && JUNK_TEMP_MARKERS.some((m) => low.includes(m)));
  });
}

/**
 * Make the shim dir resolvable by name. Registry write is for shells opened
 * outside Coterm later; process.env.PATH is what reaches PTYs spawned by this
 * Coterm instance (children inherit ours, not a refreshed registry).
 * Test/e2e instances (userData under the OS temp dir) skip the registry write
 * entirely — each one used to permanently append its throwaway dir to the
 * user PATH, eventually pushing the merged PATH past the length where Windows
 * silently drops the user portion (#62).
 */
function injectPath(dir: string): void {
  // Shims are .ps1 + registry-based — Windows-only. On POSIX this would wreck
  // PATH (";" delimiter + a dir nothing can execute), so bail early.
  if (process.platform !== "win32") return;
  // #62: prune junk temp launcher dirs from the INHERITED process PATH too —
  // a Coterm launched from an already-polluted shell would otherwise hand the
  // whole pile to every PTY it spawns (registry prune only fixes future shells).
  const entries = pruneTempLauncherEntries(
    (process.env.PATH ?? "").split(delimiter).filter((e) => e.trim()),
    tmpdir(),
  );
  if (!entries.map((e) => e.toLowerCase()).includes(dir.toLowerCase())) {
    entries.unshift(dir);
  }
  process.env.PATH = entries.join(delimiter);
  if (dir.toLowerCase().startsWith(tmpdir().toLowerCase())) return;
  try {
    const key = "HKCU\\Environment";
    let userPath = "";
    try {
      const out = execFileSync("reg", ["query", key, "/v", "Path"], { encoding: "utf8" });
      userPath = /Path\s+REG_(?:EXPAND_)?SZ\s+(.+)/i.exec(out)?.[1]?.trim() ?? "";
    } catch {
      userPath = ""; // value absent
    }
    const entries = pruneTempLauncherEntries(
      userPath.split(delimiter).filter((e) => e.trim()),
      tmpdir(),
    );
    if (!entries.map((e) => e.toLowerCase()).includes(dir.toLowerCase())) {
      entries.push(dir);
    }
    const merged = entries.join(delimiter);
    if (merged !== userPath) {
      execFileSync("reg", ["add", key, "/v", "Path", "/t", "REG_EXPAND_SZ", "/d", merged, "/f"], { stdio: "ignore" });
    }
  } catch (error) {
    logger.warn("provider", "agent.shims.path_failed", "Could not add launcher dir to user PATH.", {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * cot — cross-pane agent mail CLI bodies. cot.ps1 is the ONLY implementation
 * (pwsh 7 and Windows PowerShell 5.1 resolve `cot` to cot.ps1 from PATH);
 * cot.cmd (cmd.exe) and the extensionless `cot` (Git Bash) are byte-thin
 * forwarders. Output is at most a couple of short lines — agents read them,
 * tokens are the budget. Exit code 2 on any failure so an agent can branch.
 * Exported for tests, byte-pinned alongside renderShim.
 */
export function renderCotScripts(): { ps1: string; cmd: string; bash: string } {
  const ps1Lines = [
    "# cot - Coterm cross-pane agent mail (@-mentions).",
    "# Regenerated on every app start by ensureAgentShims; do not hand-edit.",
    "# usage: cot @handle <one short message>   |   cot who",
    "$ErrorActionPreference = 'Stop'",
    "",
    "function Cot-Fail([string]$Message) {",
    "  [Console]::Out.WriteLine($Message)",
    "  exit 2",
    "}",
    "",
    "if (-not $env:COTERM_MAIL_URL -or -not $env:COTERM_MAIL_TOKEN) {",
    "  Cot-Fail 'cot: no Coterm mail identity in this shell (COTERM_MAIL_URL / COTERM_MAIL_TOKEN unset)'",
    "}",
    "",
    "$MailHeaders = @{",
    "  Authorization = ('Bearer ' + $env:COTERM_MAIL_TOKEN)",
    "  Accept = 'text/plain'",
    "}",
    "",
    "function Cot-Post([string]$Route, [string]$JsonBody) {",
    "  try {",
    "    $Bytes = [System.Text.Encoding]::UTF8.GetBytes($JsonBody)",
    "    return Invoke-RestMethod -Method Post -Uri ($env:COTERM_MAIL_URL + $Route) -Headers $MailHeaders -ContentType 'application/json; charset=utf-8' -Body $Bytes -TimeoutSec 10",
    "  } catch {",
    "    $Response = $_.Exception.Response",
    "    if ($Response) {",
    "      try {",
    "        $Reader = New-Object System.IO.StreamReader($Response.GetResponseStream(), [System.Text.Encoding]::UTF8)",
    "        $ServerMessage = $Reader.ReadToEnd().Trim()",
    "        $Reader.Dispose()",
    "        if ($ServerMessage) { Cot-Fail $ServerMessage }",
    "      } catch { }",
    "    }",
    "    Cot-Fail ('cot: request failed: ' + $_.Exception.Message)",
    "  }",
    "}",
    "",
    "if (-not $args -or $args.Count -eq 0) { Cot-Fail 'usage: cot @handle <message> | cot who' }",
    "",
    "if ($args[0] -eq 'who') {",
    "  $Out = Cot-Post '/who' '{}'",
    "  [Console]::Out.WriteLine($Out)",
    "  exit 0",
    "}",
    "",
    "$To = [string]$args[0]",
    "if (-not $To.StartsWith('@')) { Cot-Fail 'usage: cot @handle <message> | cot who' }",
    "$Message = (($args | Select-Object -Skip 1) -join ' ').Trim()",
    "if (-not $Message) { Cot-Fail 'cot: empty message' }",
    "$Payload = @{ to = $To; text = $Message } | ConvertTo-Json -Compress",
    "$Out = Cot-Post '/send' $Payload",
    "[Console]::Out.WriteLine($Out)",
    "exit 0",
  ];
  const cmdLines = [
    "@echo off",
    "rem cot - Coterm agent mail CLI. Regenerated at app start; do not edit.",
    'powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0cot.ps1" %*',
    "exit /b %ERRORLEVEL%",
  ];
  // Git Bash: LF-only (CRLF under a shebang is brittle). The $ substitutions
  // are for bash, not TS — these are plain strings, not template literals.
  const bashLines = [
    "#!/usr/bin/env bash",
    "# cot - Coterm agent mail CLI (Git Bash): forward to the single .ps1 impl.",
    "# pwsh resolves cot.ps1 natively and handles non-ASCII args most reliably;",
    "# cmd/Git Bash wrappers can mangle CJK on the way through.",
    "set -euo pipefail",
    'dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"',
    'ps1="$(cygpath -w "$dir/cot.ps1")"',
    'powershell.exe -NoProfile -ExecutionPolicy Bypass -File "$ps1" "$@"',
  ];
  return {
    ps1: `${ps1Lines.join("\r\n")}\r\n`,
    cmd: `${cmdLines.join("\r\n")}\r\n`,
    bash: `${bashLines.join("\n")}\n`,
  };
}
