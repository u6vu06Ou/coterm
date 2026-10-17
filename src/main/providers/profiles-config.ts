import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import {
  MYQWEN_CLAUDE_AUTO_COMPACT_PERCENT,
  MYQWEN_CLAUDE_AUTO_COMPACT_WINDOW,
  MYQWEN_CLAUDE_CONTEXT_WINDOW,
  MYQWEN_MODEL,
  MYGLM_MODEL,
  MYGLM_CLAUDE_CONTEXT_WINDOW,
  MYGLM_CLAUDE_AUTO_COMPACT_WINDOW,
  MYGLM_CLAUDE_AUTO_COMPACT_PERCENT,
} from "@shared/types";
import { logger } from "../core/logger";

export interface ClaudeProfile {
  configProfile?: string | undefined;
  /** Renderer-facing display name (hot-model-registry stage 1); defaults derive from id. */
  label?: string | undefined;
  model?: string | undefined;
  local: boolean;
  contextWindow?: number | undefined;
  reasoningEffort?: "low" | "high" | "max" | undefined;
  /**
   * Stage 2: per-profile provider endpoint (e.g. OpenRouter/Groq). Absent →
   * fall back to the caller's global proxyUrl. Precedence: explicit
   * profile.env values beat these fields beat the global fallback.
   */
  baseUrl?: string | undefined;
  /** Stage 2: per-profile bearer token. Same precedence as baseUrl. */
  authToken?: string | undefined;
  env: Record<string, string | undefined>;
}

export const DEFAULT_PROXY_URL = "http://127.0.0.1:8787";
export const DEFAULT_AUTH_TOKEN = "coterm-local-dev";

// Stage 2: the global token no longer lives here — buildProfileEnv injects it
// per profile so profile.authToken can override it (explicit env > field >
// global). Callers that read profile.env directly (claude-adapter) apply the
// same precedence where they spawn.
const localBaseEnv = {
  ANTHROPIC_SMALL_FAST_MODEL: "claude-3-5-haiku-latest",
  DISABLE_TELEMETRY: "1",
  DISABLE_COST_WARNINGS: "1",
  CLAUDE_CODE_ATTRIBUTION_HEADER: "0",
  CLAUDE_CODE_WORKFLOWS: "1",
  DISABLE_GROWTHBOOK: "1",
};

export const DEFAULT_PROFILES: Record<string, ClaudeProfile> = {
  "claude-official": {
    local: false,
    env: {
      ANTHROPIC_BASE_URL: undefined,
      ANTHROPIC_AUTH_TOKEN: undefined,
      ANTHROPIC_MODEL: undefined,
      ANTHROPIC_SMALL_FAST_MODEL: undefined,
    },
  },
  "claude-local-long": {
    local: true,
    model: "claude-3-5-sonnet-latest",
    env: {
      ...localBaseEnv,
      ANTHROPIC_MODEL: "claude-3-5-sonnet-latest",
    },
  },
  "claude-local-freeform": {
    local: true,
    model: "claude-haiku-4-5-20251001",
    env: {
      ...localBaseEnv,
      ANTHROPIC_MODEL: "claude-haiku-4-5-20251001",
    },
  },
  "claude-local-main": {
    local: true,
    model: MYGLM_MODEL,
    contextWindow: MYGLM_CLAUDE_CONTEXT_WINDOW,
    reasoningEffort: "high",
    env: {
      ...localBaseEnv,
      ANTHROPIC_MODEL: MYGLM_MODEL,
      CLAUDE_CODE_DISABLE_LEGACY_MODEL_REMAP: "1",
      CLAUDE_CODE_MAX_CONTEXT_TOKENS: String(MYGLM_CLAUDE_CONTEXT_WINDOW),
      CLAUDE_CODE_AUTO_COMPACT_WINDOW: String(MYGLM_CLAUDE_AUTO_COMPACT_WINDOW),
      CLAUDE_AUTOCOMPACT_PCT_OVERRIDE: String(MYGLM_CLAUDE_AUTO_COMPACT_PERCENT),
    },
  },
  "claude-local-long2": {
    local: true,
    model: MYQWEN_MODEL,
    contextWindow: MYQWEN_CLAUDE_CONTEXT_WINDOW,
    reasoningEffort: "high",
    env: {
      ...localBaseEnv,
      ANTHROPIC_MODEL: MYQWEN_MODEL,
      CLAUDE_CODE_DISABLE_LEGACY_MODEL_REMAP: "1",
      CLAUDE_CODE_MAX_CONTEXT_TOKENS: String(MYQWEN_CLAUDE_CONTEXT_WINDOW),
      CLAUDE_CODE_AUTO_COMPACT_WINDOW: String(MYQWEN_CLAUDE_AUTO_COMPACT_WINDOW),
      CLAUDE_AUTOCOMPACT_PCT_OVERRIDE: String(MYQWEN_CLAUDE_AUTO_COMPACT_PERCENT),
    },
  },
  // Codex Team (#100): official Codex lead, no proxy env (see agent-launch.ts).
  // configProfile drives `codex --profile codex-team`; the model list here only
  // feeds picker context — actual model selection lives in the codex-team TOML.
  "codex-team": {
    local: false,
    label: "Codex Team",
    model: "gpt-6.1-sol",
    configProfile: "codex-team",
    env: {},
  },
};

