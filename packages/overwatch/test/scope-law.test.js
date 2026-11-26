// scope-law.test.js — PORCH-142: the trained tracked-vocabulary extension.
// The static constants stay the base of record; a trained tracked-scope
// class passes the law, a non-tracked label never does, and extension has
// replace semantics (the fresh full list, on every change).

import { test } from "node:test";
import assert from "node:assert/strict";

import { TRACKED_CLASSES } from "../src/scope.js";
import {
	extendTrackedVocabulary,
	filterTracked,
	isFollowableClass,
	isTrackedClass,
	resetTrackedVocabulary,
} from "../src/scope-law.js";

test("a built-in class passes the law with an untouched extension", () => {
	resetTrackedVocabulary();
	assert.equal(isTrackedClass("person"), true);
	assert.equal(filterTracked({ cls: "vehicle" }), true);
	// A trained label the hub never surfaced cannot ride the law.
	assert.equal(isTrackedClass("blue sedan"), false);
});

test("a trained tracked-scope label passes the law through the extension (PORCH-142)", () => {
	resetTrackedVocabulary();
	extendTrackedVocabulary(["Blue Sedan", "Curbside bin"]);
	assert.equal(isTrackedClass("Blue Sedan"), true);
	assert.equal(filterTracked({ cls: "Curbside bin" }), true);
	// The base of record is untouched by training.
	assert.deepEqual(TRACKED_CLASSES.includes("Blue Sedan"), false);
});

test("a non-tracked trained label never passes — the extension only carries what the hub extended", () => {
	resetTrackedVocabulary();
	extendTrackedVocabulary(["Blue Sedan"]);
	assert.equal(isTrackedClass("Marmot"), false);
	assert.equal(filterTracked({ cls: "Marmot" }), false);
	// Followability stays static: a trained label is never followable.
	assert.equal(isFollowableClass("Blue Sedan"), false);
});

test("extend has replace semantics — the fresh list wholesale, junk entries refused", () => {
	resetTrackedVocabulary();
	extendTrackedVocabulary(["Blue Sedan", "Curbside bin"]);
	assert.equal(isTrackedClass("Curbside bin"), true);
	// A delete rewrites the extension with the survivors only.
	extendTrackedVocabulary(["Blue Sedan"]);
	assert.equal(isTrackedClass("Curbside bin"), false);
	// Junk shapes never poison the set.
	extendTrackedVocabulary(["Blue Sedan", "", null, 7, "  "]);
	assert.equal(isTrackedClass("Blue Sedan"), true);
	assert.equal(isTrackedClass(""), false);
	assert.equal(isTrackedClass(null), false);
	// A non-array payload clears (the empty vocabulary is a legal fact).
	extendTrackedVocabulary(undefined);
	assert.equal(isTrackedClass("Blue Sedan"), false);
	resetTrackedVocabulary();
});
