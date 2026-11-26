// API wrapper tests (PORCH-135): start a live @porchlight/config service
// on an ephemeral port and exercise the src/api.js wrappers end to end —
// cameras, zone save/list, composition, speed calibration + test, profile
// create/activate, and the knob layer inspector.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createConfigService } from "@porchlight/config";

import { ApiError, createApi } from "../src/api.js";

let root;
let live;
let api;

before(async () => {
  root = await mkdtemp(join(tmpdir(), "porch-console-api-"));
  const service = createConfigService({ root });
  live = await service.start(0); // ephemeral port
  api = createApi(`http://127.0.0.1:${live.port}`);
});

after(async () => {
  await live?.close();
});

test("health and cameras round-trip through the wrappers", async () => {
  await api.upsertCamera("cam-1", { name: "Front door", width: 1920, height: 1080, snapshotUrl: "http://example.test/front.mjpg" });
  await api.upsertCamera("cam-2", { name: "Back yard", width: 1280, height: 720 });

  const cameras = await api.listCameras();
  const front = cameras.find((camera) => camera.id === "cam-1");
  assert.ok(front, "cam-1 appears in the camera list");
  assert.equal(front.name, "Front door");
  assert.equal(front.width, 1920);
  assert.equal(front.height, 1080);
  assert.equal(front.snapshotUrl, "http://example.test/front.mjpg");
  assert.ok(cameras.some((camera) => camera.id === "cam-2"));

  // A re-put upserts (update in place, no duplicate).
  await api.upsertCamera("cam-1", { name: "Front porch", width: 1920, height: 1080 });
  const again = (await api.listCameras()).filter((camera) => camera.id === "cam-1");
  assert.equal(again.length, 1);
  assert.equal(again[0].name, "Front porch");
});

test("zone save/list/update/delete through the wrappers", async () => {
  const created = await api.createZone("cam-1", {
    name: "Porch",
    polygon: [[10, 10], [50, 10], [50, 60], [10, 60]],
    enabled: true,
  });
  assert.ok(created.id, "the created zone has an id");

  const listed = await api.listZones("cam-1");
  assert.ok(listed.some((zone) => zone.id === created.id && zone.name === "Porch"), "the saved zone lists back");

  await api.updateZone(created.id, { enabled: false });
  assert.equal((await api.listZones("cam-1")).find((zone) => zone.id === created.id).enabled, false);

  await api.deleteZone(created.id);
  assert.ok(!(await api.listZones("cam-1")).some((zone) => zone.id === created.id));

  // Invalid polygons are refused with a plain-language 422.
  await assert.rejects(
    () => api.createZone("cam-1", { name: "Bad", polygon: [[10, 10], [50, 50]] }),
    (error) => error instanceof ApiError && error.status === 422,
  );
});

test("composition reports contributors and overlap groups without dropping any", async () => {
  const near = await api.createZone("cam-1", {
    name: "Near porch",
    polygon: [[0, 0], [40, 0], [40, 40], [0, 40]],
    enabled: true,
  });
  const walkway = await api.createZone("cam-1", {
    name: "Walkway",
    polygon: [[20, 20], [60, 20], [60, 60], [20, 60]],
    enabled: true,
  });
  await api.createMask("cam-1", {
    name: "Street",
    polygon: [[0, 70], [100, 70], [100, 100], [0, 100]],
    enabled: true,
  });

  const composition = await api.getComposition("cam-1");
  assert.equal(composition.cameraId, "cam-1");
  assert.ok(composition.zones.some((zone) => zone.id === near.id));
  assert.ok(composition.zones.some((zone) => zone.id === walkway.id));
  assert.ok(composition.masks.length >= 1);

  const contributorIds = composition.contributors.map((contributor) => contributor.id);
  assert.ok(contributorIds.includes(near.id), "near-porch zone remains a contributor");
  assert.ok(contributorIds.includes(walkway.id), "walkway zone remains a contributor");
  assert.ok(composition.contributors.every((contributor) => contributor.kind === "zone" || contributor.kind === "mask"));

  const overlappingPair = composition.overlaps?.find(
    (group) => group.kind === "zone" && group.ids.includes(near.id) && group.ids.includes(walkway.id),
  );
  assert.ok(overlappingPair, "the two intersecting zones are listed as an overlap group");

  const roofMask = await api.createMask("cam-1", {
    name: "Roofline",
    polygon: [[25, 25], [45, 25], [45, 45], [25, 45]],
    enabled: true,
  });
  const afterMask = await api.getComposition("cam-1");
  assert.ok(
    afterMask.overlaps.some((group) => group.kind === "zone+mask" && group.ids.includes(near.id) && group.ids.includes(roofMask.id)),
    "a mask intersecting a zone surfaces as a zone+mask overlap group",
  );
});

