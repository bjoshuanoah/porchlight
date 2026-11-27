// source.test.js — CameraSource unit layer: lane parsing, refusal, reconnect
// ladder (recorder.js semantics), without ffmpeg (PORCH-154).

import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";

import { CameraSource } from "../src/source.js";
import { PCM_SAMPLE_RATE } from "../src/args.js";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Make a controllable fake handle in the stdio layout of record and a
 * CameraSource wired to a factory that records every open.
 * @param {any} camera
 * @param {{ backoffMs?: number[], nowMs?: () => number, hal?: any }} [opts]
 */
function makeSource(camera, opts = {}) {
	const opens = [];
	/** @type {string[]} */
	const logLines = [];
	const lanes = [null, new PassThrough(), new PassThrough(), new PassThrough(), new PassThrough(), new PassThrough()];
	const handles = [];
	const factory = () => {
		const handle = new EventEmitter();
		handle.stdout = lanes[1];
		handle.stderr = lanes[2];
		handle.stdio = lanes;
		handle.killed = false;
		handle.kill = (sig) => {
			handle.killed = true;
			handle.killSignals = [...(handle.killSignals ?? []), sig ?? "SIGTERM"];
			handle.emit("close", null, "SIGTERM");
		};
		opens.push(handle);
		handles.push(handle);
		return handle;
	};
	const source = new CameraSource({
		camera,
		config: { rgbFps: 10, jpegFps: 5 },
		factory,
		backoffMs: opts.backoffMs ?? [10, 20],
		nowMs: opts.nowMs ?? (() => Date.now()),
		hal: opts.hal ?? { videoDecodeArgs: () => ["-hwaccel", "test"], videoEncode: () => ({ name: "enc", pixFmt: "fmt" }) },
		log: opts.log ?? ((l) => logLines.push(l)),
	});
	return { source, factory, opens, lanes, handles, logLines };
}

test("rgb lane assembles fixed w*h*3 frames across chunk boundaries", () => {
	const camera = { name: "cam", source: { url: "rtsp://x", width: 16, height: 12 } };
	const { source, lanes } = makeSource(camera);
	const frames = [];
	source.on("frame", (f) => frames.push(f));
	source.open();

	// one full frame split into 3 writes, plus a partial second frame
	const full = Buffer.alloc(576);
	for (let i = 0; i < 576; i++) full[i] = i % 256;
	lanes[3].write(full.subarray(0, 200));
	lanes[3].write(full.subarray(200, 500));
	lanes[3].write(full.subarray(500));
	assert.equal(frames.length, 1);
	assert.equal(frames[0].camera, "cam");
	assert.equal(frames[0].w, 16);
	assert.equal(frames[0].h, 12);
	assert.equal(frames[0].data.length, 16 * 12 * 3);
	assert.ok(frames[0].data.every((b, i) => b === i % 256));
	assert.equal(typeof frames[0].t, "number");
	assert.ok(Math.abs(frames[0].t - Date.now() / 1000) < 5);
	// state of record: the first lane byte proves life
	assert.equal(source.state, "live");
});

test("rgb lane emits MULTIPLE frames from a single chunk and keeps the partial tail", () => {
	const camera = { name: "cam", source: { url: "rtsp://x", width: 2, height: 2 } };
	const { source, lanes } = makeSource(camera);
	const frames = [];
	source.on("frame", (f) => frames.push(f));
	source.open();
	// frame = 12 bytes; send 2.5 frames in one write
	const buf = Buffer.alloc(30, 7);
	lanes[3].write(buf);
	assert.equal(frames.length, 2);
	assert.equal(frames[1].data.length, 12);
	const more = Buffer.alloc(6, 9);
	lanes[3].write(more);
	assert.equal(frames.length, 3);
	assert.deepEqual([...frames[2].data.subarray(0, 6)], Array(6).fill(7), "the carried tail completes the frame first");
	assert.deepEqual([...frames[2].data.subarray(6)], Array(6).fill(9));
});

test("jpeg lane scans EOI and only emits complete SOI..EOI frames across boundaries", () => {
	const camera = { name: "cam", source: { url: "rtsp://x", width: 4, height: 4 } };
	const { source, lanes } = makeSource(camera);
	const images = [];
	source.on("jpeg", (b) => images.push(b));
	source.open();
	const frame = (fill) => Buffer.concat([Buffer.from([0xff, 0xd8]), Buffer.alloc(3, fill), Buffer.from([0xff, 0xd9])]);
	const garbage = Buffer.from([0x11, 0x22]);
	// two frames in one chunk after garbage
	lanes[4].write(Buffer.concat([garbage, frame(1), frame(2)]));
	assert.equal(images.length, 2);
	assert.deepEqual([...images[0].subarray(0, 2)], [0xff, 0xd8]);
	assert.deepEqual([...images[0].subarray(-2)], [0xff, 0xd9]);
	// next frame split across writes: SOI arrives alone
	lanes[4].write(frame(3).subarray(0, 3));
	assert.equal(images.length, 2);
	lanes[4].write(frame(3).subarray(3));
	assert.equal(images.length, 3);
	assert.equal(images[2][2], 3);
});

