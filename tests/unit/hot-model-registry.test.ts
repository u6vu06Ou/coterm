import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AgentOption } from "../../src/shared/types";
import {
  DEFAULT_AUTH_TOKEN,
  DEFAULT_PROXY_URL,
  DEFAULT_PROFILES,
  buildActiveProfiles,
  buildProfileEnv,
  localRouteAuthToken,
  type ClaudeProfile,
} from "../../src/main/providers/profiles-config";
import {
  allShimProfilesFor,
  ensureAgentShims,
  supportedAgentProfilesFor,
} from "../../src/main/providers/agent-shims";
import {
  buildAgentLaunchCommand,
  buildAgentApiImplementerCommand,
  codexLocalConfigArgs,
  codexLocalEnv,
  customProfileEnvLines,
  supportedAgentProfiles,
} from "../../src/main/providers/agent-launch";
import {
  buildCodexAppServerArguments,
  codexAppServerEnvironment,
} from "../../src/main/providers/codex-app-server";
import { isContextMeterProfile } from "../../src/main/terminal/context-meter";
import { getLogFilePath, initLogger, logger } from "../../src/main/core/logger";
import { appSettingsSchema, appSettingsPatchSchema } from "../../src/shared/schema";
import { deriveAgentOptions, freeAgentGroups, pickerOptionOrder } from "../../src/shared/agent-options";
import {
  BUILTIN_AGENT_OPTIONS,
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
} from "../../src/shared/types";

