import {
  MYQWEN_CLAUDE_AUTO_COMPACT_PERCENT,
  MYQWEN_CLAUDE_AUTO_COMPACT_WINDOW,
  MYQWEN_CLAUDE_CONTEXT_WINDOW,
  MYQWEN_MODEL,
  MYGLM_CLAUDE_AUTO_COMPACT_PERCENT,
  MYGLM_CLAUDE_AUTO_COMPACT_WINDOW,
  MYGLM_CLAUDE_CONTEXT_WINDOW,
  MYGLM_MODEL,
} from "@shared/types";
import {
  resolveCodexAuthToken,
  resolveCodexBaseUrl,
  resolveCodexProfileSpec,
} from "@shared/codex-profiles";
import {
  DEFAULT_AUTH_TOKEN,
  DEFAULT_PROXY_URL,
  DEFAULT_PROFILES,
  type ClaudeProfile,
  buildProfileEnv,
} from "./profiles-config";
import { getLauncherDir, shimCommand, supportedAgentProfilesFor, allShimProfilesFor } from "./agent-shims";

/**
 * Agent API/API launch allowlist. Stage 1 takes an ACTIVE profile table
 * (DEFAULT_PROFILES ⊕ settings.customProfiles); call sites with settings
 * access pass buildActiveProfiles(settings.customProfiles). Defaults to the
 * built-in table (tests / no-settings callers).
 */
export function supportedAgentProfiles(
  profileTable: Record<string, ClaudeProfile> = DEFAULT_PROFILES,
): string[] {
  return supportedAgentProfilesFor(profileTable);
}

/** Rebuild trusted resume from allowlisted profile/session/path inputs only. */
export function buildWorktreeResumeCommand(
  agentProfile: string,
  worktreePath: string,
  sessionId: string,
  profileTable: Record<string, ClaudeProfile> = DEFAULT_PROFILES,
): string | null {
  if (!supportedAgentProfilesFor(profileTable).includes(agentProfile)) return null;
  const shim = getLauncherDir();
  if (shim) {
    return [
      `Set-Location -LiteralPath '${ps(worktreePath)}'`,
      shimCommand(agentProfile, shim, ["-Resume", `'${ps(sessionId)}'`]),
    ].join("; ");
  }
  const workspace = ps(worktreePath);
  const safeSession = ps(sessionId);

  if (agentProfile.startsWith("codex-")) {
    const configArgs = codexLocalConfigArgs(agentProfile, profileTable);
    const localEnv = codexLocalEnv(agentProfile, profileTable);
    const codex = [
      "codex --dangerously-bypass-approvals-and-sandbox",
      configArgs,
      "resume",
      `'${safeSession}'`,
    ].filter(Boolean).join(" ");
    return checkedCommand("codex", [
      `Set-Location -LiteralPath '${workspace}'`,
      `${localEnv}${codex}`,
    ].join("; "));
  }

  const model = profileTable[agentProfile]?.model
    ?? (agentProfile === "claude-local-main"
    ? MYGLM_MODEL
    : agentProfile === "claude-local-long2"
      ? MYQWEN_MODEL
    : agentProfile === "claude-local-freeform"
      ? "claude-haiku-4-5-20251001"
      : "claude-3-5-sonnet-latest");
  const claudeArgs = [
    `--model '${model}'`,
    `--resume '${safeSession}'`,
    "--dangerously-skip-permissions",
    "--teammate-mode in-process",
  ].join(" ");
  return checkedCommand("claude", [
    `Set-Location -LiteralPath '${workspace}'`,
    claudeContextEnv(agentProfile),
    `claude ${claudeArgs}`,
  ].filter(Boolean).join("; "));
}

