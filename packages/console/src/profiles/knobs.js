// The profiles knob model (PORCH-135).
//
// The profiles knob whitelist is closed by domain law: recordingMode,
// detectionEnabled, detectionClasses, audioDetectionEnabled, alertRouting,
// zoneEnabled. This module is the UI's single field model for those six —
// the Profiles screen renders its controls from KNOB_FIELDS and submits
// values only through buildKnobPatch, which rejects anything outside the
// whitelist. Pure data and functions: no DOM, testable with node --test.

export const KNOB_WHITELIST = [
  "recordingMode",
  "detectionEnabled",
  "detectionClasses",
  "audioDetectionEnabled",
  "alertRouting",
  "zoneEnabled",
];

// Control descriptors: one row per whitelisted knob, in whitelist order.
// The Profiles screen consumes these to render each knob's editor.
export const KNOB_FIELDS = [
  { knob: "recordingMode", label: "Recording mode", kind: "select", options: ["continuous", "event"] },
  { knob: "detectionEnabled", label: "Motion detection", kind: "toggle" },
  { knob: "detectionClasses", label: "Detection classes", kind: "chips", options: ["person", "animal", "vehicle"] },
  { knob: "audioDetectionEnabled", label: "Audio detection", kind: "toggle" },
  { knob: "alertRouting", label: "Alert routing", kind: "chips", options: ["bus", "webhook"] },
  { knob: "zoneEnabled", label: "Zone filtering", kind: "toggle" },
];

// Fallback values when neither a base value nor a camera-scoped override
// exists for a knob (mirrors the knob defaults the config service resolves).
export const KNOB_DEFAULTS = {
  recordingMode: "continuous",
  detectionEnabled: false,
  detectionClasses: ["person"],
  audioDetectionEnabled: false,
  alertRouting: ["webhook"],
  zoneEnabled: true,
};

/** Field descriptor for one knob, or undefined when it is not whitelisted. */
export function knobField(knob) {
  return KNOB_FIELDS.find((field) => field.knob === knob);
}

/**
 * Builds the submit patch for a profile from form values: keeps only
 * whitelisted knobs, rejects anything outside the whitelist. Returns a new
 * object with keys in whitelist order.
 */
export function buildKnobPatch(values) {
  const patch = {};
  for (const knob of KNOB_WHITELIST) {
    if (values && Object.prototype.hasOwnProperty.call(values, knob)) {
      patch[knob] = values[knob];
    }
  }
  for (const key of Object.keys(values ?? {})) {
    if (!KNOB_WHITELIST.includes(key)) {
      throw new Error(`Unknown profile knob "${key}" — the knob whitelist is closed: ${KNOB_WHITELIST.join(", ")}.`);
    }
  }
  return patch;
}
