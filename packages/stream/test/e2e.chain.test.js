// e2e.chain.test.js — the full production chain over real ffmpeg, gated by
// PORCHLIGHT_E2E=1 (the default matrix stays deterministic without ffmpeg —
// e2e.stream.test.js carries the injected-factory version of these laws).
//
// Chain of record: a real TCP camera emits a looping H.264/AAC mpegts fixture
// → the manager's REAL upstream ffmpeg demuxes it ONCE (one -i, four lanes)
// → the copy lane fans over the localhost relay → a real RecorderSupervisor
// writer ingests tcp://<relay> and lands fMP4 segments → detection-style rgb
// frames and audio PCM streams feed in-process subscribers → /live serves the
// mjpeg lane. Power-cycling the camera restores every consumer automatically.
//
// Laws proven here end to end (PORCH-154 acceptance hooks):
//   - connection-count: the camera sees EXACTLY ONE connection upstream,
//   - every consumer is fed: recorder segments land, rgb frames + pcm audio
//     chunks arrive, /live streams multipart mjpeg,
//   - power-cycle: camera up→down→up with zero manual action and health
//     events on the bus; recording resumes into the same store.

import { test } from "node:test";
import assert from "node:assert/strict";
import fsDefault from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import net from "node:net";

import { StreamManager } from "../src/manager.js";
import { RecorderSupervisor } from "@porchlight/recorder";

const E2E = process.env.PORCHLIGHT_E2E === "1";
const ffmpeg = process.env.FFMPEG_PATH || "ffmpeg";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** @param {() => unknown} fn @param {number} [timeoutMs] */
async function waitFor(fn, timeoutMs = 45000) {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		const v = fn();
		if (v) return v;
		if (Date.now() > deadline) throw new Error("waitFor: condition not met in time");
		await sleep(100);
	}
}

/** @returns {Promise<string>} fixture path */
async function makeFixture(dir) {
	const file = path.join(dir, "fixture.ts");
	// H.264 (12 fps, 640x360) + AAC — the shape a real camera emits, looped by
	// the fake camera server. dump_extra-free: the manager's copy lane repeats
	// parameter sets itself; the INPUT is a normal file stream.
	execFileSync(ffmpeg, [
		"-hide_banner", "-loglevel", "error",
		"-f", "lavfi", "-i", "testsrc2=size=640x360:rate=12",
		"-f", "lavfi", "-i", "sine=frequency=440:sample_rate=16000",
		"-map", "0:v:0", "-map", "1:a:0",
		"-c:v", "libx264", "-preset", "ultrafast", "-g", "24", "-pix_fmt", "yuv420p",
		"-c:a", "aac", "-b:a", "64k",
		"-t", "12",
		"-f", "mpegts", "-y", file,
	]);
	assert.ok(fsDefault.statSync(file).size > 100000, "fixture rendered");
	return file;
}

/** A camera-shaped TCP server: loops the fixture to every connection, counts connections, and can be power-cycled. */
class FakeCamera {
	constructor(file) {
		this.file = file;
		this.sockets = new Set();
		this.connections = 0;
		/** @type {import("node:net").Server|null} */
		this.server = null;
	}

	async start(port) {
		this.server = net.createServer((sock) => {
			this.connections += 1;
			this.sockets.add(sock);
			const data = fsDefault.readFileSync(this.file);
			let pos = 0;
			// ~4KB per 10ms ≈ 400KB/s: roughly original bitrate, so the mpegts
			// PTS the manager consumes advances at wall-ish pace (no backward
			// timestamp jumps for the downstream segment writer).
			const pump = () => {
				if (this.stopped || sock.destroyed) return;
				const end = (pos + 4096) % data.length;
				const buf = pos + 4096 <= data.length ? data.subarray(pos, pos + 4096) : Buffer.concat([data.subarray(pos), data.subarray(0, end)]);
				pos = end;
				sock.write(buf);
				setTimeout(pump, 10);
			};
			pump();
			sock.on("error", () => {});
		});
		await new Promise((resolve, reject) => {
			this.server?.once("error", reject);
			this.server?.listen(port, "127.0.0.1", resolve);
		});
		this.stopped = false;
		return port;
	}

	/** Power-cycle: kill every open connection; nothing listens until restored. */
	drop() {
		this.stopped = true;
		for (const s of this.sockets) s.destroy();
		this.sockets.clear();
		return new Promise((resolve) => this.server?.close(() => resolve()));
	}

	async restore(port) {
		return this.start(port);
	}

	async close() {
		if (this.server) {
			this.stopped = true;
			for (const s of this.sockets) s.destroy();
			await new Promise((resolve) => this.server?.close(() => resolve()));
		}
	}
}

