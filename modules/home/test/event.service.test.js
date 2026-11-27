import { test } from "node:test";
import assert from "node:assert/strict";
import { engineFixture, addCameraFor } from "./helpers/engine.fixture.js";
import { createHomeFor } from "./helpers/home.fixture.js";

/** Engine epoch seconds for a known instant. */
const AT = (iso) => Math.floor(Date.parse(iso) / 1000);

/** Anchor the fixture clock near the detections - the sweep is clock-based. */
const clockAt = (fx, epochSec) => fx.setClock(() => new Date(epochSec * 1000).toISOString());

test("ac-3: several contributing cameras and frames resolve as ONE event and ONE alert under the dedup window", async () => {
  const fx = engineFixture();
  const owner = fx.identity();
  const home = await createHomeFor(fx, owner);
  const cam1 = await addCameraFor(fx, owner, home, null, "rtsp://main/cam1", "Driveway");
  const cam2 = await addCameraFor(fx, owner, home, null, "rtsp://main/cam2", "Walkway");
  const doc1 = await fx.mod.cameraService.findOne(cam1._id);
  const doc2 = await fx.mod.cameraService.findOne(cam2._id);
  const t = AT("2026-11-20T07:05:00Z");
  clockAt(fx, t + 30);
  const first = await fx.mod.eventService.ingest({ camera: doc1.engineCameraId, trackId: "t9", cls: "person", conf: 0.91, t });
  assert.equal(first.created, true);
  const second = await fx.mod.eventService.ingest({ camera: doc2.engineCameraId, trackId: "t9", cls: "person", conf: 0.87, t: t + 30 });
  assert.equal(second.created, false, "the second contribution joins the open event");
  // ONE document, TWO contributing cameras: the key (home, area, track).
  const rows = await fx.collection("home_events").find({ homeId: home._id });
  assert.equal(rows.length, 1);
  assert.deepEqual([...rows[0].cameraRefs].sort(), [doc1.engineCameraId && cam1._id, cam2._id].sort());
  assert.equal(rows[0].state, "updated");
  assert.equal(rows[0].observations.length, 2);
  // ONE alert of record — the factual label stands even as updates land.
  assert.equal(rows[0].alert.kind, "factual");
  assert.match(rows[0].alert.text, /^Someone was seen at the /);
});

test("ac-3: the dedup window expires into the closed state; a later arrival opens its own event", async () => {
  const fx = engineFixture({ dedupWindowSec: 120 });
  const owner = fx.identity();
  const home = await createHomeFor(fx, owner);
  const cam = await addCameraFor(fx, owner, home, null, "rtsp://main/cam1");
  const doc = await fx.mod.cameraService.findOne(cam._id);
  const t = AT("2026-11-20T07:05:00Z");
  clockAt(fx, t + 5);
  await fx.mod.eventService.ingest({ camera: doc.engineCameraId, trackId: "t1", cls: "vehicle", conf: 0.8, t });
  // The window expires on the service clock: the sweep closes the open event,
  // and the next arrival is a NEW event (same track, new window).
  fx.setClock(() => new Date((t + 400) * 1000).toISOString());
  const later = fx.mod.eventService.ingest({ camera: doc.engineCameraId, trackId: "t1", cls: "vehicle", conf: 0.8, t: t + 400 });
  await new Promise((resolve) => setImmediate(resolve));
  const rows = await fx.collection("home_events").find({ homeId: home._id }).then((r) => r.sort((a, b) => a.startedAt.localeCompare(b.startedAt)));
  assert.equal(rows.length, 2, "the second arrival opens a new event once the window expired");
  const [first, newEvent] = rows;
  assert.equal(first.state, "closed");
  assert.ok(first.closedAt);
  assert.equal(newEvent.state, "open");
  assert.equal((await later).created, true);
});

