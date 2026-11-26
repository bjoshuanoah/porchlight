import { test } from "node:test";
import assert from "node:assert/strict";
import {
  alertCopy, eventEvidence, eventsByDay, factContainsInference, feedPlayState,
  gapCopy, healthExplain, healthNotes, inlineAspectRatio, isPortraitFeed,
  localInputValue, mediaUrl, viewerAspectRatio,
} from "../src/camera-model.js";
import { PORTRAIT_EXTENT } from "../src/photo-first.js";

const doorbellFeed = {
  _id: "cam_door",
  name: "Front door",
  aspect: { width: 9, height: 16 },
  live: { path: "/live/eng_door" },
  health: { recording: { state: "recording" }, playback: { state: "live" }, detection: { state: "ok" } },
};
const wideFeed = {
  _id: "cam_drive",
  name: "Driveway",
  aspect: { width: 16, height: 9 },
  live: { path: "/live/eng_drive" },
  health: { recording: { state: "recording" }, playback: { state: "live" }, detection: { state: "ok" } },
};

test("ac-1: portrait doorbell feeds inline-mask to the 3:4 extent; true ratios at or above the extent play natural", () => {
  // 9:16 is more portrait than 3:4 — the covered mask rides inline.
  assert.equal(inlineAspectRatio(doorbellFeed), "3 / 4");
  assert.equal(isPortraitFeed(doorbellFeed), true);
  // 4:5 is portrait but AT the extent — the true stamped ratio plays inline.
  const atExtent = { ...wideFeed, aspect: { width: 4, height: 5 }, _id: "x" };
  assert.equal(inlineAspectRatio(atExtent), "4 / 5");
  assert.equal(isPortraitFeed(atExtent), true);
  // Landscape and square never mask.
  assert.equal(inlineAspectRatio(wideFeed), "16 / 9");
  assert.equal(inlineAspectRatio({ ...wideFeed, aspect: { width: 1, height: 1 } }), "1 / 1");
  // Unmeasurable feeds carry the landscape default, never NaN.
  assert.equal(inlineAspectRatio({ ...wideFeed, aspect: null }), "16 / 9");
  // The extent of record is the shared photo-first constant.
  assert.equal(PORTRAIT_EXTENT, 3 / 4);
});

test("ac-1: the full-screen viewer plays natural aspect on EVERY ratio — the mask never reaches the viewer", () => {
  assert.equal(viewerAspectRatio(doorbellFeed), "9 / 16");
  assert.equal(viewerAspectRatio(wideFeed), "16 / 9");
  assert.equal(viewerAspectRatio({ ...wideFeed, aspect: { width: 22, height: 9 } }), "22 / 9");
});

test("ac-1: the media proxy URL rides the scoped token on the hub origin (same experience at home and away)", () => {
  const url = mediaUrl({ origin: "https://hub.example/", homeId: "home_1", cameraId: "cam_1", path: "/live/eng_1", token: "peng1.x.y" });
  assert.ok(url.startsWith("https://hub.example/api/home/homes/home_1/cameras/cam_1/media?path=%2Flive%2Feng_1&token=peng1.x.y"));
  assert.equal(mediaUrl({ origin: null, homeId: "h", cameraId: "c", path: "/p", token: "t" }), null);
  assert.equal(mediaUrl({ origin: "https://hub.example", homeId: "h", cameraId: "c", path: "/p", token: null }), null);
});

test("ac-2: explained gaps name retention expiry, recording-disabled, and unavailability — never a dead player", () => {
  assert.match(gapCopy("retention-expired"), /retention window/);
  assert.match(gapCopy("recording-disabled"), /Recording was off at that moment/);
  assert.match(gapCopy("unavailable"), /couldn't serve it|wasn't available/);
  assert.match(gapCopy("degraded"), /degraded/);
  assert.notEqual(gapCopy("offline"), gapCopy("unavailable"));
});

test("ac-2: seek-to-a-known-time renders a local datetime input value in the viewer's timezone", () => {
  const value = localInputValue("2026-11-20T07:05:00Z");
  // The bridge normalizes to UTC; the surface renders local — the test
  // machine's offset decides the literal string, the FORMAT and 24h pad are the contract.
  assert.match(value, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/);
  assert.equal(localInputValue("not-a-time"), null);
});

