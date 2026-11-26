import { test } from "node:test";
import assert from "node:assert/strict";
import { homeFixture } from "./helpers/home.fixture.js";
import { engineFixture, addCameraFor, grantCameraAccessFor } from "./helpers/engine.fixture.js";
import { createEngineTokenService } from "../src/services/engine-token.js";

/** A second member row: members are inserted into the membership of record. */
async function addMemberFor(fx, home, did) {
  await fx.collection("home_members").insertOne({
    _id: `hm_${did.slice(-6)}`,
    homeId: home._id,
    did,
    role: "member",
    addedBy: "did:porch:test-owner",
    createdAt: fx.now(),
  });
}

const ISO_AFTER = (iso, seconds) => new Date(Date.parse(iso) + seconds * 1000).toISOString();

test("ac-1: the owner adds and validates a camera through the engine onboarding; the association store lands home + area", async () => {
  const fx = engineFixture();
  const owner = fx.identity();
  const home = await (await import("./helpers/home.fixture.js")).createHomeFor(fx, owner);
  const { porch } = await (await import("./helpers/home.fixture.js")).seedHomeDevices(fx, owner, home);
  const camera = await addCameraFor(fx, owner, home, porch._id, "rtsp://doorbell/cam1", "Front door");
  assert.equal(camera.homeId, home._id);
  assert.equal(camera.areaId, porch._id);
  assert.equal(camera.recordingEnabled, true);
  assert.match(camera._id, /^cam_/);
  assert.ok(camera.aspect); // the engine's reported geometry rides the store
  // The association write is audited like every other mutation.
  const audits = await fx.collection("home_audit").find({ homeId: home._id, type: "camera-change" });
  assert.equal(audits.length, 1);
  assert.equal(audits[0].actorIdentityRef, owner.did);
});

test("ac-1: a rejected camera refuses plainly, and non-owner roles never reach the registration surface", async () => {
  const fx = engineFixture();
  const owner = fx.identity();
  const home = await (await import("./helpers/home.fixture.js")).createHomeFor(fx, owner);
  fx.engine.nextValidate = () => ({ ok: false, reason: "RTSP timeout" });
  await assert.rejects(
    addCameraFor(fx, owner, home, null, "rtsp://broken/cam", "Broken cam"),
    { code: "E_CAMERA_REJECTED" },
  );
  // A plain member (no role bump) never registers cameras.
  const member = fx.identity("did:porch:member");
  await addMemberFor(fx, home, member.did);
  await assert.rejects(
    fx.mod.cameraService.register({ accessToken: member.token, homeId: home._id, ...(member.write({ name: "X", rtsp: "rtsp://x" })) }),
    { code: "E_NOT_PERMITTED", message: /owner/ },
  );
});

test("ac-1: home membership alone is NOT camera authorization — a member needs the separate camera-access row", async () => {
  const fx = engineFixture();
  const owner = fx.identity();
  const home = await (await import("./helpers/home.fixture.js")).createHomeFor(fx, owner);
  await seed(fx, owner, home);
  await addCameraFor(fx, owner, home, null, "rtsp://main/cam1");
  const member = fx.identity("did:porch:member");
  await addMemberFor(fx, home, member.did);
  await assert.rejects(
    fx.mod.cameraService.list({ accessToken: member.token, homeId: home._id }),
    { code: "E_CAMERA_ACCESS_REQUIRED", message: /own authorization|camera access/i },
  );
  // The separate authorization is granted... and the member reads cameras.
  await grantCameraAccessFor(fx, owner, home, member.did);
  const listed = await fx.mod.cameraService.list({ accessToken: member.token, homeId: home._id });
  assert.equal(listed.cameras.length, 1);
  // ...revoked, and the already-open session's NEXT read is denied.
  const rows = (await fx.mod.cameraService.listAccess({ accessToken: owner.token, homeId: home._id })).access;
  await fx.mod.cameraService.revokeAccess({ accessToken: owner.token, accessId: rows[0]._id, ...(owner.write({})) });
  await assert.rejects(
    fx.mod.cameraService.list({ accessToken: member.token, homeId: home._id }),
    { code: "E_CAMERA_ACCESS_REQUIRED" },
  );
});