test("ac-3: evidence references ride the event — stills, and the gap reason when footage cannot carry it", async () => {
  const fx = engineFixture();
  const owner = fx.identity();
  const home = await createHomeFor(fx, owner);
  const cam = await addCameraFor(fx, owner, home, null, "rtsp://main/cam1");
  const doc = await fx.mod.cameraService.findOne(cam._id);
  const t = AT("2026-11-20T07:05:00Z");
  clockAt(fx, t + 5);
  const opened = await fx.mod.eventService.ingest({ camera: doc.engineCameraId, trackId: "t2", cls: "package", conf: 0.74, t });
  assert.deepEqual(opened.event.evidenceRefs, [{ kind: "still", ref: "still_main_at", path: "/media/still.jpg" }]);
  // The engine's gap answer rides the evidence with its reason — the UI
  // explains it in place, never a dead player.
  fx.engine.evidenceAtImpl = () => ({ gap: "retention-expired" });
  const second = await createHomeFor(fx, fx.identity("did:porch:owner2"));
  void second;
  const camB = await addCameraFor(fx, owner, home, null, "rtsp://main/camB", "Backyard");
  const docB = await fx.mod.cameraService.findOne(camB._id);
  const gapped = await fx.mod.eventService.ingest({ camera: docB.engineCameraId, trackId: "t3", cls: "animal", conf: 0.6, t });
  assert.deepEqual(gapped.event.evidenceRefs, [{ kind: "gap", reason: "retention-expired" }]);
  // Unknown cameras have no family surface: the detection is dropped.
  const unknown = await fx.mod.eventService.ingest({ camera: "eng_nobody", trackId: "t4", cls: "person", conf: 0.9, t });
  assert.equal(unknown.ignored, "unknown-camera");
});

test("ac-4: with the interpreter unavailable, the event still opens with evidence and the factual label - and captures continue", async () => {
  const fx = engineFixture();
  const owner = fx.identity();
  const home = await createHomeFor(fx, owner);
  const cam = await addCameraFor(fx, owner, home, null, "rtsp://main/cam1");
  const doc = await fx.mod.cameraService.findOne(cam._id);
  const t = AT("2026-11-20T07:05:00Z");
  clockAt(fx, t + 20);
  const opened = await fx.mod.eventService.ingest({ camera: doc.engineCameraId, trackId: "t7", cls: "person", conf: 0.9, t });
  assert.equal(opened.event.alert.kind, "factual");
  assert.match(opened.event.alert.text, /^Someone was seen at the /);
  assert.deepEqual(opened.event.inferences, []);
  assert.ok(opened.event.evidenceRefs.length >= 1);
  // The blocked porch is blocked: the drop stays factual, never an invented claim.
  const update = await fx.mod.eventService.ingest({ camera: doc.engineCameraId, trackId: "t7", cls: "package", conf: 0.7, t: t + 20 });
  assert.equal(update.event.state, "updated");
  assert.equal(update.event.observations.length, 2);
  const row = await fx.collection("home_events").findOne({ _id: opened.event._id });
  assert.match(row.alert.text, /^Someone was seen at the /, "the factual label never grows an invented package claim");
});

test("ac-4: interpretation gates on state transitions (never per frame); its copy renders conditional, never as fact", async () => {
  const describes = [];
  const fx = engineFixture({ interpreter: { name: "ollama-test", describe: async ({ event }) => { describes.push(event._id); return { text: "A package was likely left." }; } } });
  const owner = fx.identity();
  const home = await createHomeFor(fx, owner);
  const cam = await addCameraFor(fx, owner, home, null, "rtsp://main/cam1");
  const doc = await fx.mod.cameraService.findOne(cam._id);
  const t = AT("2026-11-20T07:05:00Z");
  clockAt(fx, t + 20);
  await fx.mod.eventService.ingest({ camera: doc.engineCameraId, trackId: "t5", cls: "person", conf: 0.9, t });
  await fx.mod.eventService.ingest({ camera: doc.engineCameraId, trackId: "t5", cls: "person", conf: 0.9, t: t + 10 });
  await fx.mod.eventService.ingest({ camera: doc.engineCameraId, trackId: "t5", cls: "person", conf: 0.9, t: t + 20 });
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  // One open transition → ONE describe call; the frame contributions never
  // call the interpreter again.
  assert.equal(describes.length, 1);
  const row = await fx.collection("home_events").findOne({ homeId: home._id });
  assert.equal(row.inferences.length, 1);
  assert.equal(row.inferences[0].text, "A package was likely left.");
  assert.equal(row.inferences[0].gate, `open:${row._id}`);
  // The alert carries BOTH: the factual label unchanged, the inference
  // conditional — an inference never renders as the fact itself.
  assert.match(row.alert.text, /^Someone was seen at the /);
  assert.equal(row.alert.kind, "interpretive");
  assert.equal(row.alert.interpretive, "A package was likely left.");
});

