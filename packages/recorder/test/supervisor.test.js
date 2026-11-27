// supervisor.test.js — supervisor wiring without ffmpeg (PORCH-127).
//
// A fake spawn emits a child that never exits: proves the state file, health
// endpoint, and retention wiring run on a supervisor whose daemons are
// managed end to end without any real camera or encoder work.

import { test } from "node:test";
import assert from "node:assert/strict";
import fsDefault from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";

import { RecorderSupervisor } from "../src/supervisor.js";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** fs proxy failing every op under the given prefixes (fault injection for the paused case). */
function faultingFs(prefixes) {
	const boom = () => Object.assign(new Error("EIO: input/output error"), { code: "EIO" });
	const f = /** @type {typeof fsDefault} */ ({ ...fsDefault });
	for (const name of ["mkdirSync", "writeFileSync", "readFileSync", "unlinkSync", "readdirSync", "statSync", "rmSync", "renameSync", "existsSync"]) {
		const real = /** @type {any} */ (fsDefault[name]);
		/** @type {any} */ (f)[name] = (p, ...args) => {
			if (prefixes.some((pre) => String(p).startsWith(pre))) throw boom();
			return real(p, ...args);
		};
	}
	return f;
}

/** @param {number} port @param {string} method @param {string} pathname @param {unknown} [body] */
async function call(port, method, pathname, body) {
	return new Promise((resolve, reject) => {
		const payload = body === undefined ? null : JSON.stringify(body);
		const req = http.request(
			{
				host: "127.0.0.1",
				port,
				method,
				path: pathname,
				headers: payload === null ? undefined : { "content-type": "application/json", "content-length": Buffer.byteLength(payload) },
			},
			(res) => {
				let raw = "";
				res.on("data", (c) => (raw += c));
				res.on("end", () => resolve({ status: res.statusCode, body: JSON.parse(raw || "{}") }));
			},
		);
		req.on("error", reject);
		req.end(payload ?? undefined);
	});
}


/** @returns {import("../src/types.js").RecorderConfig} */
function config(root, port) {
	return {
		storageRoot: root,
		port,
		segmentSeconds: 10,
		retentionDays: 2,
		cameras: [
			{ name: "camA", source: { url: "rtsp://cam/a" } },
			{ name: "camB", source: { url: "rtsp://cam/b" } },
		],
	};
}

/** Fake ffmpeg child: alive forever, never writes. */
function fakeSpawn() {
	/** @type {import("node:child_process").ChildProcess[]} */
	const procs = [];
	const spawn = () => {
		const proc = /** @type {any} */ (new EventEmitter());
		proc.pid = 42420 + procs.length;
		proc.stderr = null;
		proc.kill = () => {
			proc.emit("close", null, "SIGTERM");
			return true;
		};
		procs.push(proc);
		return proc;
	};
	return { spawn, procs };
}

test("supervisor writes state, serves /health, and stops cleanly", async () => {
	const tmp = fsDefault.mkdtempSync(path.join(os.tmpdir(), "rec-sup-"));
	const root = path.join(tmp, "store");
	const port = 18971;
	const fake = fakeSpawn();
	const supervisor = new RecorderSupervisor({ config: config(root, port), pollMs: 100, spawn: fake.spawn });
	supervisor.start();
	try {
		await sleep(250);
		supervisor.writeState(); // the file refreshes on a 2s cadence; force one
		const state = JSON.parse(fsDefault.readFileSync(path.join(root, "recorder-state.json"), "utf8"));
		assert.equal(state.cameras.length, 2);
		assert.equal(state.health, "ok");
		assert.equal(state.segmentSeconds, 10);
		assert.equal(fake.procs.length, 2);
		const child = await new Promise((resolve, reject) => {
			const req = http.get({ host: "127.0.0.1", port, path: "/health" }, (res) => {
				let body = "";
				res.on("data", (c) => (body += c));
				res.on("end", () => resolve(JSON.parse(body)));
			});
			req.on("error", reject);
		});
		assert.equal(child.service, "porchlight-recorder");
		assert.equal(child.health, "ok");
		assert.deepEqual(child.cameras.map((c) => c.camera), ["camA", "camB"]);
		assert.deepEqual(
			child.cameras.map((c) => c.audioMode),
			["transcode", "transcode"],
		);
	} finally {
		await supervisor.stop();
		await sleep(50);
		const finalState = JSON.parse(fsDefault.readFileSync(path.join(root, "recorder-state.json"), "utf8"));
		assert.equal(finalState.stopping, true);
		assert.equal(finalState.health, "degraded");
		fsDefault.rmSync(tmp, { recursive: true, force: true });
	}
});

