// store.test.js — the transcript store of record: explicit states, the
// desc-and-transcript law, family separation, day-level cascade drops.

import test from "node:test";
import assert from "node:assert/strict";
import { TranscriptStore, dateKeyOf } from "../src/store.js";
import { assertTranscriptRecord } from "../src/types.js";
import { tempTree } from "./helpers.js";

/** A valid event record builder — description REQUIRED (desc-and-transcript law). */
function eventRecord(overrides = {}) {
	return {
		cameraId: "cam-front",
		sourceType: "event",
		sourceRef: "event-cam-front-evn_1",
		startOffset: 1000,
		endOffset: 1240,
		text: "hello from the porch",
		state: "text",
		transcribedAt: 1005,
		provider: "spy:whisper",
		description: "Someone arrived at the front door",
		...overrides,
	};
}

function rollingRecord(overrides = {}) {
	return {
		cameraId: "cam-front",
		sourceType: "rolling",
		sourceRef: "window-cam-front-1764244800000",
		startOffset: 1764244800,
		endOffset: 1764244860,
		text: "packages go here",
		state: "text",
		transcribedAt: 1764244865,
		provider: "spy:whisper",
		...overrides,
	};
}

test("rolling and event records live in separate families (two-class law)", (t) => {
	const tree = tempTree();
	t.after(tree.cleanup);
	const store = new TranscriptStore({ root: tree.root });
	store.put(rollingRecord());
	store.put(eventRecord());
	assert.equal(store.list({ sourceType: "rolling" }).length, 1);
	assert.equal(store.list({ sourceType: "event" }).length, 1);
	// The families never share a lifecycle: dropping the event's day leaves
	// rolling untouched (separate classes, separate windows).
	const eventDay = dateKeyOf(eventRecord().startOffset * 1000);
	const dropped = store.dropDates("event", [eventDay]);
	assert.equal(dropped, 1);
	assert.equal(store.list({ sourceType: "event" }).length, 0);
	assert.equal(store.list({ sourceType: "rolling" }).length, 1);
});

test("the desc-and-transcript law refuses one-sided event records", () => {
	assert.throws(() => new TranscriptStore({ root: "/tmp/x" }).put(eventRecord({ description: undefined })), /description: required/);
	assert.throws(() => assertTranscriptRecord(eventRecord({ description: "   " })), /desc-and-transcript/);
});

test("rolling records refuse a description (rolling carries no description)", () => {
	assert.throws(() => assertTranscriptRecord(rollingRecord({ description: "no" })), /event records only/);
});

test("absence of text is ALWAYS an explicit state, never a missing field", () => {
	// no-speech records carry text EXACTLY null.
	assert.doesNotThrow(() => assertTranscriptRecord(rollingRecord({ text: null, state: "no-speech" })));
	assert.throws(() => assertTranscriptRecord(rollingRecord({ text: "x", state: "no-speech" })), /exactly null/);
	assert.throws(() => assertTranscriptRecord(rollingRecord({ text: undefined, state: "text" })), /state is "text"/);
	// partial carries its explicit reason (never-truncate-silently).
	assert.throws(
		() => assertTranscriptRecord(rollingRecord({ text: "partial words", status: undefined, state: "partial" })),
		/partial/,
	);
	const ok = assertTranscriptRecord(rollingRecord({ text: null, state: "partial", partial: { completedChunks: 0, totalChunks: 1, reason: "provider died" } }));
	assert.equal(ok.partial.reason, "provider died");
});

test("records persist across a fresh store instance (config survives)", (t) => {
	const tree = tempTree();
	t.after(tree.cleanup);
	const store = new TranscriptStore({ root: tree.root });
	store.put(eventRecord());
	store.put(rollingRecord({ text: null, state: "no-speech" }));
	const reopened = new TranscriptStore({ root: tree.root });
	assert.equal(reopened.list().length, 2);
	const got = reopened.get("cam-front", "event", "event-cam-front-evn_1");
	assert.equal(got.text, "hello from the porch");
	assert.equal(reopened.get("cam-front", "rolling", "missing"), null);
});

test("put is idempotent per sourceRef (re-transcription replaces in place)", (t) => {
	const tree = tempTree();
	t.after(tree.cleanup);
	const store = new TranscriptStore({ root: tree.root });
	store.put(rollingRecord());
	store.put(rollingRecord({ text: "corrected words" }));
	assert.equal(store.list().length, 1);
	assert.equal(store.list()[0].text, "corrected words");
});

test("dropDates removes whole days and reports the record count", (t) => {
	const tree = tempTree();
	t.after(tree.cleanup);
	const store = new TranscriptStore({ root: tree.root });
	// Two cameras same day + a record on another day (1765022400 = a later UTC day).
	store.put(rollingRecord());
	store.put(rollingRecord({ cameraId: "cam-side", sourceRef: "window-cam-side-1" }));
	store.put(rollingRecord({ startOffset: 1765022400, endOffset: 1765022460, sourceRef: "window-cam-front-later" }));
	assert.equal(store.dropDates("rolling", [dateKeyOf(1764244800 * 1000)]), 2);
	assert.equal(store.list().length, 1);
	// Dropping an empty day removes nothing and reports zero.
	assert.equal(store.dropDates("rolling", ["2099-01-01"]), 0);
});
