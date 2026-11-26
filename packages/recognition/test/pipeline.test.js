// pipeline.test.js — PORCH-141 ac-4: the local pipeline seam. Provider
// registration replaces transparently; the disabled enforcement refuses
// BEFORE any provider call (zero descriptor computations), and the refusal
// is counted in metrics.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
	createRecognitionPipeline,
	RecognitionMetrics,
	VisionProviderRegistry,
} from "../src/pipeline.js";

/** A deterministic test provider (single face, a 4-dim descriptor). */
function fakeProvider(name = "test-embedder", descriptor = [1, 0, 0, 0]) {
	return {
		name,
		async describeFaces() {
			return [{ descriptor, conf: 0.97, box: [0.1, 0.1, 0.5, 0.5] }];
		},
		async readPlates() {
			return [{ text: "6tri889", conf: 0.91 }];
		},
	};
}

function jpegFrame() {
	return { format: "jpeg", data: new Uint8Array([0xff, 0xd8, 0xff, 0xe0]) };
}

test("registry: create builds the registered provider", () => {
	const registry = new VisionProviderRegistry();
	registry.register("test", () => fakeProvider());
	const provider = registry.create("test");
	assert.equal(provider.name, "test-embedder");
});

test("registry: re-register replaces and says so (never silent)", () => {
	const registry = new VisionProviderRegistry();
	assert.deepEqual(registry.register("test", () => fakeProvider()), { replaced: false });
	assert.deepEqual(registry.register("test", () => fakeProvider("swap")), { replaced: true });
	assert.equal(registry.create("test").name, "swap");
	assert.deepEqual(registry.names(), ["test"]);
});

test("registry: unknown name and non-provider shapes fail loud", () => {
	const registry = new VisionProviderRegistry();
	assert.throws(() => registry.create("nope"), /No vision provider/);
	assert.throws(() => registry.register("", () => fakeProvider()));
	assert.throws(() => {
		registry.register("broken", () => /** @type {any} */ ({ name: "broken" }));
		registry.create("broken");
	}, /cannot describe faces/);
});

test("ac-4 pipeline disabled: zero descriptor computations, refusal counted", async () => {
	const metrics = new RecognitionMetrics();
	const pipeline = createRecognitionPipeline({ metrics });
	const provider = fakeProvider();
	await assert.rejects(
		pipeline.computeDescriptor({ enabled: false, provider, frame: jpegFrame() }),
		/switched off/,
	);
	assert.equal(metrics.snapshot().descriptorComputations, 0);
	assert.equal(metrics.snapshot().recognitionRuns, 0);
	assert.equal(metrics.snapshot().refusedDisabled, 1);
});

test("ac-4 pipeline disabled: zero plate reads, refusal counted", async () => {
	const metrics = new RecognitionMetrics();
	const pipeline = createRecognitionPipeline({ metrics });
	await assert.rejects(
		pipeline.computePlates({ enabled: false, provider: fakeProvider(), frame: jpegFrame() }),
		/switched off/,
	);
	assert.equal(metrics.snapshot().plateReads, 0);
	assert.equal(metrics.snapshot().refusedDisabled, 1);
});

test("pipeline enabled: descriptors compute locally and metrics count", async () => {
	const metrics = new RecognitionMetrics();
	const pipeline = createRecognitionPipeline({ metrics });
	const result = await pipeline.computeDescriptor({ enabled: true, provider: fakeProvider(), frame: jpegFrame() });
	assert.equal(result.provider, "test-embedder");
	assert.equal(result.embeddings[0].descriptor[0], 1);
	const snapshot = metrics.snapshot();
	assert.equal(snapshot.descriptorComputations, 1);
	assert.equal(snapshot.recognitionRuns, 1);
});

test("pipeline enabled: plate reads flow through the provider", async () => {
	const pipeline = createRecognitionPipeline({ metrics: new RecognitionMetrics() });
	const result = await pipeline.computePlates({ enabled: true, provider: fakeProvider(), frame: jpegFrame() });
	assert.equal(result.provider, "test-embedder");
	assert.deepEqual(result.plates[0].text, "6tri889");
});

test("pipeline: malformed frames never reach the provider", async () => {
	const pipeline = createRecognitionPipeline({ metrics: new RecognitionMetrics() });
	await assert.rejects(
		pipeline.computeDescriptor({ enabled: true, provider: fakeProvider(), frame: /** @type {any} */ ({ format: "gif", data: new Uint8Array([1]) }) }),
		/Unsupported frame format/,
	);
});

test("metrics snapshot is a copy — callers cannot mutate the audit", () => {
	const metrics = new RecognitionMetrics();
	metrics.bump("descriptorComputations");
	metrics.snapshot().descriptorComputations = 999;
	assert.equal(metrics.snapshot().descriptorComputations, 1);
});
