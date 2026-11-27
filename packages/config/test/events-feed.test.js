// events-feed.test.js — the entity event feed of record (PORCH-130).
//
// Covers the bus seam over an injected client (subscribe pattern of record,
// DetectedObject + AudioEvent payload normalization to epoch seconds, camera
// fallback from the topic, malformed payloads logged-and-skipped), the
// append-only JSONL persistence of record, the 30-day retention sweep,
// listEvents window/camera/limit semantics, the disabled-feed plain-language
// status, the busUrl resolution from the platform config of record, and the
// REST surface (/api/events incl. the bus status object and 422 paths).

import { describe, test, before, after } from "node:test";
import assert from "node:assert/strict";
import fsDefault from "node:fs";
import osDefault from "node:os";
import pathDefault from "node:path";

import { createConfigService, createEventsFeed } from "../src/index.js";
import { DETECTIONS_PATTERN } from "@porchlight/recorder";

const NOW = new Date("2026-11-27T12:00:00Z");
const T = (h, m, s) => Date.UTC(2026, 10, 27, h, m, s) / 1000;

function tmpRoot(prefix) {
	return fsDefault.mkdtempSync(pathDefault.join(osDefault.tmpdir(), prefix));
}

/** Bus seam injection mirroring createMqttBus's subscribe/status surface. */
function fakeClient() {
	const harness = {
		subscribed: null,
		handlers: [],
		log: [],
		subscribe(pattern, handler) {
			harness.subscribed = pattern;
			harness.handlers.push(handler);
		},
		status() {
			return { connected: true, url: "mqtt://fake-bus" };
		},
		emit(topic, payload) {
			for (const handler of harness.handlers) {
				handler(topic, typeof payload === "string" ? payload : JSON.stringify(payload));
			}
		},
	};
	return harness;
}

function eventsFile(root, date) {
	return pathDefault.join(root, "config", "console", "events", `${date}.jsonl`);
}

function readRows(file) {
	return fsDefault.readFileSync(file, "utf8").split("\n").filter((l) => l.trim() !== "").map((l) => JSON.parse(l));
}

describe("events feed seam (injected client)", () => {
	test("subscribes the detections family of record and stores normalized rows", (t) => {
		const root = tmpRoot("porch-events-");
		t.after(() => fsDefault.rmSync(root, { recursive: true, force: true }));
		const client = fakeClient();
		createEventsFeed({ root, busUrl: "mqtt://fake-bus", now: () => NOW, client });
		assert.equal(client.subscribed, DETECTIONS_PATTERN);

		client.emit("porchlight/engine/detections/front_left/person", {
			camera: "front_left", trackId: "T7", cls: "person", conf: 0.87, t: T(12, 0, 5), bbox: [0.1, 0.2, 0.3, 0.4],
		});
		client.emit("porchlight/engine/detections/front_left/glass_break", {
			camera: "front_left", timestamp: T(12, 1, 0), class: "glass_break", confidence: 0.91,
			clipStart: T(12, 0, 55), clipEnd: T(12, 1, 2),
		});

		const rows = readRows(eventsFile(root, "2026-11-27"));
		assert.equal(rows.length, 2);
		assert.deepEqual(rows[0], { t: T(12, 0, 5), camera: "front_left", cls: "person", conf: 0.87, trackId: "T7", source: "detection" });
		// The audio family is recognized by its clip bounds; every row is
		// normalized (timestamp→t, class→cls, confidence→conf) and carries no
		// trackId.
		assert.deepEqual(rows[1], {
			t: T(12, 1, 0), camera: "front_left", cls: "glass_break", conf: 0.91, trackId: null, source: "audio",
			clipStart: T(12, 0, 55), clipEnd: T(12, 1, 2),
		});
	});

	test("camera falls back to the topic segment; millis t normalizes to seconds", (t) => {
		const root = tmpRoot("porch-events-");
		t.after(() => fsDefault.rmSync(root, { recursive: true, force: true }));
		const client = fakeClient();
		createEventsFeed({ root, busUrl: "mqtt://fake-bus", now: () => NOW, client });

		client.emit("porchlight/engine/detections/back_door/animal", {
			trackId: "T2", cls: "animal", conf: 0.5, t: T(12, 5, 0) * 1000,
		});
		const rows = readRows(eventsFile(root, "2026-11-27"));
		assert.deepEqual(rows[0], { t: T(12, 5, 0), camera: "back_door", cls: "animal", conf: 0.5, trackId: "T2", source: "detection" });
	});

	test("malformed payloads are logged and skipped, never crash the feed", (t) => {
		const root = tmpRoot("porch-events-");
		t.after(() => fsDefault.rmSync(root, { recursive: true, force: true }));
		const lines = [];
		const client = fakeClient();
		const feed = createEventsFeed({ root, busUrl: "mqtt://fake-bus", now: () => NOW, client, log: (line) => lines.push(line) });

		client.emit("porchlight/engine/detections/front_left/person", "{not json");
		client.emit("porchlight/engine/detections/front_left/person", { camera: "front_left", cls: "person", conf: 0.5 }); // no t
		client.emit("porchlight/engine/detections/front_left/person", { t: "noon", camera: "front_left", cls: "person", conf: 0.5 });
		// No camera in the payload NOR in the topic: unlandable.
		client.emit("porchlight/engine/detections", { t: T(12, 6, 0), cls: "person", conf: 0.5 });
		assert.equal(lines.length, 4);

		// The feed keeps working after the skips; a fresh good event lands.
		client.emit("porchlight/engine/detections/front_left/person", { camera: "front_left", trackId: "T9", cls: "person", conf: 0.7, t: T(12, 6, 30) });
		const rows = readRows(eventsFile(root, "2026-11-27"));
		assert.equal(rows.length, 1);
		feed.close();
	});

	test("append-only JSONL across a midnight boundary; retention prunes by UTC date name", (t) => {
		const root = tmpRoot("porch-events-");
		t.after(() => fsDefault.rmSync(root, { recursive: true, force: true }));
		fsDefault.mkdirSync(pathDefault.join(root, "config", "console", "events"), { recursive: true });
		fsDefault.writeFileSync(eventsFile(root, "2026-10-01"), "{}\n", "utf8"); // 43+ days stale vs NOW
		fsDefault.writeFileSync(eventsFile(root, "2026-11-01"), `${JSON.stringify({ t: T(1, 0, 0), camera: "front_left", cls: "person", conf: 0.5, trackId: null, source: "detection" })}\n`, "utf8"); // 26 days — kept
		fsDefault.writeFileSync(pathDefault.join(root, "config", "console", "events", "not-an-event-file.txt"), "junk", "utf8");

		const client = fakeClient();
		createEventsFeed({ root, busUrl: "mqtt://fake-bus", now: () => NOW, client });
		client.emit("porchlight/engine/detections/front_left/person", { camera: "front_left", cls: "person", conf: 0.9, t: T(23, 59, 59) + 1 });

		assert.equal(fsDefault.existsSync(eventsFile(root, "2026-10-01")), false);
		assert.equal(fsDefault.existsSync(eventsFile(root, "2026-11-01")), true);
		assert.equal(fsDefault.existsSync(eventsFile(root, "2026-11-28")), true);
	});
});

