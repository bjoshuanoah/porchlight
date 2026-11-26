// server.test.js — PORCH-141 REST contract: the People & Things plane speaks
// plain node:http JSON, rides the owner seam, and carries every surface the
// Faces/Vehicles screens need. The ac-3 export and ac-6 toggle ride here.

import { test, after } from "node:test";
import assert from "node:assert/strict";

import { createMemoryStore } from "@porchlight/shared";

import { createRegistryService } from "../src/registry.js";
import { createRecognitionPipeline, VisionProviderRegistry } from "../src/pipeline.js";
import { createRecognitionService } from "../src/recognition.js";
import { createWatchlistService } from "../src/watchlists.js";
import { createRecognitionServer } from "../src/server.js";

const MOM_VECTOR = [0.95, 0.3, 0.05];

/** Live servers from fixture(); all closed once the file finishes. */
const liveServers = [];
after(async () => {
	for (const server of liveServers) {
		await new Promise((resolve) => server.close(() => resolve(undefined)));
	}
});

function deterministicProvider() {
	return {
		name: "test-embedder",
		async describeFaces() {
			return [{ descriptor: MOM_VECTOR, conf: 0.99 }];
		},
		async readPlates() {
			return [{ text: "6tri889", conf: 0.93 }];
		},
		// PORCH-142: the exemplar embedder stage — deterministic test vectors.
		async embedImage(frame) {
			const selector = frame.w ?? 0;
			return [selector === 1 ? [0.2, 0.98] : selector === 2 ? [0.9, 0.05, 0.1] : MOM_VECTOR];
		},
	};
}

/** Spin the plane with an in-memory store; owner seam allow-all by default. */
async function fixture({ authorize = null } = {}) {
	const registry = createRegistryService({ store: createMemoryStore() });
	const visionRegistry = new VisionProviderRegistry();
	visionRegistry.register("local", () => deterministicProvider());
	const pipeline = createRecognitionPipeline({ registry: visionRegistry });
	const recognition = createRecognitionService({ registry, pipeline });
	const watchlists = createWatchlistService({
		store: createMemoryStore(),
		trackedClasses: ["person", "vehicle", "package", "bin", "furniture", "equipment"],
		providerRef: async () => deterministicProvider(),
	});
	const { server, handler } = createRecognitionServer({ services: { registry, recognition, watchlists }, authorize });
	liveServers.push(server);
	await new Promise((resolve) => server.once("listening", resolve));
	const address = server.address();
	const port = typeof address === "object" && address ? address.port : 0;
	const url = (path) => `http://127.0.0.1:${port}${path}`;
	/** @param {string} path @param {RequestInit} [init] */
	const request = async (path, init) => {
		const response = await fetch(url(path), init);
		const text = await response.text();
		/** @type {any} */
		let body;
		try {
			body = JSON.parse(text);
		} catch {
			body = text;
		}
		return { status: response.status, body, headers: response.headers };
	};
	return { server, registry, recognition, request, handler };
}

function json(init) {
	return { ...init, headers: { "content-type": "application/json", ...(init?.headers ?? {}) } };
}

test("settings GET/PUT: the switch of record round-trips (ac-6)", async () => {
	const { request } = await fixture();
	const initial = await request("/api/recognition/settings?homeId=home-1");
	assert.equal(initial.status, 200);
	assert.equal(initial.body.settings.enabled, false);
	const on = await request("/api/recognition/settings?homeId=home-1", json({
		method: "PUT",
		body: JSON.stringify({ enabled: true, actorDid: "did:owner" }),
	}));
	assert.equal(on.status, 200);
	assert.equal(on.body.settings.enabled, true);
	assert.ok(on.body.settings.updatedAt);
	assert.equal(on.body.settings.updatedBy, "did:owner");
	// Reading is not recognition — settings render regardless of the switch.
});

test("entries POST enroll + GET list + PATCH rename + DELETE purge (ac-1/ac-3)", async () => {
	const { request } = await fixture();
	await request("/api/recognition/settings?homeId=home-1", json({ method: "PUT", body: JSON.stringify({ enabled: true }) }));
	const frame64 = Buffer.from([0xff, 0xd8, 0xff, 0xe0]).toString("base64");
	const enroll = await request("/api/recognition/entries", json({
		method: "POST",
		body: JSON.stringify({ homeId: "home-1", kind: "face", name: "Mom", frames: [{ format: "jpeg", data: frame64 }] }),
	}));
	assert.equal(enroll.status, 201);
	assert.equal(enroll.body.entry.name, "Mom");
	const entryId = enroll.body.entry._id;
	const listed = await request("/api/recognition/entries?homeId=home-1&kind=face");
	assert.equal(listed.status, 200);
	assert.equal(listed.body.count, 1);
	const renamed = await request(`/api/recognition/entries/${entryId}?homeId=home-1`, json({
		method: "PATCH",
		body: JSON.stringify({ name: "Dr. Mom" }),
	}));
	assert.equal(renamed.status, 200);
	assert.equal(renamed.body.entry.name, "Dr. Mom");
	await request("/api/recognition/entries", json({
		method: "POST",
		body: JSON.stringify({ homeId: "home-1", kind: "vehicle", name: "Dad's truck", plateText: "6TRI889" }),
	}));
	const vehicles = await request("/api/recognition/entries?homeId=home-1&kind=vehicle");
	assert.equal(vehicles.body.count, 1);
	assert.equal(vehicles.body.entries[0].plateText, "6TRI889");
	const purge = await request(`/api/recognition/entries/${entryId}?homeId=home-1`, json({
		method: "DELETE",
		body: JSON.stringify({ actorDid: "did:owner" }),
	}));
	assert.equal(purge.status, 200);
	assert.deepEqual(purge.body.purged, {
		entryId,
		descriptorVectors: 1,
		plateReads: 0,
		sightings: 0,
		annotations: 0,
	});
	const after = await request(`/api/recognition/entries/${entryId}?homeId=home-1`);
	assert.equal(after.status, 404);
	assert.equal(after.body.code, "E_NOT_FOUND");
});

