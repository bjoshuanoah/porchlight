import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMemoryStore } from "@porchlight/shared";
import { device, fixture } from "./helpers/content.fixture.js";
import { assembleSocialModule } from "../src/assemble.js";
import {
  MediaVolumeService,
  createInertVolume,
  VOLUME_CHECK,
} from "../src/services/media.volume.js";
import {
  createRelocatableMediaStore,
  createFileMediaStore,
  sha256Hex,
} from "../src/services/media.store.js";
import { MediaService } from "../src/services/media.service.js";

const OWNER = "did:porchlight:owner";
const FAMILY = "net_family";

/**
 * PORCH-054 fixtures. The filesystem inspector and the poll timer are the
 * two seams the volume service exposes for tests: every check, pause, and
 * recovery below is deterministic — no real NAS, no real clock.
 */
function fakeFs(rules = {}) {
  const perPath = (path) => (typeof rules.perPath === "function" ? rules.perPath(path) : rules);
  return {
    async inspect(path) {
      const s = perPath(path);
      return {
        exists: s.exists ?? true,
        statfsInfo:
          s.statfs === false
            ? null
            : { totalBytes: s.totalBytes ?? 512 * 1024 * 1024, freeBytes: s.freeBytes ?? 256 * 1024 * 1024, type: 24 },
        fsType: s.fsType ?? null,
        bootDevice: 1,
        sameDeviceAsBoot: s.sameDeviceAsBoot ?? false,
        cloudMount: s.cloudMount ?? false,
      };
    },
    async probeWrite(path) {
      const s = perPath(path);
      return s.writable === false
        ? { writable: false, reason: rules.reason ?? "The volume's permissions refuse writes to the hub." }
        : { writable: true };
    },
    mkdir(path) {
      (rules.created ??= []).push(path);
    },
  };
}

function manualTimer() {
  const timers = [];
  return {
    setTimeout: (fn, ms) => {
      const handle = { fn, ms };
      timers.push(handle);
      return handle;
    },
    clearTimeout: () => {},
    queued: () => timers.length,
    async tick() {
      const batch = timers.splice(0, timers.length);
      for (const handle of batch) await handle.fn();
    },
  };
}

/** A byte store whose failures at the storage boundary are scriptable. */
function scriptableStore(root = null) {
  const puts = [];
  let failCode = null;
  return {
    puts,
    failWith(code) {
      failCode = code;
    },
    relocate(newRoot) {
      root = newRoot;
    },
    get root() {
      return root;
    },
    async put(key, _bytes) {
      if (failCode) throw Object.assign(new Error(failCode), { code: failCode });
      puts.push(key);
      return key;
    },
    async get(key) {
      return puts.includes(key) ? Buffer.from(key) : null;
    },
    async has() {
      return true;
    },
    async delete() {
      return true;
    },
  };
}

function volume({ root, fs = fakeFs(), timer = manualTimer(), persistRoot = null, markers = null, uploads = null, relocatable = true, rootIsDefault = false, blobs = null } = {}) {
  const store = createMemoryStore();
  const cap = { events: [] };
  const audit = async (action, payload) => cap.events.push({ action, payload });
  const facade =
    blobs ??
    {
      relocate() {},
      root: root ?? null,
      async put(key, _bytes) {
        return key;
      },
      async get(key) {
        return Buffer.from(key);
      },
      async has() {
        return true;
      },
      async delete() {
        return true;
      },
    };
  const v = new MediaVolumeService(
    { markers: markers ?? store.collection("media_volume_markers"), uploads: uploads ?? store.collection("media_uploads"), audit, blobs: facade },
    { root, rootIsDefault, persistRoot, pollIntervalMs: 10_000, fs, timer, relocatable },
  );
  return { v, cap, markers: markers ?? store.collection("media_volume_markers"), uploads: uploads ?? store.collection("media_uploads"), facade, timer };
}

/* ---- ac-2: the five named checks, each refusal named ---- */

test("ac-2: a never-served root that is unmounted refuses media startup naming volume-not-ready", async () => {
  const { v } = volume({ root: "/Volumes/FamilyNAS", fs: fakeFs({ exists: false }) });
  await v.gatePromise;
  const status = await v.status();
  assert.equal(status.state, "startup-refused");
  assert.equal(status.check, VOLUME_CHECK.NOT_READY);
  assert.match(status.reason, /not a live mounted directory/);
});

