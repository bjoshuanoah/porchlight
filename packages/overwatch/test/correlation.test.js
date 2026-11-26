// correlation.test.js — PORCH-126 spike acceptance behavior on synthetic
// DetectedObject streams: one walk across two overlapping-coverage cameras
// merges into ONE entity with the correct zone handoff; overlapping visitors,
// weak-evidence gaps, and appearance dissimilarity keep sightings separate.

import { test } from "node:test";
import assert from "node:assert/strict";

import { EntityMergeService } from "../src/service.js";
import { cosine, correlate, pairKey, travelPrior } from "../src/correlation.js";

/**
 * @param {string} camera
 * @param {string} trackId
 * @param {number} t
 * @param {[number, number, number, number]} bbox
 * @param {number[]|undefined} [reid]
 * @param {number} [conf]
 * @param {string} [cls]
 */
function det(camera, trackId, t, bbox, reid, conf = 0.9, cls = "person") {
	return /** @type {import("../src/types.js").DetectedObject} */ ({
		camera,
		trackId,
		t,
		bbox,
		cls,
		conf,
		reid,
	});
}

/** Baseline config: cameras "left" and "right" with overlapping coverage. */
function config(overrides = {}) {
	return /** @type {import("../src/types.js").CorrelationConfig} */ ({
		adjacency: [["left", "right"]],
		overlapSide: { "left|right": { left: "right", right: "left" } },
		travelTime: { "left|right": { min: 0, max: 10 } },
		...overrides,
	});
}

test("one person walking left camera into right camera merges into ONE entity with a zone handoff", () => {
	const service = new EntityMergeService(config());
	// Walks leftward on the left camera, exits on its right edge at t=10.4.
	service.add(det("left", "p1", 10.0, [0.7, 0.3, 0.1, 0.4]));
	service.add(det("left", "p1", 10.2, [0.75, 0.3, 0.1, 0.4]));
	service.add(det("left", "p1", 10.4, [0.82, 0.3, 0.1, 0.4]));
	// Appears on the right camera at its left edge 1s later.
	service.add(det("right", "r7", 11.4, [0.05, 0.35, 0.1, 0.4]));
	service.add(det("right", "r7", 11.6, [0.09, 0.35, 0.1, 0.4]));
	const { entities, joins } = service.finalize();

	assert.equal(entities.length, 1);
	assert.equal(entities[0].sightings.length, 2);
	assert.deepEqual(
		entities[0].sightings.map((s) => s.camera),
		["left", "right"],
	);
	const handoff = entities[0].sightings[1].handoff;
	assert.ok(handoff, "cross-camera sighting carries handoff evidence");
	assert.equal(handoff.fromCamera, "left");
	assert.equal(handoff.toCamera, "right");
	assert.ok(handoff.score >= 0.5);
	assert.equal(joins.length, 1);
});

test("overlapping visitors keep separate entities and pair by appearance", () => {
	// Two descriptors: warm coat vs cool backpack.
	const warm = [1, 0.1, 0.2, 0.9, 0.1, 0.3];
	const cool = [0.1, 0.9, 0.3, 0.1, 0.9, 0.2];
	const service = new EntityMergeService(config());
	service.add(det("left", "v1", 20.0, [0.7, 0.3, 0.1, 0.4], warm));
	service.add(det("left", "v2", 20.1, [0.72, 0.32, 0.1, 0.4], cool));
	service.add(det("left", "v1", 20.6, [0.85, 0.3, 0.1, 0.4], warm));
	service.add(det("left", "v2", 20.7, [0.86, 0.32, 0.1, 0.4], cool));
	service.add(det("right", "b1", 21.2, [0.06, 0.35, 0.1, 0.4], cool));
	service.add(det("right", "b2", 21.5, [0.05, 0.35, 0.1, 0.4], warm));
	const { entities } = service.finalize();

	assert.equal(entities.length, 2);
	for (const entity of entities) {
		assert.equal(entity.sightings.length, 2, "each visitor got left+right sightings");
	}
	const coolEntity = entities.find((e) => e.sightings.some((s) => s.trackId === "b1"));
	const warmEntity = entities.find((e) => e.sightings.some((s) => s.trackId === "b2"));
	assert.deepEqual(coolEntity.sightings.map((s) => s.trackId).sort(), ["b1", "v2"]);
	assert.deepEqual(warmEntity.sightings.map((s) => s.trackId).sort(), ["b2", "v1"]);
});

test("weak evidence keeps sightings separate: no merge beyond the travel-time prior", () => {
	const service = new EntityMergeService(config());
	service.add(det("left", "p1", 10.0, [0.5, 0.3, 0.1, 0.4], [0.9, 0.9, 0.1]));
	service.add(det("left", "p1", 10.2, [0.55, 0.3, 0.1, 0.4], [0.9, 0.9, 0.1]));
	// Same-looking person appears 40s later — prior max is 10s + 2s slack.
	service.add(det("right", "r1", 50.0, [0.5, 0.35, 0.1, 0.4], [0.9, 0.9, 0.1]));
	service.add(det("right", "r1", 50.2, [0.52, 0.35, 0.1, 0.4], [0.9, 0.9, 0.1]));
	const { entities, joins } = service.finalize();
	assert.equal(joins.length, 0);
	assert.equal(entities.length, 2);
});