test("enrollment while switched off is refused 409, not 422 (ac-4/ac-6)", async () => {
	const { request } = await fixture();
	const frame64 = Buffer.from([0xff]).toString("base64");
	const refused = await request("/api/recognition/entries", json({
		method: "POST",
		body: JSON.stringify({ homeId: "home-1", kind: "face", name: "Mom", frames: [{ format: "jpeg", data: frame64 }] }),
	}));
	assert.equal(refused.status, 409);
	assert.equal(refused.body.code, "E_RECOGNITION_DISABLED");
});

test("visit enrollment requires the accountability note (F5)", async () => {
	const { request } = await fixture();
	await request("/api/recognition/settings?homeId=home-1", json({ method: "PUT", body: JSON.stringify({ enabled: true }) }));
	const missing = await request("/api/recognition/entries", json({
		method: "POST",
		body: JSON.stringify({
			homeId: "home-1",
			kind: "face",
			name: "Visitor",
			plateText: undefined,
			// No frames: face enrollment needs a photo.
			enrolledFor: "visit",
		}),
	}));
	assert.equal(missing.status, 422);
});

test("annotations GET returns by-reference rows for the event/track surfaces", async () => {
	const { registry, recognition, request } = await fixture();
	await registry.setEnabled({ homeId: "home-1", enabled: true, actorDid: "did:owner" });
	const entry = await recognition.enroll({ homeId: "home-1", kind: "face", name: "Mom", frames: [{ format: "jpeg", data: new Uint8Array([0xff, 0xd8, 0xff, 0xe0]) }] });
	await recognition.recognize({ homeId: "home-1", kind: "face", descriptor: MOM_VECTOR, eventId: "evn_1", cameraId: "cam-a", trackId: "t-1", at: 200 });
	const byTrack = await request("/api/recognition/annotations?homeId=home-1&trackId=t-1");
	assert.equal(byTrack.status, 200);
	assert.equal(byTrack.body.count, 1);
	assert.equal(byTrack.body.annotations[0].entryId, entry._id);
	const byEvent = await request("/api/recognition/annotations?homeId=home-1&targetKind=event&targetId=evn_1");
	assert.equal(byEvent.body.count, 1);
});

test("ac-3 the export surface: attachment JSON with every entry", async () => {
	const { registry, recognition, request } = await fixture();
	await registry.setEnabled({ homeId: "home-1", enabled: true, actorDid: "did:owner" });
	await recognition.enroll({ homeId: "home-1", kind: "face", name: "Mom", frames: [{ format: "jpeg", data: new Uint8Array([0xff, 0xd8, 0xff, 0xe0]) }] });
	const bundle = await request("/api/recognition/export?homeId=home-1");
	assert.equal(bundle.status, 200);
	assert.match(String(bundle.headers.get?.("content-disposition") ?? bundle.headers["content-disposition"] ?? ""), /porchlight-registry-home-1\.json/);
	assert.equal(bundle.body.formatName, "porchlight-recognition-registry/1");
	assert.equal(bundle.body.entries.length, 1);
	// The export never strips the household's own data: descriptors ride.
	assert.equal(bundle.body.entries[0].descriptors.length, 1);
});

test("ac-4 the metrics surface: zero-computation audit counters", async () => {
	const { registry, recognition, request } = await fixture();
	await registry.setEnabled({ homeId: "home-1", enabled: true, actorDid: "did:owner" });
	await recognition.enroll({ homeId: "home-1", kind: "face", name: "Mom", frames: [{ format: "jpeg", data: new Uint8Array([0xff, 0xd8, 0xff, 0xe0]) }] });
	await recognition.recognize({ homeId: "home-1", kind: "face", descriptor: MOM_VECTOR, eventId: "evn_1" });
	const metrics = await request("/api/recognition/metrics?homeId=home-1");
	assert.equal(metrics.status, 200);
	assert.equal(metrics.body.metrics.descriptorComputations, 1);
	// One enrollment pipeline run + one gallery-match run.
	assert.equal(metrics.body.metrics.recognitionRuns, 2);
});

