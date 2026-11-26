// supervisor-storage.test.js — the failover state machine through the live
// supervisor (PORCH-136, ac-2): fault injection on the primary location
// moves recording to the failover in a degraded-write state, the alert
// fires, failback is manual; with no failover recording pauses with the
// state named; the status plane renders and the drive-health alert fires.

import { test } from "node:test";
import assert from "node:assert/strict";
import fsDefault from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";

import { RecorderSupervisor } from "../src/supervisor.js";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** fs proxy failing every op under the given prefixes (fault injection). */
function faultingFs(prefixes) {
	const boom = () => Object.assign(new Error("EIO: input/output error"), { code: "EIO" });
	const f = /** @type {typeof fsDefault} */ ({ ...fsDefault });
	for (const name of ["mkdirSync", "writeFileSync", "readFileSync", "unlinkSync", "readdirSync", "statSync", "rmSync", "renameSync", "existsSync"]) {
		const real = /** @type {any} */ (fsDefault[name]);
		/** @type {any} */ (f)[name] = (p, ...args) => {
			if (prefixes.some((pre) => String(p).startsWith(pre))) throw boom();
			return real(p, ...args);
		};
	}
	return f;
}

function fakeSpawn() {
	/** @type {string[]} */
	const cwds = [];
	const spawn = (_file, _args, opts) => {
		cwds.push(opts.cwd);
		const proc = new EventEmitter();
		proc.pid = 40000 + cwds.length;
		proc.stderr = null;
		proc.kill = () => {
			proc.emit("close", null, "SIGTERM");
			return true;
		};
		return proc;
	};
	return { spawn, cwds };
}

async function call(port, method, pathname) {
	return new Promise((resolve, reject) => {
		const req = http.request({ host: "127.0.0.1", port, method, path: pathname }, (res) => {
			let body = "";
			res.on("data", (c) => (body += c));
			res.on("end", () => resolve({ status: res.statusCode, body: JSON.parse(body || "{}") }));
		});
		req.on("error", reject);
		req.end();
	});
}

function primaryRoot(dir) {
	return path.join(dir, "primary");
}

const cameras = [{ name: "camA", source: { url: "rtsp://cam/a" } }];

test("primary fault → degraded-write on the failover, alert fires, manual failback", async () => {
	const dir = fsDefault.mkdtempSync(path.join(os.tmpdir(), "porch-sup-fail-"));
	const primary = primaryRoot(dir);
	const failover = path.join(dir, "failover");
	const fake = fakeSpawn();
	const supervisor = new RecorderSupervisor({
		config: /** @type {any} */ ({ storageRoot: primary, failoverRoot: failover, port: 18981, segmentSeconds: 10, retentionDays: 2, cameras }),
		spawn: fake.spawn,
		pollMs: 100,
		log: () => {},
	});
	try {
		supervisor.start();
		await sleep(120);
		const spawns0 = fake.cwds.length;
		assert.ok(spawns0 >= 1, "daemon spawned at the primary first");
		assert.ok(fake.cwds[0].startsWith(primary), `first spawn cwd under primary (got ${fake.cwds[0]})`);

		// Fault injection: the primary volume dies after boot.
		supervisor.injectFs(faultingFs([primary]));
		supervisor.daemons[0].reportWriteError({ where: "segment dir pre-create", err: Object.assign(new Error("EIO"), { code: "EIO" }) });
		await sleep(150); // planned kill + immediate respawn at the failover

		const state = supervisor.state();
		assert.equal(state.storage.state, "degraded-write");
		assert.equal(state.storage.activeLocation, failover);
		assert.equal(state.storage.driveHealthy, true, "degraded-write is still recording");
		assert.equal(state.health, "degraded"); // failing-over state is named, never silent
		assert.ok(state.events.some((e) => e.type === "storage.failover"), "switchover alert event recorded");
		const lastSpawn = fake.cwds[fake.cwds.length - 1];
		assert.ok(lastSpawn.startsWith(failover), `recording continues on the failover (last cwd ${lastSpawn})`);

		const status = await call(18981, "GET", "/api/storage");
		assert.equal(status.body.state, "degraded-write");
		assert.equal(status.body.failover, failover);

		// Failback is MANUAL — and refused while the primary still fails.
		const refused = await call(18981, "POST", "/api/storage/failback");
		assert.equal(refused.status, 409);
		assert.match(refused.body.error, /still fails/);
		assert.equal(supervisor.state().storage.state, "degraded-write");

		// Primary recovers; failback succeeds only via the manual command.
		supervisor.injectFs(fsDefault);
		const back = await call(18981, "POST", "/api/storage/failback");
		assert.equal(back.status, 200);
		assert.equal(back.body.ok, true);
		assert.equal(back.body.storage.state, "primary");
		await sleep(150);
		const last = fake.cwds[fake.cwds.length - 1];
		assert.ok(last.startsWith(primary), `failback migrates the writer home (${last})`);
		assert.equal(supervisor.state().events.some((e) => e.type === "storage.failback"), true);
	} finally {
		await supervisor.stop();
		fsDefault.rmSync(dir, { recursive: true, force: true });
	}
});

