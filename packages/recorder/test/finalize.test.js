// finalize.test.js — finalize-on-crash semantics without ffmpeg (PORCH-127).

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { finalPathOf, finalizePlan, finalizeSegment, recoverSegment } from "../src/finalize.js";

/** @param {number} minutes @param {boolean} [part] */
const entry = (minutes, part = true) => ({
	relPath: `2026-11-24/19/cam/${String(minutes).padStart(6, "0")}${part ? ".part" : ""}`,
	tsMs: Date.UTC(2026, 10, 24, 10, 0, minutes * 60),
	part,
});

test("finalizePlan finalizes every .part older than the newest (muxer moved on)", () => {
	const entries = [entry(0), entry(600), entry(1200), entry(1800)];
	assert.deepEqual(finalizePlan(entries), [entries[0].relPath, entries[1].relPath, entries[2].relPath]);
});

test("finalizePlan keeps the newest part alive and skips final segments", () => {
	const entries = [entry(1800, false), entry(2400)];
	assert.deepEqual(finalizePlan(entries), []);
	assert.deepEqual(finalizePlan([entry(0, false)]), []);
});

test("finalizeSegment renames .part → .mp4 atomically in place", () => {
	const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "rec-fin-"));
	try {
		const dir = path.join(tmp, "2026-11-24", "19", "cam");
		fs.mkdirSync(dir, { recursive: true });
		const part = path.join(dir, "190500.part");
		fs.writeFileSync(part, "data");
		finalizeSegment(fs, part);
		assert.ok(fs.existsSync(path.join(dir, "190500.mp4")));
		assert.ok(!fs.existsSync(part));
		assert.equal(finalPathOf(part), path.join(dir, "190500.mp4"));
		assert.throws(() => finalizeSegment(fs, path.join(dir, "190500.mp4")), /not a part file/);
	} finally {
		fs.rmSync(tmp, { recursive: true, force: true });
	}
});

/** @returns {typeof import("node:child_process").execFile} */
function fakeExecFile(okPayload) {
	return (_file, _args, _opts, cb) => {
		process.nextTick(() => cb(null, okPayload ? JSON.stringify({ format: { duration: "10.0" } }) : "", ""));
	};
}

test("recoverSegment finalizes a playable orphan and discards an unrecoverable one", async () => {
	const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "rec-rec-"));
	try {
		const good = path.join(tmp, "a.part");
		const bad = path.join(tmp, "b.part");
		fs.writeFileSync(good, "x");
		fs.writeFileSync(bad, "x");
		const res1 = await recoverSegment("ffprobe", { absPath: good }, { execFile: fakeExecFile(true) });
		assert.equal(res1.action, "finalized");
		assert.ok(fs.existsSync(path.join(tmp, "a.mp4")));
		const res2 = await recoverSegment("ffprobe", { absPath: bad }, { execFile: fakeExecFile(false) });
		assert.equal(res2.action, "discarded");
		assert.ok(!fs.existsSync(bad));
		// no ffprobe → finalize blindly (fMP4 keeps fragments readable)
		const blind = path.join(tmp, "c.part");
		fs.writeFileSync(blind, "x");
		const res3 = await recoverSegment(null, { absPath: blind });
		assert.equal(res3.action, "finalized");
	} finally {
		fs.rmSync(tmp, { recursive: true, force: true });
	}
});
