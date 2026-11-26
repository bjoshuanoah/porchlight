// backend.linux.test.js — the first-cut Linux HAL backend (PORCH-132, ac-1:
// the same service contract runs against the Linux implementation).

import { test } from "node:test";
import assert from "node:assert/strict";
import { LinuxBackend } from "../src/backend.linux.js";

const hal = new LinuxBackend();

test("decode: no videotoolbox/coreml claims — plain portable software decode", () => {
	assert.deepEqual(hal.videoDecodeArgs(), []);
});

test("encode: universal software encoder default", () => {
	assert.deepEqual(hal.videoEncode(), { name: "libx264", pixFmt: "yuv420p" });
});

test("frame capture: same command shape as darwin, no hwaccel flags", () => {
	const cmd = hal.frameCaptureCommand({ input: "seg.mp4", out: "snap.jpg", at: 3 });
	assert.equal(cmd.file, "ffmpeg");
	assert.deepEqual(
		cmd.args,
		["-ss", "3", "-i", "seg.mp4", "-frames:v", "1", "-q:v", "2", "snap.jpg"],
	);
});

test("frame capture: input and out are required", () => {
	assert.throws(() => hal.frameCaptureCommand({ out: "x.jpg" }), /input and out are required/);
});

test("inference: CPU provider only — acceleration is never silently claimed", () => {
	assert.deepEqual(hal.inferenceExecutionProviders(), ["cpu"]);
});

test("vision helper: darwin-only feature reported explicitly absent (never silent)", () => {
	assert.deepEqual(hal.visionHelper(), { sourcePath: null, frameworks: [] });
});

test("status: auditable CPU posture naming the native slots that land later", () => {
	const s = hal.status();
	assert.equal(s.platform, "linux");
	assert.equal(s.decode, "none (cpu)");
	assert.equal(s.encode, "libx264");
	assert.deepEqual(s.inference, ["cpu"]);
	assert.match(s.accelerator, /vaapi\/nvdec\/openvino/);
});

test("portability guard: no darwin-only tokens leak into the linux descriptors", () => {
	const flat = JSON.stringify(hal.status()) + hal.videoDecodeArgs().join(" ")
		+ JSON.stringify(hal.videoEncode()) + JSON.stringify(hal.inferenceExecutionProviders());
	assert.ok(!flat.includes("videotoolbox"), "no videotoolbox token");
	assert.ok(!flat.includes("coreml"), "no coreml token");
	assert.ok(!flat.includes("Metal"), "no Metal token");
});
