// modes.test.js — writer-layer recording modes (PORCH-136, ac-3).
//
// Event mode writes store segments only while an event window is open
// (bounded staging ingest + pre/post-roll promotion); a manual trigger from
// live view records into the protected manual tier that no retention rule
// or sweep can prune. No ffmpeg: a fake spawn child that never exits; the
// tests place settled segments directly and drive poll() on a fixed clock.

import { test } from "node:test";
import assert from "node:assert/strict";
import fsDefault from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";

import { RecorderDaemon } from "../src/recorder.js";
import { pruneRolling, pruneEventTier } from "../src/retention.js";
import { dateDirName, hourDirName, segmentBaseName } from "../src/paths.js";

const S = 1000;

function tmp(label) {
	return fsDefault.mkdtempSync(path.join(os.tmpdir(), `porch-modes-${label}-`));
}

/** Fake ffmpeg: alive forever; records every spawn cwd. */
function fakeSpawn() {
	/** @type {string[]} */
	const cwds = [];
	/** @type {any[]} */
	const procs = [];
	const spawn = (_file, _args, opts) => {
		cwds.push(opts.cwd);
		const proc = new EventEmitter();
		proc.pid = 4000 + procs.length;
		proc.stderr = null;
		proc.kill = () => {
			proc.emit("close", null, "SIGTERM");
			return true;
		};
		procs.push(proc);
		return proc;
	};
	return { spawn, cwds, procs };
}

/** Place a settled segment at tsMs in a tree. Returns the relPath. */
function place(root, camera, tsMs, { part = false, bytes = 100 } = {}) {
	const rel = path.join(dateDirName(tsMs), hourDirName(tsMs), camera, `${segmentBaseName(tsMs)}${part ? ".part" : ".mp4"}`);
	fsDefault.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
	fsDefault.writeFileSync(path.join(root, rel), "x".repeat(bytes));
	return rel;
}

test("event mode: segments write on events only, with pre/post-roll coverage", () => {
	const root = tmp("event");
	const staging = path.join(root, ".staging");
	const T = Date.UTC(2026, 10, 20, 12, 15, 0);
	let now = T;
	// PORCH-154: config of record carries the camera fleet — the writer's
	// relay port derives from the camera's position in it.
	const camDef = /** @type {any} */ ({ name: "camA", source: { url: "rtsp://a" }, recordingMode: "event", preRollSeconds: 10, postRollSeconds: 30 });
	const cam = new RecorderDaemon({
		camera: camDef,
		config: /** @type {any} */ ({ storageRoot: root, segmentSeconds: 60, cameras: [camDef] }),
		activeRoot: () => root,
		nowMs: () => now,
		spawn: fakeSpawn().spawn,
		pollMs: 1e9,
		log: () => {},
	});
	// Pre-event staging ingest: old, near, and live segments.
	place(staging, "camA", T - 3600 * S);
	place(staging, "camA", T - 120 * S);
	place(staging, "camA", T - 60 * S);
	place(staging, "camA", T, { part: true });

	assert.equal(cam.trigger(), true); // event at T
	assert.deepEqual(cam.eventWindow, { startedAt: T, endsAt: T + 30 * S });
	now = T + 1;
	cam.poll();

	// Segment-granular pre-roll: the segment holding the trigger-10s boundary
	// ([T-60, T]) promoted; segments fully before it and the live .part stay.
	const eventsTree = path.join(root, "events");
	const promoted = fsDefault.readdirSync(path.join(eventsTree, dateDirName(T), hourDirName(T), "camA"));
	assert.equal(promoted.length, 1);
	assert.equal(promoted[0], `${segmentBaseName(T - 60 * S)}.mp4`);
	// The .part never moves while ffmpeg holds it.
	assert.ok(fsDefault.existsSync(path.join(staging, dateDirName(T), hourDirName(T), "camA", `${segmentBaseName(T)}.part`)));
	// Nothing entered the rolling ring: the store only grew the events tier.
	assert.ok(!fsDefault.existsSync(path.join(root, dateDirName(T))));

	// Post-roll: each trigger extends the window; poll keeps promoting.
	now = T + 40 * S; // 10s past endsAt — window still open (pre-roll window law)
	place(staging, "camA", T - 90 * S); // within [T-130s horizon] — stays in staging
	cam.poll();
	now = T + 70 * S; // window end passed + the [T+60s] segment exists → close
	place(staging, "camA", T + 60 * S);
	// The muxer moved past the covering segment: the .part settles (rename).
	fsDefault.renameSync(
		path.join(staging, dateDirName(T), hourDirName(T), "camA", `${segmentBaseName(T)}.part`),
		path.join(staging, dateDirName(T), hourDirName(T), "camA", `${segmentBaseName(T)}.mp4`),
	);
	cam.poll();
	assert.equal(cam.eventWindow, null);
	const eventFiles = fsDefault.readdirSync(path.join(eventsTree, dateDirName(T), hourDirName(T), "camA")).sort();
	assert.deepEqual(eventFiles, [`${segmentBaseName(T - 60 * S)}.mp4`, `${segmentBaseName(T)}.mp4`]);
	// The covering segment left the staging tree.
	assert.ok(!fsDefault.existsSync(path.join(staging, dateDirName(T), hourDirName(T), "camA", `${segmentBaseName(T)}.part`)));

	// GC keeps the staging ring bounded: old staged segments drop.
	now = T + 10 * 60 * S;
	cam.poll();
	assert.ok(!fsDefault.existsSync(path.join(staging, dateDirName(T - 3600 * S), hourDirName(T - 3600 * S), "camA", `${segmentBaseName(T - 3600 * S)}.mp4`)));
	fsDefault.rmSync(root, { recursive: true, force: true });
});

