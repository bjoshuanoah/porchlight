// server.test.js — the transcript REST surface: routes, layers inspection,
// explicit-state rendering, search with resolved paths, cascade audit.
//
// The production mount rides the config console server (an injected part);
// this file proves the handlers standalone over node:http.

import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { createTranscriptRoutes } from "../src/server.js";
import { TranscriptionService } from "../src/service.js";
import { TranscriptStore } from "../src/store.js";
import { LocalVectorStore } from "../src/vector.js";
import { DeterministicEmbedder, feed, spyProvider, tempTree } from "./helpers.js";

/** Boot the routes on an ephemeral server. */
async function boot(service) {
	const routes = createTranscriptRoutes(service);
	const server = http.createServer((req, res) => {
		const url = new URL(req.url ?? "/", "http://localhost");
		const segments = url.pathname.split("/").filter(Boolean).slice(1); // /api-relative, like the config server's r
		Promise.resolve(routes.handle(req, res, req.method ?? "GET", segments, url)).then((handled) => {
			if (!handled) {
				res.writeHead(404, { "content-type": "application/json" });
				res.end(JSON.stringify({ error: "not-found" }));
			}
		}, (err) => {
			res.writeHead(err.name === "ValidationError" ? 422 : 500, { "content-type": "application/json; charset=utf-8" });
			res.end(JSON.stringify({ error: err.message }));
		});
	});
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	const base = `http://127.0.0.1:${server.address().port}`;
	return {
		base,
		[Symbol.asyncDispose]: () => new Promise((r) => server.close(r)),
	};
}

test("ac-4 inspection surface: the winning method layer renders per camera and type", async (t) => {
	const tree = tempTree();
	t.after(tree.cleanup);
	const service = new TranscriptionService({
		store: new TranscriptStore({ root: tree.root }),
		vectorStore: new LocalVectorStore({ file: `${tree.root}/vectors.json` }),
		resolveProvider: () => spyProvider({}),
		enabledFor: () => ({ value: true, source: "base" }),
		now: () => Date.now(),
		log: () => {},
	});
	service.setMethodDoc({ recordingTypes: { rolling: "local-server" }, cameras: { "cam-front": "whisper-local" } });
	const api = await boot(service);
	t.after(() => api[Symbol.asyncDispose]());

	const doc = await (await fetch(`${api.base}/api/transcription/method`)).json();
	assert.deepEqual({ global: doc.global, rolling: doc.recordingTypes.rolling, front: doc.cameras["cam-front"] }, { global: null, rolling: "local-server", front: "whisper-local" });

	const inspect = await (await fetch(`${api.base}/api/transcription/method/inspect?cameraId=cam-front&type=rolling`)).json();
	assert.deepEqual({ method: inspect.method, source: inspect.source, winningLayer: inspect.layers.camera }, { method: "whisper-local", source: "camera", winningLayer: "whisper-local" });

	const bad = await fetch(`${api.base}/api/transcription/method/inspect?cameraId=cam-front`);
	assert.equal(bad.status, 422);
	assert.match((await bad.json()).error, /type: must be one of/);
	await service.close();
});

test("transcripts surface: explicit states list; search resolves timeline paths; audit counts", async (t) => {
	const tree = tempTree();
	t.after(tree.cleanup);
	const service = new TranscriptionService({
		store: new TranscriptStore({ root: tree.root }),
		vectorStore: new LocalVectorStore({ file: `${tree.root}/vectors.json` }),
		resolveProvider: () => spyProvider({
			name: "whisper-local:fake",
			answers: [{ text: "words said beside the door" }, { text: "the wind blew" }, { text: "  " }, { text: "speech near the door again" }],
		}),
		embedder: new DeterministicEmbedder({ dims: 8 }),
		enabledFor: () => ({ value: true, source: "base" }),
		eventReader: async ({ from, to }) => ({ data: new Float32Array(Math.round((to - from) * 16_000)).fill(0.25), sampleRate: 16_000 }),
		now: () => Date.now(),
		log: () => {},
	});
	await feed(service, "cam-front", 1764244800, 120);
	await service.settled();
	await service.submitEventSpan({ cameraId: "cam-front", eventId: "evn_1", description: "Speech near the door", startedAt: 1764244805, endedAt: 1764244805 + 60 });
	const api = await boot(service);
	t.after(() => api[Symbol.asyncDispose]());

	const listed = await (await fetch(`${api.base}/api/transcripts?cameraId=cam-front&limit=10`)).json();
	assert.equal(listed.records.length, 3); // two windows + the event
	const silent = listed.records.find((r) => r.state === "no-speech");
	assert.equal(silent !== undefined, true); // explicit state rendered, never missing

	const search = await (await fetch(`${api.base}/api/transcripts/search`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ query: "what was said at the door", k: 3 }) })).json();
	assert.equal(search.results.length >= 1, true);
	for (const r of search.results) {
		assert.equal(typeof r.timeline.path, "string");
		assert.equal(r.timeline.path === null, false);
	}

	const audit = await (await fetch(`${api.base}/api/transcripts/cascade/audit`)).json();
	assert.deepEqual({ orphanVectors: audit.orphanVectors, vectorlessRecords: audit.vectorlessRecords }, { orphanVectors: 0, vectorlessRecords: 0 });

	const unknown = await fetch(`${api.base}/api/transcription/nonsense`);
	assert.equal(unknown.status, 422);
	await service.close();
});
