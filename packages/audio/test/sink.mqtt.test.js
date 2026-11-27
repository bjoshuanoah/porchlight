// sink.mqtt.test.js — MQTT audio-event publishing roundtrip, offline
// buffering, and status (PORCH-153).

import { test } from "node:test";
import assert from "node:assert/strict";
import mqtt from "mqtt";

import { MqttAudioSink, NullAudioSink } from "../src/sink.mqtt.js";
import { startBroker } from "./helpers/broker.js";

/** @param {string} camera @param {string} cls @param {number} timestamp */
const event = (camera, cls, timestamp) =>
	({ camera, timestamp, class: cls, confidence: 0.9, clipStart: timestamp - 1, clipEnd: timestamp, provider: "onnx-audio" });

test("NullAudioSink records published events for harness runs", async () => {
	const sink = new NullAudioSink();
	await sink.publish(event("cam-1", "dog-bark", 101));
	assert.equal(sink.published.length, 1);
	assert.deepEqual(sink.status(), { transport: "null", published: 1 });
});

test("mqtt audio sink publishes onto the detections family topic; subscriber receives exactly the AudioEvent payload", async () => {
	const broker = await startBroker();
	try {
		const subscriber = mqtt.connect(broker.url);
		await new Promise((r) => subscriber.once("connect", r));
		const received = /** @type {{ topic: string, payload: string }[]} */ ([]);
		subscriber.on("message", (topic, _payload) => received.push({ topic, payload: _payload.toString() }));
		subscriber.subscribe("porchlight/engine/detections/#");
		await new Promise((r) => setTimeout(r, 50));

		const sink = await new MqttAudioSink({ url: broker.url }).start();
		await sink.publish(event("cam-9", "dog-bark", 105));
		await sink.publish(event("cam-9", "glass-break", 106));
		await new Promise((r) => setTimeout(r, 100));
		assert.equal(received.length, 2);
		// Topic family of record — the SAME two-segment family every bus
		// consumer keys on (recorder event triggers, home event ingest).
		assert.deepEqual(received.map((r) => r.topic).sort(), [
			"porchlight/engine/detections/cam-9/dog-bark",
			"porchlight/engine/detections/cam-9/glass-break",
		]);
		const parsed = JSON.parse(received[0].payload);
		// The TS 8 field set of record rides the detections family payload.
		assert.deepEqual(parsed, { camera: "cam-9", timestamp: 105, class: "dog-bark", confidence: 0.9, clipStart: 104, clipEnd: 105, provider: "onnx-audio" });
		assert.equal(sink.status().connected, true);
		assert.equal(sink.status().dropped, 0);
		assert.equal(sink.status().reason, null);
		await Promise.all([
			new Promise((r) => sink.close().then(r)),
			new Promise((r) => subscriber.end(true, {}, r)),
		]);
	} finally {
		await broker.close();
	}
});

test("mqtt audio sink buffers offline, caps the buffer, and states the degradation", async () => {
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
	const sink = new MqttAudioSink({ url: "mqtt://127.0.0.1:1", client: fake, bufferLimit: 5 });
	await sink.start();
	for (let i = 0; i < 8; i++) await sink.publish(event("cam-1", "dog-bark", 200 + i));
	assert.equal(sink.buffer.length, 5);
	assert.equal(sink.dropped, 3);
	assert.deepEqual(writes, []);
	// Never-silent: the offline bus names its degradation with the count.
	const status = sink.status();
	assert.equal(status.state, "degraded");
	assert.match(String(status.reason), /bus offline — 5 audio events buffered/);
	fake.connected = true;
	await sink.publish(event("cam-2", "glass-break", 209));
	assert.deepEqual(writes, [
		"porchlight/engine/detections/cam-1/dog-bark",
		"porchlight/engine/detections/cam-1/dog-bark",
		"porchlight/engine/detections/cam-1/dog-bark",
		"porchlight/engine/detections/cam-1/dog-bark",
		"porchlight/engine/detections/cam-1/dog-bark",
		"porchlight/engine/detections/cam-2/glass-break",
	]);
	assert.equal(sink.buffer.length, 0);
	await sink.close();
});

test("publish before start throws — the sink never pretends to publish", async () => {
	const sink = new MqttAudioSink({ url: "mqtt://127.0.0.1:1" });
	await assert.rejects(() => sink.publish(event("cam-1", "dog-bark", 300)), /start\(\) must run/);
});
