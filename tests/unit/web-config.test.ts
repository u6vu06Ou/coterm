import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { readStoredWebConfig, readWebConfig } from "../../src/main/web/web-config";

describe("Coterm web configuration", () => {
  it("stays disabled until both Access values exist", () => {
    expect(readWebConfig({})).toBeNull();
    expect(readWebConfig({ COTERM_ACCESS_TEAM_DOMAIN: "team.cloudflareaccess.com" })).toBeNull();
  });

  it("uses the configured origin (or localhost default) and a bounded local port", () => {
    expect(readWebConfig({
      COTERM_ACCESS_TEAM_DOMAIN: "team.cloudflareaccess.com",
      COTERM_ACCESS_AUD: "audience",
    })).toEqual({
      authMode: "cloudflare",
      teamDomain: "team.cloudflareaccess.com",
      audience: "audience",
      origin: "self",
      port: 43127,
      allowedHosts: [],
    });
    expect(readWebConfig({
      COTERM_ACCESS_TEAM_DOMAIN: "team.cloudflareaccess.com",
      COTERM_ACCESS_AUD: "audience",
      COTERM_ALLOWED_ORIGIN: "https://coterm.example.com",
    })).toEqual({
      authMode: "cloudflare",
      teamDomain: "team.cloudflareaccess.com",
      audience: "audience",
      origin: "https://coterm.example.com",
      port: 43127,
      allowedHosts: [],
    });
    expect(() => readWebConfig({
      COTERM_ACCESS_TEAM_DOMAIN: "team.cloudflareaccess.com",
      COTERM_ACCESS_AUD: "audience",
      COTERM_WEB_PORT: "8080",
    })).toThrow("Invalid Coterm web port.");
  });

  it("enables Tailscale without Cloudflare values", () => {
    expect(readWebConfig({
      COTERM_AUTH_MODE: "tailscale",
      COTERM_ALLOWED_LOGIN: "owner@example.com",
      COTERM_ALLOWED_HOSTS: "desktop.example.ts.net, localhost",
    })).toEqual({
      authMode: "tailscale",
      origin: "self",
      port: 43127,
      allowedLogin: "owner@example.com",
      allowedHosts: ["desktop.example.ts.net", "localhost"],
    });
  });

  it("lets environment auth mode override stored auth mode while retaining stored credentials", async () => {
    const directory = await mkdtemp(join(tmpdir(), "coterm-web-config-"));
    const file = join(directory, "remote-config.json");
    await writeFile(file, JSON.stringify({
      authMode: "tailscale",
      teamDomain: "team.cloudflareaccess.com",
      audience: "audience",
      allowedLogin: "owner@example.com",
    }));
    await expect(readStoredWebConfig(file, { COTERM_AUTH_MODE: "cloudflare" })).resolves.toMatchObject({
      authMode: "cloudflare",
      teamDomain: "team.cloudflareaccess.com",
      audience: "audience",
    });
    await rm(directory, { recursive: true, force: true });
  });

  it("loads the existing local remote config when desktop starts first", async () => {
    const directory = await mkdtemp(join(tmpdir(), "coterm-web-config-"));
    const file = join(directory, "remote-config.json");
    await writeFile(file, JSON.stringify({
      teamDomain: "team.cloudflareaccess.com",
      audience: "audience",
      remoteRoots: ["D:\\workspace"],
    }));
    await expect(readStoredWebConfig(file)).resolves.toMatchObject({
      teamDomain: "team.cloudflareaccess.com",
      audience: "audience",
      port: 43127,
    });
    await rm(directory, { recursive: true, force: true });
  });
});
