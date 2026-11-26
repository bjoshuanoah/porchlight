import { verify as nodeVerify, createPublicKey } from "node:crypto";

/**
 * Home-domain crypto helper. Self-contained by the module boundary: the
 * home domain shares zero source with identity and social, so this mirrors
 * the plane-wide Ed25519 device-signature verification shape (canonicalJson
 * payload, base64url signature over the UTF-8 message) rather than importing
 * another module's internals.
 */

/**
 * Ed25519 (OKP) verification of a member device signature over a UTF-8
 * message, against the possession-proven public JWK. Returns false on any
 * failure — never throws.
 */
export function verifyDeviceSignatureRaw({ publicKeyJwk, message, signature }) {
  try {
    const key = createPublicKey({ key: publicKeyJwk, format: "jwk" });
    return nodeVerify(
      null,
      Buffer.from(message, "utf8"),
      key,
      Buffer.from(signature, "base64url"),
    );
  } catch {
    return false;
  }
}
