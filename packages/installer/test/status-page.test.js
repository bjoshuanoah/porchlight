// status-page.test.js — health aggregation + deterministic HTML + HTTP surfaces.

import test from "node:test";
import assert from "node:assert/strict";
import { aggregateHealth, createStatusServer, renderStatusHtml } from "../src/status-page.js";

function fakeSupervisor(state) {
	return { state: () => state };
}

const idleState = {
	health: "ok",
	stopping: false,
	cameras: [],
	storageRoot: "/Library/Porchlight/recordings",
	uptimeMs: 12_000,
};

test("an idle fresh install (zero cameras) is healthy with a stated awaiting-configuration state", () => {
	const agg = aggregateHealth({ supervisor: fakeSupervisor(idleState), version: "0.5.3", halStatus: { platform: "darwin", decode: "videotoolbox" } });
	assert.equal(agg.status, "healthy");
	assert.equal(agg.awaitingConfiguration, true);
	const recorder = agg.services.find((s) => s.name === "recorder");
	assert.equal(recorder.healthy, true);
	assert.match(recorder.detail, /no cameras configured yet/);
});

test("a non-recording camera or a stopping supervisor renders degraded", () => {
	const degraded = aggregateHealth({ supervisor: fakeSupervisor({ ...idleState, health: "degraded", cameras: [{}] }) });
	assert.equal(degraded.status, "degraded");
	assert.equal(degraded.services.find((s) => s.name === "recorder").healthy, false);
	const stopping = aggregateHealth({ supervisor: fakeSupervisor({ ...idleState, stopping: true }) });
	assert.equal(stopping.status, "degraded");
});

test("a missing supervisor is a stated stopped state, not a lie", () => {
	const agg = aggregateHealth({ supervisor: null });
	assert.equal(agg.status, "degraded");
	assert.equal(agg.services.find((s) => s.name === "recorder").state, "stopped");
});

test("the storage plane rides the supervisor state as its own service row", () => {
	const agg = aggregateHealth({
		supervisor: fakeSupervisor({
			...idleState,
			storage: { state: "primary", activeLocation: "/Volumes/Recordings", primary: "/Volumes/Recordings", failover: null, reason: null, driveHealthy: true, driveReason: null, paused: false },
		}),
	});
	const storage = agg.services.find((s) => s.name === "storage");
	assert.equal(storage.healthy, true);
	assert.equal(storage.state, "primary");
	assert.equal(storage.detail, "recording to /Volumes/Recordings");
	assert.equal(agg.storage.state, "primary");
	assert.equal(agg.status, "healthy");
});

test("an unavailable or drive-failing storage plane is degraded in plain language", () => {
	const unavailable = aggregateHealth({
		supervisor: fakeSupervisor({
			...idleState,
			storage: { state: "unavailable", activeLocation: null, primary: "/Volumes/Recordings", failover: "/Volumes/Failover", reason: "no writable storage location — recording is paused", driveHealthy: true, driveReason: null, paused: true },
		}),
	});
	assert.equal(unavailable.status, "degraded");
	const row = unavailable.services.find((s) => s.name === "storage");
	assert.equal(row.healthy, false);
	assert.equal(row.detail, "no writable storage location — recording is paused");

	const driveFail = aggregateHealth({
		supervisor: fakeSupervisor({
			...idleState,
			storage: { state: "primary", activeLocation: "/Volumes/Recordings", primary: "/Volumes/Recordings", failover: null, reason: null, driveHealthy: false, driveReason: "the drive reported an I/O error", paused: false },
		}),
	});
	assert.equal(driveFail.services.find((s) => s.name === "storage").healthy, false);
	assert.equal(driveFail.services.find((s) => s.name === "storage").detail, "the drive reported an I/O error");
});

test("a supervisor state without a storage plane is a stated unknown, not a lie", () => {
	const agg = aggregateHealth({ supervisor: fakeSupervisor(idleState) });
	const row = agg.services.find((s) => s.name === "storage");
	assert.equal(row.state, "unknown");
	assert.equal(row.detail, "the recorder has not reported storage status yet");
	assert.equal(agg.storage, null);
});

