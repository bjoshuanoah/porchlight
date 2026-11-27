// e2e.span.test.js — PORCH-155 ac-2: GIVEN an audio-bearing event on a
// transcribed camera, the event record carries its transcript; an event of
// more than one window transcribes FULLY as chunked sequential windows; the
// record carries the full span or an EXPLICIT partiality state (never-
// truncate-silently); the desc-and-transcript law holds — description and
// transcript render together or neither.

import test from "node:test";
import assert from "node:assert/strict";
import { TranscriptionService } from "../src/service.js";
import { TranscriptStore } from "../src/store.js";
import { LocalVectorStore } from "../src/vector.js";
import { DeterministicEmbedder, spyProvider, tempTree } from "./helpers.js";

test("ac-2 span: a 4-minute event transcribes fully as chunked windows and joins; a silent span records no-speech; partiality is explicit", async (t) => {
	const tree = tempTree();
	t.after(tree.cleanup);
	const answers = [{ text: "hello at the door" }, { text: "nice to meet you" }, { text: null }, { text: "come on in" }];
	const provider = spyProvider({ name: "whisper-local:test", answers });
	const service = new TranscriptionService({
		store: new TranscriptStore({ root: tree.root }),
		vectorStore: new LocalVectorStore({ file: `${tree.root}/vectors.json` }),
		resolveProvider: () => provider,
		embedder: new DeterministicEmbedder(),
		enabledFor: () => ({ value: true, source: "base" }),
		eventReader: async ({ from, to }) => ({ data: new Float32Array(Math.round((to - from) * 16_000)).fill(0.25), sampleRate: 16_000 }),
		now: () => Date.now(),
		log: () => {},
	});

	// The 4-minute event: four sequential chunks (2 speech, 1 explicit
	// no-speech, 1 speech) — the full span joins, with per-chunk detail
	// naming the silent chunk explicitly.
	const startedAt = 1764244800;
	const { record, error } = await service.submitEventSpan({
		cameraId: "cam-front",
		eventId: "evn_full",
		description: "Someone arrived and was greeted at the door",
		startedAt,
		endedAt: startedAt + 240,
	});
	assert.equal(error, undefined);
	assert.equal(record.state, "text", "a no-speech MIDDLE chunk never truncates the span");
	assert.equal(record.text, "hello at the door nice to meet you come on in");
	assert.equal(record.chunks.length, 4);
	assert.equal(record.chunks[2].state, "no-speech");
	assert.equal(record.chunks[2].text, null, "absence of text is an explicit state, never a missing field");
	assert.equal(record.provider, provider.name);
	assert.equal(record.description, "Someone arrived and was greeted at the door");

	// Write-time vectors: ONE PER TEXT CHUNK (3 of 4), offsets of the chunk.
	const vectors = service.vectorStore.list().filter((p) => p.sourceType === "event" && p.sourceRef.endsWith("evn_full"));
	assert.equal(vectors.length, 3);
	assert.deepEqual(
		{ startOffset: vectors[2].startOffset, endOffset: vectors[2].endOffset },
		{ startOffset: startedAt + 180, endOffset: startedAt + 240 },
	);

	// A fully silent event records the explicit no-speech state.
	const silent = await service.submitEventSpan({
		cameraId: "cam-front",
		eventId: "evn_silent",
		description: "Motion near the hedge, no speech",
		startedAt,
		endedAt: startedAt + 120,
	});
	assert.equal(silent.record.state, "no-speech");
	assert.equal(silent.record.text, null);

	// A failing span keeps an EXPLICIT partiality state — never truncation.
	const failing = spyProvider({
		answers: [{ text: "spoke" }],
		failOn: { call: 2, message: "provider reset" },
	});
	const service2 = new TranscriptionService({
		store: service.store,
		vectorStore: service.vectorStore,
		resolveProvider: () => failing,
		embedder: new DeterministicEmbedder(),
		enabledFor: () => ({ value: true, source: "base" }),
		eventReader: async ({ from, to }) => ({ data: new Float32Array(Math.round((to - from) * 16_000)).fill(0.25), sampleRate: 16_000 }),
		now: () => Date.now(),
		log: () => {},
	});
	const partial = await service2.submitEventSpan({
		cameraId: "cam-front",
		eventId: "evn_partial",
		description: "Voices near the driveway for a while",
		startedAt,
		endedAt: startedAt + 120,
	});
	assert.equal(partial.record.state, "partial");
	assert.deepEqual({ completedChunks: partial.record.partial.completedChunks, totalChunks: partial.record.partial.totalChunks }, { completedChunks: 1, totalChunks: 2 });
	assert.match(partial.record.partial.reason, /provider reset/);

	await service.close();
});

test("the desc-and-transcript law: event transcripts refuse one-sided writes", async (t) => {
	const tree = tempTree();
	t.after(tree.cleanup);
	const service = new TranscriptionService({
		store: new TranscriptStore({ root: tree.root }),
		vectorStore: new LocalVectorStore({ file: `${tree.root}/vectors.json` }),
		resolveProvider: () => spyProvider({ answers: [{ text: "x" }] }),
		embedder: new DeterministicEmbedder(),
		enabledFor: () => ({ value: true, source: "base" }),
		eventReader: async () => ({ data: new Float32Array(16_000).fill(0.25), sampleRate: 16_000 }),
		now: () => Date.now(),
		log: () => {},
	});
	// No description — refused with the law named.
	await assert.rejects(
		() => service.submitEventSpan({ cameraId: "cam", eventId: "e1", description: "", startedAt: 0, endedAt: 60 }),
		/desc-and-transcript/,
	);
	// The store refuses the same law on direct writes.
	assert.throws(() => service.store.put({
		cameraId: "cam", sourceType: "event", sourceRef: "event-cam-e2", startOffset: 0, endOffset: 60,
		text: "words", state: "text", transcribedAt: Date.now() / 1000, provider: "p",
	}), /description: required/);
	// An event page renders both or neither: no record exists for the refused span.
	assert.equal(service.store.list({ sourceType: "event" }).length, 0);
	await service.close();
});

test("a missing event reader refuses in plain language", async (t) => {
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
	await assert.rejects(
		() => service.submitEventSpan({ cameraId: "cam", eventId: "e", description: "d", startedAt: 0, endedAt: 60 }),
		/eventReader: not wired/,
	);
	await service.close();
});
