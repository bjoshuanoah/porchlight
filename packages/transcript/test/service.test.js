// service.test.js — the TranscriptionService posture: gates, consumer loss,
// compute re-pointing, method replacement, timeline resolution, never-silent
// status.

import test from "node:test";
import assert from "node:assert/strict";
import { TranscriptionService, defaultTimelineResolver } from "../src/service.js";
import { TranscriptStore } from "../src/store.js";
import { LocalVectorStore } from "../src/vector.js";
import { UnwiredEmbedder } from "../src/index.js";
import { DeterministicEmbedder, feed, spyProvider, tempTree } from "./helpers.js";

function serviceOf(overrides = {}) {
	const tree = tempTree();
	const service = new TranscriptionService({
		store: new TranscriptStore({ root: tree.root }),
		vectorStore: new LocalVectorStore({ file: `${tree.root}/vectors.json` }),
		resolveProvider: () => spyProvider({ answers: [{ text: "spoken words" }] }),
		embedder: new DeterministicEmbedder(),
		enabledFor: () => ({ value: true, source: "base" }),
		now: () => Date.now(),
		log: () => {},
		...overrides,
	});
	return { tree, service, dispose: async () => { await service.close(); tree.cleanup(); } };
}

test("consumer loss: stop refuses chunks with an explained reason, restart clears", async (t) => {
	const { service, dispose } = await serviceOf();
	t.after(dispose);
	service.stop("the transcription consumer lost its stream lane");
	const refused = await service.submitRollingAudio({ camera: "cam", t: 0, sampleRate: 16_000, data: new Float32Array(61 * 16_000) });
	assert.match(refused.refused, /recording and visual detection continue/);
	assert.equal(refused.queued, 0);
	assert.equal(service.status().state, "failed");
	service.restart();
	assert.equal(service.status().state, "native");
	const after = await service.submitRollingAudio({ camera: "cam", t: 0, sampleRate: 16_000, data: new Float32Array(61 * 16_000) });
	assert.equal(after.queued, 1);
});

test("a disabled camera refuses with its layer named (privacy posture, off by default)", async (t) => {
	const { service, dispose } = await serviceOf({ enabledFor: undefined });
	t.after(dispose);
	const refusal = await service.submitRollingAudio({ camera: "cam", t: 0, sampleRate: 16_000, data: new Float32Array(1) });
	assert.match(refusal.refused, /transcription is off for camera "cam"/);
	// A malformed enablement answer refuses to guess.
	const malformed = new TranscriptionService({
		store: new TranscriptStore({ root: "/tmp/nonexistent-transcripts" }),
		vectorStore: new LocalVectorStore({ file: "/tmp/nonexistent-transcripts/vectors.json" }),
		resolveProvider: () => spyProvider({}),
		enabledFor: () => ({ value: "x", source: "y" }),
		now: () => Date.now(),
		log: () => {},
	});
	await assert.rejects(
		() => malformed.submitRollingAudio({ camera: "cam", t: 0, sampleRate: 16_000, data: new Float32Array(1) }),
		TypeError,
	);
});

test("method replacement lives: setMethodDoc re-scopes without restart", async (t) => {
	const { service, dispose } = await serviceOf();
	t.after(dispose);
	assert.equal(service.inspectMethod("cam", "rolling").method, "whisper-local");
	assert.equal(service.providerCache.size, 0); // nothing built yet
	service.setMethodDoc({ recordingTypes: { rolling: "openai-spec" } });
	assert.deepEqual(
		{ method: service.inspectMethod("cam", "rolling").method, source: service.inspectMethod("cam", "rolling").source },
		{ method: "openai-spec", source: "recording-type" },
	);
	// The provider cache rebuilt for the new method only on use.
	assert.equal(service.providerFor("openai-spec").name.startsWith("spy:"), true);
	assert.equal(service.providerCache.has("whisper-local"), false);
});

test("compute re-point clears cached providers in place (live apply, no restart)", async (t) => {
	const { service, dispose } = await serviceOf();
	t.after(dispose);
	const before = service.providerFor("whisper-local");
	service.repoint();
	const after = service.providerFor("whisper-local");
	assert.notEqual(after, before);
	assert.equal(after.name, before.name);
});

test("status states the never-silent posture including the unwired embedder", async (t) => {
	const { service, dispose } = await serviceOf({ embedder: new UnwiredEmbedder() });
	t.after(dispose);
	await feed(service, "cam", 0, 60);
	await service.settled();
	const s = service.status();
	assert.equal(s.stage, "transcription");
	assert.match(s.embedder.reason, /no provider yet|no embedder of record/);
	// The record still landed (text is the primary data), zero vectors.
	assert.equal(s.counters.recordsWritten, 1);
	assert.equal(s.counters.vectorsWritten, 0);
	assert.equal(s.counters.chunks > 0, true);
	assert.equal(s.methods.effective.rolling, "whisper-local");
});

test("timeline resolution of record: rolling seeks, events open the event page", () => {
	const rolling = defaultTimelineResolver({ cameraId: "cam-front", sourceType: "rolling", sourceRef: "window-cam-front-1764244800000", startOffset: 1764244800.0 });
	assert.equal(rolling.path, `/timeline/cam-front?at=${encodeURIComponent("2025-11-27T12:00:00.000Z")}`);
	assert.equal(rolling.label, "rolling window");
	assert.deepEqual(defaultTimelineResolver({ cameraId: "cam-front", sourceType: "event", sourceRef: "event-cam-front-evn_9", startOffset: 0 }), {
		path: "/events/cam-front/evn_9",
		label: "event",
	});
});

test("the event regime needs enablement too (off-camera spans refuse)", async (t) => {
	const { service, dispose } = await serviceOf({ enabledFor: () => false });
	t.after(dispose);
	const refusal = await service.submitEventSpan({ cameraId: "cam", eventId: "e", description: "d", startedAt: 0, endedAt: 60 });
	assert.match(refusal.error, /transcription is off/);
	assert.equal(refusal.record, null);
});

test("event audio unavailable keeps the span EXPLICIT (never-truncate-silently)", async (t) => {
	const { service, dispose } = await serviceOf({
		eventReader: async () => null,
	});
	t.after(dispose);
	const { record } = await service.submitEventSpan({ cameraId: "cam", eventId: "e", description: "d", startedAt: 0, endedAt: 120 });
	assert.equal(record.state, "partial");
	assert.deepEqual({ completedChunks: record.partial.completedChunks, totalChunks: record.partial.totalChunks }, { completedChunks: 0, totalChunks: 2 });
	assert.match(record.partial.reason, /unavailable/);
});

test("flushAll lands the pending tail before the consumer stops", async (t) => {
	const { service, dispose } = await serviceOf();
	t.after(dispose);
	await feed(service, "cam", 1000, 25); // under one window
	assert.equal(service.windower.retained().cam.pendingSec.toFixed(1), "25.0");
	await service.flushAll();
	const tail = service.store.list({ cameraId: "cam", sourceType: "rolling" });
	assert.equal(tail.length, 1);
	assert.equal(tail[0].startOffset, 1000);
	assert.equal(tail[0].endOffset, 1025);
	assert.deepEqual(service.windower.retained(), {});
});