test("storage states render as a reason line in the HTML", () => {
	const ok = renderStatusHtml(aggregateHealth({
		supervisor: fakeSupervisor({
			...idleState,
			storage: { state: "primary", activeLocation: "/Volumes/Recordings", primary: "/Volumes/Recordings", failover: null, reason: null, driveHealthy: true, driveReason: null, paused: false },
		}),
	}));
	assert.match(ok, /Storage: primary — recording to \/Volumes\/Recordings\./);

	const bad = renderStatusHtml(aggregateHealth({
		supervisor: fakeSupervisor({
			...idleState,
			storage: { state: "unavailable", activeLocation: null, primary: "/Volumes/Recordings", failover: null, reason: "no writable storage location — recording is paused", driveHealthy: true, driveReason: null, paused: true },
		}),
	}));
	assert.match(bad, /Storage: unavailable — no writable storage location — recording is paused\./);
	assert.equal(bad, renderStatusHtml(aggregateHealth({
		supervisor: fakeSupervisor({
			...idleState,
			storage: { state: "unavailable", activeLocation: null, primary: "/Volumes/Recordings", failover: null, reason: "no writable storage location — recording is paused", driveHealthy: true, driveReason: null, paused: true },
		}),
	})), "storage line must be deterministic given the same aggregate");
});

test("camera fleet details ride the recorder plane of the aggregate", () => {
	const agg = aggregateHealth({
		supervisor: fakeSupervisor({ ...idleState, cameras: [{ name: "front-door", state: "recording" }] }),
		// recorder.state().cameras entries are daemon snapshots
	});
	assert.deepEqual(agg.recorder?.cameraNames, ["front-door"]);
	assert.equal(agg.recorder?.cameraCount, 1);
});

test("the HTML status page is deterministic, script-free, and plain-language", () => {
	const agg = aggregateHealth({ supervisor: fakeSupervisor(idleState), version: "0.5.3", halStatus: { platform: "darwin", decode: "videotoolbox" } });
	const a = renderStatusHtml(agg);
	const b = renderStatusHtml(aggregateHealth({ ...{ supervisor: fakeSupervisor(idleState), version: "0.5.3", halStatus: { platform: "darwin", decode: "videotoolbox" } } }));
	assert.equal(a, b, "status HTML must be deterministic given the same aggregate");
	assert.ok(a.includes("<!DOCTYPE html>"));
	assert.ok(!a.includes("<script"));
	assert.ok(a.includes("No cameras configured yet"));
	assert.ok(a.match(/<b>healthy<\/b>/));
	assert.ok(a.includes("No analytics"));
});

test("degraded states render visibly in the HTML", () => {
	const agg = aggregateHealth({ supervisor: null });
	const html = renderStatusHtml(agg);
	assert.ok(html.match(/<b>degraded<\/b>/));
});

test("GET /health returns the JSON aggregate and GET / the HTML page over real HTTP", async () => {
	const srv = createStatusServer({ aggregate: () => aggregateHealth({ supervisor: fakeSupervisor(idleState), version: "0.5.3", halStatus: {} }), port: 0, host: "127.0.0.1" });
	await srv.listening();
	const port = srv.server.address().port;
	try {
		const health = await fetch(`http://127.0.0.1:${port}/health`);
		const agg = await health.json();
		assert.equal(health.status, 200);
		assert.equal(agg.status, "healthy");
		assert.equal(agg.awaitingConfiguration, true);
		assert.equal(agg.version, "0.5.3");
		const page = await fetch(`http://127.0.0.1:${port}/`);
		const html = await page.text();
		assert.equal(page.status, 200);
		assert.ok(html.includes("<!DOCTYPE html>"));
		const missing = await fetch(`http://127.0.0.1:${port}/nope`);
		assert.equal(missing.status, 404);
	} finally {
		await srv.close();
	}
});
