import { test } from "node:test";
import assert from "node:assert/strict";
import { createMemoryStore } from "@porchlight/shared";
import { NetworkService } from "../src/services/network.service.js";
import { QuotaService } from "../src/services/quota.service.js";
import { QUOTA_PLAIN_MESSAGE } from "../src/services/quota.service.js";

function fixture() {
  const db = createMemoryStore();
  const networks = new NetworkService(db.collection("networks"));
  const audit = async (action, payload = {}) => {
    await db.collection("audit_events").insertOne({
      _id: "aud_test",
      networkId: payload.networkId ?? null,
      did: payload.did ?? null,
      action,
      detail: payload.detail ?? {},
      createdAt: new Date().toISOString(),
    });
  };
  const quota = new QuotaService({
    artifacts: db.collection("artifacts"),
    networks: db.collection("networks"),
    audit,
  });
  return { db, networks, quota };
}

async function seededNetwork(networks, quotaForLimits, limits = null) {
  const network = (await networks.createNetwork({ name: "Family", ownerAccountId: "acct_1" })).network;
  if (limits) {
    await quotaForLimits.setLimits({ networkId: network._id, ...limits });
  }
  return network;
}

test("ac-3: upload admission enforces the owner ceiling with plain language", async () => {
  const { networks, quota } = fixture();
  const network = await seededNetwork(networks, quota, { storageCeilingMb: 1 });

  await quota.recordArtifact({ networkId: network._id, kind: "original", bytes: 600_000 });
  const admitted = await quota.admitUpload({ networkId: network._id, bytes: 400_000 });
  assert.equal(admitted.admitted, true);
  assert.equal(admitted.usedBytes, 1_000_000);
  assert.equal(admitted.ceilingMb, 1);

  // MiB arithmetic: 1 MiB = 1,048,576 bytes, so 500k more breaks the ceiling
  // (in-flight bytes count against admission, artifacts on record).
  await assert.rejects(
    () => quota.admitUpload({ networkId: network._id, bytes: 500_000 }),
    (error) => {
      assert.equal(error.code, "E_STORAGE_QUOTA_EXCEEDED");
      assert.equal(error.message, QUOTA_PLAIN_MESSAGE);
      return true;
    },
  );
});

test("ac-3: renditions and derived artifacts count against the same quota", async () => {
  const { networks, quota } = fixture();
  const network = await seededNetwork(networks, quota, { storageCeilingMb: 1 });
  await quota.recordArtifact({ networkId: network._id, kind: "original", bytes: 400_000 });
  await quota.recordArtifact({ networkId: network._id, kind: "rendition", bytes: 300_000 });
  const usage = await quota.usage({ networkId: network._id });
  assert.equal(usage.usedBytes, 700_000);

  await assert.rejects(
    () => quota.admitUpload({ networkId: network._id, bytes: 500_000 }),
    (error) => error.code === "E_STORAGE_QUOTA_EXCEEDED",
  );
});

test("ac-3: an unset ceiling admits and is reported, never defaulted", async () => {
  const { networks, quota } = fixture();
  const network = await seededNetwork(networks, quota);
  const admitted = await quota.admitUpload({ networkId: network._id, bytes: 5_000_000_000 });
  assert.equal(admitted.admitted, true);
  assert.equal(admitted.unset, true);
  assert.equal(admitted.ceilingMb, null);
  const limits = await quota.limits({ networkId: network._id });
  assert.equal(limits.storageCeilingMb, null);
  assert.equal(limits.retentionDays, null);
});

test("ac-3: retention sweep removes expired artifacts and frees their bytes", async () => {
  const { db, networks, quota } = fixture();
  const network = await seededNetwork(networks, quota, { retentionDays: 7 });

  const before = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
  const fresh = await quota.recordArtifact({ networkId: network._id, kind: "original", bytes: 100 });
  const stale = await quota.recordArtifact({ networkId: network._id, kind: "original", bytes: 200, retentionDays: 7, now: () => new Date(before) });

  const result = await quota.sweep({ networkId: network._id });
  assert.equal(result.swept, 1);
  assert.equal(result.bytesFreed, 200);

  const rows = await db.collection("artifacts").find({ networkId: network._id });
  assert.deepEqual(rows.map((row) => row._id), [fresh._id]);
  void stale;
});