export function buildAgentLaunchCommand(
  agentProfile: string,
  cwd: string,
  task: string | null,
  resumeSessionId: string | null,
  profileTable: Record<string, ClaudeProfile> = DEFAULT_PROFILES,
): string | null {
  if (!supportedAgentProfilesFor(profileTable).includes(agentProfile)) return null;
  // #51: launcher shims replace the inline env wall when main generated them.
  const shim = getLauncherDir();
  if (shim) {
    const args: string[] = [];
    if (resumeSessionId) args.push("-Resume", `'${ps(resumeSessionId)}'`);
    if (task) args.push("-Task", `'${ps(task)}'`);
    return [
      `Set-Location -LiteralPath '${ps(cwd)}'`,
      shimCommand(agentProfile, shim, args),
    ].join("; ");
  }
  const workspace = ps(cwd);
  const proxyDir = process.env.COTERM_PROXY_DIR?.trim() ?? "";
  const codexHome = process.env.COTERM_CODEX_HOME?.trim() ?? "";
  const codexQwenHome = process.env.COTERM_CODEX_LONG_HOME?.trim() ?? "";
  const proxyBootstrap = [proxyDir ? `$proxyDir='${ps(proxyDir)}'` : ""];
  if (proxyDir) {
    proxyBootstrap.push(
      `if (-not (netstat -an | Select-String ':8787 .*LISTENING')) { Start-Process -WindowStyle Hidden -FilePath 'cmd.exe' -ArgumentList '/c', 'python "${ps(proxyDir)}\\llm-proxy\\proxy_watchdog.py"'; Start-Sleep -Seconds 3 }`,
    );
  }
  proxyBootstrap.push(`Set-Location -LiteralPath '${workspace}'`);

  if (agentProfile.startsWith("codex-")) {
    const qwen = agentProfile === "codex-local-long";
    const home = qwen
      ? (codexQwenHome || (proxyDir ? `${proxyDir}\\codex_long` : ""))
      : codexHome;
    const configArgs = codexLocalConfigArgs(agentProfile, profileTable);
    const codex = resumeSessionId
      ? [
          "codex --dangerously-bypass-approvals-and-sandbox",
          configArgs,
          "resume",
          `'${ps(resumeSessionId)}'`,
          task ? `'${ps(task)}'` : "",
        ].filter(Boolean).join(" ")
      : task
        ? `codex --dangerously-bypass-approvals-and-sandbox ${configArgs} exec --skip-git-repo-check --cd '${workspace}' '${ps(task)}'`
        : `codex --dangerously-bypass-approvals-and-sandbox ${configArgs}`;
  const newProfileHome = agentProfile.startsWith("codex-")
    ? process.env[CODEX_HOME_ENV_VARS[agentProfile] ?? ""]?.trim() ?? ""
    : "";
    const localProfileEnv = codexLocalEnv(agentProfile, profileTable);
    return checkedCommand("codex", [
      ...proxyBootstrap,
      (newProfileHome || home) ? `$env:CODEX_HOME='${ps(newProfileHome || home)}'` : "",
      localProfileEnv || (qwen
        ? `$env:QWEN_API_KEY='${DEFAULT_AUTH_TOKEN}'`
        : `$env:GLM_API_KEY='${DEFAULT_AUTH_TOKEN}'`),
      codex,
    ].filter(Boolean).join("; "));
  }

  const model = profileTable[agentProfile]?.model
    ?? (agentProfile === "claude-local-main"
    ? MYGLM_MODEL
    : agentProfile === "claude-local-long2"
      ? MYQWEN_MODEL
    : agentProfile === "claude-local-freeform"
      ? "claude-haiku-4-5-20251001"
      : "claude-3-5-sonnet-latest");
  const claudeArgs = [
    `--model '${model}'`,
    resumeSessionId ? `--resume '${ps(resumeSessionId)}'` : "",
    task ? `-p '${ps(task)}'` : "",
    "--dangerously-skip-permissions",
    "--teammate-mode in-process",
  ].filter(Boolean).join(" ");

  // Custom (non-builtin) claude profiles build their env wall from the active
  // table; builtin free profiles keep the hardcoded wall above, except the two
  // credential lines which honor per-profile overrides (stage 2): explicit
  // profile.env value > baseUrl/authToken field > built-in constants.
  const launcherProfile = profileTable[agentProfile];
  const wallBaseUrl = launcherProfile?.env.ANTHROPIC_BASE_URL
    ?? launcherProfile?.baseUrl
    ?? DEFAULT_PROXY_URL;
  const wallAuthToken = launcherProfile?.env.ANTHROPIC_AUTH_TOKEN
    ?? launcherProfile?.authToken
    ?? DEFAULT_AUTH_TOKEN;
  const isCustomClaude = Boolean(profileTable[agentProfile]) && !(agentProfile in DEFAULT_PROFILES);
  const envWall = isCustomClaude
    ? customProfileEnvLines(agentProfile, profileTable)
    : [
        `$env:ANTHROPIC_BASE_URL='${ps(wallBaseUrl)}'`,
        `$env:ANTHROPIC_AUTH_TOKEN='${ps(wallAuthToken)}'`,
        `$env:ANTHROPIC_MODEL='${model}'`,
        "$env:ANTHROPIC_SMALL_FAST_MODEL='claude-3-5-haiku-latest'",
        "$env:DISABLE_TELEMETRY='1'",
        "$env:DISABLE_COST_WARNINGS='1'",
        "$env:CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS='1'",
        "$env:CLAUDE_CODE_DISABLE_AGENT_VIEW='1'",
        "$env:CLAUDE_CODE_ATTRIBUTION_HEADER='0'",
        "$env:CLAUDE_CODE_WORKFLOWS='1'",
        "$env:DISABLE_GROWTHBOOK='1'",
        claudeContextEnv(agentProfile),
      ];

  return checkedCommand("claude", [
    ...proxyBootstrap,
    ...envWall,
    `claude ${claudeArgs}`,
  ].filter(Boolean).join("; "));
}

