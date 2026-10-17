import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import {
  CODEX_TEAM_MARKER,
  codexTeamConfigPath,
  ensureCodexTeamConfig,
  renderCodexTeamConfig,
  resolveCodexTeamTemplateDir,
} from "../../src/main/providers/codex-team-setup";

// Mirrors the bundled tools/codex-team/codex-team.config.toml.example layout
// (marker + /v1 proxy URL + __NODE__/__BRIDGE__ env) without importing the file,
// so the test pins the contract both sides agreed on.
const TEMPLATE = [
  "# coterm-managed: codex-team v1",
  'model = "gpt-6.1-sol"',
  'model_provider = "openai"',
  "",
  "[model_providers.team_free]",
  'name = "Friend server models via local proxy"',
  'base_url = "__PROXY__/v1"',
  'wire_api = "responses"',
  'experimental_bearer_token = "free-backend"',
  "requires_openai_auth = false",
  "",
  "[mcp_servers.codex_team]",
  'command = "__NODE__"',
  'args = ["__BRIDGE__"]',
  'env = { ELECTRON_RUN_AS_NODE = "1", CODEX_TEAM_PROXY_URL = "__PROXY__" }',
  "startup_timeout_sec = 15",
  "default_tools_approval_mode = \"auto\"",
  "",
].join("\n");

let templateDir: string;
let codexDir: string;

function writeTemplate(content: string = TEMPLATE): void {
  writeFileSync(join(templateDir, "codex-team.config.toml.example"), content, "utf8");
}

function setupOptions() {
  return {
    templateDir,
    execPath: "C:/Program Files/nodejs/node.exe",
    proxyUrl: "http://127.0.0.1:8787/",
    codexDir,
  };
}

beforeEach(() => {
  templateDir = mkdtempSync(join(tmpdir(), "codex-team-tpl-"));
  codexDir = mkdtempSync(join(tmpdir(), "codex-team-home-"));
  writeTemplate();
});

describe("renderCodexTeamConfig", () => {
  it("fills machine paths and leaves no placeholders", () => {
    const rendered = renderCodexTeamConfig(TEMPLATE, {
      node: "C:/Program Files/nodejs/node.exe",
      bridge: "D:/Coterm/tools/codex-team/bridge.mjs",
      proxy: "http://127.0.0.1:8787",
    });
    expect(rendered).not.toContain("__NODE__");
    expect(rendered).not.toContain("__BRIDGE__");
    expect(rendered).not.toContain("__PROXY__");
    expect(rendered).toContain('command = "C:/Program Files/nodejs/node.exe"');
    expect(rendered).toContain('args = ["D:/Coterm/tools/codex-team/bridge.mjs"]');
    expect(rendered).toContain('base_url = "http://127.0.0.1:8787/v1"');
    expect(rendered).toContain('CODEX_TEAM_PROXY_URL = "http://127.0.0.1:8787"');
  });

  it("keeps the coterm-managed marker on the first line", () => {
    const rendered = renderCodexTeamConfig(TEMPLATE, {
      node: "node.exe",
      bridge: "bridge.mjs",
      proxy: "http://127.0.0.1:8787",
    });
    expect(rendered.startsWith(CODEX_TEAM_MARKER)).toBe(true);
  });
});

describe("ensureCodexTeamConfig", () => {
  it("renders a fresh config when none exists", () => {
    const status = ensureCodexTeamConfig(setupOptions());
    expect(status).toBe("rendered");
    const target = codexTeamConfigPath(codexDir);
    expect(existsSync(target)).toBe(true);
    const content = readFileSync(target, "utf8");
    expect(content.startsWith(CODEX_TEAM_MARKER)).toBe(true);
    expect(content).toContain(`command = "${JSON.stringify("C:/Program Files/nodejs/node.exe").slice(1, -1)}"`);
    expect(content).toContain('base_url = "http://127.0.0.1:8787/v1"');
    expect(content).not.toContain("__NODE__");
    expect(content).not.toContain("__BRIDGE__");
    expect(content).not.toContain("__PROXY__");
  });

  it("is a no-op when the on-disk file already matches", () => {
    expect(ensureCodexTeamConfig(setupOptions())).toBe("rendered");
    expect(ensureCodexTeamConfig(setupOptions())).toBe("unchanged");
  });

  it("backs up a hand-made (non-managed) file before overwriting", () => {
    const target = codexTeamConfigPath(codexDir);
    writeFileSync(target, 'model = "gpt-5"\n# my own tweaks\n', "utf8");
    const status = ensureCodexTeamConfig(setupOptions());
    expect(status).toBe("backed-up");
    const siblings = readdirSync(codexDir).filter((name) => name.startsWith("codex-team.config.toml.backup-"));
    expect(siblings).toHaveLength(1);
    expect(readFileSync(join(codexDir, siblings[0]!), "utf8")).toContain("# my own tweaks");
    expect(readFileSync(target, "utf8").startsWith(CODEX_TEAM_MARKER)).toBe(true);
  });

  it("overwrites a managed file without keeping a backup", () => {
    const target = codexTeamConfigPath(codexDir);
    ensureCodexTeamConfig(setupOptions());
    writeFileSync(target, `${CODEX_TEAM_MARKER}\n${TEMPLATE.slice(CODEX_TEAM_MARKER.length + 1)}`.replace('model = "gpt-6.1-sol"', 'model = "gpt-6.2-sol"'), "utf8");
    const status = ensureCodexTeamConfig(setupOptions());
    expect(status).toBe("rendered");
    expect(readdirSync(codexDir).filter((name) => name.startsWith("codex-team.config.toml.backup-"))).toHaveLength(0);
    expect(existsSync(target)).toBe(true);
  });

  it("reports missing-template and writes nothing when the template is absent", () => {
    writeFileSync(join(templateDir, "codex-team.config.toml.example"), "model = \"gpt-5\"\n", "utf8");
    const target = codexTeamConfigPath(codexDir);
    const status = ensureCodexTeamConfig(setupOptions());
    expect(status).toBe("missing-template");
    expect(existsSync(target)).toBe(false);
  });

  it("does not write when the render leaves placeholders behind", () => {
    writeTemplate(TEMPLATE.replace('base_url = "__PROXY__/v1"', 'base_url = "__LEFTOVER__/v1"'));
    const target = codexTeamConfigPath(codexDir);
    const status = ensureCodexTeamConfig(setupOptions());
    expect(status).toBe("error");
    expect(existsSync(target)).toBe(false);
  });
});

describe("resolveCodexTeamTemplateDir", () => {
  it("uses resources/codex-team when packaged", () => {
    expect(resolveCodexTeamTemplateDir({ isPackaged: true, resourcesPath: "C:/App/resources", appPath: "C:/App" })).toBe(
      join("C:/App/resources", "codex-team"),
    );
  });

  it("uses tools/codex-team in dev", () => {
    expect(resolveCodexTeamTemplateDir({ isPackaged: false, resourcesPath: "C:/App/resources", appPath: "D:/Coterm" })).toBe(
      join("D:/Coterm", "tools", "codex-team"),
    );
  });
});
