// tracked-follow.test.js — PORCH-140 ac-1: the tracked-objects surface and
// the follow service. Tracked-class filtering, ordering and follow flags on
// the list; follow idempotence, E_NOT_FOLLOWABLE, audited exactly-once bump
// engage/release, and the ordered-clip stream through the injected seams.

import { test } from "node:test";
import assert from "node:assert/strict";

import { createTrackedObjectsService } from "../src/tracked.js";
import { createFollowService, E_NOT_FOLLOWABLE } from "../src/follow.js";
import { statesOf } from "../src/entity-state.js";

/**
 * @param {string} camera
 * @param {string} trackId
 * @param {number} t0
 * @param {number} t1
 * @param {number[][]} samples
 * @param {string} [cls]
 */
function sighting(camera, trackId, t0, t1, samples, cls = "person") {
	return { camera, trackId, t0, t1, sampleCount: samples.length, cls, samples };
}

/** Person walking left → right while still moving at list time. */
function personChain() {
	return {
		entityId: "pe_2",
		cls: "person",
		t0: 10,
		t1: 50,
		sightings: [
			sighting("left", "p1", 10, 20, [[0.8, 0.3, 0.1, 0.4], [0.5, 0.3, 0.1, 0.4]]),
			sighting("right", "r7", 22, 50, [[0.05, 0.35, 0.1, 0.4], [0.6, 0.35, 0.1, 0.4]]),
		],
	};
}

/** Parked car seen on two cameras, still live at list time. */
function vehicleChain() {
	return {
		entityId: "pe_3",
		cls: "vehicle",
		t0: 40,
		t1: 70,
		sightings: [
			{ ...sighting("right", "r9", 40, 44, [[0.5, 0.5, 0.2, 0.2], [0.5, 0.5, 0.2, 0.2]], "vehicle"), cls: "vehicle" },
			{ ...sighting("left", "l1", 60, 70, [[0.4, 0.5, 0.2, 0.2], [0.4, 0.5, 0.2, 0.2]], "vehicle"), cls: "vehicle" },
		],
	};
}

function packageChain() {
	return {
		entityId: "pe_1",
		cls: "package",
		t0: 20,
		t1: 30,
		sightings: [sighting("left", "pk1", 20, 30, [[0.2, 0.6, 0.05, 0.05]], "package")],
	};
}

/** Out of scope (not a tracked class): must never surface. */
function birdChain() {
	return {
		entityId: "pe_0",
		cls: "bird",
		t0: 80,
		t1: 90,
		sightings: [sighting("left", "bd1", 80, 90, [[0.1, 0.1, 0.05, 0.05]], "bird")],
	};
}

function fakeAudit() {
	/** @type {Array<Record<string, unknown>>} */
	const records = [];
	return {
		records,
		/** @param {Record<string, unknown>} row */
		record(row) {
			records.push(row);
		},
	};
}

function fakeCompositor() {
	/** @type {Array<{cameraId: string, engaged: boolean}>} */
	const bumps = [];
	return {
		bumps,
		/** @param {string} cameraId @param {boolean} engaged */
		setFollowBump(cameraId, engaged) {
			bumps.push({ cameraId, engaged });
		},
	};
}

test("tracked list keeps tracked classes only, ordered by lastSeenAt desc, with follow flags", () => {
	const chains = [packageChain(), birdChain(), personChain(), vehicleChain()];
	const follow = createFollowService({ audit: fakeAudit(), compositor: fakeCompositor() });
	follow.follow({ entityId: "pe_3", cls: "vehicle", activeCameraId: "right", actorIdentityRef: "did:owner" });
	const tracked = createTrackedObjectsService({ chainsProvider: () => chains, followService: follow });

	const { tracked: list } = tracked.list({ at: 100 });
	// The bird is the most recent chain on the property and is still absent:
	// scope law keeps non-tracked classes off the tracked surface entirely.
	assert.deepEqual(
		list.map((entry) => entry.entityId),
		["pe_3", "pe_2", "pe_1"],
	);
	const vehicle = list[0];
	assert.equal(vehicle.cls, "vehicle");
	assert.deepEqual(vehicle.cameraIds, ["right", "left"]);
	assert.equal(vehicle.lastSeenAt, 70);
	assert.equal(vehicle.followed, true);
	assert.equal(list[1].followed, false);
	assert.equal(list[2].followed, false);
});

