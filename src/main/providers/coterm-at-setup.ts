import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { logger } from "../core/logger";

/**
 * coterm-at bootstrap: teach the agents in Coterm panes about the `cot` mail
 * CLI (cross-pane @-mentions).
 *
 * Two surfaces, both best-effort and non-destructive:
 *
 * 1. Claude Code skill — copies the bundled SKILL.md into
 *    `~/.claude/skills/coterm-at/SKILL.md`. Updated in place ONLY when the
 *    bundled version stamp is newer; a copy without the coterm-managed stamp
 *    (user-edited or hand-made) is never clobbered — it stays and we log.
 *
 * 2. Codex — codex CLI has no skills dir contract, so a small protocol block
 *    is maintained inside `~/.codex/AGENTS.md` between a managed marker pair:
 *    created if missing, appended if absent, replaced between markers when the
 *    version moves. A start marker without its end marker is left alone.
 *
 * Bundling contract (same as codex-team): packaged → resources/coterm-at,
 * dev → tools/coterm-at. Pure fs — no electron import; never throws to callers.
 */

export const COTERM_AT_STAMP_PREFIX = "coterm-managed: coterm-at v";
export const COTERM_AT_SKILL_NAME = "SKILL.md";
export const COTERM_AT_BLOCK_TEMPLATE_NAME = "agents-block.md";
export const COTERM_AT_BLOCK_TEMPLATE_VERSION = 2;

const BLOCK_START = /^<!-- coterm-at:managed-block v(\d+) -->$/m;
const BLOCK_END = /^<!-- \/coterm-at:managed-block -->$/m;

export type CotermAtSkillStatus =
  | "installed"       // fresh copy written
  | "updated"         // stamped older copy replaced with the bundled version
  | "unchanged"       // bundled byte-identical, or same stamp version already there
  | "kept-user-copy"  // on-disk file has no coterm-managed stamp — left untouched
  | "missing-template"
  | "error";

export type CotermAtBlockStatus =
  | "written"         // block appended / file created
  | "updated"         // existing managed block replaced
  | "unchanged"       // managed block already byte-identical
  | "missing-template"
  | "error";

/** Template dir from the bundling contract: packaged → resources/coterm-at, dev → tools/coterm-at. */
export function resolveCotermAtTemplateDir(options: {
  isPackaged: boolean;
  resourcesPath: string;
  appPath: string;
}): string {
  return options.isPackaged
    ? join(options.resourcesPath, "coterm-at")
    : join(options.appPath, "tools", "coterm-at");
}

/** Stamp version inside a SKILL.md copy, or null when the stamp is absent (user copy). */
export function cotermAtStampVersion(text: string): number | null {
  const match = new RegExp(COTERM_AT_STAMP_PREFIX + "(\\d+)").exec(text);
  return match ? Number(match[1]) : null;
}

export function cotermAtSkillPath(claudeDir: string = join(homedir(), ".claude")): string {
  return join(claudeDir, "skills", "coterm-at", COTERM_AT_SKILL_NAME);
}

export function ensureCotermAtSkill(options: {
  templateDir: string;
  claudeDir?: string;
}): CotermAtSkillStatus {
  try {
    const templatePath = join(options.templateDir, COTERM_AT_SKILL_NAME);
    if (!existsSync(templatePath)) return "missing-template";
    const bundled = readFileSync(templatePath, "utf8");
    const bundledVersion = cotermAtStampVersion(bundled);
    if (bundledVersion === null) {
      logger.warn("provider", "coterm-at.template-invalid", "coterm-at SKILL.md template has no coterm-managed stamp; not writing.", {
        templatePath,
      });
      return "missing-template";
    }
    const target = cotermAtSkillPath(options.claudeDir);
    let status: CotermAtSkillStatus = "installed";
    if (existsSync(target)) {
      const current = readFileSync(target, "utf8");
      if (current === bundled) return "unchanged";
      const currentVersion = cotermAtStampVersion(current);
      if (currentVersion === null) {
        // User's own file (or an app version before the stamp): never clobber.
        logger.info("provider", "coterm-at.skill.user-copy", "coterm-at SKILL.md on disk has no coterm-managed stamp; keeping it untouched.", {
          target,
        });
        return "kept-user-copy";
      }
      if (currentVersion >= bundledVersion) return "unchanged";
      status = "updated";
    } else {
      const base = options.claudeDir ?? join(homedir(), ".claude");
      mkdirSync(join(base, "skills", "coterm-at"), { recursive: true });
    }
    copyFileSync(templatePath, target);
    logger.info("provider", "coterm-at.skill.ready", "coterm-at Claude skill written from the bundled template.", {
      target,
      version: bundledVersion,
      status,
    });
    return status;
  } catch (error) {
    logger.warn("provider", "coterm-at.skill-failed", "coterm-at skill setup failed; keeping the existing file untouched.", {
      error: error instanceof Error ? error.message : String(error),
    });
    return "error";
  }
}

