import { randomUUID, randomBytes } from "node:crypto";

/** Pairing codes: one-time, 10 minutes. */
export const PAIRING_TTL_SECONDS = 600;
/** Device links: one-time continuity token, 24 hours. */
export const DEVICE_LINK_TTL_SECONDS = 24 * 60 * 60;

function typedError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function isoPlus(date, seconds) {
  return new Date(date.getTime() + seconds * 1000).toISOString();
}

/**
 * Device registrations and continuity. The hub registers per-identity device
 * PUBLIC keys only — private key material (`d`) is device-bound custody and is
 * rejected on every entry point. Registrations are never deduped across
 * identities: shared hardware means N registrations, N keys, N session scopes.
 */
export class DeviceService {
  /**
   * @param {object} deps
   * @param {import("@porchlight/shared").CollectionLike} deps.deviceRegistrations
   * @param {import("@porchlight/shared").CollectionLike} deps.pairingCodes
   * @param {import("@porchlight/shared").CollectionLike} deps.deviceLinks
   * @param {import("@porchlight/shared").CollectionLike} deps.sessions
   * @param {(value: string) => string} deps.hash sha256 of the code/token value
   */
  constructor({ deviceRegistrations, pairingCodes, deviceLinks, sessions, hash }) {
    this.deviceRegistrations = deviceRegistrations;
    this.pairingCodes = pairingCodes;
    this.deviceLinks = deviceLinks;
    this.sessions = sessions;
    this.hash = hash;
  }

  /** Owner/member view: active AND revoked rows stay visible. */
  async listRegistrations({ did }) {
    return this.deviceRegistrations.find({ did });
  }

  /** Fetch one registration row by id (any status), or null. */
  async getRegistration({ registrationId }) {
    if (!registrationId) return null;
    return this.deviceRegistrations.findOne({ _id: registrationId });
  }

  /**
   * Register a device-held Ed25519 PUBLIC key for the DID. Rejects private
   * key material (E_PRIVATE_KEY_REJECTED) and anything that is not an OKP
   * Ed25519 JWK (E_KEY_TYPE_REJECTED).
   */
  async createRegistration({ did, deviceId, publicKeyJwk, label = null, createdBy = null }) {
    assertAcceptableKey(publicKeyJwk);
    const now = new Date();
    const row = {
      _id: `reg_${randomUUID()}`,
      did,
      deviceId,
      label,
      // Structured copy keeps caller-owned objects from leaking in by reference.
      publicKeyJwk: JSON.parse(JSON.stringify(publicKeyJwk)),
      createdBy,
      status: "active",
      revokedAt: null,
      createdAt: now.toISOString(),
    };
    await this.deviceRegistrations.insertOne(row);
    return row;
  }

  /** One-time 10-minute pairing code from a working device. Stored hashed, returned plaintext once. */
  async mintPairingCode({ did, now = () => new Date() }) {
    const at = now();
    const code = randomBytes(6).toString("base64url");
    const row = {
      _id: `pc_${randomUUID()}`,
      did,
      code: this.hash(code),
      expiresAt: isoPlus(at, PAIRING_TTL_SECONDS),
      consumed: false,
      createdAt: at.toISOString(),
    };
    await this.pairingCodes.insertOne(row);
    return { code, expiresAt: row.expiresAt };
  }

  /**
   * Bind the NEW device's own (device-held) public key to the SAME did the
   * code was minted for. One-time; the new device never receives or sends
   * private material — only its public JWK travels here.
   */
  async consumePairingCode({ code, deviceId, publicKeyJwk, label, now = () => new Date() }) {
    const link = await this.consumeOneTimeRow({
      collection: this.pairingCodes,
      valueField: "code",
      value: code,
      ttlSeconds: PAIRING_TTL_SECONDS,
      now,
      unknownCode: "E_PAIRING_CODE_UNKNOWN",
      expiredCode: "E_PAIRING_CODE_EXPIRED",
      consumedCode: "E_PAIRING_CODE_CONSUMED",
    });
    assertAcceptableKey(publicKeyJwk);
    await this.pairingCodes.updateOne({ _id: link._id }, { $set: { consumed: true } });
    await this.supersedeDeviceSlot({ did: link.did, deviceId });
    return this.createRegistration({
      did: link.did,
      deviceId,
      publicKeyJwk,
      label: label ?? null,
      createdBy: "pairing",
    });
  }

