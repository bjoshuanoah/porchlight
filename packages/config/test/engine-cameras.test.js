// engine-cameras.test.js — the registration landing's stream-manager half
// (PORCH-154): the dims of record ride the platform config source, and the
// fleet is applied to BOTH plans of record (recorder + stream manager) — a
// manager outage is named on the answer, never faked, and never blocks the
// recorder's own apply.

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import fsDefault from "node:fs";
import osDefault from "node:os";
import pathDefault from "node:path";

import { registerStreamCamera } from "../src/engine-cameras.js";
import { readPlatformConfig } from "../src/compute.js";

function tmpRoot(prefix) {
	return fsDefault.mkdtempSync(pathDefault.join(osDefault.tmpdir(), prefix));
}

function writePlatformFile(root, doc) {
	fsDefault.mkdirSync(pathDefault.join(root, "config"), { recursive: true });
	fsDefault.writeFileSync(pathDefault.join(root, "config", "config.yaml"), JSON.stringify(doc, null, "\t") + "\n", "utf8");
}

const fakeProbe = async () => ({ ok: true, aspect: { width: 2304, height: 1296 }, audio: false });

/** Fake console registry: upsert only needs to exist. */
function fakeCameras() {
	const rows = new Map();
	return {
		upsert: (id, row) => {
			rows.set(id, row);
			return { ...row, id };
		},
		get: (id) => rows.get(id) ?? null,
		rows,
	};
}

/**
 * A fake fetch that applies per-URL behavior and records every call; a URL
 * absent from the plan behaves like a refused connection (nothing serves it).
 * @param {Record<string, { status: number } | { throw: Error }>} plan
 */
function fakeFetch(plan) {
	/** @type {{ url: string, body: any }[]} */
	const calls = [];
	const impl = async (url, init) => {
		const behavior = plan[url];
		const body = init?.body ? JSON.parse(String(init.body)) : null;
		calls.push({ url, body });
		if (!behavior) throw new Error(`connect ECONNREFUSED ${url}`);
		if ("throw" in behavior) throw behavior.throw;
		return /** @type {any} */ ({ ok: (behavior.status) >= 200 && (behavior.status) < 300, status: behavior.status });
	};
	return { calls, impl: /** @type {typeof fetch} */ (/** @type {any} */ (impl)) };
}

const RECORDER_URL = "http://127.0.0.1:8971/api/cameras/apply";
const MANAGER_URL = "http://127.0.0.1:8972/api/cameras/apply";

