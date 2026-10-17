export const LIVE_VOICE_ROOM_PREFIX = "voice-";
export const LIVE_VOICE_USER_IDENTITY_PREFIX = "user-";
export const LIVE_VOICE_AGENT_IDENTITY_PREFIX = "agent-";
/** Token lifetime in seconds (work order §1.3: 10 minutes). */
export const LIVE_VOICE_TOKEN_TTL_SECONDS = 600;

// livekit-server-sdk loads lazily: the package (with its ffi-native dependency
// chain) is no longer shipped with the app, so a load failure must surface as
// a catchable error from this async function, never a module-load crash.

export interface IssueLiveVoiceTokenInput {
  voiceSessionId: string;
  apiKey: string;
  apiSecret: string;
  identity: string;
  ttlSeconds?: number;
}

export function liveVoiceRoomName(voiceSessionId: string): string {
  return `${LIVE_VOICE_ROOM_PREFIX}${voiceSessionId}`;
}

/**
 * Signs a short-lived join token for one voice session. The token itself is
 * join material — it travels over IPC to the renderer but must never be
 * logged, same as the api key/secret pair (work order §1.4 redact rules).
 */
export async function issueLiveVoiceToken(input: IssueLiveVoiceTokenInput): Promise<string> {
  const voiceSessionId = boundedId(input.voiceSessionId);
  const identity = boundedId(input.identity);
  const { AccessToken } = await import("livekit-server-sdk");
  const token = new AccessToken(input.apiKey, input.apiSecret, {
    identity,
    ttl: input.ttlSeconds ?? LIVE_VOICE_TOKEN_TTL_SECONDS,
  });
  token.addGrant({
    room: liveVoiceRoomName(voiceSessionId),
    roomJoin: true,
    canPublish: true,
    canSubscribe: true,
  });
  return token.toJwt();
}

export function userIdentityForSession(voiceSessionId: string): string {
  return `${LIVE_VOICE_USER_IDENTITY_PREFIX}${boundedId(voiceSessionId)}`;
}

export function agentIdentityForSession(voiceSessionId: string): string {
  return `${LIVE_VOICE_AGENT_IDENTITY_PREFIX}${boundedId(voiceSessionId)}`;
}

function boundedId(value: string): string {
  const id = typeof value === "string" ? value.trim() : "";
  if (!id || id.length > 160) throw new Error("Live Voice identity/session id is invalid.");
  return id;
}
