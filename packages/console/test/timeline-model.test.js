// Timeline model tests (PORCH-130): the pure playback chain (nextOf across
// hour boundaries and gaps), seek mapping (segmentForAt with inclusive
// start / exclusive end boundaries), event-marker sort + dedupe, and the
// day/hour helpers — no DOM, no network.
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  flattenSegments,
  nextOf,
  segmentForAt,
  offsetInSegment,
  dayDates,
  dayHours,
  nextHour,
  hourStart,
  hourWindow,
  formatClock,
  eventMarkers,
} from "../src/timeline/model.js";

const seg = (ref, start, end, path = `/api/media/cam-1/2026-03-05/10/${ref}`) => ({ ref, start, end, path });

const HOUR_10 = [seg("a", 36000, 36060), seg("b", 36300, 36600)];
const HOUR_11 = [seg("c", 39600, 39660)];
const DAY = [...HOUR_10, ...HOUR_11]; // already sorted, gap between hours

// --- chaining --------------------------------------------------------------

test("nextOf chains across an hour boundary, skipping the gap", () => {
  assert.equal(nextOf(DAY, HOUR_10[0]).ref, "b");
  assert.equal(nextOf(DAY, HOUR_10[1]).ref, "c"); // hour boundary → next hour's clip
  assert.equal(nextOf(DAY, HOUR_11[0]), null); // day's end
});

test("nextOf finds the tail among unsorted input and matches by ref", () => {
  const shuffled = [HOUR_11[0], HOUR_10[0], HOUR_10[1]];
  const next = nextOf(shuffled, { ref: "b", start: HOUR_10[1].start, end: HOUR_10[1].end });
  assert.equal(next.ref, "c");
});

test("nextOf without a current or an empty day yields null", () => {
  assert.equal(nextOf(DAY, null), null);
  assert.equal(nextOf([], HOUR_10[0]), null);
  assert.equal(nextOf([{ ref: "x", start: 1, end: 2 }], { ref: "y", start: 5, end: 6 }), null);
});

// --- seek mapping ----------------------------------------------------------

test("segmentForAt covers the boundaries: start inclusive, end exclusive", () => {
  assert.equal(segmentForAt(DAY, 36000).ref, "a"); // exact start belongs to the clip
  assert.equal(segmentForAt(DAY, 36059).ref, "a");
  assert.equal(segmentForAt(DAY, 36060), null); // a's end opens a gap here — DAY's clips are not contiguous
  assert.equal(segmentForAt(DAY, 36600), null); // a gap second misses — even an exact clip end
  assert.equal(segmentForAt(DAY, 39660), null); // after the last clip
  assert.equal(segmentForAt(DAY, 35999), null); // before the first clip
});

test("segmentForAt hands an exact shared boundary back to the later clip", () => {
  const contiguous = [seg("a", 36000, 36060), seg("d", 36060, 36120)];
  assert.equal(segmentForAt(contiguous, 36060).ref, "d"); // back-to-back clips never double-play
  assert.equal(segmentForAt(contiguous, 36120), null);
});

test("segmentForAt misses in a mid-hour gap", () => {
  assert.equal(segmentForAt(DAY, 36100), null); // between a's end (36060) and b's start (36300)
});

test("segmentForAt ignores malformed input and returns nothing", () => {
  assert.equal(segmentForAt(DAY, Number.NaN), null);
  assert.equal(segmentForAt(undefined, 36000), null);
});

test("offsetInSegment is where the time sits inside its clip", () => {
  assert.equal(offsetInSegment(HOUR_10[1], 36600 - 1), HOUR_10[1].end - 1 - HOUR_10[1].start);
  assert.equal(offsetInSegment(DAY[2], 39600), 0);
});

// --- flattening ------------------------------------------------------------

test("flattenSegments merges per-hour responses into one sorted day", () => {
  const flat = flattenSegments([
    { segments: HOUR_11 },
    { segments: HOUR_10 },
    null, // a skipped hour with no response
    { segments: [{ ref: "bad", start: "no", end: 1 }] }, // malformed row dropped
  ]);
  assert.deepEqual(flat.map((s) => s.ref), ["a", "b", "c"]);
});

// --- events ----------------------------------------------------------------

test("eventMarkers sort by time and drop exact duplicates", () => {
  const events = [
    { t: 36200, cls: "vehicle", source: "detection", camera: "cam-1" },
    { t: 36010, cls: "person", source: "detection", camera: "cam-1" },
    { t: 36200, cls: "vehicle", source: "detection", camera: "cam-1" }, // exact duplicate
    { t: 36200, cls: "voice", source: "audio", camera: "cam-2" }, // same second, different source — kept
  ];
  const markers = eventMarkers(events);
  assert.deepEqual(markers.map((m) => m.t), [36010, 36200, 36200]);
  assert.equal(markers.filter((m) => m.cls === "voice").length, 1);
  assert.equal(markers[0].source, "detection");
});

test("eventMarkers tolerate missing fields and malformed rows", () => {
  const markers = eventMarkers([{ t: 12, cls: "person" }, { nope: true }, null, { t: "no" }]);
  assert.deepEqual(markers, [{ t: 12, cls: "person", source: "detection", camera: null }]);
  assert.deepEqual(eventMarkers(null), []);
});

// --- days and hours ----------------------------------------------------------

test("dayHours sorts hours and drops anything but 00–23", () => {
  assert.deepEqual(dayHours({ hours: ["10", "02", "23", "24", "7", "garbage"] }), ["02", "10", "23"]);
  assert.deepEqual(dayHours(null), []);
});

test("dayDates sorts and filters malformed dates", () => {
  assert.deepEqual(dayDates([{ date: "2026-03-06" }, { date: "nope" }, { date: "2026-03-05" }, null, {}]), ["2026-03-05", "2026-03-06"]);
});

test("nextHour walks a day's chips and reports its end", () => {
  assert.equal(nextHour(["10", "11", "14"], "10"), "11");
  assert.equal(nextHour(["10", "11"], "11"), null);
  assert.equal(nextHour([], "10"), null);
});

test("hourStart and hourWindow are UTC epoch seconds", () => {
  assert.equal(hourStart("2026-03-05", "10"), Date.UTC(2026, 2, 5, 10) / 1000);
  assert.deepEqual(hourWindow("2026-03-05", "10"), { start: Date.UTC(2026, 2, 5, 10) / 1000, end: Date.UTC(2026, 2, 5, 11) / 1000 });
  assert.equal(hourStart("nope", "10"), null);
  assert.equal(hourStart("2026-03-05", "99"), null);
  assert.equal(hourWindow("nope", "10"), null);
});

test("formatClock renders UTC HH:MM:SS", () => {
  assert.equal(formatClock(Date.UTC(2026, 2, 5, 10, 1, 9) / 1000), "10:01:09");
  assert.equal(formatClock(36000), "10:00:00");
  assert.equal(formatClock("x"), "");
  assert.equal(formatClock(-1), "");
});
