import {
  MYQWEN_CLAUDE_AUTO_COMPACT_PERCENT,
  MYQWEN_CLAUDE_AUTO_COMPACT_WINDOW,
  MYQWEN_CLAUDE_CONTEXT_WINDOW,
  type ProviderProfileId,
  type AgentOption,
  BUILTIN_AGENT_OPTIONS,
} from "@shared/types";
import { BUILTIN_CODEX_PROFILES, type CodexProfileSpec } from "@shared/codex-profiles";

// "council" is one of the ids this union carries; since the hot-model registry
// widened ProviderProfileId to an open string id, spelling it out separately
// would be a redundant constituent.
export type InteractiveAgentId = ProviderProfileId;

export type InteractiveAgentOption = AgentOption;

// Hot model registry (stage 1): the picker list is data-driven. The static
// built-ins are the pre-bootstrap fallback; the app store calls
// setAgentOptions() with the live list derived from settings.customProfiles
// (bootstrap/updateSettings) or pushed by main (profilesChanged).
let activeAgentOptions: readonly AgentOption[] = BUILTIN_AGENT_OPTIONS;

export function setAgentOptions(options: AgentOption[] | null | undefined): void {
  activeAgentOptions = options && options.length > 0 ? options : BUILTIN_AGENT_OPTIONS;
}

export function getAgentOptions(): readonly AgentOption[] {
  return activeAgentOptions;
}

/** Kept for pre-registry consumers: the static fallback table. */
export const INTERACTIVE_AGENT_OPTIONS: readonly AgentOption[] = BUILTIN_AGENT_OPTIONS;

// ponytail: key file is the gitignored .gitnexus/.gitignore (single AIza line,
// leading * from gitignore syntax). Read at launch time — never hardcoded,
// never written to a global env. Path is ASCII-safe and stable.
const GEMINI_KEY_FILE = "D:\\Coterm\\.gitnexus\\.gitignore";
const GEMINI_KEY_READ = `$env:GEMINI_API_KEY=@(((Get-Content '${GEMINI_KEY_FILE}' | Where-Object { $_ -match 'AIza' } | Select-Object -First 1) -replace '^[*]','').Trim())`;

function localEnv(name: string): string {
  const env = import.meta.env as unknown as Record<string, unknown>;
  const value = env[name];
  return typeof value === "string" ? value.trim() : "";
}

// Single source of truth for "can this profile resume a native session?".
// interactiveAgent() emits a --resume / resume subcommand for every profile
// EXCEPT council (which is a python script, no session id). Sidebar's history
// resume button must gate on the same predicate so unsupported profiles don't
// silently no-op (dispatch an event that interactiveAgent can't honor).
// #51: main generates `<userData>/agent-launchers/<profile>.ps1` shims; when
// we know the dir, the pasted command shrinks from an env wall to one shim
// call. Null = shim unavailable → inline env wall fallback (also what the
// LLMPickerDialog "copy" path keeps, since it must work outside Coterm too).
let launcherDir: string | null = null;

export function setInteractiveLauncherDir(dir: string | null): void {
  launcherDir = dir && dir.trim() ? dir : null;
}

function shimCommandFor(profile: string, args: string[] = []): string | null {
  if (!launcherDir) return null;
  const shim = `${launcherDir}\\${profile}.ps1`.replaceAll("'", "''");
  return [`& '${shim}'`, ...args].join(" ");
}

// Historical-only labels: profiles whose upstream model is dead (my-kimi
// 2026-08-26, my-legacy-model 1.5 2026-08-29). claude-history still groups old sessions
// under these ids, and the documented contract is that the sidebar resume
// button never re-launches them — the shims no longer exist, and the upstream
// answers 400 anyway.
const HISTORICAL_ONLY_PROFILES: ReadonlySet<string> = new Set([
  "claude-local-big",
  "claude-local-legacy",
  "codex-local-legacy",
]);

