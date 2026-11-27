// e2e.stream.test.js — the stream manager over REAL node:net, ffmpeg excluded
// (PORCH-154). The default test matrix is deterministic without ffmpeg: the
// fake camera is a real TCP server, and the injected factory plays ffmpeg's
// demux role (net.connect + lane split into the stdio layout of record).
//
// Laws proven here, end to end:
//   - connection-count: the camera sees EXACTLY ONE connection while a relay
//     socket, two in-process subscribers AND an extra relay socket all feed,
//   - power-cycle: a camera drop reconnects WITHOUT manual action, with
//     up→down→up captured on the bus and subscribers re-fed,
//   - load parity: the bytes the camera sends are identical between a
//     recorder-only run and a five-consumer run.

import { test } from "node:test";
import assert from "node:assert/strict";
import net from "node:net";

import { StreamManager } from "../src/manager.js";
import { streamHealthTopic } from "../src/health-bus.js";
import { FakeCameraServer, fakeFactory } from "./helpers/fake-camera.js";

const BASE = 19772;
const W = 16;
const H = 12;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** @param {() => unknown} fn @param {number} [timeoutMs] @returns {Promise<any>} */
async function waitFor(fn, timeoutMs = 10000) {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		const v = fn();
		if (v) return v;
		if (Date.now() > deadline) throw new Error("waitFor: condition not met in time");
		await sleep(20);
	}
}

const cameraConfig = (port) => ({
	name: "front-door",
	source: { url: `tcp://127.0.0.1:${port}`, width: W, height: H },
});

/** A recording-style fake bus: captures every health publish of record. */
function captureBus() {
	/** @type {{ topic: string, payload: any }[]} */
	const published = [];
	return {
		published,
		/** @param {string} topic @param {unknown} payload */
		publish: async (topic, payload) => published.push({ topic, payload }),
		close: async () => {},
	};
}

/** @param {number} nameIndex */
const relayPortOf = (nameIndex) => BASE + 1 + nameIndex;

test("connection-count law: exactly ONE camera connection while every consumer feeds", async (t) => {
	const cam = new FakeCameraServer();
	const port = await cam.start();
	const bus = captureBus();
	const manager = new StreamManager({
		config: { streams: { base: BASE }, cameras: [cameraConfig(port)] },
		bus,
		factory: fakeFactory,
		log: () => {},
	});
	await manager.start();
	t.after(() => manager.stop().catch(() => {}));
	const applied = await manager.applyPromise;
	assert.deepEqual(applied?.ports, { "front-door": relayPortOf(0) });

	// consumers of record: one relay socket (the recorder), two in-process
	// subscribers, one extra relay socket
	const relay = net.connect(relayPortOf(0));
	const relayExtra = net.connect(relayPortOf(0));
	let relayBytes = 0;
	relay.on("data", (c) => (relayBytes += c.length));
	/** @type {Buffer[]} */
	const extraBytes = [];
	relayExtra.on("data", (c) => extraBytes.push(c));
	relayExtra.on("error", () => {});
	/** @type {any[]} */
	const frames = [];
	/** @type {Buffer[]} */
	const images = [];
	/** @type {any[]} */
	const audio = [];
	manager.subscribeFrames("front-door", (f) => frames.push(f));
	manager.subscribeImages("front-door", (b) => images.push(b));
	manager.subscribeAudio("front-door", (a) => audio.push(a));

	// let the camera stream a while (the source turns live on its first byte)
	cam.streamForever();
	await waitFor(() => bus.published.some((e) => e.topic === streamHealthTopic("front-door", "up")), 10000);
	await waitFor(() => frames.length >= 5 && images.length >= 5 && audio.length >= 5 && relayBytes > 0 && extraBytes.length > 0);
	await sleep(100);

	// the law: exactly one upstream connection, despite five consumers
	assert.equal(cam.connections, 1, "the camera saw EXACTLY ONE connection");

	// every consumer is actually fed from that single lane
	assert.ok(frames.length >= 5, "rgb subscriber fed");
	assert.ok(images.length >= 5, "jpeg subscriber fed");
	assert.ok(audio.length >= 5, "audio subscriber fed");
	assert.equal(frames[0].w, W);
	assert.equal(frames[0].h, H);
	assert.equal(frames[0].data.length, W * H * 3);
	assert.equal(images[0][0], 0xff, "jpeg SOI");
	assert.equal(audio[0].sampleRate, 16000);
	assert.ok(relayBytes > 0, "relay socket fed (recorder path)");
	assert.ok(extraBytes.length > 0, "the extra relay socket is fed too");
	cam.stopSending();
	relay.destroy();
	relayExtra.destroy();
	await manager.stop();
	await cam.stop();
});