test("ac-2: a read-only/wrong-permissions mount refuses naming not-writable", async () => {
  const { v } = volume({ root: "/Volumes/FamilyNAS", fs: fakeFs({ writable: false }) });
  await v.gatePromise;
  const status = await v.status();
  assert.equal(status.state, "startup-refused");
  assert.equal(status.check, VOLUME_CHECK.NOT_WRITABLE);
  assert.match(status.reason, /not writable/);
});

test("ac-2: capacity sanity refuses an absurdly small and a near-full volume", async () => {
  const small = volume({ root: "/Volumes/Tiny", fs: fakeFs({ totalBytes: 100 * 1024 * 1024 }) });
  await small.v.gatePromise;
  const smallStatus = await small.v.status();
  assert.equal(smallStatus.check, VOLUME_CHECK.CAPACITY_NOT_SANE);
  assert.match(smallStatus.reason, /too small/);

  const full = volume({ root: "/Volumes/Full", fs: fakeFs({ totalBytes: 1024 * 1024 * 1024, freeBytes: 10 * 1024 * 1024 }) });
  await full.v.gatePromise;
  const fullStatus = await full.v.status();
  assert.equal(fullStatus.check, VOLUME_CHECK.CAPACITY_NOT_SANE);
  assert.match(fullStatus.reason, /near-full/);
});

test("ac-2: FAT32/exFAT is rejected outright by the filesystem-type check", async () => {
  const { v } = volume({ root: "/Volumes/FatCam", fs: fakeFs({ fsType: "exfat" }) });
  await v.gatePromise;
  const status = await v.status();
  assert.equal(status.state, "startup-refused");
  assert.equal(status.check, VOLUME_CHECK.FS_TYPE_REJECTED);
  assert.match(status.reason, /4GB/);
});

test("ac-2: a cloud-filesystem impersonation mount is flagged to the owner, never silently admitted", async () => {
  const { v } = volume({ root: "/Users/hub/Library/CloudStorage/Dropbox-Archive", fs: fakeFs({ cloudMount: true }) });
  await v.gatePromise;
  const status = await v.status();
  assert.equal(status.state, "ready");
  assert.equal(status.flag, VOLUME_CHECK.FS_TYPE_FLAGGED);
});

test("ac-2: a mountpoint-shaped path resolving to the boot device refuses naming boot-disk-masquerade", async () => {
  for (const shaped of ["/Volumes/Ghost NAS", "/mnt/archive", "/media/archive"]) {
    const { v } = volume({ root: shaped, fs: fakeFs({ sameDeviceAsBoot: true }) });
    await v.gatePromise;
    const status = await v.status();
    assert.equal(status.state, "startup-refused", shaped);
    assert.equal(status.check, VOLUME_CHECK.BOOT_DISK_MASQUERADE, shaped);
    assert.match(status.reason, /share never mounted/);
  }
  // The default data-directory root is the legitimate local install: a
  // missing default directory is CREATED by the gate and stays legal even
  // on the boot device (it does not carry the mount-point shape).
  const created = [];
  const localState = { exists: false };
  const local = new MediaVolumeService(
    { markers: createMemoryStore().collection("m"), uploads: createMemoryStore().collection("u"), blobs: { relocate() {}, get root() { return null; } } },
    {
      root: join(tmpdir(), "porchlight-data", "media"),
      rootIsDefault: true,
      fs: {
        async inspect() {
          return { exists: localState.exists, statfsInfo: { totalBytes: 512 * 1024 * 1024, freeBytes: 256 * 1024 * 1024, type: 24 }, fsType: null, bootDevice: 1, sameDeviceAsBoot: true, cloudMount: false };
        },
        async probeWrite() {
          return localState.exists ? { writable: true } : { writable: false, reason: "gone" };
        },
        mkdir(path) {
          created.push(path);
          localState.exists = true;
        },
      },
    },
  );
  await local.gatePromise;
  assert.equal((await local.status()).state, "ready");
  assert.equal(created.length, 1);
});

/* ---- ac-2: a refusal never kills the module (auth, timelines, chat alive) ---- */

