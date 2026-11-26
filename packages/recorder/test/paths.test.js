// paths.test.js — segment store layout (PORCH-127).

import { test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";

import {
	DAY_MS,
	dateDirName,
	hourDirName,
	listSegments,
	parseSegmentRelPath,
	partPath,
	segmentBaseName,
	segmentDir,
} from "../src/paths.js";

test("path builders produce the UTC date/hour/camera layout", () => {
	const ts = Date.UTC(2026, 10, 24, 19, 5, 7);
	assert.equal(dateDirName(ts), "2026-11-24");
	assert.equal(hourDirName(ts), "19");
	assert.equal(segmentBaseName(ts), "190507");
	assert.equal(
		segmentDir("/store", "cam_a", ts),
		"/store/2026-11-24/19/cam_a",
	);
	assert.equal(
		partPath("/store", "cam_a", ts),
		"/store/2026-11-24/19/cam_a/190507.part",
	);
});

test("parseSegmentRelPath resolves both final and in-progress names", () => {
	const final = parseSegmentRelPath("2026-11-24/19/cam_a/190507.mp4");
	assert.ok(final);
	assert.equal(final.tsMs, Date.UTC(2026, 10, 24, 19, 5, 7));
	assert.equal(final.part, false);
	assert.equal(final.camera, "cam_a");

	const part = parseSegmentRelPath("2026-11-24/19/cam_b/190507.part");
	assert.ok(part);
	assert.equal(part.tsMs, Date.UTC(2026, 10, 24, 19, 5, 7));
	assert.equal(part.part, true);

	assert.equal(parseSegmentRelPath("junk/cam/190507.mp4"), null);
	assert.equal(parseSegmentRelPath("2026-11-24/19/cam_a/readme.txt"), null);
});

test("listSegments walks the whole store sorted by start", () => {
	const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "rec-paths-"));
	try {
		const mk = (rel) => {
			fs.mkdirSync(path.dirname(path.join(tmp, rel)), { recursive: true });
			fs.writeFileSync(path.join(tmp, rel), "x");
		};
		mk("2026-11-24/18/cam_b/185959.part");
		mk("2026-11-24/19/cam_a/190000.mp4");
		mk("2026-11-24/19/cam_a/190010.mp4");
		mk("2026-11-25/00/cam_a/000000.mp4");
		mk("README");
		const entries = listSegments(tmp, { fs });
		assert.deepEqual(
			entries.map((e) => `${e.camera}:${e.part ? "part" : "final"}`),
			["cam_b:part", "cam_a:final", "cam_a:final", "cam_a:final"],
		);
		assert.equal(entries[0].tsMs, Date.UTC(2026, 10, 24, 18, 59, 59));
		assert.equal(entries[3].tsMs, Date.UTC(2026, 10, 25, 0, 0, 0));
	} finally {
		fs.rmSync(tmp, { recursive: true, force: true });
	}
});

test("DAY_MS matches the folder granularity", () => {
	assert.equal(DAY_MS, 86400000);
});
