import { lookup } from "node:dns/promises";
import { BrowserServiceError } from "./browser-errors";

const blockedProtocols = new Set(["file:", "javascript:", "data:", "vbscript:"]);

export interface BrowserNetworkPolicy {
  /** Blanket opt-out of the private-network block (COTERM_BROWSER_ALLOW_PRIVATE=1). */
  allowPrivateNetwork?: boolean;
  /**
   * Per-host opt-out (COTERM_BROWSER_ALLOW_HOSTS). Blanket allow is too coarse when the only
   * thing you actually need is one Tailscale box; this lets that host through and nothing else.
   * An entry may be a bare host (`100.64.0.1`, any port) or host:port (`127.0.0.1:43127`).
   * host:port matters for loopback: opening all of 127.0.0.1 would also expose every other local
   * service — the LLM proxy, a trading daemon — which is never what the caller meant.
   */
  allowHosts?: ReadonlySet<string>;
}

/** Parse the COTERM_BROWSER_ALLOW_HOSTS comma list into the set the policy expects. */
export function parseAllowedHosts(value: string | undefined): ReadonlySet<string> {
  return new Set((value ?? "").split(",").map((entry) => entry.trim().toLowerCase()).filter(Boolean));
}

function hostAllowed(url: Pick<URL, "hostname" | "port">, options: BrowserNetworkPolicy): boolean {
  if (options.allowPrivateNetwork) return true;
  const allowed = options.allowHosts;
  if (!allowed || allowed.size === 0) return false;
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
  return allowed.has(host) || (url.port !== "" && allowed.has(`${host}:${url.port}`));
}

export function validateBrowserUrl(value: string, options: BrowserNetworkPolicy = {}): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new BrowserServiceError("policy_denied", "Browser URL is invalid.");
  }
  if (blockedProtocols.has(url.protocol.toLowerCase())) throw new BrowserServiceError("policy_denied", "This URL scheme is blocked.");
  if (url.protocol !== "http:" && url.protocol !== "https:" && url.protocol !== "about:") {
    throw new BrowserServiceError("policy_denied", "Only HTTP(S) browser URLs are allowed.");
  }
  if (url.username || url.password) throw new BrowserServiceError("policy_denied", "Browser URLs may not contain credentials.");
  if (!hostAllowed(url, options) && isPrivateHostname(url.hostname)) {
    throw new BrowserServiceError("policy_denied", "Private-network browser navigation is disabled by policy.");
  }
  return url;
}

/** Validate both the URL spelling and the current DNS answer before navigation. */
export async function validateBrowserRequestUrl(value: string, options: BrowserNetworkPolicy = {}): Promise<URL> {
  const url = validateBrowserUrl(value, options);
  if (hostAllowed(url, options) || (url.protocol !== "http:" && url.protocol !== "https:") || isPrivateHostname(url.hostname)) return url;
  try {
    const records = await lookup(url.hostname, { all: true, verbatim: true });
    if (records.some((record) => isPrivateHostname(record.address))) {
      throw new BrowserServiceError("policy_denied", "Browser navigation resolved to a private network.");
    }
  } catch (error) {
    if (error instanceof BrowserServiceError) throw error;
    throw new BrowserServiceError("policy_denied", "Browser hostname could not be verified.");
  }
  return url;
}

export function isPrivateHostname(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
  return host === "localhost" || host.endsWith(".localhost") || host === "::1" || host === "0.0.0.0" ||
    /^127\./.test(host) || /^10\./.test(host) || /^192\.168\./.test(host) ||
    /^172\.(1[6-9]|2\d|3[0-1])\./.test(host) || /^169\.254\./.test(host) ||
    // CGNAT is 100.64.0.0/10 = 100.64–100.127. The old pattern stopped at 100.99, so most of
    // a Tailscale tailnet was never actually blocked.
    /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(host) || host.endsWith(".local") ||
    /^f[cd][0-9a-f]{2}:/i.test(host) || /^fe[89ab][0-9a-f]:/i.test(host) ||
    /^::ffff:(?:127\.|10\.|192\.168\.|172\.(?:1[6-9]|2\d|3[0-1])\.)/i.test(host);
}

export function validateProfileId(profileId: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(profileId)) throw new BrowserServiceError("policy_denied", "Browser profile ID is invalid.");
  return profileId;
}

export type BrowserRiskLevel = 0 | 1 | 2 | 3;
export function browserRisk(action: string, target?: { role?: string; name?: string }): BrowserRiskLevel {
  if (["snapshot", "screenshot", "extract", "list", "search_index", "wait"].includes(action)) return 0;
  if (["upload", "download", "submit", "login", "clipboard", "permission"].includes(action)) return 2;
  if (action === "fill" && /password|passcode|secret|mfa|verification/i.test(`${target?.role ?? ""} ${target?.name ?? ""}`)) return 3;
  if (action === "evaluate") return 3;
  return 1;
}
