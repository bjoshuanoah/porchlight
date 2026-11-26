// geometry.test.js — percent-frame polygon math (PORCH-135).

import { test } from "node:test";
import assert from "node:assert/strict";

import {
	frameFraction,
	pixelDistance,
	pointInPolygon,
	polygonArea,
	polygonIntersectsPolygon,
	segmentsIntersect,
	toPixels,
	trackPixelPathLength,
} from "../src/geometry.js";

const square = [[10, 10], [40, 10], [40, 40], [10, 40]];
const overlapSquare = [[30, 30], [60, 30], [60, 60], [30, 60]];
const farSquare = [[70, 70], [90, 70], [90, 90], [70, 90]];

test("pointInPolygon resolves interior, exterior, and surrounding-frame points", () => {
	assert.equal(pointInPolygon(20, 20, square), true);
	assert.equal(pointInPolygon(10, 10, square), true); // vertex counts as inside
	assert.equal(pointInPolygon(50, 20, square), false);
	assert.equal(pointInPolygon(35, 35, overlapSquare), true);
	// A big frame-wide polygon contains small square vertices.
	const frameWide = [[0, 0], [100, 0], [100, 100], [0, 100]];
	assert.equal(pointInPolygon(10, 10, frameWide), true);
});

test("segmentsIntersect detects crossings, shared endpoints, and collinear overlap", () => {
	assert.equal(segmentsIntersect([0, 0], [10, 10], [0, 10], [10, 0]), true);
	assert.equal(segmentsIntersect([0, 0], [10, 0], [5, 0], [15, 0]), true); // collinear overlap
	assert.equal(segmentsIntersect([0, 0], [10, 0], [10, 0], [10, 10]), true); // shared endpoint
	assert.equal(segmentsIntersect([0, 0], [10, 0], [0, 5], [10, 5]), false);
});

test("polygonIntersectsPolygon: overlap, containment, shared edge, disjoint", () => {
	assert.equal(polygonIntersectsPolygon(square, overlapSquare), true);
	assert.equal(polygonIntersectsPolygon(square, farSquare), false);
	// Full containment with no edge crossings.
	const inner = [[15, 15], [20, 15], [20, 20], [15, 20]];
	assert.equal(polygonIntersectsPolygon(square, inner), true);
	// Shared edge counts as an overlap (touching definitions compose).
	const touching = [[40, 10], [70, 10], [70, 40], [40, 40]];
	assert.equal(polygonIntersectsPolygon(square, touching), true);
});

test("polygonArea and frameFraction use percent² units", () => {
	assert.equal(polygonArea(square), 900); // 30% × 30%
	assert.equal(frameFraction(square), 0.09); // 9% of the frame
	const frameWide = [[0, 0], [100, 0], [100, 100], [0, 100]];
	assert.equal(polygonArea(frameWide), 10000);
	assert.equal(frameFraction(frameWide), 1);
});

test("percent coords map to identical normalized frame regions at any resolution", () => {
	// TS 11/12 ac: the same percent polygon covers the same fractional frame
	// region at 1920x1080 and 1280x720 — resolution changes can't drag zones.
	const norm = (pt, w, h) => toPixels(pt, w, h).map((v, i) => v / (i === 0 ? w : h));
	for (const pt of square) {
		const at1080 = norm(pt, 1920, 1080);
		const at720 = norm(pt, 1280, 720);
		assert.deepEqual(at720, at1080.map((v) => v)); // both equal pt / 100
		assert.deepEqual(at1080, [pt[0] / 100, pt[1] / 100]);
	}
});

test("pixelDistance scales percent distances by the stream resolution", () => {
	assert.equal(pixelDistance([0, 0], [100, 0], 1920, 1080), 1920); // full width
	assert.equal(pixelDistance([0, 0], [0, 100], 1920, 1080), 1080); // full height
	assert.equal(pixelDistance([0, 0], [0, 50], 1920, 1080), 540);
	// Diagonal 1920x1080.
	assert.equal(pixelDistance([0, 0], [100, 100], 1920, 1080), Math.hypot(1920, 1080));
});

test("trackPixelPathLength sums consecutive pixel segments of a time-sorted track", () => {
	const samples = [
		{ t: 0, px: 0, py: 0 },
		{ t: 1, px: 100, py: 0 }, // +1920 px
		{ t: 2, px: 100, py: 50 }, // +540 px
	];
	assert.equal(trackPixelPathLength(samples, 1920, 1080), 1920 + 540);
});
