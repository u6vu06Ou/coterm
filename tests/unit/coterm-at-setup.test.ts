import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  cotermAtSkillPath,
  cotermAtStampVersion,
  ensureCotermAtCodexBlock,
  ensureCotermAtSkill,
  ensureCotermAtSetup,
} from "../../src/main/providers/coterm-at-setup";

// Local template bodies mirror tools/coterm-at/* so the test pins the
// contract without depending on the repo file layout (one repo-layout test at
// the bottom does read the real bundled files). The block's start-marker
// version must match COTERM_AT_BLOCK_TEMPLATE_VERSION in the source.
const SKILL_TEMPLATE = [
  "---",
  "name: coterm-at",
  "description: test",
  "---",
  "",
  "<!-- coterm-managed: coterm-at v2 -->",
  "",
  "# Coterm pane mail (@-mentions)",
  "",
  "cot @codex-2 hello",
].join("\n");

const BLOCK_TEMPLATE = [
  "<!-- coterm-at:managed-block v2 -->",
  "Send: `cot @claude-1 <short message>`.",
  "<!-- /coterm-at:managed-block -->",
].join("\n");

let templateDir: string;
let claudeDir: string;
let codexDir: string;
const cleanups: string[] = [];

function makeTmp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  cleanups.push(dir);
  return dir;
}

beforeEach(() => {
  templateDir = makeTmp("coterm-at-tpl-");
  claudeDir = makeTmp("coterm-at-claude-");
  codexDir = makeTmp("coterm-at-codex-");
  writeFileSync(join(templateDir, "SKILL.md"), SKILL_TEMPLATE, "utf8");
  writeFileSync(join(templateDir, "agents-block.md"), BLOCK_TEMPLATE, "utf8");
});

afterEach(() => {
  for (const dir of cleanups.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("ensureCotermAtSkill", () => {
  it("installs the bundled skill on first run, then reports unchanged", () => {
    const target = cotermAtSkillPath(claudeDir);
    expect(ensureCotermAtSkill({ templateDir, claudeDir })).toBe("installed");
    expect(readFileSync(target, "utf8")).toBe(SKILL_TEMPLATE);
    expect(ensureCotermAtSkill({ templateDir, claudeDir })).toBe("unchanged");
  });

  it("updates an older stamped copy", () => {
    const target = cotermAtSkillPath(claudeDir);
    mkdirSync(join(claudeDir, "skills", "coterm-at"), { recursive: true });
    writeFileSync(target, "<!-- coterm-managed: coterm-at v0 -->\nold body\n", "utf8");
    expect(ensureCotermAtSkill({ templateDir, claudeDir })).toBe("updated");
    expect(readFileSync(target, "utf8")).toBe(SKILL_TEMPLATE);
  });

  it("never clobbers a copy without the coterm-managed stamp", () => {
    const target = cotermAtSkillPath(claudeDir);
    mkdirSync(join(claudeDir, "skills", "coterm-at"), { recursive: true });
    writeFileSync(target, "# my hand-written skill\n", "utf8");
    expect(ensureCotermAtSkill({ templateDir, claudeDir })).toBe("kept-user-copy");
    expect(readFileSync(target, "utf8")).toBe("# my hand-written skill\n");
  });

  it("reports missing-template when the template or its stamp is absent", () => {
    const empty = makeTmp("coterm-at-empty-tpl-");
    expect(ensureCotermAtSkill({ templateDir: empty, claudeDir })).toBe("missing-template");
    mkdirSync(join(empty, "x"), { recursive: true });
    writeFileSync(join(empty, "SKILL.md"), "# no stamp here\n", "utf8");
    expect(ensureCotermAtSkill({ templateDir: empty, claudeDir })).toBe("missing-template");
  });
});

describe("ensureCotermAtCodexBlock", () => {
  const agentsPath = () => join(codexDir, "AGENTS.md");

  it("creates AGENTS.md when missing", () => {
    expect(ensureCotermAtCodexBlock({ templateDir, codexDir })).toBe("written");
    expect(readFileSync(agentsPath(), "utf8")).toBe(BLOCK_TEMPLATE + "\n");
  });

  it("appends the block to an existing hand-written file and reports written", () => {
    writeFileSync(agentsPath(), "# my own codex notes\n", "utf8");
    expect(ensureCotermAtCodexBlock({ templateDir, codexDir })).toBe("written");
    const out = readFileSync(agentsPath(), "utf8");
    expect(out).toContain("# my own codex notes");
    expect(out).toContain(BLOCK_TEMPLATE);
    expect(ensureCotermAtCodexBlock({ templateDir, codexDir })).toBe("unchanged");
  });

  it("replaces an older managed block in place, keeping surrounding content", () => {
    const stale = [
      "# my own codex notes",
      "",
      "<!-- coterm-at:managed-block v0 -->",
      "stale text",
      "<!-- /coterm-at:managed-block -->",
      "",
      "trailing notes",
    ].join("\n") + "\n";
    writeFileSync(agentsPath(), stale, "utf8");
    expect(ensureCotermAtCodexBlock({ templateDir, codexDir })).toBe("updated");
    const out = readFileSync(agentsPath(), "utf8");
    expect(out).toContain("# my own codex notes");
    expect(out).toContain(BLOCK_TEMPLATE);
    expect(out).toContain("trailing notes");
    expect(out).not.toContain("stale text");
  });

  it("leaves a file with unpaired markers untouched", () => {
    const broken = "<!-- coterm-at:managed-block v1 -->\nno end marker\n";
    writeFileSync(agentsPath(), broken, "utf8");
    expect(ensureCotermAtCodexBlock({ templateDir, codexDir })).toBe("unchanged");
    expect(readFileSync(agentsPath(), "utf8")).toBe(broken);
  });

  it("refuses a template that does not start with its block marker", () => {
    writeFileSync(join(templateDir, "agents-block.md"), "no marker\n", "utf8");
    expect(ensureCotermAtCodexBlock({ templateDir, codexDir })).toBe("missing-template");
    expect(existsSync(agentsPath())).toBe(false);
  });
});

describe("bundled repo templates", () => {
  it("tools/coterm-at carries a stamped SKILL.md and a paired managed block", () => {
    const repoTemplateDir = join(process.cwd(), "tools", "coterm-at");
    expect(existsSync(join(repoTemplateDir, "SKILL.md"))).toBe(true);
    expect(existsSync(join(repoTemplateDir, "agents-block.md"))).toBe(true);
    const skill = readFileSync(join(repoTemplateDir, "SKILL.md"), "utf8");
    expect(cotermAtStampVersion(skill)).toBeGreaterThan(0);
    const block = readFileSync(join(repoTemplateDir, "agents-block.md"), "utf8");
    expect(block.startsWith("<!-- coterm-at:managed-block v")).toBe(true);
    expect(block).toContain("<!-- /coterm-at:managed-block -->");
    // Skill protocol must mention the CLI's failure contract.
    expect(skill).toContain("cot who");
  });

  it("the full installer runs both surfaces and returns their statuses", () => {
    const result = ensureCotermAtSetup({ templateDir, claudeDir, codexDir });
    expect(result.skill).toBe("installed");
    expect(result.codexBlock).toBe("written");
  });
});
