// types.test.js — contract assertion coverage (PORCH-128).

import { test } from "node:test";
import assert from "node:assert/strict";

import { assertDetectedObject, assertFrame, assertRawDetection } from "../src/types.js";

test("assertFrame accepts a valid rgb frame", () => {
	const frame = { camera: "cam-1", w: 4, h: 2, t: 1000.5, format: "rgb", data: new Uint8Array(4 * 2 * 3) };
	assert.doesNotThrow(() => assertFrame(frame));
});

test("assertFrame rejects missing fields, bad sizes, bad formats, short payloads", () => {
	const base = { camera: "cam-1", w: 4, h: 2, t: 1000.5, format: "rgb", data: new Uint8Array(24) };
	assert.throws(() => assertFrame({ ...base, camera: "" }), /camera/);
	assert.throws(() => assertFrame({ ...base, w: 0 }), /Frame\.w/);
	assert.throws(() => assertFrame({ ...base, t: Number.NaN }), /Frame\.t/);
	assert.throws(() => assertFrame({ ...base, format: "bgra" }), /format/);
	assert.throws(() => assertFrame({ ...base, data: new Uint8Array(10) }), /Frame\.data/);
	assert.doesNotThrow(() => assertFrame({ ...base, format: "jpeg", data: new Uint8Array(4) }));
});

test("assertRawDetection requires non-empty cls, conf in [0,1], normalized bbox", () => {
	assert.doesNotThrow(() => assertRawDetection({ cls: "person", conf: 0.9, bbox: [0, 0, 0.5, 0.5] }));
	assert.throws(() => assertRawDetection({ cls: "", conf: 0.9, bbox: [0, 0, 0.5, 0.5] }), /cls/);
	assert.throws(() => assertRawDetection({ cls: "person", conf: 1.5, bbox: [0, 0, 0.5, 0.5] }), /conf/);
	assert.throws(() => assertRawDetection({ cls: "person", conf: 0.9, bbox: [0.5, 0, 0.6, 0.5] }), /bbox/);
	assert.throws(() => assertRawDetection({ cls: "person", conf: 0.9, bbox: [-0.1, 0, 0.6, 0.5] }), /bbox/);
});

test("assertDetectedObject requires camera, trackId, cls, finite t, conf, bbox", () => {
	const object = { camera: "cam-1", trackId: "t-1", cls: "person", conf: 0.9, bbox: [0, 0, 1, 1], t: 5 };
	assert.doesNotThrow(() => assertDetectedObject(object));
	assert.throws(() => assertDetectedObject({ ...object, trackId: "" }), /trackId/);
	assert.throws(() => assertDetectedObject({ ...object, t: "x" }), /t/);
	assert.throws(() => assertDetectedObject({ ...object, provider: "" }), /provider/);
	assert.doesNotThrow(() => assertDetectedObject({ ...object, provider: "coreml", reid: [1, 2] }));
	assert.throws(() => assertDetectedObject({ ...object, reid: "no" }), /reid/);
});
