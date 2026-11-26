// retention.test.js — rolling window + disk watchdog (PORCH-127 ac-1 policy).

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { DAY_MS, dateDirName } from "../src/paths.js";
import { diskUsage, keepFloorMs, pruneRolling, retentionWatchdog } from "../src/retention.js";

const NOW = Date.UTC(2026, 10, 24, 12, 0, 0); // Nov 24 2026 noon UTC

test("keepFloorMs keeps the most recent retentionDays days inclusive of today", () => {
	assert.equal(keepFloorMs(NOW, 3), Date.UTC(2026, 10, 22));
	assert.equal(keepFloorMs(NOW, 1), Date.UTC(2026, 10, 24));
});

test("pruneRolling deletes days older than the window, keeping today", () => {
	const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "rec-ret-"));
	try {
		for (let d = 0; d < 6; d++) {
			const dir = path.join(tmp, dateDirName(NOW - d * DAY_MS));
			fs.mkdirSync(path.join(dir, "12", "cam"), { recursive: true });
			fs.writeFileSync(path.join(dir, "12", "cam", "120000.mp4"), "x");
		}
		const res = pruneRolling({ root: tmp, retentionDays: 3, nowMs: NOW, fs });
		assert.deepEqual(res.removed.sort(), ["2026-11-19", "2026-11-20", "2026-11-21"]);
		assert.deepEqual(res.moved, []);
		assert.equal(res.kept, 3);
		assert.ok(fs.existsSync(path.join(tmp, "2026-11-22")));
		assert.ok(fs.existsSync(path.join(tmp, "2026-11-24")));
		assert.ok(!fs.existsSync(path.join(tmp, "2026-11-19")));
	} finally {
		fs.rmSync(tmp, { recursive: true, force: true });
	}
});

test("pruneRolling moves to the cold archive before deleting", () => {
	const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ret-cold-"));
	try {
		const cold = path.join(tmp, "cold");
		fs.mkdirSync(cold, { recursive: true });
		for (const d of [22, 23]) {
			fs.mkdirSync(path.join(tmp, `2026-11-${d}`, "12", "cam"), { recursive: true });
			fs.writeFileSync(path.join(tmp, `2026-11-${d}`, "12", "cam", "120000.mp4"), "x");
		}
		const res = pruneRolling({ root: tmp, retentionDays: 1, nowMs: NOW, coldRoot: cold, fs });
		assert.deepEqual(res.moved.sort(), ["2026-11-22", "2026-11-23"]);
		assert.deepEqual(res.removed, []);
		assert.equal(res.kept, 0);
		assert.ok(fs.existsSync(path.join(cold, "2026-11-23", "12", "cam", "120000.mp4")));
	} finally {
		fs.rmSync(tmp, { recursive: true, force: true });
	}
});

/** @param {number} usedFraction @param {number} [dropPerRemoval] a stubbed fs with statfsSync */
function stubFs(usedFraction, dropPerRemoval = 0) {
	let used = usedFraction;
	return {
		existsSync: fs.existsSync,
		readdirSync: fs.readdirSync,
		statSync: fs.statSync,
		mkdirSync: fs.mkdirSync,
		renameSync: fs.renameSync,
		cpSync: fs.cpSync,
		writeFileSync: fs.writeFileSync,
		rmSync: (p, o) => {
			fs.rmSync(p, o);
			used -= dropPerRemoval;
		},
		statfsSync: () => ({ blocks: 1000, bfree: Math.max(0, Math.round(1000 * (1 - used))) }),
	};
}

test("retentionWatchdog prunes beyond the window floor only above high water", () => {
	const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ret-wd-"));
	try {
		for (let d = 0; d < 4; d++) {
			fs.mkdirSync(path.join(tmp, dateDirName(NOW - d * DAY_MS)), { recursive: true });
		}
		const res = retentionWatchdog({
			root: tmp,
			retentionDays: 3,
			nowMs: NOW,
			highWaterFraction: 0.6,
			fs: stubFs(0.5),
			onEvent: () => {},
		});
		assert.equal(res.pruned.length, 0);
		assert.equal(res.alerted, false);
		assert.ok(fs.existsSync(path.join(tmp, "2026-11-21")));
	} finally {
		fs.rmSync(tmp, { recursive: true, force: true });
	}
});

test("retentionWatchdog evicts oldest days first and alerts once", () => {
	const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ret-wd-"));
	try {
		for (let d = 0; d < 4; d++) {
			fs.mkdirSync(path.join(tmp, dateDirName(NOW - d * DAY_MS)), { recursive: true });
		}
		/** @type {string[]} */
		const events = [];
		const res = retentionWatchdog({
			root: tmp,
			retentionDays: 3,
			nowMs: NOW,
			highWaterFraction: 0.2,
			fs: stubFs(0.9, 0.35),
			onEvent: (e) => events.push(e.type),
		});
		assert.deepEqual(res.pruned, ["2026-11-21", "2026-11-22"]);
		assert.equal(res.usedFraction, 0.2);
		assert.equal(res.alerted, true);
		assert.ok(events.includes("storage.high-water"));
		// inside-window day survives the eviction only for genuinely new usage
		assert.ok(fs.existsSync(path.join(tmp, "2026-11-23")));
		assert.ok(fs.existsSync(path.join(tmp, "2026-11-24")));
	} finally {
		fs.rmSync(tmp, { recursive: true, force: true });
	}
});

test("diskUsage computes the df-style used fraction", () => {
	const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ret-du-"));
	try {
		const u = diskUsage(fs, tmp);
		assert.ok(u && u.usedFraction > 0 && u.usedFraction < 1, `fraction ${u?.usedFraction}`);
		const none = diskUsage({ statfsSync: undefined }, tmp);
		assert.equal(none, null);
	} finally {
		fs.rmSync(tmp, { recursive: true, force: true });
	}
});