  /** One-time 24-hour owner-routed device link. Stored hashed, returned plaintext once. */
  async mintDeviceLink({ did, now = () => new Date() }) {
    const at = now();
    const token = randomBytes(32).toString("base64url");
    const row = {
      _id: `dl_${randomUUID()}`,
      did,
      token: this.hash(token),
      expiresAt: isoPlus(at, DEVICE_LINK_TTL_SECONDS),
      consumed: false,
      createdAt: at.toISOString(),
    };
    await this.deviceLinks.insertOne(row);
    return { token, expiresAt: row.expiresAt };
  }

  /**
   * Continuity without a working device: binds the new device's key to the
   * UNCHANGED existing DID. Never mints a new identity — the did comes only
   * from the link row.
   */
  async consumeDeviceLink({ token, deviceId, publicKeyJwk, label, now = () => new Date() }) {
    const link = await this.consumeOneTimeRow({
      collection: this.deviceLinks,
      valueField: "token",
      value: token,
      ttlSeconds: DEVICE_LINK_TTL_SECONDS,
      now,
      unknownCode: "E_DEVICE_LINK_UNKNOWN",
      expiredCode: "E_DEVICE_LINK_EXPIRED",
      consumedCode: "E_DEVICE_LINK_CONSUMED",
    });
    assertAcceptableKey(publicKeyJwk);
    await this.deviceLinks.updateOne({ _id: link._id }, { $set: { consumed: true } });
    await this.supersedeDeviceSlot({ did: link.did, deviceId });
    return this.createRegistration({
      did: link.did,
      deviceId,
      publicKeyJwk,
      label: label ?? null,
      createdBy: "device-link",
    });
  }

  /**
   * Re-bind discipline (ac-12/ac-13): one ACTIVE key registration per
   * (did, deviceId). When a fresh registration lands on a slot that already
   * holds an active one — the same physical device re-binding (forgotten-PIN
   * unblock via the owner-routed link) — the prior row is retired as
   * "revoked" (it stays visible in the member view) and its active session
   * is superseded.
   */
  async supersedeDeviceSlot({ did, deviceId }) {
    const active = await this.deviceRegistrations.find({ did, deviceId, status: "active" });
    for (const row of active) {
      await this.deviceRegistrations.updateOne(
        { _id: row._id },
        { $set: { status: "revoked", revokedAt: new Date().toISOString() } },
      );
      await this.sessions.updateOne({ did, deviceId, status: "active" }, { $set: { status: "superseded" } });
    }
    return active.length;
  }

  /**
   * Revoke one device registration and supersede its (did, deviceId) active
   * sessions. The identity itself is untouched — revocation ends access for
   * this device scope only.
   */
  async revokeRegistration({ registrationId }) {
    const registration = await this.deviceRegistrations.findOne({ _id: registrationId });
    if (!registration) {
      throw typedError("E_REGISTRATION_UNKNOWN", `no device registration ${registrationId}`);
    }
    await this.deviceRegistrations.updateOne(
      { _id: registrationId },
      { $set: { status: "revoked", revokedAt: new Date().toISOString() } },
    );
    const active = await this.sessions.find({ did: registration.did, deviceId: registration.deviceId, status: "active" });
    for (const row of active) {
      await this.sessions.updateOne({ _id: row._id }, { $set: { status: "superseded" } });
    }
    return { revoked: registrationId, supersededSessions: active.length };
  }

  /**
   * Shared one-time-row lookup: unknown / expired / consumed, stored value is
   * a sha256 hash of the presented plaintext.
   */
  async consumeOneTimeRow({ collection, valueField, value, now, unknownCode, expiredCode, consumedCode }) {
    if (!value) throw typedError(unknownCode, "no value presented");
    const row = await collection.findOne({ [valueField]: this.hash(value) });
    if (!row) throw typedError(unknownCode, "no such one-time value");
    if (new Date(row.expiresAt).getTime() <= now().getTime()) {
      throw typedError(expiredCode, "one-time value expired");
    }
    if (row.consumed) throw typedError(consumedCode, "one-time value already consumed");
    return row;
  }
}

/** Custody invariant: OKP Ed25519 public JWK only — no `d`, no other key types. */
function assertAcceptableKey(publicKeyJwk) {
  if (!publicKeyJwk || typeof publicKeyJwk !== "object") {
    throw typedError("E_KEY_TYPE_REJECTED", "publicKeyJwk must be an OKP Ed25519 JWK");
  }
  if (publicKeyJwk.kty !== "OKP" || publicKeyJwk.crv !== "Ed25519") {
    throw typedError("E_KEY_TYPE_REJECTED", "device keys must be OKP Ed25519 JWKs");
  }
  if ("d" in publicKeyJwk || publicKeyJwk.d != null) {
    throw typedError("E_PRIVATE_KEY_REJECTED", "device keys are public-only: private key material (d) is never accepted");
  }
}

export default DeviceService;