test("ac-1: the view session serves natural-aspect descriptors and per-camera audio; added viewers never open a second upstream", async () => {
  const fx = engineFixture();
  const owner = fx.identity();
  const home = await (await import("./helpers/home.fixture.js")).createHomeFor(fx, owner);
  const { porch } = await seed(fx, owner, home);
  const doorbell = await addCameraFor(fx, owner, home, porch._id, "rtsp://doorbell/cam1", "Front door");
  const cam2 = await addCameraFor(fx, owner, home, porch._id, "rtsp://main/cam2", "Driveway");
  const first = await fx.mod.cameraService.viewSession({ accessToken: owner.token, homeId: home._id });
  const portrait = first.cameras.find((feed) => feed._id === doorbell._id);
  const landscape = first.cameras.find((feed) => feed._id === cam2._id);
  // Natural aspect law: portrait doorbells flag portrait (true ratio; the 3:4
  // extent inline mask is the web's photo-first render, never a server crop).
  assert.equal(portrait.portrait, true);
  assert.deepEqual(portrait.aspect, { width: 9, height: 16 });
  assert.equal(landscape.portrait, false);
  assert.equal(portrait.audio, true, "per-camera audio rides the engine's per-camera audio");
  assert.equal(landscape.audio, false);
  // The scoped engine token names exactly this home's cameras.
  const tokens = createEngineTokenService({ secret: fx.engineSecret });
  const claims = tokens.verify(first.token);
  assert.equal(claims.homeId, home._id);
  assert.equal(claims.did, owner.did);
  assert.ok(claims.cameras.length >= 2);
  // Added viewers: the standing feed descriptor is shared — the liveFeed
  // lookup count stays at its per-camera standing value.
  const before = fx.counts.liveFeed;
  await fx.mod.cameraService.viewSession({ accessToken: owner.token, homeId: home._id });
  await fx.mod.cameraService.mediaRef({
    token: first.token, homeId: home._id, cameraId: doorbell._id, path: "/live/eng_cam1",
  });
  await fx.mod.cameraService.mediaRef({
    accessToken: owner.token, homeId: home._id, cameraId: cam2._id, path: "/live/eng_cam2",
  });
  assert.equal(fx.counts.liveFeed, before, "no second upstream for added viewers — the bridge never opens media connections");
});

test("ac-1: the scoped view token expires and refuses; a foreign home token refuses", async () => {
  const fx = engineFixture();
  const owner = fx.identity();
  const home = await (await import("./helpers/home.fixture.js")).createHomeFor(fx, owner);
  await seed(fx, owner, home);
  const cam = await addCameraFor(fx, owner, home, null, "rtsp://main/cam1");
  const camera = await fx.mod.cameraService.findOne(cam._id);
  const base = fx.now();
  const mintTokens = createEngineTokenService({ secret: fx.engineSecret, now: () => base });
  const expired = mintTokens.mint({ did: owner.did, homeId: home._id, cameras: [camera.engineCameraId], ttl: 1 });
  const laterTokens = createEngineTokenService({ secret: fx.engineSecret, now: () => ISO_AFTER(base, 2) });
  assert.equal(laterTokens.verify(expired), null, "an expired engine token stops verifying");
  // A live session token still verifies in-window, then refuses across homes.
  const session = await fx.mod.cameraService.viewSession({ accessToken: owner.token, homeId: home._id });
  // Foreign home: mint for another home id — the media handoff refuses.
  const foreign = createEngineTokenService({ secret: fx.engineSecret }).mint({ did: owner.did, homeId: "home_elsewhere", cameras: [camera.engineCameraId] });
  await assert.rejects(
    fx.mod.cameraService.mediaRef({ token: foreign, homeId: home._id, cameraId: cam._id, path: "/live/eng_cam1" }),
    { code: "E_CAMERA_TOKEN_INVALID", message: /expired|open the camera/i },
  );
  // Path traversal never resolves through the engine seam.
  await assert.rejects(
    fx.mod.cameraService.mediaRef({ token: session.token, homeId: home._id, cameraId: cam._id, path: "/../etc/passwd" }),
    { code: "E_VALIDATION" },
  );
});