test("pcm lane emits AudioChunk-shaped chunks: f32le, 16 kHz, advancing t", () => {
	const camera = { name: "cam", source: { url: "rtsp://x", width: 4, height: 4 } };
	const { source, lanes } = makeSource(camera);
	const chunks = [];
	source.on("audio", (c) => chunks.push(c));
	source.open();
	// 3 samples then a partial trailing byte: the partial carries over
	const samples = new Float32Array(3);
	samples.set([0.25, -0.5, 1]);
	const buf = Buffer.from(samples.buffer);
	lanes[5].write(Buffer.concat([buf, Buffer.from([0x00])]));
	assert.equal(chunks.length, 1);
	const first = chunks[0];
	assert.equal(first.camera, "cam");
	assert.equal(first.sampleRate, PCM_SAMPLE_RATE);
	assert.ok(first.data instanceof Float32Array);
	assert.equal(first.data.length, 3);
	assert.equal(first.data[1], -0.5);
	const baseT = first.t;
	// no partial sample is ever emitted while bytes are incomplete
	assert.equal(chunks.length, 1);
	// a carried partial byte plus 3 more bytes completes exactly one sample:
	// t advances by precisely 1/16000 s
	const one = Buffer.from(new Float32Array([0.75]).buffer);
	lanes[5].write(one.subarray(1));
	assert.equal(chunks.length, 2);
	assert.equal(chunks[1].data.length, 1);
	assert.equal(chunks[1].data[0], 0.75);
	// t advanced by exactly the samples consumed: chunk 2 starts after 3 samples
	assert.ok(
		Math.abs(chunks[1].t - (baseT + 3 / PCM_SAMPLE_RATE)) < 1e-9,
		`chunk t must advance by the consumed samples (${chunks[1].t} vs ${baseT})`,
	);
});

test("url camera without registered dimensions: down with a naming reason and NO upstream open", () => {
	let opens = 0;
	const source = new CameraSource({
		camera: /** @type {any} */ ({ name: "blind", source: { url: "rtsp://x" } }),
		config: {},
		factory: () => {
			opens += 1;
			return new EventEmitter();
		},
		backoffMs: [10],
		log: () => {},
	});
	const downs = [];
	source.on("down", (e) => downs.push(e));
	source.open();
	assert.equal(opens, 0, "no upstream connection without dimensions");
	assert.equal(source.state, "down");
	assert.match(source.reason ?? "", /source\.width\/source\.height/);
	assert.equal(downs.length, 1);
	assert.equal(downs[0].state, "down");
	assert.equal(source.at > 0, true);
});

test("handle close → down event with reason; automatic reopen on the backoff ladder", async () => {
	const camera = { name: "cam", source: { url: "rtsp://x", width: 4, height: 4 } };
	const { source, opens } = makeSource(camera);
	const events = { up: 0, down: [] };
	source.on("up", () => events.up += 1);
	source.on("down", (e) => events.down.push(e));
	source.open();
	await sleep(5);
	opens[0].emit("close", 255, null); // camera drop → the HANDLE surfaces it
	assert.equal(source.state, "down");
	assert.match(source.reason ?? "", /exited|dropped/);
	assert.equal(events.down[0].state, "down");
	// backoff ladder step 1 (10ms) fires the reopen without manual action
	await sleep(40);
	assert.ok(opens.length >= 2, "reconnected without manual action");
	assert.equal(source.state, "opening");
});

test("backoff ladder caps; a stable run past five minutes resets it (recorder semantics)", async () => {
	let clock = 1_000_000;
	const camera = { name: "cam", source: { url: "rtsp://x", width: 4, height: 4 } };
	const { source, opens, logLines } = makeSource(camera, {
		backoffMs: [10, 20, 40],
		nowMs: () => clock,
	});
	source.open();
	// crash #1 with an UNSTABLE run → restarts climbs
	opens[0].emit("close", 1, null);
	assert.equal(source.restarts, 1);
	await sleep(30);
	// crash #2 unstable → climbs again
	opens[1].emit("close", 1, null);
	await sleep(30);
	const climbs = source.restarts;
	assert.equal(climbs, 2);
	// now a close after five STABLE minutes (the clock jumps past the reset):
	// recorder semantics erase one crash from history, so the stable close's
	// reconnect comes back on a one-step-LOWER ladder entry (20ms, not the
	// 40ms an unstable crash #3 would take). The ladder cap holds at the top.
	clock += 5 * 60 * 1000 + 1;
	const stableReopen = opens.length;
	opens[opens.length - 1].emit("close", 1, null);
	const reopenLine = logLines[logLines.length - 1];
	assert.match(reopenLine, /reopening the upstream in 20ms/, `stable close lands one step lower: ${reopenLine}`);
	await sleep(40);
	assert.ok(opens.length > stableReopen, "reconnected after the stable close");
	// the cap: even after many more crashes the delay never exceeds the ladder
	for (let i = 0; i < 4; i++) {
		opens[opens.length - 1].emit("close", 1, null);
		await sleep(45);
	}
	assert.ok(logLines.filter((l) => l.includes(" in 60ms") || l.includes(" in 80ms")).length === 0, "the bounded ladder never exceeds its entries");
	assert.ok(logLines.some((l) => l.includes(" in 40ms")), "the ladder reached its cap and stayed there");
	assert.ok(source.restarts > 0);
});

test("stop(): kills the handle, cancels the reopen timer, no further opens", async () => {
	const camera = { name: "cam", source: { url: "rtsp://x", width: 4, height: 4 } };
	const { source, opens } = makeSource(camera);
	source.open();
	const handle = opens[0];
	const stopping = source.stop();
	handle.emit("close", 0, "SIGTERM");
	await stopping;
	assert.ok(handle.killed === true || handle.killSignals?.length === 1);
	const count = opens.length;
	await sleep(30);
	assert.equal(opens.length, count, "no reopen after stop");
});