test("follow engages the bump exactly once, audited; re-follow is idempotent", () => {
	const audit = fakeAudit();
	const compositor = fakeCompositor();
	const follow = createFollowService({ audit, compositor });

	const sub = follow.follow({ entityId: "pe_2", cls: "person", activeCameraId: "left", actorIdentityRef: "did:owner" });
	assert.equal(sub.entityId, "pe_2");
	assert.equal(sub.engaged, true);
	assert.deepEqual(compositor.bumps, [{ cameraId: "left", engaged: true }]);
	assert.equal(audit.records.length, 1);
	assert.equal(audit.records[0].type, "follow-bump-engage");
	assert.deepEqual(audit.records[0].detail, { entityId: "pe_2", cameraId: "left" });
	assert.equal(audit.records[0].actorIdentityRef, "did:owner");

	const again = follow.follow({ entityId: "pe_2", cls: "person", activeCameraId: "left", actorIdentityRef: "did:owner" });
	assert.equal(again, sub, "re-follow returns the same subscription");
	assert.equal(compositor.bumps.length, 1, "no duplicate bump");
	assert.equal(audit.records.length, 1, "no duplicate audit row");
});

test("follow of a package throws E_NOT_FOLLOWABLE and changes nothing", () => {
	const audit = fakeAudit();
	const compositor = fakeCompositor();
	const follow = createFollowService({ audit, compositor });

	assert.throws(
		() => follow.follow({ entityId: "pe_1", cls: "package", activeCameraId: "left", actorIdentityRef: "did:owner" }),
		(error) => error.code === E_NOT_FOLLOWABLE && error.message === "Only a person or a vehicle can be followed",
	);
	assert.equal(audit.records.length, 0);
	assert.equal(compositor.bumps.length, 0);
});

test("exit hands the bump to the next camera; each engage/release audited exactly once", () => {
	const audit = fakeAudit();
	const compositor = fakeCompositor();
	const follow = createFollowService({ audit, compositor });
	follow.follow({ entityId: "pe_2", cls: "person", activeCameraId: "left", actorIdentityRef: "did:owner" });

	follow.exit({ entityId: "pe_2", cameraId: "left", nextCameraId: "right" });
	assert.deepEqual(compositor.bumps, [
		{ cameraId: "left", engaged: true },
		{ cameraId: "left", engaged: false },
		{ cameraId: "right", engaged: true },
	]);
	assert.deepEqual(
		audit.records.map((row) => row.type),
		["follow-bump-engage", "follow-bump-release", "follow-bump-engage"],
	);
	assert.equal(audit.records[2].type, "follow-bump-engage");
	assert.deepEqual(audit.records[2].detail, { entityId: "pe_2", cameraId: "right" });

	follow.unfollow({ entityId: "pe_2", actorIdentityRef: "did:owner" });
	assert.deepEqual(compositor.bumps.at(-1), { cameraId: "right", engaged: false });
	assert.equal(audit.records.at(-1).type, "follow-bump-release");
	assert.equal(follow.subscriptions().length, 0);

	follow.unfollow({ entityId: "pe_2", actorIdentityRef: "did:owner" });
	assert.equal(audit.records.length, 4, "unfollow of a gone subscription audits nothing");
});

test("stream resolves state via the injected seam and lists clips ordered by sighting t", () => {
	const chain = personChain();
	const follow = createFollowService({
		resolveState: (entityId, at) => (at > 60 ? "DEPARTED" : "MOVING"),
		clipsProvider: (c) => c.sightings.map((s) => ({
			cameraId: s.camera,
			path: `clips/${c.entityId}/${s.camera}-${s.trackId}.mp4`,
			from: s.t0 - 5,
			to: s.t1 + 5,
		})),
		chainsProvider: () => [chain],
	});

	const stream = follow.stream({ entityId: "pe_2", at: 40 });
	assert.equal(stream.entityId, "pe_2");
	assert.equal(stream.state, "MOVING");
	assert.deepEqual(
		stream.clips.map((clip) => clip.cameraId),
		["left", "right"],
	);
	assert.ok(stream.clips.every((clip) => typeof clip.path === "string" && clip.path.length > 0));
});

