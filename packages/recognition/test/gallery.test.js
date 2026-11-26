// gallery.test.js — PORCH-141 ac-2: the uncertainty law. A low-confidence
// match renders "looks like" with the confidence shown, never silently
// asserted; an uncalibrated system NEVER asserts; unknown stays unknown.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
	DEFAULT_LOOKS_LIKE_FLOOR,
	UNCALIBRATED_ASSERT_THRESHOLD,
	bestMatch,
	cosine,
	decide,
} from "../src/gallery.js";

test("cosine: identical vectors are 1, orthogonal are 0", () => {
	assert.equal(cosine([1, 0, 0], [1, 0, 0]), 1);
	assert.equal(cosine([1, 0], [0, 1]), 0);
	assert.ok(Math.abs(cosine([1, 1], [1, 0]) - Math.SQRT1_2) < 1e-12);
});

test("cosine: zero-magnitude vectors never divide by zero", () => {
	assert.equal(cosine([0, 0], [1, 2]), 0);
});

test("ac-2 Uncalibrated (the default of record): matches render looks-like, never asserted", () => {
	const strong = decide(0.999, { assertThreshold: UNCALIBRATED_ASSERT_THRESHOLD });
	assert.equal(strong.decision, "looks-like");
	// Never silently asserted — the confidence still shows.
	assert.ok(strong.confidence > 0.99);
});

test("ac-2 below the recognizability floor the sighting stays unannotated (unknown)", () => {
	const weak = decide(0.3, { assertThreshold: UNCALIBRATED_ASSERT_THRESHOLD });
	assert.equal(weak.decision, "unknown");
	const belowFloor = decide(0.59, {});
	assert.equal(belowFloor.decision, "unknown");
	const atFloor = decide(DEFAULT_LOOKS_LIKE_FLOOR, {});
	assert.equal(atFloor.decision, "looks-like");
});

test("ac-2 calibrated: above threshold asserts, below threshold renders looks-like", () => {
	const assertThreshold = 0.9;
	assert.equal(decide(0.95, { assertThreshold }).decision, "asserted");
	const below = decide(0.75, { assertThreshold });
	assert.equal(below.decision, "looks-like");
	assert.ok(below.confidence > 0);
	assert.ok(below.confidence < 1);
});

test("decision confidence maps cosine [-1,1] into [0,1]", () => {
	assert.equal(decide(-1, {}).confidence, 0);
	assert.equal(decide(1, {}).confidence, 1);
});

test("bestMatch returns the nearest gallery row", () => {
	const winner = bestMatch([1, 0], [
		{ entryId: "a", descriptor: [0.7, 0.7] },
		{ entryId: "b", descriptor: [1, 0.001] },
	]);
	assert.equal(winner.entryId, "b");
});

test("ac-2 the end-to-end law holds on a realistic gallery: near-neighbor renders looks-like, never the name asserted", () => {
	const gallery = [
		{ entryId: "fce_mom", descriptor: [1, 0] },
		{ entryId: "fce_stranger", descriptor: [0, 1] },
	];
	const near = bestMatch([0.97, 0.24], gallery);
	assert.equal(near.entryId, "fce_mom");
	// cosine ~0.97 → above the floor, below any reasonable assert threshold:
	const nearDecision = decide(near.similarity, { assertThreshold: 0.99 });
	assert.equal(nearDecision.decision, "looks-like");
});
