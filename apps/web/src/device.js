// IndexedDB structured-clones non-extractable CryptoKeys. Only the public JWK
// crosses the network; no private material is serialized into browser storage.
// The Ed25519 boundary (secure-context subtle, or the pure-JS fallback on the
// plain-http LAN addresses hubs actually serve) rides device-crypto.js.

// Insecure origins cannot mint non-extractable CryptoKeys (crypto.subtle is
// absent), so their vault rows carry the private seed as opaque base64url.
// Still device-local — the seed never leaves this browser — but script-readable
// on its own device; the tradeoff accepted so join works at every hub address.
import { createKeypair, randomDeviceId, signMessage } from "./device-crypto.js";

function openVault() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open("porchlight-devices", 1);
    request.onupgradeneeded = () => request.result.createObjectStore("registrations");
    request.onerror = () => reject(request.error);
    request.onsuccess = () => resolve(request.result);
  });
}

async function saveRegistration(origin, did, deviceId, privateKey, publicKeyJwk) {
  const db = await openVault();
  try {
    await new Promise((resolve, reject) => {
      const tx = db.transaction("registrations", "readwrite");
      // The public JWK is cached beside the non-extractable private key: the
      // public half is public by definition and must re-travel (admission
      // re-enrolls it); the private half never serializes.
      tx.objectStore("registrations").put({ privateKey, publicKeyJwk }, `${origin}:${did}:${deviceId}`);
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
    });
  } finally { db.close(); }
}

/** Legacy vault rows stored the bare private CryptoKey before PORCH-010. */
// The CryptoKey global itself only exists on secure contexts (PORCH-039):
// insecure (plain-http LAN) origins never store CryptoKey rows — they store
// seed strings — so the instanceof check is guarded, not bare.
function asRecord(value) {
  if (!value) return null;
  if (typeof CryptoKey !== "undefined" && value instanceof CryptoKey) return { privateKey: value, publicKeyJwk: null };
  return value.privateKey ? value : null;
}

export async function createDeviceRegistration(origin, consume) {
  const { privateKey, publicKeyJwk } = await createKeypair();
  const deviceId = randomDeviceId();
  const result = await consume({ deviceId, label: "Browser", publicKeyJwk });
  const registration = result.registration;
  await saveRegistration(origin, registration.did, deviceId, privateKey, publicKeyJwk);
  return registration;
}

export async function getDeviceKey(origin, did, deviceId) {
  const db = await openVault();
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction("registrations", "readonly");
      const request = tx.objectStore("registrations").get(`${origin}:${did}:${deviceId}`);
      request.onsuccess = () => resolve(asRecord(request.result)?.privateKey || null);
      request.onerror = () => reject(request.error);
    });
  } finally { db.close(); }
}

/** The minted public JWK for a device registration, or null for legacy rows. */
export async function getDeviceJwk(origin, did, deviceId) {
  const db = await openVault();
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction("registrations", "readonly");
      const request = tx.objectStore("registrations").get(`${origin}:${did}:${deviceId}`);
      request.onsuccess = () => resolve(asRecord(request.result)?.publicKeyJwk || null);
      request.onerror = () => reject(request.error);
    });
  } finally { db.close(); }
}

export async function openDeviceSession(connection, registration, request) {
  const hub = new URL(connection.url).origin;
  const privateKey = await getDeviceKey(hub, registration.did, registration.deviceId);
  if (!privateKey) throw new Error("This device cannot open that identity. Ask for a fresh device link.");
  const challenge = await request(connection, "identity/session/challenge", { method: "POST", body: JSON.stringify({ did: registration.did }) });
  const raw = await signMessage(privateKey, new TextEncoder().encode(challenge.nonce));
  const bytes = new Uint8Array(raw);
  let value = "";
  for (const byte of bytes) value += String.fromCharCode(byte);
  const signature = btoa(value).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  return request(connection, "identity/session", { method: "POST", body: JSON.stringify({ did: registration.did, deviceId: registration.deviceId, nonce: challenge.nonce, signature }) });
}

/** Ed25519 signature over a raw message string (base64url), device-held key only. */
export async function signDeviceMessage(privateKey, message) {
  const raw = await signMessage(privateKey, new TextEncoder().encode(message));
  return btoa(String.fromCharCode(...new Uint8Array(raw))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

/** Every key this browser vault holds for one hub origin (all identities). */
export async function listVaultRegistrations(origin) {
  const db = await openVault();
  try {
    await new Promise((resolve, reject) => {
      const tx = db.transaction("registrations", "readonly");
      const store = tx.objectStore("registrations");
      const keysRequest = store.getAllKeys();
      const valuesRequest = store.getAll();
      keysRequest.onerror = () => reject(keysRequest.error);
      valuesRequest.onerror = () => reject(valuesRequest.error);
      tx.oncomplete = () => {
        // Vault keys are `${origin}:${did}:${deviceId}`; both origin and DID
        // carry colons, so the trailing deviceId splits on the LAST separator.
        const prefix = `${origin}:`;
        resolve(keysRequest.result
          .map((key, index) => {
            const entry = String(key);
            if (!entry.startsWith(prefix)) return null;
            const rest = entry.slice(prefix.length);
            const split = rest.lastIndexOf(":");
            if (split <= 0) return null;
            return { did: rest.slice(0, split), deviceId: rest.slice(split + 1), privateKey: valuesRequest.result[index] };
          })
          .filter(Boolean));
      };
    });
  } finally { db.close(); }
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  }
  return value;
}

export async function signDevicePayload(origin, did, deviceId, payload) {
  const privateKey = await getDeviceKey(origin, did, deviceId);
  if (!privateKey) throw new Error("This device is no longer connected. Ask for a fresh device link.");
  const bytes = await signMessage(privateKey, new TextEncoder().encode(JSON.stringify(canonical(payload))));
  return btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
