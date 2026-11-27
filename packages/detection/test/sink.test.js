// sink.test.js — MQTT sink roundtrip, offline buffering, and status (PORCH-128).

import { test } from "node:test";
import assert from "node:assert/strict";
import mqtt from "mqtt";

import { MqttDetectionSink, NullDetectionSink } from "../src/sink.mqtt.js";
import { startBroker } from "./helpers/broker.js";

/** @param {string} camera @param {string} trackId @param {number} t @param {string} [cls] */
const object = (camera, trackId, t, cls = "person") => ({ camera, trackId, cls, conf: 0.9, bbox: [0.1, 0.1, 0.2, 0.2], t });

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
		await sink.publish(object("cam-2", "t-2", 5.1, "car"));
		await new Promise((r) => setTimeout(r, 100));
		assert.equal(received.length, 2);
		// Topic family of record (PORCH-152): <prefix>/<camera>/<cls>.
		assert.deepEqual(received.map((r) => r.topic).sort(), [
			"porchlight/engine/detections/cam-1/person",
			"porchlight/engine/detections/cam-2/car",
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
		"porchlight/engine/detections/cam-1/person",
		"porchlight/engine/detections/cam-1/person",
		"porchlight/engine/detections/cam-1/person",
		"porchlight/engine/detections/cam-1/person",
		"porchlight/engine/detections/cam-1/person",
		"porchlight/engine/detections/cam-2/person",
	]);
	assert.equal(sink.buffer.length, 0);
	await sink.close();
});

test("same camera, different classes — the cls segment separates topics", async () => {
	const broker = await startBroker();
	try {
		const subscriber = mqtt.connect(broker.url);
		await new Promise((r) => subscriber.once("connect", r));
		const received = /** @type {string[]} */ ([]);
		subscriber.on("message", (topic) => received.push(topic));
		subscriber.subscribe("porchlight/engine/detections/#");
		await new Promise((r) => setTimeout(r, 50));

		const sink = await new MqttDetectionSink({ url: broker.url }).start();
		await sink.publish(object("cam-front", "t-1", 5, "person"));
		await sink.publish(object("cam-front", "t-2", 5.1, "dog"));
		await sink.publish(object("cam-front", "t-3", 5.2, "person"));
		await new Promise((r) => setTimeout(r, 100));
		assert.deepEqual(received, [
			"porchlight/engine/detections/cam-front/person",
			"porchlight/engine/detections/cam-front/dog",
			"porchlight/engine/detections/cam-front/person",
		]);
		await Promise.all([new Promise((r) => sink.close().then(r)), new Promise((r) => subscriber.end(true, {}, r))]);
	} finally {
		await broker.close();
	}
});

test("mqtt sink status is never silent: degraded offline with a buffered-count reason, native online", async () => {
	const fake = {
		connected: false,
		/** @param {string} _topic @param {string} _payload @param {unknown} _o */
		publish(_topic, _payload, _o) {},
	};
	const sink = new MqttDetectionSink({ url: "mqtt://127.0.0.1:1", client: fake });
	await sink.start();
	await sink.publish(object("cam-1", "t-1", 1));
	let status = sink.status();
	assert.equal(status.state, "degraded");
	assert.equal(status.connected, false);
	assert.equal(status.buffered, 1);
	assert.match(/** @type {string} */ (status.reason), /offline/);
	assert.match(/** @type {string} */ (status.reason), /1 detection buffered/);
	fake.connected = true;
	status = sink.status();
	assert.equal(status.state, "native");
	assert.equal(status.reason, null);
	await sink.close();
});

test("mqtt sink start() times out when the broker is unreachable", async () => {
	const sink = new MqttDetectionSink({ url: "mqtt://127.0.0.1:1", connectTimeoutMs: 300, reconnectPeriodMs: 100 });
	await assert.rejects(() => sink.start(), /connect timeout/);
	// mqtt.js keeps retrying in background; force-stop it.
	await new Promise((r) => setTimeout(r, 50));
	await new Promise((r) => /** @type {any} */ (sink.client)?.end(true, {}, r));
});
