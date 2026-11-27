// runtime.test.js — the daemon composition root (PORCH-134 ac-1, PORCH-152).

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { startPlatformRuntime, platformPosture } from "../src/runtime.js";

function freshConfig(tmp) {
	return {
		version: 1,
		storageRoot: path.join(tmp, "recordings"),
		cameras: [],
		statusPort: 0,
		statusHost: "127.0.0.1",
		port: 0,
	};
}

/** Deterministic fake probe: the posture of record for unit tests. */
const allowedProbe = async () => ({ state: "allowed" });

function tmpdir() {
	const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "porch-rt-"));
	return {
		config: freshConfig(tmp),
		cleanup: () => fs.rmSync(tmp, { recursive: true, force: true }),
	};
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test("the runtime starts the supervisor idle and serves the status page", async () => {
	const { config, cleanup } = tmpdir();
	try {
		const rt = await startPlatformRuntime({ config, version: "0.5.3", halStatus: { platform: "darwin", decode: "videotoolbox" }, log: () => {}, localNetworkProbe: allowedProbe });
		const port = rt.status.server.address().port;
		try {
			const res = await fetch(`http://127.0.0.1:${port}/health`);
			const agg = await res.json();
			assert.equal(agg.status, "healthy");
			assert.equal(agg.awaitingConfiguration, true);
			assert.deepEqual(agg.platform, { platform: "darwin", decode: "videotoolbox" });
			// The stream manager composes FIRST and states its idle row —
			// zero cameras configured, zero live sources (PORCH-154).
			assert.ok(rt.manager, "the runtime composes the stream manager");
			assert.equal(typeof rt.managerStarted?.then, "function", "the manager's started promise is recorded");
			assert.deepEqual(agg.stream, {
				state: "idle",
				detail: "0 camera(s), 0 live source(s)",
				cameraCount: 0,
				cameraNames: [],
				liveSources: 0,
			});
			assert.deepEqual(agg.services.find((s) => s.name === "stream"), { name: "stream", healthy: true, state: "ok", detail: "0 camera(s), 0 live source(s)" });
			assert.equal(rt.aggregate().status, "healthy");
			assert.ok(fs.existsSync(config.storageRoot)); // storageRoot created by the supervisor
		} finally {
			await rt.stop();
		}
	} finally {
		cleanup();
	}
});

test("stopping the runtime closes the status server, the supervisor, and the stream manager", async () => {
	const { config, cleanup } = tmpdir();
	try {
		const rt = await startPlatformRuntime({ config, log: () => {}, localNetworkProbe: allowedProbe });
		const port = rt.status.server.address().port;
		await rt.stop();
		await assert.rejects(() => fetch(`http://127.0.0.1:${port}/health`));
		assert.equal(rt.supervisor.stopping, true);
		assert.equal(rt.manager.stopping, true, "the stream manager stops with the runtime");
	} finally {
		cleanup();
	}
});

test("a denied Local Network probe is stated with the explained row, never silent (PORCH-152)", async () => {
	const { config, cleanup } = tmpdir();
	try {
		const rt = await startPlatformRuntime({
			config,
			log: () => {},
			localNetworkProbe: async () => ({ state: "denied", reason: "simulated TCC denial — socket send refused" }),
		});
		try {
			const agg = rt.aggregate();
			assert.equal(agg.localNetwork.state, "denied");
			assert.equal(agg.localNetwork.reason, "simulated TCC denial — socket send refused");
			assert.match(agg.localNetwork.note, /Local Network permission denied/);
			assert.match(agg.localNetwork.note, /System Settings/);
			const row = agg.services.find((s) => s.name === "local-network");
			assert.equal(row.healthy, false);
			assert.match(row.detail, /silently dropped/);
			assert.match(row.detail, /System Settings/);
			assert.equal(agg.status, "degraded");
		} finally {
			await rt.stop();
		}
	} finally {
		cleanup();
	}
});