test("ac-2: a refused media root leaves auth and ingestion paused-but-module-alive", async () => {
  const fx = fixture({ networkIds: [FAMILY] });
  await fx.collections.networks.updateOne({ _id: FAMILY }, { $set: { ownerDid: OWNER } });
  const mod = assembleSocialModule(fx.store, {
    verifyMemberIdToken: (token) => (token ? { did: token } : null),
    media: { mediaRoot: "/Volumes/NotPresent", volumeFs: fakeFs({ exists: false }), mediaRootIsDefault: false },
  });
  await mod.mediaVolume.gatePromise;
  assert.equal((await mod.mediaVolume.status()).state, "startup-refused");
  // The full module assembled: the membership perimeter (auth) verifies.
  const dev = device("dev_o");
  const invite = await mod.inviteService.issue({ networkId: FAMILY, role: "owner" });
  const admitted = await mod.membershipService.admit({
    code: invite.token,
    identityAccessToken: OWNER,
    deviceId: dev.deviceId,
    devicePublicKeyJwk: dev.publicKeyJwk,
    signature: dev.sign(`porchlight-join:${invite.token}`),
  });
  const perimeter = await mod.membershipService.verifyAccessToken(admitted.accessToken, { surface: "media" });
  assert.ok(perimeter, "the membership perimeter stays alive through a media refusal");
  // Ingest pauses with the named state.
  await assert.rejects(
    mod.mediaService.beginUpload({
      accessToken: admitted.accessToken,
      payload: { size: 10, contentType: "image/jpeg" },
      signature: "x",
    }),
    (error) => error.code === "E_MEDIA_VOLUME_NOT_READY",
  );
});

/* ---- ac-3: ready-and-waiting + poll-and-recover ---- */

test("ac-3: a known-good root unmounted at boot enters ready-and-waiting and the poll auto-resumes", async () => {
  // First boot while the volume is up: the root enters the served history.
  const rules = { exists: true };
  const first = volume({ root: "/Volumes/FamilyNAS", fs: fakeFs(rules) });
  await first.v.gatePromise;
  assert.equal((await first.v.status()).state, "ready");

  // Second boot with the NAS unmounted: first-class not-ready, poll armed.
  rules.exists = false;
  const again = volume({ root: "/Volumes/FamilyNAS", fs: fakeFs(rules), markers: first.markers, timer: first.timer });
  await again.v.gatePromise;
  const paused = await again.v.status();
  assert.equal(paused.state, "volume-not-ready");
  assert.equal(paused.check, VOLUME_CHECK.NOT_READY);
  assert.match(paused.reason, /not a live mounted directory/);
  assert.equal(again.timer.queued(), 1, "the readiness poll is armed while paused");
  await again.markers.updateOne({ _id: (await first.markers.findOne({}))._id }, { $set: { lastReadyAt: "2020-01-01T00:00:00.000Z" } });

  // The NAS mounts again: within ONE poll interval media resumes
  // automatically — poll-and-recover, never refuse-and-restart.
  rules.exists = true;
  await again.timer.tick();
  const resumed = await again.v.status();
  assert.equal(resumed.state, "ready");
  assert.equal(again.timer.queued(), 0);
  const marker = await first.markers.findOne({});
  assert.notEqual(marker.lastReadyAt, "2020-01-01T00:00:00.000Z", "the served history marker's lastReadyAt moved on resume");
});

function mediaServiceFor({ uploads, blobs, volume: mediaVolume }) {
  return new MediaService(
    {
      uploads,
      assets: createMemoryStore().collection("media_assets"),
      artifacts: createMemoryStore().collection("artifacts"),
      membership: {
        verifyAccessToken: async () => ({
          session: { did: "did:porchlight:m", deviceId: "dev_m" },
          membership: { networkId: "n1" },
        }),
        verifyMemberWrite: async () => {},
      },
      quota: {
        admitUpload: async () => {},
        limits: async () => ({ storageCeilingMb: null, retentionDays: null }),
        recordArtifact: async () => {},
      },
      blobs,
      diskProbe: null,
      audit: async () => {},
      volume: mediaVolume,
    },
    { chunkSize: 4 },
  );
}