/** Hot model registry (stage 1): settings.customProfiles ⊕ DEFAULT_PROFILES. */
describe("hot model registry", () => {
  const customProfile: ClaudeProfile = {
    model: "test-model-x",
    local: true,
    env: { ANTHROPIC_MODEL: "test-model-x", CLAUDE_CODE_MAX_CONTEXT_TOKENS: "150000" },
  };
  const customTable = buildActiveProfiles({ "claude-testx": customProfile });

  describe("buildActiveProfiles", () => {
    it("returns the DEFAULT_PROFILES instance when nothing is customized", () => {
      expect(buildActiveProfiles(undefined)).toBe(DEFAULT_PROFILES);
      expect(buildActiveProfiles(null)).toBe(DEFAULT_PROFILES);
      expect(buildActiveProfiles({})).toBe(DEFAULT_PROFILES);
    });

    it("merges custom profiles over defaults (custom wins by id)", () => {
      expect(customTable["claude-testx"]).toEqual(customProfile);
      expect(customTable["claude-local-main"]).toEqual(DEFAULT_PROFILES["claude-local-main"]);
      expect(Object.keys(customTable)).toContain("claude-local-long2");
    });

    it("keeps DEFAULT_PROFILES unmutated when merging", () => {
      expect("claude-testx" in DEFAULT_PROFILES).toBe(false);
    });
  });

  describe("buildProfileEnv with an active table", () => {
    it("resolves env and proxy URL for a custom profile", () => {
      const env = buildProfileEnv("claude-testx", "http://127.0.0.1:8787", customTable);
      expect(env.ANTHROPIC_MODEL).toBe("test-model-x");
      expect(env.ANTHROPIC_BASE_URL).toBe("http://127.0.0.1:8787");
      expect(env.CLAUDE_CODE_MAX_CONTEXT_TOKENS).toBe("150000");
    });

    it("returns {} for unknown ids (fail closed)", () => {
      expect(buildProfileEnv("claude-nope", "http://127.0.0.1:8787", customTable)).toEqual({});
    });
  });

  describe("allowlist derivation", () => {
    it("admits local custom claude profiles and keeps the codex free list", () => {
      const supported = supportedAgentProfiles(customTable);
      expect(supported).toContain("claude-testx");
      expect(supported).toContain("codex-local-main");
      expect(supported).toContain("claude-local-main");
    });

    it("never admits non-local (paid) profiles into the agentapi allowlist", () => {
      const paid = buildActiveProfiles({
        "claude-paidx": { local: false, env: {} },
      });
      const supported = supportedAgentProfilesFor(paid);
      expect(supported).not.toContain("claude-paidx");
      expect(supported).not.toContain("claude-official");
    });
  });

  describe("shim generation from the active table", () => {
    let userData: string;

    beforeEach(() => {
      userData = mkdtempSync(join(tmpdir(), "coterm-hot-registry-"));
      ensureAgentShims(userData, "http://127.0.0.1:8787", {
        registerPath: false,
        profileTable: customTable,
      });
    });

    afterEach(() => {
      rmSync(userData, { recursive: true, force: true });
    });

    it("writes a shim for the custom profile with its model and env", () => {
      const content = readFileSync(join(userData, "agent-launchers", "claude-testx.ps1"), "utf8");
      expect(content).toContain("$env:ANTHROPIC_MODEL='test-model-x'");
      expect(content).toContain("$env:CLAUDE_CODE_MAX_CONTEXT_TOKENS='150000'");
      expect(content).toContain("$env:ANTHROPIC_BASE_URL='http://127.0.0.1:8787'");
      expect(content).toContain("'--model', 'test-model-x'");
    });

    it("keeps builtin shims registered alongside the custom one", () => {
      const profiles = allShimProfilesFor(customTable);
      expect(profiles).toContain("claude-testx");
      expect(profiles).toContain("claude-local-main");
      expect(profiles).toContain("gemini");
    });

    it("launches a custom profile through its shim", () => {
      const command = buildAgentLaunchCommand("claude-testx", "D:\\proj", null, null, customTable);
      expect(command).toContain("claude-testx.ps1'");
    });
  });

  describe("no-shim fallback for custom profiles", () => {
    it("builds the env wall from the active table instead of the hardcoded one", () => {
      const lines = customProfileEnvLines("claude-testx", customTable);
      expect(lines).toContain("$env:ANTHROPIC_MODEL='test-model-x'");
      expect(lines).toContain("$env:ANTHROPIC_BASE_URL='http://127.0.0.1:8787'");
      expect(lines).toContain("$env:CLAUDE_CODE_DISABLE_AGENT_VIEW='1'");
    });

    it("rejects profiles outside the active table allowlist (fail closed)", () => {
      expect(buildAgentLaunchCommand("claude-ghost", "D:\\proj", null, null, customTable)).toBeNull();
    });
  });

  describe("settings schema", () => {
    it("accepts a valid custom profile and defaults to {}", () => {
      expect(appSettingsSchema.parse({}).customProfiles).toEqual({});
      const parsed = appSettingsSchema.parse({
        customProfiles: {
          "claude-testx": { local: true, model: "test-model-x", env: { ANTHROPIC_MODEL: "test-model-x" } },
        },
      });
      expect(parsed.customProfiles["claude-testx"]?.model).toBe("test-model-x");
    });

    it("keeps the patch optional", () => {
      expect(appSettingsPatchSchema.parse({})).toEqual({});
      expect(appSettingsPatchSchema.parse({ customProfiles: {} })).toEqual({ customProfiles: {} });
    });

    it("accepts codex-harness ids but rejects reserved shim ids", () => {
      // Stage 2 (codex half): schema no longer bans codex- ids — a registered
      // codex entry drives the codex harness through BUILTIN_CODEX_PROFILES ⊕
      // deriveCodexProfileSpec. Reserved app-managed ids stay rejected.
      const parsed = appSettingsPatchSchema.parse({
        customProfiles: { "codex-custom": { local: true, env: {} } },
      });
      expect(parsed.customProfiles?.["codex-custom"]).toMatchObject({ local: true });
      for (const reserved of ["claude-official", "codex-official", "gemini", "council"]) {
        expect(() => appSettingsPatchSchema.parse({
          customProfiles: { [reserved]: { local: true, env: {} } },
        })).toThrow();
      }
    });

    it("rejects malformed ids and non-local-representing entries", () => {
      expect(() => appSettingsPatchSchema.parse({
        customProfiles: { "Bad_Id!": { local: true, env: {} } },
      })).toThrow();
      expect(() => appSettingsPatchSchema.parse({
        customProfiles: { "claude-x": { local: "yes", env: {} } },
      })).toThrow();
    });
  });

  // Hot model registry (stage 1, renderer half): the profilesChanged push /
  // picker fallback all run through these pure functions. The full order
  // below is the DOM order the e2e picker spec asserts — single source of truth.
  describe("derived agent options (shared pipeline)", () => {
    it("returns exactly the built-ins when nothing is customized", () => {
      // Same ids in the same order; codex options additionally carry their
      // resolved spec, because the static spec table is the only place their
      // model name lives and grouping/probing/launchers must read one value.
      const withoutSpec = (options: AgentOption[]) => options.map(({ codex: _codex, ...rest }) => rest);
      expect(withoutSpec(deriveAgentOptions(undefined))).toEqual(withoutSpec([...BUILTIN_AGENT_OPTIONS]));
      expect(deriveAgentOptions({})).toHaveLength(12);
      const derived = deriveAgentOptions(undefined);
      expect(derived.find((option) => option.id === "codex-local-main")?.codex?.model).toBe("my-glm-flash");
      expect(derived.find((option) => option.id === "codex-local-max")?.codex?.model).toBe("my-glm-max");
      expect(derived.find((option) => option.id === "claude-local-main")?.codex).toBeUndefined();
    });

    it("appends a custom profile with label/model/local and keeps built-ins", () => {
      const options = deriveAgentOptions({
        "claude-hotprobe": { local: true, label: "Hot Probe", model: "hot-model-x", env: {} },
      });
      const probe = options.find((option) => option.id === "claude-hotprobe");
      expect(probe).toMatchObject({ label: "Hot Probe", model: "hot-model-x", local: true, harness: "claude" });
      expect(options).toHaveLength(13);
      expect(options.map((option) => option.id)).toContain("claude-local-main");
    });

    it("overrides a built-in in place when ids collide", () => {
      const options = deriveAgentOptions({
        "claude-local-main": { local: true, label: "GLM 重貼", model: "glm-hot", env: {} },
      });
      expect(options.find((option) => option.id === "claude-local-main")).toMatchObject({
        label: "GLM 重貼",
        model: "glm-hot",
        local: true,
      });
      expect(options).toHaveLength(12);
    });

    it("keeps the picker DOM order stable (e2e contract)", () => {
      expect(pickerOptionOrder(deriveAgentOptions()).map((option) => option.id)).toEqual([
        "claude-local-main",
        "claude-local-long2",
        "claude-local-freeform",
        "codex-local-main",
        "codex-local-long2",
        "codex-local-max",
        "gemini",
        "claude-official",
        "codex-official",
        "codex-team",
      ]);
    });

    it("drops empty groups and slots a paid custom profile into PAID", () => {
      const groups = freeAgentGroups([...BUILTIN_AGENT_OPTIONS]);
      expect(groups.map((group) => group.group)).toEqual(["claude", "codex", "other"]);
      const withPaidCustom = deriveAgentOptions({ "claude-paidx": { local: false, label: "Paid X", env: {} } });
      expect(freeAgentGroups(withPaidCustom).flatMap((group) => group.agents.map((a) => a.id)))
        .not.toContain("claude-paidx");
      expect(pickerOptionOrder(withPaidCustom).map((option) => option.id)).toContain("claude-paidx");
    });
  });

  // Stage 2: per-profile baseUrl/authToken for public users filling their own
  // provider (OpenRouter/Groq/…). Precedence: explicit profile.env values >
  // baseUrl/authToken fields > global proxyUrl / built-in dev token.
  describe("per-profile baseUrl/authToken (stage 2)", () => {
    // Not sk- prefixed on purpose: this token must be caught by the
    // camelCase authToken redaction pattern, not by the sk- prefix pattern.
    const siteToken = "opaque-token-Zx91QvLm7g2k";
    const routedTable = buildActiveProfiles({
      "claude-openroute": {
        local: true,
        model: "openrouter-model-a",
        baseUrl: "https://openrouter.example/api",
        authToken: siteToken,
        env: { ANTHROPIC_MODEL: "openrouter-model-a" },
      },
    });

    it("(a) uses the profile's own baseUrl/authToken instead of the global values", () => {
      const env = buildProfileEnv("claude-openroute", "http://127.0.0.1:8787", routedTable, "global-token-AAAA");
      expect(env.ANTHROPIC_BASE_URL).toBe("https://openrouter.example/api");
      expect(env.ANTHROPIC_AUTH_TOKEN).toBe(siteToken);
    });

    it("(a2) bakes the profile credentials into the generated shim", () => {
      const userData = mkdtempSync(join(tmpdir(), "coterm-stage2-shim-"));
      try {
        ensureAgentShims(userData, "http://127.0.0.1:8787", {
          registerPath: false,
          profileTable: routedTable,
        });
        const content = readFileSync(join(userData, "agent-launchers", "claude-openroute.ps1"), "utf8");
        expect(content).toContain("$env:ANTHROPIC_BASE_URL='https://openrouter.example/api'");
        expect(content).toContain(`$env:ANTHROPIC_AUTH_TOKEN='${siteToken}'`);
      } finally {
        rmSync(userData, { recursive: true, force: true });
      }
    });

    it("(b) falls back to the global proxy URL / token when the profile has neither", () => {
      const env = buildProfileEnv("claude-testx", "http://127.0.0.1:9099", customTable);
      expect(env.ANTHROPIC_BASE_URL).toBe("http://127.0.0.1:9099");
      expect(env.ANTHROPIC_AUTH_TOKEN).toBe("coterm-local-dev");
      // Built-in profiles are unchanged (old contract).
      const builtin = buildProfileEnv("claude-local-main", "http://127.0.0.1:8787");
      expect(builtin.ANTHROPIC_BASE_URL).toBe("http://127.0.0.1:8787");
      expect(builtin.ANTHROPIC_AUTH_TOKEN).toBe("coterm-local-dev");
      // A caller-supplied global token overrides the built-in dev token.
      expect(buildProfileEnv("claude-testx", "http://x", customTable, siteToken).ANTHROPIC_AUTH_TOKEN)
        .toBe(siteToken);
    });

    it("(c) explicit profile.env values override the baseUrl/authToken fields", () => {
      const explicitTable = buildActiveProfiles({
        "claude-explicitx": {
          local: true,
          baseUrl: "https://field.example",
          authToken: "field-token-AAAA",
          env: {
            ANTHROPIC_MODEL: "explicit-model",
            ANTHROPIC_BASE_URL: "https://explicit-env.example",
            ANTHROPIC_AUTH_TOKEN: "explicit-env-token-BBBB",
          },
        },
      });
      const env = buildProfileEnv("claude-explicitx", "http://127.0.0.1:8787", explicitTable);
      expect(env.ANTHROPIC_BASE_URL).toBe("https://explicit-env.example");
      expect(env.ANTHROPIC_AUTH_TOKEN).toBe("explicit-env-token-BBBB");
    });

    it("(c2) explicit undefined strips the credential keys — fields do not resurrect them", () => {
      const strippedTable = buildActiveProfiles({
        "claude-stripx": {
          local: true,
          baseUrl: "https://field.example",
          authToken: "field-token-AAAA",
          env: {
            ANTHROPIC_MODEL: "strip-model",
            ANTHROPIC_BASE_URL: undefined,
            ANTHROPIC_AUTH_TOKEN: undefined,
          },
        },
      });
      const env = buildProfileEnv("claude-stripx", "http://127.0.0.1:8787", strippedTable);
      expect("ANTHROPIC_BASE_URL" in env).toBe(false);
      expect("ANTHROPIC_AUTH_TOKEN" in env).toBe(false);
    });

    it("accepts baseUrl/authToken on custom profile entries in the settings schema", () => {
      const parsed = appSettingsSchema.parse({
        customProfiles: {
          "claude-openroute": {
            local: true,
            baseUrl: "https://openrouter.example/api",
            authToken: siteToken,
            env: { ANTHROPIC_MODEL: "openrouter-model-a" },
          },
        },
      });
      expect(parsed.customProfiles["claude-openroute"]).toMatchObject({
        baseUrl: "https://openrouter.example/api",
        authToken: siteToken,
      });
    });

    it("localRouteAuthToken honors a claude-local-main override and defaults to the dev token", () => {
      expect(localRouteAuthToken()).toBe("coterm-local-dev");
      expect(localRouteAuthToken(buildActiveProfiles({
        "claude-local-main": { local: true, env: {}, authToken: "probe-token-CCCC" },
      }))).toBe("probe-token-CCCC");
    });

    it("buildAgentApiImplementerCommand carries the profile-resolved token", () => {
      const command = buildAgentApiImplementerCommand({
        cwd: "D:\\proj",
        prompt: "task",
        sessionId: "123e4567-e89b-42d3-a456-426614174001",
        proxyUrl: "http://127.0.0.1:8787",
        authToken: "probe-token-CCCC",
        resume: false,
      });
      expect(command).toContain("$env:ANTHROPIC_AUTH_TOKEN='probe-token-CCCC'");
    });

    it("(d) a profile authToken never reaches the log output", () => {
      const logDir = mkdtempSync(join(tmpdir(), "coterm-stage2-log-"));
      try {
        initLogger({ userDataDir: logDir, level: "debug" });
        // Worst case: the full profile table (token included) is passed as a
        // log message. The logger sink must redact before the write.
        logger.info(
          "provider",
          "profiles.changed",
          `Active profiles: ${JSON.stringify(routedTable)}`,
        );
        const log = readFileSync(getLogFilePath(), "utf8");
        expect(log).not.toContain(siteToken);
        expect(log).toContain("[REDACTED]");
      } finally {
        rmSync(logDir, { recursive: true, force: true });
      }
    });
  });

  // Stage 2 (codex half): codex- profiles register via customProfiles and ride
  // the same hot-reload pipeline — no hand-written branches anywhere. The
  // built-ins MUST keep producing the exact tokens the old if-chains emitted.
  describe("codex hot registry (stage 2, codex half)", () => {
    // Not sk- prefixed on purpose: must be caught by the redaction patterns,
    // not by any prefix heuristic.
    const codexToken = "opaque-codex-token-Kv83Rm2Wqy";

    const routedCodexTable = buildActiveProfiles({
      "codex-openroute": {
        local: true,
        model: "openrouter-model-b",
        baseUrl: "https://openrouter.example/api",
        authToken: codexToken,
        env: {},
      },
    });
    const plainCodexTable = buildActiveProfiles({
      "codex-myx": { local: true, model: "my-x-model", label: "My X", env: {} },
    });

    it("(a) a custom codex profile registers and appears in the picker's codex column", () => {
      const options = deriveAgentOptions({
        "codex-myx": { local: true, label: "My X", model: "my-x-model", env: {} },
      });
      const probe = options.find((option) => option.id === "codex-myx");
      expect(probe).toMatchObject({ harness: "codex", local: true, label: "My X" });
      // Attached spec is secrets-free and derived from the id/entry.
      expect(probe?.codex).toMatchObject({
        provider: "myx",
        model: "my-x-model",
        providerName: "My X",
        envKey: "MYX_API_KEY",
        home: "private",
      });
      const codexGroup = freeAgentGroups(options).find((group) => group.group === "codex");
      expect(codexGroup?.agents.map((agent) => agent.id)).toContain("codex-myx");
    });

    it("(b) app-server uses the profile's own baseUrl/authToken and falls back to the global values", () => {
      expect(buildCodexAppServerArguments("codex-openroute", "http://127.0.0.1:8787", routedCodexTable))
        .toContain('model_providers.openroute.base_url="https://openrouter.example/api/v1"');
      expect(codexAppServerEnvironment("codex-openroute", { PATH: "bin" }, routedCodexTable))
        .toEqual({ PATH: "bin", OPENROUTE_API_KEY: codexToken });

      // No baseUrl/authToken on the entry → proxyUrl / built-in dev token.
      expect(buildCodexAppServerArguments("codex-myx", "http://127.0.0.1:9099", plainCodexTable))
        .toContain('model_providers.myx.base_url="http://127.0.0.1:9099/v1"');
      expect(codexAppServerEnvironment("codex-myx", { PATH: "bin" }, plainCodexTable))
        .toEqual({ PATH: "bin", MYX_API_KEY: DEFAULT_AUTH_TOKEN });
    });

    it("(c) a codex route authToken never reaches the log output", () => {
      const logDir = mkdtempSync(join(tmpdir(), "coterm-stage2b-log-"));
      try {
        initLogger({ userDataDir: logDir, level: "debug" });
        const env = codexAppServerEnvironment("codex-openroute", { PATH: "bin" }, routedCodexTable);
        logger.info(
          "provider",
          "codex.appserver.environment",
          `Codex env: ${JSON.stringify(env)}; table: ${JSON.stringify(routedCodexTable)}`,
        );
        const log = readFileSync(getLogFilePath(), "utf8");
        expect(log).not.toContain(codexToken);
        expect(log).toContain("[REDACTED]");
      } finally {
        rmSync(logDir, { recursive: true, force: true });
      }
    });

    it("(d) built-in codex app-server args are byte-identical to the old if-chains", () => {
      const proxy = "http://127.0.0.1:8787";
      expect(buildCodexAppServerArguments("codex-local-long2", proxy)).toEqual([
        "app-server", "--listen", "stdio://",
        "-c", 'model_provider="myqwen"',
        "-c", `model="${MYQWEN_MODEL}"`,
        "-c", `model_context_window=${MYQWEN_CODEX_CONTEXT_WINDOW}`,
        "-c", `model_max_output_tokens=${MYQWEN_CODEX_MAX_OUTPUT_TOKENS}`,
        "-c", `model_auto_compact_token_limit=${MYQWEN_CODEX_AUTO_COMPACT_TOKEN_LIMIT}`,
        "-c", `model_auto_compact_token_limit_scope="${MYQWEN_CODEX_AUTO_COMPACT_TOKEN_LIMIT_SCOPE}"`,
        "-c", 'model_reasoning_effort="high"',
        "-c", 'model_providers.myqwen.name="Qwen Local"',
        "-c", 'model_providers.myqwen.base_url="http://127.0.0.1:8787/v1"',
        "-c", 'model_providers.myqwen.env_key="MYQWEN_API_KEY"',
        "-c", 'model_providers.myqwen.wire_api="responses"',
      ]);
      expect(buildCodexAppServerArguments("codex-local-main", proxy)).toEqual([
        "app-server", "--listen", "stdio://",
        "-c", 'model_provider="glm"',
        "-c", 'model="my-glm-flash"',
        "-c", `model_context_window=${MYGLM_CODEX_CONTEXT_WINDOW}`,
        "-c", `model_max_output_tokens=${MYGLM_CODEX_MAX_OUTPUT_TOKENS}`,
        "-c", `model_auto_compact_token_limit=${MYGLM_CODEX_AUTO_COMPACT_TOKEN_LIMIT}`,
        "-c", `model_auto_compact_token_limit_scope="${MYGLM_CODEX_AUTO_COMPACT_TOKEN_LIMIT_SCOPE}"`,
        "-c", 'model_reasoning_effort="high"',
        "-c", 'model_providers.glm.name="GLM Local Flash"',
        "-c", 'model_providers.glm.base_url="http://127.0.0.1:8787/v1"',
        "-c", 'model_providers.glm.env_key="GLM_API_KEY"',
        "-c", 'model_providers.glm.wire_api="responses"',
      ]);
      expect(buildCodexAppServerArguments("codex-local-max", proxy)).toEqual([
        "app-server", "--listen", "stdio://",
        "-c", 'model_provider="my-glm-max"',
        "-c", `model="${MYGLMMAX_MODEL}"`,
        "-c", `model_context_window=${MYGLM_CODEX_CONTEXT_WINDOW}`,
        "-c", `model_max_output_tokens=${MYGLM_CODEX_MAX_OUTPUT_TOKENS}`,
        "-c", `model_auto_compact_token_limit=${MYGLM_CODEX_AUTO_COMPACT_TOKEN_LIMIT}`,
        "-c", `model_auto_compact_token_limit_scope="${MYGLM_CODEX_AUTO_COMPACT_TOKEN_LIMIT_SCOPE}"`,
        "-c", 'model_reasoning_effort="high"',
        "-c", 'model_providers.my-glm-max.name="GLM Local Max"',
        "-c", 'model_providers.my-glm-max.base_url="http://127.0.0.1:8787/v1"',
        "-c", 'model_providers.my-glm-max.env_key="MYGLMMAX_API_KEY"',
        "-c", 'model_providers.my-glm-max.wire_api="responses"',
      ]);
      // codex-official stays the bare app-server invocation.
      expect(buildCodexAppServerArguments("codex-official", proxy))
        .toEqual(["app-server", "--listen", "stdio://"]);
    });

    it("(d2) built-in codex launch args/env are byte-identical to the old if-chains", () => {
      expect(codexLocalConfigArgs("codex-local-long2")).toEqual([
        `-c 'model_provider="myqwen"'`,
        `-c 'model="${MYQWEN_MODEL}"'`,
        `-c 'model_context_window=${MYQWEN_CODEX_CONTEXT_WINDOW}'`,
        `-c 'model_max_output_tokens=${MYQWEN_CODEX_MAX_OUTPUT_TOKENS}'`,
        `-c 'model_auto_compact_token_limit=${MYQWEN_CODEX_AUTO_COMPACT_TOKEN_LIMIT}'`,
        `-c 'model_auto_compact_token_limit_scope="${MYQWEN_CODEX_AUTO_COMPACT_TOKEN_LIMIT_SCOPE}"'`,
        `-c 'model_reasoning_effort="high"'`,
        `-c 'model_providers.myqwen.name="Qwen Local"'`,
        `-c 'model_providers.myqwen.base_url="${DEFAULT_PROXY_URL}/v1"'`,
        `-c 'model_providers.myqwen.env_key="MYQWEN_API_KEY"'`,
        `-c 'model_providers.myqwen.wire_api="responses"'`,
      ].join(" "));
      expect(codexLocalEnv("codex-local-long2")).toBe(`$env:MYQWEN_API_KEY='${DEFAULT_AUTH_TOKEN}'; `);
      expect(codexLocalEnv("codex-local-main")).toBe(`$env:GLM_API_KEY='${DEFAULT_AUTH_TOKEN}'; `);
      expect(codexLocalEnv("codex-local-max")).toBe(`$env:MYGLMMAX_API_KEY='${DEFAULT_AUTH_TOKEN}'; `);
      // codex-local-long (legacy shared home) and unregistered ids keep the caller
      // fallback: "" from both helpers. codex-team (official home, config in
      // the rendered TOML) also keeps "" — no private proxy wiring.
      expect(codexLocalConfigArgs("codex-local-long")).toBe("");
      expect(codexLocalEnv("codex-local-long")).toBe("");
      expect(codexLocalConfigArgs("codex-official")).toBe("");
      expect(codexLocalEnv("codex-official")).toBe("");
      expect(codexLocalConfigArgs("codex-team")).toBe("");
      expect(codexLocalEnv("codex-team")).toBe("");
    });

    it("(d3) a registered custom codex entry gets a private-home shim and enters the allowlist", () => {
      const userData = mkdtempSync(join(tmpdir(), "coterm-stage2b-shim-"));
      try {
        ensureAgentShims(userData, "http://127.0.0.1:8787", {
          registerPath: false,
          profileTable: plainCodexTable,
        });
        const content = readFileSync(join(userData, "agent-launchers", "codex-myx.ps1"), "utf8");
        expect(content).toContain("codex-homes\\codex-myx");
        expect(content).toContain("$env:MYX_API_KEY='coterm-local-dev'");
        expect(content).toContain("'model_provider=\"myx\"'");
        expect(supportedAgentProfilesFor(plainCodexTable)).toContain("codex-myx");
        // Fail-closed: a non-local (public provider) codex entry stays off
        // the agentapi allowlist.
        const publicCodexTable = buildActiveProfiles({
          "codex-paidx": { local: false, model: "paid-model", env: {} },
        });
        expect(supportedAgentProfilesFor(publicCodexTable)).not.toContain("codex-paidx");
      } finally {
        rmSync(userData, { recursive: true, force: true });
      }
    });

    it("meters registered custom codex entries (context-meter table)", () => {
      expect(isContextMeterProfile("claude-official")).toBe(true);
      expect(isContextMeterProfile("codex-local-long2")).toBe(true);
      expect(isContextMeterProfile("codex-local-main")).toBe(false);
      expect(isContextMeterProfile("codex-local-max")).toBe(false);
      expect(isContextMeterProfile("codex-local-long")).toBe(false);
      expect(isContextMeterProfile("codex-myx", { "codex-myx": { label: "My X" } })).toBe(true);
      // Without the active table the legacy closed set applies.
      expect(isContextMeterProfile("codex-myx")).toBe(false);
      expect(isContextMeterProfile(null)).toBe(false);
    });
  });
});
