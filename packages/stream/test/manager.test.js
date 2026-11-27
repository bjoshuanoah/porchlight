// manager.test.js — StreamManager: fleet diff, relay fan-out + slow-socket
// guard, health shape, control HTTP, in-process subscriptions (PORCH-154).
// Real node:net relay listeners; ffmpeg excluded through the injected factory.

import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import http from "node:http";
import net from "node:net";
import { PassThrough } from "node:stream";

import { StreamManager } from "../src/manager.js";
import { NullStreamHealthBus, streamHealthTopic } from "../src/health-bus.js";

const BASE = 18972;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** @param {number} port @param {string} method @param {string} pathname @param {unknown} [body] */
function call(port, method, pathname, body) {
	return new Promise((resolve, reject) => {
		const payload = body === undefined ? null : JSON.stringify(body);
		const req = http.request(
			{
				host: "127.0.0.1",
				port,
				method,
				path: pathname,
				// No keep-alive: each test boots/stops its own manager on the same
				// address, and a pooled socket of a stopped server resets mid-test.
				agent: new http.Agent({ keepAlive: false }),
				headers: payload === null ? undefined : { "content-type": "application/json", "content-length": Buffer.byteLength(payload) },
			},
			(res) => {
				let raw = "";
				res.on("data", (c) => (raw += c));
				res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: raw, json: /* json */ (() => { try { return JSON.parse(raw); } catch { return null; } })() }));
			},
		);
		req.on("error", reject);
		req.end(payload ?? undefined);
	});
}

/** @param {() => unknown} fn @param {number} [timeoutMs] @returns {Promise<any>} */
async function waitFor(fn, timeoutMs = 3000) {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		const v = fn();
		if (v) return v;
		if (Date.now() > deadline) throw new Error("waitFor: condition not met in time");
		await sleep(15);
	}
}

/**
 * The open-counting factory seam: every CameraSource open lands here, keyed
 * by camera name, so the keep/mutate diff assertions count real reopens and
 * tests can drive lane bytes through the newest handle.
 */
function makeFactory() {
	/** @type {Record<string, { count: number, latest: any }>} */
	const opens = {};
	const factory = (camera) => {
		const handle = new EventEmitter();
		handle.stdout = new PassThrough();
		handle.stderr = new PassThrough();
		handle.stdio = [null, handle.stdout, handle.stderr, new PassThrough(), new PassThrough(), new PassThrough()];
		handle.killed = false;
		handle.kill = (sig) => {
			handle.killed = true;
			handle.killSignals = [...(handle.killSignals ?? []), sig ?? "SIGTERM"];
			handle.emit("close", null, "SIGTERM");
		};
		const slot = (opens[camera.name] ??= { count: 0, latest: null });
		slot.count += 1;
		slot.latest = handle;
		return handle;
	};
	return { factory, opens };
}

/**
 * @param {any[]} cameras
 * @param {{ relBufferMax?: number, relStallMs?: number, bus?: any, base?: number }} [opts]
 */
async function makeManager(cameras, opts = {}) {
	const bus = opts.bus ?? new NullStreamHealthBus();
	const made = makeFactory();
	const manager = new StreamManager({
		config: { streams: { base: opts.base ?? BASE }, cameras },
		bus,
		factory: made.factory,
		backoffMs: [10, 20],
		relayBufferMax: opts.relBufferMax ?? (4 * 1024 * 1024),
		relayStallMs: opts.relStallMs ?? 500,
		log: () => {},
	});
	return { manager, bus, opens: made.opens };
}

const urlCam = (name) => ({ name, source: { url: `rtsp://cam/${name}`, width: 64, height: 48 } });

/** Drive rgb lane bytes so the newest handle's source turns live. */
function feedRgb(opens, name, w, h, frames = 1) {
	const frame = Buffer.alloc(w * h * 3, 3);
	const lanes = opens[name].latest.stdio;
	for (let i = 0; i < frames; i++) lanes[3].write(frame);
}