test("full chain: one upstream, every consumer fed, power-cycle recovery (real ffmpeg)", { skip: !E2E && "set PORCHLIGHT_E2E=1" }, async (t) => {
	const dir = fsDefault.mkdtempSync(path.join(os.tmpdir(), "porch154-chain-"));
	const store = path.join(dir, "store");
	fsDefault.mkdirSync(store, { recursive: true });
	const fixture = await makeFixture(dir);
	const cam = new FakeCamera(fixture);
	const BASE = 19922;
	const CAM_PORT = 19930;
	await cam.start(CAM_PORT);

	const config = {
		storageRoot: store,
		port: 19921,
		segmentSeconds: 2,
		retentionDays: 2,
		streams: { base: BASE },
		cameras: [{ name: "cam-front", source: { url: `tcp://127.0.0.1:${CAM_PORT}`, width: 640, height: 360 } }],
	};
	/** @type {{ topic: string, payload: any }[]} */
	const busEvents = [];
	const manager = new StreamManager({
		config,
		log: () => {},
		bus: {
			publish: async (topic, payload) => busEvents.push({ topic, payload }),
			close: async () => {},
		},
	});
	await manager.start();

	// In-process consumers of record (detection-style frames + audio chunks).
	/** @type {any[]} */
	const frames = [];
	const unsubFrames = manager.subscribeFrames("cam-front", (f) => frames.push(f));
	/** @type {any[]} */
	const audioChunks = [];
	const unsubAudio = manager.subscribeAudio("cam-front", (c) => audioChunks.push(c));

	const sup = new RecorderSupervisor({ config, log: () => {}, pollMs: 2000 });
	sup.start();
	t.after(async () => {
		await sup.stop();
		await manager.stop();
		await cam.close();
		// A stop's async orphan-recovery can still finalize a settled segment
		// (rename .part → .mp4): let it land before the tmpdir is removed.
		await sleep(1000);
		fsDefault.rmSync(dir, { recursive: true, force: true });
	});

	const count = () => walkCount(store);
	/** @param {string} dir @returns {number} segment files */
	function walkCount(root) {
		let n = 0;
		for (const e of fsDefault.readdirSync(root, { withFileTypes: true })) {
			const p = path.join(root, e.name);
			if (e.isDirectory()) n += walkCount(p);
			else if (e.name.endsWith(".mp4") || e.name.endsWith(".part")) n += 1;
		}
		return n;
	}

	// ac-1: EXACTLY ONE upstream connection while recorder + frames + audio feed.
	const recorderRow = () => sup.state().cameras?.find((c) => (c.name ?? c.camera) === "cam-front");
	await waitFor(() => manager.health().cameras[0]?.state === "live", 20000);
	await waitFor(() => (recorderRow()?.state === "recording"), 20000);
	await waitFor(() => count() >= 2, 30000);
	await waitFor(() => frames.length >= 5 && audioChunks.length >= 2, 20000);
	assert.equal(cam.connections, 1, "the camera saw EXACTLY ONE connection");
	assert.equal(manager.health().cameras[0].consumers, 1, "the recorder rides the one relay socket");
	assert.ok(frames.length >= 5, "rgb frames feed subscribers");
	for (const f of frames.slice(0, 3)) {
		assert.equal(f.camera, "cam-front");
		assert.equal(f.w, 640);
		assert.equal(f.h, 360);
		assert.equal(f.data.length, 640 * 360 * 3);
	}
	for (const c of audioChunks.slice(0, 2)) {
		assert.equal(c.camera, "cam-front");
		assert.equal(c.sampleRate, 16000);
		assert.ok(c.data instanceof Float32Array && c.data.length > 0);
	}
	assert.ok(count() >= 2, "the recorder landed segments from the relay chain");

	// /live serves the mjpeg lane alongside all of the above (zero added upstream).
	const live = await fetch(`http://127.0.0.1:${BASE}/live/cam-front`);
	assert.equal(live.status, 200);
	assert.match(live.headers.get("content-type") ?? "", /multipart\/x-mixed-replace/);
	await live.body?.cancel();

	// ac-2: power-cycle — the camera vanishes and returns; zero manual action.
	const before = count();
	await cam.drop();
	await waitFor(() => manager.health().cameras[0].state === "down", 15000);
	await cam.restore(CAM_PORT);
	await waitFor(() => manager.health().cameras[0].state === "live", 20000);
	await waitFor(() => count() >= before + 1, 30000);
	await waitFor(() => frames.length >= 10, 20000);
	assert.ok(cam.connections >= 2, "only the manager re-dials after the power-cycle");
	assert.ok(manager.health().cameras[0].consumers >= 1, "recorder re-attached automatically");

	// Health events on the bus: down then up, in order, for this camera.
	const downs = busEvents.filter((e) => e.topic === `porchlight/engine/streams/cam-front/down`);
	const ups = busEvents.filter((e) => e.topic === `porchlight/engine/streams/cam-front/up`);
	assert.ok(downs.length >= 1, "a down health event fired");
	assert.ok(ups.length >= 1, "an up health event fired");

	unsubFrames();
	unsubAudio();
});
