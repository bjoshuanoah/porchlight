// service-tuning.test.js — PORCH-140 ac-3: the scope law at the entity-layer
// door and the association flag control. Non-tracked classes never become
// tracks; flagged occurrence pairs stay separate (config separatePairs and
// runtime vetoPair) while unflagged co-present pairs still merge; recycled
// track ids keep distinct occurrences with their own signatures.

import { test } from "node:test";
import assert from "node:assert/strict";

import { EntityMergeService } from "../src/service.js";
import { pairKey } from "../src/correlation.js";

/**
 * @param {string} camera
 * @param {string} trackId
 * @param {number} t
 * @param {[number, number, number, number]} bbox
 * @param {string} [cls]
 */
function det(camera, trackId, t, bbox, cls = "person") {
	return { camera, trackId, t, bbox, cls, conf: 0.9 };
}

/** Baseline config: cameras "left" and "right" with overlapping coverage. */
function config(overrides = {}) {
	return /** @type {Record<string, any>} */ ({
		adjacency: [["left", "right"]],
		overlapSide: { "left|right": { left: "right", right: "left" } },
		travelTime: { "left|right": { min: 0, max: 10 } },
		...overrides,
	});
}

/**
 * One person walking out of the left camera's right edge into the right
 * camera's left edge: appearanceless geometry+timing joins the two tracks.
 *
 * @param {EntityMergeService} service
 * @param {string} leftTrack
 * @param {string} rightTrack
 * @param {number} [startT]
 */
function walk(service, leftTrack, rightTrack, startT = 10) {
	service.add(det("left", leftTrack, startT, [0.7, 0.3, 0.1, 0.4]));
	service.add(det("left", leftTrack, startT + 0.2, [0.75, 0.3, 0.1, 0.4]));
	service.add(det("left", leftTrack, startT + 0.4, [0.82, 0.3, 0.1, 0.4]));
	service.add(det("right", rightTrack, startT + 1.4, [0.05, 0.35, 0.1, 0.4]));
	service.add(det("right", rightTrack, startT + 1.6, [0.09, 0.35, 0.1, 0.4]));
}

/** @param {string} exitCamera @param {string} exitTrack @param {string} entryCamera @param {string} entryTrack */
function sig(exitCamera, exitTrack, entryCamera, entryTrack) {
	return pairKey(`${exitCamera}:${exitTrack}`, `${entryCamera}:${entryTrack}`);
}

test("a non-tracked class never becomes a track, a sighting, or an entity", () => {
	const service = new EntityMergeService(config());
	service.add(det("left", "bd1", 10.0, [0.5, 0.3, 0.1, 0.4], "bird"));
	service.add(det("left", "bd1", 10.2, [0.52, 0.3, 0.1, 0.4], "bird"));
	// A tracked person whose track is briefly mislabeled mid-stream: the
	// mislabeled sample is dropped, the person's track continues unharmed.
	service.add(det("left", "pk1", 20.0, [0.3, 0.3, 0.1, 0.4], "package"));
	service.add(det("left", "pk1", 20.1, [0.32, 0.3, 0.1, 0.4], "bicycle"));
	service.add(det("left", "pk1", 20.2, [0.34, 0.3, 0.1, 0.4]));
	const { entities, joins } = service.finalize();

	assert.equal(joins.length, 0);
	assert.equal(entities.length, 1);
	const [entity] = entities;
	assert.equal(entity.cls, "package");
	assert.equal(entity.sightings.length, 1);
	assert.equal(entity.sightings[0].sampleCount, 2, "the bicycle-labeled sample never entered the entity layer");
});

test("an appearanceless co-present pair merges unflagged; the flagged pair stays separate", () => {
	const unflagged = new EntityMergeService(config());
	walk(unflagged, "p1", "r7");
	const merged = unflagged.finalize();
	assert.equal(merged.entities.length, 1, "control: the ambiguous pair unifies without a flag");
	assert.equal(merged.joins.length, 1);
	assert.deepEqual(
		merged.entities[0].sightings.map((s) => s.trackId).sort(),
		["p1", "r7"],
	);

	const flagged = new EntityMergeService(config({ separatePairs: [sig("left", "p1", "right", "r7")] }));
	walk(flagged, "p1", "r7");
	const split = flagged.finalize();
	assert.equal(split.entities.length, 2, "the flagged pair never unifies");
	assert.equal(split.joins.length, 0, "a vetoed join records no evidence");
	assert.deepEqual(
		split.entities.map((entity) => entity.sightings.map((s) => `${s.camera}:${s.trackId}`).sort().join("+")).sort(),
		["left:p1", "right:r7"],
	);
});

test("vetoPair at runtime prevents unification in both directions", () => {
	const service = new EntityMergeService(config());
	service.add(det("left", "p1", 10.0, [0.7, 0.3, 0.1, 0.4]));
	service.add(det("left", "p1", 10.2, [0.75, 0.3, 0.1, 0.4]));
	service.add(det("left", "p1", 10.4, [0.82, 0.3, 0.1, 0.4]));
	// Veto handed in inverted role order (entry first): still hits, because
	// the signature is the sorted pairKey of the two camera:trackId names.
	service.vetoPair(sig("right", "r7", "left", "p1"));
	service.add(det("right", "r7", 11.4, [0.05, 0.35, 0.1, 0.4]));
	service.add(det("right", "r7", 11.6, [0.09, 0.35, 0.1, 0.4]));
	const { entities, joins } = service.finalize();
	assert.equal(entities.length, 2);
	assert.equal(joins.length, 0);
});

test("a veto holds for its own pair only: an unflagged parallel pair still merges", () => {
	const service = new EntityMergeService(config({ separatePairs: [sig("left", "p1", "right", "r7")] }));
	walk(service, "p1", "r7", 10);
	// Second walk far past the travel prior so the first pair's leftover
	// open tracks cannot reach it; only the flag separates the first pair.
	walk(service, "p3", "r9", 40);
	const { entities, joins } = service.finalize();

	// p1 and r7 each go solo; p3+r9 merge normally.
	assert.equal(entities.length, 3);
	assert.equal(joins.length, 1);
	const merged = entities.find((entity) => entity.sightings.length === 2);
	assert.deepEqual(
		merged.sightings.map((s) => s.trackId).sort(),
		["p3", "r9"],
	);
});

test("a recycled trackId stays a distinct occurrence with its own sequence", () => {
	const service = new EntityMergeService(config({ trackIdleSec: 5 }));
	service.add(det("left", "t0", 10.0, [0.5, 0.3, 0.1, 0.4]));
	service.add(det("left", "t0", 10.2, [0.52, 0.3, 0.1, 0.4]));
	// The detector reuses id "t0" after the idle gap: a new occurrence.
	service.add(det("left", "t0", 30.0, [0.2, 0.3, 0.1, 0.4]));
	const { entities } = service.finalize();

	assert.equal(entities.length, 2, "recycled occurrences stay separate entities");
	assert.deepEqual(entities.map((e) => e.sightings.length), [1, 1]);
	const seqs = entities
		.map((entity) => entity.sightings[0].seq)
		.sort((a, b) => a - b);
	assert.notEqual(seqs[0], seqs[1], "each occurrence carries its own sequence");
	assert.ok(entities.every((entity) => entity.sightings[0].camera === "left" && entity.sightings[0].trackId === "t0"));
});