describe("listEvents window/camera/limit over the persisted rows", () => {
	const ctx = {};
	before(() => {
		ctx.root = tmpRoot("porch-events-list-");
		const client = fakeClient();
		ctx.feed = createEventsFeed({ root: ctx.root, busUrl: "mqtt://fake-bus", now: () => NOW, client });
		const emit = (t_, camera, cls, conf) => client.emit(
			`porchlight/engine/detections/${camera}/${cls}`,
			{ camera, cls, conf, t: t_, trackId: null },
		);
		emit(T(9, 0, 0), "front_left", "person", 0.6);
		emit(T(10, 0, 0), "front_left", "animal", 0.7);
		emit(T(10, 0, 5), "back_door", "person", 0.8);
		emit(T(11, 0, 0), "front_left", "person", 0.9);
	});
	after(() => fsDefault.rmSync(ctx.root, { recursive: true, force: true }));

	test("window filter is inclusive of both bounds and reads only intersecting dates", () => {
		const answer = ctx.feed.listEvents({ from: T(9, 0, 0), to: T(10, 0, 10) });
		assert.deepEqual(answer.events.map((e) => e.t), [T(9, 0, 0), T(10, 0, 0), T(10, 0, 5)]);
	});

	test("camera filter narrows to one feed; t sorts ascending across files", () => {
		const answer = ctx.feed.listEvents({ cameraId: "front_left", from: T(0, 0, 0), to: T(23, 59, 59) });
		assert.deepEqual(answer.events.map((e) => e.conf), [0.6, 0.7, 0.9]);
	});

	test("limit caps the listing; from/to are required epoch seconds", () => {
		assert.deepEqual(ctx.feed.listEvents({ from: T(0, 0, 0), to: T(23, 59, 59), limit: 2 }).events.length, 2);
		assert.throws(() => ctx.feed.listEvents({ to: T(23, 59, 59) }), /events: from must be an epoch-seconds timestamp/);
		assert.throws(() => ctx.feed.listEvents({ from: T(0, 0, 0) }), /events: to must be an epoch-seconds timestamp/);
		assert.throws(() => ctx.feed.listEvents({ from: "noon", to: T(23, 59, 59) }), /events: from must be an epoch-seconds timestamp/);
		assert.throws(() => ctx.feed.listEvents({ from: T(0, 0, 0), to: T(23, 59, 59), limit: 0 }), /events: limit must be a positive integer/);
	});
});

