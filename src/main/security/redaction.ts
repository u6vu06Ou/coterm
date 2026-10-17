const secretPatterns: RegExp[] = [
  /\bsk-[A-Za-z0-9_-]{8,}\b/g,
  /\bgsk_[A-Za-z0-9]{12,}\b/g,
  /\b(?:ghp|github_pat)_[A-Za-z0-9_]{8,}\b/g,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{12,}\b/gi,
  /\b(?:[A-Za-z0-9]{1,32}[_-]){0,4}(?:api[_-]?key|auth[_-]?token|secret|password)\s*[=:]\s*["']?[^"'\s]{8,}/gi,
  // Stage 2 per-profile credentials reach logs in camelCase/JSON form
  // ("authToken":"…" / authToken=…); the UPPER-only generic pass below misses them.
  /"?(?:authToken|auth_token|apiKey|api_key)"?\s*[:=]\s*"?[^"'\s]{4,}/gi,
  /\b\d{8,12}:[A-Za-z0-9_-]{20,}\b/g,
  /\bANTHROPIC_AUTH_TOKEN\s*=\s*['"](ccr-local|coterm-local-dev)['"]/gi,
  /\bAIza[0-9A-Za-z_-]{20,}\b/g,
];

export function redactSecrets(value: string): string {
  const secrets = secretPatterns.reduce(
    (current, pattern) => current.replace(pattern, () => "[REDACTED]"),
    value,
  );
  return secrets
    .replace(/\$env:([A-Z][A-Z0-9_]{0,63})\s*=\s*(?![=])(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s;,\r\n]*)/gi, (_match, name: string) => `$env:${name}=[REDACTED]`)
    .replace(/\b([A-Z][A-Z0-9_]{0,63})\s*=\s*(?![=])(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s;,\r\n]*)/g, "$1=[REDACTED]");
}

const homeCandidates: string[] = (() => {
  const candidates: string[] = [];
  const userProfile = process.env.USERPROFILE;
  if (userProfile) candidates.push(userProfile);
  const home = process.env.HOME;
  if (home) candidates.push(home);
  return candidates
    .filter((candidate, index, array) => candidate && array.indexOf(candidate) === index)
    .sort((left, right) => right.length - left.length);
})();

export function redactPii(value: string): string {
  let result = value;
  for (const candidate of homeCandidates) {
    if (result.includes(candidate)) {
      result = result.split(candidate).join("~");
    }
  }
  return result
    // Windows may expose the same profile as either an 8.3 path
    // (C:\Users\RUNNER~1) or its long form (C:\Users\runneradmin).
    // Redact the profile component independently of that aliasing.
    .replace(/[A-Za-z]:[\\/]+Users[\\/]+[^\\/\s"]+/gi, "~")
    .replace(/\/home\/[^/\s"]+/g, "~");
}

export function redactEgress(value: string): string {
  try {
    return redactSecrets(redactPii(value));
  } catch {
    return "[REDACT-FAILED]";
  }
}

/** Apply egress redaction to JSON-shaped values without touching JSON syntax. */
export function redactEgressValue<T>(value: T): T {
  if (typeof value === "string") return redactEgress(value) as T;
  if (Array.isArray(value)) {
    return (value as unknown[]).map((item) => redactEgressValue(item)) as unknown as T;
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, item]) => [key, redactEgressValue(item)]),
    ) as T;
  }
  return value;
}

/**
 * Strip query-string VALUES (keys stay, they are usually benign) plus hash
 * fragments. URLs in network logs must not leak tokens riding in the query
 * (?api_key=..., ?session=...) — the same rule the log sink already applies
 * to free-form text. Falls back to generic egress redaction when unparseable.
 */
export function redactUrlQuery(value: string): string {
  try {
    const url = new URL(value);
    for (const key of [...url.searchParams.keys()]) {
      url.searchParams.set(key, "[REDACTED]");
    }
    url.hash = "";
    // Redact origin+path ONLY: running the secret patterns over the final
    // string would match the surviving `api_key=[REDACTED]` key=value tail and
    // nuke the whole query. The query values are already neutralized above.
    return `${redactSecrets(redactPii(url.origin + url.pathname))}${url.search}`;
  } catch {
    return redactEgress(value);
  }
}

export function safeErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return redactEgress(error.message);
  }
  return redactEgress(String(error));
}
