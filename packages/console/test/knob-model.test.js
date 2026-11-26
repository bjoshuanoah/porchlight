// Knob whitelist field-model tests (PORCH-135): the UI's knob field model
// contains exactly the six whitelisted knobs — nothing more, nothing less —
// and refuses to build a patch carrying anything outside the whitelist.
import { test } from "node:test";
import assert from "node:assert/strict";

import { KNOB_FIELDS, KNOB_WHITELIST, buildKnobPatch, knobField } from "../src/profiles/knobs.js";

const WHITELIST = [
  "recordingMode",
  "detectionEnabled",
  "detectionClasses",
  "audioDetectionEnabled",
  "alertRouting",
  "zoneEnabled",
];

test("the knob field model is exactly the six-knob whitelist, in domain order", () => {
  assert.deepEqual(KNOB_WHITELIST, WHITELIST);
  assert.deepEqual(KNOB_FIELDS.map((field) => field.knob), WHITELIST);
});

test("every knob renders from its specified control kind and options", () => {
  const kinds = Object.fromEntries(KNOB_FIELDS.map((field) => [field.knob, field]));
  assert.deepEqual(kinds.recordingMode, { knob: "recordingMode", label: "Recording mode", kind: "select", options: ["continuous", "event"] });
  assert.equal(kinds.detectionEnabled.kind, "toggle");
  assert.deepEqual(kinds.detectionClasses.options, ["person", "animal", "vehicle"]);
  assert.equal(kinds.audioDetectionEnabled.kind, "toggle");
  assert.deepEqual(kinds.alertRouting.options, ["bus", "webhook"]);
  assert.equal(kinds.zoneEnabled.kind, "toggle");
});

test("knobField returns descriptors only for whitelisted knobs", () => {
  assert.equal(knobField("recordingMode").kind, "select");
  assert.equal(knobField("brightness"), undefined);
});

test("buildKnobPatch keeps only whitelisted keys", () => {
  const patch = buildKnobPatch({
    recordingMode: "event",
    detectionEnabled: true,
    detectionClasses: ["person", "animal"],
    audioDetectionEnabled: false,
    alertRouting: ["bus", "webhook"],
    zoneEnabled: true,
  });
  assert.deepEqual(patch, {
    recordingMode: "event",
    detectionEnabled: true,
    detectionClasses: ["person", "animal"],
    audioDetectionEnabled: false,
    alertRouting: ["bus", "webhook"],
    zoneEnabled: true,
  });
  assert.deepEqual(Object.keys(patch), WHITELIST);
});

test("buildKnobPatch rejects any knob outside the whitelist", () => {
  assert.throws(
    () => buildKnobPatch({ recordingMode: "event", sensitivity: 5 }),
    (error) => error.message.includes("sensitivity"),
  );
  assert.throws(
    () => buildKnobPatch({ brightness: 50 }),
    (error) => error.message.includes("brightness"),
  );
  // Empty or nullish forms build an empty patch, not an error.
  assert.deepEqual(buildKnobPatch({}), {});
  assert.deepEqual(buildKnobPatch(null), {});
});
