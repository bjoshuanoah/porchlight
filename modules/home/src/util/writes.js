import { canonicalJson } from "@porchlight/shared";
import { verifyDeviceSignatureRaw } from "./crypto.js";

/**
 * Signed-member-write resolution for the home domain (PORCH-137 TS 1).
 * The existing Porchlight identity plane is the only auth surface: the
 * caller presents their identity access token (device-bound sessions);
 * a member-issued write additionally carries an Ed25519 device signature
 * over canonicalJson(payload), verified against the possession-proven
 * device key at write time and stored on the documents it authorized.
 *
 * Injected seams (wired by apps/server from the identity module's public
 * entry — home imports no identity source):
 *   verifySession(token) -> { did, deviceId } | null
 *   registeredDeviceKey(did, deviceId) -> { publicKeyJwk } | null
 */

/**
 * Resolve the caller to { did, deviceId } or fail typed:
 *   E_MUST_SIGN_IN     — no/!verified token
 *   E_SIGNATURE_REQUIRED — a write without a payload+signature pair
 *   E_SIGNATURE_INVALID  — a signature that does not verify
 */
export async function requireSignedSession({ accessToken, payload, signature, verifySession, registeredDeviceKey }) {
  if (!accessToken) return fail("E_MUST_SIGN_IN", "Sign in with your Porchlight identity to reach this home.");
  const session = await verifySession(accessToken ?? null);
  if (!session || !session.did) {
    return fail("E_MUST_SIGN_IN", "Sign in with your Porchlight identity to reach this home.");
  }
  if (!payload || typeof payload !== "object" || !signature) {
    return fail("E_SIGNATURE_REQUIRED", "This action needs your device's confirmation — update Porchlight on this device and try again.");
  }
  const registration = registeredDeviceKey
    ? await registeredDeviceKey(session.did, session.deviceId)
    : null;
  if (!registration?.publicKeyJwk) {
    return fail("E_SIGNATURE_INVALID", "This device's key is no longer enrolled — reconnect the device and try again.");
  }
  const verified = verifyDeviceSignatureRaw({
    publicKeyJwk: registration.publicKeyJwk,
    message: canonicalJson(payload),
    signature,
  });
  if (!verified) {
    return fail("E_SIGNATURE_INVALID", "This action's device confirmation didn't verify — update Porchlight on this device and try again.");
  }
  return { did: session.did, deviceId: session.deviceId, deviceSignature: signature };
}

/** Read-only session resolution (no signature): the token must still verify. */
export async function requireSession({ accessToken, verifySession }) {
  if (!accessToken) return fail("E_MUST_SIGN_IN", "Sign in with your Porchlight identity to reach this home.");
  const session = await verifySession(accessToken ?? null);
  if (!session || !session.did) {
    return fail("E_MUST_SIGN_IN", "Sign in with your Porchlight identity to reach this home.");
  }
  return { did: session.did, deviceId: session.deviceId ?? null };
}

function fail(code, message) {
  const error = new Error(message);
  error.code = code;
  throw error;
}
