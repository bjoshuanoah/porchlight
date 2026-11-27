// e2e.cadence.test.js — PORCH-155 ac-1: GIVEN speech inside a camera feed
// with transcription enabled for that scope, the rolling ~1-minute window
// transcribes WITHIN its cadence budget (well under its wall-clock length)
// and lands TEXT PLUS WRITE-TIME VECTORS. The next window starts on
// schedule: window creation is time-driven from the feed, never blocked by
// an in-flight transcription.

import test from "node:test";
import assert from "node:assert/strict";
import { TranscriptionService } from "../src/service.js";
import { TranscriptStore } from "../src/store.js";
import { LocalVectorStore } from "../src/vector.js";
import { ROLLING_CADENCE_BUDGET_MS } from "../src/types.js";
import { DeterministicEmbedder, feed, spyProvider, tempTree } from "./helpers.js";

test("ac-1 cadence: windows transcribe within budget, land text and write-time vectors, and the feed never stalls", async (t) => {
	const tree = tempTree();
	t.after(tree.cleanup);
	const provider = spyProvider({
		name: "whisper-local:fake-base",
		answers: [{ text: "hello from the front porch" }, { text: "the courier left a box" }, { text: "  " }],
	});
	const embedder = new DeterministicEmbedder();
	const service = new TranscriptionService({
		store: new TranscriptStore({ root: tree.root }),
		vectorStore: new LocalVectorStore({ file: `${tree.root}/vectors.json` }),
		resolveProvider: () => provider,
		embedder,
		enabledFor: (cam) => ({ value: cam === "cam-front", source: "base" }),
		now: () => Date.now(),
		log: () => {},
	});

	// Speech feeds at 60 s chunk granularity on the aligned timeline: a
	// chunk whose span completes a window emits it IMMEDIATELY (window
	// creation rides the feed, never an in-flight transcription — the next
	// window starts on schedule). Chunk submission returns after enqueueing;
	// transcription runs on the per-camera queue in order.
	const t0 = 1764244800;
	const first = await service.submitRollingAudio({ camera: "cam-front", t: t0, sampleRate: 16_000, data: new Float32Array(60 * 16_000).fill(0.5) });
	assert.equal(first.queued, 1, "a completed first chunk emits its window at once");
	await feed(service, "cam-front", t0 + 60, 120); // windows 2 and 3
	await service.settled();

	// Text PLUS write-time vectors, both landed (never lazy).
	const records = service.store.list({ sourceType: "rolling", cameraId: "cam-front" });
	assert.equal(records.length, 3);
	assert.equal(records.find((r) => r.startOffset === t0).text, "hello from the front porch");
	assert.equal(records.find((r) => r.startOffset === t0 + 60).text, "the courier left a box");
	// Write-time vectors: one per recorded window, payload refs carrying the
	// TS 13 field set exactly.
	const vectors = service.vectorStore.list().filter((p) => p.sourceType === "rolling" && p.cameraId === "cam-front");
	assert.equal(vectors.length, 2, "the silent window embeds nothing — no text, no vector");
	assert.deepEqual(
		{ cameraId: vectors[0].cameraId, sourceType: vectors[0].sourceType, sourceRef: vectors[0].sourceRef },
		{ cameraId: "cam-front", sourceType: "rolling", sourceRef: "window-cam-front-1764244800000" },
	);

	// Cadence: every window completed within the budget of record, counted.
	assert.equal(service.cadence.budgetMs, ROLLING_CADENCE_BUDGET_MS);
	assert.equal(service.cadence.windowsStarted, 3);
	assert.equal(service.cadence.windowsCompleted, 3);
	assert.equal(service.cadence.lastWindowMs < ROLLING_CADENCE_BUDGET_MS, true, "transcribes in well under its wall-clock length");
	assert.equal(service.cadence.budgetOverruns, 0);

	// Enablement gate: the OTHER camera is off — zero analysis, zero vectors.
	await feed(service, "cam-side", t0, 120);
	await service.settled();
	assert.equal(service.store.list({ cameraId: "cam-side" }).length, 0);
	assert.equal(service.vectorStore.list().filter((p) => p.cameraId === "cam-side").length, 0);
	assert.equal(service.counters.refused >= 2, true);

	// Explicit no-speech state: the third window spoke nothing — its record
	// carries state "no-speech" with text exactly null (absence of text is
	// never a missing field), and no vector without text to embed.
	const silent = service.store.list({ cameraId: "cam-front", sourceType: "rolling" }).find((r) => r.state === "no-speech");
	assert.equal(silent.startOffset, t0 + 120);
	assert.equal(silent.text, null);
	assert.equal(silent.state, "no-speech");
	await service.close();
});

test("a provider failure lands an EXPLICIT partial window, never a silent gap", async (t) => {
	const tree = tempTree();
	t.after(tree.cleanup);
	const provider = spyProvider({
		answers: [{ text: "first window spoke" }],
		failOn: { call: 2, message: "the model server restarted mid-window" },
	});
	const service = new TranscriptionService({
		store: new TranscriptStore({ root: tree.root }),
		vectorStore: new LocalVectorStore({ file: `${tree.root}/vectors.json` }),
		resolveProvider: () => provider,
		embedder: new DeterministicEmbedder(),
		enabledFor: () => ({ value: true, source: "base" }),
		now: () => Date.now(),
		log: () => {},
	});
	const t0 = 1764244800;
	await feed(service, "cam-front", t0, 180);
	await service.settled();
	const records = service.store.list({ cameraId: "cam-front", sourceType: "rolling" });
	const partial = records.find((r) => r.state === "partial");
	assert.equal(partial.text, null);
	assert.equal(partial.partial.totalChunks, 1);
	assert.match(partial.partial.reason, /model server restarted/);
	assert.equal(records.find((r) => r.state === "text").text, "first window spoke");
	await service.close();
});
