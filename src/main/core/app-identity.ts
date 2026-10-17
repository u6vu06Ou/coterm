// Release-channel identity (v1.5 side-by-side Beta, work order section 5 Phase 0C).
//
// Stable v1.4.11 (baseline b6fe775) owns the legacy identity. The Beta must
// install and run NEXT TO stable without touching its live data, so every
// shared resource below is channel-scoped:
//   - appId / productName           (installer + single-instance naming)
//   - userData dir name             (SQLite, settings, logs, checkpoints,
//                                    browser-profiles, agent-launchers,
//                                    session-index.db, agent-api-token.txt
//                                    all live under userData already)
//   - remote-config dir name        (%LOCALAPPDATA%\<configDirName>)
//   - default Agent API / web port  (43127 stable, 43128 beta)
//
// Channel resolution order: COTERM_CHANNEL env override (tests/dev),
// then package version semver prerelease (any "-" tag => non-stable build).
// Stable keeps the EXACT legacy values so the live install at
// %APPDATA%\Coterm is never renamed, migrated, or opened by a Beta.

export type AppChannel = "stable" | "beta";

export interface AppIdentity {
  channel: AppChannel;
  version: string;
  productName: string;
  appId: string;
  /** Directory name under %APPDATA% that becomes app.getPath("userData"). */
  userDataDirName: string;
  /** Directory name under %LOCALAPPDATA% holding remote-config.json. */
  configDirName: string;
  /** Default Agent API / web port when COTERM_WEB_PORT is unset. */
  defaultWebPort: number;
  isBeta: boolean;
}

const STABLE = {
  channel: "stable" as const,
  productName: "Coterm",
  appId: "io.coterm.app",
  userDataDirName: "Coterm",
  configDirName: "Coterm",
  defaultWebPort: 43_127,
  isBeta: false,
};

const BETA = {
  channel: "beta" as const,
  productName: "Coterm Beta",
  appId: "io.coterm.app.beta",
  userDataDirName: "Coterm Beta",
  configDirName: "Coterm Beta",
  defaultWebPort: 43_128,
  isBeta: true,
};

export const STABLE_IDENTITY: Omit<AppIdentity, "version"> = STABLE;
export const BETA_IDENTITY: Omit<AppIdentity, "version"> = BETA;

function normalizeChannel(raw: string | undefined): AppChannel | null {
  const value = raw?.trim().toLowerCase();
  if (value === "stable") return "stable";
  if (value === "beta") return "beta";
  return null;
}

/** Any prerelease semver tag (1.5.0-beta.1, 1.5.0-rc.1) is a non-stable build. */
export function channelFromVersion(version: string): AppChannel {
  return version.includes("-") ? "beta" : "stable";
}

export function resolveAppIdentity(
  version: string,
  environment: { COTERM_CHANNEL?: string } = process.env,
): AppIdentity {
  const channel = normalizeChannel(environment.COTERM_CHANNEL) ?? channelFromVersion(version);
  const base = channel === "beta" ? BETA : STABLE;
  return { ...base, version };
}
