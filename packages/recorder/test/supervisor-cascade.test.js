// supervisor-cascade.test.js — the retention index cascade rides the
// supervisor's sweep IN THE SAME PASS (PORCH-155; TS 13): deleted dates drop
// their transcript text + vector payloads synchronously within one
// sweepRetention() call — never a later cleanup hope — and a not-wired
// cascade never breaks the sweep.

import { test } from "node:test";
import assert from "node:assert/strict";
import fsDefault from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";

import { RecorderSupervisor } from "../src/supervisor.js";
import { dateDirName, DAY_MS } from "../src/paths.js";

// Days ride the real clock: the supervisor sweeps with nowMs: Date.now().
const NOW = Date.now();

function fakeSpawn() {
	const spawn = (_file, _args, opts) => {
		const proc = new EventEmitter();
		proc.pid = 41000 + opts.cwd.length;
		proc.stderr = null;
		proc.kill = () => {
			proc.emit("close", null, "SIGTERM");
			return true;
		};
		return proc;
	};
	return { spawn };
}

function seededRoot(dir) {
	const root = path.join(dir, "primary");
	// An old day and a fresh day plus an event-tier old day.
	for (const day of ["old", "fresh"]) {
		const when = day === "old" ? NOW - 4 * DAY_MS : NOW;
		fsDefault.mkdirSync(path.join(root, dateDirName(when), "12", "camA"), { recursive: true });
		fsDefault.writeFileSync(path.join(root, dateDirName(when), "12", "camA", "120000.mp4"), "x");
		fsDefault.mkdirSync(path.join(root, "events", dateDirName(when), "12", "camA"), { recursive: true });
		fsDefault.writeFileSync(path.join(root, "events", dateDirName(when), "12", "camA", "120000.mp4"), "x");
	}
	return root;
}

test("the sweep drops deleted dates into the cascade in the same pass, rolling and events", async () => {
	const dir = fsDefault.mkdtempSync(path.join(os.tmpdir(), "porch-cascade-"));
	try {
		const root = seededRoot(dir);
		/** @type {string[][]} */
		const rollingCalls = [];
		/** @type {string[][]} */
		const eventCalls = [];
		const supervisor = new RecorderSupervisor({
			config: /** @type {any} */ ({ storageRoot: root, port: 18990, segmentSeconds: 10, retentionDays: 1, eventRetentionDays: 1, cameras: [] }),
			spawn: fakeSpawn().spawn,
			log: () => {},
			retentionCascade: {
				dropRollingDates: async (dates) => {
					rollingCalls.push(dates);
					return { records: 0, vectors: 0, dateKeys: dates };
				},
				dropEventDates: async (dates) => {
					eventCalls.push(dates);
					return { records: 0, vectors: 0, dateKeys: dates };
				},
			},
		});
		supervisor.start();
		try {
			const before = fsDefault.existsSync(path.join(root, dateDirName(NOW - 4 * DAY_MS)));
			assert.equal(before, true);
			const sweep = await supervisor.sweepRetention();
			// The cascade RAN INSIDE the sweep call (same pass, same await chain):
			// the old rolling and event days were both dropped through it.
			assert.deepEqual(rollingCalls, [[dateDirName(NOW - 4 * DAY_MS)]]);
			assert.deepEqual(eventCalls, [[dateDirName(NOW - 4 * DAY_MS)]]);
			assert.equal(sweep.rolling.removed[0], dateDirName(NOW - 4 * DAY_MS));
			assert.equal(sweep.cascadeRolling.dateKeys[0], dateDirName(NOW - 4 * DAY_MS));
			// Nothing deleted lands in the cascade twice: the fresh day stays.
			assert.equal(fsDefault.existsSync(path.join(root, dateDirName(NOW))), true);
		} finally {
			await supervisor.stop();
		}
	} finally {
		fsDefault.rmSync(dir, { recursive: true, force: true });
	}
});

test("a not-wired cascade is a stated no-op — the sweep still prunes", async () => {
	const dir = fsDefault.mkdtempSync(path.join(os.tmpdir(), "porch-cascade-"));
	try {
		const root = seededRoot(dir);
		const supervisor = new RecorderSupervisor({
			config: /** @type {any} */ ({ storageRoot: root, port: 18991, segmentSeconds: 10, retentionDays: 1, eventRetentionDays: 1, cameras: [] }),
			spawn: fakeSpawn().spawn,
			log: () => {},
		});
		supervisor.start();
		try {
			const sweep = await supervisor.sweepRetention();
			assert.equal(sweep.rolling.removed.length, 1);
			assert.equal(sweep.cascadeRolling, null, "no cascade wired — nothing dropped, truthfully reported");
		} finally {
			await supervisor.stop();
		}
	} finally {
		fsDefault.rmSync(dir, { recursive: true, force: true });
	}
});

test("a failing cascade reports the sweep failure as a stated event, never a silent partial delete", async () => {
	const dir = fsDefault.mkdtempSync(path.join(os.tmpdir(), "porch-cascade-"));
	try {
		const root = seededRoot(dir);
		const supervisor = new RecorderSupervisor({
			config: /** @type {any} */ ({ storageRoot: root, port: 18992, segmentSeconds: 10, retentionDays: 1, eventRetentionDays: 1, cameras: [] }),
			spawn: fakeSpawn().spawn,
			log: () => {},
			retentionCascade: {
				dropRollingDates: async () => {
					throw new Error("cascade store unavailable");
				},
				dropEventDates: async () => ({ records: 0, vectors: 0, dateKeys: [] }),
			},
		});
		supervisor.start();
		try {
			const sweep = await supervisor.sweepRetention();
			assert.equal(sweep, null, "the failing sweep is reported, not swallowed");
			assert.ok(supervisor.state().events.some((e) => e.type === "retention.error"), "the failure lands as a stated event");
		} finally {
			await supervisor.stop();
		}
	} finally {
		fsDefault.rmSync(dir, { recursive: true, force: true });
	}
});