/**
 * Session restore (2026-10-23): rebuild the relaunch command for a pane
 * captured in session-restore.json. Unlike buildAgentLaunchCommand (Agent API/API
 * allowlist = free proxy profiles only), this covers every profile the
 * "+agent" picker can launch — paid/official included (claude-official,
 * codex-official, codex-team, paid custom profiles) — because the pane was
 * started by the user launching it, not by an API caller.
 *
 * Trusted-resume rule (ABCDEF guide §3) is kept: the command is rebuilt from
 * the {profile, sessionId} metadata pair only — a malformed session id is
 * dropped (agent relaunches fresh), never interpolated raw. Returns null for
 * council (no session concept), gemini without its launcher shim, paid custom
 * profiles without their shim (credentials live in the shim; the renderer
 * refuses the same way), and truly unknown profile ids — the caller leaves
 * those panes as plain shells.
 */
export function buildSessionResumeCommand(
  agentProfile: string,
  cwd: string,
  sessionId: string | null,
  profileTable: Record<string, ClaudeProfile> = DEFAULT_PROFILES,
): string | null {
  if (agentProfile === "council") return null;
  // Snapshot corruption guard: claude session ids and codex rollout ids are
  // UUID-shaped; anything outside this alphabet was never a real session id,
  // so resume is dropped and the agent launches fresh instead.
  const safeSession = sessionId && /^[A-Za-z0-9_-]{1,200}$/.test(sessionId) ? sessionId : null;
  if (supportedAgentProfilesFor(profileTable).includes(agentProfile)) {
    return buildAgentLaunchCommand(agentProfile, cwd, null, safeSession, profileTable);
  }
  const shim = getLauncherDir();
  if (shim && allShimProfilesFor(profileTable).includes(agentProfile)) {
    // gemini's resume is index-based, not a stored session id — its shim
    // ignores -Resume, so only pass an id when the profile maps one.
    const args = safeSession && agentProfile !== "gemini" ? ["-Resume", `'${ps(safeSession)}'`] : [];
    return [
      `Set-Location -LiteralPath '${ps(cwd)}'`,
      shimCommand(agentProfile, shim, args),
    ].join("; ");
  }
  // No launcher shim: mirror the renderer's interactiveAgent() inline
  // fallbacks for the built-in official CLIs (used in tests and before the
  // first bootstrap shim render).
  const workspace = ps(cwd);
  if (agentProfile === "claude-official") {
    return checkedCommand("claude", [
      `Set-Location -LiteralPath '${workspace}'`,
      "$env:ANTHROPIC_BASE_URL=$null; $env:ANTHROPIC_AUTH_TOKEN=$null; $env:ANTHROPIC_MODEL=$null; $env:ANTHROPIC_SMALL_FAST_MODEL=$null",
      "$env:CLAUDE_CODE_WORKFLOWS='1'",
      "$env:CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS='1'",
      "$env:CLAUDE_CODE_DISABLE_AGENT_VIEW='1'",
      `claude${safeSession ? ` --resume '${safeSession}'` : ""} --dangerously-skip-permissions --teammate-mode in-process`,
    ].join("; "));
  }
  if (agentProfile === "codex-official") {
    const resume = safeSession ? ` resume '${safeSession}'` : "";
    return checkedCommand("codex", [
      `Set-Location -LiteralPath '${workspace}'`,
      `$env:CODEX_HOME=$null; codex --dangerously-bypass-approvals-and-sandbox${resume}`,
    ].join("; "));
  }
  if (agentProfile.startsWith("codex-")) {
    const spec = resolveCodexProfileSpec(agentProfile, profileTable);
    if (spec?.home === "official") {
      // codex-team & friends: missing <profile>.config.toml must fail loudly
      // (codex silently runs as plain Codex otherwise — issue #100 follow-up).
      const profileName = ps(spec.configProfile ?? agentProfile);
      const resume = safeSession ? ` resume '${safeSession}'` : "";
      return checkedCommand("codex", [
        `Set-Location -LiteralPath '${workspace}'`,
        "$env:CODEX_HOME=$null",
        `$profileToml = Join-Path $env:USERPROFILE ('.codex/${profileName}.config.toml')`,
        `if (-not (Test-Path $profileToml)) { Write-Host 'Codex 設定檔 ~/.codex/${profileName}.config.toml 不存在，請確認檔案是否存在。' -ForegroundColor Yellow } else { codex --profile '${profileName}'${resume} }`,
      ].join("; "));
    }
  }
  return null;
}

