// IndexedDB structured-clones non-extractable CryptoKeys. Only the public JWK
// crosses the network; no private material is serialized into browser storage.
function openVault() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open("porchlight-devices", 1);
    request.onupgradeneeded = () => request.result.createObjectStore("registrations");
    request.onerror = () => reject(request.error);
    request.onsuccess = () => resolve(request.result);
  });
}

async function saveRegistration(origin, did, deviceId, privateKey) {
  const db = await openVault();
  try {
    await new Promise((resolve, reject) => {
      const tx = db.transaction("registrations", "readwrite");
      tx.objectStore("registrations").put(privateKey, `${origin}:${did}:${deviceId}`);
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
    });
  } finally { db.close(); }
}

export async function createDeviceRegistration(origin, consume) {
  const keys = await crypto.subtle.generateKey({ name: "Ed25519" }, false, ["sign", "verify"]);
  const deviceId = crypto.randomUUID();
  const publicKeyJwk = await crypto.subtle.exportKey("jwk", keys.publicKey);
  const result = await consume({ deviceId, label: "Browser", publicKeyJwk });
  const registration = result.registration;
  await saveRegistration(origin, registration.did, deviceId, keys.privateKey);
  return registration;
}

export async function getDeviceKey(origin, did, deviceId) {
  const db = await openVault();
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction("registrations", "readonly");
      const request = tx.objectStore("registrations").get(`${origin}:${did}:${deviceId}`);
      request.onsuccess = () => resolve(request.result || null);
      request.onerror = () => reject(request.error);
    });
  } finally { db.close(); }
}

export async function openDeviceSession(connection, registration, request) {
  const hub = new URL(connection.url).origin;
  const privateKey = await getDeviceKey(hub, registration.did, registration.deviceId);
  if (!privateKey) throw new Error("This device cannot open that identity. Ask for a fresh device link.");
  const challenge = await request(connection, "identity/session/challenge", { method: "POST", body: JSON.stringify({ did: registration.did }) });
  const raw = await crypto.subtle.sign("Ed25519", privateKey, new TextEncoder().encode(challenge.nonce));
  const bytes = new Uint8Array(raw);
  let value = "";
  for (const byte of bytes) value += String.fromCharCode(byte);
  const signature = btoa(value).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  return request(connection, "identity/session", { method: "POST", body: JSON.stringify({ did: registration.did, deviceId: registration.deviceId, nonce: challenge.nonce, signature }) });
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
  const bytes = await crypto.subtle.sign("Ed25519", privateKey, new TextEncoder().encode(JSON.stringify(canonical(payload))));
  return btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
