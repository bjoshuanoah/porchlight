import { createHmac, timingSafeEqual } from "node:crypto";
import { canonicalJson } from "@porchlight/shared";

/**
 * Engine token bridge (PORCH-139, TS 2 auth bridge). The SPA presents its
 * Porchlight session to the bridge; the bridge validates the identity,
 * resolves camera authorization, and issues a SCOPED token the engine
 * accepts for exactly the named cameras in the named home until expiry.
 * The engine is a separate service (PORCH-I-009) and never imported — it
 * verifies these tokens with the same shared secret of record from the
 * runtime config. Token material never carries device signatures.
 */

const PREFIX = "peng1.";

function b64url(value) {
  return Buffer.from(value, "utf8").toString("base64url");
}

function hmac(secret, payload) {
  return createHmac("sha256", String(secret)).update(payload).digest("base64url");
}

export function createEngineTokenService({ secret, now = defaultNow, ttlSeconds = 300 } = {}) {
  if (typeof secret !== "string" || secret.length === 0) {
    throw new Error("engine token secret required");
  }
  return {
    ttl: ttlSeconds,
    /**
     * Mint one scoped camera-view token. claims: { did, homeId, cameras:
     * [engine camera ids], exp (epoch seconds) }. The scope is frozen at
     * mint time — the engine verifies the claim set, never an open-ended
     * session.
     */
    mint({ did, homeId, cameras, ttl = ttlSeconds } = {}) {
      if (!did || !homeId) {
        const error = new Error("engine token needs did and homeId");
        error.code = "E_VALIDATION";
        throw error;
      }
      const issuedAt = Math.floor(parseEpoch(now()));
      const exp = issuedAt + Math.max(1, Math.floor(ttl));
      const claims = { v: 1, did, homeId, cameras: (cameras ?? []).map(String), iat: issuedAt, exp };
      const payload = b64url(canonicalJson(claims));
      return PREFIX + payload + "." + hmac(secret, payload);
    },
    /** Verify one token: shape, signature (timing-safe), and expiry. */
    verify(token) {
      if (typeof token !== "string" || !token.startsWith(PREFIX)) return null;
      const [payload, signature] = token.slice(PREFIX.length).split(".");
      if (!payload || !signature) return null;
      const expected = hmac(secret, payload);
      const actual = Buffer.from(signature);
      const check = Buffer.from(expected);
      if (actual.length !== check.length || !timingSafeEqual(actual, check)) return null;
      let claims = null;
      try {
        claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
      } catch {
        return null;
      }
      if (!claims || claims.v !== 1 || typeof claims.exp !== "number") return null;
      if (claims.exp <= Math.floor(parseEpoch(now()))) return null;
      return claims;
    },
  };
}

/** Epoch seconds from an ISO/epoch input — the bridge normalizes to UTC. */
export function parseEpoch(value, fallbackMs = Date.now()) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  const parsed = Date.parse(String(value ?? ""));
  return Number.isFinite(parsed) ? Math.floor(parsed / 1000) : Math.floor(fallbackMs / 1000);
}

function defaultNow() {
  return new Date().toISOString();
}