test("speed calibration stores and estimates through the wrappers", async () => {
  await api.putSpeed("cam-1", {
    enabled: true,
    area: [[10, 20], [90, 20], [90, 80], [10, 80]],
    line: { p1: [40, 50], p2: [60, 50] },
    meters: 2,
  });

  const stored = await api.getSpeed("cam-1");
  assert.equal(stored.enabled, true);
  assert.deepEqual(stored.line, { p1: [40, 50], p2: [60, 50] });
  assert.equal(stored.meters, 2);

  // 20% of 1920px = 384px over 2m → 192 px/m: a good calibration.
  // The track crosses the full line in 1s → 384px / 192 px/m / 1s = 2 m/s.
  const estimate = await api.testSpeed("cam-1", [
    { t: 0, px: 40, py: 50 },
    { t: 1, px: 60, py: 50 },
  ]);
  assert.equal(estimate.estimate, true);
  assert.ok(Math.abs(estimate.speedMps - 2) < 0.01, `speed is 2 m/s, got ${estimate.speedMps}`);
  assert.equal(estimate.quality.grade, "good");
  assert.ok(Math.abs(estimate.quality.pxPerMeter - 192) < 0.01, `pxPerMeter is 192, got ${estimate.quality.pxPerMeter}`);

  // A camera without a stored calibration is refused with a 422.
  await assert.rejects(
    () => api.testSpeed("cam-2", [{ t: 0, px: 0, py: 0 }, { t: 1, px: 10, py: 0 }]),
    (error) => error instanceof ApiError && error.status === 422,
  );
});

test("base config and knob inspector reflect the layers per camera", async () => {
  await api.putBaseConfig({ _default: { recordingMode: "continuous" }, "cam-1": { zoneEnabled: false } });

  const base = await api.getBaseConfig();
  assert.equal(base._default?.recordingMode, "continuous");
  assert.equal(base["cam-1"]?.zoneEnabled, false);

  const knobs = await api.getKnobs("cam-1");
  const recording = knobs.knobs.recordingMode;
  assert.ok(recording, "recordingMode appears in the inspector payload");
  assert.equal(recording.base, "continuous");
  assert.equal(recording.source, "base");
  assert.equal(recording.value, "continuous");

  // cam-1's own base key beats the _default fallback for zoneEnabled.
  assert.equal(knobs.knobs.zoneEnabled.base, false);
});

test("profile create, activate, and inspector wiring", async () => {
  // The contract shape for `changed` is keyed by scope layer
  // ({ "_default" | cameraId }: { knob: { value, source } }); some single
  // layer responses may be flat ({ knob: { value, source } }) — accept
  // either and flatten to per-knob entries.
  const changedKnobs = (changed) => {
    const flat = {};
    for (const [key, entry] of Object.entries(changed ?? {})) {
      if (entry && typeof entry === "object" && !("source" in entry)) {
        for (const [knob, detail] of Object.entries(entry)) flat[knob] = detail;
      } else {
        flat[key] = entry;
      }
    }
    return flat;
  };

  const night = await api.createProfile({
    name: "Night",
    scope: "global",
    knobs: { recordingMode: "event", detectionEnabled: true },
  });
  assert.ok(night.id, "the created profile has an id");
  assert.ok((await api.listProfiles()).some((profile) => profile.id === night.id));

  const activation = await api.activateProfile(night.id);
  assert.equal(activation.activeProfileId, night.id);
  // The changed set carries { value, source } per knob; only knobs that
  // actually changed appear.
  assert.equal(typeof activation.changed, "object");
  assert.equal(changedKnobs(activation.changed).recordingMode?.value, "event");

  const active = await api.getActive();
  assert.equal(active.profileId, night.id);
  assert.equal(active.name, "Night");
  assert.equal(active.source, "manual");

  // The knob inspector reports the profile layer on every covered camera.
  const knobsCam1 = await api.getKnobs("cam-1");
  assert.equal(knobsCam1.knobs.recordingMode.value, "event");
  assert.equal(knobsCam1.knobs.recordingMode.source, "profile");
  assert.equal(knobsCam1.knobs.recordingMode.profileId, night.id);
  assert.equal(knobsCam1.knobs.detectionEnabled.value, true);

  const knobsCam2 = await api.getKnobs("cam-2");
  assert.equal(knobsCam2.knobs.recordingMode.source, "profile");
  assert.equal(knobsCam2.knobs.recordingMode.profileId, night.id);

  // Switching to a camera-scoped profile: it covers only its own camera.
  const door = await api.createProfile({
    name: "Door event",
    scope: "camera",
    cameraId: "cam-1",
    knobs: { zoneEnabled: true },
  });
  await api.activateProfile(door.id);
  const afterDoor = await api.getKnobs("cam-1");
  assert.equal(afterDoor.knobs.zoneEnabled.source, "profile");
  assert.equal(afterDoor.knobs.zoneEnabled.profileId, door.id);
  const cam2AfterDoor = await api.getKnobs("cam-2");
  assert.equal(cam2AfterDoor.knobs.recordingMode.source, "base");
  assert.equal(cam2AfterDoor.knobs.recordingMode.value, "continuous");

  // Deleting the active profile clears the activation.
  await api.deleteProfile(door.id);
  const cleared = await api.getActive();
  assert.equal(cleared.profileId, null);
  await api.deleteProfile(night.id);
  assert.ok(!(await api.listProfiles()).some((profile) => profile.id === night.id));
});

