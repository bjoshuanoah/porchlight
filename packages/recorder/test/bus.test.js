// bus.test.js — the recorder's event-bus seam (PORCH-136, ac-4 + ac-3 bus
// wiring). Storage state publishes on the engine's event bus and detection
// events drive event-mode recording. Embedded aedes broker — the broker is
// provisioned by the product's own setup, never assumed pre-deployed.

import { test } from "node:test";
import assert from "node:assert/strict";
import fsDefault from "node:fs";
import mqtt from "mqtt";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import { once } from "node:events";

import { startBroker } from "../../detection/test/helpers/broker.js";
import { createMqttBus, STORAGE_STATE_TOPIC, STORAGE_EVENTS_TOPIC } from "../src/bus.mqtt.js";
import { RecorderSupervisor } from "../src/supervisor.js";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test("storage state and events publish on the bus; detections drive triggers", async () => {
	const broker = await startBroker();
	const dir = fsDefault.mkdtempSync(path.join(os.tmpdir(), "porch-bus-"));

	// An independent subscriber reads what the supervisor publishes.
	const sub = mqtt.connect(broker.url, { clientId: "bus-test-sub" });
	await once(sub, "connect");
	/** @type {{topic: string, payload: any}[]} */
	const seen = [];
	/** @type {() => void} */
	let stateDoneResolve = () => {};
	const stateDone = new Promise((resolve) => {
		stateDoneResolve = resolve;
	});
	sub.on("message", (topic, buf) => {
		try {
			const payload = JSON.parse(buf.toString("utf8"));
			seen.push({ topic, payload });
			if (payload.storage?.state === "degraded-write") stateDoneResolve();
		} catch { /* non-JSON */ }
	});
	sub.subscribe(STORAGE_STATE_TOPIC);
	sub.subscribe(STORAGE_EVENTS_TOPIC);

	try {
		const bus = createMqttBus({ url: broker.url, log: () => {} });
		/** @type {EventEmitter[]} */
		const procs = [];
		const spawn = () => {
			const p = new EventEmitter();
			p.pid = 5;
			p.stderr = null;
			p.kill = () => {
				p.emit("close", null, "SIGTERM");
				return true;
			};
			procs.push(p);
			return p;
		};
		const supervisor = new RecorderSupervisor({
			config: /** @type {any} */ ({
				storageRoot: path.join(dir, "primary"),
				failoverRoot: path.join(dir, "failover"),
				port: 18991,
				segmentSeconds: 10,
				cameras: [{ name: "camN", source: { url: "rtsp://x" }, recordingMode: "event" }],
				busUrl: broker.url,
			}),
			spawn,
			pollMs: 1e9,
			log: () => {},
			bus, // the supervisor adopts this exact connection (createMqttBus above)
		});
		supervisor.start();
		await sleep(200); // spawn + first retained state publication

		// Fault → failover: the event AND the new retained state hit the bus.
		const fault = Object.assign(new Error("EIO"), { code: "EIO" });
		supervisor.injectFs(
			/** @type {any} */ (fsProxyFaulting(path.join(dir, "primary"))),
		);
		supervisor.daemons[0].reportWriteError({ where: "injected fault", err: fault });
		await Promise.race([stateDone, sleep(1500)]);
		assert.ok(
			seen.some((s) => s.topic === STORAGE_EVENTS_TOPIC && s.payload.type === "storage.failover"),
			"failover alert publishes on the bus",
		);
		const lastState = [...seen].reverse().find((s) => s.topic === STORAGE_STATE_TOPIC);
		assert.equal(lastState.payload.storage.state, "degraded-write");
		assert.equal(lastState.payload.storage.failover, path.join(dir, "failover"));

		// ac-3 bus wiring: detections on the bus open the event-mode window.
		assert.equal(supervisor.daemons[0].mode, "event");
		bus.client.publish("porchlight/engine/detections/camN/person", JSON.stringify({ camera: "camN" }));
		await sleep(150);
		assert.ok(supervisor.daemons[0].eventWindow, "detection event opened the recording window");

		await supervisor.stop();
		await bus.close();
	} finally {
		sub.end(true);
		await broker.close();
		fsDefault.rmSync(dir, { recursive: true, force: true });
	}
});

/** fs proxy failing all ops under prefixes (same shape as supervisor tests). */
function fsProxyFaulting(...prefixes) {
	const boom = () => Object.assign(new Error("EIO: input/output error"), { code: "EIO" });
	const f = /** @type {typeof fsDefault} */ ({ ...fsDefault });
	for (const name of ["mkdirSync", "writeFileSync", "readFileSync", "unlinkSync", "readdirSync", "statSync", "renameSync", "existsSync"]) {
		const real = /** @type {any} */ (fsDefault[name]);
		/** @type {any} */ (f)[name] = (p, ...args) => {
			if (prefixes.some((pre) => String(p).startsWith(pre))) throw boom();
			return real(p, ...args);
		};
	}
	return f;
}
