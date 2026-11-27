// compute.test.js — the engine compute posture (PORCH-152).
//
// Covers the stage/plan closed lists, the three-layer resolution with source
// visibility (built-in → setup → admin), never-silent status (unknown /
// failed states with reasons), the live re-point round trip through the
// publisher, the REST surface (list/detail/PUT/DELETE + 422 paths), the
// camera-view-token admin boundary, stream validation and the POST /cameras
// registration landing (platform config + console mirror + live fleet apply).

import { describe, test, before, after } from "node:test";
import assert from "node:assert/strict";
import fsDefault from "node:fs";
import osDefault from "node:os";
import pathDefault from "node:path";
import http from "node:http";

import { createComputeService, readPlatformConfig } from "../src/compute.js";
import { createConfigService } from "../src/index.js";
import { Store } from "../src/store.js";
import { Publisher } from "../src/publisher.js";
import { validateStreamUrl } from "../src/stream-validate.js";
import { registerStreamCamera } from "../src/engine-cameras.js";

function tmpRoot(prefix) {
	return fsDefault.mkdtempSync(pathDefault.join(osDefault.tmpdir(), prefix));
}

function writePlatformFile(root, doc) {
	fsDefault.mkdirSync(pathDefault.join(root, "config"), { recursive: true });
	fsDefault.writeFileSync(pathDefault.join(root, "config", "config.yaml"), JSON.stringify(doc, null, "\t") + "\n", "utf8");
}

function fakeProbe(answer) {
	return async (opts) => {
		fakeProbe.lastOpts = opts;
		return typeof answer === "function" ? answer(opts) : structuredClone(answer);
	};
}

