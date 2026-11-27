// broker.test.js — the event bus of record (PORCH-129 ac-1 lifecycle).
//
// Proves the green-field lifecycle end to end over the real wire protocol:
// a fresh broker provisions, engine-service-shaped mqtt.js clients connect,
// a restarted client reconnects without manual intervention, and a broker
// restarted on the same port is found again by an auto-reconnecting client.

import test from "node:test";
import assert from "node:assert/strict";
import mqtt from "mqtt";

import { EventBusBroker } from "../src/broker.js";

const DETECTIONS_TOPIC = "porchlight/engine/detections/front-door/person";

/** @param {any} client */
function connect(client, what) {
	return new Promise((resolve, reject) => {
		client.once("connect", resolve);
		client.once("error", (/** @type {Error} */ err) => reject(new Error(`${what}: ${err.message}`)));
	});
}

test("a fresh deployment provisions its bus and engine clients connect and exchange the DetectedObject family", async () => {
	const broker = await new EventBusBroker().start();
	try {
		assert.match(broker.url, /^mqtt:\/\/127\.0\.0\.1:\d+$/);
		const sub = mqtt.connect(broker.url, { clientId: "engine-sub", clean: true, reconnectPeriod: 50 });
		const pub = mqtt.connect(broker.url, { clientId: "engine-pub", clean: true, reconnectPeriod: 50 });
		try {
			await connect(sub, "subscriber connect");
			await connect(pub, "publisher connect");
			assert.equal(broker.clientCount, 2);

			const received = /** @type {{ topic: string, payload: string }[]} */ ([]);
			// The ack resolves before any later publish can race the subscription.
			await new Promise((r) => sub.subscribe("porchlight/engine/detections/+/+", () => r()));
			sub.on("message", (topic, payload) => received.push({ topic, payload: payload.toString() }));

			const object = { camera: "front-door", trackId: "t1", cls: "person", conf: 0.92, bbox: [0.1, 0.2, 0.3, 0.4], t: 1764268800 };
			await new Promise((r) => pub.publish(DETECTIONS_TOPIC, JSON.stringify(object), { qos: 0 }, () => r()));

			// Deterministic: await the received fact, never a fixed sleep.
			await new Promise((resolve, reject) => {
				const on = () => received.length > 0 && (clearInterval(timer), resolve(true));
				const timer = setInterval(() => on(), 10);
				setTimeout(() => reject(new Error("no publish arrived on the bus")), 2000);
			});
			assert.equal(received[0].topic, DETECTIONS_TOPIC);
			assert.deepEqual(JSON.parse(received[0].payload), object);
			assert.equal(broker.status().state, "running");
			assert.equal(broker.status().transport, "mqtt");
		} finally {
			sub.end(true); pub.end(true);
		}
	} finally {
		await broker.stop();
	}
});

test("a service restart reconnects to the same bus without manual intervention (client restart)", async () => {
	const broker = await new EventBusBroker().start();
	try {
		const received = /** @type {string} */ ([]);
		// The long-lived consumer: the home hub / recorder shape — survives
		// the producer service's restart on its own connection.
		const sub = mqtt.connect(broker.url, { clientId: "hub-consumer", clean: true });
		await new Promise((r) => sub.subscribe("porchlight/engine/detections/+/+", () => r()));
		sub.on("message", (_t, p) => received.push(p.toString()));

		// A producer service restarts: the old client dies, a new one boots —
		// same url, no manual config, no broker touch. (PORCH-129 ac-1.)
		const first = mqtt.connect(broker.url, { clientId: "detection-service", clean: true });
		await connect(first, "first producer");
		await new Promise((r) => first.end(true, {}, r));
		const restarted = mqtt.connect(broker.url, { clientId: "detection-service", clean: true });
		await connect(restarted, "restarted producer");
		await new Promise((r) => restarted.publish(DETECTIONS_TOPIC, JSON.stringify({ camera: "front-door", trackId: "t2", cls: "person", conf: 0.8, bbox: [0, 0, 1, 1], t: 1 }), { qos: 0 }, () => r()));
		await new Promise((resolve) => {
			const check = setInterval(() => received.length > 0 && (clearInterval(check), resolve(true)), 10);
			setTimeout(() => { clearInterval(check); resolve(false); }, 2000);
		});
		if (received.length !== 1) throw new Error(`expected exactly one post-restart fact, got ${received.length}`);
		assert.deepEqual(JSON.parse(received[0]), { camera: "front-door", trackId: "t2", cls: "person", conf: 0.8, bbox: [0, 0, 1, 1], t: 1 });
		await restarted.end(true); await sub.end(true);
	} finally {
		await broker.stop();
	}
});

