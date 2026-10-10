import { test } from "node:test";
import assert from "node:assert/strict";
import { createMemoryStore } from "@porchlight/shared";
import { DeviceService } from "../src/services/device.service.js";
import { sha256 } from "../src/services/signing.service.js";

function fixture(hook = null) {
  const db = createMemoryStore();
  const collections = {
    deviceRegistrations: db.collection("device_registrations"),
    pairingCodes: db.collection("pairing_codes"),
    deviceLinks: db.collection("device_links"),
    sessions: db.collection("sessions"),
  };
  const devices = new DeviceService({ ...collections, hash: sha256, onDeviceLinkMinted: hook });
  return { db, devices };
}

test("mintDeviceLink observes the mint for device notifications (PORCH-059)", async () => {
  const observed = [];
  const { devices } = fixture((event) => observed.push(event));
  const minted = await devices.mintDeviceLink({ did: "did:porch:test-a" });
  assert.deepEqual(observed, [{ did: "did:porch:test-a", grantId: minted.grantId }]);
  const stored = await devices.deviceLinks.find({ did: "did:porch:test-a" });
  assert.equal(stored.length, 1, "the mint persists unchanged");
});

test("a failing observer never fails the mint", async () => {
  const { devices } = fixture(() => {
    throw new Error("observer down");
  });
  const minted = await devices.mintDeviceLink({ did: "did:porch:test-b" });
  assert.ok(minted.token);
  assert.equal((await devices.deviceLinks.find({ did: "did:porch:test-b" })).length, 1);
});

test("mintDeviceLink works without an observer wired (push disabled)", async () => {
  const { devices } = fixture();
  const minted = await devices.mintDeviceLink({ did: "did:porch:test-c" });
  assert.ok(minted.grantId);
});