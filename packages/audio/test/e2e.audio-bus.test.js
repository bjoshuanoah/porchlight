// e2e.audio-bus.test.js — the audio event plane end to end through the real
// embedded bus (PORCH-153 ac-1): a synthetic sample clip containing a target
// class feeds the service (enabled), the AudioEvent publishes onto the
// detections family of record, and a consumer keyed on the engine's topic
// pattern receives exactly the contract — within the measured latency guard.

import { test } from "node:test";
import assert from "node:assert/strict";
import mqtt from "mqtt";

import { AudioAnalysisService } from "../src/service.js";
import { MqttAudioSink } from "../src/sink.mqtt.js";
import { startBroker } from "./helpers/broker.js";

/** One second of "clip" audio for the target class, pushed as live chunks. */
/** @param {string} camera @param {number} t @param {number} seconds @param {number} rate */
function clipChunk(camera, t, seconds, rate = 16000) {
	const n = Math.round(seconds * rate);
	return { camera, t, sampleRate: rate, data: new Float32Array(n).fill(0.5) };
}

/** Bounded condition wait — the bus fanout decides when, never a fixed sleep. */
/** @param {() => boolean} condition @param {number} [deadlineMs] */
async function waitFor(condition, deadlineMs = 5000) {
	const deadline = Date.now() + deadlineMs;
	while (!condition()) {
		if (Date.now() > deadline) return false;
		await new Promise((r) => setTimeout(r, 20));
	}
	return true;
}

test("ac-1 e2e: sample clip with the target class → AudioEvent on the bus within the latency guard", async () => {
	const broker = await startBroker();
	try {
		// The bus consumer side — the family of record the hub, recorder, and
		// recognition consumers key on.
		const consumer = mqtt.connect(broker.url);
		await new Promise((r) => consumer.once("connect", r));
		const received = /** @type {{ topic: string, event: Record<string, unknown>, atMs: number }[]} */ ([]);
		consumer.on("message", (topic, payload) => received.push({ topic, event: JSON.parse(payload.toString()), atMs: Date.now() }));
		// The subscription is acknowledged before anything publishes — no
		// fixed sleep, no lost first message (mqtt.js acks via the callback).
		await new Promise((r) => consumer.subscribe("porchlight/engine/detections/+/+", () => r()));

		const sink = await new MqttAudioSink({ url: broker.url }).start();
		const svc = new AudioAnalysisService({
			// The local classifier of record: the target class fires on every
			// window of this clip (the model's own job against real audio).
			provider: {
				name: "audio-classifier-e2e",
				classify: async () => [{ cls: "dog-bark", conf: 0.91 }],
				status: () => ({ engine: "onnxruntime-coreml", providerClass: "native-mlx", model: null, executionTarget: "gpu/ane", state: "native", reason: null }),
			},
			sink,
			enabledFor: (camera) => ({ value: camera === "cam-front", source: "base" }),
			windowMs: 1000,
			now: () => Date.now() / 1000,
			log: () => {},
		});

		const startedAt = Date.now();
		// The sample clip arrives as the stream-serving path delivers the
		// decoded track: 2 seconds of chunks.
		await svc.submit(clipChunk("cam-front", 1000, 0.6));
		await svc.submit(clipChunk("cam-front", 1000.6, 0.6));
		const result = await svc.submit(clipChunk("cam-front", 1001.2, 1));
		assert.equal(result.refused, null);
		// Broker fanout: wait until an event actually arrives (bounded), then
		// inspect what the consumer saw — never a fixed sleep racing the bus.
		await waitFor(() => received.length >= 1);
		assert.ok(received.length >= 1, "the AudioEvent reached a consumer on the detections family");

		const event = received[0].event;
		assert.equal(received[0].topic, "porchlight/engine/detections/cam-front/dog-bark");
		assert.equal(event.camera, "cam-front");
		assert.equal(event.class, "dog-bark");
		assert.equal(event.confidence, 0.91);
		assert.equal(event.clipStart, 1000);
		assert.ok(Math.abs((/** @type {number} */ (event.clipEnd)) - 1001) < 0.001);
		// Latency guard, measured call→publish→fanout: a CI regression bound,
		// NOT the benchmark latency number of record (benchmark-gated).
		const wall = received[0].atMs - startedAt;
		assert.ok(wall < 5000, `end-to-end publish took ${wall}ms`);
		// The reported per-pass measurement is the observable the benchmark reads.
		assert.ok(result.latencyMs < 5000, `classify→publish took ${result.latencyMs}ms`);

		// A DISABLED camera in the same fleet publishes nothing at all
		// (cross-checked e2e; the zero-execution proof lives in service.test.js).
		await svc.submit(clipChunk("cam-side", 1000, 1));
		assert.ok(received.every((r) => r.event.camera === "cam-front"), "no audio events from the disabled camera");
		assert.equal(svc.status().refused, 1);

		await svc.close();
		await new Promise((r) => consumer.end(true, {}, r));
	} finally {
		await broker.close();
	}
});
