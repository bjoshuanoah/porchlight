// transcripts.test.js — the transcription plane wired into the config
// server (PORCH-155). A REAL @porchlight/transcript TranscriptionService is
// injected as the `transcription` part of createConfigService and exercised
// through the actual HTTP surface on an ephemeral port (the boot discipline
// of server.test.js): the method doc of record PUT/GET, per-camera
// inspection with the winning layer, the never-silent status, the stored
// records + cascade audit lines, and the plain-language refusals (422s from
// the plane's own validation, the unwired-embedder search refusal, and the
// 503 the config server states when the engine composition didn't wire the
// plane at all).

import { describe, test, before, after } from "node:test";
import assert from "node:assert/strict";
import fsDefault from "node:fs";
import osDefault from "node:os";
import pathDefault from "node:path";

import { createConfigService } from "../src/index.js";
import {
  TranscriptionService,
  TranscriptStore,
  LocalVectorStore,
  createTranscriptRoutes,
} from "@porchlight/transcript";

describe("config server transcription plane wiring", () => {
	const ctx = {};

	async function api(method, pathname, body) {
		const res = await fetch(`http://127.0.0.1:${ctx.port}${pathname}`, {
			method,
			headers: body === undefined ? {} : { "content-type": "application/json" },
			body: body === undefined ? undefined : JSON.stringify(body),
		});
		const text = await res.text();
		return { status: res.status, body: text.trim() === "" ? null : JSON.parse(text) };
	}

	before(async () => {
		const root = fsDefault.mkdtempSync(pathDefault.join(osDefault.tmpdir(), "porch-transcripts-"));
		ctx.root = root;
		const store = new TranscriptStore({ root: pathDefault.join(root, "transcripts"), log: () => {} });
		const vectorStore = new LocalVectorStore({ file: pathDefault.join(root, "vectors.json"), log: () => {} });
		// Real service, wired providers-free: the method doc + inspection +
		// status paths don't build providers, and the absent embedder is
		// exactly the plain-language refusal under test.
		const transcript = new TranscriptionService({
			store,
			vectorStore,
			// A stub resolver is enough for method/inspection/status surfaces;
			// the compute re-point test pins cache clearing, not provider guts.
			resolveProvider: (method) => ({ name: `prov-${method}`, transcribe: async () => ({ text: null }) }),
			now: Date.now,
			log: () => {},
		});
		ctx.transcript = transcript;
		const service = createConfigService({
			root: pathDefault.join(root, "config"),
			consoleDist: null,
			transcription: createTranscriptRoutes(transcript),
		});
		ctx.handle = await service.start(0);
		ctx.port = ctx.handle.port;
	});

	after(async () => {
		await ctx.handle?.close();
		if (ctx.root) fsDefault.rmSync(ctx.root, { recursive: true, force: true });
	});

	test("PUT /api/transcription/method scopes the doc of record; GET reads it back", async () => {
		const put = await api("PUT", "/api/transcription/method", {
			global: "openai-spec",
			recordingTypes: { rolling: "whisper-local" },
			cameras: { cam_1: "local-server" },
		});
		assert.equal(put.status, 200);
		assert.deepEqual(put.body, {
			method: {
				global: "openai-spec",
				recordingTypes: { rolling: "whisper-local", event: null },
				cameras: { cam_1: "local-server" },
			},
		});

		const got = await api("GET", "/api/transcription/method");
		assert.equal(got.status, 200);
		assert.deepEqual(got.body, put.body.method);
	});

	test("PUT refuses a method outside the class enum in plain language", async () => {
		const put = await api("PUT", "/api/transcription/method", { global: "magic-ears" });
		assert.equal(put.status, 422);
		assert.ok(put.body.error.includes("must be one of whisper-local, openai-spec, local-server"));
	});

	test("method/inspect names the winning layer per camera", async () => {
		// Camera override beats the recording-type scope.
		const overridden = await api("GET", "/api/transcription/method/inspect?cameraId=cam_1&type=rolling");
		assert.equal(overridden.status, 200);
		assert.deepEqual(overridden.body, {
			method: "local-server",
			source: "camera",
			layers: { camera: "local-server", recordingTypes: { rolling: "whisper-local", event: null }, global: "openai-spec", builtIn: "whisper-local" },
		});

		// No override → the recording-type scope wins.
		const byType = await api("GET", "/api/transcription/method/inspect?cameraId=cam_2&type=rolling");
		assert.equal(byType.status, 200);
		assert.deepEqual(byType.body, {
			method: "whisper-local",
			source: "recording-type",
			layers: { camera: null, recordingTypes: { rolling: "whisper-local", event: null }, global: "openai-spec", builtIn: "whisper-local" },
		});

		// Nothing set for event → the global layer wins.
		const byGlobal = await api("GET", "/api/transcription/method/inspect?cameraId=cam_2&type=event");
		assert.equal(byGlobal.status, 200);
		assert.deepEqual(byGlobal.body, {
			method: "openai-spec",
			source: "global",
			layers: { camera: null, recordingTypes: { rolling: "whisper-local", event: null }, global: "openai-spec", builtIn: "whisper-local" },
		});

		// Inspection is per camera — an absent cameraId refuses in plain language.
		const absent = await api("GET", "/api/transcription/method/inspect?type=rolling");
		assert.equal(absent.status, 422);
		assert.ok(absent.body.error.includes("cameraId: required"));
	});

	test("service.setMethodDoc lives through the HTTP PUT surface (setMethodDoc round-trip)", async () => {
		const doc = ctx.transcript.setMethodDoc({
			global: null,
			recordingTypes: { rolling: "openai-spec", event: "openai-spec" },
			cameras: { cam_1: "whisper-local" },
		});
		const got = await api("GET", "/api/transcription/method");
		assert.deepEqual(got.body, doc);
		const inspect = await api("GET", "/api/transcription/method/inspect?cameraId=cam_1&type=event");
		assert.deepEqual(inspect.body, {
			method: "whisper-local",
			source: "camera",
			layers: { camera: "whisper-local", recordingTypes: { rolling: "openai-spec", event: "openai-spec" }, global: null, builtIn: "whisper-local" },
		});
	});

	test("GET /api/transcription/status reports the never-silent posture", async () => {
		const got = await api("GET", "/api/transcription/status");
		assert.equal(got.status, 200);
		assert.equal(got.body.stage, "transcription");
		assert.equal(got.body.state, "native");
		assert.equal(got.body.embedder.state, "not-provisioned");
		assert.ok(got.body.embedder.reason.includes("no embedder of record is wired"));
		assert.deepEqual(got.body.cadence, {
			windowsStarted: 0,
			windowsCompleted: 0,
			lastWindowRef: null,
			lastWindowMs: null,
			budgetMs: 25_000,
			budgetOverruns: 0,
		});
	});

	test("search without an embedder refuses 422 in plain language", async () => {
		const post = await api("POST", "/api/transcripts/search", { query: "someone at the door" });
		assert.equal(post.status, 422);
		assert.equal(
			post.body.error,
			"semantic search is unavailable: the embedding stage has no provider of record — re-point it on the Models/Compute surface",
		);
	});

	test("GET /api/transcripts and the cascade audit line answer countable zeros", async () => {
		const list = await api("GET", "/api/transcripts");
		assert.equal(list.status, 200);
		assert.deepEqual(list.body, { records: [] });

		const audit = await api("GET", "/api/transcripts/cascade/audit");
		assert.equal(audit.status, 200);
		assert.deepEqual(audit.body, { transcriptRecords: 0, vectorPayloads: 0, textChunks: 0, orphanVectors: 0, vectorlessRecords: 0 });
	});

	test("a Models/Compute re-point of the transcription stage applies live through the wired part (PORCH-155)", async () => {
		// The service holds a built provider; the compute-repoint event clears
		// the cache in place — the next window rebuilds from the posture of
		// record, no restart.
		const before = ctx.transcript.providerFor("whisper-local");
		const put = await api("PUT", "/api/compute/stages/transcription", { providerClass: "openai-spec", model: "whisper-1", endpointRef: "secrets/transcribe" });
		assert.equal(put.status, 200);
		const after = ctx.transcript.providerFor("whisper-local");
		assert.notEqual(after, before, "the re-point rebuilt the provider live");
	});

	test("without the wired part, transcription surfaces refuse 503 in plain language", async () => {
		const root = fsDefault.mkdtempSync(pathDefault.join(osDefault.tmpdir(), "porch-transcripts-unwired-"));
		const service = createConfigService({ root, consoleDist: null });
		const handle = await service.start(0);
		try {
			for (const path of ["/api/transcription/status", "/api/transcripts", "/api/transcripts/cascade/audit"]) {
				const res = await fetch(`http://127.0.0.1:${handle.port}${path}`);
				assert.equal(res.status, 503);
				const body = await res.json();
				assert.equal(
					body.error,
					"the transcription service of record is not wired into this build's config service — the engine composition owns that wiring",
				);
			}
		} finally {
			await handle.close();
			fsDefault.rmSync(root, { recursive: true, force: true });
		}
	});
});