describe("compute posture service (layer resolution + status + live re-point)", () => {
	test("six stages and three provider classes are the closed vocabularies", () => {
		assert.deepEqual([...STAGES_LIST], ["detection", "event-description", "audio-classification", "transcription", "overwatch-evaluation", "embedding"]);
		assert.deepEqual([...CLASSES_LIST], ["native-mlx", "openai-spec", "local-server"]);
	});

	test("all stages resolve to the built-in native plan with source built-in", () => {
		const svc = bootService(tmpRoot("porch-compute-"));
		for (const stage of STAGES_LIST) {
			const d = svc.detail(stage);
			assert.equal(d.source, "built-in");
			assert.equal(d.effective.providerClass, "native-mlx");
			assert.equal(d.effective.model, null);
			assert.equal(d.status.state, "unknown");
			assert.match(d.status.reason, /not reporting/);
			assert.deepEqual(d.providerClasses, ["native-mlx", "openai-spec", "local-server"]);
		}
	});

	test("setup layer: platform config of record compute.stages wins over built-in", () => {
		const root = tmpRoot("porch-compute-");
		writePlatformFile(root, {
			version: 1, storageRoot: `${root}/recordings`, cameras: [],
			compute: { stages: { transcription: { providerClass: "local-server", endpointRef: "secrets/lfm3" } } },
		});
		const svc = bootService(root);
		const d = svc.detail("transcription");
		assert.equal(d.source, "setup");
		assert.deepEqual(d.effective, { providerClass: "local-server", model: null, endpointRef: "secrets/lfm3" });
		assert.equal(d.layers.builtIn.providerClass, "native-mlx");
	});

	test("admin layer wins over setup and built-in; layers stay inspectable", () => {
		const root = tmpRoot("porch-compute-");
		writePlatformFile(root, {
			version: 1, storageRoot: `${root}/recordings`, cameras: [],
			compute: { stages: { detection: { providerClass: "native-mlx", model: "yolo11n" } } },
		});
		const svc = bootService(root);
		svc.repoint("detection", { providerClass: "openai-spec", endpointRef: "secrets/vision", model: "gpt-6-vision" });
		const d = svc.detail("detection");
		assert.equal(d.source, "admin");
		assert.deepEqual(d.effective, { providerClass: "openai-spec", model: "gpt-6-vision", endpointRef: "secrets/vision" });
		assert.deepEqual(d.layers.setup, { providerClass: "native-mlx", model: "yolo11n" });
	});

	test("a malformed stored layer never resolves — it is named, never guessed", () => {
		const root = tmpRoot("porch-compute-");
		writePlatformFile(root, {
			version: 1, storageRoot: `${root}/recordings`, cameras: [],
			compute: { stages: { detection: { providerClass: "warp-drive", model: 7 } } },
		});
		const svc = bootService(root);
		const d = svc.detail("detection");
		assert.equal(d.source, "built-in");
		assert.equal(d.layerIssues.length, 1);
		assert.match(d.layerIssues[0], /setup layer value for "detection"/);
	});

	test("repoint validates the closed stage list and the plan shape", () => {
		const svc = bootService(tmpRoot("porch-compute-"));
		assert.throws(() => svc.repoint("not-a-stage", { providerClass: "native-mlx" }), /unknown stage/);
		assert.throws(() => svc.repoint("detection", { providerClass: "warp-drive" }), /providerClass must be one of/);
		assert.throws(() => svc.repoint("detection", { providerClass: "openai-spec" }), /requires an endpointRef/);
		assert.throws(() => svc.repoint("detection", { providerClass: "native-mlx", endpointRef: "secrets/x" }), /endpointRef is not a native field/);
		assert.throws(() => svc.repoint("detection", { providerClass: "native-mlx", model: "  " }), /model must be a non-empty string or null/);
	});

	test("repoint publishes the change; reset removes the admin layer (base preserved)", () => {
		const root = tmpRoot("porch-compute-");
		const store = new Store(root);
		const publisher = new Publisher();
		/** @type {unknown[]} */
		const events = [];
		publisher.subscribe((ev) => {
			if (ev?.type === "compute-repoint") events.push(ev);
		});
		writePlatformFile(root, {
			version: 1, storageRoot: `${root}/recordings`, cameras: [],
			compute: { stages: { embedding: { providerClass: "native-mlx", model: "qwen3-embedding:8b" } } },
		});
		const svc = createComputeService({ store, publisher, root, fs: fsDefault });

		svc.repoint("embedding", { providerClass: "local-server", endpointRef: "secrets/lfm3" });
		assert.equal(events.length, 1);
		assert.equal(events[0].type, "compute-repoint");
		assert.equal(events[0].stage, "embedding");
		assert.deepEqual(events[0].value, { providerClass: "local-server", model: null, endpointRef: "secrets/lfm3" });
		assert.equal(svc.detail("embedding").source, "admin");

		// Reset: the admin entry is gone, the setup layer wins; base untouched.
		svc.reset("embedding");
		assert.equal(events.length, 2);
		assert.equal(events[1].source, "setup");
		assert.deepEqual(events[1].value, { providerClass: "native-mlx", model: "qwen3-embedding:8b" });
		assert.equal(svc.detail("embedding").source, "setup");
		// The platform config of record still carries the setup default.
		assert.deepEqual(readPlatformConfig(`${root}/config/config.yaml`, { fs: fsDefault }).compute.stages.embedding, { providerClass: "native-mlx", model: "qwen3-embedding:8b" });
	});

	test("never-silent status: reporters register, throw, and normalize", () => {
		const svc = bootService(tmpRoot("porch-compute-"));
		svc.registerStatus("detection", () => ({
			state: "cpu", providerClass: "native-mlx", model: "yolo11n", executionTarget: "cpu", reason: "coreml EP unavailable",
		}));
		const cpu = svc.statusOf("detection");
		assert.equal(cpu.stage, "detection");
		assert.equal(cpu.state, "cpu");
		assert.equal(cpu.providerClass, "native-mlx");
		assert.equal(cpu.model, "yolo11n");
		assert.equal(cpu.executionTarget, "cpu");
		assert.equal(cpu.reason, "coreml EP unavailable");
		assert.match(cpu.updatedAt, /^\d{4}-\d{2}-\d{2}T/);
		svc.registerStatus("embedding", () => { throw new Error("embedder socket refused"); });
		const failed = svc.statusOf("embedding");
		assert.equal(failed.state, "failed");
		assert.equal(failed.reason, "embedder socket refused");
		svc.registerStatus("transcription", () => ({ state: "not-a-state" }));
		const normalized = svc.statusOf("transcription");
		assert.equal(normalized.state, "unknown");
		assert.match(normalized.reason, /unknown state "not-a-state"/);
		assert.throws(() => svc.registerStatus("nope", () => ({})), /unknown stage/);
	});
});