test("stop() twice resolves — a null http server never stalls the retry path", async () => {
	const tmp = fsDefault.mkdtempSync(path.join(os.tmpdir(), "rec-bystop-"));
	const fake = fakeSpawn();
	const supervisor = new RecorderSupervisor({
		config: /** @type {any} */ ({ storageRoot: path.join(tmp, "store"), port: 18994, segmentSeconds: 10, retentionDays: 2, cameras: [] }),
		spawn: fake.spawn,
		pollMs: 100,
		log: () => {},
		bus: null,
	});
	try {
		supervisor.start();
		await sleep(60);
		await supervisor.stop();
		// The second stop must resolve: an already-closed server fires no
		// close callback, and no callback means the old await hung forever.
		await supervisor.stop();
		assert.equal(supervisor.httpServer, null);
	} finally {
		await supervisor.stop(); // triple-stop too: every retry path is safe
		fsDefault.rmSync(tmp, { recursive: true, force: true });
	}
});

test("applyConfig applies the camera set live: add, mutate, remove — no restart", async () => {
	const tmp = fsDefault.mkdtempSync(path.join(os.tmpdir(), "rec-apply-"));
	const port = 18991;
	const fake = fakeSpawn();
	const supervisor = new RecorderSupervisor({
		config: /** @type {any} */ ({
			storageRoot: path.join(tmp, "store"),
			port,
			segmentSeconds: 10,
			retentionDays: 2,
			cameras: [{ name: "camA", source: { url: "rtsp://cam/a" } }],
		}),
		spawn: fake.spawn,
		pollMs: 100,
		log: () => {},
		bus: null,
	});
	try {
		supervisor.start();
		await sleep(120);
		assert.equal(fake.procs.length, 1);

		// ADD: the new daemon starts with the same factory as boot.
		const added = await supervisor.applyConfig(/** @type {any} */ ({
			...supervisor.config,
			cameras: [
				{ name: "camA", source: { url: "rtsp://cam/a" } },
				{ name: "camB", source: { url: "rtsp://cam/b" } },
			],
		}));
		assert.deepEqual(added, { ok: true, started: ["camB"], stopped: [], kept: ["camA"] });
		assert.equal(supervisor.daemons.length, 2);
		assert.ok(supervisor.state().cameras.some((c) => c.camera === "camB"), "state file plane shows the added camera");
		assert.equal(fake.procs.length, 2);

		// MUTATE: the writer arguments changed — stop + rebuild, not swap-in-place.
		const mutated = await supervisor.applyConfig(/** @type {any} */ ({
			...supervisor.config,
			cameras: [
				{ name: "camA", source: { url: "rtsp://cam/a2" }, recordingMode: "event", preRollSeconds: 5, postRollSeconds: 20 },
				{ name: "camB", source: { url: "rtsp://cam/b" } },
			],
		}));
		assert.deepEqual(mutated, { ok: true, started: ["camA"], stopped: ["camA"], kept: ["camB"] });
		const rebuilt = supervisor.daemonFor({ name: "camA" });
		assert.ok(rebuilt);
		assert.equal(rebuilt.camera.source.url, "rtsp://cam/a2");
		assert.equal(rebuilt.mode, "event");
		assert.equal(rebuilt.preRollMs, 5000);
		assert.equal(rebuilt.postRollMs, 20000);
		assert.equal(fake.procs.length, 3, "mutated camera spawned a fresh writer");

		// REMOVE: the daemon stops and drops from the fleet.
		const removed = await supervisor.applyConfig(/** @type {any} */ ({
			...supervisor.config,
			cameras: [{ name: "camA", source: { url: "rtsp://cam/a2" }, recordingMode: "event", preRollSeconds: 5, postRollSeconds: 20 }],
		}));
		assert.deepEqual(removed, { ok: true, started: [], stopped: ["camB"], kept: ["camA"] });
		assert.deepEqual(supervisor.daemons.map((d) => d.camera.name), ["camA"]);
		assert.deepEqual(supervisor.state().cameras.map((c) => c.camera), ["camA"]);
		assert.equal(fake.procs.length, 3, "removal kills, never spawns");

		// Validation refusals leave the live fleet untouched.
		const before = supervisor.daemons.length;
		await assert.rejects(
			() => supervisor.applyConfig(/** @type {any} */ ({ ...supervisor.config, cameras: [{ name: "bad name!", source: { url: "rtsp://x" } }] })),
			/invalid camera name/,
		);
		assert.equal(supervisor.daemons.length, before);
		assert.deepEqual(supervisor.config.cameras.map((c) => c.name), ["camA"]);
	} finally {
		await supervisor.stop();
		fsDefault.rmSync(tmp, { recursive: true, force: true });
	}
});

