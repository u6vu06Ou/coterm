import { readFile } from "node:fs/promises";

// Stable default; the Beta channel passes its own (app-identity.ts). Keeping
// the stable value here means existing callers/tests resolve unchanged.
const DEFAULT_PORT = 43_127;

export type AuthMode = "cloudflare" | "tailscale";

interface Environment {
  COTERM_ACCESS_TEAM_DOMAIN?: string;
  COTERM_ACCESS_AUD?: string;
  COTERM_WEB_PORT?: string;
  COTERM_ALLOWED_ORIGIN?: string;
  COTERM_AUTH_MODE?: string;
  COTERM_ALLOWED_LOGIN?: string;
  COTERM_ALLOWED_HOSTS?: string;
}

interface WebConfigBase {
  origin: string;
  port: number;
  allowedHosts: string[];
  remoteRoots?: string[];
}

export type WebConfig = WebConfigBase & (
  | { authMode: "cloudflare"; teamDomain: string; audience: string }
  | { authMode: "tailscale"; allowedLogin?: string }
);

function normalizeAuthMode(value: string | undefined): AuthMode | undefined {
  const trimmed = value?.trim().toLowerCase();
  if (trimmed === "tailscale") return "tailscale";
  if (trimmed === "cloudflare") return "cloudflare";
  return undefined;
}

function parsePort(raw: string | undefined, defaultPort: number): number {
  const port = raw ? Number(raw) : defaultPort;
  if (!Number.isInteger(port) || port < 20_000 || port > 49_151) {
    throw new Error("Invalid Coterm web port.");
  }
  return port;
}

function parseAllowedHosts(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(/[;,]/)
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

export function readWebConfig(environment: Environment, defaultPort: number = DEFAULT_PORT): WebConfig | null {
  const authMode = normalizeAuthMode(environment.COTERM_AUTH_MODE);
  const teamDomain = environment.COTERM_ACCESS_TEAM_DOMAIN?.trim();
  const audience = environment.COTERM_ACCESS_AUD?.trim();
  const port = parsePort(environment.COTERM_WEB_PORT, defaultPort);
  const origin = environment.COTERM_ALLOWED_ORIGIN?.trim() || "self";

  if (authMode === "tailscale") {
    const allowedLogin = environment.COTERM_ALLOWED_LOGIN?.trim() || undefined;
    return {
      authMode: "tailscale",
      origin,
      port,
      ...(allowedLogin ? { allowedLogin } : {}),
      allowedHosts: parseAllowedHosts(environment.COTERM_ALLOWED_HOSTS),
    };
  }

  // Default / explicit cloudflare mode: require CF teamDomain + audience.
  if (!teamDomain || !audience) return null;
  return {
    authMode: "cloudflare",
    teamDomain,
    audience,
    origin,
    port,
    allowedHosts: parseAllowedHosts(environment.COTERM_ALLOWED_HOSTS),
  };
}

export async function readStoredWebConfig(
  path: string,
  environment: Environment = {},
  defaultPort: number = DEFAULT_PORT,
): Promise<WebConfig | null> {
  try {
    const value = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
    const env: Environment = {
      COTERM_WEB_PORT: String(defaultPort),
    };
    if (typeof value.teamDomain === "string") env.COTERM_ACCESS_TEAM_DOMAIN = value.teamDomain;
    if (typeof value.audience === "string") env.COTERM_ACCESS_AUD = value.audience;
    if (typeof value.authMode === "string") env.COTERM_AUTH_MODE = value.authMode;
    if (typeof value.allowedOrigin === "string") env.COTERM_ALLOWED_ORIGIN = value.allowedOrigin;
    if (typeof value.allowedLogin === "string") env.COTERM_ALLOWED_LOGIN = value.allowedLogin;
    if (Array.isArray(value.allowedHosts)) {
      env.COTERM_ALLOWED_HOSTS = value.allowedHosts
        .filter((item): item is string => typeof item === "string" && item.length > 0)
        .join(";");
    }
    const config = readWebConfig({ ...env, ...environment }, defaultPort);
    if (!config) return null;
    return {
      ...config,
      remoteRoots: Array.isArray(value.remoteRoots)
        ? value.remoteRoots.filter((item): item is string => typeof item === "string" && item.length > 0)
        : [],
    };
  } catch {
    return null;
  }
}
