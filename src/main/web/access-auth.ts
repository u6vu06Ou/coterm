import {
  createRemoteJWKSet,
  jwtVerify,
  type JWTVerifyGetKey,
  type JWTPayload,
} from "jose";
import type { IncomingMessage } from "node:http";

interface AccessVerifierOptions {
  issuer: string;
  audience: string;
  keySet: JWTVerifyGetKey;
}

export interface AccessIdentity extends JWTPayload {
  email: string;
}

export type AccessVerifier = (assertion: string | undefined, request?: IncomingMessage) => Promise<AccessIdentity>;

export function createAccessVerifier(options: AccessVerifierOptions): AccessVerifier {
  return async (assertion) => {
    if (!assertion) throw new Error("Access authentication required.");
    try {
      const { payload } = await jwtVerify(assertion, options.keySet, {
        issuer: options.issuer,
        audience: options.audience,
        algorithms: ["RS256"],
      });
      if (typeof payload.email !== "string" || !payload.email) throw new Error("Missing email.");
      return payload as AccessIdentity;
    } catch {
      throw new Error("Access authentication failed.");
    }
  };
}

export function createCloudflareAccessVerifier(teamDomain: string, audience: string): AccessVerifier {
  const issuer = `https://${teamDomain}`;
  return createAccessVerifier({
    issuer,
    audience,
    keySet: createRemoteJWKSet(new URL(`${issuer}/cdn-cgi/access/certs`), {
      cacheMaxAge: 60 * 60 * 1_000,
      cooldownDuration: 30_000,
      timeoutDuration: 5_000,
    }),
  });
}

const LOOPBACK_ADDRESSES = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);

/**
 * Tailscale Serve verifier. Serve is a loopback reverse proxy on the same host,
 * so legitimate traffic arrives from 127.0.0.1/::1 and carries a
 * `Tailscale-User-Login` header injected by Serve. Funnel (public) traffic has
 * neither and is rejected.
 */
export function createTailscaleVerifier(allowedLogin?: string): AccessVerifier {
  return (_assertion, request) => {
    if (!request) return Promise.reject(new Error("Tailscale authentication requires the request."));
    const remote = request.socket.remoteAddress ?? "";
    if (!LOOPBACK_ADDRESSES.has(remote)) {
      return Promise.reject(new Error("Tailscale authentication requires a loopback source."));
    }
    const login = readHeader(request, "tailscale-user-login");
    if (!login) return Promise.reject(new Error("Missing Tailscale user login."));
    if (allowedLogin && login !== allowedLogin) {
      return Promise.reject(new Error("Tailscale user login not allowed."));
    }
    return Promise.resolve({ email: login });
  };
}

function readHeader(request: IncomingMessage, name: string): string | undefined {
  const value = request.headers[name.toLowerCase()];
  if (Array.isArray(value)) return value[0];
  return value;
}
