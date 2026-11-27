// seam-porch.test.js — the bus + webhook wire contract together (PORCH-129
// ac-3 / ac-4). One DetectionService publish fans to BOTH output families
// and every consumer of the contract receives the SAME normalized
// DetectedObject JSON: a bus subscriber (the Porchlight Home consumer shape —
// subscribe-only, event-driven) and an HTTP webhook target.

import test from "node:test";
import assert from "node:assert/strict";
import mqtt from "mqtt";

import { startBroker } from "./helpers/broker.js";
import { DetectionService, MqttDetectionSink, WebhookDetectionSink, fanoutDetectionSink } from "../src/index.js";
import { DetectionTracker } from "../src/tracker.js";

/** A fake provider whose every frame yields one detection. */
function scriptedProvider() {
	return {
		name: "fake",
		/** @param {any} frame */
		async detect(frame) {
			return [{ cls: "person", conf: 0.9, bbox: [0.25, 0.25, 0.5, 0.5], t: frame.t }];
		},
	};
}

test("one publish fans to bus and webhook — every consumer receives the same normalized contract, event-driven", async () => {
	const broker = await startBroker();
	// The Porchlight Home consumer shape (PORCH-I-008 TS 1 / PORCH-139): it
	// SUBSCRIBES on connect. No polling loop exists anywhere under test —
	// its only knowledge of detections is the bus message event.
	const hubConsumer = mqtt.connect(broker.url, { clientId: "porchlight-home-consumer", clean: true });
	/** @type {{ topic: string, payload: Record<string, unknown> }[]} */
	const onBus = [];
	/** @type {Record<string, unknown>[]} */
	const onWebhook = [];
	/** @type {{ url: string, body: unknown }[]} */
	const webhookPosts = [];
	try {
		await new Promise((r) => hubConsumer.once("connect", r));
		await new Promise((r) => hubConsumer.subscribe("porchlight/engine/detections/+/+", () => r()));
		hubConsumer.on("message", (topic, payload) => onBus.push({ topic, payload: JSON.parse(payload.toString()) }));

		const webhook = new WebhookDetectionSink({
			urls: ["http://porchlight-home.example/engine-events"],
			fetchImpl: (async (_url, init) => {
				webhookPosts.push({ url: String(_url), body: JSON.parse(/** @type {string} */ (init?.body)) });
				onWebhook.push(/** @type {Record<string, unknown>} */ (JSON.parse(/** @type {string} */ (init?.body))));
				return { ok: true, status: 200 };
			}),
		});
		const bus = await new MqttDetectionSink({ url: broker.url }).start();
		const service = new DetectionService({
			provider: scriptedProvider(),
			sink: fanoutDetectionSink([{ name: "bus", sink: bus }, { name: "webhook", sink: webhook }]),
			trackerFactory: () => new DetectionTracker({ minHits: 1 }),
		});
		try {
			const started = performance.now();
			await service.submit({ camera: "front-door", w: 640, h: 480, t: 1764268800, format: "rgb", data: new Uint8Array(640 * 480 * 3) });
			assert.equal(service.published, 1);
			// The bus fact lands inside the 1-second event budget by awaiting
			// the contract instead of sleeping.
			const budgetMs = 1000;
			await new Promise((resolve, reject) => {
				const timer = setTimeout(() => reject(new Error(`no bus fact within ${budgetMs}ms of the publish`)), budgetMs);
				const check = setInterval(() => {
					if (onBus.length > 0 && performance.now() - started < budgetMs) {
						clearTimeout(timer);
						clearInterval(check);
						resolve(true);
					}
				}, 5);
			});
			// The webhook family carried the contract too, in the same pass.
			await new Promise((r) => setTimeout(r, 50));
			assert.equal(onWebhook.length, 1);
			// Contract: every consumer received the SAME normalized fields.
			assert.deepEqual(onBus[0].payload, onWebhook[0]);
			assert.equal(onBus[0].topic, "porchlight/engine/detections/front-door/person");
			// Contract fields of record: label, bbox, confidence, track id,
			// timestamp, camera (PORCH-I-009 TS 3).
			const fact = /** @type {Record<string, unknown>} */ (onBus[0].payload);
			assert.equal(fact.cls, "person");
			assert.equal(fact.camera, "front-door");
			assert.deepEqual(fact.bbox, [0.25, 0.25, 0.5, 0.5]);
			assert.equal(fact.t, 1764268800);
			assert.ok(typeof fact.trackId === "string" && fact.trackId.length > 0, `carries the per-camera track id (${String(fact.trackId)})`);
			assert.ok(typeof fact.conf === "number" && fact.conf > 0 && fact.conf <= 1);
		} finally {
			await service.close();
			await bus.close();
		}
	} finally {
		await new Promise((r) => hubConsumer.end(true, {}, r));
		await broker.close();
	}
});