export function canResumeProfile(profileId: string): boolean {
  // gemini --resume takes an index/`latest`, not a session-id string, so the
  // sidebar's UUID-based resume button cannot target it. council has no session.
  if (HISTORICAL_ONLY_PROFILES.has(profileId)) return false;
  return profileId !== "council" && profileId !== "gemini";
}

export function interactiveAgent(
  provider: InteractiveAgentId,
  proxyUrl: string,
  claudeModel: "default" | "opus" | "sonnet" | "haiku" = "default",
  resumeSessionId?: string,
): { title: string; command: string; fullCommand: string; agentProfile?: string; nativeSessionId?: string } | null {
  if (provider === "council") {
    // ponytail: council script dir from env (set by local installer), not
    // hardcoded. Empty = user must set COTERM_COUNCIL_DIR before using.
    const councilDir = localEnv("COTERM_COUNCIL_DIR");
    const cd = councilDir ? `Set-Location '${councilDir}'; ` : "";
    return {
      title: "Council",
      command: `${cd}$q = Read-Host 'Council question'; if ($q) { python council.py --chairman codex54 $q }`,
      fullCommand: `${cd}$q = Read-Host 'Council question'; if ($q) { python council.py --chairman codex54 $q }`,
    };
  }
  if (provider === "codex-official") {
    const shimCmd = shimCommandFor(provider, resumeSessionId ? ["-Resume", `'${ps(resumeSessionId)}'`] : []);
    if (shimCmd) {
      return { title: "Codex", command: shimCmd, fullCommand: shimCmd };
    }
    const cmd = checkedCommand(
      "codex",
      codexCommand(resumeSessionId),
      "\u627e\u4e0d\u5230 Codex CLI\uff0c\u8acb\u5148\u5b89\u88dd\u6216\u57f7\u884c codex login\u3002",
    );
    return { title: "Codex", command: cmd, fullCommand: cmd };
  }
  if (provider === "codex-local-main" || provider === "codex-local-long") {
    const shimCmd = shimCommandFor(provider, resumeSessionId ? ["-Resume", `'${ps(resumeSessionId)}'`] : []);
    // Keep the original return shape: no agentProfile, so the dock writes into
    // the current tile instead of rebuilding it as an agent PTY.
    if (shimCmd) {
      return { title: provider, command: shimCmd, fullCommand: shimCmd };
    }
    // *-codex.cmd forwards %* to `codex --dangerously-bypass-approvals-and-sandbox %*`,
    // so passing `resume <id>` lands as `codex ... resume <id>` (codex's resume subcommand,
    // NOT a --resume flag \u2014 codex has no such flag). Without resume, launches a fresh session.
    const wrapper = provider === "codex-local-long"
      ? (localEnv("COTERM_QWEN_CODEX_CMD") || "C:\\llm-tools\\qwen-codex.cmd")
      : (localEnv("COTERM_GLM_CODEX_CMD") || "C:\\llm-tools\\glm-codex.cmd");
    const wrapperName = provider === "codex-local-long" ? "qwen-codex.cmd" : "glm-codex.cmd";
    const wrapperEnv = provider === "codex-local-long" ? "COTERM_QWEN_CODEX_CMD" : "COTERM_GLM_CODEX_CMD";
    const args = resumeSessionId ? ` resume '${ps(resumeSessionId)}'` : "";
    const cmd = checkedCommand(
      "codex",
      [
        `$wrapper='${ps(wrapper)}'`,
        `if (!(Test-Path -LiteralPath $wrapper)) { $found=Get-Command '${wrapperName}' -ErrorAction SilentlyContinue; if ($found) { $wrapper=$found.Source } }`,
        `if (!(Test-Path -LiteralPath $wrapper)) { Write-Host '[Coterm] ${wrapperName} not found. Set ${wrapperEnv} or install the local launcher.' -ForegroundColor Yellow } else { & $wrapper${args} }`,
      ].join("; "),
      "\u627e\u4e0d\u5230 Codex CLI\uff0c\u8acb\u5148\u5b89\u88dd\u6216\u57f7\u884c codex login\u3002",
    );
    return { title: provider, command: cmd, fullCommand: cmd };
  }
  // Stage 2 (codex half): every other codex- profile is spec-driven — the
  // built-in trio and any registered custom codex entry share this one generic
  // branch (codex-official and the .cmd-wrapper pair above are the exceptions).
  // The spec comes from the option table (deriveAgentOptions attaches it),
  // falling back to the builtin table pre-bootstrap; unknown ids → null.
  if (provider.startsWith("codex-")) {
    const option = activeAgentOptions.find((o) => o.id === provider);
    const spec: CodexProfileSpec | null = option?.codex ?? BUILTIN_CODEX_PROFILES[provider] ?? null;
    if (!spec) return null;
    const title = option?.title ?? option?.label ?? provider;
    const shimCmd = shimCommandFor(provider, resumeSessionId ? ["-Resume", `'${ps(resumeSessionId)}'`] : []);
    if (shimCmd) return { title, command: shimCmd, fullCommand: shimCmd, agentProfile: provider };
    const resume = resumeSessionId ? ` resume '${ps(resumeSessionId)}'` : "";
    if (spec.home === "official") {
      // #100 follow-up: a missing <profile>.config.toml makes Codex silently
      // run as plain Codex. Guard mirrors the shim writer (agent-shims.ts).
      const profileName = ps(spec.configProfile ?? "");
      const missing = provider === "codex-team"
        ? "Codex Team 設定檔不存在，請重開 Coterm 讓它自動產生"
        : `Codex 設定檔 ~/.codex/${profileName}.config.toml 不存在，請確認檔案是否存在。`;
      const cmd = checkedCommand("codex", [
        "$env:CODEX_HOME=$null",
        `$profileToml = Join-Path $env:USERPROFILE ('.codex/${profileName}.config.toml')`,
        `if (-not (Test-Path $profileToml)) { Write-Host '${missing}' -ForegroundColor Yellow } else { codex --profile '${profileName}'${resume} }`,
      ].join("; "), "找不到 Codex CLI，請先安裝或加入 PATH。");
      return { title, command: cmd, fullCommand: cmd, agentProfile: provider };
    }
    const envKey = spec.launcherEnvKey ?? spec.envKey;
    const cmd = checkedCommand("codex", [
      `$env:CODEX_HOME=Join-Path $env:APPDATA 'Coterm\\codex-homes\\${provider}'`,
      "New-Item -ItemType Directory -Force -Path $env:CODEX_HOME | Out-Null",
      `$env:${envKey}='coterm-local-dev'`,
      `codex --dangerously-bypass-approvals-and-sandbox ${codexSpecConfigArgs(spec, proxyUrl)}${resume}`,
    ].join("; "), "找不到 Codex CLI，請先安裝或加入 PATH。");
    return { title, command: cmd, fullCommand: cmd, agentProfile: provider };
  }
  if (provider === "gemini") {
    const shimCmd = shimCommandFor(provider);
    if (shimCmd) {
      return { title: "Gemini CLI", command: shimCmd, fullCommand: shimCmd };
    }
    // Key read from file at launch (GEMINI_KEY_READ) — never hardcoded.
    // --yolo = auto-approve all tools (matches claude --dangerously-skip-permissions).
    // No --resume: gemini uses index/`latest`, not a UUID session id.
    const cmd = checkedCommand(
      "gemini",
      `${GEMINI_KEY_READ}; gemini --yolo`,
      "找不到 Gemini CLI，請先安裝 (npm i -g @google/gemini-cli)。",
    );
    return { title: "Gemini CLI", command: cmd, fullCommand: cmd };
  }
  if (provider === "claude-official") {
    const model = claudeModel === "default" ? "" : ` --model '${claudeModel}'`;
    // Generate a UUID for this fresh launch so context-meter + clean-view can
    // resolve the EXACT .jsonl by id. Skip when resuming (reuse existing session).
    const nativeSessionId = resumeSessionId ? undefined : crypto.randomUUID();
    const sessionIdFlag = nativeSessionId ? ` --session-id '${nativeSessionId}'` : "";
    const shimCmd = shimCommandFor(provider, [
      ...(claudeModel !== "default" ? ["-Model", `'${claudeModel}'`] : []),
      ...(resumeSessionId ? ["-Resume", `'${ps(resumeSessionId)}'`] : []),
      ...(nativeSessionId ? ["-SessionId", `'${ps(nativeSessionId)}'`] : []),
    ]);
    if (shimCmd) {
      return { title: "Claude Code", command: shimCmd, fullCommand: shimCmd, ...(nativeSessionId ? { nativeSessionId } : {}) };
    }
    const cmd = checkedCommand(
      "claude",
      `$env:ANTHROPIC_BASE_URL=$null; $env:ANTHROPIC_AUTH_TOKEN=$null; $env:ANTHROPIC_MODEL=$null; $env:ANTHROPIC_SMALL_FAST_MODEL=$null; $env:CLAUDE_CODE_WORKFLOWS='1'; $env:CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS='1'; $env:CLAUDE_CODE_DISABLE_AGENT_VIEW='1'; claude${model}${sessionIdFlag}${resumeSessionId ? ` --resume '${resumeSessionId}'` : ""} --dangerously-skip-permissions --teammate-mode in-process`,
      "\u627e\u4e0d\u5230 Claude Code CLI\uff0c\u8acb\u5148\u5b89\u88dd\u6216\u57f7\u884c claude auth login\u3002",
    );
    return { title: "Claude Code", command: cmd, fullCommand: cmd, ...(nativeSessionId ? { nativeSessionId } : {}) };
  }
  if (!provider.startsWith("claude-")) return null;
  // Hot model registry (stage 1): model/title come from the option table
  // (built-ins ⊕ settings.customProfiles), not id-by-id if-chains — a custom
  // profile never appears in hand-written branches.
  const option = activeAgentOptions.find((o) => o.id === provider);
  const model = option?.model ?? "claude-3-5-sonnet-latest";
  const title = option?.title ?? option?.label ?? provider;
  const url = proxyUrl.replaceAll("'", "''");
  // Generate a UUID for this fresh launch so context-meter + clean-view can
  // resolve the EXACT .jsonl by id. Skip when resuming (reuse existing session).
  const nativeSessionId = resumeSessionId ? undefined : crypto.randomUUID();
  const sessionIdFlag = nativeSessionId ? ` --session-id '${nativeSessionId}'` : "";
  const shimCmd = shimCommandFor(provider, [
    ...(resumeSessionId ? ["-Resume", `'${ps(resumeSessionId)}'`] : []),
    ...(nativeSessionId ? ["-SessionId", `'${ps(nativeSessionId)}'`] : []),
  ]);
  if (shimCmd) {
    return {
      title,
      command: shimCmd,
      fullCommand: shimCmd,
      agentProfile: provider,
      ...(nativeSessionId ? { nativeSessionId } : {}),
    };
  }
  // A paid (local:false) profile carries its own env (e.g. claude-team -> router
  // 4003) that only the shim knows. The inline wall below hard-wires the free
  // proxy, where an unknown claude-* name falls through to the default free
  // model — the user sees "Opus 5.5" but talks to Qwen. Refuse instead.
  if (option && option.local === false) {
    const msg = `${title} needs its launcher shim, which is unavailable here. Open it from the desktop app or restart Coterm.`;
    const cmd = `Write-Host '[Coterm] ${ps(msg)}' -ForegroundColor Yellow`;
    return { title, command: cmd, fullCommand: cmd, agentProfile: provider };
  }
  // Keep local claude-* launches self-contained. pty.spawn also injects these
  // values for agent tiles, but writing them into the shell command prevents
  // any fallback path from silently using the user's paid claude.ai session.
  const claudeLine = `claude --model '${model}'${sessionIdFlag}${resumeSessionId ? ` --resume '${resumeSessionId}'` : ""} --dangerously-skip-permissions --teammate-mode in-process`;
  const fullCommand = checkedCommand(
    "claude",
    [
      `$env:ANTHROPIC_BASE_URL='${url}'`,
      "$env:ANTHROPIC_AUTH_TOKEN='coterm-local-dev'",
      `$env:ANTHROPIC_MODEL='${model}'`,
      "$env:ANTHROPIC_SMALL_FAST_MODEL='claude-3-5-haiku-latest'",
      "$env:DISABLE_TELEMETRY='1'",
      "$env:DISABLE_COST_WARNINGS='1'",
      "$env:CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS='1'",
      "$env:CLAUDE_CODE_DISABLE_AGENT_VIEW='1'",
      "$env:CLAUDE_CODE_ATTRIBUTION_HEADER='0'",
      "$env:CLAUDE_CODE_WORKFLOWS='1'",
      "$env:DISABLE_GROWTHBOOK='1'",
      ...(provider === "claude-local-long2"
          ? [
              "$env:CLAUDE_CODE_DISABLE_LEGACY_MODEL_REMAP='1'",
              `$env:CLAUDE_CODE_MAX_CONTEXT_TOKENS='${MYQWEN_CLAUDE_CONTEXT_WINDOW}'`,
              `$env:CLAUDE_CODE_AUTO_COMPACT_WINDOW='${MYQWEN_CLAUDE_AUTO_COMPACT_WINDOW}'`,
              `$env:CLAUDE_AUTOCOMPACT_PCT_OVERRIDE='${MYQWEN_CLAUDE_AUTO_COMPACT_PERCENT}'`,
            ]
            : []),
      claudeLine,
    ].join("; "),
    "\u627e\u4e0d\u5230 Claude Code CLI\uff0c\u8acb\u5148\u5b89\u88dd\u6216\u52a0\u5230 PATH\u3002",
  );
  return {
    title,
    command: fullCommand,
    fullCommand,
    agentProfile: provider,
    ...(nativeSessionId ? { nativeSessionId } : {}),
  };
}

