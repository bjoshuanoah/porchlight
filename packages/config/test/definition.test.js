// definition.test.js — zone/mask CRUD + validation (PORCH-135).

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { NotFoundError } from "../src/types.js";
import { createConfigService } from "../src/index.js";

function makeService() {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "porch-def-"));
	const service = createConfigService({ root, consoleDist: null });
	return {
		root,
		service,
		cleanup: () => fs.rmSync(root, { recursive: true, force: true }),
	};
}

const rect = (x1, y1, x2, y2) => [[x1, y1], [x2, y1], [x2, y2], [x1, y2]];

test("zones create/list/update/remove with defaults and identity", () => {
	const { service, cleanup } = makeService();
	try {
		const zone = service.zones.create("cam_a", { name: "driveway", polygon: rect(10, 10, 40, 50) });
		assert.match(zone.id, /^zone-/);
		assert.equal(zone.cameraId, "cam_a");
		assert.equal(zone.name, "driveway");
		assert.equal(zone.enabled, true); // default on
		assert.deepEqual(zone.polygon, rect(10, 10, 40, 50));

		// A second camera does not leak into the list.
		service.zones.create("cam_b", { name: "other", polygon: rect(0, 0, 10, 10) });
		assert.deepEqual(service.zones.list("cam_a").map((z) => z.id), [zone.id]);
		assert.equal(service.zones.get(zone.id).name, "driveway");

		// Partial update: only the touched fields move.
		const updated = service.zones.update(zone.id, { enabled: false, polygon: rect(1, 1, 2, 2) });
		assert.equal(updated.enabled, false);
		assert.equal(updated.name, "driveway");
		assert.deepEqual(updated.polygon, rect(1, 1, 2, 2));

		assert.equal(service.zones.remove(zone.id), true);
		assert.deepEqual(service.zones.list("cam_a"), []);
		assert.equal(service.zones.get(zone.id), null);
	} finally {
		cleanup();
	}
});

test("zones validate polygon and name with plain-language errors", () => {
	const { service, cleanup } = makeService();
	try {
		assert.throws(() => service.zones.create("cam_a", { name: "x", polygon: [[0, 0], [10, 10]] }), /at least 3/);
		assert.throws(() => service.zones.create("cam_a", { name: "x", polygon: "nope" }), /polygon/);
		assert.throws(() => service.zones.create("cam_a", { name: "x", polygon: [[0, 0], [101, 0], [10, 10]] }), /\[0, 100\]/);
		assert.throws(() => service.zones.create("cam_a", { name: "x", polygon: [[0, -1], [10, 0], [10, 10]] }), /\[0, 100\]/);
		assert.throws(() => service.zones.create("cam_a", { name: "x", polygon: [[0, 0], [10, "five"], [10, 10]] }), /\[0, 100\]/);
		assert.throws(() => service.zones.create("cam_a", { polygon: rect(0, 0, 10, 10) }), /name/);
		assert.throws(() => service.zones.create("cam_a", { name: "", polygon: rect(0, 0, 10, 10) }), /name/);
		assert.throws(() => service.zones.create("cam_a", { name: "x", polygon: rect(0, 0, 10, 10), enabled: "yes" }), /enabled/);
	} finally {
		cleanup();
	}
});

test("zones reject unknown ids and never alias the caller's polygon", () => {
	const { service, cleanup } = makeService();
	try {
		assert.throws(() => service.zones.update("zone-nope", { enabled: true }), NotFoundError);
		assert.throws(() => service.zones.remove("zone-nope"), NotFoundError);

		const zone = service.zones.create("cam_a", { name: "parking", polygon: rect(0, 0, 10, 10) });
		const polygon = zone.polygon;
		polygon[0][0] = 999; // caller mutation must not leak into the store
		assert.equal(service.zones.get(zone.id).polygon[0][0], 0);
	} finally {
		cleanup();
	}
});

test("masks share the same CRUD shape with mask identity", () => {
	const { service, cleanup } = makeService();
	try {
		const mask = service.masks.create("cam_a", { name: "tree_shadow", polygon: rect(5, 5, 15, 15), enabled: true });
		assert.match(mask.id, /^mask-/);
		assert.equal(mask.cameraId, "cam_a");

		// Zone and mask documents stay separate.
		assert.deepEqual(service.zones.list("cam_a"), []);
		assert.equal(service.masks.list("cam_a").length, 1);
		assert.deepEqual(service.masks.get(mask.id).polygon, rect(5, 5, 15, 15));

		assert.throws(() => service.masks.update("mask-nope", {}), /no mask with id/);
		service.masks.remove(mask.id);
		assert.deepEqual(service.masks.list("cam_a"), []);
	} finally {
		cleanup();
	}
});

test("definitions persist across a fresh service instance over the same root", () => {
	const { root, service, cleanup } = makeService();
	try {
		const zone = service.zones.create("cam_a", { name: "gate", polygon: rect(2, 2, 8, 8) });
		const mask = service.masks.create("cam_a", { name: "mailbox", polygon: rect(9, 9, 12, 12) });

		const reborn = createConfigService({ root, consoleDist: null });
		assert.deepEqual(reborn.zones.list("cam_a"), [zone]);
		assert.deepEqual(reborn.masks.list("cam_a"), [mask]);
	} finally {
		cleanup();
	}
});