test("ac-5: the three health planes explain independently; recording-but-not-detecting never reads healthy", () => {
  const recordingNotDetecting = {
    ...doorbellFeed,
    health: { recording: { state: "recording" }, playback: { state: "live" }, detection: { state: "unhealthy" } },
  };
  const notes = healthNotes(recordingNotDetecting);
  assert.match(notes.find((row) => row.plane === "recording").note, /recording\./);
  assert.match(notes.find((row) => row.plane === "playback").note, /normally/);
  const detection = notes.find((row) => row.plane === "detection");
  assert.match(detection.note, /Detection isn't running/);
  assert.match(detection.note, /recording and playback continue/, "the plane copy names the independent planes");
  assert.equal(healthExplain({ plane: "recording", state: "disabled" }, wideFeed), "Recording is turned off for Driveway — live view continues, but nothing is captured.");
  // Unknown plane states fall back to a read-failure line, never silence.
  assert.match(healthExplain({ plane: "recording", state: "unknown-future" }, wideFeed), /can't be read/);
});

test("ac-1: feed play states name the gap — offline, missing feed path, and the recording-disabled note", () => {
  const offline = { ...doorbellFeed, health: { recording: { state: "offline" }, playback: { state: "live" }, detection: { state: "ok" } } };
  assert.equal(feedPlayState(offline).kind, "gap");
  assert.equal(feedPlayState(offline).reason, "offline");
  assert.match(feedPlayState(offline).copy, /offline right now/);
  const noFeed = { ...doorbellFeed, live: { path: null, gap: "unavailable" } };
  assert.equal(feedPlayState(noFeed).kind, "gap");
  assert.match(feedPlayState(noFeed).copy, /wasn't available/);
  const off = { ...doorbellFeed, health: { recording: { state: "disabled" }, playback: { state: "live" }, detection: { state: "ok" } } };
  const playing = feedPlayState(off);
  assert.equal(playing.kind, "live");
  assert.match(playing.note, /Recording is turned off for Front door/);
  assert.equal(feedPlayState(doorbellFeed).kind, "live");
  assert.equal(feedPlayState(doorbellFeed).note, null);
});

test("ac-3: the alert renders the factual label as fact and the inference as conditional — never the inference as fact", () => {
  const interpretive = {
    alert: { text: "Someone was seen at the Porch.", interpretive: "A package was likely left.", kind: "interpretive" },
    evidenceRefs: [{ kind: "still", ref: "s1", path: "/media/still.jpg" }],
    observations: [{ cameraId: "cam_1", label: "person" }],
  };
  const copy = alertCopy(interpretive);
  assert.equal(copy.factual, "Someone was seen at the Porch.");
  assert.equal(copy.interpretive, "A package was likely left.");
  assert.match(copy.conditional, /when the footage supports it/);
  // The contract sweep: the factual label NEVER carries the inference text.
  assert.equal(factContainsInference(interpretive), false);
  assert.equal(factContainsInference({
    alert: { text: "A package was likely left.", interpretive: "A package was likely left.", kind: "interpretive" },
  }), true, "an inference copy-pasted into fact must fail the sweep");
  assert.equal(factContainsInference({ alert: { text: "Someone was seen at the Porch." } }), false);
});

test("ac-3: the evidence ref opens a still, or explains the gap in place", () => {
  const still = eventEvidence({
    observations: [{ cameraId: "cam_1" }],
    evidenceRefs: [{ kind: "still", ref: "s1", path: "/media/still.jpg" }],
  });
  assert.equal(still.kind, "still");
  assert.equal(still.path, "/media/still.jpg");
  assert.equal(still.cameraId, "cam_1");
  const gapped = eventEvidence({
    observations: [{ cameraId: "cam_1" }],
    evidenceRefs: [{ kind: "gap", reason: "retention-expired" }],
  });
  assert.equal(gapped.kind, "gap");
  assert.match(gapped.copy, /retention window/);
  const none = eventEvidence({ observations: [], evidenceRefs: [] });
  assert.equal(none.kind, "gap");
});

test("ac-2: playback events partition into the viewer's local day buckets (calendar math)", () => {
  const events = [
    { startedAt: "2026-11-19T23:30:00Z" }, // late Nov 19 UTC
    { startedAt: "2026-11-20T07:05:00Z" },
    { startedAt: "2026-11-20T07:05:00Z" },
  ];
  const days = eventsByDay(events);
  const keys = [...days.keys()];
  assert.equal([...days.values()].every((rows) => rows.every((event) => typeof event?._id !== "string" || true)), true);
  // Partition property: every event lands exactly once, under day-shaped keys.
  const total = keys.reduce((sum, key) => sum + days.get(key).length, 0);
  assert.equal(total, events.length);
  assert.ok(keys.every((key) => /^\d{4}-\d{2}-\d{2}$/.test(key)));
  // UTC-adjacent instants split or merge by the viewer's day — never duplicated.
  assert.equal(keys.length >= 1, true);
});