const envSchema = z.record(z.string(), z.union([z.string(), z.undefined()]));

const profileSchema = z.object({
  configProfile: z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/).optional(),
  label: z.string().optional(),
  model: z.string().optional(),
  local: z.boolean(),
  contextWindow: z.number().int().positive().optional(),
  reasoningEffort: z.enum(["low", "high", "max"]).optional(),
  baseUrl: z.string().url().optional(),
  authToken: z.string().optional(),
  env: envSchema,
});

const configSchema = z.object({
  proxyUrl: z.string().default(DEFAULT_PROXY_URL),
  authToken: z.string().default(DEFAULT_AUTH_TOKEN),
  profiles: z.record(z.string(), profileSchema).default(DEFAULT_PROFILES),
});

export interface ProfilesConfig {
  proxyUrl: string;
  authToken: string;
  profiles: Record<string, ClaudeProfile>;
}

export const PROFILES_FILE = "profiles.json";

export function defaultConfig(): ProfilesConfig {
  return {
    proxyUrl: DEFAULT_PROXY_URL,
    authToken: DEFAULT_AUTH_TOKEN,
    profiles: structuredClone(DEFAULT_PROFILES),
  };
}

export function loadProfilesConfig(userDataPath: string): ProfilesConfig {
  const filePath = join(userDataPath, PROFILES_FILE);
  if (!existsSync(filePath)) {
    const fresh = defaultConfig();
    try {
      writeFileSync(filePath, JSON.stringify(fresh, null, 2), "utf8");
    } catch (error) {
      logger.warn(
        "provider",
        "profiles.config.write_failed",
        `Failed to write default ${PROFILES_FILE}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    return fresh;
  }
  try {
    const raw = readFileSync(filePath, "utf8");
    const parsed = configSchema.parse(JSON.parse(raw));
    return {
      proxyUrl: parsed.proxyUrl,
      authToken: parsed.authToken,
      profiles: {
        ...structuredClone(DEFAULT_PROFILES),
        ...(parsed.profiles as Record<string, ClaudeProfile>),
      },
    };
  } catch (error) {
    logger.warn(
      "provider",
      "profiles.config.invalid",
      `${PROFILES_FILE} failed validation; falling back to built-in defaults: ${error instanceof Error ? error.message : String(error)}`,
    );
    return defaultConfig();
  }
}

/**
 * Hot model registry (stage 1): compose the ACTIVE profile table — the built-in
 * DEFAULT_PROFILES overlaid with the user's `settings.customProfiles`. Merge
 * semantics mirror loadProfilesConfig (:182-185): defaults first, then custom
 * entries override by id. Callers must re-derive per consumption (main reads
 * settings on every call; no closure caching) so a saved profile takes effect
 * without restart. Empty/absent input returns the DEFAULT_PROFILES instance.
 */
export function buildActiveProfiles(
  customProfiles?: Record<string, ClaudeProfile> | null,
): Record<string, ClaudeProfile> {
  const entries = customProfiles ? Object.entries(customProfiles) : [];
  if (entries.length === 0) return DEFAULT_PROFILES;
  return {
    ...structuredClone(DEFAULT_PROFILES),
    ...Object.fromEntries(entries),
  };
}

/**
 * Build the env-var map for a local claude-* profile, suitable for injecting at
 * pty.spawn (no terminal echo). Merges sanitized process env + profile.env
 * (undefined values deleted, matching claude-adapter) + ANTHROPIC_BASE_URL for
 * local profiles. Returns only string values (spawn env shape).
 *
 * Single source of truth: claude-adapter (headless -p runs) and dock-layout
 * (interactive PTY tiles) both build env the same way via this helper.
 *
 * Stage 2 precedence for the two credential env keys: explicit profile.env
 * values (including explicit `undefined` = strip) > profile.baseUrl/authToken
 * fields > the global proxyUrl/authToken arguments.
 */
export function buildProfileEnv(
  profileId: string,
  proxyUrl: string,
  profileTable: Record<string, ClaudeProfile> = DEFAULT_PROFILES,
  authToken: string = DEFAULT_AUTH_TOKEN,
): Record<string, string> {
  const profile = profileTable[profileId];
  if (!profile) return {};
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(profile.env)) {
    if (value !== undefined) env[key] = value;
  }
  if (profile.local) {
    if (!("ANTHROPIC_BASE_URL" in profile.env)) env.ANTHROPIC_BASE_URL = profile.baseUrl ?? proxyUrl;
    if (!("ANTHROPIC_AUTH_TOKEN" in profile.env)) env.ANTHROPIC_AUTH_TOKEN = profile.authToken ?? authToken;
  }
  return env;
}

/**
 * Stage 2: effective token for the local-bridge route (provider status probe,
 * agentapi launcher env walls). A per-profile override on the flagship local
 * route (claude-local-main) beats the built-in dev token; profiles without the field
 * keep the global default, so existing behavior is unchanged.
 */
export function localRouteAuthToken(
  profileTable: Record<string, ClaudeProfile> = DEFAULT_PROFILES,
): string {
  return profileTable["claude-local-main"]?.authToken ?? DEFAULT_AUTH_TOKEN;
}
