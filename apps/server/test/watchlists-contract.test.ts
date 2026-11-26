import { test } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import fsDefault from "node:fs";
import pathDefault from "node:path";
import osDefault from "node:os";
import { canonicalJson, createMemoryStore, type StoreLike } from "@porchlight/shared";
import type { Server } from "node:http";
import type { RecognitionPlane } from "../src/recognition-plane.js";
import { createRecognitionPlaneRouter } from "../src/recognition-plane.js";
import { TRACKED_CLASSES } from "@porchlight/overwatch";
import { assembleHomeModule } from "@porchlight/home";
import { generateKeyPairSync, sign as nodeSign } from "node:crypto";

/**
 * PORCH-142 transport contract: the watchlists vertical rides the SAME hub
 * plane shape as People & Things — bearer identity seam, home owner
 * perimeter, Mongo store of record — and the trainable-class emission path
 * runs classify-on-ingest, never gated by the biometric recognition switch
 * (the opt-in law governs faces/plates only; watchlists train on the
 * household's own taught crops and never leave the hub except as plain
 * classification facts on the detections bus). The emitted detection rides
 * into the home module's event pipeline + automation rules: the full
 * train → calibrate → assert → emit → automation-fire path.
 */

interface Json { [key: string]: unknown }

/** The provider's exemplar embedder of record — deterministic unit vectors. */
const EMBEDDING_DIM = 6;
/** The in-class exemplar direction (the TRAIN_FRAME byte of record picks it). */
const EXEMPLAR_AXIS = 0xff % EMBEDDING_DIM;
/** A near-neighbor direction at cosine 0.7 with the exemplar — above the
 * 0.6 looks-like floor so it renders "looks like", below a 0.75 assert
 * threshold so it never asserts. */
const NEAR_COMPONENT = Math.sqrt(1 - 0.7 * 0.7);
const NEAR_AXIS = (EXEMPLAR_AXIS + 1) % EMBEDDING_DIM;
const NEAR_FRAME = Buffer.from([0x01]).toString("base64");

function embedFor(data: string): number[] {
	const head = Buffer.from(data, "base64")[0];
	if (head === 0x01) {
		const near = new Array(EMBEDDING_DIM).fill(0);
		near[EXEMPLAR_AXIS] = 0.7;
		near[NEAR_AXIS] = NEAR_COMPONENT;
		return near;
	}
	const v = new Array(EMBEDDING_DIM).fill(0);
	v[head % EMBEDDING_DIM] = 1;
	return v;
}

const MATCH_VECTOR = embedFor(Buffer.from([0xff, 0xd8, 0xff, 0xe0]).toString("base64"));

function provider() {
	return {
		name: "contract-embedder",
		async describeFaces() {
			return [];
		},
		/** One vector per uploaded frame (the qwen3-embedding-class seam). */
		async embedImage(frame: { format: string; data: string }) {
			return [embedFor(String(frame.data))];
		},
	};
}

interface Harness {
	server: Server;
	port: Promise<number>;
	root: string;
	plane: RecognitionPlane;
	store: StoreLike;
	published: Array<{ camera: string; trackId: string; cls: string; conf: number; t?: number; provider: string }>;
	vocabularyChanges: string[][];
}

