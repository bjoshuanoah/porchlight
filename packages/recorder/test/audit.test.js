// audit.test.js — gap audit over a synthetic store (PORCH-127 ac-1 tooling).

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { auditStorage, probeCorrupt } from "../src/audit.js";
import { segmentDir, segmentBaseName } from "../src/paths.js";

const SEG = 10;
const BASE = Date.UTC(2026, 10, 24, 19, 0, 0);

/**
 * Materialize a store: one segment per step, with optional holes.
 * @param {string} tmp
 * @param {string} camera
 * @param {number[]} startsMs
 */
function buildStore(tmp, camera, startsMs) {
	for (const ts of startsMs) {
		const dir = segmentDir(tmp, camera, ts);
		fs.mkdirSync(dir, { recursive: true });
		fs.writeFileSync(path.join(dir, `${segmentBaseName(ts)}.mp4`), "x");
	}
}

test("auditStorage reports zero gaps for a continuous run", () => {
	const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "rec-audit-"));
	try {
		const starts = Array.from({ length: 30 }, (_, i) => BASE + i * SEG * 1000);
		buildStore(tmp, "camA", starts);
		const res = auditStorage({
			root: tmp,
			cameras: ["camA"],
			segmentSeconds: SEG,
			sinceMs: BASE,
			untilMs: BASE + 29 * SEG * 1000,
			fs,
		});
		assert.equal(res.ok, true, JSON.stringify(res));
		assert.equal(res.totals.segments, 30);
		assert.equal(res.cameras[0].gaps.length, 0);
		assert.equal(res.cameras[0].coverageStart, BASE);
	} finally {
		fs.rmSync(tmp, { recursive: true, force: true });
	}
});

test("auditStorage flags the exact missing window when segments vanish", () => {
	const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "rec-audit-"));
	try {
		// segments 0..5 present, 6..8 missing (60s hole), 9.. present
		const starts = Array.from({ length: 15 }, (_, i) => BASE + i * SEG * 1000)
			.filter((t) => !(t >= BASE + 6 * SEG * 1000 && t <= BASE + 8 * SEG * 1000));
		buildStore(tmp, "camA", starts);
		const res = auditStorage({
			root: tmp,
			cameras: ["camA"],
			segmentSeconds: SEG,
			fs,
		});
		assert.equal(res.ok, false);
		assert.equal(res.totals.gaps, 1);
		const gap = res.cameras[0].gaps[0];
		assert.equal(gap.from, BASE + 6 * SEG * 1000);      // nominal end of segment 5
		assert.equal(gap.to, BASE + 9 * SEG * 1000);
		assert.equal(res.cameras[0].segments, 12);
	} finally {
		fs.rmSync(tmp, { recursive: true, force: true });
	}
});

test("auditStorage treats keyframe overshoot inside tolerance as coverage", () => {
	const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "rec-audit-"));
	try {
		// one segment rolled at 1.9× the nominal length — still covered
		const starts = [BASE, BASE + 19 * 1000, BASE + 2 * SEG * 1000];
		buildStore(tmp, "camA", starts);
		const res = auditStorage({
			root: tmp,
			cameras: ["camA"],
			segmentSeconds: SEG,
			sinceMs: BASE,
			untilMs: BASE + 2 * SEG * 1000,
			fs,
		});
		assert.equal(res.ok, true, JSON.stringify(res.cameras[0].gaps));
	} finally {
		fs.rmSync(tmp, { recursive: true, force: true });
	}
});

test("auditStorage reports a missing camera and in-progress laggards", () => {
	const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "rec-audit-"));
	try {
		const starts = [BASE, BASE + SEG * 1000];
		buildStore(tmp, "camA", starts);
		fs.mkdirSync(segmentDir(tmp, "camB", BASE), { recursive: true });
		fs.writeFileSync(
			path.join(segmentDir(tmp, "camB", BASE), `${segmentBaseName(BASE)}.part`),
			"x",
		);
		const res = auditStorage({ root: tmp, cameras: ["camA", "camB"], segmentSeconds: SEG, fs });
		assert.equal(res.cameras[0].gaps.length, 0);
		assert.equal(res.cameras[1].segments, 0);
		assert.equal(res.cameras[1].inProgress, 1);
		assert.equal(res.totals.segments, 2);
		assert.equal(res.totals.inProgress, 1);
	} finally {
		fs.rmSync(tmp, { recursive: true, force: true });
	}
});

test("probeCorrupt counts unreadable and overlong segments; playable tails are fine", async () => {
	const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "rec-probe-"));
	try {
		const t0 = BASE, t1 = BASE + SEG * 1000, t2 = BASE + 2 * SEG * 1000;
		const dirA = segmentDir(tmp, "camA", t0);
		fs.mkdirSync(dirA, { recursive: true });
		fs.writeFileSync(path.join(dirA, `${segmentBaseName(t0)}.mp4`), "x"); // 10s — ok
		fs.writeFileSync(path.join(dirA, `${segmentBaseName(t1)}.mp4`), "x"); // 25s — overlong
		fs.writeFileSync(path.join(dirA, `${segmentBaseName(t2)}.mp4`), "x"); // probe fails
		let call = 0;
		const execFile = /** @type {typeof import("node:child_process").execFile} */ ((
			_file, _args, _opts, cb,
		) => {
			call += 1;
			if (call === 1) {
				process.nextTick(() => cb(null, JSON.stringify({ format: { duration: "10.1" } }), ""));
			} else if (call === 2) {
				process.nextTick(() => cb(null, JSON.stringify({ format: { duration: "25.0" } }), ""));
			} else {
				process.nextTick(() => cb(new Error("moov missing"), "", "error"));
			}
		});
		const res = await probeCorrupt({
			root: tmp,
			cameras: ["camA"],
			ffprobePath: "ffprobe",
			segmentSeconds: SEG,
			fs,
			execFile,
		});
		assert.equal(res.checked, 3);
		assert.equal(res.ok, false);
		assert.deepEqual(res.corrupt.map((c) => c.reason.startsWith("implausible") ? "implausible" : "ffprobe failed"),
			["implausible", "ffprobe failed"]);
	} finally {
		fs.rmSync(tmp, { recursive: true, force: true });
	}
});