test("appearance veto: dissimilar crops never merge on timing alone", () => {
	const service = new EntityMergeService(config());
	service.add(det("left", "p1", 10.0, [0.85, 0.3, 0.1, 0.4], [1, 0, 0, 0.9, 0.05, 0.05]));
	service.add(det("left", "p1", 10.4, [0.88, 0.3, 0.1, 0.4], [1, 0, 0, 0.9, 0.05, 0.05]));
	// A different person enters right camera inside the prior window.
	service.add(det("right", "r1", 11.0, [0.06, 0.35, 0.1, 0.4], [0.05, 0.9, 0.05, 0, 1, 0]));
	const { entities, joins } = service.finalize();
	assert.equal(joins.length, 0);
	assert.equal(entities.length, 2);
});

test("no reid data on either side: timing + edge geometry alone can merge", () => {
	const service = new EntityMergeService(config({ joinThreshold: 0.5 }));
	service.add(det("left", "p1", 10.0, [0.7, 0.3, 0.1, 0.4]));
	service.add(det("left", "p1", 10.4, [0.88, 0.3, 0.1, 0.4]));
	service.add(det("right", "r7", 11.6, [0.04, 0.35, 0.1, 0.4]));
	const { entities, joins } = service.finalize();
	assert.equal(joins.length, 1);
	assert.equal(entities.length, 1);
});

test("simultaneous overlapping views merge via the exit-side pairing path", () => {
	const service = new EntityMergeService(config({ trackIdleSec: 1.5 }));
	// Both cameras see the person at once; left stream ends mid-walk and the
	// right stream keeps going.
	service.add(det("right", "r4", 11.0, [0.1, 0.35, 0.1, 0.4]));
	service.add(det("left", "p3", 10.0, [0.6, 0.3, 0.1, 0.4]));
	service.add(det("left", "p3", 10.8, [0.8, 0.3, 0.1, 0.4]));
	service.add(det("right", "r4", 11.3, [0.12, 0.35, 0.1, 0.4]));
	service.add(det("right", "r4", 11.6, [0.14, 0.35, 0.1, 0.4]));
	const { entities, joins } = service.finalize();
	assert.equal(joins.length, 1);
	assert.equal(entities.length, 1);
	const cams = entities[0].sightings.map((s) => s.camera);
	assert.deepEqual(cams, ["left", "right"]);
});

test("a recycled per-camera trackId after the idle gap is a separate occurrence", () => {
	const service = new EntityMergeService(config());
	service.add(det("left", "t0", 10.0, [0.5, 0.3, 0.1, 0.4]));
	service.add(det("left", "t0", 10.2, [0.52, 0.3, 0.1, 0.4]));
	// Detector reuses id "t0" for a different person, 20s later.
	service.add(det("left", "t0", 30.0, [0.2, 0.3, 0.1, 0.4]));
	const { entities } = service.finalize();
	assert.equal(entities.length, 2);
	assert.deepEqual(
		entities.map((e) => e.sightings.length),
		[1, 1],
	);
});

test("correlate rejects a candidate entering before the exit beyond simultaneity slack", () => {
	const cfg = config();
	/** @type {import("../src/types.js").CameraTrack} */
	const exit = { camera: "left", trackId: "a", seq: 0, t0: 10, t1: 12, cls: "person", objects: [det("left", "a", 12, [0.9, 0.3, 0.1, 0.4])], reid: undefined, closed: true };
	/** @type {import("../src/types.js").CameraTrack} */
	const entry = { camera: "right", trackId: "b", seq: 1, t0: 5, t1: 6, cls: "person", objects: [det("right", "b", 5, [0.1, 0.35, 0.1, 0.4])], reid: undefined, closed: false };
	const result = correlate(cfg, exit, entry);
	assert.ok(result.rejected);
	assert.equal(result.score, 0);
});

test("travelPrior and pairKey resolve the authored adjacency entry", () => {
	assert.equal(pairKey("b", "a"), "a|b");
	assert.deepEqual(travelPrior(config(), "right", "left"), { min: 0, max: 10 });
	assert.deepEqual(travelPrior(config(), "x", "y"), { min: 0, max: 10 }); // DEFAULT_TRAVEL_TIME
});

test("cosine similarity guards mismatched and empty descriptors", () => {
	assert.equal(cosine(undefined, [1, 2]), 0);
	assert.equal(cosine([1], [1, 2]), 0);
	assert.equal(cosine([1, 0], [1, 0]), 1);
});
