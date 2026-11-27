// provider.vision.test.js — Swift Vision subprocess provider against a fake
// helper speaking the framed protocol (real Swift e2e is env-gated) (PORCH-128).

import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import fs from "node:fs";
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
	// Never-silent posture (PORCH-152): all five fields, state native.
	assert.deepEqual(provider.status(), {
		engine: "vision",
		providerClass: "native-mlx",
		model: "apple-vision",
		executionTarget: "ane",
		state: "native",
		respawns: 0,
		reason: null,
	});
	await provider.close();
});

// Respawn posture: the helper crashed (exit 7), was respawned after the
// first backoff rung, and status() names that — never silent (PORCH-152).
test("vision provider status states helper respawns", async () => {
	const counter = path.join(path.dirname(FAKE_HELPER), `respawn-counter-${process.pid}`);
	await fs.promises.writeFile(counter, "0");
	try {
		const provider = await new VisionProvider({
			bin: process.execPath,
			// Counter file: the first helper exits (7) to trigger exactly one
			// respawn; the respawned helper holds its stdin open so it stays
			// alive until close() — no respawn cascade, deterministic count.
			args: ["-e", `const fs=require("node:fs");const p=${JSON.stringify(counter)};let n=0;try{n=+fs.readFileSync(p,"utf8")}catch{};fs.writeFileSync(p,String(n+1));if(n<1)process.exit(7);process.stdin.resume()`],
			timeoutMs: 5000,
		}).start();
		// Under load the respawn (250ms backoff + spawn) may lag the fixed
		// wait — poll for the deterministic count instead of one sleep.
		let status = null;
		for (let waited = 0; waited < 5000; waited += 100) {
			await new Promise((r) => setTimeout(r, 100));
			status = provider.status();
			if (status.respawns >= 1) break;
		}
		assert.equal(status.state, "native");
		assert.equal(status.respawns, 1, `exactly one respawn counted (status: ${JSON.stringify(status)})`);
		assert.match(/** @type {string} */ (status.reason), /helper respawned 1 times/);
		// Under load the respawned child may not have incremented the counter
		// yet when respawns flips — poll the file for the reached count.
		let count = await fs.promises.readFile(counter, "utf8");
		for (let waited = 0; count !== "2" && waited < 5000; waited += 100) {
			await new Promise((r) => setTimeout(r, 100));
			count = await fs.promises.readFile(counter, "utf8");
		}
		assert.equal(count, "2", "exactly one respawn occurred");
		await provider.close();
		// close() SIGTERMs the up helper and sets stopping — the respawn
		// cycle must not have run again (counter frozen).
		assert.equal(await fs.promises.readFile(counter, "utf8"), "2", "close stopped the respawn cycle");
	} finally {
		await fs.promises.rm(counter, { force: true });
	}
})

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