/**
 * No-shim fallback env wall for a CUSTOM (non-builtin) claude-harness profile:
 * derived from the active table the same way claudeShimBody does, instead of
 * the hardcoded free-proxy wall in buildAgentLaunchCommand.
 */
export function customProfileEnvLines(
  agentProfile: string,
  profileTable: Record<string, ClaudeProfile>,
  proxyUrl: string = DEFAULT_PROXY_URL,
): string[] {
  const env = buildProfileEnv(agentProfile, proxyUrl, profileTable);
  env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS = "1";
  env.CLAUDE_CODE_DISABLE_AGENT_VIEW = "1";
  return Object.entries(env).map(([key, value]) => `$env:${key}='${value.replaceAll("'", "''")}'`);
}

/**
 * Per-profile CODEX_HOME override env vars (dev/test launcher installs), keyed
 * by profile id. Ids without an entry fall back to the global COTERM_CODEX_HOME
 * in the caller — same as the old if-chain, which only covered the three
 * private-home builtin profiles.
 */
const CODEX_HOME_ENV_VARS: Readonly<Record<string, string>> = {
  "codex-local-long2": "COTERM_CODEX_LOCAL_LONG2_HOME",
  "codex-local-main": "COTERM_CODEX_GLM_HOME",
  "codex-local-max": "COTERM_CODEX_LOCAL_MAX_HOME",
};

/**
 * Codex -c config args for a local launch, derived from the shared codex spec
 * table (stage 2 codex half). Legacy "qwen"-home profiles (codex-local-long) pass no
 * config args — their CODEX_HOME config.toml carries the provider wiring; an
 * unregistered codex id and official-home profiles (codex-team, whose config
 * lives in the codex-team TOML) also keep "". Exported for the stage-2 identity
 * tests (tests/unit/hot-model-registry.test.ts).
 */
export function codexLocalConfigArgs(
  profile: string,
  profileTable: Record<string, ClaudeProfile> = DEFAULT_PROFILES,
): string {
  const spec = resolveCodexProfileSpec(profile, profileTable);
  if (!spec || spec.home !== "private") return "";
  const baseUrl = `${resolveCodexBaseUrl(profile, DEFAULT_PROXY_URL, profileTable).replace(/\/+$/, "")}/v1`;
  return [
    `-c 'model_provider="${spec.provider}"'`,
    ...(spec.model !== undefined ? [`-c 'model="${spec.model}"'`] : []),
    ...(spec.contextWindow !== undefined ? [`-c 'model_context_window=${spec.contextWindow}'`] : []),
    ...(spec.maxOutputTokens !== undefined ? [`-c 'model_max_output_tokens=${spec.maxOutputTokens}'`] : []),
    ...(spec.autoCompactTokenLimit !== undefined ? [`-c 'model_auto_compact_token_limit=${spec.autoCompactTokenLimit}'`] : []),
    ...(spec.autoCompactScope !== undefined ? [`-c 'model_auto_compact_token_limit_scope="${spec.autoCompactScope}"'`] : []),
    ...(spec.reasoningEffort !== undefined ? [`-c 'model_reasoning_effort="${spec.reasoningEffort}"'`] : []),
    ...(spec.providerName !== undefined ? [`-c 'model_providers.${spec.provider}.name="${spec.providerName}"'`] : []),
    `-c 'model_providers.${spec.provider}.base_url="${baseUrl}"'`,
    `-c 'model_providers.${spec.provider}.env_key="${spec.envKey}"'`,
    `-c 'model_providers.${spec.provider}.wire_api="responses"'`,
  ].join(" ");
}

/**
 * Env-wall credential line for a local codex launch: spec env key + the
 * profile's own authToken (explicit env > field > built-in dev token).
 * codex-local-long, unregistered codex ids, and official-home profiles (codex-team)
 * return "" so the caller's legacy fallback emits the key — identity with the
 * old if-chain.
 */
