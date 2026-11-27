// service.test.js — DetectionService pipeline: test-double provider through
// tracking to publishing, latency budget, and provider pluggability (PORCH-128).

import { test } from "node:test";
import assert from "node:assert/strict";
import mqtt from "mqtt";

import { DetectionService } from "../src/service.js";
import { DetectionTracker } from "../src/tracker.js";
import { MqttDetectionSink } from "../src/sink.mqtt.js";
import { ProviderRegistry } from "../src/registry.js";
import { startBroker } from "./helpers/broker.js";

/** @param {string} camera @param {number} t @returns {import("../src/types.js").Frame} */
const frame = (camera, t) => ({ camera, w: 4, h: 2, t, format: "rgb", data: new Uint8Array(24) });

/** Minimal sink collecting publishes (NullDetectionSink shape). */
class SinkProbe {
	/** @type {import("../src/types.js").DetectedObject[]} */
	published = [];
	/** @param {import("../src/types.js").DetectedObject} o */
	async publish(o) {
		this.published.push(o);
	}
	async close() {}
}

/**
 * Deterministic test double: emits a person detection.
 * @returns {import("../src/types.js").InferenceProvider}
 */
function testDoubleProvider() {
	return {
		name: "test-double",
		/** @param {import("../src/types.js").Frame} f */
		detect: async (f) => [{ cls: "person", conf: 0.9, bbox: [0.0, 0.4, 0.2, 0.2], t: f.t }],
		status: () => ({ engine: "test-double" }),
	};
}

/** Default factory: immediate confirmation; one id space per service so
 * per-camera tracks never collide. */
const idFactory = makeIds();
const trackerFactory = () => new DetectionTracker({ minHits: 1, nextId: idFactory });

function makeIds() {
	let n = 0;
	return () => `t-${++n}`;
}

test("pipeline: tracked detections carry camera, provider, and stable trackId", async () => {
	const sink = new SinkProbe();
	const service = new DetectionService({ provider: testDoubleProvider(), sink, trackerFactory });
	const r1 = await service.submit(frame("cam-1", 1));
	assert.equal(r1.objects.length, 1);
	const published = sink.published[0];
	assert.equal(published.camera, "cam-1");
	assert.equal(published.provider, "test-double");
	assert.equal(published.trackId, r1.objects[0].trackId);
	assert.equal(service.status().provider.engine, "test-double");
	assert.equal(service.status().frames, 1);
	assert.equal(service.status().published, 1);
});

test("ac-2: frame → provider → tracker → MQTT publish lands on a subscriber within 1s of frame availability", async () => {
	const broker = await startBroker();
	try {
		const subscriber = mqtt.connect(broker.url);
		await new Promise((r) => subscriber.once("connect", r));
		/** @type {number|null} */
		let t0 = null;
		/** @type {number|null} */
		let arrival = null;
		subscriber.subscribe("porchlight/engine/detections/cam-1/person");
		subscriber.on("message", () => {
			if (t0 !== null && arrival === null) arrival = performance.now() - t0;
		});
		await new Promise((r) => setTimeout(r, 50));

		const sink = await new MqttDetectionSink({ url: broker.url }).start();
		const service = new DetectionService({ provider: testDoubleProvider(), sink, trackerFactory });
		t0 = performance.now();
		const r = await service.submit(frame("cam-1", Date.now() / 1000));
		await new Promise((r) => setTimeout(r, 200));
		assert.ok(arrival !== null, "subscriber received the detection");
		assert.ok(/** @type {number} */ (arrival) < 1000, `arrival within 1s budget (was ${arrival?.toFixed(1)}ms)`);
		assert.ok(r.latencyMs < 1000, "service path latency inside the budget");
		await Promise.all([sink.close(), new Promise((r) => subscriber.end(true, {}, r))]);
	} finally {
		await broker.close();
	}
});

test("ac-3: a registry-registered third-party provider runs the full pipeline with zero core changes", async () => {
	const registry = new ProviderRegistry();
	registry.register("openvino-test-double", () => ({
		name: "openvino-test-double",
		/** @param {import("../src/types.js").Frame} f */
		detect: async (f) => [{ cls: "car", conf: 0.8, bbox: [0.5, 0.5, 0.1, 0.1], t: f.t }],
		status: () => ({ engine: "openvino" }),
	}));
	const service = new DetectionService({
		provider: registry.create("openvino-test-double"),
		sink: new SinkProbe(),
		trackerFactory: () => new DetectionTracker({ minHits: 1, nextId: makeIds() }),
	});
	const r = await service.submit(frame("cam-9", 1));
	assert.equal(r.objects.length, 1);
	assert.equal(r.objects[0].provider, "openvino-test-double");
	assert.equal(r.objects[0].cls, "car");
});

