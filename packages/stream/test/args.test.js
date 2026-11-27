// args.test.js — the pure upstream argv layer (PORCH-154).

import { test } from "node:test";
import assert from "node:assert/strict";

import {
	buildStreamArgs,
	resolveStreamDimensions,
	STREAM_LANE,
	STREAM_STDIO,
} from "../src/args.js";
import { resolveStreamBase } from "../src/config.js";

/** A fixed HAL so the argv tests never depend on the running host. */
const hal = {
	videoDecodeArgs: () => ["-hwaccel", "testhw"],
	videoEncode: () => ({ name: "test-enc", pixFmt: "testfmt" }),
};

const urlCamera = {
	name: "front-door",
	source: { url: "rtsp://cam/stream", width: 1280, height: 720 },
};

test("url camera: one -i, rtsp transport tcp, hal decode, four lanes of record", () => {
	const argv = buildStreamArgs(urlCamera, {}, /** @type {any} */ (hal));
	// exactly one -i, the source URL (the only place source.url is read)
	assert.equal(argv.filter((a) => a === "-i").length, 1);
	assert.equal(argv[argv.indexOf("-i") + 1], "rtsp://cam/stream");
	// rtsp of record
	assert.deepEqual(argv.slice(argv.indexOf("-rtsp_transport"), argv.indexOf("-rtsp_transport") + 2), ["-rtsp_transport", "tcp"]);
	// decode is the HAL's
	assert.ok(argv.includes("-hwaccel"));
	// mpegts lane: -map 0:v:0 -c:v copy -map 0:a:0? -c:a aac -ar 16000 -b:a 96k
	// (amendment: audio is transcoded ONCE at the upstream — `-c:a copy` of
	// PCM into mpegts is not demuxable downstream)
	const i1 = argv.indexOf(STREAM_LANE.mpegts);
	assert.equal(argv[argv.lastIndexOf("-c:v", i1) + 1], "copy");
	assert.equal(argv[argv.lastIndexOf("-c:a", i1) + 1], "aac");
	assert.equal(argv[argv.lastIndexOf("-ar", i1) + 1], "16000");
	assert.equal(argv[argv.lastIndexOf("-b:a", i1) + 1], "96k");
	assert.equal(argv[argv.lastIndexOf("-f", i1) + 1], "mpegts");
	// mid-stream joinability: SPS/PPS repeat per keyframe on the relay lane
	assert.equal(argv[argv.lastIndexOf("-bsf:v", i1) + 1], "dump_extra");
	assert.ok(argv.includes("0:a:0?"), "optional audio mapping present");
	// rgb lane: fps then pix_fmt then rawvideo
	const i3 = argv.indexOf(STREAM_LANE.rgb);
	assert.equal(argv[argv.lastIndexOf("-r", i3) + 1], "10");
	assert.equal(argv[argv.lastIndexOf("-pix_fmt", i3) + 1], "rgb24");
	assert.equal(argv[argv.lastIndexOf("-f", i3) + 1], "rawvideo");
	// jpeg lane
	const i4 = argv.indexOf(STREAM_LANE.jpeg);
	assert.equal(argv[argv.lastIndexOf("-r", i4) + 1], "5");
	assert.equal(argv[argv.lastIndexOf("-q:v", i4) + 1], "5");
	assert.equal(argv[argv.lastIndexOf("-f", i4) + 1], "mjpeg");
	// pcm lane: f32le mono 16k
	const i5 = argv.indexOf(STREAM_LANE.pcm);
	assert.equal(argv[argv.lastIndexOf("-f", i5) + 1], "f32le");
	assert.equal(argv[argv.lastIndexOf("-ac", i5) + 1], "1");
	assert.equal(argv[argv.lastIndexOf("-ar", i5) + 1], "16000");
});

test("url camera: fps knobs from cfg", () => {
	const argv = buildStreamArgs(urlCamera, { rgbFps: 15, jpegFps: 3 }, /** @type {any} */ (hal));
	const i3 = argv.indexOf(STREAM_LANE.rgb);
	const i4 = argv.indexOf(STREAM_LANE.jpeg);
	assert.equal(argv[argv.lastIndexOf("-r", i3) + 1], "15");
	assert.equal(argv[argv.lastIndexOf("-r", i4) + 1], "3");
});

