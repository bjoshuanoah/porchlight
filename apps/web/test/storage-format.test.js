import { test } from "node:test";
import assert from "node:assert/strict";
import { formatStorage, formatStorageMb, ceilingMbToGb, ceilingGbToMb } from "../src/storage-format.js";

// PORCH-056: the owner console reads every capacity figure in human units.
// The wire keeps bytes and MB; this module is the display face. GB ↔ TB
// scaling switches at the conventional threshold with at most one decimal.

test("byte figures render in GB, never raw bytes or KB", () => {
  assert.equal(formatStorage(1024 ** 3), "1 GB");
  assert.equal(formatStorage(2.5 * 1024 ** 3), "2.5 GB");
  assert.equal(formatStorage(0), "0 GB");
  assert.equal(formatStorage(600 * 1024 ** 2), "0.6 GB");
});

test("figures cross into TB at the conventional 1024 GB threshold", () => {
  assert.equal(formatStorage(1024 ** 4), "1 TB");
  assert.equal(formatStorage(3.75 * 1024 ** 4), "3.8 TB");
});

test("no rounding surprise at the GB/TB boundary", () => {
  // A byte below one terabyte rounds into TB rather than reading "1024 GB".
  assert.equal(formatStorage(1024 ** 4 - 1), "1 TB");
  // Just below stays GB — nothing jumps to TB before 1024 GB.
  assert.equal(formatStorage(1023.94 * 1024 ** 3), "1023.9 GB");
});

test("at most one decimal place, exact values carry none", () => {
  assert.equal(formatStorage(1.234 * 1024 ** 3), "1.2 GB");
  assert.equal(formatStorage(4 * 1024 ** 4 + 500 * 1024 ** 3), "4.5 TB");
});

test("malformed byte figures never render", () => {
  assert.equal(formatStorage(undefined), null);
  assert.equal(formatStorage(null), null);
  assert.equal(formatStorage(-100), null);
  assert.equal(formatStorage(Number.NaN), null);
  assert.equal(formatStorage(Number.POSITIVE_INFINITY), null);
});

test("the storage ceiling reads in GB/TB while the wire stays MB", () => {
  assert.equal(formatStorageMb(1024), "1 GB");
  assert.equal(formatStorageMb(1536), "1.5 GB");
  assert.equal(formatStorageMb(2048 * 1024), "2 TB");
  assert.equal(formatStorageMb(null), null);
  assert.equal(formatStorageMb(''), null);
});

test("the ceiling form converts MB wire values to a GB draft and back", () => {
  assert.equal(ceilingMbToGb(1536), "1.5");
  assert.equal(ceilingMbToGb(null), '');
  assert.equal(ceilingMbToGb(''), '');
  assert.equal(ceilingGbToMb("1.5"), 1536);
  assert.equal(ceilingGbToMb(''), null);
  // Round trip is stable: a saved GB figure re-displays as the same GB.
  assert.equal(ceilingMbToGb(ceilingGbToMb("2")), "2");
});