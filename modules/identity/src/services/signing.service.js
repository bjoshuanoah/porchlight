import { randomUUID, createHash } from "node:crypto";
import { signEdDsaJwt, newEd25519Jwks, verifyEdDsaJwt, decodeJwt } from "../util/jwt.js";

/** Access-token TTL: the standing OIDC assumption (~10 minutes, refresh rides the session). */
export const ACCESS_TTL_SECONDS = 600;
/** ID-token TTL, same ~10-minute bound. */
export const ID_TOKEN_TTL_SECONDS = 600;
/** Handoff tokens live minutes, not days. */
export const HANDOFF_TTL_SECONDS = 300;

export function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

/**
 * Hub-adjacent operator keystore. Two key planes, never conflated:
 *
 * - "member-auth" plane: signs member-verification ID tokens; served via
 *   JWKS with kid-based rotation (receiving networks re-fetch transparently;
 *   rotation within a matching key set never breaks validation).
 * - "did-doc" plane: the operator-held identity-plane key. Infrastructure
 *   material adjacent to the hub — signs only the DID document and migration
 *   handoff tokens, never member writes, never exposed on any member surface.
 */
export class HubSigningService {
  /**
   * @param {import("@porchlight/shared").CollectionLike} issuerKeys collection
   */
  constructor(issuerKeys) {
    this.issuerKeys = issuerKeys;
  }

  async activate(plane) {
    const active = await this.issuerKeys.findOne({ plane, status: "active" });
    if (active) return active;
    const jwks = newEd25519Jwks();
    const key = {
      kid: `kid_${plane}_${randomUUID()}`,
      plane,
      algorithm: "Ed25519",
      publicKeyJwk: jwks.publicKeyJwk,
      privateKeyJwk: jwks.privateKeyJwk,
      status: "active",
      createdAt: new Date().toISOString(),
    };
    await this.issuerKeys.insertOne(key);
    return key;
  }

  /** Idempotently ensure both planes exist; returns the two active rows. */
  async ensure() {
    return { memberAuth: await this.activate("member-auth"), didDoc: await this.activate("did-doc") };
  }

  /** The operator-held identity-plane key: {kid, publicKeyJwk}. */
  async didDocKey() {
    const key = await this.activate("did-doc");
    return { kid: key.kid, publicKeyJwk: key.publicKeyJwk };
  }

  /** Sign a member-auth-plane JWT (member verification ID token). */
  async signMemberToken(claims, { ttlSeconds = ID_TOKEN_TTL_SECONDS, issuedAtSeconds = null } = {}) {
    const active = await this.activate("member-auth");
    const iat = issuedAtSeconds ?? Math.floor(Date.now() / 1000);
    return signEdDsaJwt({
      payload: { ...claims, exp: iat + ttlSeconds },
      privateKeyJwk: active.privateKeyJwk,
      kid: active.kid,
      issuedAtSeconds: iat,
    });
  }

  /** Sign a did-doc-plane attestation (handoff token). */
  async signHandoffToken({ did, oldIssuer, newIssuer, ttlSeconds = HANDOFF_TTL_SECONDS } = {}) {
    const active = await this.activate("did-doc");
    const iat = Math.floor(Date.now() / 1000);
    return signEdDsaJwt({
      payload: { typ: "porchlight-handoff", did, oldIssuer, newIssuer, exp: iat + ttlSeconds },
      privateKeyJwk: active.privateKeyJwk,
      kid: active.kid,
      issuedAtSeconds: iat,
    });
  }

  /** Local-plane handoff verification (same keystore). Throws typed errors. */
  async verifyHandoffToken(token) {
    const key = await this.activate("did-doc");
    let result;
    try {
      result = verifyEdDsaJwt(token, { publicKeyJwk: key.publicKeyJwk });
    } catch (error) {
      const mapped = new Error(error.message);
      mapped.code = error.code ?? "E_HANDOFF_INVALID";
      throw mapped;
    }
    if (result.payload.typ !== "porchlight-handoff") {
      const error = new Error("token is not a porchlight handoff token");
      error.code = "E_HANDOFF_INVALID";
      throw error;
    }
    if (result.payload.exp <= Math.floor(Date.now() / 1000)) {
      const error = new Error("handoff token expired");
      error.code = "E_HANDOFF_EXPIRED";
      throw error;
    }
    return result.payload;
  }

  /** Published member-auth JWKS: active + rotated-out keys still in the published set. */
  async jwks() {
    await this.activate("member-auth");
    const keys = [];
    for (const status of ["active", "published"]) {
      const found = await this.issuerKeys.find({ plane: "member-auth", status });
      for (const row of found) keys.push({ kid: row.kid, ...stripPrivate(row.publicKeyJwk) });
    }
    return { keys };
  }

  /** The did-doc plane's public keys, served hub-level for cross-hub handoff verification. */
  async didDocPublicKeys() {
    const active = await this.activate("did-doc");
    return { keys: [{ kid: active.kid, ...stripPrivate(active.publicKeyJwk) }] };
  }

  /** Rotate the member-auth plane: a fresh active kid; the previous one stays published. */
  async rotateMemberAuthKeys() {
    const previous = await this.activate("member-auth");
    await this.issuerKeys.updateOne({ kid: previous.kid }, { $set: { status: "published" } });
    const fresh = await this.activate("member-auth");
    return { retiredKid: previous.kid, activeKid: fresh.kid };
  }

  /** Prune a rotated (published) key out of the served set. */
  async prunePublishedKey(kid) {
    const found = await this.issuerKeys.findOne({ kid, plane: "member-auth", status: "published" });
    if (!found) {
      const error = new Error("no published member-auth key with that kid");
      error.code = "E_KID_NOT_PUBLISHED";
      throw error;
    }
    await this.issuerKeys.updateOne({ kid }, { $set: { status: "retired" } });
    return { pruned: kid };
  }

  /** The did-doc-plane public JWK for a kid (cross-hub handoff verification). */
  async didDocJwkForKid(kid) {
    const key = await this.issuerKeys.findOne({ kid, plane: "did-doc" });
    if (!key) return null;
    return { kid: key.kid, ...stripPrivate(key.publicKeyJwk) };
  }
}

function stripPrivate(publicKeyJwk) {
  const { kty, crv, x } = publicKeyJwk;
  return { kty, crv, x };
}

export default HubSigningService;
export { decodeJwt };