test("profile activation persists in the store (a fresh service resumes state)", async () => {
  const revived = await api.createProfile({ name: "Daytime", scope: "global", knobs: { recordingMode: "continuous" } });
  await api.activateProfile(revived.id);

  // Restart persistence is server-side: a brand-new createConfigService
  // over the same root must resume the activation the wrappers can read.
  const restarted = createConfigService({ root });
  const relaunched = await restarted.start(0);
  const restartedApi = createApi(`http://127.0.0.1:${relaunched.port}`);
  try {
    const active = await restartedApi.getActive();
    assert.equal(active.profileId, revived.id);
  } finally {
    await relaunched.close();
  }
  await api.deleteProfile(revived.id);
});

// Storage & recording wrappers (PORCH-136): the recorder-side endpoints
// live behind a stub service that records every request it receives, so
// the wrapper contract — methods, paths, bodies, and error propagation —
// is pinned independently of the live config service below.
const STORAGE_DOC = {
  state: "degraded-write",
  configured: true,
  activeLocation: "/media/failover",
  primary: "/media/porchlight",
  failover: "/media/failover",
  reason: "The primary location has not answered writes in 30 seconds.",
  driveHealthy: true,
  paused: false,
  usage: {
    tiers: { rolling: { segments: 12, bytes: 1536000 }, events: { segments: 4, bytes: 512000 }, manual: { segments: 1, bytes: 1024 } },
    diskUsedFraction: 0.63,
  },
  source: "recorder",
};

const STORAGE_RULES = [
  { id: "rule-1", eventClass: "person", keepDays: 30 },
  { id: "rule-2", cameraId: "cam-9", keepDays: 14 },
];

let stub;
let stubRequests;
let stubApi;

before(async () => {
  stubRequests = [];
  const json = (res, status, payload) => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(payload));
  };
  stub = createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => {
      raw += chunk;
    });
    req.on("end", () => {
      let body = null;
      try {
        body = raw ? JSON.parse(raw) : null;
      } catch {
        body = raw;
      }
      stubRequests.push({ method: req.method, url: req.url, body });
      const { method, url } = req;

      if (method === "GET" && url === "/api/storage") return json(res, 200, STORAGE_DOC);
      if (method === "PUT" && url === "/api/storage") {
        if (body?.primary === "/media/nope") return json(res, 422, { error: "The primary location /media/nope does not exist yet." });
        return json(res, 201, { ...STORAGE_DOC, state: "primary", primary: body?.primary });
      }
      if (method === "POST" && url === "/api/storage/test") {
        if (!body?.location) return json(res, 422, { error: "Enter a location to test." });
        return json(res, 200, { ok: true, location: body.location });
      }
      if (method === "POST" && url === "/api/storage/failback") {
        return json(res, 409, { error: "Recordings cannot switch back while the primary location is still not responding." });
      }
      if (method === "GET" && url === "/api/storage/rules") return json(res, 200, STORAGE_RULES);
      if (method === "POST" && url === "/api/storage/rules") {
        if (!body?.keepDays) return json(res, 422, { error: "Keep-days must be a positive number of days." });
        return json(res, 201, { id: "rule-3", ...body });
      }
      if (method === "PUT" && url === "/api/storage/rules/rule-1") return json(res, 200, { id: "rule-1", ...body });
      if (method === "DELETE" && url === "/api/storage/rules/rule-1") return json(res, 200, { ok: true });
      if (method === "DELETE" && url === "/api/storage/rules/rule-gone") return json(res, 404, { error: "That retention rule is already gone." });
      if (method === "POST" && url === "/api/cameras/cam-9/record/start") return json(res, 200, { ok: true, cameraId: "cam-9", mode: "manual" });
      if (method === "POST" && url === "/api/cameras/cam-9/record/stop") return json(res, 200, { ok: false, reason: "The camera was not recording, so there is nothing to stop." });
      return json(res, 404, { error: `No handler for ${method} ${url}` });
    });
  });
  await new Promise((resolve) => stub.listen(0, "127.0.0.1", resolve));
  stubApi = createApi(`http://127.0.0.1:${stub.address().port}`);
});