test("ac-2: seek to a known time lands the right segment; the gaps explain themselves", async () => {
  const fx = engineFixture();
  const owner = fx.identity();
  const home = await (await import("./helpers/home.fixture.js")).createHomeFor(fx, owner);
  const cam = await addCameraFor(fx, owner, home, null, "rtsp://main/cam1");
  const at = new Date("2026-11-20T12:00:00Z").toISOString();
  const found = await fx.mod.cameraService.seek({ accessToken: owner.token, homeId: home._id, cameraId: cam._id, at });
  assert.deepEqual(found.evidence, { kind: "segment", ref: "seg_main_at", path: "/media/seg.m4s" });
  fx.engine.segmentAtImpl = () => ({ gap: "retention-expired" });
  const expired = await fx.mod.cameraService.seek({ accessToken: owner.token, homeId: home._id, cameraId: cam._id, at });
  assert.equal(expired.gap, "retention-expired");
  fx.engine.segmentAtImpl = () => { throw new Error("engine gone"); };
  const unavailable = await fx.mod.cameraService.seek({ accessToken: owner.token, homeId: home._id, cameraId: cam._id, at });
  assert.equal(unavailable.gap, "unavailable");
  // A live visit grant never reaches playback either.
  const grantee = fx.identity("did:porch:grantee");
  await fx.registerIdentityRow(grantee.did);
  const { porch } = await seed(fx, owner, home);
  await fx.mod.grantService.create({
    accessToken: owner.token, homeId: home._id, ...owner.write({
      granteeDid: grantee.did,
      scopes: [{ resourceType: "area", resourceRef: porch._id, verbs: ["view", "control"] }],
      expiresAt: ISO_AFTER(fx.now(), 3600),
    }),
  });
  await assert.rejects(
    fx.mod.cameraService.seek({ accessToken: grantee.token, homeId: home._id, cameraId: cam._id, at }),
    { code: "E_NOT_PERMITTED", message: /never ride a visit grant/i },
  );
});

test("ac-2: the timeline serves segments from the engine's index plus event thumbnails; window validation refuses", async () => {
  const fx = engineFixture();
  const owner = fx.identity();
  const home = await (await import("./helpers/home.fixture.js")).createHomeFor(fx, owner);
  const { porch } = await seed(fx, owner, home);
  const cam = await addCameraFor(fx, owner, home, porch._id, "rtsp://main/cam1");
  const camDoc = await fx.mod.cameraService.findOne(cam._id);
  fx.engine.segmentsImpl = ({ cameraId }) => (cameraId === camDoc.engineCameraId
    ? [{ start: 1_764_400_000, end: 1_764_403_600, ref: "seg_a" }]
    : []);
  const from = "2026-11-20T10:00:00Z";
  const to = "2026-11-20T12:00:00Z";
  const timeline = await fx.mod.cameraService.timeline({ accessToken: owner.token, homeId: home._id, from, to });
  assert.equal(timeline.segments.length, 1);
  assert.equal(timeline.segments[0].ref, "seg_a");
  // An event inside the window rides the timeline with its thumbnail stills.
  await fx.mod.eventService.ingest({ camera: camDoc.engineCameraId, trackId: "t1", cls: "person", conf: 0.9, t: Math.floor(Date.parse(from) / 1000) + 60 });
  const withEvents = await fx.mod.cameraService.timeline({ accessToken: owner.token, homeId: home._id, from, to });
  assert.equal(withEvents.events.length, 1);
  assert.ok(withEvents.events[0].evidenceRefs.some((ref) => ref.kind === "still"));
  await assert.rejects(
    fx.mod.cameraService.timeline({ accessToken: owner.token, homeId: home._id, from: to, to: from }),
    { code: "E_VALIDATION" },
  );
});

