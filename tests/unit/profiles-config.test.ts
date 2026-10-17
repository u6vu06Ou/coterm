import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_AUTH_TOKEN,
  DEFAULT_PROXY_URL,
  DEFAULT_PROFILES,
  loadProfilesConfig,
} from "../../src/main/providers/profiles-config";

function makeTempDir(): string {
  return mkdtempSync(join(tmpdir(), "coterm-profiles-"));
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("loadProfilesConfig", () => {
  it("writes the built-in default profiles.json when the file is absent and returns the built-in profiles", () => {
    const dir = makeTempDir();
    const profilesPath = join(dir, "profiles.json");
    const result = loadProfilesConfig(dir);

    expect(result.profiles).toEqual(DEFAULT_PROFILES);
    expect(result.proxyUrl).toBe(DEFAULT_PROXY_URL);
    expect(result.authToken).toBe(DEFAULT_AUTH_TOKEN);
    const written = JSON.parse(readFileSync(profilesPath, "utf8")) as {
      profiles: unknown;
      proxyUrl: unknown;
    };
    expect(written.profiles).toEqual(DEFAULT_PROFILES);
    expect(written.proxyUrl).toBe(DEFAULT_PROXY_URL);

    rmSync(dir, { recursive: true, force: true });
  });

  it("returns the custom file content when a valid profiles.json exists", () => {
    const dir = makeTempDir();
    const custom = {
      proxyUrl: "http://my-proxy:8080",
      authToken: "custom-token-xyz",
      profiles: {
        "claude-local-main": {
          model: "claude-sonnet-4-6",
          local: true,
          env: { ANTHROPIC_MODEL: "claude-sonnet-4-6", ANTHROPIC_AUTH_TOKEN: "custom-token-xyz" },
        },
      },
    };
    writeFileSync(join(dir, "profiles.json"), JSON.stringify(custom), "utf8");

    const result = loadProfilesConfig(dir);

    expect(result.proxyUrl).toBe("http://my-proxy:8080");
    expect(result.authToken).toBe("custom-token-xyz");
    expect(result.profiles["claude-local-main"]!.model).toBe("claude-sonnet-4-6");
    expect(result.profiles["claude-local-main"]!.env.ANTHROPIC_AUTH_TOKEN).toBe("custom-token-xyz");

    rmSync(dir, { recursive: true, force: true });
  });

  it("falls back to the built-in default and warns (without throwing) when profiles.json fails zod validation", () => {
    const dir = makeTempDir();
    writeFileSync(join(dir, "profiles.json"), JSON.stringify({ profiles: "not-an-object" }), "utf8");

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const result = loadProfilesConfig(dir);

    expect(result.profiles).toEqual(DEFAULT_PROFILES);
    expect(result.proxyUrl).toBe(DEFAULT_PROXY_URL);
    expect(result.authToken).toBe(DEFAULT_AUTH_TOKEN);
    expect(warnSpy).toHaveBeenCalled();

    rmSync(dir, { recursive: true, force: true });
  });
});
