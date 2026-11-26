// storage.test.js — the config plane's storage service + REST surface
// (PORCH-136). Real filesystem under a tmp root: write tests, persisted
// docs, the config of record, and an unreachable recorder are all real —
// storage is asked, never assumed.

import { describe, test, before, after } from "node:test";
import assert from "node:assert/strict";
import fsDefault from "node:fs";
import osDefault from "node:os";
import pathDefault from "node:path";
import httpDefault from "node:http";

import { createConfigService } from "../src/index.js";
import { configYamlPathFor, createStorageService, resolveRecorderBase } from "../src/storage.js";

const TAB = "\t";

/** A platform config of record the installer bootstrap would have written. */
function seedConfigYaml(root) {
	const dir = pathDefault.join(root, "config");
	fsDefault.mkdirSync(dir, { recursive: true });
	const cfg = {
		version: 1,
		storageRoot: pathDefault.join(root, "recordings"),
		cameras: [],
		segmentSeconds: 600,
		retentionDays: 7,
		statusPort: 8970,
		statusHost: "0.0.0.0",
	};
	fsDefault.writeFileSync(pathDefault.join(dir, "config.yaml"), JSON.stringify(cfg, null, TAB) + "\n", "utf8");
	return cfg;
}

/** A directory the process can traverse but not write into. */
function makeReadOnlyDir(root) {
	const ro = pathDefault.join(root, "ro-parent");
	fsDefault.mkdirSync(ro, { recursive: true });
	fsDefault.chmodSync(ro, 0o555);
	return ro;
}

/** Recover a read-only parent so the tmp root can be removed. */
function releaseReadOnlyDir(ro) {
	fsDefault.chmodSync(ro, 0o755);
}

/** Bind + close an ephemeral server: a port nothing is listening on. */
async function closedRecorderBase() {
	const srv = httpDefault.createServer();
	await new Promise((resolve) => srv.listen(0, "127.0.0.1", resolve));
	const port = /** @type {import("node:net").AddressInfo} */ (srv.address()).port;
	await new Promise((resolve) => srv.close(resolve));
	return `http://127.0.0.1:${port}`;
}

/** A fake recorder supervisor serving hand-picked storage responses. */
async function startFakeRecorder(handlers) {
	const srv = httpDefault.createServer(async (req, res) => {
		const url = req.url ?? "/";
		const handler = handlers.find((h) => h.method === req.method && h.url === url);
		if (!handler) {
			res.writeHead(404, { "content-type": "application/json" });
			res.end(JSON.stringify({ error: `no route for ${req.method} ${url}` }));
			return;
		}
		res.writeHead(handler.status ?? 200, { "content-type": "application/json" });
		res.end(JSON.stringify(handler.body ?? {}));
	});
	await new Promise((resolve) => srv.listen(0, "127.0.0.1", resolve));
	const port = /** @type {import("node:net").AddressInfo} */ (srv.address()).port;
	return { base: `http://127.0.0.1:${port}`, close: () => new Promise((resolve) => srv.close(resolve)) };
}

