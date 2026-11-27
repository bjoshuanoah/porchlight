// e2e.cascade.test.js — PORCH-155 ac-4 (cascade half): GIVEN a retention
// sweep deleting rolling windows and events, transcript text AND vector
// entries drop in the SAME removal pass; ZERO matching vector payloads
// remain (count verified, orphan-check assertion passes).

import test from "node:test";
import assert from "node:assert/strict";
import { TranscriptionService } from "../src/service.js";
import { TranscriptStore } from "../src/store.js";
import { LocalVectorStore } from "../src/vector.js";
import { createTranscriptCascade } from "../src/cascade.js";
import { DeterministicEmbedder, feed, spyProvider, tempTree } from "./helpers.js";
import { pruneRolling, pruneEventTier } from "@porchlight/recorder";

test("ac-4 cascade: the sweep's same pass drops text + vectors, orphan check counts zero", async (t) => {
	const tree = tempTree();
	t.after(tree.cleanup);
	const provider = spyProvider({
		answers: [{ text: "speech to keep today" }, { text: "old speech to sweep away" }, { text: "event speech kept" }],
		name: "whisper-local:fake",
	});
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

	// Two rolling days (keep-day 2025-11-28 via nowMs) + an event on the old day.
	await feed(service, "cam-front", 1764158400, 60); // 2025-11-26 12:00 UTC — sweeps away
	await feed(service, "cam-front", 1764763200, 60); // 2025-12-03 12:00 UTC — stays
	await service.settled();
	await service.submitEventSpan({
		cameraId: "cam-front",
		eventId: "evn_old",
		description: "Old-day speech event",
		startedAt: 1764158460,
		endedAt: 1764158520,
	});

	const before = service.vectorStore.count();
	assert.equal(before >= 3, true);
	assert.equal(service.store.list({ sourceType: "rolling" }).length, 2);

	// THE RETENTION SWEEP — the recorder's own pruning functions return the
	// dates they removed; the cascade rides THE SAME PASS (the supervisor's
	// sweep executes these calls inline; see packages/recorder sweep wiring).
	const fs = (await import("node:fs")).default;
	// The recorder's rolling floor prunes by day dirs — give it a segment tree
	// shape over which it removes the old day.
	fs.mkdirSync(`${tree.root}/../../segments/2025-11-26/12/cam-front`, { recursive: true });
	fs.writeFileSync(`${tree.root}/../../segments/2025-11-26/12/cam-front/120000.mp4`, "seg");
	fs.mkdirSync(`${tree.root}/../../segments/2025-12-03/12/cam-front`, { recursive: true });
	fs.writeFileSync(`${tree.root}/../../segments/2025-12-03/12/cam-front/120000.mp4`, "seg");
	fs.mkdirSync(`${tree.root}/../../segments/events/2025-11-26/12/cam-front`, { recursive: true });
	fs.writeFileSync(`${tree.root}/../../segments/events/2025-11-26/12/cam-front/120000.mp4`, "seg");
	const segmentsRoot = `${tree.root}/../../segments`;
	const sweepNow = Date.UTC(2025, 11, 4); // keeps 2025-11-28 onward at 7 days
	const rolling = pruneRolling({ root: segmentsRoot, retentionDays: 7, nowMs: sweepNow, fs });
	assert.deepEqual(rolling.removed, ["2025-11-26"]);
	const events = pruneEventTier({ root: segmentsRoot, eventRetentionDays: 1, nowMs: sweepNow, fs });
	assert.deepEqual(events.removed, ["2025-11-26"]);

	// The cascade — SAME PASS, not a later cleanup.
	const cascade = createTranscriptCascade({ store: service.store, vectorStore: service.vectorStore });
	const droppedRolling = await cascade.dropRollingDates(rolling.removed);
	const droppedEvents = await cascade.dropEventDates(events.removed);

	// COUNTED truth, not assumption.
	assert.equal(droppedRolling.records, 1);
	assert.equal(droppedRolling.vectors, 1);
	assert.equal(droppedEvents.records, 1);
	assert.equal(droppedEvents.vectors, 1);

	// Zero matching vector payloads remain — count verified.
	assert.equal(service.vectorStore.list().filter((p) => p.sourceRef.includes("old") || (p.startOffset >= 1764158400 && p.startOffset < 1764244800)).length, 0);

	// The orphan check passes with zero orphans and zero vectorless records.
	const audit = cascade.audit();
	assert.deepEqual({ orphanVectors: audit.orphanVectors, vectorlessRecords: audit.vectorlessRecords }, { orphanVectors: 0, vectorlessRecords: 0 });
	assert.equal(audit.transcriptRecords, 1); // only the kept day's window remains
	assert.equal(audit.vectorPayloads, 1);

	// The kept day's speech still searches (retention coverage intact).
	const keep = await service.search("speech to keep");
	assert.equal(keep.length, 1);
	await service.close();
});

test("the cascade audit SURFACES inconsistency in both directions", async (t) => {
	const tree = tempTree();
	t.after(tree.cleanup);
	const store = new TranscriptStore({ root: tree.root });
	const vectors = new LocalVectorStore({ file: `${tree.root}/vectors.json` });
	const service = new TranscriptionService({
		store,
		vectorStore: vectors,
		resolveProvider: () => spyProvider({ answers: [{ text: "speech" }] }),
		embedder: new DeterministicEmbedder(),
		enabledFor: () => ({ value: true, source: "base" }),
		now: () => Date.now(),
		log: () => {},
	});
	await feed(service, "cam", 1764244800, 90);
	await service.settled();
	// Simulate a vectorless record: delete its payload behind the cascade's back.
	vectors.deleteByRefs({ sourceType: "rolling", refs: [store.list()[0].sourceRef] });
	const audit = createTranscriptCascade({ store, vectorStore: vectors }).audit();
	assert.equal(audit.vectorlessRecords, 1);
	assert.equal(audit.orphanVectors, 0);
	await service.close();
});
