// Device-key crypto boundary (PORCH-039): the same device-held OKP Ed25519
// contract on every hub address. WebCrypto subtle exists only in secure
// contexts (https and localhost aliases); hubs serve the SPA over plain http
// from LAN addresses, so this module falls back to the pure-JS @noble/ed25519
// key/sign when subtle is absent. Keys stay in this browser either way — only
// the public JWK ever crosses the network (E_KEY_TYPE_REJECTED custody rule).
import {
  getPublicKey, hashes as edHashes, sign as ed25519Sign, utils as edUtils,
} from "@noble/ed25519";
import { sha512 } from "@noble/hashes/sha2.js";

// @noble/ed25519 v3 is crypto-agnostic: the consumer injects SHA-512, then the
// synchronous keygen/sign paths run (matching subtle's wire format exactly —
// 64-byte signatures over the raw message bytes, Node-verifiable).
edHashes.sha512 = sha512;

/** A secure-context WebCrypto subtle is required for the CryptoKey path. */
export function hasSubtle() {
  return typeof crypto !== "undefined" && Boolean(crypto.subtle)
    && typeof crypto.subtle.generateKey === "function"
    && typeof crypto.subtle.sign === "function";
}

/** crypto.randomUUID is also secure-context-only; UUID v4 from getRandomValues. */
export function randomDeviceId() {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function b64url(bytes) {
  let raw = "";
  for (const byte of bytes) raw += String.fromCharCode(byte);
  return btoa(raw).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function seedFromB64url(value) {
  const padded = String(value).replace(/-/g, "+").replace(/_/g, "/");
  return Uint8Array.from(atob(padded + "=".repeat((4 - (padded.length % 4)) % 4)), (char) => char.charCodeAt(0));
}

function isCryptoKey(value) {
  return typeof CryptoKey !== "undefined" && value instanceof CryptoKey;
}

/**
 * A device keypair for the vault. privateKey is a non-extractable CryptoKey
 * on secure origins, or a base64url seed string on insecure ones; both carry
 * the OKP Ed25519 public JWK the hub re-verifies at admission and sessions.
 */
export async function createKeypair() {
  if (hasSubtle()) {
    const keys = await crypto.subtle.generateKey({ name: "Ed25519" }, false, ["sign", "verify"]);
    const publicKeyJwk = await crypto.subtle.exportKey("jwk", keys.publicKey);
    return { privateKey: keys.privateKey, publicKeyJwk };
  }
  const secretKey = edUtils.randomSecretKey();
  return {
    privateKey: b64url(secretKey),
    publicKeyJwk: { kty: "OKP", crv: "Ed25519", x: b64url(getPublicKey(secretKey)) },
  };
}

/** Ed25519 over the raw message bytes for a held CryptoKey or seed record. */
export async function signMessage(privateKey, bytes) {
  if (isCryptoKey(privateKey)) {
    return new Uint8Array(await crypto.subtle.sign("Ed25519", privateKey, bytes));
  }
  return Uint8Array.from(ed25519Sign(Uint8Array.from(bytes), seedFromB64url(privateKey)));
}