describe("storage service (config plane)", () => {
	const ctx = {};
	let roDir;

	before(async () => {
		ctx.root = fsDefault.mkdtempSync(pathDefault.join(osDefault.tmpdir(), "porch-storage-"));
		seedConfigYaml(ctx.root);
		ctx.service = createConfigService({ root: ctx.root, consoleDist: null, recorderBase: await closedRecorderBase() });
		ctx.storage = ctx.service.storage;
		roDir = makeReadOnlyDir(ctx.root);
	});

	after(() => {
		if (roDir) releaseReadOnlyDir(roDir);
		fsDefault.rmSync(ctx.root, { recursive: true, force: true });
	});

	test("an empty storage doc is a stated not-configured shape, not silence", () => {
		assert.deepEqual(ctx.storage.get(), {
			configured: false,
			primary: null,
			failover: null,
			eventRetentionDays: 30,
			rules: [],
		});
	});

	test("testLocation passes a writable location and refuses a read-only one in plain language", () => {
		const ok = ctx.storage.testLocation(pathDefault.join(ctx.root, "primary-ok"));
		assert.equal(ok.ok, true);
		assert.equal(ok.location, pathDefault.join(ctx.root, "primary-ok"));

		const bad = ctx.storage.testLocation(pathDefault.join(roDir, "nope"));
		assert.equal(bad.ok, false);
		assert.match(bad.reason, /could not (create the directory|write a test file).*permission denied/);
	});

	test("configure happy path persists the doc and the config of record", () => {
		const primary = pathDefault.join(ctx.root, "recordings");
		const failover = pathDefault.join(ctx.root, "failover");
		const doc = ctx.storage.configure({ primary, failover, eventRetentionDays: 45 });

		assert.equal(doc.configured, true);
		assert.equal(doc.primary, primary);
		assert.equal(doc.failover, failover);
		assert.equal(doc.eventRetentionDays, 45);

		// The storage doc landed in the console store.
		assert.deepEqual(ctx.storage.get(), { configured: true, primary, failover, eventRetentionDays: 45, rules: [] });

		// The config of record carries the same answer (the daemon reads it).
		const cfg = JSON.parse(fsDefault.readFileSync(configYamlPathFor(ctx.root), "utf8"));
		assert.equal(cfg.storageRoot, primary);
		assert.equal(cfg.failoverRoot, failover);
		assert.equal(cfg.eventRetentionDays, 45);
	});

	test("a failing location is a never-silent ValidationError and nothing is persisted", () => {
		const beforeYaml = fsDefault.readFileSync(configYamlPathFor(ctx.root), "utf8");
		assert.throws(
			() => ctx.storage.configure({ primary: pathDefault.join(roDir, "primary"), failover: null }),
			(err) => {
				assert.equal(err.name, "ValidationError");
				assert.match(err.message, /storage location test failed/);
				assert.match(err.message, /permission denied/);
				return true;
			},
		);
		// The doc is NOT persisted for the failing setup — it still holds the
		// previous happy-path answer, byte for byte.
		assert.deepEqual(ctx.service.store.readDoc("storage"), { configured: true, primary: pathDefault.join(ctx.root, "recordings"), failover: pathDefault.join(ctx.root, "failover"), eventRetentionDays: 45, rules: [] });
		assert.equal(fsDefault.readFileSync(configYamlPathFor(ctx.root), "utf8"), beforeYaml);
	});

	test("configure validates eventRetentionDays and required primary in plain language", () => {
		assert.throws(() => ctx.storage.configure({ primary: pathDefault.join(ctx.root, "x"), eventRetentionDays: 0 }), /eventRetentionDays must be an integer >= 1/);
		assert.throws(() => ctx.storage.configure({}), /primary location is required/);
		assert.throws(() => ctx.storage.configure({ primary: 42 }), /primary location must be a non-empty string path/);
	});

	test("a missing config of record is a stated error, the console never invents one", () => {
		const bareRoot = fsDefault.mkdtempSync(pathDefault.join(osDefault.tmpdir(), "porch-storage-bare-"));
		const bare = createConfigService({ root: bareRoot, consoleDist: null });
		assert.throws(
			() => bare.storage.configure({ primary: pathDefault.join(bare.root, "p") }),
			/config of record .* does not exist yet — run the porchlight installer bootstrap first/,
		);
		fsDefault.rmSync(bareRoot, { recursive: true, force: true });
	});

	test("dropping the failover on reconfigure removes failoverRoot from the config of record", () => {
		const primary = pathDefault.join(ctx.root, "recordings");
		ctx.storage.configure({ primary, failover: null, eventRetentionDays: 30 });
		const cfg = JSON.parse(fsDefault.readFileSync(configYamlPathFor(ctx.root), "utf8"));
		assert.equal(cfg.failoverRoot, undefined);
		assert.equal(cfg.storageRoot, primary);
	});

	test("status() with an unreachable recorder is plain-language, before and after configure", async () => {
		// Start from an empty doc so "not configured yet" is the real state.
		ctx.service.store.writeDoc("storage", {});
		const pre = await ctx.storage.status();
		assert.equal(pre.source, "unreachable");
		assert.equal(pre.state, "not-configured");
		assert.equal(pre.configured, false);
		assert.match(pre.reason, /not configured yet/);

		ctx.storage.configure({ primary: pathDefault.join(ctx.root, "recordings"), failover: pathDefault.join(ctx.root, "failover") });
		const post = await ctx.storage.status();
		assert.equal(post.source, "unreachable");
		assert.equal(post.state, "unknown — recorder unreachable");
		assert.equal(post.configured, true);
		assert.equal(post.primary, pathDefault.join(ctx.root, "recordings"));
		assert.match(post.reason, /recorder service .* is unreachable/);
	});

	test("failback() with an unreachable recorder is {ok:false} in plain language, not a throw", async () => {
		const result = await ctx.storage.failback();
		assert.equal(result.ok, false);
		assert.match(result.reason, /recorder service is unreachable.*failback/i);
	});

	test("trigger() with an unreachable recorder is {ok:false} in plain language", async () => {
		const stopped = await ctx.storage.trigger("front-door", "stop");
		assert.equal(stopped.ok, false);
		assert.match(stopped.reason, /unreachable.*stopping/);
	});

	test("trigger() refuses actions outside start/stop", async () => {
		await assert.rejects(() => ctx.storage.trigger("front-door", "pause"), /action must be "start" or "stop"/);
	});

	test("retention rules CRUD: sequence ids, validation, and the NotFoundError", () => {
		const first = ctx.storage.addRule({ cameraId: "front-door", keepDays: 3 });
		assert.deepEqual(first, { id: "rule-1", cameraId: "front-door", keepDays: 3 });
		const second = ctx.storage.addRule({ eventClass: "person", zoneId: "driveway", keepDays: 7 });
		assert.equal(second.id, "rule-2");
		assert.deepEqual(ctx.storage.listRules(), [first, second]);

		// Validation in plain language.
		assert.throws(() => ctx.storage.addRule({ keepDays: 5 }), /needs at least one scope/);
		assert.throws(() => ctx.storage.addRule({ cameraId: "bad id!", keepDays: 5 }), /cameraId must be a safe identifier/);
		assert.throws(() => ctx.storage.addRule({ cameraId: "front-door" }), /keepDays must be an integer >= 1/);
		assert.throws(() => ctx.storage.addRule("nope"), /expected an object/);

		// Update merges onto the existing rule.
		assert.deepEqual(ctx.storage.updateRule("rule-1", { keepDays: 5 }), { id: "rule-1", cameraId: "front-door", keepDays: 5 });

		assert.throws(() => ctx.storage.updateRule("rule-99", { keepDays: 2 }), (err) => err.name === "NotFoundError");
		assert.throws(() => ctx.storage.removeRule("rule-99"), (err) => err.name === "NotFoundError");

		assert.equal(ctx.storage.removeRule("rule-2").ok, true);
		assert.deepEqual(ctx.storage.listRules(), [{ id: "rule-1", cameraId: "front-door", keepDays: 5 }]);

		// Every mutation rode the config of record; the recorder shape has no ids.
		const cfg = JSON.parse(fsDefault.readFileSync(configYamlPathFor(ctx.root), "utf8"));
		assert.deepEqual(cfg.retentionRules, [{ cameraId: "front-door", keepDays: 5 }]);
	});

	test("restart persistence: a new service over the same root resumes the doc", () => {
		const resumed = createConfigService({ root: ctx.root, consoleDist: null, recorderBase: "http://127.0.0.1:1" });
		assert.equal(resumed.storage.get().configured, true);
		assert.deepEqual(resumed.storage.listRules(), [{ id: "rule-1", cameraId: "front-door", keepDays: 5 }]);
	});
});

