// contract.test.js — the AudioEvent/audio-frame contract of record (PORCH-153).

import { test } from "node:test";
import assert from "node:assert/strict";

import {
	AUDIO_CLASSES,
	assertAudioChunk,
	assertAudioFrame,
	assertAudioEvent,
} from "../src/types.js";

test("AUDIO_CLASSES is the build decision of record — the PRD 8 candidate set, never a spec constant", () => {
	assert.deepEqual([...AUDIO_CLASSES], ["glass-break", "dog-bark", "smoke-co-alarm", "raised-voice"]);
	assert.ok(Object.isFrozen(AUDIO_CLASSES));
	for (const cls of AUDIO_CLASSES) {
		assert.match(cls, /^[a-z0-9-]+$/, "class labels are safe topic segments");
	}
});

test("assertAudioChunk validates the decoded-audio contract", () => {
	assertAudioChunk({ camera: "cam-1", t: 100, sampleRate: 16000, data: new Float32Array(1600) });
	assert.throws(() => assertAudioChunk({ camera: "", t: 100, sampleRate: 16000, data: new Float32Array(8) }), /camera/);
	assert.throws(() => assertAudioChunk({ camera: "c", t: 0, sampleRate: 16000, data: new Float32Array(8) }), /t/);
	assert.throws(() => assertAudioChunk({ camera: "c", t: 100, sampleRate: -1, data: new Float32Array(8) }), /sampleRate/);
	assert.throws(() => assertAudioChunk({ camera: "c", t: 100, sampleRate: 16000, data: [1, 2, 3] }), /Float32Array/);
	assert.throws(() => assertAudioChunk(null), /object/i);
});

test("assertAudioFrame validates the window contract, including span/sample-count consistency", () => {
	assertAudioFrame({ camera: "c", clipStart: 100, clipEnd: 101, sampleRate: 16000, data: new Float32Array(16000) });
	// A window that claims a longer span than its samples encode is malformed.
	assert.throws(
		() => assertAudioFrame({ camera: "c", clipStart: 100, clipEnd: 101, sampleRate: 16000, data: new Float32Array(6000) }),
		/disagrees/,
	);
	assert.throws(
		() => assertAudioFrame({ camera: "c", clipStart: 100, clipEnd: 101, sampleRate: 16000, data: new Float32Array(40000) }),
		/disagrees/,
	);
	assert.throws(() => assertAudioFrame({ camera: "c", clipStart: 101, clipEnd: 100, sampleRate: 16000, data: new Float32Array(16000) }), /clipEnd > clipStart/);
	assert.throws(() => assertAudioFrame({ camera: "c", clipStart: 100, clipEnd: 101, sampleRate: 0, data: new Float32Array(16000) }), /sampleRate/);
});

test("assertAudioEvent validates the bus contract {camera, timestamp, class, confidence, clipStart, clipEnd}", () => {
	const event = { camera: "c", timestamp: 101, class: "dog-bark", confidence: 0.9, clipStart: 100, clipEnd: 101, provider: "onnx-audio" };
	assertAudioEvent(event);
	assert.throws(() => assertAudioEvent({ ...event, confidence: 1.2 }), /confidence/);
	assert.throws(() => assertAudioEvent({ ...event, class: "" }), /class/);
	assert.throws(() => assertAudioEvent({ ...event, clipStart: 102 }), /clipEnd.*clipStart/);
	assert.throws(() => assertAudioEvent({ ...event, timestamp: "now" }), /timestamp/);
	assertAudioEvent({ camera: "c", timestamp: 101, class: "x", confidence: 0, clipStart: 100, clipEnd: 101 }); // provider optional
});
