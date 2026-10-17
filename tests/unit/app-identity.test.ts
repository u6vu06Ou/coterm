// v1.5 Phase 0C acceptance: the Beta channel must resolve EVERY shared
// resource (appId, productName, userData/SQLite/settings/browser profile/
// token/config dir, Agent API + web default port) differently from stable,
// while stable keeps the exact legacy v1.4.11 values so the live install is
// untouched. package.json's channel (beta train vs stable) must match its
// dist script's builder config.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  BETA_IDENTITY,
  STABLE_IDENTITY,
  channelFromVersion,
  resolveAppIdentity,
} from "../../src/main/core/app-identity";
import { readStoredWebConfig, readWebConfig } from "../../src/main/web/web-config";

const repoRoot = fileURLToPath(new URL("../../", import.meta.url));
const APPDATA = "C:\\Users\\Example\\AppData\\Roaming";
const LOCALAPPDATA = "C:\\Users\\Example\\AppData\\Local";

function channelPaths(dirName: string): Record<string, string> {
  const userData = join(APPDATA, dirName);
  return {
    userData,
    sqlite: join(userData, "ai-terminal.sqlite"),
    settings: join(userData, "settings.json"),
    sessionIndex: join(userData, "session-index.db"),
    browserProfiles: join(userData, "browser-profiles"),
    agentApiToken: join(userData, "agent-api-token.txt"),
    agentLaunchers: join(userData, "agent-launchers"),
    logs: join(userData, "logs"),
  };
}

