import { createHash, createPublicKey, randomBytes, verify } from "node:crypto";

/**
 * Social-domain crypto helpers. Self-contained by the module boundary:
 * identity and social share zero source, so these mirror the identity-side
 * primitives (AuthService device-signature verification shape) rather than
 * importing them.
 */

/** sha256 hex digest of a string (token-at-rest hashing surface). */
export function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

/** Opaque bearer token; plaintext returned once, only the hash is stored. */
export function opaqueToken() {
  return randomBytes(32).toString("base64url");
}

/**
 * Ed25519 (OKP) verification of a member device signature over a UTF-8
 * message, against the enrolled public JWK. Mirrors the identity-side
 * verifyDeviceSignatureRaw contract: returns false on any failure.
 */
export function verifyDeviceSignatureRaw({ publicKeyJwk, message, signature }) {
  try {
    const key = createPublicKey({ key: publicKeyJwk, format: "jwk" });
    return verify(
      null,
      Buffer.from(message, "utf8"),
      key,
      Buffer.from(signature, "base64url"),
    );
  } catch {
    return false;
  }
}