/**
 * Maintain the coterm-at block inside `~/.codex/AGENTS.md`. Marker semantics:
 * - no file → create the file containing only the block
 * - file without block → append "\n\n" + block
 * - file with a managed block (start+end markers) → replace in place; identical → "unchanged"
 * - start marker without end marker → leave the file alone (log warn)
 */
export function ensureCotermAtCodexBlock(options: {
  templateDir: string;
  codexDir?: string;
}): CotermAtBlockStatus {
  try {
    const templatePath = join(options.templateDir, COTERM_AT_BLOCK_TEMPLATE_NAME);
    if (!existsSync(templatePath)) return "missing-template";
    const block = readFileSync(templatePath, "utf8").replace(/\r\n/g, "\n").trimEnd();
    const startMarker = `<!-- coterm-at:managed-block v${COTERM_AT_BLOCK_TEMPLATE_VERSION} -->`;
    if (!block.startsWith(startMarker)) {
      logger.warn("provider", "coterm-at.block-template-invalid", "coterm-at agents-block.md does not start with its managed-block marker; not writing.", {
        templatePath,
      });
      return "missing-template";
    }
    const codexDir = options.codexDir ?? join(homedir(), ".codex");
    const target = join(codexDir, "AGENTS.md");
    if (!existsSync(target)) {
      mkdirSync(codexDir, { recursive: true });
      writeFileSync(target, block + "\n", "utf8");
      return "written";
    }
    const current = readFileSync(target, "utf8");
    if (!BLOCK_START.test(current) && !BLOCK_END.test(current)) {
      const trimmed = current.trimEnd();
      writeFileSync(target, `${trimmed}\n\n${block}\n`, "utf8");
      return "written";
    }
    const startMatch = BLOCK_START.exec(current);
    const endMatch = BLOCK_END.exec(current);
    if (!startMatch || !endMatch || endMatch.index < startMatch.index) {
      logger.warn("provider", "coterm-at.block-markers-unpaired", "AGENTS.md has an unpaired coterm-at managed-block marker; leaving the file untouched.", {
        target,
      });
      return "unchanged";
    }
    const before = current.slice(0, startMatch.index).trimEnd();
    const after = current.slice(endMatch.index + endMatch[0].length).trimStart();
    const next = `${before}\n\n${block}\n${after}`.trimEnd() + "\n";
    if (next === current) return "unchanged";
    writeFileSync(target, next, "utf8");
    return "updated";
  } catch (error) {
    logger.warn("provider", "coterm-at.block-failed", "coterm-at AGENTS.md block setup failed; keeping the file untouched.", {
      error: error instanceof Error ? error.message : String(error),
    });
    return "error";
  }
}

/** One-call orchestrator used by app bootstrap. Never throws. */
export function ensureCotermAtSetup(options: {
  templateDir: string;
  claudeDir?: string;
  codexDir?: string;
}): { skill: CotermAtSkillStatus; codexBlock: CotermAtBlockStatus } {
  return {
    skill: ensureCotermAtSkill(options),
    codexBlock: ensureCotermAtCodexBlock(options),
  };
}