test("ac-5: recording, playback, and detection health track independently, and the owner-only surfaces refuse members", async () => {
  const fx = engineFixture();
  const owner = fx.identity();
  const home = await (await import("./helpers/home.fixture.js")).createHomeFor(fx, owner);
  const { porch } = await seed(fx, owner, home);
  const member = fx.identity("did:porch:member");
  await addMemberFor(fx, home, member.did);
  await grantCameraAccessFor(fx, owner, home, member.did);
  const cam = await addCameraFor(fx, owner, home, porch._id, "rtsp://main/cam1");
  // The health planes answer independently — a camera recording but NOT
  // detecting reads as its own state, not a healthy blank feed.
  fx.engine.planes.detection = { state: "unhealthy" };
  const health = await fx.mod.cameraService.health({ accessToken: member.token, homeId: home._id });
  const plane = health.cameras.find((row) => row.cameraId === cam._id).planes;
  assert.deepEqual(plane, {
    recording: { state: "recording" },
    playback: { state: "live" },
    detection: { state: "unhealthy" },
  });
  // Recording-disabled on THIS camera only — the per-camera plane stays per-camera.
  const camDocHealth = await fx.mod.cameraService.findOne(cam._id);
  fx.engine.disabledCameras = new Set([camDocHealth.engineCameraId]);
  fx.engine.planes.detection = { state: "ok" };
  const second = await fx.mod.cameraService.health({ accessToken: member.token, homeId: home._id });
  assert.equal(second.cameras.find((row) => row.cameraId === cam._id).planes.recording.state, "disabled");
  // Owner surfaces refuse members with plain language.
  await assert.rejects(
    fx.mod.cameraService.setRecording({ accessToken: member.token, cameraId: cam._id, ...(member.write({ enabled: false })) }),
    { code: "E_NOT_PERMITTED", message: /owner/ },
  );
  await assert.rejects(
    fx.mod.cameraService.bulkRecording({ accessToken: member.token, homeId: home._id, ...(member.write({ enabled: true })) }),
    { code: "E_NOT_PERMITTED", message: /owner/ },
  );
});

test("ac-5: a visit grantee reaches NO camera surface — the refusal is plain language, and event surfaces refuse too", async () => {
  const fx = engineFixture();
  const owner = fx.identity();
  const home = await (await import("./helpers/home.fixture.js")).createHomeFor(fx, owner);
  const { porch } = await seed(fx, owner, home);
  const cam = await addCameraFor(fx, owner, home, porch._id, "rtsp://main/cam1");
  const grantee = fx.identity("did:porch:grantee");
  await fx.registerIdentityRow(grantee.did);
  await fx.mod.grantService.create({
    accessToken: owner.token, homeId: home._id, ...owner.write({
      granteeDid: grantee.did,
      scopes: [{ resourceType: "area", resourceRef: porch._id, verbs: ["view", "control"] }],
      expiresAt: ISO_AFTER(fx.now(), 3600),
    }),
  });
  for (const [name, run] of Object.entries({
    list: () => fx.mod.cameraService.list({ accessToken: grantee.token, homeId: home._id }),
    viewSession: () => fx.mod.cameraService.viewSession({ accessToken: grantee.token, homeId: home._id }),
    timeline: () => fx.mod.cameraService.timeline({ accessToken: grantee.token, homeId: home._id, from: "2026-11-20T10:00:00Z", to: "2026-11-20T11:00:00Z" }),
    health: () => fx.mod.cameraService.health({ accessToken: grantee.token, homeId: home._id }),
    events: () => fx.mod.eventService.list({ accessToken: grantee.token, homeId: home._id }),
    seek: () => fx.mod.cameraService.seek({ accessToken: grantee.token, homeId: home._id, cameraId: cam._id, at: new Date().toISOString() }),
  })) {
    await assert.rejects(run, { code: "E_NOT_PERMITTED", message: /cameras never ride a visit grant/i }, `${name} must refuse the visit grantee`);
  }
});