test("a throwing probe never crashes the runtime — the state is stated", async () => {
	const { config, cleanup } = tmpdir();
	try {
		const rt = await startPlatformRuntime({
			config,
			log: () => {},
			localNetworkProbe: async () => {
				throw new Error("probe boom");
			},
		});
		try {
			const agg = rt.aggregate();
			assert.equal(agg.localNetwork.state, "unknown");
			assert.match(agg.localNetwork.reason, /probe boom/);
			assert.equal(agg.status, "healthy", "an unknown posture stays neutral");
		} finally {
			await rt.stop();
		}
	} finally {
		cleanup();
	}
});

test("the probe interval re-probes and the latest posture feeds the aggregate; stop clears the interval", async () => {
	const { config, cleanup } = tmpdir();
	let calls = 0;
	const rt = await startPlatformRuntime({
		config,
		log: () => {},
		localNetworkProbe: async () => {
			calls += 1;
			return calls === 1 ? { state: "denied", reason: "first probe denied" } : { state: "allowed" };
		},
		localNetworkProbeMs: 25,
	});
	try {
		assert.equal(rt.aggregate().localNetwork.state, "denied", "the boot probe result is stated before the first interval tick");
		const deadline = Date.now() + 2000;
		while (calls < 2 && Date.now() < deadline) await sleep(10);
		assert.ok(calls >= 2, `the probe interval must fire (calls=${calls})`);
		assert.equal(rt.aggregate().localNetwork.state, "allowed");
		assert.equal(rt.aggregate().status, "healthy");
		await rt.stop();
		const afterStop = calls;
		await sleep(80);
		assert.equal(calls, afterStop, "stop() must clear the probe interval");
	} finally {
		await rt.stop(); // a second stop (double signal, teardown) must also resolve, not stall
		cleanup();
	}
});

test("platformPosture states the host posture, and never advertises what does not exist", () => {
	const posture = platformPosture();
	assert.ok("platform" in posture);
	if (process.platform === "darwin") {
		assert.equal(posture.decode, "videotoolbox");
		assert.deepEqual(posture.inference, ["coreml", "cpu"]);
	}
});

test("the transcription consumer composes onto the manager's pcm lane with the retention cascade in the same sweep (PORCH-155)", async () => {
	const { config, cleanup } = tmpdir();
	try {
		const rt = await startPlatformRuntime({
			config,
			log: () => {},
			localNetworkProbe: allowedProbe,
			transcriptionResolver: () => ({ name: "whisper-local:test", transcribe: async () => ({ text: null }), status: () => ({ state: "configured" }) }),
			transcriptionEnabledFor: () => ({ value: false, source: "base" }),
		});
		try {
			// The consumer of record exists and is wired to the manager's
			// in-process pcm lane — no second camera connection exists.
			assert.ok(rt.transcription, "the transcription service composed");
			assert.equal(typeof rt.transcription.submitRollingAudio, "function");
			// The retention index cascade rides the supervisor's sweep pass.
			assert.ok(rt.supervisor.retentionCascade, "the supervisor carries the retention cascade");
			assert.equal(typeof rt.supervisor.retentionCascade.dropRollingDates, "function");
			// Not-wired never hides: without a transcription opt the row states
			// unavailable; wired, the row renders its own posture.
			const agg = rt.aggregate();
			const row = agg.services.find((s) => s.name === "transcript");
			assert.equal(row.state, "ok");
			assert.match(row.detail, /transcribing whisper-local/);
		} finally {
			await rt.stop();
		}
	} finally {
		cleanup();
	}
});

test("with no transcription seams the status page states the plane is not wired (never silent)", async () => {
	const { config, cleanup } = tmpdir();
	try {
		const rt = await startPlatformRuntime({ config, log: () => {}, localNetworkProbe: allowedProbe });
		try {
			assert.equal(rt.transcription, null);
			assert.equal(rt.supervisor.retentionCascade, null);
			const row = rt.aggregate().services.find((s) => s.name === "transcript");
			assert.equal(row.healthy, false);
			assert.equal(row.state, "unavailable");
			assert.match(row.detail, /not wired/);
		} finally {
			await rt.stop();
		}
	} finally {
		cleanup();
	}
});