test("no failover configured: recording pauses with the state named, recovers on health", async () => {
	const dir = fsDefault.mkdtempSync(path.join(os.tmpdir(), "porch-sup-pause-"));
	const primary = primaryRoot(dir);
	const fake = fakeSpawn();
	const supervisor = new RecorderSupervisor({
		config: /** @type {any} */ ({ storageRoot: primary, port: 18982, segmentSeconds: 10, cameras }),
		spawn: fake.spawn,
		pollMs: 100,
		log: () => {},
	});
	try {
		supervisor.start();
		await sleep(120);
		supervisor.injectFs(faultingFs([primary]));
		supervisor.daemons[0].reportWriteError({ where: "segment dir pre-create", err: Object.assign(new Error("EIO"), { code: "EIO" }) });
		await sleep(150);

		const state = supervisor.state();
		assert.equal(state.storage.state, "unavailable");
		assert.equal(state.storage.paused, true);
		assert.match(state.storage.reason ?? "", /recording paused/);
		assert.ok(state.events.some((e) => e.type === "storage.unavailable"), "pause event recorded");

		const status = await call(18982, "GET", "/api/storage");
		assert.equal(status.body.state, "unavailable");
		assert.equal(status.body.paused, true);
		assert.equal(status.body.usage, null);

		// Manual trigger while paused: 409 naming the pause (never silent).
		const manual = await call(18982, "POST", "/api/cameras/camA/record/start");
		assert.equal(manual.status, 409);
		assert.match(manual.body.error, /paused/);

		// The drive-health probe recovers the paused state once it writes again.
		supervisor.injectFs(fsDefault);
		supervisor.writeState(); // state file write works again
		supervisor.probeDriveHealth();
		assert.equal(supervisor.state().storage.state, "primary");
		assert.equal(supervisor.state().storage.paused, false);
		await sleep(120);
		assert.ok(supervisor.daemons.length === 1, "recording resumed with a daemon");
		assert.ok(supervisor.daemons[0].state === "recording" || supervisor.daemons[0].state === "starting");
		assert.ok(fake.cwds[fake.cwds.length - 1].startsWith(primary), "resume writes to the primary");
	} finally {
		await supervisor.stop();
		fsDefault.rmSync(dir, { recursive: true, force: true });
	}
});

test("drive fault injection fires the admin alert and names the drive state", async () => {
	const dir = fsDefault.mkdtempSync(path.join(os.tmpdir(), "porch-sup-drive-"));
	const primary = primaryRoot(dir);
	const supervisor = new RecorderSupervisor({
		config: /** @type {any} */ ({ storageRoot: primary, port: 18983, segmentSeconds: 10, cameras: [] }),
		pollMs: 1e9,
		log: () => {},
		bus: null,
	});
	try {
		supervisor.start();
		supervisor.injectFs(faultingFs([primary]));
		supervisor.probeDriveHealth();
		const state = supervisor.state();
		assert.equal(state.storage.driveHealthy, false);
		assert.match(state.storage.driveReason ?? "", /I\/O error|failing/);
		assert.ok(state.events.some((e) => e.type === "storage.drive-health"), "drive-health alert recorded");
		assert.equal(state.health, "degraded");

		// The status plane names the drive state — never a silent stall.
		const status = await call(18983, "GET", "/api/storage");
		assert.equal(status.body.driveHealthy, false);
		assert.ok(status.body.reason || status.body.driveReason);

		// Healthy again → recovery without manual action (same location).
		supervisor.injectFs(fsDefault);
		supervisor.probeDriveHealth();
		assert.equal(supervisor.state().storage.driveHealthy, true);
		assert.ok(
			supervisor.state().events.some((e) => e.type === "storage.recovered" || e.type === "storage.drive-recovered"),
			"recovery lands in the event log",
		);
	} finally {
		await supervisor.stop();
		fsDefault.rmSync(dir, { recursive: true, force: true });
	}
});

test("manual trigger and event API refuse plain-language when inapplicable", async () => {
	const dir = fsDefault.mkdtempSync(path.join(os.tmpdir(), "porch-sup-api-"));
	const supervisor = new RecorderSupervisor({
		config: /** @type {any} */ ({ storageRoot: primaryRoot(dir), port: 18984, segmentSeconds: 10, cameras: [{ name: "camA", source: { url: "rtsp://x" } }] }),
		spawn: fakeSpawn().spawn,
		pollMs: 100,
		log: () => {},
	});
	try {
		supervisor.start();
		await sleep(120);
		const unknown = await call(18984, "POST", "/api/cameras/nope/record/start");
		assert.equal(unknown.status, 404);
		const trigger = await call(18984, "POST", "/api/cameras/camA/trigger");
		assert.equal(trigger.status, 409);
		assert.match(trigger.body.error, /continuously/);
		const started = await call(18984, "POST", "/api/cameras/camA/record/start");
		assert.equal(started.status, 200);
		assert.equal(started.body.manualActive, true);
		const dup = await call(18984, "POST", "/api/cameras/camA/record/start");
		assert.equal(dup.status, 409);
		const stopped = await call(18984, "POST", "/api/cameras/camA/record/stop");
		assert.equal(stopped.status, 200);
		const dupStop = await call(18984, "POST", "/api/cameras/camA/record/stop");
		assert.equal(dupStop.status, 409);
	} finally {
		await supervisor.stop();
		fsDefault.rmSync(dir, { recursive: true, force: true });
	}
});
