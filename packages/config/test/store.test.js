// store.test.js — atomic YAML persistence + restart semantics (PORCH-135).

import { test } from "node:test";
import assert from "node:assert/strict";
import fsDefault from "node:fs";
import os from "node:os";
import pathDefault from "node:path";
import { parse as parseYaml } from "yaml";

import { Store, consoleDirFor } from "../src/store.js";
import { createConfigService } from "../src/index.js";

test("docs live under <root>/config/console", () => {
	assert.equal(consoleDirFor("/Library/Porchlight"), pathDefault.join("/Library/Porchlight", "config", "console"));
});

test("writeDoc/readDoc round-trips nested YAML; reads stay cached and cached writes are visible", () => {
	const tmp = fsDefault.mkdtempSync(pathDefault.join(os.tmpdir(), "porch-store-"));
	try {
		const store = new Store(tmp);
		const doc = { profiles: [{ id: "p1", knobs: { recordingMode: "event" }, tags: ["a", "b"] }] };
		store.writeDoc("profiles", doc);
		assert.deepEqual(store.readDoc("profiles"), doc);
		// The on-disk file is real YAML, parseable by an independent reader.
		const raw = fsDefault.readFileSync(pathDefault.join(consoleDirFor(tmp), "profiles.yaml"), "utf8");
		assert.deepEqual(parseYaml(raw), doc);
	} finally {
		fsDefault.rmSync(tmp, { recursive: true, force: true });
	}
});

test("writes are atomic: tmp file first, rename over target, no tmp residue", () => {
	const tmp = fsDefault.mkdtempSync(pathDefault.join(os.tmpdir(), "porch-store-"));
	try {
		const calls = [];
		const fsSpy = {
			existsSync: (...a) => fsDefault.existsSync(...a),
			readFileSync: (...a) => fsDefault.readFileSync(...a),
			mkdirSync: (...a) => fsDefault.mkdirSync(...a),
			writeFileSync: (file, data) => {
				calls.push(["write", file]);
				return fsDefault.writeFileSync(file, data);
			},
			renameSync: (from, to) => {
				calls.push(["rename", from, to]);
				return fsDefault.renameSync(from, to);
			},
		};
		const store = new Store(tmp, { fs: fsSpy });
		const dir = consoleDirFor(tmp);
		store.writeDoc("zones", { zones: [] });

		const writes = calls.filter(([kind]) => kind === "write");
		const renames = calls.filter(([kind]) => kind === "rename");
		assert.equal(writes.length, 1);
		assert.equal(renames.length, 1);
		const [, writeTarget] = writes[0];
		const [, renameFrom, renameTo] = renames[0];
		// Data lands in a sibling tmp file, then one atomic rename publishes it.
		assert.notEqual(writeTarget, pathDefault.join(dir, "zones.yaml"));
		assert.equal(renameFrom, writeTarget);
		assert.equal(renameTo, pathDefault.join(dir, "zones.yaml"));
		assert.equal(fsDefault.readdirSync(dir).filter((f) => f.endsWith(".tmp")).length, 0);
	} finally {
		fsDefault.rmSync(tmp, { recursive: true, force: true });
	}
});

test("reading a missing doc yields {} without creating files", () => {
	const tmp = fsDefault.mkdtempSync(pathDefault.join(os.tmpdir(), "porch-store-"));
	try {
		const store = new Store(tmp);
		assert.deepEqual(store.readDoc("cameras"), {});
		assert.equal(fsDefault.existsSync(consoleDirFor(tmp)), false); // read never creates the dir
	} finally {
		fsDefault.rmSync(tmp, { recursive: true, force: true });
	}
});

test("two service instances over the same dir: restart resumes full state", () => {
	const root = fsDefault.mkdtempSync(pathDefault.join(os.tmpdir(), "porch-store-"));
	try {
		const first = createConfigService({ root, consoleDist: null });
		const camera = first.cameras.upsert("front_left", { name: "Front Left", width: 1920, height: 1080, snapshotUrl: "http://cam/snap" });
		const zone = first.zones.create("front_left", { name: "driveway", polygon: [[10, 10], [40, 10], [40, 50], [10, 50]] });
		first.base.setScope("_default", { recordingMode: "event" });
		const profile = first.profiles.create({ name: "night", knobs: { recordingMode: "event" } });
		first.profiles.activate(profile.id);
		first.speed.set("front_left", { enabled: true, line: { p1: [0, 0], p2: [0, 50] }, meters: 10 });

		const reborn = createConfigService({ root, consoleDist: null });
		assert.deepEqual(reborn.cameras.list(), [camera]);
		assert.deepEqual(reborn.zones.list("front_left"), [zone]);
		assert.deepEqual(reborn.base.getAll(), { _default: { recordingMode: "event" } });
		assert.deepEqual(reborn.profiles.list(), [profile]);
		assert.deepEqual(reborn.profiles.activeState(), { profileId: profile.id, name: "night", source: "manual" });
		assert.equal(reborn.speed.get("front_left").meters, 10);

		// The reborn instance keeps writing to the same dir coherently.
		const zone2 = reborn.masks.create("front_left", { name: "mailbox", polygon: [[0, 0], [5, 0], [5, 5], [0, 5]] });
		assert.deepEqual(new Store(root).readDoc("masks").masks, [zone2]);
	} finally {
		fsDefault.rmSync(root, { recursive: true, force: true });
	}
});
