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
		subscriber.subscribe("porchlight/engine/detections/cam-1");
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
