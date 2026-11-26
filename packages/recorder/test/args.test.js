// args.test.js — ffmpeg argv construction (PORCH-127 binding constraints).

import { test } from "node:test";
import assert from "node:assert/strict";

import { AUDIO_TRANSCODE, SEGMENT_MOVFLAGS, buildFfmpegArgs, buildFfmpegCommand, resolveAudioMode } from "../src/args.js";
import { LinuxBackend, resolveHal } from "@porchlight/hal";

const CFG = { segmentSeconds: 600 };

test("real RTSP camera: videotoolbox ingest, copy video, AAC/16k transcode, fMP4 segment tail", () => {
	const argv = buildFfmpegArgs(
		{ name: "front_left", source: { url: "rtsp://cam/l" } },
		CFG,
	);
	assert.ok(argv.includes("-hwaccel") && argv[argv.indexOf("-hwaccel") + 1] === "videotoolbox");
	assert.ok(argv.includes("-rtsp_transport") && argv[argv.indexOf("-rtsp_transport") + 1] === "tcp");
	assert.deepEqual(
		argv.slice(argv.indexOf("-c:v"), argv.indexOf("-c:v") + 2),
		["-c:v", "copy"],
	);
	assert.deepEqual(
		argv.slice(argv.indexOf("-c:a"), argv.indexOf("-c:a") + 2),
		["-c:a", AUDIO_TRANSCODE.codec],
	);
	assert.ok(argv.includes("-ar") && argv.includes(String(AUDIO_TRANSCODE.sampleRate)));
	assert.deepEqual(
		argv.slice(argv.indexOf("-f", 8)).slice(0, 2),
		["-f", "segment"],
	);
	assert.ok(argv.includes(`movflags=${SEGMENT_MOVFLAGS}`));
	assert.ok(argv.some((a) => a.includes("movflags=+frag_keyframe+empty_moov")));
	const tmpl = argv[argv.length - 1];
	assert.equal(tmpl, "./%Y-%m-%d/%H/front_left/%H%M%S.part");
	assert.deepEqual(argv.slice(argv.indexOf("-segment_time"), argv.indexOf("-segment_time") + 2),
		["-segment_time", "600"]);
	assert.ok(argv.includes("-strftime"));
});

test("audioMode defaults to transcode; copy is the explicit opt-out", () => {
	assert.equal(resolveAudioMode({ name: "a", source: { url: "rtsp://x" } }), "transcode");
	const argv = buildFfmpegArgs(
		{ name: "a", source: { url: "rtsp://x" }, audioMode: "copy" },
		CFG,
	);
	assert.ok(argv.includes("copy"));
	assert.ok(!argv.includes("-ar"));
});

test("synthetic soak camera: VideoToolbox encoder + PCM routed through the same AAC/16k branch", () => {
	const argv = buildFfmpegArgs(
		{
			name: "soak-1",
			source: {
				synthetic: { size: "640x360", fps: 12, encoder: "h264_videotoolbox", bitrate: "500k" },
			},
		},
		CFG,
	);
	assert.ok(argv.includes("h264_videotoolbox"));
	assert.ok(!argv.includes("-hwaccel")); // encode path, not decode path
	assert.ok(argv.some((a) => a.startsWith("testsrc2=")));
	assert.ok(argv.some((a) => a.startsWith("sine=") && a.includes("sample_rate=8000")));
	assert.ok(argv.includes("-ar") && argv.includes("16000"));
	assert.ok(argv.includes("-g") && argv[argv.indexOf("-g") + 1] === "24");
	const tmpl = argv[argv.length - 1];
	assert.equal(tmpl, "./%Y-%m-%d/%H/soak-1/%H%M%S.part");
});

test("synthetic source refuses audioMode copy (PCM has nothing safe to copy)", () => {
	assert.throws(
		() => buildFfmpegArgs(
			{ name: "s", source: { synthetic: {} }, audioMode: "copy" },
			CFG,
		),
		/cannot use audioMode "copy"/,
	);
});

test("camera without a usable source throws", () => {
	assert.throws(() => buildFfmpegArgs({ name: "x", source: {} }, CFG), /needs source/);
});

// PORCH-132: hardware decisions come from the HAL. The builder must run
// unmodified against the Linux HAL first-cut (test double) — same service
// code, zero darwin-only tokens in the argv.

test("portability: identical builder against the Linux HAL double — no videotoolbox anywhere", () => {
	const hal = resolveHal({ platform: "linux" });
	assert.ok(hal instanceof LinuxBackend);
	const urlArgv = buildFfmpegArgs({ name: "front_left", source: { url: "rtsp://cam/l" } }, CFG, hal);
	assert.ok(!urlArgv.includes("videotoolbox"));
	assert.ok(!urlArgv.includes("-hwaccel")); // first-cut linux: software decode
	assert.deepEqual(
		urlArgv.slice(urlArgv.indexOf("-c:v"), urlArgv.indexOf("-c:v") + 2),
		["-c:v", "copy"],
	);
	const synthArgv = buildFfmpegArgs(
		{ name: "soak-1", source: { synthetic: { size: "640x360", fps: 12 } } },
		CFG,
		hal,
	);
	assert.deepEqual(
		synthArgv.slice(synthArgv.indexOf("-c:v"), synthArgv.indexOf("-c:v") + 2),
		["-c:v", "libx264"],
	);
	assert.deepEqual(
		synthArgv.slice(synthArgv.indexOf("-pix_fmt"), synthArgv.indexOf("-pix_fmt") + 2),
		["-pix_fmt", "yuv420p"],
	);
});

test("portability: builder without an injected hal resolves this host's backend (darwin: videotoolbox)", () => {
	if (process.platform !== "darwin") return;
	const argv = buildFfmpegArgs({ name: "front_left", source: { url: "rtsp://cam/l" } }, CFG);
	assert.ok(argv.includes("-hwaccel") && argv[argv.indexOf("-hwaccel") + 1] === "videotoolbox");
});

test("portability: buildFfmpegCommand threads the hal backend through", () => {
	const linux = buildFfmpegCommand({ name: "c", source: { url: "rtsp://c" } }, CFG, resolveHal({ platform: "linux" }));
	assert.equal(linux.file, "ffmpeg");
	assert.ok(!linux.args.includes("videotoolbox"));
	const darwin = buildFfmpegCommand({ name: "c", source: { url: "rtsp://c" } }, CFG, resolveHal({ platform: "darwin" }));
	assert.ok(darwin.args.includes("videotoolbox"));
});
