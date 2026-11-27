// e2e.scope.test.js — PORCH-155 ac-4 (scope half): GIVEN a per-camera method
// override, it wins over the recording-type method, which wins over global;
// the effective method AND its source layer are inspectable (the admin
// console renders the winning layer).

import test from "node:test";
import assert from "node:assert/strict";
import { TranscriptionService } from "../src/service.js";
import { TranscriptStore } from "../src/store.js";
import { LocalVectorStore } from "../src/vector.js";
import { DeterministicEmbedder, spyProvider, tempTree } from "./helpers.js";

test("ac-4 scope: camera override supersedes recording-type, which supersedes global — per camera exactly", async (t) => {
	const tree = tempTree();
	t.after(tree.cleanup);
	const providers = [];
	const service = new TranscriptionService({
		store: new TranscriptStore({ root: tree.root }),
		vectorStore: new LocalVectorStore({ file: `${tree.root}/vectors.json` }),
		resolveProvider: (method) => {
			const p = spyProvider({ name: `prov-${method}` });
			providers.push({ method, p });
			return p;
		},
		embedder: new DeterministicEmbedder(),
		enabledFor: () => ({ value: true, source: "base" }),
		eventReader: async ({ from, to }) => ({ data: new Float32Array(Math.round((to - from) * 16_000)).fill(0.25), sampleRate: 16_000 }),
		now: () => Date.now(),
		log: () => {},
	});
	// The config of record: global openai-spec; recording-type local-server
	// for rolling; ONE camera override (cam-front → whisper-local).
	service.setMethodDoc({
		global: "openai-spec",
		recordingTypes: { rolling: "local-server", event: "openai-spec" },
		cameras: { "cam-front": "whisper-local" },
	});

	// Inspectable: effective method + source layer, for BOTH cameras and
	// BOTH families — the override applies to EXACTLY its camera.
	const frontRolling = service.inspectMethod("cam-front", "rolling");
	assert.deepEqual(
		{ method: frontRolling.method, source: frontRolling.source },
		{ method: "whisper-local", source: "camera" },
	);
	assert.equal(frontRolling.layers.camera, "whisper-local"); // the winning layer is rendered
	assert.equal(frontRolling.layers.recordingTypes.rolling, "local-server");
	assert.equal(frontRolling.layers.global, "openai-spec");

	const sideRolling = service.inspectMethod("cam-side", "rolling");
	assert.deepEqual(
		{ method: sideRolling.method, source: sideRolling.source },
		{ method: "local-server", source: "recording-type" },
	);
	const sideEvent = service.inspectMethod("cam-side", "event");
	assert.deepEqual(
		{ method: sideEvent.method, source: sideEvent.source },
		{ method: "openai-spec", source: "recording-type" },
	);

	// The override drives the ACTUAL provider the window rides: cam-front's
	// rolling windows transcribe through whisper-local, cam-side's through
	// local-server — in ONE shared windower fleet, per camera.
	await service.submitRollingAudio({ camera: "cam-front", t: 0, sampleRate: 16_000, data: new Float32Array(61 * 16_000).fill(0.5) });
	await service.submitRollingAudio({ camera: "cam-side", t: 0, sampleRate: 16_000, data: new Float32Array(61 * 16_000).fill(0.5) });
	await service.settled();
	const frontWindow = service.store.list({ cameraId: "cam-front", sourceType: "rolling" })[0];
	const sideWindow = service.store.list({ cameraId: "cam-side", sourceType: "rolling" })[0];
	assert.equal(frontWindow.provider, "prov-whisper-local");
	assert.equal(sideWindow.provider, "prov-local-server");

	// Event family on cam-side: recording-type carries the event method
	// (openai-spec) and wins over global (openai-spec too — same method,
	// the layer of record stays truthful).
	const sideEventSpan = await service.submitEventSpan({
		cameraId: "cam-side",
		eventId: "e",
		description: "Speech at the fence",
		startedAt: 0,
		endedAt: 60,
	});
	assert.equal(sideEventSpan.record.provider, "prov-openai-spec");
	const sideEventInspect = service.inspectMethod("cam-side", "event");
	assert.deepEqual(
		{ method: sideEventInspect.method, source: sideEventInspect.source },
		{ method: "openai-spec", source: "recording-type" },
	);
	await service.close();
});