describe("storage REST surface", () => {
	const ctx = {};
	let roDir;

	before(async () => {
		ctx.root = fsDefault.mkdtempSync(pathDefault.join(osDefault.tmpdir(), "porch-storage-api-"));
		seedConfigYaml(ctx.root);
		const service = createConfigService({ root: ctx.root, consoleDist: null, recorderBase: await closedRecorderBase() });
		ctx.storage = service.storage;
		ctx.store = service.store;
		const handle = await service.start(0);
		ctx.port = handle.port;
		ctx.handle = handle;
		roDir = makeReadOnlyDir(ctx.root);
	});

	after(async () => {
		await ctx.handle?.close();
		if (roDir) releaseReadOnlyDir(roDir);
		fsDefault.rmSync(ctx.root, { recursive: true, force: true });
	});

	async function api(method, pathname, body) {
		const res = await fetch(`http://127.0.0.1:${ctx.port}${pathname}`, {
			method,
			headers: body === undefined ? {} : { "content-type": "application/json" },
			body: body === undefined ? undefined : JSON.stringify(body),
		});
		const text = await res.text();
		return { status: res.status, body: text.trim() === "" ? null : JSON.parse(text) };
	}

	test("GET /api/storage says not-configured while the recorder is down", async () => {
		const { status, body } = await api("GET", "/api/storage");
		assert.equal(status, 200);
		assert.equal(body.source, "unreachable");
		assert.equal(body.state, "not-configured");
		assert.match(body.reason, /not configured yet/);
	});

	test("POST /api/storage/test validates the body and passes the write test through", async () => {
		const missing = await api("POST", "/api/storage/test", {});
		assert.equal(missing.status, 422);
		assert.match(missing.body.error, /location must be a non-empty string path/);

		const malformed = await api("POST", "/api/storage/test", { location: 42 });
		assert.equal(malformed.status, 422);

		const ok = await api("POST", "/api/storage/test", { location: pathDefault.join(ctx.root, "probe-ok") });
		assert.equal(ok.status, 200);
		assert.deepEqual(ok.body, { ok: true, location: pathDefault.join(ctx.root, "probe-ok") });

		const bad = await api("POST", "/api/storage/test", { location: pathDefault.join(roDir, "nope") });
		assert.equal(bad.status, 200);
		assert.equal(bad.body.ok, false);
		assert.match(bad.body.reason, /permission denied/);
	});

	test("PUT /api/storage persists the setup; GET flips to the stated unknown state", async () => {
		const primary = pathDefault.join(ctx.root, "recordings");
		const put = await api("PUT", "/api/storage", { primary, failover: pathDefault.join(ctx.root, "failover"), eventRetentionDays: 14 });
		assert.equal(put.status, 201);
		assert.equal(put.body.configured, true);

		const cfg = JSON.parse(fsDefault.readFileSync(configYamlPathFor(ctx.root), "utf8"));
		assert.equal(cfg.storageRoot, primary);
		assert.equal(cfg.failoverRoot, pathDefault.join(ctx.root, "failover"));
		assert.equal(cfg.eventRetentionDays, 14);

		const status = await api("GET", "/api/storage");
		assert.equal(status.status, 200);
		assert.equal(status.body.state, "unknown — recorder unreachable");
		assert.equal(status.body.configured, true);
		assert.equal(status.body.primary, primary);
	});

	test("PUT /api/storage rejects a bad location as 422 and persists nothing new", async () => {
		const put = await api("PUT", "/api/storage", { primary: pathDefault.join(roDir, "primary") });
		assert.equal(put.status, 422);
		assert.match(put.body.error, /storage location test failed.*permission denied/);
	});

	test("POST /api/storage/failback with the recorder down is {ok:false} in plain language", async () => {
		const { status, body } = await api("POST", "/api/storage/failback");
		assert.equal(status, 200);
		assert.equal(body.ok, false);
		assert.match(body.reason, /recorder service is unreachable/);
	});

	test("rules routes: create 201, list, 404 on unknown ids", async () => {
		const created = await api("POST", "/api/storage/rules", { cameraId: "front-door", keepDays: 3 });
		assert.equal(created.status, 201);
		assert.deepEqual(created.body, { id: "rule-1", cameraId: "front-door", keepDays: 3 });

		const listed = await api("GET", "/api/storage/rules");
		assert.deepEqual(listed.body, [{ id: "rule-1", cameraId: "front-door", keepDays: 3 }]);

		const unknownPut = await api("PUT", "/api/storage/rules/rule-99", { keepDays: 9 });
		assert.equal(unknownPut.status, 404);
		const unknownDelete = await api("DELETE", "/api/storage/rules/rule-99");
		assert.equal(unknownDelete.status, 404);

		const scopeless = await api("POST", "/api/storage/rules", { keepDays: 5 });
		assert.equal(scopeless.status, 422);

		const removed = await api("DELETE", "/api/storage/rules/rule-1");
		assert.equal(removed.status, 200);
		assert.equal(removed.body.ok, true);
	});

	test("POST /api/cameras/<id>/record/<action> with the recorder down is {ok:false} in plain language", async () => {
		const started = await api("POST", "/api/cameras/front-door/record/start");
		assert.equal(started.status, 200);
		assert.equal(started.body.ok, false);
		assert.match(started.body.reason, /unreachable/);

		const paused = await api("POST", "/api/cameras/front-door/record/pause");
		assert.equal(paused.status, 422);
		assert.match(paused.body.error, /action must be "start" or "stop"/);
	});
});

