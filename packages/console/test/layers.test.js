// Layer inspection model tests (PORCH-135): base / active-profile /
// effective mapping, knob defaults when neither layer sets a value, and
// the camera-scope fallback — a camera-scoped profile covers only its own
// camera, other cameras read the base layer.
import { test } from "node:test";
import assert from "node:assert/strict";

import { buildLayerTable } from "../src/profiles/layers.js";
import { KNOB_DEFAULTS, KNOB_WHITELIST } from "../src/profiles/knobs.js";

const CAM = "cam-1";
const OTHER = "cam-2";

function tableFor(overrides = {}) {
  return buildLayerTable({ cameraId: CAM, ...overrides });
}

function rowOf(table, knob) {
  return table.find((row) => row.knob === knob);
}

test("one row per whitelisted knob, in whitelist order", () => {
  const table = tableFor();
  assert.deepEqual(table.map((row) => row.knob), KNOB_WHITELIST);
});

test("base layer: camera base value beats the payload default fallback", () => {
  const table = tableFor({
    knobs: { cameraId: CAM, knobs: { recordingMode: { base: "event", value: "event", source: "base" } } },
  });
  const row = rowOf(table, "recordingMode");
  assert.deepEqual(row.base, { value: "event", set: true });
  assert.equal(row.effective, "event");
  assert.equal(row.source, "base");
});

test("base layer: unset knobs fall back to the knob defaults, marked unset", () => {
  const table = tableFor({ knobs: { cameraId: CAM, knobs: {} } });
  const row = rowOf(table, "detectionEnabled");
  assert.equal(row.base.set, false);
  assert.equal(row.base.value, KNOB_DEFAULTS.detectionEnabled);
  assert.equal(row.effective, KNOB_DEFAULTS.detectionEnabled);
  assert.equal(row.source, "base");
});

test("active global profile wins per knob; base fills the knobs it does not set", () => {
  const night = {
    id: "prof-night",
    name: "Night",
    scope: "global",
    knobs: { recordingMode: "event", alertRouting: ["bus"] },
  };
  const table = tableFor({
    knobs: {
      cameraId: CAM,
      knobs: {
        recordingMode: { base: "continuous", value: "event", source: "profile", profileId: "prof-night" },
        detectionEnabled: { base: false, value: false, source: "base" },
      },
    },
    profiles: [night],
    active: { profileId: "prof-night", name: "Night", source: "manual" },
  });

  const recording = rowOf(table, "recordingMode");
  assert.equal(recording.profile.set, true);
  assert.equal(recording.profile.applied, true);
  assert.equal(recording.profile.value, "event");
  assert.equal(recording.effective, "event");
  assert.equal(recording.source, "profile");
  assert.equal(recording.profileId, "prof-night");

  const routing = rowOf(table, "alertRouting");
  assert.equal(routing.profile.set, true);
  assert.deepEqual(routing.profile.value, ["bus"]);
  assert.equal(routing.source, "profile");

  // A knob the profile does not set stays on the base layer.
  const detection = rowOf(table, "detectionEnabled");
  assert.equal(detection.profile.set, false);
  assert.equal(detection.profile.applied, false);
  assert.equal(detection.effective, false);
  assert.equal(detection.source, "base");
});

test("camera-scope fallback: a camera-scoped profile covers only its camera", () => {
  const doorProfile = {
    id: "prof-door",
    name: "Door event",
    scope: "camera",
    cameraId: CAM,
    knobs: { recordingMode: "event" },
  };
  const sharedKnobs = {
    cameraId: OTHER,
    knobs: { recordingMode: { base: "continuous", value: "continuous", source: "base" } },
  };

  // Its own camera: the profile applies.
  const own = buildLayerTable({
    cameraId: CAM,
    knobs: { cameraId: CAM, knobs: { recordingMode: { base: "continuous", value: "event", source: "profile", profileId: "prof-door" } } },
    profiles: [doorProfile],
    active: { profileId: "prof-door", name: "Door event", source: "manual" },
  });
  const ownRow = rowOf(own, "recordingMode");
  assert.equal(ownRow.profile.applied, true);
  assert.equal(ownRow.effective, "event");
  assert.equal(ownRow.source, "profile");

  // A different camera: the camera-scoped profile does not apply — the
  // base layer resolves every knob for it.
  const elsewhere = buildLayerTable({
    cameraId: OTHER,
    knobs: sharedKnobs,
    profiles: [doorProfile],
    active: { profileId: "prof-door", name: "Door event", source: "manual" },
  });
  const otherRow = rowOf(elsewhere, "recordingMode");
  assert.equal(otherRow.profile.set, true); // the profile does set the knob…
  assert.equal(otherRow.profile.applied, false); // …but not for this camera
  assert.equal(otherRow.effective, "continuous");
  assert.equal(otherRow.source, "base");
  assert.equal(otherRow.profileId, undefined);

  // Unset knobs on that other camera fall back to the knob defaults.
  const defaultRow = rowOf(elsewhere, "zoneEnabled");
  assert.equal(defaultRow.effective, KNOB_DEFAULTS.zoneEnabled);
  assert.equal(defaultRow.source, "base");
});

test("no active profile: every row resolves from the base layer", () => {
  const table = tableFor({
    knobs: {
      cameraId: CAM,
      knobs: { audioDetectionEnabled: { base: true, value: true, source: "base" } },
    },
    profiles: [{ id: "prof-x", name: "X", scope: "global", knobs: { recordingMode: "event" } }],
    active: { profileId: null, source: null },
  });
  for (const row of table) {
    assert.equal(row.source, "base");
    assert.equal(row.profile.applied, false);
  }
  assert.equal(rowOf(table, "audioDetectionEnabled").effective, true);
});

test("unknown active profile id: rows fall back to base without a profile layer", () => {
  const table = tableFor({
    profiles: [],
    active: { profileId: "prof-gone", name: "Gone", source: "manual" },
  });
  for (const row of table) {
    assert.equal(row.source, "base");
    assert.equal(row.profile.set, false);
  }
});
