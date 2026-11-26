// sink.test.js — MQTT sink roundtrip, offline buffering, and status (PORCH-128).

import { test } from "node:test";
import assert from "node:assert/strict";
import mqtt from "mqtt";

import { MqttDetectionSink, NullDetectionSink } from "../src/sink.mqtt.js";
import { startBroker } from "./helpers/broker.js";

/** @param {string} camera @param {string} trackId @param {number} t */
const object = (camera, trackId, t) => ({ camera, trackId, cls: "person", conf: 0.9, bbox: [0.1, 0.1, 0.2, 0.2], t });

test("NullDetectionSink records published objects for harness runs", async () => {
	const sink = new NullDetectionSink();
	await sink.publish(object("cam-1", "t-1", 1));
	assert.equal(sink.published.length, 1);
	assert.deepEqual(sink.status(), { transport: "null", published: 1 });
});

test("mqtt sink publishes one DetectedObject per camera topic; subscriber receives exact payload", async () => {
	const broker = await startBroker();
	try {
		const subscriber = mqtt.connect(broker.url);
		await new Promise((r) => subscriber.once("connect", r));
		const received = /** @type {{ topic: string, payload: string }[]} */ ([]);
		subscriber.on("message", (topic, _payload) => received.push({ topic, payload: _payload.toString() }));
		subscriber.subscribe("porchlight/engine/detections/#");
		// allow the subscription to propagate
		await new Promise((r) => setTimeout(r, 50));

		const sink = await new MqttDetectionSink({ url: broker.url }).start();
		await sink.publish(object("cam-1", "t-1", 5));
		await sink.publish(object("cam-2", "t-2", 5.1));
		await new Promise((r) => setTimeout(r, 100));
		assert.equal(received.length, 2);
		assert.deepEqual(received.map((r) => r.topic).sort(), [
			"porchlight/engine/detections/cam-1",
			"porchlight/engine/detections/cam-2",
		]);
		const parsed = JSON.parse(received[0].payload);
		assert.deepEqual(parsed, { camera: "cam-1", trackId: "t-1", cls: "person", conf: 0.9, bbox: [0.1, 0.1, 0.2, 0.2], t: 5 });
		assert.equal(sink.status().connected, true);
		assert.equal(sink.status().dropped, 0);
		await Promise.all([new Promise((r) => sink.close().then(r)), new Promise((r) => subscriber.end(true, {}, r))]);
	} finally {
		await broker.close();
	}
});

test("mqtt sink buffers offline, caps the buffer, and reports drops", async () => {
	// Injected client exercises the offline path without network assumptions.
	/** @type {string[]} */
	const writes = [];
	const fake = {
		connected: false,
		/** @param {string} topic @param {string} _payload @param {unknown} _o */
		publish(topic, _payload, _o) {
			writes.push(topic);
		},
	};
	const sink = new MqttDetectionSink({ url: "mqtt://127.0.0.1:1", client: fake, bufferLimit: 5 });
	await sink.start();
	for (let i = 0; i < 8; i++) await sink.publish(object("cam-1", `t-${i}`, i));
	assert.equal(sink.buffer.length, 5);
	assert.equal(sink.dropped, 3);
	assert.deepEqual(writes, []);
	fake.connected = true;
	await sink.publish(object("cam-2", "t-9", 9));
	// Reconnect flushes the five buffered objects, then the live one.
	assert.deepEqual(writes, [
		"porchlight/engine/detections/cam-1",
		"porchlight/engine/detections/cam-1",
		"porchlight/engine/detections/cam-1",
		"porchlight/engine/detections/cam-1",
		"porchlight/engine/detections/cam-1",
		"porchlight/engine/detections/cam-2",
	]);
	assert.equal(sink.buffer.length, 0);
	await sink.close();
});

test("mqtt sink start() times out when the broker is unreachable", async () => {
	const sink = new MqttDetectionSink({ url: "mqtt://127.0.0.1:1", connectTimeoutMs: 300, reconnectPeriodMs: 100 });
	await assert.rejects(() => sink.start(), /connect timeout/);
	// mqtt.js keeps retrying in background; force-stop it.
	await new Promise((r) => setTimeout(r, 50));
	await new Promise((r) => /** @type {any} */ (sink.client)?.end(true, {}, r));
});
