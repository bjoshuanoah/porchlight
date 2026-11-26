// server.test.js — the overwatch REST plane's transport contract (PORCH-140
// wave 2). Real servers on ephemeral ports (the config-plane test pattern):
// zone authoring incl. restart persistence via a NEW store instance on the
// same path, validation 422s, dial clamp + audit, tracked/follow/stream,
// the outage-gap timeline, the association flag control, and the authorize
// seam (null = allow-all; injected denies read 403).

import { describe, test, before, after } from "node:test";
import assert from "node:assert/strict";
import fsDefault from "node:fs";
import osDefault from "node:os";
import pathDefault from "node:path";

import { createConfigStore } from "../src/config-store.js";
import { createAuditLog } from "../src/audit.js";
import { createDial } from "../src/dial.js";
import { createTrackedObjectsService } from "../src/tracked.js";
import { createFollowService } from "../src/follow.js";
import { createVisitService } from "../src/visits.js";
import { createOverwatchServer, occurrenceSignatures } from "../src/server.js";

/**
 * @param {string} camera
 * @param {string} trackId
 * @param {number} t0
 * @param {number} t1
 * @param {string} [cls]
 * @param {number[][]} [samples]
 */
function sighting(camera, trackId, t0, t1, cls = "person", samples = [[0.3, 0.4, 0.1, 0.4], [0.7, 0.4, 0.1, 0.4]]) {
	return { camera, trackId, t0, t1, sampleCount: samples.length, cls, samples };
}

/** A person mid-walk across two cameras (entityState MOVING at the fixed at=40). */
function personChain() {
	return {
		entityId: "pe_person",
		cls: "person",
		t0: 10,
		t1: 50,
		sightings: [
			sighting("left", "p1", 10, 20),
			sighting("right", "r7", 22, 50),
		],
	};
}

/** A parked vehicle on one camera (stationary law — PARKED). */
function vehicleChain() {
	return {
		entityId: "pe_vehicle",
		cls: "vehicle",
		t0: 10,
		t1: 50,
		sightings: [sighting("left", "v1", 10, 50, "vehicle", [[0.4, 0.3, 0.2, 0.2], [0.4, 0.3, 0.2, 0.2]])],
	};
}

/** A tracked-scope but non-followable entity, seen on BOTH person cameras. */
function packageChain() {
	return {
		entityId: "pe_package",
		cls: "package",
		t0: 10,
		t1: 50,
		sightings: [
			sighting("left", "pk1", 10, 20, "package"),
			sighting("right", "pk2", 22, 50, "package"),
		],
	};
}

/**
 * One entity with an unexplained 45 s inter-sighting span (110 → 155, over
 * the 30 s law) that a recorded outage covers: the timeline must carry a gap
 * entry trimmed to the outage, chronologically placed.
 */
function gapChain() {
	return {
		entityId: "pe_gap",
		cls: "person",
		t0: 100,
		t1: 220,
		sightings: [
			sighting("cam-a", "a1", 100, 110),
			sighting("cam-a", "a2", 155, 220),
		],
	};
}