test("ac-4: a failing interpreter never blocks capture, facts, or factual alerts", async () => {
  const fx = engineFixture({ interpreter: { name: "ollama-test", describe: async () => { throw new Error("interpreter down"); } } });
  const owner = fx.identity();
  const home = await createHomeFor(fx, owner);
  const cam = await addCameraFor(fx, owner, home, null, "rtsp://main/cam1");
  const doc = await fx.mod.cameraService.findOne(cam._id);
  const t = AT("2026-11-20T07:05:00Z");
  clockAt(fx, t + 15);
  const opened = await fx.mod.eventService.ingest({ camera: doc.engineCameraId, trackId: "t8", cls: "person", conf: 0.9, t });
  assert.equal(opened.created, true);
  const updated = await fx.mod.eventService.ingest({ camera: doc.engineCameraId, trackId: "t8", cls: "person", conf: 0.9, t: t + 15 });
  assert.equal(updated.event.state, "updated");
  const row = await fx.collection("home_events").findOne({ _id: opened.event._id });
  assert.deepEqual(row.inferences, []);
  assert.equal(row.alert.kind, "factual");
  assert.match(row.alert.text, /^Someone was seen at the /);
});

test("ac-3: the flag control marks an incorrect event once, landing an audit row with the actor", async () => {
  const fx = engineFixture();
  const owner = fx.identity();
  const home = await createHomeFor(fx, owner);
  const cam = await addCameraFor(fx, owner, home, null, "rtsp://main/cam1");
  const doc = await fx.mod.cameraService.findOne(cam._id);
  const t = AT("2026-11-20T07:05:00Z");
  clockAt(fx, t + 5);
  const opened = await fx.mod.eventService.ingest({ camera: doc.engineCameraId, trackId: "t6", cls: "vehicle", conf: 0.9, t });
  const flagged = await fx.mod.eventService.flag({ accessToken: owner.token, eventId: opened.event._id, did: owner.did });
  assert.equal(flagged.event.flag.by, owner.did);
  // The flag of record is one per event: a second flag is idempotent.
  const again = await fx.mod.eventService.flag({ accessToken: owner.token, eventId: opened.event._id, did: owner.did });
  assert.deepEqual(again.event.flag, flagged.event.flag);
  const audits = await fx.collection("home_audit").find({ homeId: home._id, type: "event-flag" });
  assert.equal(audits.length, 1);
  assert.equal(audits[0].actorIdentityRef, owner.did);
});

test("ac-3: the alert surface lists newest first with a bounded page, camera-class authorization enforced", async () => {
  const fx = engineFixture();
  const owner = fx.identity();
  const home = await createHomeFor(fx, owner);
  const cam = await addCameraFor(fx, owner, home, null, "rtsp://main/cam1");
  const doc = await fx.mod.cameraService.findOne(cam._id);
  const t = AT("2026-11-20T07:05:00Z");
  clockAt(fx, t + 0);
  await fx.mod.eventService.ingest({ camera: doc.engineCameraId, trackId: "tA", cls: "person", conf: 0.9, t: t - 60 });
  await fx.mod.eventService.ingest({ camera: doc.engineCameraId, trackId: "tB", cls: "vehicle", conf: 0.9, t });
  const listed = await fx.mod.eventService.list({ accessToken: owner.token, homeId: home._id, limit: 1 });
  assert.equal(listed.events.length, 1);
  assert.equal(listed.total, 2);
  assert.match(listed.events[0].alert.text, /^A vehicle was seen/, "newest first");
  // Without the camera-class auth the list refuses — the event surface is a
  // camera surface (PRD 2's exclusion law); anonymous token refusal is the
  // identity plane's own plain language.
  await assert.rejects(
    fx.mod.eventService.list({ accessToken: null, homeId: home._id }),
    { code: "E_MUST_SIGN_IN" },
  );
});

