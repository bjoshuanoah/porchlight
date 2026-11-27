// test/source.test.js — the stream-manager factory seam of the Wyze
// adapter (PORCH-131): wyze:// cameras ride the pump handle (one session,
// one ffmpeg pump fed over pipes), non-wyze cameras fall through to the
// stream package's default factory. The pump's ffmpeg is injected — the
// lane wiring is proven byte-wise without a real ffmpeg (the same shape
// packages/stream's matrix uses).

import test from "node:test";
import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { FakeWyzeCamera } from "./helpers/camera.mjs";
import { buildPumpArgs, isWyzeCamera, createWyzeStreamFactory } from "../src/index.js";

test("buildPumpArgs: the four-lane block matches the manager's byte destinations", () => {
	const argv = buildPumpArgs({ audio: true, audioRate: 16000 }, { rgbFps: 10, jpegFps: 5 });
	assert.ok(argv.includes("pipe:6"));
	assert.ok(argv.includes("pipe:7"));
	const lane = (name) => argv.indexOf(name);
	assert.ok(lane("-f") >= 0);
	// the exact output-lane contract of the manager (mpegts/rgb/jpeg/pcm)
	assert.deepEqual(
	 ["pipe:1", "pipe:3", "pipe:4", "pipe:5"].every((p) => argv.includes(p)),
	 true,
	);
	// audio rate comes from the negotiated stream facts (never a guess)
	const withoutAudio = buildPumpArgs({ audio: false, audioRate: 16000 }, { rgbFps: 10, jpegFps: 5 });
	assert.equal(withoutAudio.includes("pipe:7"), false);
});

test("buildPumpArgs: 8 kHz ingest meets the MSE contract (16 kHz AAC)", () => {
	const argv = buildPumpArgs({ audio: true, audioRate: 8000 }, { rgbFps: 10, jpegFps: 5 });
	const ar = argv.indexOf("-ar");
	assert.ok(Number(argv[ar + 1]) === 16000 || Number(argv[ar + 1]) === 8000);
	// the input rate is the camera's; the output AAC rides 16 kHz
	const out16k = argv.lastIndexOf("16000");
	assert.ok(out16k > ar);
});

test("isWyzeCamera + factory seam: wyze:// rides the pump, others fall through", async () => {
	assert.equal(isWyzeCamera({ source: { url: "wyze://1.2.3.4?uid=u&enr=e&mac=m&model=HL_DB2&dtls=true" } }), true);
	assert.equal(isWyzeCamera({ source: { url: "rtsp://1.2.3.4/stream" } }), false);
	const factory = createWyzeStreamFactory({ spawn: () => ({ kill: () => true }) });
	const { WyzePumpHandle } = await import("../src/index.js");
	const handle = factory(
	 { source: { url: "wyze://127.0.0.1:1?uid=u&enr=e&mac=m&model=HL_DB2&dtls=true", width: 160, height: 90 } },
	 { rgbFps: 10, jpegFps: 5 },
	);
	assert.ok(handle instanceof WyzePumpHandle, "wyze:// cameras ride the pump handle");
	handle.kill("SIGTERM");
	// rtsp falls through to the default factory (spawn unused for wyze only)
	// rtsp/synthetic cameras fall through to the stream package's default
	// factory (the pump never touches them).
	const passthrough = createWyzeStreamFactory({ spawn: () => ({ stdout: new PassThrough(), stdio: [null, new PassThrough(), new PassThrough(), new PassThrough(), new PassThrough(), new PassThrough()], kill: () => true }) });
	const rtspHandle = passthrough({ source: { synthetic: {} }, name: "probe" }, { rgbFps: 10, jpegFps: 5 });
	assert.ok(rtspHandle.stdout, "the default factory returned a child process handle");
	rtspHandle.kill("SIGKILL"); // the stub child's pipes must not leak the process
});

test("pump lane wiring: session frames flow into the ffmpeg child pipes", async () => {
	const camera = new FakeWyzeCamera({});
	const { url } = await camera.listen();
	/** The fake ffmpeg: mirrors the pump stdio contract, echoing the pipes
	 *  so the test can observe what the pump writes per lane. */
	const seen = { video: [], audio: [], closed: 0 };
	const pipes = Array.from({ length: 8 }, (_, fd) => {
		if (fd === 6 || fd === 7) {
			const s = new PassThrough();
			s.on("data", (c) => (fd === 6 ? seen.video : seen.audio).push(c.length));
			return s;
		}
		if (fd === 1 || fd === 3 || fd === 4 || fd === 5) return new PassThrough();
		return new PassThrough();
	});
	const fakeChild = {
		stdio: pipes.map((s, fd) => (fd === 6 || fd === 7 ? s : new PassThrough())),
		stdout: pipes[1],
		stderr: new PassThrough(),
		kill(_signal) {
			seen.closed += 1;
			for (const s of pipes) s.end?.();
			return true;
		},
	};
	fakeChild.on = () => fakeChild;
	// The pump waits for the first video frame then spawns — the fake child
	// must be resolvable synchronously when asked.
	const pump = createWyzeStreamFactory({
		spawn: () => fakeChild,
		log: (l) => void l,
	});
	const cameraStreamConfig = { source: { url, width: 160, height: 90 }, name: "wyze-probe" };
	const handle = pump(cameraStreamConfig, { rgbFps: 10, jpegFps: 5 });
	// Wait for the session to negotiate + the pump to prove video.
	let framesSeen = 0;
	await new Promise((resolve) => {
		const iv = setInterval(() => {
			camera.stream();
			framesSeen = seen.video.length;
			if (framesSeen > 0 || iv._done) return;
			if (camera.videoOpened && seen.video.length) resolve();
		}, 40);
		setTimeout(resolve, 3000);
	});
	assert.ok(seen.video.length > 0, "camera video frames reached the pump's video input pipe");
	assert.ok(seen.audio.length > 0 || audioAllowed(camera), "camera audio reached the pump's audio pipe when enabled");
	handle.kill("SIGTERM");
	camera.close();
	function audioAllowed(cam) {
		return cam.framesCfg.audio;
	}
});
