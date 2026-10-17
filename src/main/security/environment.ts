const secretEnvironmentKey =
  /(?:^|_)(?:TOKEN|API_KEY|AUTH_TOKEN|ACCESS_TOKEN|REFRESH_TOKEN|SECRET|PASSWORD|PASSWD|PRIVATE_KEY|CLIENT_SECRET|ACCESS_KEY)(?:$|_)/i;

// Suffixes that, when trailing a secret-shaped key, indicate the variable is a
// derived/non-secret reference (e.g. TOKEN_COUNT, PASSWORD_HASH_SALT) rather than
// the credential itself. These must not be stripped from the child environment.
const nonSecretSuffix = /(?:COUNT|PATH|DIR|SALT|ALIAS|URL)$/i;

export function sanitizedChildEnvironment(
  source: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(source).filter(
      (entry): entry is [string, string] =>
        entry[1] !== undefined &&
        !(secretEnvironmentKey.test(entry[0]) && !nonSecretSuffix.test(entry[0])),
    ),
  );
}