describe("overwatch REST plane contract", () => {
	/** @type {Record<string, unknown>} */
	const ctx = {};
	const root = fsDefault.mkdtempSync(pathDefault.join(osDefault.tmpdir(), "overwatch-server-"));
	const storePath = pathDefault.join(root, "config", "overwatch", "config.json");
	const auditPath = pathDefault.join(root, "config", "overwatch", "audit.jsonl");
	const PORT = () => 40;

	/**
	 * @param {{
	 *   chains?: () => unknown[],
	 *   outages?: () => Array<{ cameraId: string, from: number, to: number }>,
	 *   now?: () => number,
	 *   entityService?: object | null,
	 *   authorize?: ((args: unknown) => unknown) | null,
	 * }} [options]
	 */
	function buildServices({ chains = () => [], outages = () => [], now = PORT, entityService = null, authorize = null } = {}) {
		const store = createConfigStore({ path: storePath });
		const audit = createAuditLog({ path: auditPath });
		const dial = createDial({ store, audit });
		const clipsProvider = (/** @type {{ entityId: string, sightings?: Array<{ camera: string, trackId: string, t0: number, t1: number }> }} */ chain) =>
			(chain.sightings ?? []).map((ref) => ({
				cameraId: ref.camera,
				path: `clips/${chain.entityId}/${ref.camera}-${ref.trackId}.mp4`,
				from: ref.t0,
				to: ref.t1,
			}));
		const followService = createFollowService({ audit, chainsProvider: chains, clipsProvider, now });
		const trackedService = createTrackedObjectsService({ chainsProvider: chains, followService });
		const visitService = createVisitService({ store, chainsProvider: chains, clipsProvider, outagesProvider: outages });
		const services = { store, dial, audit, trackedService, followService, visitService, now, entityService };
		return createOverwatchServer({ services, authorize, log: () => {} });
	}

	/**
	 * @param {import("node:http").Server} server
	 * @returns {Promise<number>} the bound ephemeral port
	 */
	function listen(server) {
		return new Promise((resolve) => {
			server.listen(0, "127.0.0.1", () => resolve(/** @type {{ port: number }} */ (server.address()).port));
		});
	}

	/** @returns {Promise<void>} resolved when the server's socket is closed */
	function close(server) {
		return new Promise((resolve) => server.close(() => resolve(undefined)));
	}

	async function api(method, pathname, body) {
		const res = await fetch(`http://127.0.0.1:${ctx.port}${pathname}`, {
			method,
			headers: body === undefined ? {} : { "content-type": "application/json" },
			body: body === undefined ? undefined : JSON.stringify(body),
		});
		const text = await res.text();
		return { status: res.status, body: text.trim() === "" ? null : JSON.parse(text) };
	}

	before(async () => {
		const chains = () => [personChain(), vehicleChain(), packageChain(), gapChain()];
		ctx.vetoed = [];
		const server = buildServices({
			chains,
			outages: () => [{ cameraId: "cam-a", from: 120, to: 150 }],
			entityService: { vetoPair: (/** @type {string} */ signature) => ctx.vetoed.push(signature) },
		});
		ctx.server = server;
		ctx.port = await listen(server);
	});

	after(async () => {
		await close(ctx.server);
		fsDefault.rmSync(root, { recursive: true, force: true });
	});

	test("zone PUT → state GET roundtrip; DELETE withdraws; every mutation lands an audit row", async () => {
		const put = await api("PUT", "/api/overwatch/zones/front", {
			polygon: [[0, 0], [10, 0], [10, 10]],
			actorIdentityRef: "did:owner",
		});
		assert.equal(put.status, 200);
		assert.equal(put.body.zone.cameraId, "front");
		assert.deepEqual(put.body.zone.polygon, [[0, 0], [10, 0], [10, 10]]);
		assert.equal(put.body.zone.authoredBy, "did:owner");

		const state = await api("GET", "/api/overwatch/state");
		assert.equal(state.status, 200);
		const front = state.body.cameras.find((/** @type {{ cameraId: string }} */ camera) => camera.cameraId === "front");
		assert.deepEqual(front, { cameraId: "front", zone: [[0, 0], [10, 0], [10, 10]], uncovered: false });
		assert.ok(state.body.zones.some((/** @type {{ cameraId: string }} */ zone) => zone.cameraId === "front"));
		assert.deepEqual(state.body.adjacency, []);
		assert.deepEqual(state.body.travelTime, {});
		assert.equal(typeof state.body.dial.frameRate, "number");
		assert.equal(state.body.dial.capFps, 5);

		const audits = await api("GET", "/api/overwatch/audit?type=zone-config-change");
		assert.equal(audits.body.records.length, 1);
		assert.deepEqual(audits.body.records[0].detail, { cameraId: "front", action: "set" });

		const removed = await api("DELETE", "/api/overwatch/zones/front");
		assert.equal(removed.status, 200);
		assert.deepEqual(removed.body, { cameraId: "front", removed: true });
		const again = await api("DELETE", "/api/overwatch/zones/front");
		assert.equal(again.status, 404);
		assert.equal(again.body.code, "E_NOT_FOUND");
		const after = await api("GET", "/api/overwatch/audit?type=zone-config-change");
		assert.deepEqual(after.body.records.map((/** @type {{ detail: { action: string } }} */ record) => record.detail.action), ["remove", "set"]);
	});

	test("an authored zone survives a plane restart on the same store path (NEW store instance)", async () => {
		await api("PUT", "/api/overwatch/zones/back", { polygon: [[1, 1], [4, 1], [4, 4]] });

		// The restart path: a fresh store instance re-reads the same file.
		const reloaded = createConfigStore({ path: storePath });
		assert.ok(reloaded.getState().coverageZones.some((/** @type {{ cameraId: string }} */ zone) => zone.cameraId === "back"));

		// And a fresh plane on that fresh instance serves the zone.
		const restarted = buildServices();
		const restartedPort = await listen(restarted);
		try {
			const res = await fetch(`http://127.0.0.1:${restartedPort}/api/overwatch/state`);
			const body = await res.json();
			const back = body.cameras.find((/** @type {{ cameraId: string }} */ camera) => camera.cameraId === "back");
			assert.deepEqual(back, { cameraId: "back", zone: [[1, 1], [4, 1], [4, 4]], uncovered: false });
		} finally {
			await close(restarted);
		}
	});

	test("invalid polygon is a plain-language 422; unknown routes are 404", async () => {
		assert.equal((await api("PUT", "/api/overwatch/zones/bad", { polygon: [[0, 0], [1, 1]] })).status, 422);
		assert.equal((await api("PUT", "/api/overwatch/zones/bad", { polygon: "nope" })).status, 422);
		assert.equal((await api("PUT", "/api/overwatch/zones/bad", "{not json")).status, 422);
		assert.equal((await api("GET", "/api/overwatch/does-not-exist")).status, 404);
		assert.equal((await api("POST", "/api/overwatch/state")).status, 404);
	});

	test("adjacency and travel-time PUTs normalize and validate", async () => {
		assert.equal((await api("PUT", "/api/overwatch/adjacency", { pairs: [["right", "left"], ["left", "yard"]] })).status, 200);
		let state = await api("GET", "/api/overwatch/state");
		assert.deepEqual(state.body.adjacency, [["left", "right"], ["left", "yard"]], "pairs normalize sorted");

		assert.equal((await api("PUT", "/api/overwatch/travel-time", { updates: { "left|right": { min: 2, max: 8 } } })).status, 200);
		state = await api("GET", "/api/overwatch/state");
		assert.deepEqual(state.body.travelTime, { "left|right": { min: 2, max: 8 } });

		assert.equal((await api("PUT", "/api/overwatch/adjacency", { pairs: "nope" })).status, 422);
		assert.equal((await api("PUT", "/api/overwatch/adjacency", { pairs: [["left", "left"]] })).status, 422);
		// Unsorted pair-key form is refused (the store validates the keys).
		assert.equal((await api("PUT", "/api/overwatch/travel-time", { updates: { "right|left": { min: 1, max: 2 } } })).status, 422);
		assert.equal((await api("PUT", "/api/overwatch/travel-time", { updates: {} })).status, 200);
	});

	test("dial PUT clamps to the benchmark cap and lands audit rows for actual changes", async () => {
		// An ordinary in-range change first (audited), so the clamp below is a
		// real state change (starting the dial at the cap would clamp to a
		// no-op — identical values audit nothing).
		const set = await api("PUT", "/api/overwatch/dial", { frameRate: 3, actorIdentityRef: "did:owner" });
		assert.deepEqual(set.body, { frameRate: 3, clamped: false, capFps: 5 });

		const clamped = await api("PUT", "/api/overwatch/dial", { frameRate: 50, actorIdentityRef: "did:owner" });
		assert.equal(clamped.status, 200);
		assert.deepEqual(clamped.body, { frameRate: 5, clamped: true, capFps: 5 });

		assert.deepEqual((await api("GET", "/api/overwatch/dial")).body, { frameRate: 5, capFps: 5 });

		// Same value again: explicit state changes only — no new audit row.
		await api("PUT", "/api/overwatch/dial", { frameRate: 5, actorIdentityRef: "did:owner" });

		assert.equal((await api("PUT", "/api/overwatch/dial", { frameRate: "fast" })).status, 422);

		const audits = await api("GET", "/api/overwatch/audit?type=dial-change");
		assert.equal(audits.body.records.length, 2, "newest first, the clamped set and the plain set");
		assert.deepEqual(audits.body.records[0].detail, { requested: 50, applied: 5, clamped: true });
		assert.deepEqual(audits.body.records[1].detail, { requested: 3, applied: 3, clamped: false });
	});

	test("tracked list + follow/unfollow + stream shape", async () => {
		const list = await api("GET", "/api/overwatch/tracked");
		assert.equal(list.status, 200);
		assert.deepEqual(
			list.body.tracked.map((/** @type {{ entityId: string }} */ entry) => entry.entityId),
			["pe_gap", "pe_package", "pe_person", "pe_vehicle"],
			"lastSeenAt desc with deterministic ties",
		);
		const person = list.body.tracked.find((/** @type {{ entityId: string }} */ entry) => entry.entityId === "pe_person");
		assert.deepEqual(person, {
			entityId: "pe_person",
			cls: "person",
			entityState: "MOVING",
			cameraIds: ["left", "right"],
			lastSeenAt: 50,
			followed: false,
		});
		assert.equal(
			list.body.tracked.find((/** @type {{ entityId: string }} */ entry) => entry.entityId === "pe_vehicle").entityState,
			"PARKED",
		);

		const followed = await api("POST", "/api/overwatch/tracked/pe_person/follow", {
			activeCameraId: "left",
			actorIdentityRef: "did:owner",
		});
		assert.equal(followed.status, 200);
		assert.deepEqual(followed.body.subscription, {
			entityId: "pe_person",
			cls: "person",
			cameraId: "left",
			engaged: true,
			actorIdentityRef: "did:owner",
			since: 40,
		});

		// The tracked list reflects the live subscription; re-follow is idempotent.
		assert.equal(
			(await api("GET", "/api/overwatch/tracked")).body.tracked.find((/** @type {{ entityId: string }} */ e) => e.entityId === "pe_person").followed,
			true,
		);
		const refollow = await api("POST", "/api/overwatch/tracked/pe_person/follow", {});
		assert.deepEqual(refollow.body.subscription.cameraId, "left");

		const stream = await api("GET", "/api/overwatch/tracked/pe_person/stream");
		assert.equal(stream.status, 200);
		assert.equal(stream.body.state, "MOVING");
		assert.deepEqual(stream.body.clips, [
			{ cameraId: "left", path: "clips/pe_person/left-p1.mp4", from: 10, to: 20 },
			{ cameraId: "right", path: "clips/pe_person/right-r7.mp4", from: 22, to: 50 },
		]);
		assert.equal((await api("GET", "/api/overwatch/tracked/pe_unknown/stream")).status, 404);

		// Non-followable classes are refused with the plain-language law.
		const notFollowable = await api("POST", "/api/overwatch/tracked/pe_package/follow", {});
		assert.equal(notFollowable.status, 422);
		assert.equal(notFollowable.body.error, "Only a person or a vehicle can be followed");

		const unfollowed = await api("DELETE", "/api/overwatch/tracked/pe_person/follow", { actorIdentityRef: "did:owner" });
		assert.equal(unfollowed.status, 200);
		assert.deepEqual(unfollowed.body, { entityId: "pe_person", followed: false, removed: true });
	});

	test("visit list + timeline carry the outage gap entry, never fabricated content", async () => {
		const visits = await api("GET", "/api/overwatch/visits?from=100&to=300");
		assert.equal(visits.status, 200);
		assert.equal(visits.body.visits.length, 1);
		const visit = visits.body.visits[0];
		assert.deepEqual(visit.entities, ["pe_gap"]);
		assert.deepEqual(visit.cameras, ["cam-a"]);

		const timeline = await api("GET", `/api/overwatch/visits/${visit.visitId}/timeline`);
		assert.equal(timeline.status, 200);
		const entries = timeline.body.timeline;
		assert.deepEqual(entries.map((/** @type {{ kind: string }} */ entry) => entry.kind), ["clip", "gap", "clip"]);
		assert.deepEqual(entries[1], { kind: "gap", cameraId: "cam-a", from: 120, to: 150, reason: "camera-outage" });
		assert.ok(!("path" in entries[1]), "gap entries never carry media");

		assert.equal((await api("GET", "/api/overwatch/visits")).status, 422);
		assert.equal((await api("GET", "/api/overwatch/visits?from=300&to=100")).status, 422);
		assert.equal((await api("GET", "/api/overwatch/visits/visit_unknown/timeline")).status, 404);
	});

	test("association flag persists occurrence pair signatures, audits, and vetoes live", async () => {
		// pe_person vs pe_package: two mixed cross-camera pairs, two signatures.
		const first = await api("POST", "/api/overwatch/association/flag", {
			fromEntityId: "pe_person",
			toEntityId: "pe_package",
			actorIdentityRef: "did:owner",
		});
		assert.equal(first.status, 200);
		const firstSignatures = ["left:p1|right:pk2", "left:pk1|right:r7"];
		assert.deepEqual(first.body.added, firstSignatures);
		assert.deepEqual(ctx.vetoed, firstSignatures, "the runtime veto lands on the active merge service");

		// pe_person vs pe_gap adds the four cross-camera pairs against cam-a.
		const crossCamera = await api("POST", "/api/overwatch/association/flag", {
			fromEntityId: "pe_person",
			toEntityId: "pe_gap",
			actorIdentityRef: "did:owner",
		});
		assert.equal(crossCamera.status, 200);
		const expected = occurrenceSignatures(personChain(), gapChain());
		assert.equal(expected.length, 4, "every cross-camera sighting pair builds one camera:trackId signature");
		assert.deepEqual(crossCamera.body.added, expected);
		assert.deepEqual(ctx.vetoed, [...firstSignatures, ...expected]);

		// Persisted of record: a NEW store instance carries the rows.
		const persisted = createConfigStore({ path: storePath });
		const storePairs = persisted.getState().correlation.separatePairs;
		for (const signature of [...firstSignatures, ...expected]) {
			assert.ok(storePairs.includes(signature));
		}

		const auditRows = await api("GET", "/api/overwatch/audit?type=association-flag");
		assert.equal(auditRows.body.records.length, 2);
		assert.deepEqual(auditRows.body.records[0].detail, {
			fromEntityId: "pe_person",
			toEntityId: "pe_gap",
			signatures: expected,
		});

		// Re-flag: no new signatures → no audit row, no duplicate store rows.
		const reflagged = await api("POST", "/api/overwatch/association/flag", { fromEntityId: "pe_person", toEntityId: "pe_gap" });
		assert.deepEqual(reflagged.body.added, []);
		assert.equal((await api("GET", "/api/overwatch/audit?type=association-flag")).body.records.length, 2);

		assert.equal((await api("POST", "/api/overwatch/association/flag", { fromEntityId: "pe_person", toEntityId: "pe_unknown" })).status, 404);
		assert.equal((await api("POST", "/api/overwatch/association/flag", { fromEntityId: "pe_person" })).status, 422);
		assert.equal((await api("POST", "/api/overwatch/association/flag", { fromEntityId: "pe_gap", toEntityId: "pe_gap" })).status, 422);
	});

	test("authorize: null allows everything; an injected deny reads 403 E_NOT_PERMITTED", async () => {
		const denyServer = buildServices({ authorize: () => false });
		const denyPort = await listen(denyServer);
		try {
			assert.equal((await fetch(`http://127.0.0.1:${denyPort}/api/overwatch/state`)).status, 403);
			const put = await fetch(`http://127.0.0.1:${denyPort}/api/overwatch/zones/front`, {
				method: "PUT",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ polygon: [[0, 0], [1, 0], [1, 1]] }),
			});
			assert.equal(put.status, 403);
			assert.equal((await put.json()).code, "E_NOT_PERMITTED");
		} finally {
			await close(denyServer);
		}

		// Reads pass, writes deny: the owner-ness split the hub adapter wires.
		const readOkServer = buildServices({
			chains: () => [personChain()],
			authorize: ({ action }) => action === "read",
		});
		const readOkPort = await listen(readOkServer);
		try {
			assert.equal((await fetch(`http://127.0.0.1:${readOkPort}/api/overwatch/state`)).status, 200);
			const put = await fetch(`http://127.0.0.1:${readOkPort}/api/overwatch/dial`, {
				method: "PUT",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ frameRate: 3 }),
			});
			assert.equal(put.status, 403);
		} finally {
			await close(readOkServer);
		}
	});
});