test("manual trigger records into the protected tier; sweeps never prune it", () => {
	const root = tmp("manual");
	const d = new RecorderDaemon({
		camera: /** @type {any} */ ({ name: "camA", source: { url: "rtsp://a" }, recordingMode: "event" }),
		config: /** @type {any} */ ({ storageRoot: root, segmentSeconds: 60, cameras: [{ name: "camA", source: { url: "rtsp://a" }, recordingMode: "event" }] }),
		activeRoot: () => root,
		spawn: fakeSpawn().spawn,
		pollMs: 1e9,
		log: () => {},
	});
	assert.equal(d.manualStart(), true);
	assert.equal(d.target().kind, "manual");
	assert.equal(d.target().cwd, path.join(root, "manual"));
	// Second start is a no-op (already protected-recording).
	assert.equal(d.manualStart(), false);
	assert.equal(d.manualStop(), true);
	assert.equal(d.target().kind, "staging");

	// The protected tier ignores every sweep: rolling pruning removes whole
	// rolling date dirs; the event tier prunes per rule; manual never moves.
	const oldDayTs = Date.UTC(2026, 10, 1, 8, 0, 0);
	place(root, "camA", oldDayTs); // rolling day, ancient
	place(path.join(root, "events"), "camA", oldDayTs);
	place(path.join(root, "manual"), "camA", oldDayTs);
	pruneRolling({ root, retentionDays: 7, nowMs: Date.UTC(2026, 10, 25), fs: fsDefault });
	pruneEventTier({ root, eventRetentionDays: 1, nowMs: Date.UTC(2026, 10, 25), fs: fsDefault });
	assert.ok(fsDefault.existsSync(path.join(root, "manual", dateDirName(oldDayTs), hourDirName(oldDayTs), "camA", `${segmentBaseName(oldDayTs)}.mp4`)), "manual survives every sweep");
	assert.ok(!fsDefault.existsSync(path.join(root, dateDirName(oldDayTs))), "rolling day pruned");
	assert.ok(!fsDefault.existsSync(path.join(root, "events", dateDirName(oldDayTs))), "event day pruned per its window");
	fsDefault.rmSync(root, { recursive: true, force: true });
});

test("continuous cameras ignore event triggers; manual switch moves the writer", () => {
	const root = tmp("continuous");
	const fake = fakeSpawn();
	let now = Date.UTC(2026, 10, 20, 12, 0, 0);
	const d = new RecorderDaemon({
		camera: /** @type {any} */ ({ name: "camA", source: { url: "rtsp://a" } }),
		config: /** @type {any} */ ({ storageRoot: root, segmentSeconds: 60, cameras: [{ name: "camA", source: { url: "rtsp://a" } }] }),
		activeRoot: () => root,
		nowMs: () => now,
		spawn: fake.spawn,
		pollMs: 1e9,
		log: () => {},
	});
	d.manualStart();
	assert.equal(d.target().kind, "manual");
	assert.equal(d.snapshot().manualActive, true);
	// Continuous mode never records into events/staging for triggers.
	assert.equal(d.trigger(), false);
	assert.equal(d.snapshot().recordingMode, "continuous");
	fsDefault.rmSync(root, { recursive: true, force: true });
});

test("retention rules floor: the max matching rule keeps event footage longer", () => {
	const root = tmp("rules");
	const oldTs = Date.UTC(2026, 10, 1, 8, 0, 0);
	place(path.join(root, "events"), "camA", oldTs);
	place(path.join(root, "events"), "camB", oldTs);
	pruneEventTier({
		root,
		eventRetentionDays: 30,
		retentionRules: [{ cameraId: "camA", keepDays: 60 }],
		nowMs: Date.UTC(2026, 10, 35),
		fs: fsDefault,
	});
	// camA's rule keeps it 60 days; camB falls to the class default (30).
	assert.ok(fsDefault.existsSync(path.join(root, "events", dateDirName(oldTs), hourDirName(oldTs), "camA")));
	assert.ok(!fsDefault.existsSync(path.join(root, "events", dateDirName(oldTs), hourDirName(oldTs), "camB")));
	fsDefault.rmSync(root, { recursive: true, force: true });
});

test("target switches re-spawn ffmpeg immediately at the new tree", async () => {
	const root = tmp("switch");
	const fake = fakeSpawn();
	const d = new RecorderDaemon({
		camera: /** @type {any} */ ({ name: "camA", source: { url: "rtsp://a" }, recordingMode: "event" }),
		config: /** @type {any} */ ({ storageRoot: root, segmentSeconds: 60, cameras: [{ name: "camA", source: { url: "rtsp://a" }, recordingMode: "event" }] }),
		activeRoot: () => root,
		spawn: fake.spawn,
		pollMs: 1e9,
		log: () => {},
	});
	try {
		d.start();
		await new Promise((r) => setTimeout(r, 60)); // recoverOrphans → spawnFfmpeg
		assert.equal(fake.cwds[0], path.join(root, ".staging"), "event mode stages into .staging");
		d.manualStart();
		await new Promise((r) => setTimeout(r, 60)); // planned kill → immediate respawn, no backoff ladder
		assert.deepEqual(fake.cwds[1], path.join(root, "manual"), "manual trigger moves the writer");
		assert.equal(d.snapshot().recordingTarget, "manual");
		d.manualStop();
		await new Promise((r) => setTimeout(r, 60));
		assert.deepEqual(fake.cwds[2], path.join(root, ".staging"), "manual stop returns to the mode's writer");
	} finally {
		await d.stop();
		fsDefault.rmSync(root, { recursive: true, force: true });
	}
});