test("applyFleet diff: add / keep / mutate (close+reopen) / remove with relay ports in codepoint order", async (t) => {
	const { manager, opens } = await makeManager([]);
	t.after(() => manager.stop().catch(() => {}));
	await manager.start();
	await manager.applyPromise;

	// ADD two cameras: ports follow base+1+sortedIndex (plain codepoint sort)
	const fleet = [urlCam("sidewalk"), urlCam("front-door")];
	let applied = await manager.applyFleet(fleet);
	assert.deepEqual([...applied.added].sort(), ["front-door", "sidewalk"]);
	assert.deepEqual(applied.ports, { "front-door": BASE + 1, sidewalk: BASE + 2 });
	assert.equal(manager.sources.size, 2);
	assert.equal(manager.relays.get("front-door")?.port, BASE + 1);
	assert.equal(manager.relays.get("sidewalk")?.port, BASE + 2);

	// KEEP an unchanged name: no reopen
	await manager.applyFleet(fleet);
	assert.equal(opens["front-door"].count, 1);

	// MUTATE front-door's source: close+reopen on the same name
	const mutated = [{ name: "front-door", source: { url: "rtsp://cam/other", width: 64, height: 48 } }, urlCam("sidewalk")];
	const waitApply = manager.applyFleet(mutated);
	assert.equal(opens["front-door"].latest.killed, true, "the mutated writer is stopped before rebuild");
	applied = await waitApply;
	assert.deepEqual(applied.mutated, ["front-door"]);
	assert.equal(opens["front-door"].count, 2);

	// REMOVE sidewalk: source and relay listener are gone
	applied = await manager.applyFleet([mutated[0]]);
	assert.deepEqual(applied.removed, ["sidewalk"]);
	assert.equal(manager.sources.has("sidewalk"), false);
	assert.equal(manager.relays.has("sidewalk"), false);
	await manager.stop();
});

test("health(): closed state set with reason/at/relayPort/consumers; missing-dims refusal never opens", async (t) => {
	const { manager, opens } = await makeManager([urlCam("front-door"), { name: "blind", source: { url: "rtsp://cam/blind" } }]);
	t.after(() => manager.stop().catch(() => {}));
	await manager.start();
	await manager.applyPromise;
	assert.equal(opens.blind, undefined, "no upstream open without dimensions");
	const h = manager.health();
	assert.equal(h.state, "degraded");
	assert.deepEqual(h.cameras.map((c) => c.name).sort(), ["blind", "front-door"]);
	const blind = h.cameras.find((c) => c.name === "blind");
	assert.equal(blind.state, "down");
	assert.match(blind.reason ?? "", /source\.width\/source\.height/);
	assert.equal(blind.relayPort, BASE + 1, "ports derive for the whole codepoint-sorted fleet");
	const front = h.cameras.find((c) => c.name === "front-door");
	assert.equal(front.state, "opening");
	assert.equal(front.relayPort, BASE + 2);
	assert.equal(typeof front.at, "number");
	await manager.stop();
});

test("empty fleet: the manager starts idle and says so", async (t) => {
	const { manager } = await makeManager([]);
	t.after(() => manager.stop().catch(() => {}));
	await manager.start();
	await manager.applyPromise;
	assert.equal(manager.health().state, "idle");
	assert.deepEqual(manager.health().cameras, []);
	await manager.stop();
});

test("relay fan-out: every connected socket receives the exact mpegts bytes", async (t) => {
	const { manager, opens } = await makeManager([urlCam("front-door")]);
	t.after(() => manager.stop().catch(() => {}));
	await manager.start();
	await manager.applyPromise;
	const sockA = net.connect(BASE + 1);
	const sockB = net.connect(BASE + 1);
	await waitFor(() => manager.health().cameras[0]?.consumers === 2);
	/** @type {Buffer[]} */
	const gotA = [];
	/** @type {Buffer[]} */
	const gotB = [];
	sockA.on("data", (c) => gotA.push(c));
	sockB.on("data", (c) => gotB.push(c));
	const bytes = Buffer.alloc(200, 0x47);
	/** @type {PassThrough} */ (opens["front-door"].latest.stdout).write(bytes);
	await waitFor(() => gotA.length > 0 && gotB.length > 0, 2000);
	assert.equal(Buffer.concat(gotA).length, 200);
	assert.ok(Buffer.concat(gotB).equals(bytes), "exact byte-for-byte fan");
	// both sockets tracked as consumers in the health row
	assert.equal(manager.health().cameras[0].consumers, 2);
	sockA.destroy();
	sockB.destroy();
	await manager.stop();
});