describe("REST /api/events + the disabled feed + the config of record", () => {
	test("feed without a bus answers a stated disabled status; /api/events still answers", async (t) => {
		const root = tmpRoot("porch-events-rest-");
		t.after(() => fsDefault.rmSync(root, { recursive: true, force: true }));
		const service = createConfigService({ root, consoleDist: null });
		const handle = await service.start(0);
		t.after(() => handle.close());

		const res = await fetch(`http://127.0.0.1:${handle.port}/api/events?from=1&to=2`);
		assert.equal(res.status, 200);
		assert.deepEqual(await res.json(), {
			events: [],
			bus: { connected: false, url: null, detail: "the event bus isn't configured — the config of record needs a busUrl before detections and audio events land here" },
		});
		assert.deepEqual(service.events.status(), { connected: false, url: null, detail: "the event bus isn't configured — the config of record needs a busUrl before detections and audio events land here" });
	});

	test("busUrl of record wires the feed without a broker present; REST carries its status", async (t) => {
		const root = tmpRoot("porch-events-bus-");
		t.after(() => fsDefault.rmSync(root, { recursive: true, force: true }));
		fsDefault.mkdirSync(pathDefault.join(root, "config"), { recursive: true });
		fsDefault.writeFileSync(
			pathDefault.join(root, "config", "config.yaml"),
			JSON.stringify({ version: 1, storageRoot: `${root}/recordings`, cameras: [], busUrl: "mqtt://nowhere.invalid" }, null, "\t") + "\n",
			"utf8",
		);
		const service = createConfigService({ root, consoleDist: null });
		const handle = await service.start(0);
		t.after(async () => {
			await service.events.close();
			await handle.close();
		});

		// The feed is wired from the config of record — no override passed —
		// and a missing broker is a stated degradation, never a crash.
		assert.equal(service.events.status().url, "mqtt://nowhere.invalid");
		assert.equal(service.events.status().connected, false);

		const res = await fetch(`http://127.0.0.1:${handle.port}/api/events?from=1&to=2`);
		const body = await res.json();
		assert.equal(res.status, 200);
		assert.deepEqual(body.events, []);
		assert.equal(body.bus.url, "mqtt://nowhere.invalid");
		assert.equal(typeof body.bus.connected, "boolean");
	});

	test("/api/events carries the bus status; 422s are verbatim", async (t) => {
		const root = tmpRoot("porch-events-rest2-");
		t.after(() => fsDefault.rmSync(root, { recursive: true, force: true }));
		const client = fakeClient();
		const service = createConfigService({ root, consoleDist: null, busUrl: "mqtt://fake-bus", eventsClient: client });
		const serviceHandle = await service.start(0);
		const { port } = serviceHandle;
		t.after(async () => {
			await service.events.close();
			await serviceHandle.close();
		});
		client.emit("porchlight/engine/detections/front_left/person", { camera: "front_left", cls: "person", conf: 0.7, t: T(12, 0, 0) });

		const ok = await fetch(`http://127.0.0.1:${port}/api/events?from=${T(0, 0, 0)}&to=${T(23, 59, 59)}`);
		const body = await ok.json();
		assert.equal(ok.status, 200);
		assert.deepEqual(body.events.map((e) => e.camera), ["front_left"]);
		assert.deepEqual(body.bus, { connected: true, url: "mqtt://fake-bus" });

		for (const [query, message] of [
			[`from=${T(0, 0, 0)}&to=abc`, "events: to must be an epoch-seconds timestamp (UTC)"],
			["to=5", "events: from must be an epoch-seconds timestamp (UTC)"],
			[`from=${T(0, 0, 0)}&to=${T(1, 0, 0)}&limit=0`, "events: limit must be a positive integer"],
		]) {
			const res = await fetch(`http://127.0.0.1:${port}/api/events?${query}`);
			assert.equal(res.status, 422);
			assert.deepEqual(await res.json(), { error: message });
		}

		// Camera + limit narrowing over REST.
		client.emit("porchlight/engine/detections/front_left/person", { camera: "front_left", cls: "person", conf: 0.8, t: T(12, 0, 1) });
		client.emit("porchlight/engine/detections/back_door/person", { camera: "back_door", cls: "person", conf: 0.9, t: T(12, 0, 2) });
		const filtered = await fetch(`http://127.0.0.1:${port}/api/events?from=${T(0, 0, 0)}&to=${T(23, 59, 59)}&cameraId=back_door`);
		assert.deepEqual((await filtered.json()).events.map((e) => e.conf), [0.9]);
	});
});
