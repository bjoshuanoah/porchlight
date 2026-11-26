// compose.test.js — composition resolver: union semantics, contributors, overlaps (PORCH-135).

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { createConfigService } from "../src/index.js";

function makeService() {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "porch-compose-"));
	const service = createConfigService({ root, consoleDist: null });
	return { service, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

const rect = (x1, y1, x2, y2) => [[x1, y1], [x2, y1], [x2, y2], [x1, y2]];

test("overlapping enabled zones compose as a union — both stay contributors", () => {
	const { service, cleanup } = makeService();
	try {
		const a = service.zones.create("cam_a", { name: "driveway", polygon: rect(10, 10, 40, 50) });
		const b = service.zones.create("cam_a", { name: "walkway", polygon: rect(30, 30, 60, 70) });

		const c = service.compose("cam_a");
		assert.equal(c.cameraId, "cam_a");
		// The resolver never silently overrides: both definitions are returned.
		assert.deepEqual(c.zones.map((z) => z.id), [a.id, b.id]);
		assert.deepEqual(c.contributors.map((k) => k.kind), ["zone", "zone"]);
		assert.deepEqual(c.contributors.map((k) => k.name), ["driveway", "walkway"]);
		assert.deepEqual(c.overlaps, [{ kind: "zone", ids: [a.id, b.id] }]);
	} finally {
		cleanup();
	}
});

test("disabled zones stay listed as contributors but never form overlap groups", () => {
	const { service, cleanup } = makeService();
	try {
		const a = service.zones.create("cam_a", { name: "active", polygon: rect(10, 10, 40, 50) });
		const off = service.zones.create("cam_a", { name: "disabled", polygon: rect(20, 20, 50, 50), enabled: false });

		const c = service.compose("cam_a");
		assert.equal(c.zones.length, 2); // contributor identity preserved
		assert.deepEqual(c.contributors, [
			{ kind: "zone", id: a.id, name: "active", enabled: true },
			{ kind: "zone", id: off.id, name: "disabled", enabled: false },
		]);
		assert.deepEqual(c.overlaps, []); // disabled defs don't participate
	} finally {
		cleanup();
	}
});

test("zone↔mask intersections render as cross-kind overlap groups — never a silent exclusion", () => {
	const { service, cleanup } = makeService();
	try {
		const zone = service.zones.create("cam_a", { name: "zone_x", polygon: rect(10, 10, 40, 50) });
		const mask = service.masks.create("cam_a", { name: "mask_x", polygon: rect(20, 20, 50, 50) });
		const far = service.masks.create("cam_a", { name: "mask_far", polygon: rect(60, 60, 80, 80) });

		const c = service.compose("cam_a");
		// A mask excluding part of a zone composes visibly: both stay listed
		// and the intersection is named, not silently resolved.
		assert.deepEqual(c.overlaps, [{ kind: "zone+mask", ids: [zone.id, mask.id] }]);
		assert.equal(c.contributors.length, 3);
		assert.deepEqual(c.contributors.map((k) => k.kind), ["zone", "mask", "mask"]);
		assert.ok(c.contributors.every((k) => k.id !== far.id || k.enabled === true));
	} finally {
		cleanup();
	}
});

test("three-way overlap chains into one group with every contributor kept", () => {
	const { service, cleanup } = makeService();
	try {
		const a = service.zones.create("cam_a", { name: "a", polygon: rect(0, 0, 30, 30) });
		const b = service.zones.create("cam_a", { name: "b", polygon: rect(20, 0, 50, 30) });
		const c = service.zones.create("cam_a", { name: "c", polygon: rect(40, 0, 70, 30) });

		const comp = service.compose("cam_a");
		assert.deepEqual(comp.overlaps, [{ kind: "zone", ids: [a.id, b.id, c.id] }]);
		assert.equal(comp.zones.length, 3); // union law: nothing dropped
	} finally {
		cleanup();
	}
});

test("mask overlap groups are their own union-of-exclusions chain", () => {
	const { service, cleanup } = makeService();
	try {
		const m1 = service.masks.create("cam_a", { name: "m1", polygon: rect(0, 0, 20, 20) });
		const m2 = service.masks.create("cam_a", { name: "m2", polygon: rect(15, 15, 35, 35) });
		const m3 = service.masks.create("cam_a", { name: "m3", polygon: rect(60, 60, 80, 80) });

		const c = service.compose("cam_a");
		assert.deepEqual(c.overlaps, [{ kind: "mask", ids: [m1.id, m2.id] }]);
		assert.deepEqual(c.masks.map((m) => m.id), [m1.id, m2.id, m3.id]);
		assert.deepEqual(c.contributors.filter((k) => k.id === m3.id), [{ kind: "mask", id: m3.id, name: "m3", enabled: true }]);
	} finally {
		cleanup();
	}
});

test("compose is per-camera and empty on unknown cameras", () => {
	const { service, cleanup } = makeService();
	try {
		service.zones.create("cam_a", { name: "a", polygon: rect(0, 0, 10, 10) });
		assert.deepEqual(service.compose("cam_b"), {
			cameraId: "cam_b",
			zones: [],
			masks: [],
			contributors: [],
			overlaps: [],
		});
	} finally {
		cleanup();
	}
});