test("slow-socket guard: a consumer that cannot keep up is disconnected alone", async (t) => {
	const { manager, opens } = await makeManager([urlCam("front-door")], { relBufferMax: 8192, relStallMs: 60 });
	t.after(() => manager.stop().catch(() => {}));
	await manager.start();
	await manager.applyPromise;
	const fast = net.connect(BASE + 1);
	const slow = net.connect(BASE + 1);
	await waitFor(() => manager.health().cameras[0]?.consumers === 2);
	/** @type {number} */
	let fastBytes = 0;
	fast.on("data", (c) => (fastBytes += c.length));
	// Flowing first, then paused: the transition stops the underlying handle's
	// reads, so the consumer genuinely never drains (a socket that was never
	// flowing can stay window-open and absorb writes forever).
	slow.on("data", () => {});
	slow.pause(); // never reads, never drains
	const stdout = /** @type {PassThrough} */ (opens["front-door"].latest.stdout);
	const start = Date.now();
	// Drive the lane long enough for the stall clock (60ms test window) to
	// expire — a client that never drains is dropped past the stall window
	// even when the OS buffers absorb every write, so the test carries no
	// kernel-buffer arithmetic.
	while (Date.now() - start < 1500 && manager.health().cameras[0].consumers === 2) {
		stdout.write(Buffer.alloc(32 * 1024, 0x47));
		await sleep(5);
	}
	// server-side truth: the stalled consumer is dropped from the fan set
	// (a paused client socket may hold unread bytes, so the client-side
	// close event can lag — the fan bookkeeping is the observable of record)
	await waitFor(() => manager.health().cameras[0]?.consumers === 1, 5000);
	assert.equal(manager.health().cameras[0].consumers, 1, "only the fast consumer remains");
	assert.equal(fast.destroyed, false, "peers keep flowing");
	assert.ok(fastBytes > 0, "the fast consumer kept receiving");
	slow.destroy();
	fast.destroy();
});

test("in-process subscriptions: frames / images / audio delivered; unsubscribe works", async (t) => {
	const camera = { name: "front-door", source: { url: "rtsp://cam/f", width: 8, height: 6 } };
	const { manager, opens } = await makeManager([camera]);
	t.after(() => manager.stop().catch(() => {}));
	await manager.start();
	await manager.applyPromise;
	/** @type {any[]} */
	const frames = [];
	/** @type {Buffer[]} */
	const images = [];
	/** @type {any[]} */
	const audio = [];
	manager.subscribeFrames("front-door", (f) => frames.push(f));
	const unsubImages = manager.subscribeImages("front-door", (b) => images.push(b));
	const unsubAudio = manager.subscribeAudio("front-door", (a) => audio.push(a));
	const lanes = opens["front-door"].latest.stdio;
	feedRgb(opens, "front-door", 8, 6);
	lanes[4].write(Buffer.concat([Buffer.from([0xff, 0xd8]), Buffer.alloc(4), Buffer.from([0xff, 0xd9])]));
	lanes[5].write(Buffer.from(new Float32Array([1, -1]).buffer));
	await waitFor(() => frames.length >= 1 && images.length >= 1 && audio.length >= 1);
	assert.equal(frames[0].w, 8);
	assert.equal(frames[0].h, 6);
	assert.equal(images[0][0], 0xff);
	assert.equal(audio[0].sampleRate, 16000);
	assert.equal(audio[0].data.length, 2);
	unsubImages();
	unsubAudio();
	lanes[4].write(Buffer.concat([Buffer.from([0xff, 0xd8]), Buffer.alloc(2), Buffer.from([0xff, 0xd9])]));
	feedRgb(opens, "front-door", 8, 6);
	await sleep(20);
	assert.equal(images.length, 1, "unsubscribed image consumer stops receiving");
	assert.equal(frames.length, 2, "subscribed frame consumer keeps receiving");
	const framesCount = frames.length;
	manager.subscribeFrames("front-door", () => { throw new Error("subscriber boom"); });
	feedRgb(opens, "front-door", 8, 6);
	await sleep(20);
	assert.ok(frames.length > framesCount, "a throwing subscriber never blocks the pipeline");
	await manager.stop();
});

test("control HTTP: /health, POST /api/cameras/apply 200/422, /cameras/:id, /live/:name 404|503", async (t) => {
	const { manager } = await makeManager([urlCam("front-door")]);
	t.after(() => manager.stop().catch(() => {}));
	await manager.start();
	await manager.applyPromise;
	const port = BASE;

	let res = await call(port, "GET", "/health");
	assert.equal(res.status, 200);
	assert.equal(res.json.state, "opening", "a fleet with an unreceived camera is opening, not live");
	assert.equal(res.json.cameras.length, 1);

	res = await call(port, "GET", "/cameras/front-door");
	assert.equal(res.status, 200);
	assert.equal(res.json.name, "front-door");
	res = await call(port, "GET", "/cameras/nope");
	assert.equal(res.status, 404);
	assert.match(res.json.reason ?? "", /no camera named/);

	res = await call(port, "GET", "/live/ghost");
	assert.equal(res.status, 404);
	assert.match(res.json.reason ?? "", /no camera named "ghost"/);
	res = await call(port, "GET", "/live/front-door");
	assert.equal(res.status, 503);
	assert.match(res.json.reason ?? "", /not live/);

	// apply: bad shape → 422 plain-language
	res = await call(port, "POST", "/api/cameras/apply", { cameras: [{ name: "bad name!", source: {} }] });
	assert.equal(res.status, 422);
	assert.match(res.json.reason ?? "", /not valid/);
	res = await call(port, "POST", "/api/cameras/apply", { cameras: "nope" });
	assert.equal(res.status, 422);

	// apply: good fleet → 200 with the health rows and the port map
	res = await call(port, "POST", "/api/cameras/apply", { cameras: [urlCam("front-door"), urlCam("sidewalk")] });
	assert.equal(res.status, 200);
	assert.equal(res.json.ok, true);
	assert.equal(Object.keys(res.json.ports).length, 2);
	assert.equal(res.json.cameras.length, 2);

	res = await call(port, "GET", "/health");
	assert.equal(res.json.cameras.length, 2);
	await manager.stop();
});

