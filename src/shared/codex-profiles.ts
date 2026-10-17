// Hot model registry (stage 2, codex half): single source of truth for the
// per-profile codex wiring that used to be hand-written if-chains in four
// places (renderer interactive-agent, agent-shims, agent-launch,
// codex-app-server). A newly registered codex- entry in
// settings.customProfiles now works in every harness without new branches.
//
// Pure data + pure functions — no node/Electron deps, so main and the
// renderer import the same table. Secrets (authToken/baseUrl) stay OUT of
// the spec: they are resolved separately from the profile entries (see
// resolveCodexAuthToken/resolveCodexBaseUrl) so the spec is safe to attach
// to picker options that cross into the DOM.
import {
  MYGLM_CODEX_AUTO_COMPACT_TOKEN_LIMIT,
  MYGLM_CODEX_AUTO_COMPACT_TOKEN_LIMIT_SCOPE,
  MYGLM_CODEX_CONTEXT_WINDOW,
  MYGLM_CODEX_MAX_OUTPUT_TOKENS,
  MYGLMMAX_MODEL,
  MYQWEN_CODEX_AUTO_COMPACT_TOKEN_LIMIT,
  MYQWEN_CODEX_AUTO_COMPACT_TOKEN_LIMIT_SCOPE,
  MYQWEN_CODEX_CONTEXT_WINDOW,
  MYQWEN_CODEX_MAX_OUTPUT_TOKENS,
  MYQWEN_MODEL,
} from "./types";

export type CodexReasoningEffort = "low" | "high" | "max";

/**
 * Structural slice of a profile entry that a codex spec can be derived from —
 * satisfied by settings.customProfiles entries (schema CustomProfileEntry)
 * and by the main-process profile table (ClaudeProfile), so both sides resolve
 * overlays from whichever table they already hold.
 */
export interface CodexProfileSource {
  configProfile?: string | undefined;
  label?: string | undefined;
  model?: string | undefined;
  contextWindow?: number | undefined;
  /** Override -c model_max_output_tokens (codex harness only). */
  maxOutputTokens?: number | undefined;
  /** Override -c model_auto_compact_token_limit (codex harness only). */
  autoCompactTokenLimit?: number | undefined;
  /** Override -c model_auto_compact_token_limit_scope (codex harness only). */
  autoCompactScope?: string | undefined;
  reasoningEffort?: CodexReasoningEffort | undefined;
  baseUrl?: string | undefined;
  authToken?: string | undefined;
  env?: Record<string, string | undefined> | undefined;
}

export interface CodexProfileSpec {
  configProfile?: string | undefined;
  /** codex `model_provider` key (and the model_providers.<x> table name). */
  provider: string;
  /** Env var the app-server config `env_key` points at. */
  envKey: string;
  /** Env var the shim/launcher wall injects when it differs from envKey (codex-local-long only). */
  launcherEnvKey?: string | undefined;
  /** model_providers.<provider>.name display value. */
  providerName?: string | undefined;
  /** codex `-c model` value; omitted keeps the provider's codex default. */
  model?: string | undefined;
  /** codex `-c model_context_window` value. */
  contextWindow?: number | undefined;
  /** codex `-c model_max_output_tokens` value. */
  maxOutputTokens?: number | undefined;
  /** codex `-c model_auto_compact_token_limit` value. */
  autoCompactTokenLimit?: number | undefined;
  /** codex `-c model_auto_compact_token_limit_scope` value. */
  autoCompactScope?: string | undefined;
  reasoningEffort?: CodexReasoningEffort | undefined;
  /**
   * CODEX_HOME posture. "private" = own codex-homes/<id> dir seeded with the
   * yolo config; "qwen" = legacy shared codex_long home whose pre-seeded
   * config.toml already carries the provider (no -c config args needed).
   */
  home: "private" | "qwen" | "official";
}

/**
 * Built-in codex-harness specs, previously four hand-written if-chains. Field
 * values are verbatim the old branches — the identity tests in
 * tests/unit/hot-model-registry.test.ts pin built-in behavior to these rows.
 */
export const BUILTIN_CODEX_PROFILES: Readonly<Record<string, CodexProfileSpec>> = {
  "codex-local-long2": {
    provider: "myqwen",
    model: MYQWEN_MODEL,
    contextWindow: MYQWEN_CODEX_CONTEXT_WINDOW,
    maxOutputTokens: MYQWEN_CODEX_MAX_OUTPUT_TOKENS,
    autoCompactTokenLimit: MYQWEN_CODEX_AUTO_COMPACT_TOKEN_LIMIT,
    autoCompactScope: MYQWEN_CODEX_AUTO_COMPACT_TOKEN_LIMIT_SCOPE,
    reasoningEffort: "high",
    providerName: "Qwen Local",
    envKey: "MYQWEN_API_KEY",
    home: "private",
  },
  "codex-local-long": {
    provider: "qwen",
    model: "upstream-my-qwen-old-freeform",
    contextWindow: 262144,
    maxOutputTokens: 32768,
    // No reasoning effort / auto compact: its CODEX_HOME config.toml carries
    // the provider wiring, so the shim passes no -c args at all.
    providerName: "Qwen 3.6",
    envKey: "CODEX_QWEN_API_KEY",
    launcherEnvKey: "QWEN_API_KEY",
    home: "qwen",
  },
  "codex-local-main": {
    provider: "glm",
    model: "my-glm-flash",
    contextWindow: MYGLM_CODEX_CONTEXT_WINDOW,
    maxOutputTokens: MYGLM_CODEX_MAX_OUTPUT_TOKENS,
    autoCompactTokenLimit: MYGLM_CODEX_AUTO_COMPACT_TOKEN_LIMIT,
    autoCompactScope: MYGLM_CODEX_AUTO_COMPACT_TOKEN_LIMIT_SCOPE,
    reasoningEffort: "high",
    providerName: "GLM Local Flash",
    envKey: "GLM_API_KEY",
    home: "private",
  },
  "codex-local-max": {
    provider: "my-glm-max",
    model: MYGLMMAX_MODEL,
    contextWindow: MYGLM_CODEX_CONTEXT_WINDOW,
    maxOutputTokens: MYGLM_CODEX_MAX_OUTPUT_TOKENS,
    autoCompactTokenLimit: MYGLM_CODEX_AUTO_COMPACT_TOKEN_LIMIT,
    autoCompactScope: MYGLM_CODEX_AUTO_COMPACT_TOKEN_LIMIT_SCOPE,
    reasoningEffort: "high",
    providerName: "GLM Local Max",
    envKey: "MYGLMMAX_API_KEY",
    home: "private",
  },
  // Codex Team (#100): official paid Codex lead driving free worker models via
  // the codex-team MCP bridge. The lead's ~/.codex/codex-team.config.toml is
  // rendered from the bundled template (codex-team-setup.ts) — no envKey, no
  // private home, no proxy args; model selection lives in that TOML.
  "codex-team": {
    provider: "openai",
    providerName: "Codex Team",
    envKey: "",
    home: "official",
    configProfile: "codex-team",
    model: "gpt-6.1-sol",
  },
};

