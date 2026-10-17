import { generateKeyPair, exportJWK, SignJWT, createLocalJWKSet } from "jose";
import type { IncomingMessage } from "node:http";
import { beforeAll, describe, expect, it } from "vitest";
import { createAccessVerifier, createTailscaleVerifier } from "../../src/main/web/access-auth";

describe("Cloudflare Access authentication", () => {
  const issuer = "https://example.cloudflareaccess.com";
  const audience = "coterm-audience";
  let privateKey: CryptoKey;
  let verifier: ReturnType<typeof createAccessVerifier>;

  beforeAll(async () => {
    const keys = await generateKeyPair("RS256", { extractable: true });
    privateKey = keys.privateKey;
    const jwk = await exportJWK(keys.publicKey);
    verifier = createAccessVerifier({
      issuer,
      audience,
      keySet: createLocalJWKSet({ keys: [{ ...jwk, kid: "test-key", alg: "RS256" }] }),
    });
  });

  async function token(overrides: { issuer?: string; audience?: string; expiresIn?: string } = {}) {
    return new SignJWT({ email: "owner@example.com" })
      .setProtectedHeader({ alg: "RS256", kid: "test-key" })
      .setIssuer(overrides.issuer ?? issuer)
      .setAudience(overrides.audience ?? audience)
      .setIssuedAt()
      .setExpirationTime(overrides.expiresIn ?? "5m")
      .sign(privateKey);
  }

  it("accepts a valid Access assertion", async () => {
    await expect(verifier(await token())).resolves.toMatchObject({ email: "owner@example.com" });
  });

  it("rejects missing assertions", async () => {
    await expect(verifier(undefined)).rejects.toThrow("Access authentication required.");
  });

  it("rejects expired assertions", async () => {
    await expect(verifier(await token({ expiresIn: "-1s" }))).rejects.toThrow("Access authentication failed.");
  });

  it("rejects the wrong issuer or audience", async () => {
    await expect(verifier(await token({ issuer: "https://attacker.invalid" }))).rejects.toThrow("Access authentication failed.");
    await expect(verifier(await token({ audience: "other-app" }))).rejects.toThrow("Access authentication failed.");
  });

  it("rejects invalid signatures", async () => {
    const other = await generateKeyPair("RS256");
    const forged = await new SignJWT({ email: "attacker@example.com" })
      .setProtectedHeader({ alg: "RS256", kid: "test-key" })
      .setIssuer(issuer).setAudience(audience).setIssuedAt().setExpirationTime("5m")
      .sign(other.privateKey);
    await expect(verifier(forged)).rejects.toThrow("Access authentication failed.");
  });
});

describe("Tailscale Serve authentication", () => {
  function request(remoteAddress: string, login?: string): IncomingMessage {
    return {
      socket: { remoteAddress },
      headers: login ? { "tailscale-user-login": login } : {},
    } as unknown as IncomingMessage;
  }

  it.each(["127.0.0.1", "::1", "::ffff:127.0.0.1"])(
    "accepts identity headers from loopback %s",
    async (remoteAddress) => {
      const verifier = createTailscaleVerifier("owner@example.com");
      await expect(verifier(undefined, request(remoteAddress, "owner@example.com")))
        .resolves.toMatchObject({ email: "owner@example.com" });
    },
  );

  it("rejects missing headers, non-loopback sources, and the wrong login", async () => {
    const verifier = createTailscaleVerifier("owner@example.com");
    await expect(verifier(undefined, request("127.0.0.1"))).rejects.toThrow("Missing Tailscale user login.");
    await expect(verifier(undefined, request("100.64.0.10", "owner@example.com")))
      .rejects.toThrow("loopback source");
    await expect(verifier(undefined, request("127.0.0.1", "other@example.com")))
      .rejects.toThrow("not allowed");
  });
});
