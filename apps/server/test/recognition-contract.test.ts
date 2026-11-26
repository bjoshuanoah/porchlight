import { test } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import fsDefault from "node:fs";
import pathDefault from "node:path";
import osDefault from "node:os";
import type { Server } from "node:http";
import type { StoreLike } from "@porchlight/shared";
import { createMemoryStore } from "@porchlight/shared";
import type { RecognitionPlane } from "../src/recognition-plane.js";
import { createRecognitionPlaneRouter } from "../src/recognition-plane.js";

/**
 * PORCH-141 transport contract: the People & Things plane rides the hub's
 * adapter shape (same as the overwatch plane) — bearer identity seam, home
 * owner perimeter (export owner-only), Mongo registry collections, the
 * audit file under the hub root, and the engine-bus ingest seam where the
 * recognition switch of record bites BEFORE any run.
 */

interface Json { [key: string]: unknown }

const MOM_DESCRIPTOR = [0.95, 0.3, 0.05];

function provider() {
	return {
		name: "contract-embedder",
		async describeFaces() {
			return [{ descriptor: MOM_DESCRIPTOR, conf: 0.99 }];
		},
		async readPlates() {
			return [{ text: "6tri889", conf: 0.93 }];
		},
	};
}

interface Harness {
	server: Server;
	port: Promise<number>;
	root: string;
	plane: RecognitionPlane;
	store: StoreLike;
	servedHomes: Json;
}

/** Owner/member stub identity + home-authorize seam (the hub contract, without the full identity flow). */
function harness({ owner = true, enableProvider = true } = {}): Harness {
	const identityAuth = {
		verifyAccessToken: async (token: string) =>
			token === "owner-token" ? { did: "did:porch:owner", sessionId: "s1" } : token === "member-token" ? { did: "did:porch:member", sessionId: "s2" } : null,
	};
	const homeModule = {
		homeService: {
			authorize: async (args: { accessToken: string; homeId: string }) => ({
				did: args.accessToken === "owner-token" ? "did:porch:owner" : "did:porch:member",
				role: args.accessToken === "owner-token" && owner ? "owner" : "member",
			}),
		},
	};
	const root = fsDefault.mkdtempSync(pathDefault.join(osDefault.tmpdir(), "porch-recognition-"));
	const store = createMemoryStore();
	store.collection("cameras").insertOne({ _id: "cam_1", homeId: "home-1", engineCameraId: "eng_cam1", name: "Front door" });
	const plane = createRecognitionPlaneRouter({
		root,
		store,
		identityAuth,
		homeModule,
		visionProviderFactory: enableProvider ? provider : null,
		homeForCamera: async (engineCameraId: string) => {
			const camera = await store.collection("cameras").findOne({ engineCameraId });
			return camera ? { homeId: String(camera.homeId), cameraId: String(camera.engineCameraId) } : null;
		},
		log: () => {},
	});
	const app = express();
	app.use(express.json());
	app.use("/api/recognition", plane.router);
	const { promise: port, resolve: resolvePort } = Promise.withResolvers<number>();
	const server = app.listen(0, "127.0.0.1", () => resolvePort((server.address() as { port: number }).port));
	return { server, port, root, plane, store, servedHomes: { "home-1": "did:porch:owner" } };
}

async function api(h: Harness, method: string, pathname: string, body?: object, token = "owner-token") {
	const res = await fetch(`http://127.0.0.1:${await h.port}${pathname}`, {
		method,
		headers: { ...(body === undefined ? {} : { "content-type": "application/json" }), authorization: `Bearer ${token}` },
		body: body === undefined ? undefined : JSON.stringify(body),
	});
	const text = await res.text();
	return { status: res.status, body: text.trim() === "" ? null : (JSON.parse(text) as Json) };
}

