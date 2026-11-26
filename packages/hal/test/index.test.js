// index.test.js — HAL resolution and injection (PORCH-132).

import { test } from "node:test";
import assert from "node:assert/strict";
import { DarwinBackend, LinuxBackend, createHal, resolveHal } from "../src/index.js";

test("resolveHal: darwin host resolves the VideoToolbox/CoreML backend", () => {
	const hal = resolveHal({ platform: "darwin" });
	assert.ok(hal instanceof DarwinBackend);
	assert.equal(hal.platform, "darwin");
	assert.deepEqual(hal.videoDecodeArgs(), ["-hwaccel", "videotoolbox"]);
	assert.deepEqual(hal.inferenceExecutionProviders(), ["coreml", "cpu"]);
});

test("resolveHal: linux host resolves the first-cut CPU backend", () => {
	const hal = resolveHal({ platform: "linux" });
	assert.ok(hal instanceof LinuxBackend);
	assert.equal(hal.platform, "linux");
	assert.deepEqual(hal.inferenceExecutionProviders(), ["cpu"]);
});

test("resolveHal: unknown platform is a loud failure, never a silent CPU default", () => {
	assert.throws(() => resolveHal({ platform: "win32" }), /no HAL backend for platform/);
});

test("createHal: an injected backend wins — services run unmodified against any backend", () => {
	const byInjection = createHal({ backend: new LinuxBackend() });
	assert.ok(byInjection instanceof LinuxBackend);
	const byDefault = createHal();
	assert.equal(byDefault.platform, process.platform);
});

test("createHal: default resolution matches the running host (the macOS path resolves natively)", () => {
	if (process.platform !== "darwin") return;
	const hal = resolveHal();
	assert.ok(hal instanceof DarwinBackend);
});
