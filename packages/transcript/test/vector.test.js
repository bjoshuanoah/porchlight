// vector.test.js — the local vector store of record: write-time puts, cosine
// ranking, ref-filtered deletion, persistence across instances.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { LocalVectorStore } from "../src/vector.js";
import { DeterministicEmbedder, tempTree } from "./helpers.js";

function payload(overrides = {}) {
	return {
		cameraId: "cam-front",
		sourceType: "rolling",
		sourceRef: "window-cam-front-1764244800000",
		startOffset: 1764244800,
		endOffset: 1764244845,
		text: "the dog barked at the mail carrier",
		...overrides,
	};
}

test("cosine search ranks lexical overlap first, k bounds the answer", async (t) => {
	const tree = tempTree();
	t.after(tree.cleanup);
	const embedder = new DeterministicEmbedder();
	const store = new LocalVectorStore({ file: `${tree.root}/vectors.json` });
	const texts = [
		"the dog barked twice",
		"package left at the door",
		"the dog barked at the mail carrier",
		"someone walked past the gate",
	];
	for (const [i, text] of texts.entries()) {
		const { data } = await embedder.embed(text);
		store.put({ data }, payload({ sourceRef: `w-${i}`, text }));
	}
	assert.equal(store.count(), 4);
	// "find where someone said X": lexical family wins.
	const { data: q } = await embedder.embed("where did the dog bark");
	const top = store.search({ data: q }, { k: 2 });
	assert.equal(top.length, 2);
	assert.match(top[0].payload.text, /dog barked/);
	// Payload refs carry the TS 13 field set exactly.
	assert.equal(top[0].payload.sourceType, "rolling");
	assert.equal(typeof top[0].payload.startOffset, "number");
});

test("deleteByRefs drops exactly the named source refs (per-sourceRef filter)", (t) => {
	const tree = tempTree();
	t.after(tree.cleanup);
	const store = new LocalVectorStore({ file: `${tree.root}/vectors.json` });
	const v = new Float32Array([1, 0, 0, 0, 0, 0, 0, 0]);
	store.put({ data: v }, payload());
	store.put({ data: v }, payload({ sourceRef: "w-2", text: "second" }));
	store.put({ data: v }, payload({ sourceType: "event", sourceRef: "event-cam-front-evn_1" }));
	assert.equal(store.count(), 3);
	assert.equal(store.deleteByRefs({ sourceType: "rolling", refs: ["window-cam-front-1764244800000", "w-2"] }), 2);
	assert.equal(store.count(), 1);
	assert.equal(store.list()[0].sourceType, "event");
	// The event family is untouched by a rolling drop.
	assert.equal(store.deleteByRefs({ sourceType: "rolling", refs: ["event-cam-front-evn_1"] }), 0);
});

test("deleteByDateKeys drops by UTC day of the chunk start (the sweep's day granularity)", (t) => {
	const tree = tempTree();
	t.after(tree.cleanup);
	// 1764244800 = 2025-11-27T12:00:00Z
	const store = new LocalVectorStore({ file: `${tree.root}/vectors.json` });
	const v = new Float32Array([0, 1, 0, 0, 0, 0, 0, 0]);
	store.put({ data: v }, payload());
	store.put({ data: v }, payload({ startOffset: 1764158400, sourceRef: "w-day-before" })); // 2025-11-26
	assert.equal(store.deleteByDateKeys({ sourceType: "rolling", dateKeys: ["2025-11-27"] }), 1);
	assert.equal(store.count(), 1);
	assert.equal(store.list()[0].sourceRef, "w-day-before");
});

test("the collection persists across instances (config-survives-restarts law)", async (t) => {
	const tree = tempTree();
	t.after(tree.cleanup);
	const embedder = new DeterministicEmbedder();
	const first = new LocalVectorStore({ file: `${tree.root}/vectors.json` });
	const { data } = await embedder.embed("speech text");
	first.put({ data }, payload({ sourceRef: "w-speech", text: "speech text" }));
	const reopened = new LocalVectorStore({ file: `${tree.root}/vectors.json` });
	assert.equal(reopened.count(), 1);
	assert.equal(reopened.list()[0].text, "speech text");
	// A torn file refuses to load (never guessed over).
	fs.writeFileSync(`${tree.root}/vectors.json`, "{torn");
	assert.throws(() => new LocalVectorStore({ file: `${tree.root}/vectors.json` }), /unreadable/);
});