test("power-cycle law: camera drop → down bus event → automatic reconnect → up, subscribers re-fed", async (t) => {
	const cam = new FakeCameraServer();
	const port = await cam.start();
	const bus = captureBus();
	const manager = new StreamManager({
		config: { streams: { base: BASE }, cameras: [cameraConfig(port)] },
		bus,
		factory: fakeFactory,
		backoffMs: [50, 100], // fast ladder for the test (real default in source.js)
		log: () => {},
	});
	await manager.start();
	t.after(() => manager.stop().catch(() => {}));
	await manager.applyPromise;

	/** @type {any[]} */
	const frames = [];
	manager.subscribeFrames("front-door", (f) => frames.push(f));
	cam.streamForever();
	await waitFor(() => frames.length >= 3, 5000);
	const firstUp = bus.published.filter((e) => e.topic === streamHealthTopic("front-door", "up")).length;
	assert.equal(firstUp, 1, "state up on first connect");

	// POWER CYCLE: the camera kills its sockets; the manager must come back.
	const framesAtCut = frames.length;
	cam.destroyConnections();
	await waitFor(() => bus.published.some((e) => e.topic === streamHealthTopic("front-door", "down")), 3000);
	const downEvent = bus.published.find((e) => e.topic === streamHealthTopic("front-door", "down"));
	assert.equal(downEvent.payload.state, "down");
	assert.equal(downEvent.payload.camera, "front-door");
	assert.match(downEvent.payload.reason ?? "", /dropped|exited/);

	// no manual action: the manager reopens on the ladder and the feed resumes
	await waitFor(() => {
		const up = bus.published.filter((e) => e.topic === streamHealthTopic("front-door", "up")).length;
		return up >= 2;
	}, 8000);
	await waitFor(() => frames.length > framesAtCut + 3, 8000);
	assert.ok(frames.length > framesAtCut + 3, "subscribers re-fed without manual action");
	cam.stopSending();
	await manager.stop();
	await cam.stop();
});

/**
 * One isolated run: boot a fresh camera + manager, attach the requested
 * consumers, let the camera send a FIXED program, and report the total bytes
 * the camera put on the wire.
 * @param {{ consumers: number, inProc: boolean }} shape
 * @returns {Promise<{ cameraBytes: number }>}
 */
async function runLoad(shape) {
	const cam = new FakeCameraServer();
	const port = await cam.start();
	const manager = new StreamManager({
		config: { streams: { base: BASE }, cameras: [cameraConfig(port)] },
		bus: captureBus(),
		factory: fakeFactory,
		log: () => {},
	});
	await manager.start();
	await manager.applyPromise;
	/** @type {import("node:net").Socket[]} */
	const sockets = [];
	try {
		if (shape.consumers > 0) {
			for (let i = 0; i < shape.consumers; i++) {
				const sock = net.connect(relayPortOf(0));
				sock.on("data", () => {});
				sock.on("error", () => {});
				sock.resume();
				sockets.push(sock);
			}
		}
		await waitFor(() => shape.consumers === 0 || manager.health().cameras[0]?.consumers === shape.consumers);
		if (shape.inProc) {
			manager.subscribeFrames("front-door", () => {});
			manager.subscribeImages("front-door", () => {});
			manager.subscribeAudio("front-door", () => {});
		}
		// round 0 primes the lane (the source turns live on its first byte);
		// both runs send the identical 20-round program
		await cam.sendRound(0);
		await waitFor(() => manager.health().cameras[0]?.state === "live");
		// the FIXED program continues: rounds 1..19, no consumer-driven pacing
		const rounds = 20;
		for (let i = 1; i < rounds; i++) {
			await cam.sendRound(i);
			if (i < rounds - 1) await sleep(10);
		}
		const cameraBytes = cam.bytesSent;
		await sleep(50);
		return { cameraBytes };
	} finally {
		for (const sock of sockets) sock.destroy();
		await manager.stop();
		await cam.stop();
	}
}

test("load parity: the camera sends identical bytes for recorder-only vs five-consumer runs", async () => {
	// recorder-only: one relay consumer (the recorder rides the relay URL)
	const solo = await runLoad({ consumers: 1, inProc: false });
	// five consumers: one relay socket + one extra relay socket + three
	// in-process subscribers — consumer count must add ZERO camera load
	const five = await runLoad({ consumers: 2, inProc: true });
	assert.equal(solo.cameraBytes, five.cameraBytes, "identical camera bytes between runs");
	const expected = 20 * 2323; // 20 fixed rounds of 2323 bytes (see fake-camera roundBytes)
	assert.equal(solo.cameraBytes, expected);
});
