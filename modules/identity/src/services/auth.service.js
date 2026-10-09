import { randomUUID, randomBytes, verify, createPublicKey } from "node:crypto";

/** Challenge TTL: the device must sign within two minutes of asking. */
export const CHALLENGE_TTL_SECONDS = 120;
/** Access-token TTL — the standing ~10-minute OIDC assumption. */
export const ACCESS_TTL_SECONDS = 600;
/** Refresh tokens ride the session: 45 days. */
export const REFRESH_TTL_SECONDS = 45 * 24 * 60 * 60;

function typedError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function isoPlus(date, seconds) {
  return new Date(date.getTime() + seconds * 1000).toISOString();
}

function opaqueToken() {
  return randomBytes(32).toString("base64url");
}

/**
 * Challenge-signature authentication. The device holds its Ed25519 private
 * key; the hub challenges, the device signs the nonce, the hub verifies
 * against the registered PUBLIC key and issues session tokens. Humans and
 * agents ride exactly the same verification path (ac-2).
 *
 * Tokens are stored as SHA-256 hashes only (injected `hash`); plaintexts are
 * returned once at issuance and never persisted.
 */
export class AuthService {
  /**
   * @param {object} deps
   * @param {import("@porchlight/shared").CollectionLike} deps.challenges
   * @param {import("@porchlight/shared").CollectionLike} deps.sessions
   * @param {import("@porchlight/shared").CollectionLike} deps.deviceRegistrations
   * @param {(value: string) => string} deps.hash sha256 of the token value
   */
  constructor({ challenges, sessions, deviceRegistrations, hash }) {
    this.challenges = challenges;
    this.sessions = sessions;
    this.deviceRegistrations = deviceRegistrations;
    this.hash = hash;
  }

  /**
   * Mint a one-time 120s challenge for the DID. Identity existence is
   * evidenced by device registrations (this service holds no identities
   * handle): a DID with no registration rows is unknown here.
   */
  async createChallenge({ did }) {
    if (!did) throw typedError("E_IDENTITY_NOT_FOUND", "did is required");
    const known = await this.deviceRegistrations.findOne({ did });
    if (!known) {
      throw typedError("E_IDENTITY_NOT_FOUND", `no identity is registered for ${did}`);
    }
    const now = new Date();
    const nonce = randomBytes(32).toString("base64url");
    const row = {
      _id: `chl_${randomUUID()}`,
      did,
      nonce,
      expiresAt: isoPlus(now, CHALLENGE_TTL_SECONDS),
      consumed: false,
      createdAt: now.toISOString(),
    };
    await this.challenges.insertOne(row);
    return { challengeId: row._id, did: row.did, nonce: row.nonce, expiresAt: row.expiresAt };
  }

  /**
   * Verify the device signature over the nonce and open a session.
   * Order is fixed: consume the challenge, resolve the active registration,
   * verify the signature, supersede prior same-(did, deviceId) sessions.
   */
  async openSession({ did, deviceId, nonce, signature, now = () => new Date() }) {
    // 1) One unconsumed, unexpired challenge for this (did, nonce).
    const challenge = await this.challenges.findOne({ did, nonce, consumed: false });
    if (!challenge || new Date(challenge.expiresAt).getTime() <= now().getTime()) {
      throw typedError("E_CHALLENGE_REQUIRED", "no unconsumed, unexpired challenge for this did+nonce");
    }
    await this.challenges.updateOne({ _id: challenge._id }, { $set: { consumed: true } });

    // 2) The active registration for (did, deviceId).
    const registration = await this.deviceRegistrations.findOne({ did, deviceId, status: "active" });
    if (!registration) {
      throw typedError("E_NO_REGISTRATION", `no active device registration for (${did}, ${deviceId})`);
    }

    // 3) Ed25519 verify over exactly the nonce (utf8).
    if (!verifyDeviceSignatureRaw({ publicKeyJwk: registration.publicKeyJwk, message: nonce, signature })) {
      throw typedError("E_SIGNATURE_INVALID", "device signature over the nonce does not verify");
    }

    // 4) Supersede prior active sessions for the same (did, deviceId).
    const prior = await this.sessions.find({ did, deviceId, status: "active" });
    for (const row of prior) {
      await this.sessions.updateOne({ _id: row._id }, { $set: { status: "superseded" } });
    }

    const at = now();
    const accessToken = opaqueToken();
    const refreshToken = opaqueToken();
    const session = {
      _id: `sess_${randomUUID()}`,
      did,
      deviceId,
      accessTokenHash: this.hash(accessToken),
      refreshTokenHash: this.hash(refreshToken),
      accessExpiresAt: isoPlus(at, ACCESS_TTL_SECONDS),
      refreshExpiresAt: isoPlus(at, REFRESH_TTL_SECONDS),
      status: "active",
      createdAt: at.toISOString(),
    };
    await this.sessions.insertOne(session);
    return {
      sessionId: session._id,
      did,
      deviceId,
      accessToken,
      refreshToken,
      expiresInSeconds: ACCESS_TTL_SECONDS,
    };
  }