test("control HTTP MJPEG: live camera streams multipart/x-mixed-replace with the jpeg payload", async (t) => {
	const camera = { name: "front-door", source: { url: "rtsp://cam/f", width: 8, height: 6 } };
	const { manager, opens } = await makeManager([camera]);
	t.after(() => manager.stop().catch(() => {}));
	await manager.start();
	await manager.applyPromise;
	const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8]), Buffer.alloc(6, 0x5a), Buffer.from([0xff, 0xd9])]);
	// the camera goes live BEFORE the request so /live gets the multipart path
	feedRgb(opens, "front-door", 8, 6);
	await waitFor(() => manager.health().cameras[0].state === "live");
	const got = await new Promise((resolve, reject) => {
		let settled = false;
		const req = http.get({ host: "127.0.0.1", port: BASE, path: "/live/front-door", agent: new http.Agent({ keepAlive: false }) }, (res) => {
			let body = "";
			res.on("data", (c) => (body += c.toString("latin1")));
			res.on("error", () => {
				if (settled) return;
				settled = true;
				resolve({ status: res.statusCode, headers: res.headers, body });
			});
			// resolve after a settle window so at least one frame rode through
			setTimeout(() => {
				settled = true;
				resolve({ status: res.statusCode, headers: res.headers, body });
				req.destroy();
			}, 400);
		});
		req.on("error", () => {
			if (settled) return;
			settled = true;
			reject(new Error("mjpeg client request failed"));
		});
		// frames flow while the multipart request is open
		setTimeout(() => {
			opens["front-door"].latest.stdio[4].write(jpeg);
			setTimeout(() => opens["front-door"].latest.stdio[4].write(jpeg), 120);
		}, 40);
	});
	assert.equal(got.status, 200);
	assert.match(got.headers["content-type"] ?? "", /multipart\/x-mixed-replace; boundary=porchlight-live/);
	assert.ok(got.body.includes("Content-Type: image/jpeg"));
	assert.ok(got.body.includes(`Content-Length: ${jpeg.length}`));
	assert.ok(got.body.includes(jpeg.toString("latin1")), "exact jpeg bytes ride the multipart body");
	await manager.stop();
});

test("health bus seam: transitions publish porchlight/engine/streams/<camera>/up|down", async (t) => {
	/** @type {{ topic: string, payload: any }[]} */
	const published = [];
	const bus = { publish: async (topic, payload) => published.push({ topic, payload }), close: async () => {} };
	const camera = { name: "front-door", source: { url: "rtsp://cam/f", width: 8, height: 6 } };
	const { manager, opens } = await makeManager([camera], { bus });
	t.after(() => manager.stop().catch(() => {}));
	await manager.start();
	await manager.applyPromise;
	feedRgb(opens, "front-door", 8, 6);
	await waitFor(() => published.length >= 1);
	assert.equal(published[0].topic, streamHealthTopic("front-door", "up"));
	assert.equal(published[0].payload.state, "up");
	assert.equal(published[0].payload.camera, "front-door");
	assert.equal(typeof published[0].payload.at, "number");
	// camera drop → down event with the reason carried through
	opens["front-door"].latest.stdout.emit("data", Buffer.alloc(8)); // live first
	await sleep(5);
	opens["front-door"].latest.emit("close", 1, null);
	await waitFor(() => published.length >= 2);
	assert.equal(published[1].topic, streamHealthTopic("front-door", "down"));
	assert.equal(published[1].payload.state, "down");
	assert.match(published[1].payload.reason ?? "", /dropped|exited/);
	await manager.stop();
});

test("double start is refused; stop() is idempotent-ish and closes the control surface", async (t) => {
	const { manager } = await makeManager([]);
	t.after(() => manager.stop().catch(() => {}));
	await manager.start();
	await manager.applyPromise;
	assert.throws(() => manager.start(), /already started/);
	await manager.stop();
	await manager.stop();
	const res = await call(BASE, "GET", "/health").catch((e) => ({ status: 0, err: e }));
	assert.equal(res.status, 0, "the control endpoint is closed after stop");
});
