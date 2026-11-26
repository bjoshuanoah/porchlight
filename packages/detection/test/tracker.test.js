// tracker.test.js — ByteTrack-style FSM tracker behavior (PORCH-128).

import { test } from "node:test";
import assert from "node:assert/strict";

import { DetectionTracker, iou } from "../src/tracker.js";

/** @param {number} x @param {number} y @param {number} w @param {number} h @returns {[number, number, number, number]} */
const box = (x, y, w, h) => [x, y, w, h];
/** @param {string} cls @param {number} conf @param {[number, number, number, number]} bbox @param {number} [t] */
const det = (cls, conf, bbox, t = 0) => ({ cls, conf, bbox, ...(t ? { t } : {}) });

test("iou: identical boxes are 1, disjoint are 0, overlap is fractional", () => {
	assert.equal(iou(box(0, 0, 0.5, 0.5), box(0, 0, 0.5, 0.5)), 1);
	assert.equal(iou(box(0, 0, 0.1, 0.1), box(0.9, 0.9, 0.1, 0.1)), 0);
	const s = iou(box(0, 0, 0.5, 0.5), box(0.25, 0, 0.5, 0.5));
	assert.equal(s.toFixed(4), "0.3333");
});

test("a track publishes only after minHits confirmation frames", () => {
	const tracker = new DetectionTracker({ minHits: 3, nextId: () => `t-${tracker.tracks.length + 1}` });
	assert.deepEqual(tracker.update([det("person", 0.9, box(0, 0, 0.2, 0.2))], 1), []);
	assert.deepEqual(tracker.update([det("person", 0.9, box(0, 0, 0.2, 0.2))], 1.1), []);
	const third = tracker.update([det("person", 0.9, box(0, 0, 0.2, 0.2))], 1.2);
	assert.equal(third.length, 1);
	assert.equal(third[0].trackId, "t-1");
	assert.equal(third[0].cls, "person");
});

test("track ids stay stable across matched frames", () => {
	const tracker = new DetectionTracker();
	for (const i of [0, 1, 2]) tracker.update([det("person", 0.9, box(0, 0, 0.2, 0.2))], i * 0.1);
	const a = tracker.update([det("person", 0.9, box(0.01, 0, 0.2, 0.2))], 0.4);
	const b = tracker.update([det("person", 0.9, box(0.02, 0, 0.2, 0.2))], 0.5);
	assert.equal(a[0].trackId, b[0].trackId);
});

test("velocity prediction bridges a missed frame; lost tracks re-confirm", () => {
	const maxAgeSec = 2;
	const tracker = new DetectionTracker({ maxAgeSec });
	// Object moving right at 0.1 units/sec, confirmed.
	tracker.update([det("person", 0.9, box(0.0, 0.4, 0.2, 0.2))], 1.0);
	tracker.update([det("person", 0.9, box(0.1, 0.4, 0.2, 0.2))], 2.0);
	const confirmed = tracker.update([det("person", 0.9, box(0.2, 0.4, 0.2, 0.2))], 3.0);
	assert.equal(confirmed.length, 1);
	const id = confirmed[0].trackId;
	// Missed frame: prediction carries the track; no emission while lost.
	assert.deepEqual(tracker.update([], 3.4), []);
	// Reappears at predicted spot: same id, re-confirmed.
	const back = tracker.update([det("person", 0.9, box(0.23, 0.4, 0.2, 0.2))], 3.5);
	assert.equal(back.length, 1);
	assert.equal(back[0].trackId, id);
	assert.equal(tracker.tracks[0].state, "confirmed");
});

test("low-confidence detections join existing tracks but never open new ones", () => {
	const tracker = new DetectionTracker();
	for (const i of [0, 1, 2]) tracker.update([det("person", 0.9, box(0, 0, 0.2, 0.2))], i * 0.1);
	const before = tracker.tracks.length;
	const out = tracker.update([det("person", 0.3, box(0.01, 0, 0.2, 0.2))], 0.4);
	assert.equal(tracker.tracks.length, before, "no new track from a low-conf detection");
	assert.equal(out.length, 1, "low-conf match still emits against the confirmed track");
	assert.deepEqual(tracker.update([det("person", 0.3, box(0.9, 0.9, 0.1, 0.1))], 0.5), []);
});

test("tracks age out past maxAgeSec", () => {
	const maxAgeSec = 0.5;
	const tracker = new DetectionTracker({ maxAgeSec });
	tracker.update([det("person", 0.9, box(0, 0, 0.2, 0.2))], 1.0);
	tracker.update([det("person", 0.9, box(0, 0, 0.2, 0.2))], 1.1);
	tracker.update([det("person", 0.9, box(0, 0, 0.2, 0.2))], 1.2);
	assert.equal(tracker.tracks.length, 1);
	tracker.update([], 1.4);
	assert.equal(tracker.tracks.length, 1);
	tracker.update([], 1.8);
	assert.deepEqual(tracker.tracks, [], "expired track is deleted");
});

test("two concurrent objects track separately", () => {
	const tracker = new DetectionTracker();
	const l = det("person", 0.9, box(0.1, 0.4, 0.15, 0.15));
	const r = det("dog", 0.88, box(0.7, 0.4, 0.15, 0.15));
	for (const i of [0, 1, 2]) tracker.update([/** @type {any} */ ({ ...l }), /** @type {any} */ ({ ...r })], i * 0.1);
	const out = tracker.update([/** @type {any} */ ({ ...l, bbox: box(0.11, 0.4, 0.15, 0.15) }), /** @type {any} */ ({ ...r, bbox: box(0.71, 0.4, 0.15, 0.15) })], 0.4);
	assert.equal(out.length, 2);
	const ids = out.map((o) => o.trackId);
	assert.notEqual(ids[0], ids[1]);
	assert.deepEqual(out.map((o) => o.cls).sort(), ["dog", "person"]);
});
