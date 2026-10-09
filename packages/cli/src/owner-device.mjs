// Owner's server-adjacent control-plane device key (PORCH-015 remediation).
// The identity core binds every device-held key at admission ("keys on
// device"): the first account cannot exist without one, or its owner could
// never open a challenge-signature session. The CLI on the owner's own
// machine IS such a device: it generates a local Ed25519 keypair, persists
// the private half under PORCHLIGHT_HOME/identity/ (0600), and presents only
// the public JWK to the hub. The hub never receives private material, and a
// device-less first account stays impossible (E_DEVICE_KEY_REQUIRED).
import { mkdirSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { generateKeyPairSync, randomUUID } from "node:crypto";

export function ensureOwnerDevice(homeRoot) {
  if (!homeRoot) throw new Error("owner device needs the porchlight home root");
  const dir = join(homeRoot, "identity");
  const file = join(dir, "device.json");
  if (existsSync(file)) {
    const existing = JSON.parse(readFileSync(file, "utf8"));
    if (existing?.deviceId && existing?.publicKeyJwk) return { deviceId: existing.deviceId, label: existing.label, publicKeyJwk: existing.publicKeyJwk };
  }
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const publicKeyJwk = publicKey.export({ format: "jwk" });
  if ("d" in publicKeyJwk) throw new Error("public export carried private material");
  const deviceId = randomUUID();
  const row = {
    deviceId,
    label: "Owner CLI",
    createdAt: new Date().toISOString(),
    publicKeyJwk,
    privateKeyPem: privateKey.export({ format: "pem", type: "pkcs8" }),
  };
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(file, JSON.stringify(row, null, 2) + "\n", { mode: 0o600 });
  return { deviceId, label: row.label, publicKeyJwk };
}