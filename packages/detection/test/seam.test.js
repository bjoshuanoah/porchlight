// seam.test.js — the ac-5 engine↔overwatch seam contract (PORCH-152).
//
// Pins what the two sides of the bus seam agree on WITHOUT importing the
// consumer: (a) the publish topic family is matched against the recorder's
// DETECTIONS_PATTERN (the one mirrored-by-import transport contract — the
// recorder is the bus consumer of record), (b) the payload contract is the
// mirrored minimal shape check of packages/overwatch/src/types.js
// assertDetectedObject, and (c) the engine camera id of record satisfies the
// recorder's CAMERA_NAME_RE. Mirrors carry comments pointing at their
// originals; keep both sides in sync.

import { test } from "node:test";
import assert from "node:assert/strict";

import { DETECTIONS_PATTERN } from "@porchlight/recorder";

import { assertDetectedObject } from "../src/types.js";
import { MqttDetectionSink } from "../src/sink.mqtt.js";

/** MQTT wildcard semantics of record: `+` matches exactly one level. */
/** @param {string} pattern @param {string} topic */
function matchesPattern(pattern, topic) {
	const patternLevels = pattern.split("/");
	const topicLevels = topic.split("/");
	return patternLevels.length === topicLevels.length && patternLevels.every((level, i) => level === "+" || level === topicLevels[i]);
}

/** MIRROR of packages/recorder/src/config.js CAMERA_NAME_RE (/^[A-Za-z0-9][A-Za-z0-9._-]*$/) —
 * keep in sync: letters/digits first, then letters/digits/dots/underscores/dashes, i.e. a safe
 * path component everywhere the id lands (topic level, filesystem, config key). */
const CAMERA_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** MIRROR of packages/config/src/types.js ID_RE (/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/) — keep in sync. */
const CONFIG_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/**
 * MIRROR of packages/overwatch/src/types.js assertDetectedObject — the
 * consumer acceptance of record for the bus payload. Duplicated (never
 * imported) per the seam law; keep in sync.
 * @param {unknown} maybe
 */
function overwatchAccepts(maybe) {
	if (typeof maybe !== "object" || maybe === null) {
		throw new TypeError("DetectedObject must be an object");
	}
	const o = /** @type {Record<string, unknown>} */ (maybe);
	for (const key of ["camera", "trackId", "cls"]) {
		if (typeof o[key] !== "string" || o[key].length === 0) {
			throw new TypeError(`DetectedObject.${key} must be a non-empty string`);
		}
	}
	if (typeof o.t !== "number" || !Number.isFinite(o.t)) {
		throw new TypeError("DetectedObject.t must be a finite epoch-seconds number");
	}
	if (typeof o.conf !== "number" || o.conf < 0 || o.conf > 1) {
		throw new TypeError("DetectedObject.conf must be in [0,1]");
	}
	if (!Array.isArray(o.bbox) || o.bbox.length !== 4 || o.bbox.some((c) => typeof c !== "number")) {
		throw new TypeError("DetectedObject.bbox must be [x, y, w, h] numbers");
	}
	const [x, y, w, h] = o.bbox;
	if (x < 0 || y < 0 || w < 0 || h < 0 || x + w > 1 + 1e-9 || y + h > 1 + 1e-9) {
		throw new TypeError("DetectedObject.bbox must be normalized within [0,1]");
	}
	if (o.reid !== undefined && !Array.isArray(o.reid)) {
		throw new TypeError("DetectedObject.reid, when present, must be a number[]");
	}
}

/** The known-good object of record riding the seam. */
const objectOfRecord = { camera: "cam-front", trackId: "t-17", cls: "person", conf: 0.92, bbox: [0.1, 0.2, 0.3, 0.4], t: 17200.5, provider: "coreml", reid: [1, 0, 2] };

test("ac-5: the sink's default topic family matches DETECTIONS_PATTERN (+/+)", async () => {
	assert.equal(DETECTIONS_PATTERN, "porchlight/engine/detections/+/+");
	const prefix = DETECTIONS_PATTERN.split("/").slice(0, 3).join("/");
	assert.equal(prefix, "porchlight/engine/detections");

	// The real sink build path (default topicPrefix, injected client).
	/** @type {string[]} */
	const writes = [];
	const fake = {
		connected: true,
		/** @param {string} topic @param {string} _payload @param {unknown} _o */
		publish(topic, _payload, _o) {
			writes.push(topic);
		},
	};
	const sink = new MqttDetectionSink({ url: "mqtt://127.0.0.1:1", client: fake });
	await sink.start();
	await sink.publish(objectOfRecord);

	const topic = writes[0];
	const levels = topic.split("/");
	assert.equal(levels.length, DETECTIONS_PATTERN.split("/").length, "one topic level per pattern level");
	assert.ok(matchesPattern(DETECTIONS_PATTERN, topic), `${topic} must match ${DETECTIONS_PATTERN}`);
	assert.equal(levels.slice(0, 3).join("/"), prefix, "the topic rides the prefix of record");
	// Last two levels are camera/cls — the recorder's cameraFromTopic reads
	// parts[3], so the camera must sit exactly there.
	assert.equal(levels[3], objectOfRecord.camera);
	assert.equal(levels[4], objectOfRecord.cls);
	await sink.close();
});

test("ac-5: the payload contract — the same known-good object passes both seam sides", () => {
	assert.doesNotThrow(() => assertDetectedObject(objectOfRecord), "detection (producer) accepts the object of record");
	assert.doesNotThrow(() => overwatchAccepts(objectOfRecord), "overwatch (consumer) accepts the object of record");
	// The mirrored consumer check is the same gate: a shape rejected on the
	// consumer side is rejected here too.
	assert.throws(() => overwatchAccepts({ ...objectOfRecord, trackId: "" }), /trackId/);
	assert.throws(() => assertDetectedObject({ ...objectOfRecord, trackId: "" }), /trackId/);
	assert.throws(() => overwatchAccepts({ ...objectOfRecord, conf: 1.5 }), /conf/);
	assert.throws(() => assertDetectedObject({ ...objectOfRecord, conf: 1.5 }), /conf/);
});

test("ac-5: the engine camera id law — ids satisfy the recorder camera-name rules", () => {
	// The one id of record rides every plane: platform config cameras[].name,
	// console cameras.yaml id, the bus topic level, and the overwatch keys.
	for (const id of ["cam-front", "cam-1a2b3c4d", "front2"]) {
		assert.ok(CAMERA_NAME_RE.test(id), `${id} is a legal recorder camera name`);
		assert.ok(CONFIG_ID_RE.test(id), `${id} is a legal platform config id`);
	}
	for (const bad of ["cam front", "-cam", ".cam", "cam/1", ""]) {
		assert.equal(CAMERA_NAME_RE.test(bad), false, `refuses ${JSON.stringify(bad)} (not a safe path component)`);
		assert.equal(CONFIG_ID_RE.test(bad), false, `refuses ${JSON.stringify(bad)}`);
	}
});
