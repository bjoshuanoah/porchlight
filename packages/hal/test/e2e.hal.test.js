// e2e.hal.test.js — real-hardware validation of the macOS HAL (PORCH-132,
// env-gated). Runs ONLY with PORCHLIGHT_E2E=1 on a macOS host with ffmpeg on
// PATH. The default unit matrix stays deterministic without ffmpeg/network.
//
// Covers ac-1's darwin clause: when the hardware backend is exercised, decode
// and capture go through the HAL's macOS implementation — the argv fragments
// exercised against real ffmpeg come from hal.videoEncode()/videoDecodeArgs()/
// frameCaptureCommand(), not from service-side constants.

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtempSync, existsSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const exec = promisify(execFile);
const E2E = process.env.PORCHLIGHT_E2E === "1";

test("darwin HAL: hw-encode → hw-decode → single-frame capture through HAL argv, real ffmpeg", async (t) => {
	if (!E2E || process.platform !== "darwin") {
		t.skip("set PORCHLIGHT_E2E=1 on a macOS host with ffmpeg on PATH");
		return;
	}
	const { resolveHal } = await import("../src/index.js");
	const hal = resolveHal();
	assert.equal(hal.platform, "darwin");

	const dir = mkdtempSync(path.join(os.tmpdir(), "porch-hal-e2e-"));
	const clip = path.join(dir, "in.mp4");
	const snap = path.join(dir, "snap.jpg");

	// Encode 2 s of the synthetic test source with the HAL's encoder default.
	const enc = hal.videoEncode();
	const encodeArgs = [
		"-f", "lavfi", "-i", "testsrc2=size=320x240:rate=12",
		"-t", "2",
		"-c:v", enc.name,
		"-pix_fmt", enc.pixFmt,
		"-y", clip,
	];
	await exec("ffmpeg", encodeArgs);
	assert.ok(enc.name === "h264_videotoolbox", "darwin HAL encoder default");
	assert.ok(statSync(clip).size > 500, "encoded clip written");

	// Decode + capture one frame with the HAL's hwdecode + capture argv.
	const cap = hal.frameCaptureCommand({ input: clip, out: snap, at: 0.5 });
	assert.deepEqual(cap.args.slice(0, 2), ["-hwaccel", "videotoolbox"]);
	const capBinArgs = [...cap.args.slice(0, cap.args.indexOf("-i")), "-y", ...cap.args.slice(cap.args.indexOf("-i"))];
	await exec("ffmpeg", capBinArgs);
	assert.ok(existsSync(snap), "captured frame exists");
	assert.ok(statSync(snap).size > 500, "captured frame is a real image, not an empty file");
});