test("per-camera trackers keep trackId namespaces apart", async () => {
	const service = new DetectionService({ provider: testDoubleProvider(), sink: new SinkProbe(), trackerFactory });
	await service.submit(frame("cam-a", 1));
	await service.submit(frame("cam-b", 1));
	const ra = await service.submit(frame("cam-a", 1.1));
	const rb = await service.submit(frame("cam-b", 1.1));
	assert.notEqual(ra.objects[0].trackId, rb.objects[0].trackId);
	assert.equal(service.trackers.size, 2);
});

test("repoint: provider B replaces provider A live — publishes carry B, trackers survive, generation increments", async () => {
	const sink = new SinkProbe();
	const providerA = testDoubleProvider();
	/** @type {string[]} */
	const closed = [];
	providerA.close = async () => {
		closed.push("provider-a");
	};
	const providerB = {
		name: "provider-b",
		/** @param {import("../src/types.js").Frame} f */
		detect: async (f) => [{ cls: "person", conf: 0.9, bbox: [0.0, 0.4, 0.2, 0.2], t: f.t }],
		status: () => ({ engine: "provider-b", providerClass: "local-server", state: "native", reason: null }),
	};
	const service = new DetectionService({ provider: providerA, sink, trackerFactory });

	const first = await service.submit(frame("cam-1", 1));
	assert.equal(sink.published[0].provider, "test-double");

	const swap = await service.repoint(providerB);
	assert.deepEqual(swap, { name: "provider-b", generation: 1 });
	assert.equal(service.provider, providerB, "the live seam points at provider B");
	assert.deepEqual(closed, ["provider-a"], "the old provider was closed after the swap");
	assert.equal(service.sink, sink, "the sink is untouched");
	assert.equal(service.trackers.size, 1, "trackers survive the re-point");
	assert.equal(service.status().provider.engine, "provider-b");

	const second = await service.submit(frame("cam-1", 1.1));
	assert.equal(second.objects[0].provider, "provider-b", "subsequent publishes carry the new provider name");
	// Same camera + overlapping bbox across the re-point: the per-camera
	// tracker continues the same track id — no namespace reset.
	assert.equal(second.objects[0].trackId, first.objects[0].trackId);

	await service.repoint({ ...testDoubleProvider(), name: "provider-c" });
	assert.equal(service.status().generation, 2, "generation keeps counting");
	assert.equal(service.status().stage, "detection");
});

test("repoint: close errors of the old provider are logged and never fail the swap", async () => {
	/** @type {string[]} */
	const lines = [];
	const providerA = testDoubleProvider();
	providerA.close = async () => {
		throw new Error("close blew up");
	};
	const service = new DetectionService({
		provider: providerA,
		sink: new SinkProbe(),
		log: (...a) => lines.push(a.join(" ")),
	});
	await service.submit(frame("cam-1", 1));

	const swap = await service.repoint(testDoubleProvider());
	assert.ok(lines.some((l) => l.includes("close during repoint") && l.includes("close blew up")), "swallowed close error is logged");
	assert.deepEqual(swap, { name: "test-double", generation: 1 });
});

test("repoint: an object violating the InferenceProvider protocol throws a TypeError naming the protocol", async () => {
	const service = new DetectionService({ provider: testDoubleProvider(), sink: new SinkProbe(), trackerFactory });
	await assert.rejects(
		() => service.repoint(/** @type {any} */ ({ name: 7, detect: async () => [] })),
		(e) => e instanceof TypeError && /InferenceProvider/.test(e.message),
	);
	await assert.rejects(
		() => service.repoint(/** @type {any} */ ({ name: "no-detect" })),
		(e) => e instanceof TypeError && /InferenceProvider/.test(e.message),
	);
	// A rejected re-point leaves the live seam and generation untouched.
	assert.equal(service.provider.name, "test-double");
	assert.equal(service.status().generation, 0);
});