/** Owner/member stub identity + home-authorize seam + the emission fakes. */
function harness(): Harness {
	const identityAuth = {
		verifyAccessToken: async (token: string) =>
			token === "owner-token" ? { did: "did:porch:owner", sessionId: "s1" } : token === "member-token" ? { did: "did:porch:member", sessionId: "s2" } : null,
	};
	const homeModule = {
		homeService: {
			authorize: async (args: { accessToken: string; homeId: string }) => ({
				did: args.accessToken === "owner-token" ? "did:porch:owner" : "did:porch:member",
				role: args.accessToken === "owner-token" ? "owner" : "member",
			}),
		},
	};
	const root = fsDefault.mkdtempSync(pathDefault.join(osDefault.tmpdir(), "porch-watchlists-"));
	const store = createMemoryStore();
	store.collection("cameras").insertOne({ _id: "cam_1", homeId: "home-1", engineCameraId: "eng_cam1", name: "Front door" });
	const published: Harness["published"] = [];
	const vocabularyChanges: Harness["vocabularyChanges"] = [];
	const plane = createRecognitionPlaneRouter({
		root,
		store,
		identityAuth,
		homeModule,
		visionProviderFactory: provider,
		trackedClasses: [...TRACKED_CLASSES],
		publishDetection: async (detection) => {
			published.push(detection);
		},
		onVocabularyChanged: async (labels) => {
			vocabularyChanges.push(labels);
		},
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
	return { server, port, root, plane, store, published, vocabularyChanges };
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

const TRAIN_FRAME = Buffer.from([0xff, 0xd8, 0xff, 0xe0]).toString("base64");

test("watchlists vertical: create → vocabulary → calibrate → assert → emit (contract)", async (t) => {
	const h = harness();
	t.after(async () => {
		await new Promise((resolve) => h.server.close(() => resolve(undefined)));
	});
	// Train: two taught examples land as data-URL exemplars with the honest
	// few-shot bound — and the REST view carries NO raw descriptors. The
	// class's examples came from a built-in tracked class (the flagged
	// vehicle crop), so its tracking scope derives "tracked".
	const created = await api(h, "POST", "/api/recognition/watchlists", {
		homeId: "home-1",
		label: "Blue Sedan",
		trackingSource: "vehicle",
		frames: [{ format: "jpeg", data: TRAIN_FRAME }, { format: "jpeg", data: Buffer.from([0x00, 0x10, 0x20]).toString("base64") }],
	});
	assert.equal(created.status, 201);
	const cls = (created.body as { class: Json }).class;
	assert.equal(cls.label, "Blue Sedan");
	assert.equal(cls.exemplarCount, 2);
	assert.equal(cls.trackingScope, "tracked");
	assert.equal(cls.trackingSource, "vehicle");
	const exemplars = cls.exemplars as Array<{ image: string; origin: string }>;
	assert.equal(exemplars[0].image.startsWith("data:image/jpeg;base64,"), true);
	assert.equal(exemplars[0].origin, "train");
	assert.equal(JSON.stringify(cls).includes('"descriptor"'), false, "raw descriptors never leave the hub");
	assert.ok((cls.expectedAccuracy as Json) !== null && (cls.expectedAccuracy as { hitRate: number | null }).hitRate !== undefined);
	// The vocabulary lists the trained label among the built-in tracked set.
	const vocabulary = await api(h, "GET", "/api/recognition/watchlists/vocabulary?homeId=home-1");
	assert.equal(vocabulary.status, 200);
	const shape = (vocabulary.body as { vocabulary: { builtIn: Json[]; trained: Json[] } }).vocabulary;
	assert.equal(shape.builtIn.length, TRACKED_CLASSES.length);
	const trained = shape.trained as Array<{ label: string; kind: string; classId: string; trackingScope: string }>;
	assert.ok(trained.some((item) => item.label === "Blue Sedan" && item.kind === "trained" && item.classId === String(cls._id)));
	// Calibrate: the class asserts only at or above its threshold.
	const calibrated = await api(h, "PUT", `/api/recognition/watchlists/${String(cls._id)}?homeId=home-1`, { assertThreshold: 0.75 });
	assert.equal(calibrated.status, 200);
	assert.equal((calibrated.body as { class: { assertThreshold: number } }).class.assertThreshold, 0.75);

	// Ingest: an in-class descriptor asserts and EMITS — with the biometric
	// recognition switch left OFF (watchlists are not gated by the opt-in
	// law; the emitted fact rides the plain detections shape).
	await h.plane.ingestEngineDetection({ camera: "eng_cam1", trackId: "t-5", cls: "vehicle", conf: 0.9, t: 120, reid: [...MATCH_VECTOR] });
	assert.equal(h.published.length, 1, "the asserted detection emitted exactly once");
	assert.deepEqual(h.published[0], { camera: "eng_cam1", trackId: "t-5", cls: "Blue Sedan", conf: 1, t: 120, provider: "watchlist" });
	// The event dedup window holds: the same track re-ingests without a
	// second emission (bounded re-emission).
	await h.plane.ingestEngineDetection({ camera: "eng_cam1", trackId: "t-5", cls: "vehicle", conf: 0.9, t: 130, reid: [...MATCH_VECTOR] });
	assert.equal(h.published.length, 1);
	// A near neighbor at cosine 0.7 renders "looks like" and never emits.
	await h.plane.ingestEngineDetection({ camera: "eng_cam1", trackId: "t-6", cls: "vehicle", conf: 0.9, t: 140, reid: [...embedFor(NEAR_FRAME)] });
	assert.equal(h.published.length, 1, "below-threshold detections never emit");
	const detections = await api(h, "GET", `/api/recognition/watchlists/${String(cls._id)}/detections?homeId=home-1`);
	assert.equal(detections.status, 200);
	const rows = (detections.body as { detections: Array<{ label: string; decision: string; confidence: number; emitted: boolean; trackId?: string }> }).detections;
	assert.deepEqual(
		rows.map((row) => row.decision).sort(),
		["asserted", "asserted", "looks-like"],
		"one deduped asserted row + one emitted asserted row + one looks-like row",
	);
	assert.equal(rows.filter((row) => row.emitted === true).length, 1, "exactly one emitted detection for the trained label");
	assert.ok(rows.every((row) => row.trackId !== undefined), "the rows carry the camera/track provenance for corrections");
	assert.equal(JSON.stringify(rows).includes("descriptor"), false, "no descriptor ever rides a detection row");

	// Delete: the class purges with counts, the vocabulary empties, and the
	// detection rows go with it.
	assert.ok(h.vocabularyChanges.some((labels) => labels.includes("Blue Sedan")), "mutations re-extend the tracked vocabulary");
	const purged = await api(h, "DELETE", `/api/recognition/watchlists/${String(cls._id)}?homeId=home-1`, { actorDid: "did:porch:owner" });
	assert.equal(purged.status, 200);
	const count = (purged.body as { purged: { classId: string; exemplars: number; detections: number } }).purged;
	assert.equal(count.classId, String(cls._id));
	assert.equal(count.exemplars, 2);
	assert.equal(count.detections, 3);
	const empty = await api(h, "GET", "/api/recognition/watchlists/vocabulary?homeId=home-1");
	assert.deepEqual((empty.body as { vocabulary: { trained: Json[] } }).vocabulary.trained, []);
	const gone = await api(h, "GET", `/api/recognition/watchlists/${String(cls._id)}?homeId=home-1`);
	assert.equal(gone.status, 404);
});

/** The home-module surface the automation-fire proof drives (the ambient
 *  @porchlight/home types narrow the router's subset only; the services run
 *  for real over their own store). */
interface HomeMod {
	adapters: { register(adapter: object): unknown };
	homeService: { create(args: object): Promise<{ home: { _id: string } }> };
	areaService: { create(args: object): Promise<{ area: { _id: string } }> };
	deviceService: { register(args: object): Promise<{ device: { _id: string } }> };
	automationService: {
		create(args: object): Promise<{ automation: { _id: string } }>;
		handleEvent(args: { homeId: string; eventClass: string; at?: string }): Promise<{ fired: Array<{ results: Array<{ outcome: string }> }> }>;
	};
	eventService: { ingest(detection: { camera: string; trackId: string; cls: string; conf: number; t: number }): Promise<{ event: { _id: string } | null; created: boolean; ignored: string | null }> };
}

/** One device-bound identity: a real signed session + enrolled device key
 *  (exactly the home fixture's identity mint, typed for this test). */
function identity(sessions: Map<string, { did: string; deviceId: string }>, deviceKeys: Map<string, object>, did: string) {
	const deviceId = `dev_${crypto.randomUUID().slice(0, 8)}`;
	const token = `tok_${crypto.randomUUID()}`;
	const { publicKey, privateKey } = generateKeyPairSync("ed25519");
	const publicKeyJwk = publicKey.export({ format: "jwk" }) as object;
	sessions.set(token, { did, deviceId });
	deviceKeys.set(`${did}:${deviceId}`, publicKeyJwk);
	return {
		token,
		/** A signed write body for the service call shape (payload, signature). */
		write(payload: object) {
			return { payload, signature: nodeSign(null, Buffer.from(canonicalJson(payload), "utf8"), privateKey).toString("base64url") };
		},
	};
}

/** The home module assembled over its own store (the REAL services, like
 *  the home tests run) with the SAME engine camera of record, one outdoor
 *  area + a switch device, and the rule the trained label should fire. */
async function automationHarness(): Promise<{ owner: { token: string; write(payload: object): { payload: object; signature: string } }; homeId: string; mod: HomeMod }> {
	const homeStore = createMemoryStore();
	const sessions = new Map<string, { did: string; deviceId: string }>();
	const deviceKeys = new Map<string, object>();
	const owner = identity(sessions, deviceKeys, "did:porch:home-owner");
	const mod = assembleHomeModule(homeStore, {
		verifySession: (token: string | null) => Promise.resolve(sessions.get(String(token ?? "")) ?? null),
		registeredDeviceKey: (did: string, deviceId: string) => {
			const jwk = deviceKeys.get(`${did}:${deviceId}`);
			return Promise.resolve(jwk ? { publicKeyJwk: jwk } : null);
		},
		orgId: () => null,
	}) as unknown as HomeMod;
	// The one contract-test adapter: a switch device whose turnOn confirms.
	let on = false;
	mod.adapters.register({
		name: "test",
		commandsFor: () => ["turnOn", "turnOff"],
		send: async ({ command }: { command: string }) => {
			on = command === "turnOn";
			return { state: { on } };
		},
		readState: async () => ({ state: { on } }),
	});
	const home = (await mod.homeService.create({ accessToken: owner.token, ...owner.write({ name: "Fieldstone" }) })).home;
	const porch = (await mod.areaService.create({ accessToken: owner.token, homeId: home._id, ...owner.write({ name: "Porch", kind: "outdoor" }) })).area;
	const device = (await mod.deviceService.register({
		accessToken: owner.token,
		homeId: home._id,
		...owner.write({ name: "Porch light", areaId: porch._id, capabilities: ["switch"], adapter: { name: "test", binding: "matter-node-2" } }),
	})).device;
	// The engine camera of record joins the home: the emitted detection
	// resolves through this association into a family event.
	homeStore.collection("cameras").insertOne({ _id: "cam_h1", homeId: home._id, engineCameraId: "eng_cam1", name: "Front door" });
	await mod.automationService.create({
		accessToken: owner.token,
		homeId: home._id,
		...owner.write({
			name: "Blue Sedan arrived",
			trigger: { eventClass: "Blue Sedan", areaId: null },
			actions: [{ deviceId: device._id, command: "turnOn" }],
		}),
	});
	return { owner, homeId: String(home._id), mod };
}

test("watchlists vertical: the emitted detection fires the home module's automations (contract)", async (t) => {
	const h = harness();
	t.after(async () => {
		await new Promise((resolve) => h.server.close(() => resolve(undefined)));
	});
	// Train + calibrate the class, exactly like the household does.
	const created = await api(h, "POST", "/api/recognition/watchlists", {
		homeId: "home-1",
		label: "Blue Sedan",
		trackingSource: "vehicle",
		frames: [{ format: "jpeg", data: TRAIN_FRAME }],
	});
	assert.equal(created.status, 201);
	const classId = String((created.body as { class: Json }).class._id);
	const calibrated = await api(h, "PUT", `/api/recognition/watchlists/${classId}?homeId=home-1`, { assertThreshold: 0.75 });
	assert.equal(calibrated.status, 200);

	const home = await automationHarness();
	// The plane asserts at the camera and emits; the emitted fact feeds the
	// home module's event pipeline and the automation rule fires.
	await h.plane.ingestEngineDetection({ camera: "eng_cam1", trackId: "t-auto", cls: "vehicle", conf: 0.9, t: 1000, reid: [...MATCH_VECTOR] });
	assert.equal(h.published.length, 1);
	const emitted = h.published[0];
	const ingested = await home.mod.eventService.ingest({
		camera: emitted.camera,
		trackId: emitted.trackId,
		cls: emitted.cls,
		conf: emitted.conf,
		t: emitted.t as number,
	});
	assert.ok(ingested.event, "the emitted detection opens a home event");
	const outcome = await home.mod.automationService.handleEvent({
		homeId: home.homeId,
		eventClass: emitted.cls,
		at: new Date(Number(emitted.t) * 1000).toISOString(),
	});
	assert.equal(outcome.fired.length, 1, "the trained label drives the automation of record");
	assert.equal(outcome.fired[0].results[0].outcome, "confirmed");
});
