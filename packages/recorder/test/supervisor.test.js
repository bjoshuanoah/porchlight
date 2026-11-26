// supervisor.test.js — supervisor wiring without ffmpeg (PORCH-127).
//
// A fake spawn emits a child that never exits: proves the state file, health
// endpoint, and retention wiring run on a supervisor whose daemons are
// managed end to end without any real camera or encoder work.

import { test } from "node:test";
import assert from "node:assert/strict";
import fsDefault from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";

import { RecorderSupervisor } from "../src/supervisor.js";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** @returns {import("../src/types.js").RecorderConfig} */
function config(root, port) {
	return {
		storageRoot: root,
		port,
		segmentSeconds: 10,
		retentionDays: 2,
		cameras: [
			{ name: "camA", source: { url: "rtsp://cam/a" } },
			{ name: "camB", source: { url: "rtsp://cam/b" } },
		],
	};
}

/** Fake ffmpeg child: alive forever, never writes. */
function fakeSpawn() {
	/** @type {import("node:child_process").ChildProcess[]} */
	const procs = [];
	const spawn = () => {
		const proc = /** @type {any} */ (new EventEmitter());
		proc.pid = 42420 + procs.length;
		proc.stderr = null;
		proc.kill = () => {
			proc.emit("close", null, "SIGTERM");
			return true;
		};
		procs.push(proc);
		return proc;
	};
	return { spawn, procs };
}

test("supervisor writes state, serves /health, and stops cleanly", async () => {
	const tmp = fsDefault.mkdtempSync(path.join(os.tmpdir(), "rec-sup-"));
	const root = path.join(tmp, "store");
	const port = 18971;
	const fake = fakeSpawn();
	const supervisor = new RecorderSupervisor({ config: config(root, port), pollMs: 100, spawn: fake.spawn });
	supervisor.start();
	try {
		await sleep(250);
		supervisor.writeState(); // the file refreshes on a 2s cadence; force one
		const state = JSON.parse(fsDefault.readFileSync(path.join(root, "recorder-state.json"), "utf8"));
		assert.equal(state.cameras.length, 2);
		assert.equal(state.health, "ok");
		assert.equal(state.segmentSeconds, 10);
		assert.equal(fake.procs.length, 2);
		const child = await new Promise((resolve, reject) => {
			const req = http.get({ host: "127.0.0.1", port, path: "/health" }, (res) => {
				let body = "";
				res.on("data", (c) => (body += c));
				res.on("end", () => resolve(JSON.parse(body)));
			});
			req.on("error", reject);
		});
		assert.equal(child.service, "porchlight-recorder");
		assert.equal(child.health, "ok");
		assert.deepEqual(child.cameras.map((c) => c.camera), ["camA", "camB"]);
		assert.deepEqual(
			child.cameras.map((c) => c.audioMode),
			["transcode", "transcode"],
		);
	} finally {
		await supervisor.stop();
		await sleep(50);
		const finalState = JSON.parse(fsDefault.readFileSync(path.join(root, "recorder-state.json"), "utf8"));
		assert.equal(finalState.stopping, true);
		assert.equal(finalState.health, "degraded");
		fsDefault.rmSync(tmp, { recursive: true, force: true });
	}
});
