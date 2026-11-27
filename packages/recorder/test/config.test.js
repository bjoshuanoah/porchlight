// config.test.js — config load (JSON + YAML) and validation (PORCH-127).

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { loadConfig, resolveDefaults, validateConfig } from "../src/config.js";

/** @returns {import("../src/types.js").RecorderConfig} minimal valid config */
const good = () => ({
	storageRoot: "/tmp/store",
	cameras: [{ name: "front_left", source: { url: "rtsp://cam/l" } }],
});

test("validateConfig resolves the safe defaults", () => {
	const d = resolveDefaults(validateConfig(good()));
	assert.equal(d.segmentSeconds, 600);
	assert.equal(d.retentionDays, 7);
	assert.equal(d.highWaterFraction, 0.9);
	assert.equal(d.port, 8971);
	assert.match(d.statePath, /recorder-state\.json$/);
});

test("validateConfig rejects bad cameras and unsafe names", () => {
	// PORCH-134 ac-1: an empty fleet is legal — the fresh deployment Mac boots
	// headless with zero cameras configured; missing/non-array still fail.
	assert.throws(() => validateConfig({ storageRoot: "/tmp" }), /cameras: required array/);
	assert.throws(() => validateConfig({ storageRoot: "/tmp", cameras: "nope" }), /cameras: required array/);
	assert.doesNotThrow(() => validateConfig({ storageRoot: "/tmp", cameras: [] }));
	assert.throws(() => validateConfig({ storageRoot: "/tmp", cameras: [{ name: "../etc", source: { url: "x" } }] }), /invalid camera name/);
	assert.throws(() => validateConfig({ storageRoot: "/tmp", cameras: [{ name: "a", source: { url: "x" } }, { name: "a", source: { url: "y" } }] }), /duplicate camera name/);
	assert.throws(() => validateConfig({ storageRoot: "/tmp", cameras: [{ name: "a", source: {} }] }), /needs url or synthetic/);
	assert.throws(() => validateConfig({ storageRoot: "/tmp", cameras: [{ name: "a", source: { url: "x" }, audioMode: "passthrough" }] }), /audioMode/);
	assert.throws(() => validateConfig({ ...good(), segmentSeconds: 0 }), /segmentSeconds/);
	assert.throws(() => validateConfig({ ...good(), highWaterFraction: 1.5 }), /highWaterFraction/);
	assert.throws(() => validateConfig({ cameras: good().cameras }), /storageRoot/);
});

test("loadConfig reads YAML and JSON with versioned-config discipline", () => {
	const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "rec-cfg-"));
	try {
		const yml = path.join(tmp, "recorder.yaml");
		fs.writeFileSync(yml, [
			"storageRoot: /tmp/store",
			"segmentSeconds: 300",
			"retentionDays: 7",
			"cameras:",
			"  - name: front_left",
			"    source:",
			"      url: rtsp://cam/l",
			"  - name: soak_1",
			"    audioMode: transcode",
			"    source:",
			"      synthetic:",
			"        size: 640x360",
			"        fps: 12",
			"        encoder: h264_videotoolbox",
		].join("\n"));
		const cfg = loadConfig(yml);
		assert.equal(cfg.segmentSeconds, 300);
		assert.equal(cfg.cameras.length, 2);
		assert.equal(cfg.cameras[1].source.synthetic?.encoder, "h264_videotoolbox");

		const json = path.join(tmp, "recorder.json");
		fs.writeFileSync(json, JSON.stringify(good()));
		assert.equal(loadConfig(json).cameras[0].name, "front_left");
		fs.writeFileSync(path.join(tmp, "bad.json"), "{not json");
		assert.throws(() => loadConfig(path.join(tmp, "bad.json")));
	} finally {
		fs.rmSync(tmp, { recursive: true, force: true });
	}
});

test("loadConfig validates a broken YAML field", () => {
	const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "rec-cfg-"));
	try {
		const yml = path.join(tmp, "broken.yaml");
		fs.writeFileSync(yml, "storageRoot: /tmp\ncameras:\n  - name: a\n    source:\n      url: rtsp://x\nsegmentSeconds: nope\n");
		assert.throws(() => loadConfig(yml), /segmentSeconds/);
	} finally {
		fs.rmSync(tmp, { recursive: true, force: true });
	}
});

test("streams: the manager's base-port knob validates with field-path errors (PORCH-154)", () => {
	// Valid: object shape, base optional (the contract default 8972 applies at
	// relay-derivation time), anything >= 1024 accepted.
	assert.doesNotThrow(() => validateConfig({ ...good(), streams: { base: 9500 } }));
	assert.doesNotThrow(() => validateConfig({ ...good(), streams: {} }));
	// Wrong shapes name the exact field path in plain language.
	assert.throws(
		() => validateConfig({ ...good(), streams: "8972" }),
		/config\.streams: expected an object with an optional integer `base` port/,
	);
	assert.throws(() => validateConfig({ ...good(), streams: 8972 }), /config\.streams/);
	// Low base: beneath the well-known-port floor (contract floor 1024).
	assert.throws(
		() => validateConfig({ ...good(), streams: { base: 1023 } }),
		/config\.streams\.base: must be an integer >= 1024/,
	);
	// Wrong-typed base: stringed and fractional integers both refuse.
	assert.throws(() => validateConfig({ ...good(), streams: { base: "9500" } }), /config\.streams\.base/);
	assert.throws(() => validateConfig({ ...good(), streams: { base: 8972.5 } }), /config\.streams\.base/);
});

test("resolveDefaults leaves streams untouched: the knob is read only at relay derivation", () => {
	const cfg = validateConfig({ ...good(), streams: { base: 9500 } });
	const defaults = resolveDefaults(cfg);
	// The resolved defaults never inherit or default streams — arg.js's
	// relayPortFor consumes cfg.streams directly.
	assert.ok(!("streams" in defaults));
	// And the config of record itself keeps its knob, unmutated.
	assert.deepEqual(cfg.streams, { base: 9500 });
	assert.ok(!("streams" in resolveDefaults(validateConfig(good()))));
});
