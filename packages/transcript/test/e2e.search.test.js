// e2e.search.test.js — PORCH-155 ac-3: GIVEN a spoken phrase inside
// retention coverage, vector search returns matching windows and events
// with source refs RESOLVED TO TIMELINE PATHS (rolling window → seek
// target; event → event page), across BOTH store families.

import test from "node:test";
import assert from "node:assert/strict";
import { TranscriptionService } from "../src/service.js";
import { TranscriptStore } from "../src/store.js";
import { LocalVectorStore } from "../src/vector.js";
import { DeterministicEmbedder, feed, spyProvider, tempTree } from "./helpers.js";

test("ac-3 search: a spoken phrase finds both families, every result opens its source", async (t) => {
	const tree = tempTree();
	t.after(tree.cleanup);
	const provider = spyProvider({
		name: "whisper-local:test",
		answers: [
			{ text: "the delivery driver left a box on the step" }, // rolling window 1
			{ text: "wind over the hedge, no words" },              // rolling window 2
			{ text: "did anyone hear the dog barking at the gate" },// event chunk
			{ text: "  " },                                          // silent event chunk
		],
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

	// Rolling windows + an event, both transcribed into the store of record.
	await feed(service, "cam-front", 1764244800, 120);
	await service.settled();
	await service.submitEventSpan({
		cameraId: "cam-front",
		eventId: "evn_gate",
		description: "Someone spoke at the gate",
		startedAt: 1764244900,
		endedAt: 1764244900 + 120,
	});

	// "Find where someone said X" — the phrase family spans BOTH families.
	const results = await service.search("who talked about the dog barking at the gate");
	assert.equal(results.length >= 1, true);
	const byFamily = Object.groupBy(results, (r) => r.sourceType);

	// The event hit resolves to the EVENT PAGE; it opens its source.
	const event = byFamily.event?.[0];
	assert.equal(event !== undefined, true);
	assert.equal(event.sourceRef, "event-cam-front-evn_gate");
	assert.equal(event.timeline.path, `/events/${encodeURIComponent("cam-front")}/evn_gate`);
	assert.equal(event.timeline.label, "event");
	assert.match(event.text, /barking/);

	// A rolling hit resolves to the SEEK TARGET on the timeline.
	const rolling = byFamily.rolling?.[0];
	assert.equal(rolling !== undefined, true);
	assert.match(rolling.timeline.path, /^\/timeline\/cam-front\?at=/);
	const at = decodeURIComponent(new URL(`http://x${rolling.timeline.path}`).searchParams.get("at"));
	assert.equal(at, new Date(rolling.startOffset * 1000).toISOString());
	assert.equal(rolling.timeline.label, "rolling window");

	// Family and camera filters scope the search.
	const onlyEvents = await service.search("dog barking", { sourceType: "event" });
	assert.deepEqual([...new Set(onlyEvents.map((r) => r.sourceType))], ["event"]);

	// No search without the embedder of record — plain language, never silent.
	const unsearchable = new TranscriptionService({
		store: service.store,
		vectorStore: service.vectorStore,
		resolveProvider: () => spyProvider({}),
		enabledFor: () => false,
		now: () => Date.now(),
		log: () => {},
	});
	await assert.rejects(() => unsearchable.search("anything"), /embedding stage has no provider/);
	await service.close();
	await unsearchable.close();
});
