import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { statSync } from "node:fs";
import { ensureOwnerDevice } from "../src/owner-device.mjs";

test("owner device persists one stable keypair with private material out of the hub", async () => {
  const home = await mkdtemp(join(tmpdir(), "porchlight-owner-device-"));
  const first = ensureOwnerDevice(home);
  assert.match(first.deviceId, /^[0-9a-f-]{36}$/);
  assert.equal(first.publicKeyJwk.kty, "OKP");
  assert.equal(first.publicKeyJwk.crv, "Ed25519");
  assert.equal("d" in first.publicKeyJwk, false, "public JWK must not carry private material");
  assert.equal(first.label, "Owner CLI");

  const second = ensureOwnerDevice(home);
  assert.deepEqual(
    { deviceId: second.deviceId, label: second.label, publicKeyJwk: second.publicKeyJwk },
    { deviceId: first.deviceId, label: first.label, publicKeyJwk: first.publicKeyJwk },
    "re-running must keep the same owner device",
  );

  const file = join(home, "identity", "device.json");
  const mode = statSync(file).mode & 0o777;
  assert.equal(mode, 0o600, "private key file must be owner-only");

  delete process.env.PORCHLIGHT_UNIT_KEEP;
  assert.throws(() => ensureOwnerDevice(null), /home root/);
});