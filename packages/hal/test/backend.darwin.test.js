// backend.darwin.test.js — macOS HAL contract (PORCH-132, ac-1).

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { DarwinBackend } from "../src/backend.darwin.js";

const hal = new DarwinBackend();

test("decode: VideoToolbox hardware via system ffmpeg", () => {
	assert.deepEqual(hal.videoDecodeArgs(), ["-hwaccel", "videotoolbox"]);
});

test("encode: VideoToolbox NV12 default for synthetic/soak origins", () => {
	assert.deepEqual(hal.videoEncode(), { name: "h264_videotoolbox", pixFmt: "nv12" });
});

test("frame capture: hwaccel-carrying single-frame argv, deterministic shape", () => {
	const cmd = hal.frameCaptureCommand({ input: "seg.mp4", out: "snap.jpg", at: 12.5 });
	assert.equal(cmd.file, "ffmpeg");
	assert.deepEqual(
		cmd.args,
		["-hwaccel", "videotoolbox", "-ss", "12.5", "-i", "seg.mp4", "-frames:v", "1", "-q:v", "2", "snap.jpg"],
	);
	const noSeek = hal.frameCaptureCommand({ input: "seg.mp4", out: "snap.jpg" });
	assert.deepEqual(
		noSeek.args,
		["-hwaccel", "videotoolbox", "-i", "seg.mp4", "-frames:v", "1", "-q:v", "2", "snap.jpg"],
	);
});

test("frame capture: input and out are required", () => {
	assert.throws(() => hal.frameCaptureCommand({ input: "a.mp4" }), /input and out are required/);
	assert.throws(() => hal.frameCaptureCommand(), /input and out are required/);
});

test("inference: CoreML EP first, CPU fallback rung explicit (never-silent)", () => {
	assert.deepEqual(hal.inferenceExecutionProviders(), ["coreml", "cpu"]);
});

test("vision helper: the Swift source ships with the HAL and exists on disk", () => {
	const helper = hal.visionHelper();
	assert.ok(existsSync(helper.sourcePath), `helper source at ${helper.sourcePath}`);
	assert.ok(helper.sourcePath.endsWith("packages/hal/swift/VisionHelper.swift"));
	assert.deepEqual(helper.frameworks, ["Foundation", "Vision", "ImageIO", "CoreGraphics"]);
});

test("status: audible posture of the host acceleration", () => {
	assert.deepEqual(hal.status(), {
		platform: "darwin",
		accelerator: "apple-silicon",
		decode: "videotoolbox",
		encode: "h264_videotoolbox",
		inference: ["coreml", "cpu"],
		visionHelper: "swift-subprocess",
	});
});