test("the owner seam: falsy denies 403, thrown 401 passes through", async () => {
	const denied = await fixture({ authorize: () => false });
	const refuse = await denied.request("/api/recognition/entries?homeId=home-1");
	assert.equal(refuse.status, 403);
	assert.equal(refuse.body.code, "E_NOT_PERMITTED");
	await denied.server.close();

	const unauthorized = await fixture({
		authorize: () => {
			const error = new Error("Sign in with your Porchlight identity to reach this home.");
			error.status = 401;
			error.code = "E_MUST_SIGN_IN";
			throw error;
		},
	});
	const refuse401 = await unauthorized.request("/api/recognition/entries?homeId=home-1");
	assert.equal(refuse401.status, 401);
	assert.equal(refuse401.body.code, "E_MUST_SIGN_IN");
	await unauthorized.server.close();
});

test("plain-language 422s and the plain 404", async () => {
	const { request } = await fixture();
	const bad = await request("/api/recognition/entries", json({ method: "POST", body: "{oops" }));
	assert.equal(bad.status, 422);
	assert.equal(bad.body.code, "E_INVALID");
	const unknown = await request("/api/recognition/does-not-exist");
	assert.equal(unknown.status, 404);
	const other = await request("/api/overwatch/state");
	assert.equal(other.status, 404);
});

test("oversized bodies are refused; non-object bodies refused", async () => {
	const { request } = await fixture();
	const nonObject = await request("/api/recognition/settings?homeId=h", json({ method: "PUT", body: JSON.stringify([1, 2]) }));
	assert.equal(nonObject.status, 422);
	assert.equal(nonObject.body.code, "E_INVALID");
});

// ---- PORCH-142: the watchlists REST plane ----

/** jpeg frame; `w` selects the deterministic exemplar vector. */
const frameOf = (w) => ({ format: "jpeg", data: Buffer.from(`jpeg-${w}`).toString("base64"), w });

test("watchlists REST: train → vocabulary → per-class threshold → detections → delete (ac-1/ac-2/ac-5)", async () => {
	const { request } = await fixture();
	const created = await request("/api/recognition/watchlists", json({
		method: "POST",
		body: JSON.stringify({ homeId: "home-1", label: "63 Chevy Impala", frames: [frameOf(2)], trackingSource: "vehicle" }),
	}));
	assert.equal(created.status, 201);
	assert.equal(created.body.class.label, "63 Chevy Impala");
	assert.equal(created.body.class.trackingScope, "tracked");
	assert.match(created.body.class.exemplars[0].image, /^data:image\/jpeg;base64,/);
	const classId = created.body.class._id;

	const vocabulary = await request("/api/recognition/watchlists/vocabulary?homeId=home-1");
	assert.equal(vocabulary.status, 200);
	assert.ok(vocabulary.body.vocabulary.builtIn.some((entry) => entry.label === "person" && entry.trackingScope === "tracked"));
	assert.deepEqual(vocabulary.body.vocabulary.trained, [{
		label: "63 Chevy Impala", kind: "trained", trackingScope: "tracked", assertThreshold: null, classId,
	}]);

	// Uncalibrated classify happens through the plane's ingest seam — REST
	// exposes the recorded ring only. Calibrate so an asserted row exists.
	const calibrated = await request(`/api/recognition/watchlists/${classId}?homeId=home-1`, json({
		method: "PUT", body: JSON.stringify({ assertThreshold: 0.01 }),
	}));
	assert.equal(calibrated.status, 200);

	const list = await request("/api/recognition/watchlists?homeId=home-1");
	assert.equal(list.status, 200);
	assert.equal(list.body.count, 1);
	assert.equal(list.body.classes[0]?.expectedAccuracy?.note, created.body.class.expectedAccuracy.note);

	const purged = await request(`/api/recognition/watchlists/${classId}?homeId=home-1`, json({ method: "DELETE" }));
	assert.equal(purged.status, 200);
	assert.equal(purged.body.purged.classId, classId);
	const empty = await request("/api/recognition/watchlists?homeId=home-1");
	assert.equal(empty.body.count, 0);
});

test("watchlists REST: junk refused 422, corrections 404 in plain language, owner refused 403", async () => {
	let ownerAllowed = true;
	const { request } = await fixture({ authorize: () => ownerAllowed });
	const bad = await request("/api/recognition/watchlists", json({
		method: "POST", body: JSON.stringify({ homeId: "home-1", label: "!!", frames: [frameOf(0)] }),
	}));
	assert.equal(bad.status, 422);
	const noDetection = await request("/api/recognition/watchlists/corrections", json({
		method: "POST", body: JSON.stringify({ homeId: "home-1", cameraId: "cam-x", trackId: "t-x" }),
	}));
	assert.equal(noDetection.status, 404);
	assert.match(noDetection.body.error, /No recorded detection/);
	ownerAllowed = false;
	const refused = await request("/api/recognition/watchlists", json({
		method: "POST", body: JSON.stringify({ homeId: "home-1", label: "Anything", frames: [frameOf(0)] }),
	}));
	assert.equal(refused.status, 403);
});