test("ac-5: camera-access grants and revocations land in the audit family with the acting owner", async () => {
  const fx = engineFixture();
  const owner = fx.identity();
  const home = await (await import("./helpers/home.fixture.js")).createHomeFor(fx, owner);
  await seed(fx, owner, home);
  const member = fx.identity("did:porch:member");
  await addMemberFor(fx, home, member.did);
  const access = await grantCameraAccessFor(fx, owner, home, member.did);
  // Duplicate grant and owner self-grant refuse; a non-member refuses.
  await assert.rejects(grantCameraAccessFor(fx, owner, home, member.did), { code: "E_CAMERA_ACCESS_EXISTS" });
  await assert.rejects(grantCameraAccessFor(fx, owner, home, owner.did), { code: "E_CAMERA_ACCESS_EXISTS" });
  const stranger = fx.identity("did:porch:stranger");
  await assert.rejects(grantCameraAccessFor(fx, owner, home, stranger.did), { code: "E_CAMERA_MEMBER_UNKNOWN" });
  await fx.mod.cameraService.revokeAccess({ accessToken: owner.token, accessId: access._id, ...(owner.write({})) });
  await assert.rejects(
    fx.mod.cameraService.revokeAccess({ accessToken: owner.token, accessId: access._id, ...(owner.write({})) }),
    { code: "E_CAMERA_ACCESS_ALREADY_REVOKED" },
  );
  const audits = await fx.collection("home_audit").find({ homeId: home._id });
  const grantRow = audits.find((row) => row.type === "grant" && row.detail?.resourceType === "camera");
  const revokeRow = audits.find((row) => row.type === "revoke" && row.detail?.resourceType === "camera");
  assert.equal(grantRow.actorIdentityRef, owner.did);
  assert.equal(revokeRow.actorIdentityRef, owner.did);
});

test("ac-1: with the engine not connected, camera surfaces fail closed with plain language - never a healthy blank surface", async () => {
  const fx = homeFixture(); // no engine, no secret
  const owner = fx.identity();
  const home = await (await import("./helpers/home.fixture.js")).createHomeFor(fx, owner);
  await assert.rejects(
    fx.mod.cameraService.list({ accessToken: owner.token, homeId: home._id }),
    { code: "E_ENGINE_NOT_CONNECTED", message: /engine isn't connected/i },
  );
  await assert.rejects(
    fx.mod.cameraService.viewSession({ accessToken: owner.token, homeId: home._id }),
    { code: "E_ENGINE_NOT_CONNECTED" },
  );
  await assert.rejects(
    fx.mod.cameraService.register({ accessToken: owner.token, homeId: home._id, ...owner.write({ name: "X", rtsp: "rtsp://x" }) }),
    { code: "E_ENGINE_NOT_CONNECTED" },
  );
});

test("ac-1: recording controls land audited rows; bulk covers the fleet of record", async () => {
  const fx = engineFixture();
  const owner = fx.identity();
  const home = await (await import("./helpers/home.fixture.js")).createHomeFor(fx, owner);
  const { porch } = await seed(fx, owner, home);
  const cam = await addCameraFor(fx, owner, home, porch._id, "rtsp://main/cam1");
  const other = await addCameraFor(fx, owner, home, porch._id, "rtsp://main/cam2", "Walkway");
  const updated = await fx.mod.cameraService.setRecording({ accessToken: owner.token, cameraId: cam._id, ...(owner.write({ enabled: false })) });
  assert.equal(updated.camera.recordingEnabled, false);
  const bulk = await fx.mod.cameraService.bulkRecording({ accessToken: owner.token, homeId: home._id, ...(owner.write({ enabled: true })) });
  assert.equal(bulk.cameras.length, 2);
  assert.ok(bulk.cameras.every((row) => row.recordingEnabled === true));
  const rows = await fx.collection("home_audit").find({ homeId: home._id, type: "camera-recording" });
  assert.equal(rows.length, 2);
  const bulkRow = rows.find((row) => row.detail?.action === "bulk-recording");
  assert.deepEqual([...bulkRow.detail.cameraIds].sort(), [cam._id, other._id].sort());
});

async function seed(fx, owner, home) {
  const { seedHomeDevices } = await import("./helpers/home.fixture.js");
  return seedHomeDevices(fx, owner, home);
}
