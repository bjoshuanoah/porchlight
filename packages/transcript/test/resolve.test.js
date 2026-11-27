// resolve.test.js — method scopes and precedence (PORCH-155 ac-4 scope law).
// The directive pins the precedence verbatim: camera override → recording
// type → global [Assumed, confirm at build]; the resolver returns BOTH the
// effective method and its source layer.

import test from "node:test";
import assert from "node:assert/strict";
import { resolveTranscriptionMethod, validateMethodDoc, BUILTIN_METHOD } from "../src/resolve.js";
import { METHOD_CLASSES, ValidationError } from "../src/types.js";

const EMPTY = validateMethodDoc(null);

test("an empty doc resolves to the built-in floor with source layer global", () => {
	assert.deepEqual(resolveTranscriptionMethod(EMPTY, "cam-front", "rolling"), {
		method: BUILTIN_METHOD,
		source: "global",
	});
});

test("camera override wins over recording type, which wins over global", () => {
	const doc = validateMethodDoc({
		global: "openai-spec",
		recordingTypes: { rolling: "local-server", event: null },
		cameras: { "cam-front": "whisper-local" },
	});
	assert.deepEqual(resolveTranscriptionMethod(doc, "cam-front", "rolling"), { method: "whisper-local", source: "camera" });
	// Override applies ONLY to its camera — the neighbor resolves by type.
	assert.deepEqual(resolveTranscriptionMethod(doc, "cam-side", "rolling"), { method: "local-server", source: "recording-type" });
	assert.deepEqual(resolveTranscriptionMethod(doc, "cam-side", "event"), { method: "openai-spec", source: "global" });
});

test("recording-type wins over global per family", () => {
	const doc = validateMethodDoc({ global: "openai-spec", recordingTypes: { rolling: "local-server" } });
	assert.deepEqual(resolveTranscriptionMethod(doc, "cam", "rolling"), { method: "local-server", source: "recording-type" });
	assert.deepEqual(resolveTranscriptionMethod(doc, "cam", "event"), { method: "openai-spec", source: "global" });
});

test("partial docs compose: unset scopes fall through to lower layers", () => {
	const doc = validateMethodDoc({ cameras: { cam: "local-server" } });
	assert.deepEqual(resolveTranscriptionMethod(doc, "cam", "event"), { method: "local-server", source: "camera" });
	assert.deepEqual(resolveTranscriptionMethod(doc, "other", "rolling"), { method: BUILTIN_METHOD, source: "global" });
});

test("the method class set is closed and unknown methods refuse", () => {
	assert.deepEqual([...METHOD_CLASSES], ["whisper-local", "openai-spec", "local-server"]);
	assert.throws(() => validateMethodDoc({ global: "whisper-cloud" }), ValidationError);
	assert.throws(() => validateMethodDoc({ cameras: { cam: 42 } }), ValidationError);
	assert.throws(() => validateMethodDoc("nope"), ValidationError);
});