describe("app identity channels (Phase 0C side-by-side Beta)", () => {
  it("package.json dist script matches the version's channel (beta train vs stable)", () => {
    const pkg = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8")) as {
      version: string;
      scripts: Record<string, string>;
      build: { appId: string; productName: string };
    };
    // The default `dist` script must build the channel the version implies:
    // 1.5.0-beta.N -> beta builder config; plain 1.5.0 -> stable config.
    // Pinned to the train pattern (not an exact N) so collision-guard bumps
    // don't fail the public dist build.
    expect(pkg.version).toMatch(/^1\.5\.\d+(-beta\.\d+)?$/);
    const isBetaTrain = pkg.version.includes("-");
    if (isBetaTrain) {
      expect(pkg.scripts.dist).toContain("electron-builder.beta.json");
    } else {
      expect(pkg.scripts.dist).not.toContain("electron-builder.beta.json");
    }
    expect(pkg.scripts["dist:beta"]).toContain("electron-builder.beta.json");
    expect(pkg.scripts["dist:stable"]).not.toContain("electron-builder.beta.json");
    // The default (stable) builder config keeps the legacy identity.
    expect(pkg.build.appId).toBe("io.coterm.app");
    expect(pkg.build.productName).toBe("Coterm");
  });

  it("stable keeps the exact legacy v1.4.11 values", () => {
    expect(resolveAppIdentity("1.4.11", {})).toMatchObject(STABLE_IDENTITY);
    expect(STABLE_IDENTITY).toEqual({
      channel: "stable",
      productName: "Coterm",
      appId: "io.coterm.app",
      userDataDirName: "Coterm",
      configDirName: "Coterm",
      defaultWebPort: 43_127,
      isBeta: false,
    });
  });

  it("any prerelease version resolves to the beta channel", () => {
    expect(channelFromVersion("1.5.0-beta.1")).toBe("beta");
    expect(channelFromVersion("1.5.0-rc.2")).toBe("beta");
    expect(channelFromVersion("1.4.11")).toBe("stable");
  });

  it("COTERM_CHANNEL overrides the version-derived channel", () => {
    expect(resolveAppIdentity("1.5.0-beta.1", { COTERM_CHANNEL: "stable" }).channel).toBe("stable");
    expect(resolveAppIdentity("1.4.11", { COTERM_CHANNEL: "beta" }).channel).toBe("beta");
    expect(resolveAppIdentity("1.4.11", { COTERM_CHANNEL: "garbage" }).channel).toBe("stable");
  });

  it("beta differs from stable on every shared resource", () => {
    const stable = resolveAppIdentity("1.4.11", {});
    const beta = resolveAppIdentity("1.5.0-beta.1", {});
    expect(beta.appId).not.toBe(stable.appId);
    expect(beta.productName).not.toBe(stable.productName);
    expect(beta.defaultWebPort).not.toBe(stable.defaultWebPort);

    const stablePaths = channelPaths(stable.userDataDirName);
    const betaPaths = channelPaths(beta.userDataDirName);
    for (const key of Object.keys(stablePaths)) {
      expect(betaPaths[key], `${key} must differ`).not.toBe(stablePaths[key]);
      expect(betaPaths[key]?.startsWith(join(APPDATA, "Coterm Beta"))).toBe(true);
    }
    // Stable userData is the untouched legacy path; beta never resolves to it.
    expect(stablePaths.userData).toBe(join(APPDATA, "Coterm"));
    expect(betaPaths.userData).not.toBe(stablePaths.userData);
    // remote-config.json lives under %LOCALAPPDATA%\<configDirName>.
    expect(join(LOCALAPPDATA, beta.configDirName)).not.toBe(join(LOCALAPPDATA, stable.configDirName));
  });

  it("the beta builder config matches the beta identity", () => {
    const cfg = JSON.parse(readFileSync(join(repoRoot, "electron-builder.beta.json"), "utf8")) as {
      appId: string;
      productName: string;
      win: { artifactName: string };
      nsis: { shortcutName: string };
    };
    expect(cfg.appId).toBe(BETA_IDENTITY.appId);
    expect(cfg.productName).toBe(BETA_IDENTITY.productName);
    expect(cfg.nsis.shortcutName).toBe(BETA_IDENTITY.productName);
    expect(cfg.win.artifactName).toBe("Coterm Beta-${version}-Setup.${ext}");
  });

  it("the beta builder config is a full superset of the stable package.json build block", () => {
    // electron-builder treats --config as a WHOLESALE replacement: the
    // package.json `build` block is NOT merged in. Every stable key must
    // therefore be copied into electron-builder.beta.json, with only the
    // identity fields overridden. A drift here silently ships a Beta
    // installer without asarUnpack/file excludes/icon/languages/NSIS opts.
    const pkg = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8")) as {
      build: Record<string, unknown>;
    };
    const beta = JSON.parse(readFileSync(join(repoRoot, "electron-builder.beta.json"), "utf8")) as Record<
      string,
      unknown
    > & { win: Record<string, unknown>; nsis: Record<string, unknown>; directories: Record<string, unknown> };
    const overriddenTop = new Set(["appId", "productName"]);
    for (const [key, value] of Object.entries(pkg.build)) {
      if (overriddenTop.has(key)) continue;
      if (typeof value === "object" && value !== null && !Array.isArray(value)) continue; // nested checked below
      expect(beta[key], `build.${key}`).toEqual(value);
    }
    for (const [key, value] of Object.entries(pkg.build["directories"] as Record<string, unknown>)) {
      expect(beta.directories[key], `directories.${key}`).toEqual(value);
    }
    const overriddenWin = new Set(["artifactName"]);
    for (const [key, value] of Object.entries(pkg.build["win"] as Record<string, unknown>)) {
      if (overriddenWin.has(key)) continue;
      expect(beta.win[key], `win.${key}`).toEqual(value);
    }
    for (const [key, value] of Object.entries(pkg.build["nsis"] as Record<string, unknown>)) {
      expect(beta.nsis[key], `nsis.${key}`).toEqual(value);
    }
    // Identity overrides actually happened — never a re-labeled stable build.
    expect(beta["appId"]).toBe(BETA_IDENTITY.appId);
    expect(beta["productName"]).toBe(BETA_IDENTITY.productName);
  });

  it("web config honors the channel default port and keeps env override", () => {
    const stable = readWebConfig({ COTERM_AUTH_MODE: "tailscale" });
    const beta = readWebConfig({ COTERM_AUTH_MODE: "tailscale" }, BETA_IDENTITY.defaultWebPort);
    expect(stable?.port).toBe(43_127);
    expect(beta?.port).toBe(43_128);
    const overridden = readWebConfig(
      { COTERM_AUTH_MODE: "tailscale", COTERM_WEB_PORT: "44000" },
      BETA_IDENTITY.defaultWebPort,
    );
    expect(overridden?.port).toBe(44_000);
  });

  it("stored web config resolves with the channel default port", async () => {
    const { mkdtemp, writeFile, rm } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const dir = await mkdtemp(join(tmpdir(), "coterm-webcfg-"));
    try {
      const file = join(dir, "remote-config.json");
      await writeFile(file, JSON.stringify({ authMode: "tailscale" }), "utf8");
      const stable = await readStoredWebConfig(file, { COTERM_WEB_PORT: "" });
      const beta = await readStoredWebConfig(file, { COTERM_WEB_PORT: "" }, BETA_IDENTITY.defaultWebPort);
      expect(stable?.port).toBe(43_127);
      expect(beta?.port).toBe(43_128);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