test("POST /api/cameras/apply applies live and refuses plain-language on bad bodies", async () => {
	const tmp = fsDefault.mkdtempSync(path.join(os.tmpdir(), "rec-apply-http-"));
	const port = 18992;
	const fake = fakeSpawn();
	const supervisor = new RecorderSupervisor({
		config: /** @type {any} */ ({
			storageRoot: path.join(tmp, "store"),
			port,
			segmentSeconds: 10,
			retentionDays: 2,
			cameras: [{ name: "camA", source: { url: "rtsp://cam/a" } }],
		}),
		spawn: fake.spawn,
		pollMs: 100,
		log: () => {},
		bus: null,
	});
	try {
		supervisor.start();
		await sleep(120);

		const ok = await call(port, "POST", "/api/cameras/apply", {
			cameras: [
				{ name: "camA", source: { url: "rtsp://cam/a" } },
				{ name: "camC", source: { url: "rtsp://cam/c" } },
			],
		});
		assert.equal(ok.status, 200);
		assert.deepEqual(ok.body, { ok: true, started: ["camC"], stopped: [], kept: ["camA"] });
		assert.deepEqual(supervisor.daemons.map((d) => d.camera.name), ["camA", "camC"]);

		const noArray = await call(port, "POST", "/api/cameras/apply", { cameras: "two" });
		assert.equal(noArray.status, 422);
		assert.match(noArray.body.error, /cameras array/);
		assert.deepEqual(supervisor.daemons.map((d) => d.camera.name), ["camA", "camC"], "refusal leaves the fleet untouched");

		const badCamera = await call(port, "POST", "/api/cameras/apply", {
			cameras: [
				{ name: "camA", source: { url: "rtsp://cam/a" } },
				{ name: "spaces not allowed", source: { url: "rtsp://cam/x" } },
			],
		});
		assert.equal(badCamera.status, 422);
		assert.match(badCamera.body.error, /invalid camera name/);
		assert.deepEqual(supervisor.config.cameras.map((c) => c.name), ["camA", "camC"], "config swap refuses too");
	} finally {
		await supervisor.stop();
		fsDefault.rmSync(tmp, { recursive: true, force: true });
	}
});

test("applyConfig while storage is paused: validation + config swap only, no daemon starts", async () => {
	const tmp = fsDefault.mkdtempSync(path.join(os.tmpdir(), "rec-apply-pause-"));
	const store = path.join(tmp, "store");
	const port = 18993;
	const fake = fakeSpawn();
	const supervisor = new RecorderSupervisor({
		config: /** @type {any} */ ({
			storageRoot: store,
			port,
			segmentSeconds: 10,
			retentionDays: 2,
			cameras: [{ name: "camA", source: { url: "rtsp://cam/a" } }],
		}),
		spawn: fake.spawn,
		pollMs: 100,
		log: () => {},
		bus: null,
	});
	try {
		supervisor.start();
		await sleep(120);

		// Fault injection: the only storage location dies → recording pauses.
		supervisor.injectFs(faultingFs([store]));
		supervisor.daemons[0].reportWriteError({ where: "segment dir pre-create", err: Object.assign(new Error("EIO"), { code: "EIO" }) });
		await sleep(150);
		assert.equal(supervisor.paused, true);

		const result = await supervisor.applyConfig(/** @type {any} */ ({
			...supervisor.config,
			cameras: [
				{ name: "camA", source: { url: "rtsp://cam/a" } },
				{ name: "camB", source: { url: "rtsp://cam/b" } },
			],
		}));
		assert.deepEqual(result, { ok: true, started: [], stopped: [], kept: [], paused: true });
		assert.equal(supervisor.daemons.length, 1, "no daemon starts while paused");
		assert.deepEqual(supervisor.config.cameras.map((c) => c.name), ["camA", "camB"], "config of record still swaps");

		// Storage recovers → resume starts the FULL swapped camera set.
		supervisor.injectFs(fsDefault);
		supervisor.probeDriveHealth();
		await sleep(120);
		assert.deepEqual(supervisor.daemons.map((d) => d.camera.name), ["camA", "camB"]);
		assert.equal(fake.procs.length, 3, "resume spawns fresh writers for the full swapped set");
	} finally {
		await supervisor.stop();
		fsDefault.rmSync(tmp, { recursive: true, force: true });
	}
});
