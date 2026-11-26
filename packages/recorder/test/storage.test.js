// storage.test.js — the storage backend plane (PORCH-136).
//
// The write test (create/read/write/delete), the failover state machine
// (fault-injected via fs), drive health, and tier usage — no ffmpeg, no
// real camera, deterministic.

import { test } from "node:test";
import assert from "node:assert/strict";
import fsDefault from "node:fs";
import os from "node:os";
import path from "node:path";

import { StorageBackend, driveHealth, tierUsage, writeTest, writeTestReason } from "../src/storage.js";

function tmp(label) {
	return fsDefault.mkdtempSync(path.join(os.tmpdir(), `porch-storage-${label}-`));
}

/** fs proxy failing every op that touches any of the given path prefixes. */
function faultingFs(prefixes) {
	const boom = () => Object.assign(new Error("EIO: input/output error"), { code: "EIO" });
	/** @type {string[]} */
	const faulted = prefixes;
	const f = /** @type {typeof fsDefault} */ ({ ...fsDefault });
	for (const name of ["mkdirSync", "writeFileSync", "readFileSync", "unlinkSync", "statfsSync", "readdirSync", "statSync", "rmSync", "renameSync", "existsSync", "cpSync"]) {
		const real = /** @type {any} */ (fsDefault[name]);
		/** @type {any} */ (f)[name] = (p, ...args) => {
			if (faulted.some((pre) => String(p).startsWith(pre))) throw boom();
			return real(p, ...args);
		};
	}
	f.openSync = (p, ...args) => {
		if (faulted.some((pre) => String(p).startsWith(pre))) throw boom();
		return /** @type {any} */ (fsDefault).openSync(p, ...args);
	};
	return f;
}

test("write test performs create, write, read, delete on a good location", () => {
	const dir = tmp("good");
	const result = writeTest(dir);
	assert.equal(result.ok, true, JSON.stringify(result));
	// The probe did its full cycle: nothing left behind.
	assert.deepEqual(fsDefault.readdirSync(dir).filter((f) => f.startsWith(".porchlight-write-test")), []);
	fsDefault.rmSync(dir, { recursive: true, force: true });
});

test("write test fails in plain language on a permission-denied location", () => {
	const dir = path.join(tmp("locked"), "inside");
	// Parent dir is read-only: "create" fails with EACCES.
	fsDefault.mkdirSync(path.dirname(dir), { recursive: true });
	fsDefault.chmodSync(path.dirname(dir), 0o555);
	try {
		if (process.getuid?.() === 0) return; // root bypasses permission faults
		const result = writeTest(dir);
		assert.equal(result.ok, false);
		assert.equal(result.step, "create");
		assert.match(result.reason ?? "", /permission denied/);
	} finally {
		fsDefault.chmodSync(path.dirname(dir), 0o755);
		fsDefault.rmSync(path.dirname(dir), { recursive: true, force: true });
	}
});

test("writeTestReason names the reason per errno", () => {
	assert.match(writeTestReason("EACCES", "create"), /permission denied/);
	assert.match(writeTestReason("EIO", "read"), /may be failing/);
	assert.match(writeTestReason("ENOSPC", "write"), /no space left/);
	assert.match(writeTestReason("EWHATEVER", "write"), /\(EWHATEVER\)/);
});

function backend(root, { failover, fs, events = [] } = {}) {
	return new StorageBackend({
		primary: root,
		failover: failover ?? null,
		fs: fs ?? fsDefault,
		onEvent: (e) => events.push(e),
	});
}

test("fault injection switches to failover; failback is manual; refusal is plain", () => {
	const primary = path.join(tmp("primary"), "store");
	fsDefault.mkdirSync(primary, { recursive: true });
	const failover = path.join(tmp("failover"), "store");
	/** @type {{type: string, detail?: string}[]} */
	const events = [];
	const bad = faultingFs([primary]);
	const b = backend(primary, { failover, fs: bad, events });
	assert.equal(b.state, "primary");

	const r1 = b.reportWriteFailure({ where: "segment dir", err: bad });
	assert.equal(r1.switched, true);
	assert.equal(b.state, "degraded-write");
	assert.equal(b.activeLocation(), failover);
	assert.match(b.reason ?? "", /failover/);
	assert.equal(events.some((e) => e.type === "storage.failover"), true);
	// Status plane (ac-4) carries the explicit state.
	assert.deepEqual([b.status().state, b.status().primary, b.status().failover], ["degraded-write", primary, failover]);

	// Primary still failing → manual failback refuses with the named reason.
	const refused = b.failback();
	assert.equal(refused.ok, false);
	assert.match(refused.reason ?? "", /still fails/);
	assert.equal(b.state, "degraded-write");
	assert.equal(events.some((e) => e.type === "storage.failback-rejected"), true);

	// Recovery of the primary alone does NOT flip state (manual-only law).
	assert.equal(b.reportWriteFailure({ where: "probe" }).switched, false);
	assert.equal(b.state, "degraded-write");

	// A repeated fault while degraded must not re-switch or re-emit.
	events.length = 0;
	assert.equal(b.reportWriteFailure({ where: "again" }).switched, false);
	assert.equal(events.length, 0);

	// Manual failback once the drive recovers.
	const good = backend(primary, { failover, fs: fsDefault, events: events });
	good.state = "degraded-write";
	const ok = good.failback();
	assert.equal(ok.ok, true);
	assert.equal(good.state, "primary");
	assert.equal(events.some((e) => e.type === "storage.failback"), true);
	fsDefault.rmSync(primary, { recursive: true, force: true });
	fsDefault.rmSync(failover, { recursive: true, force: true });
});

