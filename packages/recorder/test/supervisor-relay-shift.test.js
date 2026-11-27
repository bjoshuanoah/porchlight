// supervisor-relay-shift.test.js — PORCH-154: a live fleet change that moves
// a kept camera's relay port (sorted-fleet position) is a writer change — the
// supervisor rebuilds that writer so its ffmpeg reads the listener the manager
// actually moved, instead of holding a stale spawn-time argv.

import { test } from "node:test";
import assert from "node:assert/strict";
import fsDefault from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";

import { RecorderSupervisor } from "../src/supervisor.js";

/** Fake ffmpeg child: alive forever, records every spawn argv. */
function fakeSpawn() {
	const argvs = [];
	const spawn = (_file, args) => {
		argvs.push(args);
		const proc = /** @type {any} */ (new EventEmitter());
		proc.pid = 50000 + argvs.length;
		proc.stderr = null;
		proc.kill = () => {
			proc.emit("close", null, "SIGTERM");
			return true;
		};
		return proc;
	};
	return { spawn, argvs };
}

/** The -i input value of a captured spawn argv, or null. */
function inputOf(argv) {
	const i = argv.indexOf("-i");
	return i >= 0 ? argv[i + 1] : null;
}

/** @returns {import("../src/types.js").RecorderConfig} */
function config(root, cameras) {
	return {
		storageRoot: root,
		port: 17971,
		segmentSeconds: 10,
		retentionDays: 2,
		streams: { base: 18972 },
		cameras,
	};
}

const camA = { name: "camA", source: { url: "rtsp://cam/a" } };
const camB = { name: "camB", source: { url: "rtsp://cam/b" } };

/** spawnFfmpeg rides orphan-recovery (async): wait for the daemon's spawn. */
async function until(fn, ms = 2000) {
	const end = Date.now() + ms;
	for (;;) {
		if (fn()) return;
		if (Date.now() > end) return;
		await new Promise((r) => setTimeout(r, 25));
	}
}

test("a fleet shift that moves a kept camera's relay port rebuilds that writer", async () => {
	const root = path.join(os.tmpdir(), `porch-stream-shift-${process.pid}-${Math.random().toString(36).slice(2)}`);
	fsDefault.mkdirSync(root, { recursive: true });
	const { spawn, argvs } = fakeSpawn();
	const sup = new RecorderSupervisor({
		config: config(root, [camA, camB]),
		spawn,
		pollMs: 100,
	});
	sup.start();
	try {
		await until(() => argvs.length >= 2);
		assert.deepEqual(
			argvs.map(inputOf).sort(),
			["tcp://127.0.0.1:18973", "tcp://127.0.0.1:18974"],
			"boot writers read their sorted-fleet relay ports",
		);
		// "cam-0" sorts before both (codepoint '-' < letters): every kept
		// writer's relay port shifts up by one — both must rebuild.
		const next = config(root, [
			camA,
			camB,
			{ name: "cam-0", source: { url: "rtsp://cam/zero" } },
		]);
		const result = await sup.applyConfig(next);
		const inputs = argvs.map(inputOf);
		assert.equal(inputs.filter((x) => x === "tcp://127.0.0.1:18975").length, 1, "camB rebuilt on its shifted relay port");
		assert.equal(inputs.filter((x) => x === "tcp://127.0.0.1:18974").length, 2, "camA rebuilt (was 18974 at boot)");
		assert.equal(inputs.filter((x) => x === "tcp://127.0.0.1:18973").length, 2, "cam-0 started on the vacated port (was camA's)");
		assert.deepEqual(result.stopped.sort(), ["camA", "camB"]);
		assert.deepEqual(result.started.sort(), ["cam-0", "camA", "camB"]);
	} finally {
		await sup.stop();
		fsDefault.rmSync(root, { recursive: true, force: true });
	}
});

test("a fleet change that keeps every relay port untouched keeps writers", async () => {
	const root = path.join(os.tmpdir(), `porch-stream-keep-${process.pid}-${Math.random().toString(36).slice(2)}`);
	fsDefault.mkdirSync(root, { recursive: true });
	const { spawn, argvs } = fakeSpawn();
	const sup = new RecorderSupervisor({
		config: config(root, [camA, camB]),
		spawn,
		pollMs: 100,
	});
	sup.start();
	try {
		// Same name set → relay ports unchanged; only camA's source mutates.
		// Await the boot spawns first: applyConfig stops a not-yet-spawned
		// writer before its first ffmpeg ever launches (the rebuild is then
		// that camera's ONLY spawn), which would skew post-hoc counts.
		await until(() => argvs.map(inputOf).sort().join() === "tcp://127.0.0.1:18973,tcp://127.0.0.1:18974");
		const next = config(root, [{ name: "camA", source: { url: "rtsp://cam/a2" } }, camB]);
		const res = await sup.applyConfig(next);
		// camA rebuilds (source changed), camB is kept: one new camA spawn.
		await until(() => argvs.filter((a) => inputOf(a) === "tcp://127.0.0.1:18973").length >= 2);
		assert.equal(argvs.filter((a) => inputOf(a) === "tcp://127.0.0.1:18973").length, 2, "camA rebuilt for its source change");
		assert.equal(argvs.filter((a) => inputOf(a) === "tcp://127.0.0.1:18974").length, 1, "camB kept — no new spawn");
		assert.equal(argvs.length, 3, "exactly one rebuild spawn");
		assert.deepEqual({ started: [...res.started].sort(), stopped: [...res.stopped].sort(), kept: [...res.kept].sort() }, { started: ["camA"], stopped: ["camA"], kept: ["camB"] });
	} finally {
		await sup.stop();
		fsDefault.rmSync(root, { recursive: true, force: true });
	}
});
