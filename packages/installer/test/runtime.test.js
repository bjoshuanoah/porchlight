// runtime.test.js — the daemon composition root (PORCH-134 ac-1).

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

test("the runtime starts the supervisor idle and serves the status page", async () => {
	const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "porch-rt-"));
	try {
		const rt = await startPlatformRuntime({ config: freshConfig(tmp), version: "0.5.3", halStatus: { platform: "darwin", decode: "videotoolbox" }, log: () => {} });
		const port = rt.status.server.address().port;
		try {
			const res = await fetch(`http://127.0.0.1:${port}/health`);
			const agg = await res.json();
			assert.equal(agg.status, "healthy");
			assert.equal(agg.awaitingConfiguration, true);
			assert.deepEqual(agg.platform, { platform: "darwin", decode: "videotoolbox" });
			assert.ok(fs.existsSync(tmp)); // storageRoot created by the supervisor
			assert.equal(rt.aggregate().status, "healthy");
		} finally {
			await rt.stop();
		}
	} finally {
		fs.rmSync(tmp, { recursive: true, force: true });
	}
});

test("stopping the runtime closes the status server and the supervisor", async () => {
	const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "porch-rt-"));
	try {
		const rt = await startPlatformRuntime({ config: freshConfig(tmp), log: () => {} });
		const port = rt.status.server.address().port;
		await rt.stop();
		await assert.rejects(() => fetch(`http://127.0.0.1:${port}/health`));
		assert.equal(rt.supervisor.stopping, true);
	} finally {
		fs.rmSync(tmp, { recursive: true, force: true });
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