test("non-rtsp url camera: no rtsp_transport flag, loop opt-in", () => {
	const argv = buildStreamArgs({ name: "file-cam", source: { url: "http://cam/file.mp4", width: 64, height: 64 } }, {}, /** @type {any} */ (hal));
	assert.ok(!argv.includes("-rtsp_transport"));
	const argvLoop = buildStreamArgs({ name: "file-cam", source: { url: "file.mp4", loop: true, width: 64, height: 64 } }, {}, /** @type {any} */ (hal));
	assert.deepEqual(argvLoop.slice(argvLoop.indexOf("-stream_loop"), argvLoop.indexOf("-stream_loop") + 2), ["-stream_loop", "-1"]);
});

test("synthetic camera: lavfi inputs to the SAME lanes through the HAL encoder", () => {
	const argv = buildStreamArgs(
		{ name: "soak", source: { synthetic: { size: "320x240", fps: 12 } } },
		{ rgbFps: 10, jpegFps: 5 },
		/** @type {any} */ (hal),
	);
	assert.ok(!argv.includes("-rtsp_transport"));
	const ii = argv.indexOf("-i");
	assert.equal(argv[ii + 1], "testsrc2=size=320x240:rate=12");
	assert.ok(argv.some((a) => a.startsWith("sine=")), "the sine lavfi input is present");
	assert.equal(argv[argv.indexOf("-c:v") + 1], "test-enc");
	assert.equal(argv[argv.indexOf("-pix_fmt") + 1], "testfmt");
	assert.equal(argv[argv.lastIndexOf("-bsf:v", argv.indexOf(STREAM_LANE.mpegts)) + 1], "dump_extra");
	// every destination lane is present and unchanged
	for (const lane of [STREAM_LANE.mpegts, STREAM_LANE.rgb, STREAM_LANE.jpeg, STREAM_LANE.pcm]) {
		assert.ok(argv.includes(lane), `lane ${lane} present`);
	}
});

test("synthetic camera without audio: no audio mapping, lanes stay put", () => {
	const argv = buildStreamArgs({ name: "soak", source: { synthetic: { audio: false } } }, {}, /** @type {any} */ (hal));
	assert.ok(!argv.includes("sine="));
	assert.ok(argv.includes(STREAM_LANE.mpegts) && argv.includes(STREAM_LANE.rgb) && argv.includes(STREAM_LANE.jpeg));
});

test("camera without url or synthetic throws a plain error", () => {
	assert.throws(() => buildStreamArgs(/** @type {any} */ ({ name: "x", source: {} })), /needs source\.url or source\.synthetic/);
});

test("stdio layout of record: fd1 mpegts, fd2 stderr, fd3 rgb, fd4 jpeg, fd5 pcm", () => {
	assert.deepEqual([...STREAM_STDIO], ["ignore", "pipe", "pipe", "pipe", "pipe", "pipe"]);
});

test("resolveStreamDimensions: url needs registered dims; synthetic parses size", () => {
	assert.equal(resolveStreamDimensions({ name: "a", source: { url: "rtsp://x" } }), null);
	assert.deepEqual(resolveStreamDimensions({ name: "a", source: { url: "rtsp://x", width: 320, height: 240 } }), { w: 320, h: 240 });
	assert.deepEqual(resolveStreamDimensions({ name: "a", source: { synthetic: { size: "160x90" } } }), { w: 160, h: 90 });
	assert.deepEqual(resolveStreamDimensions({ name: "a", source: { synthetic: {} } }), { w: 1280, h: 720 });
});

test("resolveStreamBase: default 8972, integer validation", () => {
	assert.equal(resolveStreamBase({}), 8972);
	assert.equal(resolveStreamBase({ streams: {} }), 8972);
	assert.equal(resolveStreamBase({ streams: { base: 9100 } }), 9100);
	assert.throws(() => resolveStreamBase({ streams: { base: "x" } }), /streams\.base/);
	assert.throws(() => resolveStreamBase({ streams: { base: 80 } }), /streams\.base/);
});