export function codexLocalEnv(
  profile: string,
  profileTable: Record<string, ClaudeProfile> = DEFAULT_PROFILES,
): string {
  const spec = resolveCodexProfileSpec(profile, profileTable);
  if (!spec || spec.home !== "private") return "";
  const key = spec.launcherEnvKey ?? spec.envKey;
  const token = resolveCodexAuthToken(profile, spec, profileTable, DEFAULT_AUTH_TOKEN);
  return `$env:${key}='${token}'; `;
}

function claudeContextEnv(profile: string): string {
  const values = profile === "claude-local-long2"
      ? [MYQWEN_CLAUDE_CONTEXT_WINDOW, MYQWEN_CLAUDE_AUTO_COMPACT_WINDOW, MYQWEN_CLAUDE_AUTO_COMPACT_PERCENT]
        : profile === "claude-local-main"
            ? [MYGLM_CLAUDE_CONTEXT_WINDOW, MYGLM_CLAUDE_AUTO_COMPACT_WINDOW, MYGLM_CLAUDE_AUTO_COMPACT_PERCENT]
          : null;
  if (!values) return "";
  return [
    "$env:CLAUDE_CODE_DISABLE_LEGACY_MODEL_REMAP='1'",
    `$env:CLAUDE_CODE_MAX_CONTEXT_TOKENS='${values[0]}'`,
    `$env:CLAUDE_CODE_AUTO_COMPACT_WINDOW='${values[1]}'`,
    `$env:CLAUDE_AUTOCOMPACT_PCT_OVERRIDE='${values[2]}'`,
  ].join("; ");
}

/**
 * Issue #6 fixed implementer command. Unlike the generic interactive launcher,
 * the first turn always has an explicit UUID and every correction resumes that
 * exact Claude session. Inputs are PowerShell-quoted; the command is never
 * reconstructed from persisted free-form shell text.
 */
export function buildAgentApiImplementerCommand(input: {
  cwd: string;
  prompt: string;
  sessionId: string;
  proxyUrl: string;
  /** Stage 2: per-profile token override (localRouteAuthToken); omitted → built-in dev token. */
  authToken?: string;
  resume: boolean;
}): string {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(input.sessionId)) {
    throw new Error("AgentApi implementer requires a stable UUID session ID.");
  }
  const workspace = ps(input.cwd);
  const prompt = ps(input.prompt);
  const session = ps(input.sessionId);
  const model = MYGLM_MODEL;
  const sessionArg = input.resume ? `--resume '${session}'` : `--session-id '${session}'`;
  return checkedCommand("claude", [
    `Set-Location -LiteralPath '${workspace}'`,
    `$env:ANTHROPIC_BASE_URL='${ps(input.proxyUrl)}'`,
    `$env:ANTHROPIC_AUTH_TOKEN='${ps(input.authToken ?? DEFAULT_AUTH_TOKEN)}'`,
    `$env:ANTHROPIC_MODEL='${model}'`,
    "$env:ANTHROPIC_SMALL_FAST_MODEL='claude-3-5-haiku-latest'",
    "$env:DISABLE_TELEMETRY='1'",
    "$env:DISABLE_COST_WARNINGS='1'",
    "$env:CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS='1'",
    "$env:CLAUDE_CODE_DISABLE_AGENT_VIEW='1'",
    "$env:CLAUDE_CODE_ATTRIBUTION_HEADER='0'",
    "$env:CLAUDE_CODE_WORKFLOWS='1'",
    "$env:DISABLE_GROWTHBOOK='1'",
    `claude --model '${model}' ${sessionArg} -p '${prompt}' --teammate-mode in-process`,
  ].join("; "));
}

function checkedCommand(executable: string, command: string): string {
  const installHint =
    executable === "codex"
      ? "npm i -g @openai/codex"
      : executable === "claude"
        ? "npm i -g @anthropic-ai/claude-code"
        : "";
  const message = installHint
    ? `找不到 ${executable} CLI（${executable === "codex" ? "Codex" : "Claude Code"}），請先安裝：${installHint}，裝好後重開終端再試。`
    : `[Coterm] ${executable} CLI not found.`;
  return `if (!(Get-Command '${ps(executable)}' -ErrorAction SilentlyContinue)) { Write-Host '${ps(message)}' -ForegroundColor Yellow } else { ${command} }`;
}

function ps(value: string): string {
  return value.replaceAll("'", "''");
}