after(async () => {
  await new Promise((resolve) => stub.close(resolve));
});

test("storage status passes through and configuration round-trips (422s keep the server's words)", async () => {
  const doc = await stubApi.getStorage();
  assert.deepEqual(doc, STORAGE_DOC);

  const created = await stubApi.configureStorage({ primary: "/media/new", failover: "/media/spare", eventRetentionDays: 14 });
  assert.equal(created.state, "primary");
  assert.equal(created.primary, "/media/new");

  const put = stubRequests.find((entry) => entry.method === "PUT" && entry.url === "/api/storage");
  assert.ok(put, "configuration reached the service");
  assert.deepEqual(put.body, { primary: "/media/new", failover: "/media/spare", eventRetentionDays: 14 });

  await assert.rejects(
    () => stubApi.configureStorage({ primary: "/media/nope" }),
    (error) =>
      error instanceof ApiError &&
      error.status === 422 &&
      error.message === "The primary location /media/nope does not exist yet.",
  );
});

test("storage location test reports ok and refuses a missing location with a 422", async () => {
  const checked = await stubApi.testStorageLocation("/media/new");
  assert.deepEqual(checked, { ok: true, location: "/media/new" });

  await assert.rejects(
    () => stubApi.testStorageLocation(""),
    (error) => error instanceof ApiError && error.status === 422 && error.message === "Enter a location to test.",
  );
});

test("failback surfaces a recorder refusal as a 409 ApiError", async () => {
  await assert.rejects(
    () => stubApi.storageFailback(),
    (error) =>
      error instanceof ApiError &&
      error.status === 409 &&
      error.message === "Recordings cannot switch back while the primary location is still not responding.",
  );
  assert.ok(stubRequests.some((entry) => entry.method === "POST" && entry.url === "/api/storage/failback"));
});

test("retention rules list, add, update, and delete through the wrappers", async () => {
  const listed = await stubApi.listStorageRules();
  assert.equal(listed.length, 2);
  assert.ok(listed.some((rule) => rule.id === "rule-1" && rule.eventClass === "person"));

  const added = await stubApi.addStorageRule({ cameraId: "cam-9", keepDays: 7 });
  assert.equal(added.id, "rule-3");
  assert.equal(added.keepDays, 7);
  const post = stubRequests.find((entry) => entry.method === "POST" && entry.url === "/api/storage/rules");
  assert.deepEqual(post.body, { cameraId: "cam-9", keepDays: 7 });

  const updated = await stubApi.updateStorageRule("rule-1", { eventClass: "vehicle", keepDays: 60 });
  assert.equal(updated.keepDays, 60);
  const put = stubRequests.find((entry) => entry.method === "PUT" && entry.url === "/api/storage/rules/rule-1");
  assert.deepEqual(put.body, { eventClass: "vehicle", keepDays: 60 });

  await stubApi.deleteStorageRule("rule-1");
  assert.ok(stubRequests.some((entry) => entry.method === "DELETE" && entry.url === "/api/storage/rules/rule-1"));

  // An already-gone rule keeps the server's plain-language error.
  await assert.rejects(
    () => stubApi.deleteStorageRule("rule-gone"),
    (error) => error instanceof ApiError && error.status === 404 && error.message === "That retention rule is already gone.",
  );

  await assert.rejects(
    () => stubApi.addStorageRule({ keepDays: 0 }),
    (error) => error instanceof ApiError && error.status === 422 && error.message === "Keep-days must be a positive number of days.",
  );
});

test("manual record start/stop send recorder requests and pass refusal bodies through", async () => {
  const started = await stubApi.manualRecord("cam-9", "start");
  assert.deepEqual(started, { ok: true, cameraId: "cam-9", mode: "manual" });
  assert.ok(stubRequests.some((entry) => entry.method === "POST" && entry.url === "/api/cameras/cam-9/record/start"));

  // The recorder's own { ok: false, reason } refusal is the return value,
  // not an exception — the console shows the reason verbatim.
  const refused = await stubApi.manualRecord("cam-9", "stop");
  assert.deepEqual(refused, { ok: false, reason: "The camera was not recording, so there is nothing to stop." });
  assert.ok(stubRequests.some((entry) => entry.method === "POST" && entry.url === "/api/cameras/cam-9/record/stop"));
});

test("a fetch that never reaches the recorder resolves to { ok: false, reason }", async () => {
  const deadApi = createApi("http://127.0.0.1:1"); // nothing listens on port 1
  const failed = await deadApi.manualRecord("cam-9", "start");
  assert.equal(failed.ok, false);
  assert.ok(failed.reason, "a plain-language reason comes back for the console to show");
});