test("recognition vertical: settings toggle of record round-trips through the hub plane (contract)", async (t) => {
	const h = harness();
	t.after(async () => {
		await new Promise((resolve) => h.server.close(() => resolve(undefined)));
	});
	// Opt-in default: a household that never opted in reads disabled.
	const initial = await api(h, "GET", "/api/recognition/settings?homeId=home-1");
	assert.equal(initial.status, 200);
	const initialSettings = initial.body as { settings: { enabled: boolean } };
	assert.equal(initialSettings.settings.enabled, false);
	const on = await api(h, "PUT", "/api/recognition/settings?homeId=home-1", { enabled: true, actorDid: "did:porch:owner" });
	const onSettings = on.body as { settings: { enabled: boolean; updatedBy: string | null } };
	assert.equal(onSettings.settings.enabled, true);
	assert.equal(onSettings.settings.updatedBy, "did:porch:owner");
	// Unauthenticated refusals take the home surfaces' plain posture.
	const anonymous = await api(h, "GET", "/api/recognition/settings?homeId=home-1", undefined, "bogus");
	assert.equal(anonymous.status, 401);
	assert.equal(anonymous.body?.code, "E_MUST_SIGN_IN");
});

test("recognition vertical: the owner gates writes and gates the export; members read (contract)", async (t) => {
	const h = harness();
	t.after(async () => {
		await new Promise((resolve) => h.server.close(() => resolve(undefined)));
	});
	await api(h, "PUT", "/api/recognition/settings?homeId=home-1", { enabled: true });
	const frame = Buffer.from([0xff, 0xd8, 0xff, 0xe0]).toString("base64");
	const memberEnroll = await api(h, "POST", "/api/recognition/entries", { homeId: "home-1", kind: "face", name: "Mom", frames: [{ format: "jpeg", data: frame }] }, "member-token");
	assert.equal(memberEnroll.status, 403);
	assert.equal(memberEnroll.body?.code, "E_NOT_PERMITTED");
	const memberRead = await api(h, "GET", "/api/recognition/entries?homeId=home-1", undefined, "member-token");
	assert.equal(memberRead.status, 200);
	// The biometric export leaves only through the owner's own act (ac-5).
	const memberExport = await api(h, "GET", "/api/recognition/export?homeId=home-1", undefined, "member-token");
	assert.equal(memberExport.status, 403);
	const ownerExport = await api(h, "GET", "/api/recognition/export?homeId=home-1");
	assert.equal(ownerExport.status, 200);
});

test("recognition vertical: enroll → annotate → purge lands the purge audit under the hub root (contract)", async (t) => {
	const h = harness();
	t.after(async () => {
		await new Promise((resolve) => h.server.close(() => resolve(undefined)));
	});
	await api(h, "PUT", "/api/recognition/settings?homeId=home-1", { enabled: true });
	const frame = Buffer.from([0xff, 0xd8, 0xff, 0xe0]).toString("base64");
	const enroll = await api(h, "POST", "/api/recognition/entries", { homeId: "home-1", kind: "face", name: "Mom", frames: [{ format: "jpeg", data: frame }] });
	assert.equal(enroll.status, 201);
	assert.equal((enroll.body as { entry: { name: string } }).entry.name, "Mom");
	const entryId = String((enroll.body as { entry: { _id: string } }).entry._id);
	// The ingest seam: a bus detection carrying local recognition evidence
	// annotates by reference (entity/track surface join).
	await h.plane.ingestEngineDetection({ camera: "eng_cam1", trackId: "t-9", cls: "person", conf: 0.9, t: 120, reid: MOM_DESCRIPTOR });
	const byTrack = await api(h, "GET", "/api/recognition/annotations?homeId=home-1&trackId=t-9");
	assert.equal(byTrack.body?.count, 1);
	const byTrackRows = (byTrack.body as { annotations: Array<{ entryId: string; decision: string }> }).annotations;
	assert.equal(byTrackRows[0].entryId, entryId);
	assert.equal(byTrackRows[0].decision, "looks-like");
	// The purge removes the entry, the annotation, and counts what went away;
	// the purge audit lands under the hub root of record.
	const purge = await api(h, "DELETE", `/api/recognition/entries/${entryId}?homeId=home-1`, { actorDid: "did:porch:owner" });
	assert.equal(purge.status, 200);
	assert.deepEqual(purge.body?.purged, { entryId, descriptorVectors: 1, plateReads: 0, sightings: 1, annotations: 1 });
	assert.equal((await api(h, "GET", "/api/recognition/annotations?homeId=home-1&trackId=t-9")).body?.count, 0);
	const audit = JSON.parse(fsDefault.readFileSync(pathDefault.join(h.root, "config", "recognition", "audit.jsonl"), "utf8").trim().split("\n").at(-1) as string) as Json;
	assert.equal(audit.type, "registry-entry-purge");
	assert.equal((audit.detail as Json).entryId, entryId);
});