test("stream without a resolveState seam derives the state from the chain's liveState", () => {
	const chain = personChain();
	const follow = createFollowService({ chainsProvider: () => [chain] });
	assert.equal(follow.stream({ entityId: "pe_2", at: 30 }).state, "MOVING");
	const parked = vehicleChain();
	const parkedFollow = createFollowService({ chainsProvider: () => [parked] });
	assert.equal(parkedFollow.stream({ entityId: "pe_3", at: 45 }).state, "PARKED");
});

test("tracked get() returns the full chain view, FSM states and ordered clips", () => {
	const chain = personChain();
	const follow = createFollowService({
		chainsProvider: () => [chain],
		clipsProvider: (c) => c.sightings.map((s) => ({ cameraId: s.camera, path: `clips/${s.camera}-${s.trackId}.mp4`, from: s.t0, to: s.t1 })),
	});
	const tracked = createTrackedObjectsService({ chainsProvider: () => [chain], followService: follow });

	const view = tracked.get({ entityId: "pe_2", at: 30 });
	assert.equal(view.entityId, "pe_2");
	assert.equal(view.entityState, "MOVING");
	assert.equal(view.state, "MOVING");
	assert.deepEqual(view.states.map((state) => state.state), ["arrival", "movement"]);
	assert.deepEqual(view.chain.sightings.map((s) => s.camera), ["left", "right"]);
	assert.deepEqual(view.clips.map((clip) => clip.cameraId), ["left", "right"]);
	assert.equal(view.followed, false);
});

test("tracked get() on an unknown entity yields null", () => {
	const tracked = createTrackedObjectsService({ chainsProvider: () => [personChain()] });
	assert.equal(tracked.get({ entityId: "pe_404" }), null);
});

/** Person who walks across and then settles: three sightings on the chain. */
function settlingChain(cls = "person") {
	return {
		entityId: "pe_7",
		cls,
		t0: 10,
		t1: 118,
		sightings: [
			sighting("left", "w1", 10, 20, [[0.8, 0.3, 0.1, 0.4], [0.5, 0.3, 0.1, 0.4]], cls),
			sighting("left", "w2", 22, 24, [[0.5, 0.3, 0.1, 0.4], [0.05, 0.3, 0.1, 0.4]], cls),
			sighting("right", "w3", 26, 118, [[0.3, 0.35, 0.1, 0.4], [0.3, 0.35, 0.1, 0.4], [0.31, 0.35, 0.1, 0.4]], cls),
		],
	};
}

test("FSM: arrival → movement → stationary in label sequence while live", () => {
	const { sightings: states, entityState } = statesOfChain(settlingChain(), 30);
	assert.deepEqual(states.map((state) => state.state), ["arrival", "movement", "stationary"]);
	assert.equal(entityState, "STATIONARY");
});

/**
 * @param {import("../src/types.js").PropertyEntity} chain
 * @param {number} at
 */
function statesOfChain(chain, at) {
	return statesOf(chain, { now: at });
}

test("FSM: the stale final sighting flips to departure — DEPARTED entity state", () => {
	const chain = settlingChain();
	const { sightings: states, entityState } = statesOfChain(chain, 200);
	assert.deepEqual(states.map((state) => state.state), ["arrival", "movement", "departure"]);
	assert.equal(entityState, "DEPARTED");
});

test("FSM: a still-live stationary person past loiteringSec is LOITERING", () => {
	const chain = settlingChain();
	// Stretch the stationary sighting so it is still being observed at now.
	chain.t1 = 150;
	chain.sightings[2].t1 = 150;
	chain.sightings[2].sampleCount = 4;
	chain.sightings[2].samples.push([0.3, 0.35, 0.1, 0.4]);
	const { entityState } = statesOfChain(chain, 160);
	assert.equal(entityState, "LOITERING", "160 − 26 > 120, sighting not stale (160 − 150 ≤ 60)");
});

test("FSM: a stationary vehicle is PARKED at any duration", () => {
	const chain = settlingChain("vehicle");
	const stationary = statesOfChain(chain, 30);
	assert.equal(stationary.entityState, "PARKED");
	const settledLong = statesOfChain(chain, 119);
	assert.equal(settledLong.entityState, "PARKED", "vehicles never LOITER");
});