/** codex model_provider slug for a profile id ("codex-my.model" → "mymodel"). */
export function codexProviderSlug(profileId: string): string {
  const suffix = profileId.startsWith("codex-") ? profileId.slice("codex-".length) : profileId;
  return suffix.replace(/[^a-z0-9]/g, "");
}

/**
 * Spec for a newly registered custom codex- entry. No windows/compact/output
 * unless the entry carries them — codex's own defaults apply; a custom
 * contextWindow does flow through (SPEC Q6 mapping) even though codex may
 * discard it for model names it does not recognize (learned rule 2026-08-28).
 */
export function deriveCodexProfileSpec(profileId: string, entry: CodexProfileSource): CodexProfileSpec {
  if (entry.configProfile) {
    if (!/^[a-z][a-z0-9_-]{0,63}$/.test(entry.configProfile)) throw new Error("Invalid Codex config profile");
    return { provider: "openai", envKey: "", home: "official", configProfile: entry.configProfile };
  }
  const slug = codexProviderSlug(profileId);
  return {
    provider: slug,
    providerName: entry.label ?? profileId,
    model: entry.model ?? slug,
    contextWindow: entry.contextWindow,
    maxOutputTokens: entry.maxOutputTokens,
    autoCompactTokenLimit: entry.autoCompactTokenLimit,
    autoCompactScope: entry.autoCompactScope,
    reasoningEffort: entry.reasoningEffort,
    envKey: `${slug.toUpperCase()}_API_KEY`,
    home: "private",
  };
}

/**
 * Resolve the ACTIVE codex spec for a profile id: built-in table overlaid
 * per-field with the user's entry (custom wins per field), or a derived spec
 * for a registered custom codex- id. Null for codex-official, claude ids and
 * codex- ids with no registration (callers keep their legacy fallback).
 */
export function resolveCodexProfileSpec(
  profileId: string,
  customProfiles?: Record<string, CodexProfileSource> | null,
): CodexProfileSpec | null {
  const builtin = BUILTIN_CODEX_PROFILES[profileId];
  const entry = customProfiles?.[profileId];
  if (builtin) {
    if (!entry) return builtin;
    return {
      ...builtin,
      ...(entry.model !== undefined ? { model: entry.model } : {}),
      ...(entry.contextWindow !== undefined ? { contextWindow: entry.contextWindow } : {}),
      ...(entry.maxOutputTokens !== undefined ? { maxOutputTokens: entry.maxOutputTokens } : {}),
      ...(entry.autoCompactTokenLimit !== undefined ? { autoCompactTokenLimit: entry.autoCompactTokenLimit } : {}),
      ...(entry.autoCompactScope !== undefined ? { autoCompactScope: entry.autoCompactScope } : {}),
      ...(entry.reasoningEffort !== undefined ? { reasoningEffort: entry.reasoningEffort } : {}),
      ...(entry.label !== undefined ? { providerName: entry.label } : {}),
      ...(entry.configProfile !== undefined ? { configProfile: entry.configProfile } : {}),
    };
  }
  if (!profileId.startsWith("codex-") || !entry) return null;
  return deriveCodexProfileSpec(profileId, entry);
}

/**
 * Effective bearer token for a codex profile. Same precedence as the claude
 * side (buildProfileEnv): explicit env value > authToken field > the caller's
 * global fallback (built-in dev token / localRouteAuthToken).
 */
export function resolveCodexAuthToken(
  profileId: string,
  spec: CodexProfileSpec | null,
  customProfiles: Record<string, CodexProfileSource> | null | undefined,
  defaultToken: string,
): string {
  const entry = customProfiles?.[profileId];
  const envKey = spec?.launcherEnvKey ?? spec?.envKey;
  const explicit = envKey ? entry?.env?.[envKey] : undefined;
  return explicit ?? entry?.authToken ?? defaultToken;
}

/** Effective base URL for a codex profile: entry.baseUrl > caller fallback. */
export function resolveCodexBaseUrl(
  profileId: string,
  fallback: string,
  customProfiles: Record<string, CodexProfileSource> | null | undefined,
): string {
  return customProfiles?.[profileId]?.baseUrl ?? fallback;
}
