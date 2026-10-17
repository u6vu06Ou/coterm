import { describe, expect, it } from "vitest";
import { decodeJwt, decodeProtectedHeader } from "jose";
import {
  LIVE_VOICE_TOKEN_TTL_SECONDS,
  agentIdentityForSession,
  issueLiveVoiceToken,
  liveVoiceRoomName,
  userIdentityForSession,
} from "../../src/main/voice/live/livekit-token";

const SESSION = "vs-abc123";

describe("live voice token issuance", () => {
  it("names rooms and identities by session convention", () => {
    expect(liveVoiceRoomName(SESSION)).toBe("voice-vs-abc123");
    expect(userIdentityForSession(SESSION)).toBe("user-vs-abc123");
    expect(agentIdentityForSession(SESSION)).toBe("agent-vs-abc123");
  });

  it("signs a join token with room, identity, and a 10-minute TTL", async () => {
    const jwt = await issueLiveVoiceToken({
      voiceSessionId: SESSION,
      apiKey: "k".repeat(32),
      apiSecret: "s".repeat(40),
      identity: userIdentityForSession(SESSION),
    });
    const claims = decodeJwt(jwt);
    expect(claims.sub).toBe(`user-${SESSION}`);
    const video = claims.video as Record<string, unknown>;
    expect(video.room).toBe(`voice-${SESSION}`);
    expect(video.roomJoin).toBe(true);
    const ttl = (claims.exp ?? 0) - (claims.iat ?? claims.nbf ?? 0);
    expect(Math.abs(ttl - LIVE_VOICE_TOKEN_TTL_SECONDS)).toBeLessThanOrEqual(2);
    expect(decodeProtectedHeader(jwt).alg).toBe("HS256");
  });

  it("accepts a custom TTL and rejects empty session ids", async () => {
    const jwt = await issueLiveVoiceToken({
      voiceSessionId: SESSION,
      apiKey: "k".repeat(32),
      apiSecret: "s".repeat(40),
      identity: userIdentityForSession(SESSION),
      ttlSeconds: 60,
    });
    const claims = decodeJwt(jwt);
    expect(Math.abs(((claims.exp ?? 0) - (claims.iat ?? claims.nbf ?? 0)) - 60)).toBeLessThanOrEqual(2);
    await expect(
      issueLiveVoiceToken({
        voiceSessionId: "   ",
        apiKey: "k".repeat(32),
        apiSecret: "s".repeat(40),
        identity: "user-x",
      }),
    ).rejects.toThrow(/invalid/i);
  });
});
