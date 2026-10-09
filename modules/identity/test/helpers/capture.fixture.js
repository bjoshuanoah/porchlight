import { sign, createPrivateKey } from "node:crypto";

/** Insert a device registration row directly (the first-account mint shape). */
export function insertRegistration(db, { did, deviceId, jwks, createdBy = "first-account", status = "active" }) {
  return db.collection("device_registrations").insertOne({
    _id: `reg_${deviceId}`,
    did,
    deviceId,
    label: null,
    publicKeyJwk: jwks.publicKeyJwk,
    createdBy,
    status,
    revokedAt: null,
    createdAt: new Date().toISOString(),
  });
}

/** Ed25519 signature over a challenge nonce (base64url). */
export function signNonce(privateKeyJwk, nonce) {
  return sign(null, Buffer.from(nonce, "utf8"), createPrivateKey({ key: privateKeyJwk, format: "jwk" })).toString("base64url");
}