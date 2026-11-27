// bus.test.js — the stream health bus seam (PORCH-154): topic family of
// record, MQTT buffering, and the Null bus green-field default.

import { test } from "node:test";
import assert from "node:assert/strict";

import { MqttStreamHealthPublisher, NullStreamHealthBus, streamHealthTopic, STREAM_HEALTH_PREFIX } from "../src/health-bus.js";

test("topic family of record: porchlight/engine/streams/<camera>/<up|down>", () => {
	assert.equal(STREAM_HEALTH_PREFIX, "porchlight/engine/streams");
	assert.equal(streamHealthTopic("front-door", "up"), "porchlight/engine/streams/front-door/up");
	assert.equal(streamHealthTopic("front-door", "down"), "porchlight/engine/streams/front-door/down");
});

test("mqtt publisher: publishes JSON payloads of record on the wired client", async () => {
	/** @type {{ topic: string, msg: string, opts: any }[]} */
	const published = [];
	const client = {
		connected: true,
		/** @param {string} topic @param {string} msg @param {any} opts */
		publish(topic, msg, opts) {
			published.push({ topic, msg, opts });
		},
	};
	const bus = new MqttStreamHealthPublisher({ url: "mqtt://127.0.0.1:1883", client });
	await bus.start();
	await bus.publish(streamHealthTopic("front-door", "up"), { camera: "front-door", state: "up", reason: null, at: 12 });
	assert.equal(published.length, 1);
	assert.equal(published[0].topic, "porchlight/engine/streams/front-door/up");
	assert.deepEqual(JSON.parse(published[0].msg), { camera: "front-door", state: "up", reason: null, at: 12 });
});

test("mqtt publisher: offline events buffer bounded, flush in order on reconnect", async () => {
	/** @type {{ topic: string, msg: string }[]} */
	const published = [];
	/** @type {any} */
	const client = {
		connected: false,
		publish(topic, msg) {
			published.push({ topic, msg });
		},
	};
	const bus = new MqttStreamHealthPublisher({ url: "mqtt://127.0.0.1:1883", client, bufferLimit: 2 });
	await bus.start();
	// offline: buffer, oldest drops beyond the bound, drops are counted
	const later = bus.publish(streamHealthTopic("a", "up"), { camera: "a", state: "up", reason: null, at: 1 });
	await later;
	await bus.publish(streamHealthTopic("a", "down"), { camera: "a", state: "down", reason: "r1", at: 2 });
	await bus.publish(streamHealthTopic("b", "up"), { camera: "b", state: "up", reason: null, at: 3 });
	assert.equal(bus.dropped, 1);
	assert.equal(bus.buffer.length, 2);
	client.connected = true;
	await bus.publish(streamHealthTopic("c", "up"), { camera: "c", state: "up", reason: null, at: 4 });
	assert.equal(published.length, 3, "buffered events flushed in order before the new one");
	// buffer kept [a/down, b/up] (a/up dropped beyond the bound), flushed in order
	assert.deepEqual(JSON.parse(published[0].msg), { camera: "a", state: "down", reason: "r1", at: 2 });
	assert.deepEqual(JSON.parse(published[1].msg), { camera: "b", state: "up", reason: null, at: 3 });
	assert.deepEqual(JSON.parse(published[2].msg), { camera: "c", state: "up", reason: null, at: 4 });
	assert.equal(bus.buffer.length, 0);
});

test("null bus (green-field default): records and drops, nothing is assumed pre-deployed", async () => {
	const bus = new NullStreamHealthBus();
	await bus.publish(streamHealthTopic("drive", "up"), { camera: "drive", state: "up", reason: null, at: 7 });
	await bus.publish(streamHealthTopic("drive", "down"), { camera: "drive", state: "down", reason: "why", at: 8 });
	assert.equal(bus.published.length, 2);
	assert.deepEqual(bus.published[0], { topic: "porchlight/engine/streams/drive/up", payload: { camera: "drive", state: "up", reason: null, at: 7 } });
	assert.deepEqual(bus.status(), { transport: "null", published: 2 });
	await bus.close();
});
