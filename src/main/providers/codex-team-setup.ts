import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parse as parseToml } from "smol-toml";
import { logger } from "../core/logger";

/**
 * Codex Team config bootstrap (work #100 follow-up): renders the bundled
 * `codex-team.config.toml.example` template into `~/.codex/codex-team.config.toml`
 * with machine paths filled in, so `codex --profile codex-team` works out of the
 * box instead of silently running plain Codex when the file is hand-made/missing.
 *
 * Template contract (shared with the bridge-port teammate, verbatim):
 * - first line: `# coterm-managed: codex-team v1`
 * - `"__NODE__"` → process.execPath (the template sets ELECTRON_RUN_AS_NODE=1)
 * - `"__BRIDGE__"` → absolute path of bridge.mjs (forward slashes)
 * - `__PROXY__` → proxy base URL without trailing slash (bare token; covers
 *   both `"__PROXY__"` and `"__PROXY__/v1"` inside quotes)
 *
 * Pure fs/path/smol-toml — no electron import, so unit tests can drive it.
 * Never touches `~/.codex/config.toml` or `auth.json`; never throws to callers.
 */

export const CODEX_TEAM_MARKER = "# coterm-managed: codex-team v1";
export const CODEX_TEAM_TEMPLATE_NAME = "codex-team.config.toml.example";
export const CODEX_TEAM_CONFIG_NAME = "codex-team.config.toml";

export type CodexTeamSetupStatus =
  | "rendered"      // wrote a fresh config
  | "unchanged"     // rendered output byte-identical to what's on disk
  | "backed-up"     // existing non-managed file preserved as a backup, then overwritten
  | "missing-template"
  | "error";

export function codexTeamConfigPath(codexDir: string = join(homedir(), ".codex")): string {
  return join(codexDir, CODEX_TEAM_CONFIG_NAME);
}

/** Template dir from the bundling contract: packaged → resources/codex-team, dev → tools/codex-team. */
export function resolveCodexTeamTemplateDir(options: {
  isPackaged: boolean;
  resourcesPath: string;
  appPath: string;
}): string {
  return options.isPackaged
    ? join(options.resourcesPath, "codex-team")
    : join(options.appPath, "tools", "codex-team");
}

export interface CodexTeamRenderInputs {
  node: string;
  bridge: string;
  proxy: string;
}

/**
 * Fill the template placeholders. Quoted forms go first for node/bridge
 * (JSON string quoting is valid TOML basic-string quoting), then the bare
 * token as a fallback for hand-variants; `__PROXY__` stays a plain URL so both
 * `"__PROXY__"` and `"__PROXY__/v1"` resolve inside quotes.
 */
export function renderCodexTeamConfig(template: string, inputs: CodexTeamRenderInputs): string {
  const proxy = inputs.proxy.replace(/\/+$/, "");
  const nodeJson = JSON.stringify(inputs.node);
  const bridgeJson = JSON.stringify(inputs.bridge);
  return template
    .replaceAll('"__NODE__"', nodeJson)
    .replaceAll('"__BRIDGE__"', bridgeJson)
    .replaceAll("__NODE__", nodeJson)
    .replaceAll("__BRIDGE__", bridgeJson)
    .replaceAll("__PROXY__", proxy);
}

/**
 * Ensure `~/.codex/codex-team.config.toml` exists and is coterm-managed.
 * - on-disk file identical → no-op ("unchanged")
 * - on-disk file with the coterm-managed marker → overwrite
 * - on-disk file WITHOUT the marker (hand-made/prototype) → copy to
 *   `codex-team.config.toml.backup-<timestamp>` first, then overwrite
 * - any leftover `__...__` placeholder or unparseable output → do NOT write
 *   (contract mismatch — the bridge-port template delivers the placeholders)
 */
export function ensureCodexTeamConfig(options: {
  templateDir: string;
  execPath: string;
  proxyUrl: string;
  codexDir?: string;
}): CodexTeamSetupStatus {
  try {
    const codexDir = options.codexDir ?? join(homedir(), ".codex");
    const templatePath = join(options.templateDir, CODEX_TEAM_TEMPLATE_NAME);
    if (!existsSync(templatePath)) {
      return "missing-template";
    }
    const template = readFileSync(templatePath, "utf8");
    if (!template.startsWith(CODEX_TEAM_MARKER)) {
      logger.warn("provider", "codex-team.template-invalid", "codex-team.config.toml.example does not start with the coterm-managed marker; not writing.", {
        templatePath,
      });
      return "missing-template";
    }
    const bridgePath = join(options.templateDir, "bridge.mjs").replaceAll("\\", "/");
    const rendered = renderCodexTeamConfig(template, {
      node: options.execPath,
      bridge: bridgePath,
      proxy: options.proxyUrl,
    });
    const leftovers = rendered.match(/__[A-Za-z0-9_]+__/g);
    if (leftovers?.length) {
      logger.warn("provider", "codex-team.template-leftovers", "codex-team template has unresolved placeholders; not writing. Update the bundled template.", {
        placeholders: [...new Set(leftovers)],
      });
      return "error";
    }
    try {
      parseToml(rendered);
    } catch (error) {
      logger.warn("provider", "codex-team.render-invalid", "Rendered codex-team.config.toml does not parse as TOML; not writing.", {
        error: error instanceof Error ? error.message : String(error),
      });
      return "error";
    }
    const target = codexTeamConfigPath(codexDir);
    let status: CodexTeamSetupStatus = "rendered";
    if (existsSync(target)) {
      const current = readFileSync(target, "utf8");
      if (current === rendered) return "unchanged";
      if (!current.startsWith(CODEX_TEAM_MARKER)) {
        const backupPath = join(codexDir, `${CODEX_TEAM_CONFIG_NAME}.backup-${Date.now()}`);
        copyFileSync(target, backupPath);
        status = "backed-up";
      }
    } else {
      mkdirSync(codexDir, { recursive: true });
    }
    writeFileSync(target, rendered, "utf8");
    logger.info("provider", "codex-team.config.ready", "Codex Team config written from the bundled template.", {
      target,
      status,
    });
    return status;
  } catch (error) {
    logger.warn("provider", "codex-team.setup-failed", "Codex Team config setup failed; keeping the existing file untouched.", {
      error: error instanceof Error ? error.message : String(error),
    });
    return "error";
  }
}