test("ac-3: setLimits validates quantity-only inputs loudly", async () => {
  const { networks, quota } = fixture();
  const network = await seededNetwork(networks, quota);
  const set = await quota.setLimits({ networkId: network._id, storageCeilingMb: 1024, retentionDays: 30 });
  assert.equal(set.quota.storageCeilingMb, 1024);

  await assert.rejects(
    () => quota.setLimits({ networkId: network._id, storageCeilingMb: 0 }),
    (error) => error.code === "E_INVALID_QUOTA",
  );
  await assert.rejects(
    () => quota.setLimits({ networkId: network._id, retentionDays: -5 }),
    (error) => error.code === "E_INVALID_QUOTA",
  );
});

test("upload admission and sweeps record auditable member-action events", async () => {
  const { db, networks, quota } = fixture();
  const network = await seededNetwork(networks, quota, { retentionDays: 1 });
  const aMonthAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  await quota.recordArtifact({ networkId: network._id, kind: "original", bytes: 10 });
  await quota.recordArtifact({ networkId: network._id, kind: "original", bytes: 20, retentionDays: 1, now: () => aMonthAgo });
  await quota.sweep({ networkId: network._id });
  const actions = (await db.collection("audit_events").find({ networkId: network._id })).map((row) => row.action);
  assert.deepEqual(actions, ["upload", "upload", "retention_delete"]);
});

test("ac-3: a tightened retention window applies at the next sweep pass", async () => {
  const { db, networks, quota } = fixture();
  const network = await seededNetwork(networks, quota, { storageCeilingMb: 1024, retentionDays: 30 });
  const tenDaysAgo = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000);
  await quota.recordArtifact({
    networkId: network._id,
    kind: "original",
    bytes: 500,
    retentionDays: 30,
    now: () => tenDaysAgo,
  });

  // Owner tightens the window AFTER the artifact was recorded: the next
  // retention pass enforces the CURRENT setting, not the per-row stamp
  // written under the old one.
  await quota.setLimits({ networkId: network._id, storageCeilingMb: 1024, retentionDays: 7 });
  const result = await quota.sweep({ networkId: network._id });
  assert.equal(result.swept, 1);
  assert.equal(result.bytesFreed, 500);
  const remaining = await db.collection("artifacts").find({ networkId: network._id });
  assert.equal(remaining.length, 0);
});

test("ac-3: a widened retention window preserves rows the stamp would expire", async () => {
  const { db, networks, quota } = fixture();
  const network = await seededNetwork(networks, quota, { storageCeilingMb: 1024, retentionDays: 7 });
  const tenDaysAgo = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000);
  const row = await quota.recordArtifact({
    networkId: network._id,
    kind: "original",
    bytes: 300,
    retentionDays: 7,
    now: () => tenDaysAgo,
  });

  // Owner widens the window before any pass removed the row: the next pass
  // re-evaluates expiry from the row age against the new window, so the row
  // survives.
  await quota.setLimits({ networkId: network._id, storageCeilingMb: 1024, retentionDays: 30 });
  const result = await quota.sweep({ networkId: network._id });
  assert.equal(result.swept, 0);
  const remaining = await db.collection("artifacts").find({ networkId: network._id });
  assert.deepEqual(remaining.map((r) => r._id), [row._id]);
});

test("ac-3: clearing the window stops future passes but honors stamped expiry", async () => {
  const { networks, quota } = fixture();
  const network = await seededNetwork(networks, quota, { retentionDays: 1 });
  const aMonthAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  const stamped = await quota.recordArtifact({ networkId: network._id, kind: "original", bytes: 50, retentionDays: 1, now: () => aMonthAgo });
  await quota.setLimits({ networkId: network._id, storageCeilingMb: null, retentionDays: null });

  // null clears a limit (unset): un-stamped rows are safe forever, but the
  // row recorded while a window existed still carries its stamp.
  const result = await quota.sweep({ networkId: network._id });
  assert.equal(result.swept, 1);
  void stamped;
});