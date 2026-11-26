// visits.test.js — PORCH-140 ac-2/ac-5: visit grouping, chronological
// timeline, and outage gap entries. Gaps explain spans with real outage
// records and never fabricate content.

import { test } from "node:test";
import assert from "node:assert/strict";

import { createVisitService, visitIdFor } from "../src/visits.js";

/**
 * @param {string} camera
 * @param {string} trackId
 * @param {number} t0
 * @param {number} t1
 * @param {string} cls
 * @param {number[][]} samples
 */
function sighting(camera, trackId, t0, t1, cls = "person", samples = [[0.1, 0.3, 0.1, 0.4], [0.4, 0.3, 0.1, 0.4]]) {
	return { camera, trackId, t0, t1, sampleCount: samples.length, cls, samples };
}

/** Alice: cam-a then cam-b, moving samples. */
function aliceChain() {
	return {
		entityId: "pe_1",
		cls: "person",
		t0: 10,
		t1: 60,
		sightings: [sighting("cam-a", "a1", 10, 30), sighting("cam-b", "b1", 40, 60)],
	};
}

/** Bob: co-present with Alice on cam-a, then onward to cam-c. */
function bobChain() {
	return {
		entityId: "pe_2",
		cls: "person",
		t0: 20,
		t1: 80,
		sightings: [sighting("cam-a", "a2", 20, 30), sighting("cam-c", "c2", 50, 80)],
	};
}

function carolChain() {
	return { entityId: "pe_3", cls: "person", t0: 100, t1: 120, sightings: [sighting("cam-a", "a3", 100, 120)] };
}

/** Dave: a long unexplained span between his only two sightings. */
function daveChain() {
	return {
		entityId: "pe_4",
		cls: "person",
		t0: 0,
		t1: 130,
		sightings: [sighting("cam-a", "d1", 0, 20), sighting("cam-b", "d2", 110, 130)],
	};
}

/** @param {PropertyEntity} chain */
function clipsFor(chain) {
	return chain.sightings.map((s) => ({
		cameraId: s.camera,
		path: `clips/${chain.entityId}/${s.camera}-${s.trackId}.mp4`,
		from: s.t0,
		to: s.t1,
	}));
}

/** @typedef {import("../src/types.js").PropertyEntity} PropertyEntity */

test("listVisits groups entities with overlapping timelines; ids are stable and window-bound", () => {
	const service = createVisitService({ chainsProvider: () => [carolChain(), bobChain(), aliceChain()] });
	const visits = service.listVisits({ from: 0, to: 200 });

	assert.equal(visits.length, 2);
	const first = visits[0];
	assert.deepEqual(first.entities, ["pe_1", "pe_2"]);
	assert.equal(first.from, 10);
	assert.equal(first.to, 80);
	assert.deepEqual(first.cameras, ["cam-a", "cam-b", "cam-c"]);
	assert.ok(first.visitId.startsWith("visit_"));
	assert.equal(first.visitId.length, 18);

	const again = service.listVisits({ from: 0, to: 200 });
	assert.equal(again[0].visitId, first.visitId, "same entities + window → same visit id");

	const later = service.listVisits({ from: 90, to: 200 });
	assert.equal(later.length, 1);
	assert.deepEqual(later[0].entities, ["pe_3"]);
	assert.notEqual(later[0].visitId, first.visitId, "a different window re-hashes");
});

test("timeline entries are chronological with named cameras, FSM states and clip paths", () => {
	const service = createVisitService({
		chainsProvider: () => [aliceChain()],
		clipsProvider: clipsFor,
	});
	const [visit] = service.listVisits({ from: 0, to: 200 });
	const entries = service.timeline({ visitId: visit.visitId, at: 200 });

	// Alice: first sighting "arrival" (clip padded ±5 and clamped), final
	// sighting stale by now=200 → "departure" (clip = the last sighting).
	assert.deepEqual(entries.map((e) => e.kind), ["clip", "clip"]);
	assert.deepEqual(entries.map((e) => [e.cameraId, e.state]), [["cam-a", "arrival"], ["cam-b", "departure"]]);
	assert.deepEqual(entries.map((e) => e.from), [5, 40]);
	assert.deepEqual(entries.map((e) => e.to), [35, 60]);
	assert.equal(entries[0].path, "clips/pe_1/cam-a-a1.mp4");
	assert.equal(entries[1].path, "clips/pe_1/cam-b-b1.mp4");
});

test("a sighting without a clip degrades to a state entry — no fabricated path", () => {
	const service = createVisitService({ chainsProvider: () => [aliceChain()], clipsProvider: () => [] });
	const [visit] = service.listVisits({ from: 0, to: 200 });
	const entries = service.timeline({ visitId: visit.visitId, at: 200 });
	assert.deepEqual(entries.map((e) => e.kind), ["state", "state"]);
	assert.ok(entries.every((e) => !("path" in e)));
	assert.ok(entries.every((e) => !("reason" in e)));
});