  /** Agents verify identically to humans; delegation is the whole point (ac-2). */
  async openSessionForAgent({ did, deviceId, nonce, signature, now = () => new Date() }) {
    return this.openSession({ did, deviceId, nonce, signature, now });
  }

  /** Resolve an access token to {did, sessionId}, or null (expired/unknown/superseded/revoked). */
  async verifyAccessToken(accessToken, now = () => new Date()) {
    if (!accessToken) return null;
    const session = await this.sessions.findOne({ accessTokenHash: this.hash(accessToken) });
    if (!session) return null;
    if (session.status !== "active") return null;
    if (new Date(session.accessExpiresAt).getTime() <= now().getTime()) return null;
    return { did: session.did, sessionId: session._id };
  }

  /**
   * Rotate the access token off a still-valid refresh token. Boring choice:
   * new access only — the refresh hash stays until it expires.
   */
  async refresh({ refreshToken, now = () => new Date() }) {
    if (!refreshToken) throw typedError("E_REFRESH_INVALID", "refresh token required");
    const session = await this.sessions.findOne({ refreshTokenHash: this.hash(refreshToken) });
    if (!session || session.status !== "active") {
      throw typedError("E_REFRESH_INVALID", "refresh token is unknown or its session is not active");
    }
    if (new Date(session.refreshExpiresAt).getTime() <= now().getTime()) {
      throw typedError("E_REFRESH_INVALID", "refresh token expired");
    }
    const at = now();
    const accessToken = opaqueToken();
    await this.sessions.updateOne(
      { _id: session._id },
      { $set: { accessTokenHash: this.hash(accessToken), accessExpiresAt: isoPlus(at, ACCESS_TTL_SECONDS) } },
    );
    return { accessToken, refreshToken, expiresInSeconds: ACCESS_TTL_SECONDS };
  }

  /** Network-side revocation kill switch: revoke ALL sessions for the DID. */
  async revokeSessionsForIdentity({ did }) {
    const active = await this.sessions.find({ did, status: "active" });
    for (const row of active) {
      await this.sessions.updateOne({ _id: row._id }, { $set: { status: "revoked" } });
    }
    return { revoked: active.length };
  }

  /**
   * The single shared write-verification path for humans AND agents (ac-2):
   * Ed25519 over the message bytes against the registration's public JWK.
   */
  async verifyDeviceSignature({ registration, message, signature }) {
    if (!registration?.publicKeyJwk) return false;
    return verifyDeviceSignatureRaw({
      publicKeyJwk: registration.publicKeyJwk,
      message,
      signature,
    });
  }
}

/** Shared Raw verify helper (also used by this module's DeviceService). */
export function verifyDeviceSignatureRaw({ publicKeyJwk, message, signature }) {
  try {
    const key = createPublicKey({ key: publicKeyJwk, format: "jwk" });
    return verify(null, Buffer.from(String(message), "utf8"), key, Buffer.from(signature, "base64url"));
  } catch {
    return false;
  }
}

export default AuthService;