test("ac-3: a root dropped mid-run pauses ingest with the state named and recovers on the poll", async () => {
  const rules = { exists: true };
  const timer = manualTimer();
  const blobs = scriptableStore("/Volumes/FamilyNAS");
  const { v, uploads } = volume({ root: "/Volumes/FamilyNAS", fs: fakeFs(rules), timer, blobs });
  await v.gatePromise;
  const media = mediaServiceFor({ uploads, blobs, volume: v });

  const chunk = Buffer.from("abcd");
  await uploads.insertOne({
    _id: "upl_abc",
    networkId: "n1",
    did: "did:porchlight:m",
    deviceId: "dev_m",
    size: 8,
    contentType: "application/octet-stream",
    chunkSize: 4,
    chunkCount: 2,
    receivedChunks: [0],
    state: "open",
    mediaId: null,
    createdAt: new Date().toISOString(),
    lastActivityAt: new Date().toISOString(),
  });
  assert.equal(await media.putChunk({ accessToken: "t", uploadId: "upl_abc", index: 0, bytes: chunk, chunkSha: sha256Hex(chunk) }).then(
    (r) => r.received,
    () => NaN,
  ), 1, "the healthy root admits chunk writes");

  // The NAS drops mid-run: the next write fails, ingest PAUSES with the
  // state named, and the poll arms. Nothing is redirected anywhere.
  rules.exists = false;
  blobs.failWith("ENOENT");
  const err = await media
    .putChunk({ accessToken: "t", uploadId: "upl_abc", index: 1, bytes: Buffer.from("efgh"), chunkSha: sha256Hex(Buffer.from("efgh")) })
    .then(
      () => null,
      (e) => e,
    );
  assert.equal(err.code, "E_MEDIA_VOLUME_NOT_READY");
  assert.match(err.message, /not ready/);
  assert.equal((await v.status()).state, "volume-not-ready");
  assert.equal(timer.queued(), 1);
  const writesBeforePause = blobs.puts.length;
  await assert.rejects(
    media.putChunk({ accessToken: "t", uploadId: "upl_abc", index: 1, bytes: Buffer.from("efgh"), chunkSha: sha256Hex(Buffer.from("efgh")) }),
    (e) => e.code === "E_MEDIA_VOLUME_NOT_READY",
  );
  assert.equal(blobs.puts.length, writesBeforePause, "no bytes land anywhere while paused — never a silent fallback, never a redirect");

  // The NAS mounts again: the poll resumes media; the same chunk lands in
  // the configured root only.
  rules.exists = true;
  blobs.failWith(null);
  await timer.tick();
  assert.equal((await v.status()).state, "ready");
  const result = await media.putChunk({ accessToken: "t", uploadId: "upl_abc", index: 1, bytes: Buffer.from("efgh"), chunkSha: sha256Hex(Buffer.from("efgh")) });
  assert.equal(result.complete, true);
  assert.ok(blobs.puts.includes("upl_abc/1"), "the recovered write landed in the configured root");
});

test("ac-3: a failed read-back at the storage boundary pauses media with the failure named", async () => {
  const { v } = volume({ root: "/Volumes/FamilyNAS", fs: fakeFs() });
  await v.gatePromise;
  const err = v.noteWriteFailure(Object.assign(new Error("boom"), { code: "E_BLOB_READBACK" }), "/Volumes/FamilyNAS");
  assert.equal(err.code, "E_MEDIA_VOLUME_NOT_READY");
  assert.equal((await v.status()).state, "volume-not-ready");
  assert.match((await v.status()).reason, /read-back/);
});

