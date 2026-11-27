// Transcription model tests (PORCH-155): the pure transcripts/model.js —
// the closed method classes of record mirrored (never imported) from
// packages/transcript/src/types.js, the human labels, the record-state chip
// mapping (absence of text is an explicit state, never a missing field),
// and normalizeMethodForm's shape law.
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  METHOD_CLASSES,
  METHOD_LABELS,
  SOURCE_LABELS,
  SOURCE_LAYERS,
  emptyMethodDoc,
  normalizeMethodForm,
  stateChipFor,
} from "../src/transcripts/model.js";

test("the model mirrors the closed transcript-package method classes", () => {
  // packages/transcript/src/types.js METHOD_CLASSES — mirrored, never
  // imported, the same dependency-light law compute/model.js states.
  assert.deepEqual(METHOD_CLASSES, ["whisper-local", "openai-spec", "local-server"]);
});

test("METHOD_LABELS covers every method class of record", () => {
  assert.deepEqual(
    METHOD_CLASSES.map((method) => METHOD_LABELS[method]),
    ["Whisper-class local binary", "OpenAI-spec endpoint", "Local server endpoint"],
  );
});

test("SOURCE_LABELS and SOURCE_LAYERS keep the families and layers plain", () => {
  assert.deepEqual(SOURCE_LABELS, { rolling: "Rolling windows", event: "Events" });
  assert.deepEqual(SOURCE_LAYERS, { camera: "Camera override", "recording-type": "Recording type", global: "Global" });
});

test("emptyMethodDoc is the all-scopes-unset shape", () => {
  assert.deepEqual(emptyMethodDoc(), { global: null, recordingTypes: { rolling: null, event: null }, cameras: {} });
});

test("stateChipFor maps the explicit record states, never silent", () => {
  // text — the ordinary case
  assert.deepEqual(stateChipFor({ state: "text", text: "Someone was at the door." }), { severity: "neutral", label: "Transcript" });

  // no-speech is an explicit state, never a missing text field
  assert.deepEqual(stateChipFor({ state: "no-speech", text: null }), { severity: "neutral", label: "No speech detected" });

  // partial carries the chunk position and the reason verbatim
  assert.deepEqual(
    stateChipFor({ state: "partial", partial: { completedChunks: 2, totalChunks: 4, reason: "the provider stopped answering" } }),
    { severity: "warning", label: "Partial — chunk 2 of 4: the provider stopped answering" },
  );

  // partial without a reason still states the chunk position
  assert.deepEqual(
    stateChipFor({ state: "partial", partial: { completedChunks: 0, totalChunks: 1 } }),
    { severity: "warning", label: "Partial — chunk 0 of 1" },
  );

  // any other state is named, never rendered silent
  assert.equal(stateChipFor({ state: "mystery" }).severity, "muted");
  assert.ok(stateChipFor({ state: "mystery" }).label.includes("mystery"));
  assert.equal(stateChipFor({}).label, "record carries no state");
});

test("normalizeMethodForm shapes drafts into the wire doc", () => {
  // Blank/absent scopes become null, never "".
  assert.deepEqual(normalizeMethodForm({}), { global: null, recordingTypes: { rolling: null, event: null }, cameras: {} });
  assert.deepEqual(
    normalizeMethodForm({ global: "  ", recordingTypes: { rolling: "", event: null }, cameras: {} }),
    { global: null, recordingTypes: { rolling: null, event: null }, cameras: {} },
  );

  // Whitespace around a real value trims; nulls and passthrough survive.
  assert.deepEqual(
    normalizeMethodForm({ global: " openai-spec ", recordingTypes: { rolling: "whisper-local" }, cameras: { cam_1: "local-server " } }),
    { global: "openai-spec", recordingTypes: { rolling: "whisper-local", event: null }, cameras: { cam_1: "local-server" } },
  );

  // A blank camera override is not an override — it drops out of the map
  // (that camera falls through to the recording-type/global layers).
  assert.deepEqual(
    normalizeMethodForm({ cameras: { cam_1: "  ", "  cam_2 ": "openai-spec" } }),
    { global: null, recordingTypes: { rolling: null, event: null }, cameras: { cam_2: "openai-spec" } },
  );

  // Non-string scopes are shaped, not invented.
  assert.deepEqual(
    normalizeMethodForm({ global: 7, cameras: { cam_1: 2 } }),
    { global: null, recordingTypes: { rolling: null, event: null }, cameras: {} },
  );
});
