// speed.test.js — speed calibration math and track estimates (PORCH-135).

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { NotFoundError } from "../src/types.js";
import { qualityGrade } from "../src/speed.js";
import { createConfigService } from "../src/index.js";

function makeService({ width = 1920, height = 1080 } = {}) {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "porch-speed-"));
	const service = createConfigService({ root, consoleDist: null });
	service.cameras.upsert("cam_a", { name: "front", width, height });
	return { service, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

test("pxPerMeter is the calibration line pixel length / real meters", () => {
	const { service, cleanup } = makeService();
	try {
		// Line spans 50% of frame height → 540 px at 1080; 10 real meters.
		service.speed.set("cam_a", { enabled: true, line: { p1: [0, 0], p2: [0, 50] }, meters: 10 });
		const entry = service.speed.get("cam_a");
		assert.equal(entry.enabled, true);
		assert.deepEqual(entry.line, { p1: [0, 0], p2: [0, 50] });
		assert.equal(entry.meters, 10);

		// Track walks 10% of height (108 px) in 10 s → 108/54/10 = 0.2 m/s.
		const out = service.speed.estimate("cam_a", [
			{ t: 0, px: 10, py: 10 },
			{ t: 10, px: 10, py: 20 },
		]);
		assert.equal(out.estimate, true); // always labeled as an estimate
		assert.equal(out.quality.pxPerMeter, 54);
		assert.equal(out.quality.grade, "good");
		assert(Math.abs(out.speedMps - 0.2) < 1e-12);
	} finally {
		cleanup();
	}
});

test("grade thresholds are 40 good / 15 fair / else poor at the current resolution", () => {
	const { service, cleanup } = makeService();
	try {
		// Line pixel length fixed at 540 px (0–50% height).
		const cases = [
			{ meters: 13.5, grade: "good" }, // 40 px/m
			{ meters: 27, grade: "fair" }, // 20 px/m
			{ meters: 60, grade: "poor" }, // 9 px/m
		];
		for (const { meters, grade } of cases) {
			service.speed.set("cam_a", { line: { p1: [0, 0], p2: [0, 50] }, meters });
			const out = service.speed.estimate("cam_a", [
				{ t: 0, px: 0, py: 0 },
				{ t: 1, px: 0, py: 1 },
			]);
			assert.equal(out.quality.grade, grade, `meters=${meters}`);
			assert.equal(out.estimate, true);
		}
		// Unit checks of the boundary constants.
		assert.equal(qualityGrade(40), "good");
		assert.equal(qualityGrade(39.9), "fair");
		assert.equal(qualityGrade(15), "fair");
		assert.equal(qualityGrade(14.9), "poor");
	} finally {
		cleanup();
	}
});

test("speed test requires stored calibration (plain-language 422)", () => {
	const { service, cleanup } = makeService();
	try {
		assert.throws(() => service.speed.estimate("cam_a", [{ t: 0, px: 0, py: 0 }, { t: 1, px: 1, py: 1 }]), /no calibration stored for camera "cam_a"/);
	} finally {
		cleanup();
	}
});

test("speed validation rejects impossible calibrations", () => {
	const { service, cleanup } = makeService();
	try {
		assert.throws(() => service.speed.set("cam_a", { meters: 0 }), /meters/);
		assert.throws(() => service.speed.set("cam_a", { meters: -3 }), /meters/);
		assert.throws(() => service.speed.set("cam_a", { line: { p1: [10, 10], p2: [10, 10] }, meters: 5 }), /endpoints must differ/);
		assert.throws(() => service.speed.set("cam_a", { line: { p1: [101, 0], p2: [0, 0] }, meters: 5 }), /\[0, 100\]/);
		assert.throws(() => service.speed.set("cam_a", { area: [[0, 0], [200, 200], [10, 10]] }), /\[0, 100\]/);
		assert.throws(() => service.speed.set("cam_a", { line: { p1: [0, 0], p2: [0, 10] } }), /line and meters must be calibrated together/);
	} finally {
		cleanup();
	}
});

test("speed test rejects degenerate tracks", () => {
	const { service, cleanup } = makeService();
	try {
		service.speed.set("cam_a", { line: { p1: [0, 0], p2: [0, 50] }, meters: 10 });
		assert.throws(() => service.speed.estimate("cam_a", [{ t: 0, px: 0, py: 0 }]), /at least two samples/);
		assert.throws(() => service.speed.estimate("cam_a", [
			{ t: 5, px: 0, py: 0 },
			{ t: 5, px: 1, py: 0 },
		]), /positive time window/);
		assert.throws(() => service.speed.estimate("cam_a", "nope"), /track/);
		assert.throws(() => service.speed.estimate("cam_a", [
			{ t: 0, px: 0, py: 0 },
			{ t: 1, px: 150, py: 0 },
		]), /\[0, 100\]/);
	} finally {
		cleanup();
	}
});

test("estimate works through an unsorted track and multi-hop paths", () => {
	const { service, cleanup } = makeService();
	try {
		service.speed.set("cam_a", { enabled: true, line: { p1: [0, 0], p2: [0, 100] }, meters: 54 });
		// 1080 px line / 54 m → 20 px/m (fair). Track: 10% then another 10% of height (216 px), 12 s total.
		const out = service.speed.estimate("cam_a", [
			{ t: 12, px: 50, py: 20 },
			{ t: 0, px: 50, py: 0 },
			{ t: 6, px: 50, py: 10 },
		]);
		assert.equal(out.quality.grade, "fair");
		assert.equal(out.estimate, true);
		assert(Math.abs(out.speedMps - 216 / 20 / 12) < 1e-12);
	} finally {
		cleanup();
	}
});

test("speed service resolves pxPerMeter against the camera's stored resolution", () => {
	const { service, cleanup } = makeService({ width: 640, height: 360 });
	try {
		// Same percent line resolves differently at 360p-ish: 180 px / 4.5 m = 40 px/m → good.
		service.speed.set("cam_a", { line: { p1: [0, 0], p2: [0, 50] }, meters: 4.5 });
		const out = service.speed.estimate("cam_a", [
			{ t: 0, px: 0, py: 0 },
			{ t: 1, px: 0, py: 10 },
		]);
		assert.equal(out.quality.pxPerMeter, 40);
		assert.equal(out.quality.grade, "good");
		assert.equal(out.estimate, true);
	} finally {
		cleanup();
	}
});

test("estimate on an unknown camera is a NotFoundError", () => {
	const { service, cleanup } = makeService();
	try {
		service.speed.set("cam_a", { line: { p1: [0, 0], p2: [0, 50] }, meters: 10 });
		assert.throws(() => service.speed.estimate("ghost", [{ t: 0, px: 0, py: 0 }, { t: 1, px: 1, py: 1 }]), NotFoundError);
	} finally {
		cleanup();
	}
});

test("speed calibration persists across a fresh service instance", () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "porch-speed-"));
	try {
		const first = createConfigService({ root, consoleDist: null });
		first.cameras.upsert("cam_a", { name: "front", width: 1920, height: 1080 });
		first.speed.set("cam_a", { enabled: true, area: [[0, 50], [100, 50], [50, 100]], line: { p1: [0, 0], p2: [0, 50] }, meters: 10 });

		const reborn = createConfigService({ root, consoleDist: null });
		assert.deepEqual(reborn.speed.get("cam_a"), first.speed.get("cam_a"));
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});