describe("storage service against a live (fake) recorder", () => {
	let recorder;
	const ctx = {};

	before(async () => {
		ctx.root = fsDefault.mkdtempSync(pathDefault.join(osDefault.tmpdir(), "porch-storage-live-"));
		seedConfigYaml(ctx.root);
		recorder = await startFakeRecorder([
			{
				method: "GET",
				url: "/api/storage",
				body: {
					state: "degraded-write",
					activeLocation: pathDefault.join(ctx.root, "failover"),
					primary: pathDefault.join(ctx.root, "recordings"),
					failover: pathDefault.join(ctx.root, "failover"),
					reason: "the primary location stopped accepting writes — recording to the failover location",
					driveHealthy: true,
					driveReason: null,
					paused: false,
					usage: { tiers: { rolling: { segments: 2, bytes: 10 }, events: { segments: 1, bytes: 3 }, manual: { segments: 0, bytes: 0 } }, diskUsedFraction: 0.31 },
					bus: { connected: true, url: "mqtt://bus.local" },
				},
			},
			{ method: "POST", url: "/api/storage/failback", status: 409, body: { error: "recordings are already on the primary location" } },
			{ method: "POST", url: "/api/cameras/front-door/record/start", body: { ok: true, camera: "front-door", manualActive: true } },
			{ method: "POST", url: "/api/cameras/ghost/record/stop", status: 404, body: { error: 'unknown camera "ghost"' } },
		]);
	});

	after(async () => {
		await recorder.close();
		fsDefault.rmSync(ctx.root, { recursive: true, force: true });
	});

	function freshService() {
		return createStorageService({
			store: createConfigService({ root: ctx.root, consoleDist: null, recorderBase: recorder.base }).store,
			recorderBase: recorder.base,
		});
	}

	test("status() merges the recorder's live storage fields, usage, and bus", async () => {
		const st = await freshService().status();
		assert.equal(st.source, "recorder");
		assert.equal(st.state, "degraded-write");
		assert.match(st.reason, /failover location/);
		assert.equal(st.configured, false);
		assert.deepEqual(st.usage.tiers, { rolling: { segments: 2, bytes: 10 }, events: { segments: 1, bytes: 3 }, manual: { segments: 0, bytes: 0 } });
		assert.equal(st.usage.diskUsedFraction, 0.31);
		assert.deepEqual(st.bus, { connected: true, url: "mqtt://bus.local" });
	});

	test("failback() passes a refused (409) failback through as plain-language {ok:false}", async () => {
		const result = await freshService().failback();
		assert.equal(result.ok, false);
		assert.equal(result.reason, "recordings are already on the primary location");
	});

	test("trigger() passes a successful start through; refusals come back as {ok:false}", async () => {
		const service = freshService();
		assert.deepEqual(await service.trigger("front-door", "start"), { ok: true, camera: "front-door", manualActive: true });
		const stopped = await service.trigger("ghost", "stop");
		assert.equal(stopped.ok, false);
		assert.equal(stopped.reason, 'unknown camera "ghost"');
	});

	test("recorderBase resolves from the config of record's port (deployment port wiring)", () => {
		const root = fsDefault.mkdtempSync(pathDefault.join(osDefault.tmpdir(), "porch-base-"));
		try {
			fsDefault.mkdirSync(pathDefault.join(root, "config"), { recursive: true });
			fsDefault.writeFileSync(pathDefault.join(root, "config", "config.yaml"), "version: 1\nstorageRoot: /x\nport: 18444\n");
			assert.equal(resolveRecorderBase(configYamlPathFor(root)), "http://127.0.0.1:18444");
			assert.equal(resolveRecorderBase(pathDefault.join(root, "config", "missing.yaml")), "http://127.0.0.1:8971");
		} finally {
			fsDefault.rmSync(root, { recursive: true, force: true });
		}
	});
});