test("ac-3: uploads acknowledge only after their bytes read back from the target root", async () => {
  const dir = mkdtempSync(join(tmpdir(), "porch-vol-"));
  try {
    const key = sha256Hex(Buffer.from("original-bytes"));
    const store = createFileMediaStore(dir);
    await store.put(key, Buffer.from("original-bytes"));
    const readBack = await store.get(key);
    assert.ok(readBack.equals(Buffer.from("original-bytes")), "the acknowledged put read back identical");
    // And the bytes are physically on the configured root's blob layout.
    assert.ok(existsSync(join(dir, "blobs", key.slice(0, 2), key)));
    assert.ok(readFileSync(join(dir, "blobs", key.slice(0, 2), key), "utf8") === "original-bytes");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/* ---- ac-4: no automatic migration; failing edits refused ---- */

test("ac-4: an edit whose path fails the five checks is refused with the check's reason named", async () => {
  const dirA = mkdtempSync(join(tmpdir(), "porch-a-"));
  try {
    const persisted = [];
    const rules = {
      perPath: (path) => (path.includes("porch-bad-") ? { writable: false } : {}),
    };
    const store = createRelocatableMediaStore(dirA);
    const { v } = volume({
      root: dirA,
      fs: fakeFs({ ...rules, exists: true }),
      persistRoot: (root) => {
        persisted.push(root);
      },
      blobs: store,
    });
    await v.gatePromise;
    const key = sha256Hex(Buffer.from("archive"));
    await store.put(key, Buffer.from("archive"));
    const err = await v.changeRoot(join(tmpdir(), "porch-bad-x")).then(
      () => null,
      (e) => e,
    );
    assert.equal(err.code, "E_MEDIA_ROOT_REFUSED");
    assert.equal(err.check, VOLUME_CHECK.NOT_WRITABLE);
    assert.match(err.reason, /not writable/);
    // Nothing changed: the pipeline still serves the OLD root.
    assert.equal((await v.status()).root, dirA);
    assert.deepEqual(persisted, [], "a refused edit never persists");
    // And the archive bytes never moved — no automatic migration.
    await store.put(sha256Hex(Buffer.from("after-refusal")), Buffer.from("after-refusal"));
    assert.ok(readdirSync(join(dirA, "blobs")).length >= 1, "new bytes still land on the current root");
  } finally {
    rmSync(dirA, { recursive: true, force: true });
  }
});

test("ac-4: a passing edit re-points without moving media; open uploads are abandoned with the reason named", async () => {
  const dirA = mkdtempSync(join(tmpdir(), "porch-a-"));
  const dirB = mkdtempSync(join(tmpdir(), "porch-b-"));
  try {
    const persisted = [];
    const store = createRelocatableMediaStore(dirA);
    const { v, uploads } = volume({
      root: dirA,
      fs: fakeFs({ exists: true }),
      persistRoot: (root) => {
        persisted.push(root);
      },
      blobs: store,
      uploads: createMemoryStore().collection("media_uploads"),
    });
    await v.gatePromise;
    const oldKey = sha256Hex(Buffer.from("old-archive"));
    await store.put(oldKey, Buffer.from("old-archive"));
    await uploads.insertOne({
      _id: "upl_open",
      networkId: "n1",
      did: "did:x",
      deviceId: "dev",
      size: 4,
      contentType: "application/octet-stream",
      chunkSize: 4,
      chunkCount: 1,
      receivedChunks: [0],
      state: "open",
      mediaId: null,
      createdAt: new Date().toISOString(),
      lastActivityAt: new Date().toISOString(),
    });

    const status = await v.changeRoot(dirB);
    assert.equal(status.root, dirB);
    assert.equal(status.state, "ready");
    assert.deepEqual(persisted, [dirB], "the config file is the source of truth and got the edit");
    const openRow = await uploads.findOne({ _id: "upl_open" });
    assert.equal(openRow.state, "abandoned");
    assert.equal(openRow.closedAs, "media-root-changed");
    // No automatic migration: the old bytes sit on the OLD volume.
    assert.equal(existsSync(join(dirB, "blobs", oldKey.slice(0, 2), oldKey)), false, "nothing moved automatically");
    assert.ok(existsSync(join(dirA, "blobs", oldKey.slice(0, 2), oldKey)), "the old volume keeps its bytes for the owner-run move");
    // New writes land on the NEW root only.
    const newKey = sha256Hex(Buffer.from("new-archive"));
    await store.put(newKey, Buffer.from("new-archive"));
    assert.ok(existsSync(join(dirB, "blobs", newKey.slice(0, 2), newKey)));
  } finally {
    rmSync(dirA, { recursive: true, force: true });
    rmSync(dirB, { recursive: true, force: true });
  }
});

/* ---- ac-1: the console + health surfaces carry root and readiness ---- */

async function serve(mod) {
  const expressMod = await import("express");
  const app = expressMod.default();
  app.use(expressMod.json());
  app.use("/api/social", mod.api);
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  const base = `http://127.0.0.1:${server.address().port}/api/social`;
  return { base, close: () => server.close() };
}

test("ac-1: the owner console shows the current root and readiness, and carries the edit action", async () => {
  const fx = fixture({ networkIds: [FAMILY] });
  await fx.collections.networks.updateOne({ _id: FAMILY }, { $set: { ownerDid: OWNER } });
  const dirA = mkdtempSync(join(tmpdir(), "porch-a-"));
  const dirB = mkdtempSync(join(tmpdir(), "porch-b-"));
  const dirBad = mkdtempSync(join(tmpdir(), "porch-bad-"));
  rmSync(dirBad, { recursive: true, force: true }); // an absent (unmounted) volume path
  try {
    const persisted = [];
    const mod = assembleSocialModule(fx.store, {
      verifyMemberIdToken: (token) => (token ? { did: token } : null),
      media: {
        mediaRoot: dirA,
        mediaRootIsDefault: false,
        persistRoot: (root) => {
          persisted.push(root);
        },
        volumeFs: fakeFs({
          perPath: (path) => (path === dirB ? { exists: true, writable: true } : path === dirBad ? { exists: false } : { exists: true, writable: true }),
        }),
      },
    });
    await mod.mediaVolume.gatePromise;
    const dev = device("dev_o");
    const invite = await mod.inviteService.issue({ networkId: FAMILY, role: "owner" });
    const owner = await mod.membershipService.admit({
      code: invite.token,
      identityAccessToken: OWNER,
      deviceId: dev.deviceId,
      devicePublicKeyJwk: dev.publicKeyJwk,
      signature: dev.sign(`porchlight-join:${invite.token}`),
    });
    const { base, close } = await serve(mod);
    try {
      const got = await fetch(`${base}/console/media-root`, { headers: { authorization: `Bearer ${owner.accessToken}` } });
      assert.equal(got.status, 200);
      const rootView = await got.json();
      assert.equal(rootView.root, dirA);
      assert.equal(rootView.state, "ready");
      assert.match(rootView.note, /never moves existing media/);

      // A failing edit: refused with the check's reason named.
      const refused = await fetch(`${base}/console/media-root`, {
        method: "PUT",
        headers: { authorization: `Bearer ${owner.accessToken}`, "content-type": "application/json" },
        body: JSON.stringify({ root: dirBad }),
      });
      assert.equal(refused.status, 422);
      const refusedBody = await refused.json();
      assert.equal(refusedBody.code, "E_MEDIA_ROOT_REFUSED");
      assert.equal(refusedBody.check, VOLUME_CHECK.NOT_READY);
      assert.deepEqual(persisted, [], "a refused edit never persists");

      // A passing edit re-points (media never moves — see the ac-4 test).
      const put = await fetch(`${base}/console/media-root`, {
        method: "PUT",
        headers: { authorization: `Bearer ${owner.accessToken}`, "content-type": "application/json" },
        body: JSON.stringify({ root: dirB }),
      });
      assert.equal(put.status, 200);
      const edited = await put.json();
      assert.equal(edited.root, dirB);
      assert.equal(edited.state, "ready");
      assert.deepEqual(persisted, [dirB]);
      assert.equal(mod.mediaVolume.root, dirB);

      // Non-owners never see the setting.
      const memberDev = device("dev_m");
      const memberCode = await mod.inviteService.issue({ networkId: FAMILY, role: "member" });
      const member = await mod.membershipService.admit({
        code: memberCode.token,
        identityAccessToken: "did:porchlight:member",
        deviceId: memberDev.deviceId,
        devicePublicKeyJwk: memberDev.publicKeyJwk,
        signature: memberDev.sign(`porchlight-join:${memberCode.token}`),
      });
      const denied = await fetch(`${base}/console/media-root`, { headers: { authorization: `Bearer ${member.accessToken}` } });
      assert.equal(denied.status, 403);
    } finally {
      close();
    }
  } finally {
    rmSync(dirA, { recursive: true, force: true });
    rmSync(dirB, { recursive: true, force: true });
  }
});

test("ac-1: the volume status shape the console and health services consume names root + state", async () => {
  const mod = assembleSocialModule(createMemoryStore(), {
    verifyMemberIdToken: (token) => (token ? { did: token } : null),
    media: { mediaRoot: mkdtempSync(join(tmpdir(), "porch-h-")), volumeFs: fakeFs({ exists: true, writable: true }) },
  });
  await mod.mediaVolume.gatePromise;
  const status = await mod.mediaService.volumeStatus();
  assert.equal(status.state, "ready");
  assert.ok(status.root.startsWith(tmpdir()));
  // The exact fields the health surface (apps/server) consumes.
  const { root, state, check, reason, flag } = status;
  assert.equal(typeof root, "string");
  assert.equal(state, "ready");
  assert.equal(check, null);
  assert.equal(reason, null);
  assert.equal(flag, null);
});

/* ---- edges: inert volume (memory-store deployments) ---- */

test("the inert volume (no filesystem root) stays ready and refuses edits", async () => {
  const inert = createInertVolume();
  assert.equal((await inert.status()).state, "ready");
  await assert.rejects(
    inert.changeRoot("/Volumes/Somewhere"),
    (error) => error.code === "E_MEDIA_ROOT_UNAVAILABLE",
  );
  await inert.assertReady();
});