export function dispatchNativeWorkflow(
  target: EventTarget,
  terminalId: string,
  provider: ProviderProfileId,
  initialInput: string,
): void {
  target.dispatchEvent(new CustomEvent("coterm:interactive-agent", {
    detail: { terminalId, provider, initialInput },
  }));
}

function checkedCommand(executable: string, command: string, message: string): string {
  return `if (!(Get-Command '${ps(executable)}' -ErrorAction SilentlyContinue)) { Write-Host '[Coterm] ${ps(message)}' -ForegroundColor Yellow } else { ${command} }`;
}

// codex's resume is a SUBCOMMAND (`codex resume <id>`), not a --resume flag.
// --dangerously-bypass-approvals-and-sandbox is a top-level flag and composes
// before the subcommand: `codex --dangerously-bypass-approvals-and-sandbox resume <id>`.
function codexCommand(resumeSessionId?: string): string {
  const resume = resumeSessionId ? ` resume '${ps(resumeSessionId)}'` : "";
  const launch = `codex --dangerously-bypass-approvals-and-sandbox${resume}`;
  return `$env:CODEX_HOME=$null; ${launch}`;
}

/** Spec-driven `-c` config args for the renderer's no-shim fallback wall.
 *  Token order/shape matches the old hardcoded list (identity pinned by unit
 *  tests); optional spec fields emit exactly when the spec carries them. */
function codexSpecConfigArgs(spec: CodexProfileSpec, proxyUrl: string): string {
  const baseUrl = `${proxyUrl.replace(/\/+$/, "").replaceAll("'", "''")}/v1`;
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

function ps(value: string): string {
  return value.replaceAll("'", "''");
}
