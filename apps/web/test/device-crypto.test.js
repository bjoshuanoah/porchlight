// PORCH-039 device-key crypto boundary: the join flow must mint a device key
// and sign with it at every hub address — including plain-http LAN origins
// (e.g. http://192.168.1.31:8710) where window.crypto.subtle and randomUUID
// do not exist (insecure contexts). The reported bug: verify succeeded, then
// createDeviceRegistration threw a TypeError pre-network, which the front
// door rendered as a false "We couldn't reach" verdict.
import test from "node:test";
import assert from "node:assert/strict";
import { signDeviceMessage } from "../src/device.js";
import { createKeypair, hasSubtle, randomDeviceId, signMessage } from "../src/device-crypto.js";

// Custody invariant the hub enforces (identity E_KEY_TYPE_REJECTED): the JWK
// the client produces must be a public OKP Ed25519 key with no private `d`.
function assertOkpPublicJwk(publicKeyJwk, message) {
  assert.equal(publicKeyJwk.kty, "OKP", message);
  assert.equal(publicKeyJwk.crv, "Ed25519", message);
  assert.match(publicKeyJwk.x, /^[A-Za-z0-9_-]{27,44}$/, message);
  assert.equal("d" in publicKeyJwk, false, message);
}

// Node's verify path is the hub's own verifyDeviceSignatureRaw (auth.service):
// Ed25519 over the UTF-8 message bytes against the stored OKP JWK, base64url
// signature — so a signature Node accepts is a signature the hub accepts.
async function hubVerifies(publicKeyJwk, message, signatureBase64url) {
  const { createPublicKey, verify } = await import("node:crypto");
  const key = createPublicKey({ key: publicKeyJwk, format: "jwk" });
  return verify(null, Buffer.from(message, "utf8"), key, Buffer.from(signatureBase64url, "base64url"));
}

function b64url(bytes) {
  return Buffer.from(bytes).toString("base64url");
}

test("secure-context path keeps the non-extractable CryptoKey vault contract", async () => {
  assert.equal(hasSubtle(), true, "node --test runs with global WebCrypto present");
  const { privateKey, publicKeyJwk } = await createKeypair();
  assert.equal(privateKey instanceof CryptoKey, true);
  assert.equal(privateKey.extractable, false);
  assertOkpPublicJwk(publicKeyJwk, "subtle path JWK");
  const message = "porchlight-join:CODE";
  const signature = b64url(await signMessage(privateKey, Buffer.from(message, "utf8")));
  assert.equal(await hubVerifies(publicKeyJwk, message, signature), true);
});

test("PORCH-039 regression: an insecure context (no crypto.subtle, no randomUUID, no CryptoKey global) still mints a working device key instead of throwing TypeError", async (t) => {
  // Measured on Chromium over plain http LAN origins (e.g. the reported
  // http://192.168.1.31:8710): crypto.subtle, crypto.randomUUID AND the
  // CryptoKey global are all undefined; getRandomValues and IndexedDB work.
  const original = globalThis.crypto;
  const originalCryptoKey = globalThis.CryptoKey;
  t.after(() => {
    Object.defineProperty(globalThis, "crypto", { value: original });
    Object.defineProperty(globalThis, "CryptoKey", { value: originalCryptoKey });
  });
  Object.defineProperty(globalThis, "crypto", {
    value: { getRandomValues: original.getRandomValues.bind(original) },
  });
  Object.defineProperty(globalThis, "CryptoKey", { value: undefined });
  assert.equal(hasSubtle(), false);
  const { privateKey, publicKeyJwk } = await createKeypair();
  assert.ok(privateKey, "keypair resolves rather than throwing pre-network");
  assert.equal(typeof privateKey, "string", "vault stores the device-held seed at insecure origins");
  assertOkpPublicJwk(publicKeyJwk, "fallback JWK");
  const message = "porchlight-join:65DolOPQsQQETZxC9VhQbEkH";
  const signature = b64url(await signMessage(privateKey, Buffer.from(message, "utf8")));
  assert.equal(await hubVerifies(publicKeyJwk, message, signature), true,
    "hub-side Ed25519 verify accepts the fallback signature");
});

test("PORCH-039 regression: the device-held key signs session challenges on insecure origins too", async (t) => {
  const original = globalThis.crypto;
  t.after(() => { Object.defineProperty(globalThis, "crypto", { value: original }); });
  Object.defineProperty(globalThis, "crypto", {
    value: { getRandomValues: original.getRandomValues.bind(original) },
  });
  const { privateKey, publicKeyJwk } = await createKeypair();
  const nonce = "nonce-4f1c9a";
  const signature = await signDeviceMessage(privateKey, nonce);
  assert.equal(await hubVerifies(publicKeyJwk, nonce, signature), true,
    "openDeviceSession's challenge signature verifies hub-side");
});

test("randomDeviceId stays a UUID v4 without randomUUID", (t) => {
  const original = globalThis.crypto;
  t.after(() => { Object.defineProperty(globalThis, "crypto", { value: original }); });
  Object.defineProperty(globalThis, "crypto", {
    value: { getRandomValues: original.getRandomValues.bind(original),
      randomUUID: undefined }, // insecure contexts carry no randomUUID
  });
  const id = randomDeviceId();
  assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
});