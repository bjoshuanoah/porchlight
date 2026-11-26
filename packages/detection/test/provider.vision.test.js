// provider.vision.test.js — Swift Vision subprocess provider against a fake
// helper speaking the framed protocol (real Swift e2e is env-gated) (PORCH-128).

import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { VisionProvider } from "../src/provider.vision.js";

const FAKE_HELPER = path.join(path.dirname(fileURLToPath(import.meta.url)), "helpers", "fake-vision-helper.mjs");

/** @param {Partial<import("../src/types.js").Frame>} [over] @returns {import("../src/types.js").Frame} */
const rgbFrame = (over = {}) => ({
	camera: "cam-1",
	w: 2,
	h: 2,
	t: 20.5,
	format: "rgb",
	data: new Uint8Array(2 * 2 * 3).fill(128),
	...over,
});

test("vision provider: framed protocol roundtrip yields normalized detections", async () => {
	const provider = await new VisionProvider({ bin: process.execPath, args: [FAKE_HELPER], timeoutMs: 5000 }).start();
	const dets = await provider.detect(rgbFrame());
	assert.equal(dets.length, 2);
	assert.equal(dets[0].cls, "person");
	assert.equal(dets[0].conf, 0.8);
	assert.deepEqual(dets[0].bbox, [0.2, 0.3, 0.2, 0.2]);
	assert.equal(dets[0].t, 20.5);
	assert.equal(dets[1].cls, "dog");
	assert.equal(provider.status().engine, "vision");
	assert.equal(provider.status().respawns, 0);
	await provider.close();
});

test("vision provider keeps frames serial across repeated detections", async () => {
	const provider = await new VisionProvider({ bin: process.execPath, args: [FAKE_HELPER], timeoutMs: 5000 }).start();
	for (const t of [1, 2, 3]) {
		const dets = await provider.detect(rgbFrame({ t }));
		assert.equal(dets[0].t, t);
	}
	await provider.close();
});

test("vision provider enforces the protocol: payload length and inflight guard", async () => {
	const provider = await new VisionProvider({ bin: process.execPath, args: [FAKE_HELPER] }).start();
	await assert.rejects(() => provider.detect(rgbFrame({ data: new Uint8Array(3) })), /Frame\.data/);
	const [slow, quick] = await Promise.allSettled([
		provider.detect(rgbFrame({ t: 1 })),
		provider.detect(rgbFrame({ t: 2 })),
	]);
	assert.equal(slow.status, "fulfilled");
	assert.equal(quick.status, "rejected", "second concurrent frame is refused while one is in flight");
	await provider.close();
});

test("vision provider: a silent helper times out inside the deadline", async () => {
	const helper = path.join(path.dirname(FAKE_HELPER), "silent-helper.mjs");
	const provider = new VisionProvider({ bin: process.execPath, args: [helper], timeoutMs: 300 });
	await provider.start();
	await assert.rejects(() => provider.detect(rgbFrame()), /no helper response within 300ms/);
	await provider.close();
});