describe("compute REST surface + camera seams", () => {
	const ctx = {};
	const events = [];

	async function api(method, pathname, body, headers = {}) {
		const res = await fetch(`http://127.0.0.1:${ctx.port}${pathname}`, {
			method,
			headers: { ...(body === undefined ? {} : { "content-type": "application/json" }), ...headers },
			body: body === undefined ? undefined : JSON.stringify(body),
		});
		const text = await res.text();
		return { status: res.status, body: text.trim() === "" ? null : JSON.parse(text) };
	}

	before(async () => {
		const root = tmpRoot("porch-server-");
		writePlatformFile(root, { version: 1, storageRoot: `${root}/recordings`, cameras: [], ffprobePath: "ffprobe-fake" });
		const service = createConfigService({ root, consoleDist: null, probeImpl: fakeProbe({ ok: true, aspect: { width: 1920, height: 1080 }, audio: true, codec: "h264" }) });
		service.publisher.subscribe((ev) => {
			if (ev?.type === "compute-repoint") events.push(ev);
		});
		const handle = await service.start(0);
		ctx.root = root;
		ctx.port = handle.port;
		ctx.handle = handle;
		ctx.service = service;
	});

	after(async () => {
		await ctx.handle?.close();
		if (ctx.root) fsDefault.rmSync(ctx.root, { recursive: true, force: true });
	});

	test("GET /api/compute/stages lists every stage with status and classes", async () => {
		const { status, body } = await api("GET", "/api/compute/stages");
		assert.equal(status, 200);
		assert.equal(body.stages.length, 6);
		for (const stage of body.stages) {
			assert.ok(STAGES_LIST.includes(stage.stage));
			assert.equal(stage.status.state, "unknown");
			assert.deepEqual(stage.providerClasses, ["native-mlx", "openai-spec", "local-server"]);
		}
	});

	test("PUT re-points live and DELETE restores the layered default", async () => {
		const put = await api("PUT", "/api/compute/stages/event-description", { providerClass: "local-server", endpointRef: "secrets/lfm3", model: "lfm3" });
		assert.equal(put.status, 200);
		assert.equal(put.body.source, "admin");
		assert.deepEqual(events.at(-1), { type: "compute-repoint", stage: "event-description", value: put.body.effective, source: "admin" });

		const bad = await api("PUT", "/api/compute/stages/audio-classification", { providerClass: "openai-spec" });
		assert.equal(bad.status, 422);
		assert.match(bad.body.error, /requires an endpointRef/);

		const unknown = await api("PUT", "/api/compute/stages/transcribe", { providerClass: "native-mlx" });
		assert.equal(unknown.status, 422);
		assert.match(unknown.body.error, /unknown stage/);

		const del = await api("DELETE", "/api/compute/stages/event-description");
		assert.equal(del.status, 200);
		assert.equal(del.body.source, "built-in");
		assert.deepEqual(events.at(-1).source, "built-in");
	});

	test("the camera-view token family never carries admin-plane access", async () => {
		const refused = await api("GET", "/api/compute/stages", undefined, { authorization: "peng1.eyJ2IjoxfQ.sig" });
		assert.equal(refused.status, 403);
		assert.match(refused.body.error, /camera-view sessions never carry NVR\/admin access/);
		const refusedWrite = await api("PUT", "/api/compute/stages/detection", { providerClass: "native-mlx" }, { authorization: "peng1.x.y" });
		assert.equal(refusedWrite.status, 403);
	});

	test("POST /api/cameras/validate probes the stream in plain language", async () => {
		const ok = await api("POST", "/api/cameras/validate", { url: "rtsp://cam.local/stream" });
		assert.equal(ok.status, 200);
		assert.deepEqual(ok.body, { ok: true, aspect: { width: 1920, height: 1080 }, audio: true, codec: "h264" });
		const bad = await api("POST", "/api/cameras/validate", {});
		assert.equal(bad.status, 422);
	});

	test("POST /cameras registers into the platform config + console mirror and applies the fleet live", async () => {
		// A stand-in supervisor for the fleet apply.
		/** @type {any[]} */
		const appliedFleets = [];
		const supervisor = http.createServer((req, res) => {
			let raw = "";
			req.on("data", (c) => { raw += c; });
			req.on("end", () => {
				if (req.url === "/api/cameras/apply" && req.method === "POST") {
					appliedFleets.push(JSON.parse(raw).cameras);
					res.writeHead(200, { "content-type": "application/json" });
					res.end(JSON.stringify({ ok: true, started: ["cam-1"], stopped: [], kept: 0 }));
					return;
				}
				res.writeHead(404, { "content-type": "application/json" });
				res.end("{}");
			});
		});
		await new Promise((r) => supervisor.listen(0, "127.0.0.1", r));
		const supervisorBase = `http://127.0.0.1:${supervisor.address().port}`;

		const answer = await registerStreamCamera({
			root: ctx.root,
			url: "rtsp://front-door.local/stream1",
			cameras: ctx.service.cameras,
			recorderBase: supervisorBase,
			probeImpl: fakeProbe({ ok: true, aspect: { width: 2304, height: 1296 }, audio: false }),
		});
		assert.equal(answer.ok, true);
		assert.match(answer.cameraId, /^cam-[0-9a-f]{8}$/);
		assert.deepEqual(answer.aspect, { width: 2304, height: 1296 });
		assert.equal(answer.audio, false);
		assert.deepEqual(answer.recording, { ok: true });
		// The recorder contract-validated fleet reached the supervisor.
		assert.equal(appliedFleets.length, 1);
		assert.equal(appliedFleets[0][0].name, answer.cameraId);
		assert.equal(appliedFleets[0][0].source.url, "rtsp://front-door.local/stream1");
		// The platform config of record now carries the camera.
		const platform = readPlatformConfig(`${ctx.root}/config/config.yaml`, { fs: fsDefault });
		assert.equal(platform.cameras.length, 1);
		assert.equal(platform.cameras[0].name, answer.cameraId);
		// The console registry mirrors the same id (one camera id of record).
		assert.deepEqual(ctx.service.cameras.get(answer.cameraId), { id: answer.cameraId, name: answer.cameraId, width: 2304, height: 1296 });

		// Duplicate URL: refused in plain language.
		const dup = await registerStreamCamera({
			root: ctx.root, url: "rtsp://front-door.local/stream1", cameras: ctx.service.cameras, recorderBase: supervisorBase, probeImpl: fakeProbe({ ok: true, aspect: { width: 1, height: 1 }, audio: false }),
		});
		assert.equal(dup.ok, false);
		assert.match(dup.reason, /already registered/);

		// Probe failure: the reason travels verbatim, nothing registers.
		const probeFail = await registerStreamCamera({
			root: ctx.root, url: "rtsp://garage.local/stream", cameras: ctx.service.cameras, recorderBase: supervisorBase, probeImpl: fakeProbe({ ok: false, reason: "the camera didn't answer within 6000ms — check the address and the camera's reachability" }),
		});
		assert.equal(probeFail.ok, false);
		assert.match(probeFail.reason, /didn't answer/);

		// Supervisor unreachable: the recording gap is named, never faked.
		const noSupervisor = await registerStreamCamera({
			root: ctx.root, url: "rtsp://side-yard.local/stream", cameras: ctx.service.cameras, recorderBase: "http://127.0.0.1:1", probeImpl: fakeProbe({ ok: true, aspect: { width: 2, height: 2 }, audio: false }),
		});
		assert.equal(noSupervisor.ok, true);
		assert.equal(noSupervisor.recording.ok, false);
		assert.match(noSupervisor.recording.reason, /isn't reachable/);

		supervisor.close();
	});

	test("the hub-facing health seams answer from the supervisor and the compute plane", async () => {
		// Fake supervisor: health + storage planes.
		const supervisor = http.createServer((req, res) => {
			if (req.url === "/health") {
				res.writeHead(200, { "content-type": "application/json" });
				res.end(JSON.stringify({ health: "ok", stopping: false, cameras: [{ name: "cam-live", state: "recording" }] }));
				return;
			}
			if (req.url === "/api/storage") {
				res.writeHead(200, { "content-type": "application/json" });
				res.end(JSON.stringify({ state: "primary", activeLocation: "/Volumes/recordings", paused: false }));
				return;
			}
			res.writeHead(404);
			res.end("{}");
		});
		await new Promise((r) => supervisor.listen(0, "127.0.0.1", r));
		// Rebind a service against the fake supervisor base.
		const root = tmpRoot("porch-seam-");
		writePlatformFile(root, { version: 1, storageRoot: `${root}/recordings`, cameras: [] });
		const service = createConfigService({ root, consoleDist: null, recorderBase: `http://127.0.0.1:${supervisor.address().port}`, probeImpl: fakeProbe({ ok: true, aspect: { width: 2, height: 2 }, audio: false }) });
		const handle = await service.start(0);

		const serviceHealth = await fetch(`http://127.0.0.1:${handle.port}/service`).then((r) => r.json());
		assert.deepEqual(serviceHealth, { state: "ok", detail: "recording 1 camera(s)" });

		const storage = await fetch(`http://127.0.0.1:${handle.port}/storage`).then((r) => r.json());
		assert.deepEqual(storage, { state: "primary", detail: "recording to /Volumes/recordings" });

		const camHealth = await fetch(`http://127.0.0.1:${handle.port}/cameras/cam-live`).then((r) => r.json());
		assert.deepEqual(camHealth.recording, { state: "recording", detail: null });
		assert.equal(camHealth.playback.state, "unavailable");
		assert.match(camHealth.playback.detail, /stream manager \(PORCH-154\)/);
		assert.ok("state" in camHealth.detection);
		// The audio plane (PORCH-153): the knob audioDetectionEnabled is off
		// by default, so a camera states its disabled plane — even though the
		// audio-classification stage's compute status is an independent state.
		assert.deepEqual(camHealth.audio, { state: "disabled", detail: null });

		// With audio detection enabled for the camera, the plane reports the
		// audio stage's never-silent posture: unregistered reporter →
		// unavailable with the stated reason, no silent blank.
		await fetch(`http://127.0.0.1:${handle.port}/api/config/base`, {
			method: "PUT",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ "cam-live": { audioDetectionEnabled: true } }),
		});
		const enabledHealth = await fetch(`http://127.0.0.1:${handle.port}/cameras/cam-live`).then((r) => r.json());
		assert.equal(enabledHealth.audio.state, "unavailable");
		assert.match(String(enabledHealth.audio.detail), /not reporting — service wiring pending/, "the stage's own reason rides the plane");
		// A failed audio stage (the consumer-loss state) renders degraded WITH
		// its explained reason — never a silent degradation.
		service.compute.registerStatus("audio-classification", () => ({ state: "failed", providerClass: null, model: null, executionTarget: null, reason: "audio event analysis stopped (consumer stopped) — sounds no longer raise camera events; recording and visual detection continue." }));
		const failedHealth = await fetch(`http://127.0.0.1:${handle.port}/cameras/cam-live`).then((r) => r.json());
		assert.equal(failedHealth.audio.state, "degraded");
		assert.match(String(failedHealth.audio.detail), /audio event analysis stopped \(consumer stopped\)/);
		assert.match(String(failedHealth.audio.detail), /recording and visual detection continue\.$/);

		const unknown = await fetch(`http://127.0.0.1:${handle.port}/cameras/nope`);
		assert.equal(unknown.status, 404);

		handle.close();
		supervisor.close();
	});
});

describe("stream validation probe", () => {
	test("URL sanity answers in plain language before any process spawns", async () => {
		const noUrl = await validateStreamUrl({ url: "   " });
		assert.equal(noUrl.ok, false);
		assert.match(noUrl.reason, /stream URL is required/);
		const notUrl = await validateStreamUrl({ url: "not a url at all" });
		assert.equal(notUrl.ok, false);
		assert.match(notUrl.reason, /isn't a stream URL/);
	});

	test("the real ffprobe binary answers or names its absence", async () => {
		const answer = await validateStreamUrl({ url: "rtsp://127.0.0.1:9/nope", timeoutMs: 1500, ffprobePath: "ffprobe-missing-xyz" });
		assert.equal(answer.ok, false);
		assert.ok(answer.reason.length > 0);
	});
});

// The closed vocabularies re-read from the module under test (single copies).
import { STAGES as STAGES_LIST, PROVIDER_CLASSES as CLASSES_LIST } from "../src/compute.js";

/** Boot a compute service on a fresh tmp store; root drives the setup layer. */
function bootService(root) {
	return createComputeService({ store: new Store(root), publisher: new Publisher(), root, fs: fsDefault });
}
