// config.test.js — platform config of record bootstrap (PORCH-134).

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
	defaultConfigDocument,
	ensureBootstrapConfig,
	loadPlatformConfig,
	parseInputs,
	renderConfigYaml,
	validatePlatformConfig,
} from "../src/config.js";

test("the default config of record is property-agnostic: zero cameras, defaults stated", () => {
	const cfg = defaultConfigDocument();
	assert.equal(cfg.version, 1);
	assert.equal(cfg.storageRoot, "/Library/Porchlight/recordings");
	assert.deepEqual(cfg.cameras, []);
	assert.equal(cfg.statusPort, 8970);
	assert.equal(cfg.statusHost, "0.0.0.0");
	assert.equal(cfg.segmentSeconds, 600);
	assert.equal(cfg.retentionDays, 7);
});

test("deployment inputs override the defaults through the same validation", () => {
	const cfg = defaultConfigDocument({ cameras: [{ name: "front-door", source: { url: "rtsp://10.0.0.4/stream" } }], statusPort: 9000 });
	assert.equal(cfg.cameras.length, 1);
	assert.equal(cfg.statusPort, 9000);
	// unknown input keys are dropped, never silently carried into the config
	const pruned = defaultConfigDocument({ somethingElse: 42, statusPort: 9001 });
	assert.equal(pruned.somethingElse, undefined);
	assert.equal(pruned.statusPort, 9001);
});

test("invalid inputs fail loudly through the recorder contract", () => {
	assert.throws(() => defaultConfigDocument({ segmentSeconds: "nope" }), /segmentSeconds/);
	assert.throws(() => defaultConfigDocument({ statusPort: 0 }), /statusPort/);
	assert.throws(() => defaultConfigDocument({ statusPort: 70000 }), /statusPort/);
	assert.throws(() => defaultConfigDocument({ statusHost: "" }), /statusHost/);
	assert.throws(() => defaultConfigDocument({ cameras: [{ name: "a/b", source: { url: "x" } }] }), /invalid camera name/);
});

test("validatePlatformConfig accepts the empty fresh-install fleet", () => {
	const cfg = validatePlatformConfig({ storageRoot: "/tmp/store", cameras: [] });
	assert.equal(cfg.statusPort, 8970);
	assert.equal(cfg.statusHost, "0.0.0.0");
});

test("ensureBootstrapConfig writes once and never overwrites on reinstall", () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "porch-cfg-"));
	try {
		const first = ensureBootstrapConfig(dir);
		assert.equal(first.created, true);
		// operator edits after first boot
		const onDisk = fs.readFileSync(first.path, "utf8");
		fs.writeFileSync(first.path, onDisk.replace("8970", "8990"), "utf8");
		const second = ensureBootstrapConfig(dir, { statusPort: 1234 });
		assert.equal(second.created, false);
		assert.equal(loadPlatformConfig(second.path).statusPort, 8990, "reinstall must keep the deployment's config of record");
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test("ensureBootstrapConfig merges config.inputs.yaml from the deployment when present", () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "porch-cfg-"));
	try {
		fs.writeFileSync(path.join(dir, "config.inputs.yaml"), "storageRoot: /Volumes/Cams/store\ncameras: []\n", "utf8");
		const result = ensureBootstrapConfig(dir);
		const cfg = loadPlatformConfig(result.path);
		assert.equal(cfg.storageRoot, "/Volumes/Cams/store");
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test("parseInputs fails loudly on garbage", () => {
	assert.throws(() => parseInputs("{ not json"), /unparseable/);
	assert.throws(() => parseInputs("- a\n- b"), /expected an object/);
	assert.deepEqual(parseInputs('{"a": 1}'), { a: 1 });
});

test("renderConfigYaml round-trips through loadPlatformConfig", () => {
	const cfg = defaultConfigDocument({ cameras: [] });
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "porch-yaml-"));
	try {
		const file = path.join(dir, "config.yaml");
		fs.writeFileSync(file, renderConfigYaml(cfg), "utf8");
		const loaded = loadPlatformConfig(file);
		assert.deepEqual(loaded, cfg);
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});
