// sink.webhook.test.js — the HTTP webhook output contract (PORCH-129 ac-3).
//
// Contract under test: the webhook emits the SAME normalized DetectedObject
// JSON the bus carries — field-for-field, no reshaping, no enrichment — and
// delivery failure never breaks the detection loop (best-effort output).

import test from "node:test";
import assert from "node:assert/strict";

import { WebhookDetectionSink, fanoutDetectionSink } from "../src/sink.webhook.js";
import { assertDetectedObject } from "../src/types.js";

const OBJECT = { camera: "front-door", trackId: "t9", cls: "person", conf: 0.93, bbox: [0.11, 0.22, 0.33, 0.44], t: 1764268800, provider: "vision", reid: [1, 2, 3] };

test("the webhook POSTs the exact DetectedObject JSON the bus carries", async () => {
	/** @type {{ url: string, body: unknown, headers: Record<string, string> }[]} */
	const seen = [];
	const sink = new WebhookDetectionSink({
		urls: ["http://porchlight-home.example/events"],
		fetchImpl: (async (url, init) => {
			seen.push({ url: String(url), body: JSON.parse(/** @type {string} */ (init?.body)), headers: /** @type {Record<string, string>} */ (init?.headers) });
			return { ok: true, status: 200 };
		}),
	});
	assertDetectedObject(OBJECT); // the contract of record is the shape that rides
	await sink.publish(OBJECT);
	assert.equal(seen.length, 1);
	assert.equal(seen[0].headers["content-type"], "application/json");
	assert.deepEqual(seen[0].body, OBJECT); // field-for-field: no reshaping
	assert.equal(sink.delivered, 1);
	assert.equal(sink.status().transport, "webhook");
});

test("a failing webhook is counted and never fatal to the detection loop", async () => {
	const sink = new WebhookDetectionSink({
		urls: ["http://porchlight-home.example/events"],
		fetchImpl: (async () => { throw new Error("refused"); }),
		log: () => {},
	});
	await sink.publish(OBJECT); // resolves, never throws
	await sink.publish(OBJECT);
	const status = sink.status();
	assert.equal(status.failed, 2);
	assert.equal(status.delivered, 0);
	assert.equal(status.state, "degraded");
	assert.match(/** @type {string} */ (status.reason), /2 delivery failure/);
});

test("a non-2xx response counts as a delivery failure", async () => {
	const sink = new WebhookDetectionSink({ urls: ["http://x.test/e"], fetchImpl: (async () => ({ ok: false, status: 503 })) });
	await sink.publish(OBJECT);
	assert.equal(sink.status().failed, 1);
});

test("multiple targets receive the same payload in parallel", async () => {
	/** @type {string[]} */
	const hits = [];
	const sink = new WebhookDetectionSink({
		urls: ["http://a.test/e", "http://b.test/e"],
		fetchImpl: (async (url) => { hits.push(String(url)); return { ok: true, status: 200 }; }),
	});
	await sink.publish(OBJECT);
	assert.deepEqual(hits.sort(), ["http://a.test/e", "http://b.test/e"]);
	assert.equal(sink.delivered, 2);
});

test("construction validates the target list loudly (no silent half-configured sink)", async () => {
	assert.throws(() => new WebhookDetectionSink({ urls: [] }), /non-empty list/);
	assert.throws(() => new WebhookDetectionSink({ urls: ["not-a-url"] }), /http\(s\)/);
});

test("fanoutDetectionSink fans to every selected output and isolates sink failures", async () => {
	const busSink = { published: /** @type {unknown[]} */ ([]), async publish(o) { this.published.push(JSON.parse(JSON.stringify(o))); }, status() { return { transport: "mqtt" }; }, async close() { this.closed = true; }, closed: false };
	const webhookSink = { async publish(_o) { throw new Error("down"); }, status() { return { transport: "webhook" }; } };
	const out = fanoutDetectionSink([{ name: "bus", sink: busSink }, { name: "webhook", sink: webhookSink }]);
	await out.publish(OBJECT); // fanout resolves; the webhook failure never reaches publish()
	assert.deepEqual(JSON.parse(JSON.stringify(busSink.published[0])), OBJECT); // the bus family got the SAME object
	const status = out.status?.();
	assert.deepEqual(status?.sinks.map((/** @type {any} */ s) => s.name), ["bus", "webhook"]);
	await out.close();
	assert.equal(busSink.closed, true);
});