test("no failover configured: recording pauses with the state named", () => {
	const primary = path.join(tmp("paused"), "store");
	fsDefault.mkdirSync(primary, { recursive: true });
	/** @type {{type: string, detail?: string}[]} */
	const events = [];
	const bad = faultingFs([primary]);
	const b = backend(primary, { fs: bad, events });
	const r = b.reportWriteFailure({ where: "state file", err: bad });
	assert.equal(r.switched, false);
	assert.equal(b.state, "unavailable");
	assert.equal(b.activeLocation(), null);
	assert.match(b.reason ?? "", /recording paused/);
	assert.match(b.reason ?? "", /no failover configured/);
	assert.equal(events.some((e) => e.type === "storage.unavailable"), true);

	// Failback from a paused state names the pause, it never "succeeds".
	const refused = b.failback();
	assert.equal(refused.ok, false);
	assert.match(refused.reason ?? "", /paused/);

	// Recovery: only when the location writes again does recording resume.
	assert.equal(b.reportWriteFailure({ where: "again" }).switched, false);
	assert.equal(b.state, "unavailable");
	// (event dedupe: repeated faults do not re-emit the pause)
	const count = events.filter((e) => e.type === "storage.unavailable").length;
	b.reportWriteFailure({ where: "again" });
	assert.equal(events.filter((e) => e.type === "storage.unavailable").length, count);

	assert.equal(b.checkDriveHealth().state, "unavailable"); // still bad
	// checkDriveHealth with a healthy fs sees the location writable → recover.
	const b2 = backend(primary, { fs: faultingFs([]), events });
	b2.state = "unavailable";
	const st = b2.checkDriveHealth();
	assert.equal(st.state, "primary");
	assert.equal(events.some((e) => e.type === "storage.recovered"), true);

	fsDefault.rmSync(primary, { recursive: true, force: true });
});

test("drive health names OS-exposed signals: statfs failure and write failure", () => {
	const dir = tmp("drive");
	const statfsBroken = /** @type {any} */ ({
		...fsDefault,
		statfsSync: () => {
			throw Object.assign(new Error("Input/output error"), { code: "EIO" });
		},
		writeFileSync: () => {
			throw Object.assign(new Error("Disk I/O"), { code: "EIO" });
		},
	});
	const h1 = driveHealth(dir, { fs: statfsBroken });
	assert.equal(h1.healthy, false);
	assert.equal(h1.signal, "statfs-failure");
	assert.match(h1.reason ?? "", /I\/O error|failing/);
	const writeBroken = /** @type {any} */ ({
		...fsDefault,
		statfsSync: fsDefault.statfsSync,
		writeFileSync: () => {
			throw Object.assign(new Error("Read-only"), { code: "EROFS" });
		},
	});
	const h2 = driveHealth(dir, { fs: writeBroken });
	assert.equal(h2.healthy, false);
	assert.equal(h2.signal, "write-failure");
	assert.match(h2.reason ?? "", /read-only/);
	const h3 = driveHealth(dir, { fs: fsDefault });
	assert.equal(h3.healthy, true);
	assert.equal(h3.signal, "ok");
	fsDefault.rmSync(dir, { recursive: true, force: true });
});

test("drive-health alert fires once per degradation and recovers", () => {
	const primary = path.join(tmp("alert"), "store");
	fsDefault.mkdirSync(primary, { recursive: true });
	/** @type {{type: string}[]} */
	const events = [];
	const b = backend(primary, { fs: faultingFs([]), events });
	b.checkDriveHealth();
	const before = events.filter((e) => e.type === "storage.drive-health").length;
	// Now the drive breaks: statfs keeps working but writes die.
	const brokenFs = /** @type {any} */ ({
		...fsDefault,
		writeFileSync: (p, ...a) => {
			if (String(p).startsWith(primary)) throw Object.assign(new Error("EIO"), { code: "EIO" });
			return fsDefault.writeFileSync(p, ...a);
		},
	});
	b.fs = brokenFs;
	assert.equal(b.checkDriveHealth().driveHealthy, false);
	const after = events.filter((e) => e.type === "storage.drive-health").length;
	assert.equal(after, before + 1);
	// Degraded state persists without re-alerting every probe.
	b.checkDriveHealth();
	assert.equal(events.filter((e) => e.type === "storage.drive-health").length, after);
	fsDefault.rmSync(primary, { recursive: true, force: true });
});

test("tier usage counts the three classes separately", () => {
	const root = tmp("tiers");
	fsDefault.mkdirSync(path.join(root, "2026-11-25", "10", "camA"), { recursive: true });
	fsDefault.writeFileSync(path.join(root, "2026-11-25", "10", "camA", "100000.mp4"), "r".repeat(30));
	fsDefault.mkdirSync(path.join(root, "events", "2026-11-24", "09", "camA"), { recursive: true });
	fsDefault.writeFileSync(path.join(root, "events", "2026-11-24", "09", "camA", "090000.mp4"), "e".repeat(50));
	fsDefault.mkdirSync(path.join(root, "manual", "2026-11-23", "08", "camA"), { recursive: true });
	fsDefault.writeFileSync(path.join(root, "manual", "2026-11-23", "08", "camA", "080000.mp4"), "m".repeat(70));
	const usage = tierUsage(root);
	assert.deepEqual(usage.tiers.rolling, { segments: 1, bytes: 30 });
	assert.deepEqual(usage.tiers.events, { segments: 1, bytes: 50 });
	assert.deepEqual(usage.tiers.manual, { segments: 1, bytes: 70 });
	assert.equal(typeof usage.diskUsedFraction, "number");
	assert.ok(usage.diskUsedFraction > 0 && usage.diskUsedFraction < 1);
	fsDefault.rmSync(root, { recursive: true, force: true });
});