test("ac-2: the AudioEvent family opens a timeline event on the SAME evidence path — clip+timestamp through the engine seam", async () => {
  const fx = engineFixture();
  const owner = fx.identity();
  const home = await createHomeFor(fx, owner);
  const cam = await addCameraFor(fx, owner, home, null, "rtsp://main/cam1");
  const doc = await fx.mod.cameraService.findOne(cam._id);
  const t = AT("2026-11-20T07:05:00Z");
  clockAt(fx, t + 5);
  // The AudioEvent contract of record (PORCH-153): class/timestamp/confidence
  // vocabulary, no track id — published onto the same bus family.
  const opened = await fx.mod.eventService.ingest({
    camera: doc.engineCameraId, class: "dog-bark", confidence: 0.92, timestamp: t,
  });
  assert.equal(opened.created, true);
  assert.equal(opened.event.alert.kind, "factual");
  assert.match(opened.event.alert.text, /^A dog bark was heard at the /, "the audio fact is phrased HEARD, never seen");
  // The SAME evidence path as visual events: the engine's evidence seam
  // resolved the event's timestamp into a clip/segment ref.
  assert.deepEqual(opened.event.evidenceRefs, [{ kind: "still", ref: "still_main_at", path: "/media/still.jpg" }]);
  assert.equal(opened.event.observations[0].label, "dog-bark");
  assert.equal(opened.event.observations[0].confidence, 0.92);
  assert.equal(opened.event.observations[0].trackId, "audio-dog-bark");
  // The timeline list serves the audio event like any visual event.
  const listed = await fx.mod.eventService.list({ accessToken: owner.token, homeId: home._id });
  assert.equal(listed.total, 1);
  assert.match(listed.events[0].alert.text, /dog bark was heard/);
});

test("ac-2: audio classes dedup per class — a glass break and a dog bark stay distinct records", async () => {
  const fx = engineFixture();
  const owner = fx.identity();
  const home = await createHomeFor(fx, owner);
  const cam = await addCameraFor(fx, owner, home, null, "rtsp://main/cam1");
  const doc = await fx.mod.cameraService.findOne(cam._id);
  const t = AT("2026-11-20T07:05:00Z");
  clockAt(fx, t + 5);
  const bark = await fx.mod.eventService.ingest({ camera: doc.engineCameraId, class: "dog-bark", confidence: 0.9, timestamp: t });
  const barkTwo = await fx.mod.eventService.ingest({ camera: doc.engineCameraId, class: "dog-bark", confidence: 0.88, timestamp: t + 10 });
  const glass = await fx.mod.eventService.ingest({ camera: doc.engineCameraId, class: "glass-break", confidence: 0.95, timestamp: t + 15 });
  assert.equal(bark.created, true);
  assert.equal(barkTwo.created, false, "two barks in one window resolve as one event record");
  assert.equal(glass.created, true, "a different class opens its own timeline record");
  const rows = await fx.collection("home_events").find({ homeId: home._id });
  assert.equal(rows.length, 2);
  const labels = rows.map((r) => r.alert.text).sort();
  assert.deepEqual(labels, ["A dog bark was heard at the the property.", "Glass breaking was heard at the the property."]);
  // Every audio-family record keys per class; nothing merges across classes.
  assert.deepEqual([...new Set(rows.map((r) => r.trackId))].sort(), ["audio-dog-bark", "audio-glass-break"]);
});

test("ac-2: an audio arrival without its timestamp is malformed — never a silent event with a guessed time", async () => {
  const fx = engineFixture();
  const owner = fx.identity();
  const home = await createHomeFor(fx, owner);
  const cam = await addCameraFor(fx, owner, home, null, "rtsp://main/cam1");
  const doc = await fx.mod.cameraService.findOne(cam._id);
  const t = AT("2026-11-20T07:05:00Z");
  clockAt(fx, t + 5);
  const bad = await fx.mod.eventService.ingest({ camera: doc.engineCameraId, class: "dog-bark", confidence: 0.9 });
  assert.equal(bad.ignored, "malformed-detection");
  const rows = await fx.collection("home_events").find({ homeId: home._id });
  assert.equal(rows.length, 0);
});