describe("registerStreamCamera — dims of record + dual fleet apply", () => {
	test("the probed aspect lands as source.width/height in the platform config of record", async () => {
		const root = tmpRoot("porch-cam-dims-");
		writePlatformFile(root, { version: 1, storageRoot: `${root}/recordings`, cameras: [] });
		try {
			const answer = await registerStreamCamera({
				root,
				url: "rtsp://front-door.local/stream1",
				cameras: fakeCameras(),
				fetchImpl: fakeFetch({ [RECORDER_URL]: { status: 200 }, [MANAGER_URL]: { status: 200 } }).impl,
				probeImpl: fakeProbe,
			});
			assert.equal(answer.ok, true);
			const platform = readPlatformConfig(`${root}/config/config.yaml`, { fs: fsDefault });
			assert.equal(platform.cameras.length, 1);
			assert.equal(platform.cameras[0].name, answer.cameraId);
			assert.deepEqual(platform.cameras[0].source, { url: "rtsp://front-door.local/stream1", width: 2304, height: 1296 });
		} finally {
			fsDefault.rmSync(root, { recursive: true, force: true });
		}
	});

	test("the fleet is applied to the recorder AND the stream manager, both carries the dims", async () => {
		const root = tmpRoot("porch-cam-dual-");
		writePlatformFile(root, { version: 1, storageRoot: `${root}/recordings`, cameras: [] });
		try {
			const fetcher = fakeFetch({ [RECORDER_URL]: { status: 200 }, [MANAGER_URL]: { status: 200 } });
			const answer = await registerStreamCamera({
				root,
				url: "rtsp://front-door.local/stream1",
				cameras: fakeCameras(),
				recorderBase: "http://127.0.0.1:8971",
				streamBase: "http://127.0.0.1:8972",
				fetchImpl: fetcher.impl,
				probeImpl: fakeProbe,
			});
			assert.equal(answer.ok, true);
			assert.deepEqual(answer.recording, { ok: true });
			assert.deepEqual(answer.streaming, { ok: true });
			assert.deepEqual(fetcher.calls.map((c) => c.url), [RECORDER_URL, MANAGER_URL]);
			// The SAME validated fleet reached both plans of record, row with dims.
			assert.deepEqual(fetcher.calls[0].body.cameras[0].source, { url: "rtsp://front-door.local/stream1", width: 2304, height: 1296 });
			assert.deepEqual(fetcher.calls[0].body, fetcher.calls[1].body);
		} finally {
			fsDefault.rmSync(root, { recursive: true, force: true });
		}
	});

	test("the manager refusing the fleet (422) is named on the answer — recording stays ok", async () => {
		const root = tmpRoot("porch-cam-422-");
		writePlatformFile(root, { version: 1, storageRoot: `${root}/recordings`, cameras: [] });
		try {
			const answer = await registerStreamCamera({
				root,
				url: "rtsp://front-door.local/stream1",
				cameras: fakeCameras(),
				fetchImpl: fakeFetch({ [RECORDER_URL]: { status: 200 }, [MANAGER_URL]: { status: 422 } }).impl,
				probeImpl: fakeProbe,
			});
			assert.equal(answer.ok, true);
			assert.deepEqual(answer.recording, { ok: true });
			assert.equal(answer.streaming.ok, false);
			assert.equal(answer.streaming.reason, "the stream manager refused the fleet update (422)");
		} finally {
			fsDefault.rmSync(root, { recursive: true, force: true });
		}
	});

	test("a manager outage is named, never faked — recording still lands", async () => {
		const root = tmpRoot("porch-cam-outage-");
		writePlatformFile(root, { version: 1, storageRoot: `${root}/recordings`, cameras: [] });
		try {
			const answer = await registerStreamCamera({
				root,
				url: "rtsp://front-door.local/stream1",
				cameras: fakeCameras(),
				// The manager default port is served by nobody here.
				fetchImpl: fakeFetch({ [RECORDER_URL]: { status: 200 } }).impl,
				probeImpl: fakeProbe,
			});
			assert.equal(answer.ok, true);
			assert.deepEqual(answer.recording, { ok: true });
			assert.equal(answer.streaming.ok, false);
			assert.equal(answer.streaming.reason, "the stream manager isn't reachable — serving starts when it is (boot reads the same config of record)");
		} finally {
			fsDefault.rmSync(root, { recursive: true, force: true });
		}
	});

	test("a recorder apply failure still hard-fails exactly as before — the manager apply is independent of it", async () => {
		const root = tmpRoot("porch-cam-recfail-");
		writePlatformFile(root, { version: 1, storageRoot: `${root}/recordings`, cameras: [] });
		try {
			const answer = await registerStreamCamera({
				root,
				url: "rtsp://front-door.local/stream1",
				cameras: fakeCameras(),
				recorderBase: "http://127.0.0.1:8971",
				fetchImpl: fakeFetch({ [RECORDER_URL]: { status: 422 } }).impl,
				probeImpl: fakeProbe,
			});
			assert.equal(answer.ok, true);
			assert.equal(answer.recording.ok, false);
			assert.equal(answer.recording.reason, "the recorder refused the fleet update (422)");
		} finally {
			fsDefault.rmSync(root, { recursive: true, force: true });
		}
	});
});