test("an outage-covered unexplained span becomes a gap entry in chronological position", () => {
	const service = createVisitService({
		chainsProvider: () => [daveChain()],
		clipsProvider: clipsFor,
		outagesProvider: () => [{ cameraId: "cam-a", from: 25, to: 95 }],
	});
	const [visit] = service.listVisits({ from: 0, to: 200 });
	const entries = service.timeline({ visitId: visit.visitId, at: 200 });

	assert.deepEqual(entries.map((e) => `${e.kind}:${e.cameraId}`), ["clip:cam-a", "gap:cam-a", "clip:cam-b"]);
	const gap = entries[1];
	assert.equal(gap.from, 25, "trimmed to the outage overlap");
	assert.equal(gap.to, 95);
	assert.equal(gap.reason, "camera-outage");
	assert.ok(!("path" in gap), "gap entries carry no clip content");
	assert.deepEqual(entries.map((e) => e.from), [0, 25, 110]);
});

test("an unexplained span with no recorded outage gets no gap entry — silence is honest", () => {
	const service = createVisitService({
		chainsProvider: () => [daveChain()],
		clipsProvider: clipsFor,
		outagesProvider: () => [],
	});
	const [visit] = service.listVisits({ from: 0, to: 200 });
	const entries = service.timeline({ visitId: visit.visitId, at: 200 });
	assert.deepEqual(entries.map((e) => e.kind), ["clip", "clip"]);
	assert.ok(entries.every((e) => e.kind !== "gap"));
});

test("a handoff-sized span with an overlapping outage stays a movement, not a gap", () => {
	const shortGap = {
		entityId: "pe_6",
		cls: "person",
		t0: 0,
		t1: 60,
		sightings: [sighting("cam-a", "s1", 0, 20), sighting("cam-b", "s2", 40, 60)],
	};
	const service = createVisitService({
		chainsProvider: () => [shortGap],
		clipsProvider: clipsFor,
		outagesProvider: () => [{ cameraId: "cam-a", from: 20, to: 40 }],
	});
	const [visit] = service.listVisits({ from: 0, to: 200 });
	const entries = service.timeline({ visitId: visit.visitId, at: 200 });
	assert.ok(entries.every((e) => e.kind === "clip"), "20s span ≤ 30s threshold needs no explanation");
});

test("an outage on a zone-eligible camera explains a silent visit edge", () => {
	const edgeChain = {
		entityId: "pe_5",
		cls: "person",
		t0: 20,
		t1: 40,
		sightings: [sighting("cam-a", "e1", 20, 40)],
	};
	const service = createVisitService({
		store: { eligibleCameraIds: () => ["cam-c"] },
		chainsProvider: () => [edgeChain],
		outagesProvider: () => [{ cameraId: "cam-c", from: 12, to: 18 }],
	});
	const [visit] = service.listVisits({ from: 10, to: 50 });
	const entries = service.timeline({ visitId: visit.visitId, at: 50 });

	const gap = entries[0];
	assert.equal(gap.kind, "gap");
	assert.equal(gap.cameraId, "cam-c");
	assert.equal(gap.from, 12);
	assert.equal(gap.to, 18);
	assert.equal(gap.reason, "camera-outage");
	assert.ok(!("path" in gap));

	// A camera with neither zone eligibility nor sightings carries no
	// coverage expectation: the same outage elsewhere stays unexplained-free.
	const restricted = createVisitService({
		store: { eligibleCameraIds: () => ["cam-z"] },
		chainsProvider: () => [edgeChain],
		outagesProvider: () => [{ cameraId: "cam-c", from: 12, to: 18 }],
	});
	const [visitB] = restricted.listVisits({ from: 10, to: 50 });
	const entriesB = restricted.timeline({ visitId: visitB.visitId, at: 50 });
	assert.ok(entriesB.every((e) => e.kind !== "gap"));
});

test("timeline on an unknown visit id throws E_NOT_FOUND", () => {
	const service = createVisitService({ chainsProvider: () => [] });
	assert.throws(
		() => service.timeline({ visitId: "visit_000000000000" }),
		(error) => error.code === "E_NOT_FOUND",
	);
});

test("openVisitSurface timelines a single chain over its own span and reuses the stable id", () => {
	const chain = daveChain();
	const service = createVisitService({ chainsProvider: () => [chain] });
	const surface = service.openVisitSurface({ chain });

	assert.equal(surface.entityId, "pe_4");
	assert.equal(surface.from, 0);
	assert.equal(surface.to, 130);
	assert.equal(surface.visitId, visitIdFor([chain.entityId], chain.t0, chain.t1));
	assert.equal(surface.timeline.length, 2, "no outages configured → no gap entries");
	assert.deepEqual(
		service.timeline({ visitId: surface.visitId, at: 200 }).map((e) => `${e.kind}:${e.from}`),
		surface.timeline.map((e) => `${e.kind}:${e.from}`),
	);
});

test("listVisits validates the window", () => {
	const service = createVisitService({ chainsProvider: () => [] });
	assert.throws(() => service.listVisits({ from: 200, to: 100 }), (error) => error.code === "E_BAD_WINDOW");
	assert.throws(() => service.listVisits({}), (error) => error.code === "E_BAD_WINDOW");
});