test("recognition vertical: the switch of record bites the ingest seam BEFORE any run (contract)", async (t) => {
	const h = harness();
	t.after(async () => {
		await new Promise((resolve) => h.server.close(() => resolve(undefined)));
	});
	// Off: a detection bearing recognition evidence does NOT run (the
	// zero-computation posture of ac-4/ac-6) — no annotations appear.
	await h.plane.ingestEngineDetection({ camera: "eng_cam1", trackId: "t-1", cls: "person", conf: 0.9, t: 10, reid: MOM_DESCRIPTOR });
	assert.equal((await api(h, "GET", "/api/recognition/annotations?homeId=home-1")).body?.count, 0);
	// Bare detections (today's engine reality: no reid, no plate) never run.
	await api(h, "PUT", "/api/recognition/settings?homeId=home-1", { enabled: true });
	await h.plane.ingestEngineDetection({ camera: "eng_cam1", trackId: "t-2", cls: "person", conf: 0.9, t: 20 });
	assert.equal((await api(h, "GET", "/api/recognition/annotations?homeId=home-1")).body?.count, 0);
	// Unregistered cameras resolve nothing.
	await h.plane.ingestEngineDetection({ camera: "eng_cam_ghost", trackId: "t-3", reid: MOM_DESCRIPTOR });
	assert.equal((await api(h, "GET", "/api/recognition/annotations?homeId=home-1")).body?.count, 0);
	// Enroll the gallery face; toggling back on resumes without re-enrollment.
	const frame = Buffer.from([0xff, 0xd8, 0xff, 0xe0]).toString("base64");
	await api(h, "POST", "/api/recognition/entries", { homeId: "home-1", kind: "face", name: "Mom", frames: [{ format: "jpeg", data: frame }] });
	// On: the same evidence runs, the sighting + annotation land.
	await h.plane.ingestEngineDetection({ camera: "eng_cam1", trackId: "t-9", cls: "person", conf: 0.9, t: 120, reid: MOM_DESCRIPTOR });
	assert.equal((await api(h, "GET", "/api/recognition/annotations?homeId=home-1&trackId=t-9")).body?.count, 1);
	const metrics = await api(h, "GET", "/api/recognition/metrics?homeId=home-1");
	assert.equal(Object((metrics.body as { metrics: { recognitionRuns: number; descriptorComputations: number } }).metrics).recognitionRuns, 2, "one enrollment pipeline run + one bus-borne match run — descriptors never recomputed");
	// Toggling off stops runs immediately; the registry still renders.
	await api(h, "PUT", "/api/recognition/settings?homeId=home-1", { enabled: false });
	await h.plane.ingestEngineDetection({ camera: "eng_cam1", trackId: "t-10", reid: MOM_DESCRIPTOR });
	assert.equal((await api(h, "GET", "/api/recognition/annotations?homeId=home-1&trackId=t-10")).body?.count, 0);
	assert.equal((await api(h, "GET", "/api/recognition/entries?homeId=home-1")).body?.count, 1);
});

test("recognition vertical: no provider factory = enrollment fails closed with plain language (contract)", async (t) => {
	const h = harness({ enableProvider: false });
	t.after(async () => {
		await new Promise((resolve) => h.server.close(() => resolve(undefined)));
	});
	await api(h, "PUT", "/api/recognition/settings?homeId=home-1", { enabled: true });
	const refused = await api(h, "POST", "/api/recognition/entries", { homeId: "home-1", kind: "face", name: "Mom" });
	assert.equal(refused.status, 422);
	assert.match(String(refused.body?.error), /descriptor/);
	// Registry surfaces still ride: settings, entries, export.
	const settingsAfter = (await api(h, "GET", "/api/recognition/settings?homeId=home-1")).body as { settings: { enabled: boolean } };
	assert.equal(settingsAfter.settings.enabled, true);
});
