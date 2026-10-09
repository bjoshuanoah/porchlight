/**
 * Ed25519 compact-JWT primitives (EdDSA JWS). Dependency-free: node:crypto
 * only. Used by the hub signing service (issuance) and the cross-hub member
 * token verifier (receipt). Fixed-alg discipline everywhere — the header
 * alg must be exactly "EdDSA"; anything else fails closed.
 */
import { sign, verify, createPrivateKey, createPublicKey, generateKeyPairSync } from "node:crypto";

export const JWS_ALG = "EdDSA";

function b64url(input) {
  return Buffer.from(input).toString("base64url");
}

function b64urlJson(object) {
  return b64url(JSON.stringify(object));
}

/** Compact serialization of an Ed25519-signed JWT. payload.iat is set here. */
export function signEdDsaJwt({ payload, privateKeyJwk, kid, issuedAtSeconds = null }) {
  if (!payload || !privateKeyJwk || !kid) throw new Error("signEdDsaJwt: payload, privateKeyJwk and kid are required");
  const iat = issuedAtSeconds ?? Math.floor(Date.now() / 1000);
  const header = { alg: JWS_ALG, typ: "JWT", kid };
  const signingInput = `${b64urlJson(header)}.${b64urlJson({ ...payload, iat })}`;
  const key = createPrivateKey({ key: privateKeyJwk, format: "jwk" });
  const signature = sign(null, Buffer.from(signingInput), key).toString("base64url");
  return `${signingInput}.${signature}`;
}

/** Decode without verification (issuing-side introspection only). */
export function decodeJwt(token) {
  const parts = String(token).split(".");
  if (parts.length !== 3) throw new Error("malformed token");
  const [headerJson, payloadJson, signature] = parts;
  return {
    header: JSON.parse(Buffer.from(headerJson, "base64url").toString("utf8")),
    payload: JSON.parse(Buffer.from(payloadJson, "base64url").toString("utf8")),
    signature,
  };
}

/**
 * Verify a compact EdDSA JWT against one public JWK. Errors are typed and
 * specific: E_MALFORMED_TOKEN, E_ALG_MISMATCH, E_SIGNATURE_INVALID.
 */
export function verifyEdDsaJwt(token, { publicKeyJwk }) {
  let decoded;
  try {
    decoded = decodeJwt(token);
  } catch {
    const error = new Error("malformed token");
    error.code = "E_MALFORMED_TOKEN";
    throw error;
  }
  if (decoded.header.alg !== JWS_ALG) {
    const error = new Error(`token alg "${decoded.header.alg}" is not accepted (fixed EdDSA discipline)`);
    error.code = "E_ALG_MISMATCH";
    throw error;
  }
  const parts = String(token).split(".");
  const signingInput = `${parts[0]}.${parts[1]}`;
  const key = createPublicKey({ key: publicKeyJwk, format: "jwk" });
  const ok = verify(null, Buffer.from(signingInput), key, Buffer.from(decoded.signature, "base64url"));
  if (!ok) {
    const error = new Error("signature verification failed");
    error.code = "E_SIGNATURE_INVALID";
    throw error;
  }
  return { header: decoded.header, payload: decoded.payload };
}

/** Fresh Ed25519 JWK keypair as {publicKeyJwk, privateKeyJwk} (OKP envelope). */
export function newEd25519Jwks() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  return {
    publicKeyJwk: publicKey.export({ format: "jwk" }),
    privateKeyJwk: privateKey.export({ format: "jwk" }),
  };
}