test("a broker restart on the same port is re-found by a live client (auto-reconnect, no manual step)", async () => {
	// Fixed port so the restarted broker occupies the same endpoint.
	const broker = await new EventBusBroker({ port: 0 }).start();
	const port = Number(new URL(broker.url).port);
	try {
		const client = mqtt.connect(broker.url, { clientId: "auto-reconnector", clean: true, reconnectPeriod: 100, connectTimeout: 1000 });
		try {
			await connect(client, "initial connect");
			await broker.stop();
			// mqtt.js retries with jittered delays during the outage window —
			// reconnect errors are the client's own noise, counted not fatal.
			const errors = /** @type {Error[]} */ ([]);
			client.on("error", (/** @type {Error} */ e) => errors.push(e));
			const revived = await new EventBusBroker({ port }).start();
			try {
				// The automatic reconnect: watch the client's connect state and
				// the revived broker's own client count — no manual step, no
				// new client, just mqtt.js finding the broker back on the same
				// port. Deterministic by polling, bounded by a hard timeout.
				await new Promise((resolve, reject) => {
					const deadline = Date.now() + 10_000;
					const check = setInterval(() => {
						if (client.connected && revived.clientCount > 0) {
							clearInterval(check);
							resolve(true);
						} else if (Date.now() > deadline) {
							clearInterval(check);
							reject(new Error(`client never reconnected (${errors.length} retry error(s): ${errors[0]?.message ?? "none"})`));
						}
					}, 50);
				});
				// After the automatic reconnect the wire works again end to end,
				// on the SAME client object that survived the broker restart.
				// The subscription re-arms exactly as a restarting engine
				// service re-arms: subscribe once connected (mqtt.js ack first).
				const got = new Promise((resolve, reject) => {
					client.subscribe(DETECTIONS_TOPIC, () => resolve(true));
					setTimeout(() => reject(new Error("resubscribe after reconnect did not complete in 3s")), 3000);
				});
				const publisher = mqtt.connect(revived.url, { clientId: "after-restart-pub", clean: true });
				await connect(publisher, "second publisher");
				const object = { camera: "front-door", trackId: "t3", cls: "person", conf: 0.7, bbox: [0, 0, 1, 1], t: 2 };
				await new Promise((r) => publisher.publish(DETECTIONS_TOPIC, JSON.stringify(object), { qos: 0 }, () => r()));
				assert.equal(await got, true);
				const received = /** @type {Record<string, unknown>[]} */ ([]);
				client.on("message", (_t, p) => received.push(JSON.parse(p.toString())));
				// QoS-0 delivery: arrive-or-timeout, never a fixed sleep.
				await new Promise((resolve, reject) => {
					const check = setInterval(() => received.length > 0 && (clearInterval(check), resolve(true)), 10);
					setTimeout(() => { clearInterval(check); reject(new Error("no fact delivered after the reconnect")); }, 3000);
				});
				assert.deepEqual(received[0], object);
				await new Promise((r) => publisher.end(true, {}, r));
			} finally {
				await revived.stop();
			}
		} finally {
			client.end(true);
		}
	} finally {
		await broker.stop().catch(() => {});
	}
});

test("status states itself before start, url refuses pre-start, start is idempotent, stop is idempotent", async () => {
	const broker = new EventBusBroker();
	assert.deepEqual(broker.status(), { transport: "mqtt", mode: "embedded", state: "stopped", url: null, clients: 0 });
	assert.throws(() => broker.url, /start\(\) must run before url/);
	const first = await broker.start();
	const second = await broker.start();
	assert.equal(first, broker);
	assert.equal(second, broker); // same instance, one bind
	await broker.stop();
	await broker.stop(); // idempotent
	assert.equal(broker.server, null);
	// Restart after stop works (another lifecycle pass).
	const again = await new EventBusBroker().start();
	await again.stop();
});
