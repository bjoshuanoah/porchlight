// Pure geometry tests (PORCH-135): percent ↔ pixel mapping, polygon
// hit-testing, vertex drag math, and the resolution-invariance proof —
// the same percent polygon covers an identical fraction of the frame at
// any resolution (checked at 1920×1080 vs 1280×720).
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  clampPercent,
  toPercentPoint,
  toPixelPoint,
  polygonToPercent,
  polygonToPixels,
  pointInPolygon,
  nearestVertexIndex,
  dragVertex,
  polygonAreaNormalized,
  polygonAreaPixels,
  convexClipPolygon,
  intersectAreaNormalized,
} from "../src/editor/geometry.js";

const HD = { width: 1920, height: 1080 };
const QHD = { width: 1280, height: 720 };

// Numeric tolerance helper — node:assert has no floating-point comparer.
function assertClose(actual, expected, delta = 1e-9) {
  assert.ok(Math.abs(actual - expected) <= delta, `expected ${actual} ≈ ${expected} within ${delta}`);
}

test("percent ↔ pixel mapping round-trips", () => {
  const percent = toPercentPoint([960, 540], HD);
  assertClose(percent[0], 50);
  assertClose(percent[1], 50);
  const pixel = toPixelPoint(percent, HD);
  assertClose(pixel[0], 960);
  assertClose(pixel[1], 540);
});

test("the same pixel point maps to the same percents at different resolutions", () => {
  // 640/1920 = 1/3 of the width; 1280 × 1/3 lands on the same percent.
  const at1920 = toPercentPoint([640, 360], HD);
  const at1280 = toPercentPoint([1280 / 3, 240], QHD);
  assertClose(at1920[0], at1280[0]);
  assertClose(at1920[1], at1280[1]);
});

test("polygon helpers map every vertex", () => {
  const square = [[0, 0], [1920, 0], [1920, 1080], [0, 1080]];
  const percent = polygonToPercent(square, HD);
  assert.deepEqual(percent, [[0, 0], [100, 0], [100, 100], [0, 100]]);
  const backToPixels = polygonToPixels(percent, HD);
  assert.deepEqual(backToPixels, square);
});

test("clampPercent keeps coordinates inside the frame", () => {
  assert.equal(clampPercent(-5), 0);
  assert.equal(clampPercent(50), 50);
  assert.equal(clampPercent(150), 100);
});

test("hit-testing: inside, outside, and concave polygons", () => {
  const square = [[10, 10], [50, 10], [50, 50], [10, 50]];
  assert.equal(pointInPolygon([30, 30], square), true);
  assert.equal(pointInPolygon([70, 70], square), false);
  assert.equal(pointInPolygon([10, 10], square), true); // vertex counts as inside

  // Concave arrowhead: the notch around (45, 30) is outside the polygon.
  const concave = [[10, 10], [60, 10], [60, 50], [40, 30], [20, 50]];
  assert.equal(pointInPolygon([48, 45], concave), false); // inside the notch
  assert.equal(pointInPolygon([40, 15], concave), true);
});

test("nearestVertexIndex finds the closest vertex", () => {
  const polygon = [[10, 10], [90, 10], [90, 90]];
  assert.equal(nearestVertexIndex([5, 12], polygon), 0);
  assert.equal(nearestVertexIndex([99, 88], polygon), 2);
});

test("vertex drag moves one vertex and clamps to the frame", () => {
  const polygon = [[10, 10], [50, 10], [50, 50]];
  const dragged = dragVertex(polygon, 2, [150, -20]);
  assert.deepEqual(dragged, [[10, 10], [50, 10], [100, 0]]);
  // The input polygon is never mutated.
  assert.deepEqual(polygon, [[10, 10], [50, 10], [50, 50]]);
});

test("resolution proof: a percent polygon covers an identical normalized region at 1920×1080 and 1280×720", () => {
  const porch = [[10, 10], [30, 10], [30, 40], [10, 40]]; // 20% × 30% of the frame
  const normalized = polygonAreaNormalized(porch);
  assertClose(normalized, 600 / 10_000);

  const atHD = polygonAreaPixels(porch, HD);
  const atQHD = polygonAreaPixels(porch, QHD);
  assertClose(atHD / (HD.width * HD.height), normalized);
  assertClose(atQHD / (QHD.width * QHD.height), normalized);
  assertClose(atHD / (HD.width * HD.height), atQHD / (QHD.width * QHD.height));
});

test("resolution proof: the normalized rect intersection area is identical across resolutions", () => {
  // Two overlapping rects drawn in percent coords.
  const zoneA = [[10, 10], [40, 10], [40, 50], [10, 50]];
  const zoneB = [[30, 20], [60, 20], [60, 60], [30, 60]];
  // Their intersection is the 10% × 30% rect over (30..40, 20..50) = 300 %².
  const expected = 300 / 10_000;

  const atHD = intersectAreaNormalized(
    polygonToPercent(polygonToPixels(zoneA, HD), HD),
    polygonToPercent(polygonToPixels(zoneB, HD), HD),
  );
  const atQHD = intersectAreaNormalized(
    polygonToPercent(polygonToPixels(zoneA, QHD), QHD),
    polygonToPercent(polygonToPixels(zoneB, QHD), QHD),
  );
  assertClose(atHD, expected);
  assertClose(atQHD, expected);
  assert.equal(atHD, atQHD);

  // The clipped region itself is that inner rect; vertex order may rotate
  // with the clipping walk, so compare as a vertex set.
  const clipped = convexClipPolygon(zoneA, zoneB);
  assert.deepEqual(
    [...clipped].sort(),
    [[30, 20], [40, 20], [40, 50], [30, 50]].sort(),
  );
});

test("percent polygons stay identical when re-derived from pixels at each resolution", () => {
  // The editor round-trip: pixel clicks → percents — so the percent
  // polygon is resolution-independent by construction.
  const clickedAtHD = polygonToPercent([[192, 108], [768, 108], [768, 540]], HD);
  const clickedAtQHD = polygonToPercent([[128, 72], [512, 72], [512, 360]], QHD);
  assert.deepEqual(clickedAtHD, clickedAtQHD);
});
