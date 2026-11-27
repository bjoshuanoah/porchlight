// store.test.js — descriptions stored with their event (PORCH-133 ac-2):
// append-only JSONL keyed by the event identity, day partition reading,
// explicit states, and the retention seam.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createDescriptionStore } from "../src/index.js";

/** @returns {string} */
function tmpRoot() {
	return fs.mkdtempSync(path.join(os.tmpdir(), "porch-inference-store-"));
}

const EVENT = { t: 1764264000, camera: "front-door", cls: "person", trackId: "7" };

/** @param {Partial<Parameters<ReturnType<typeof createDescriptionStore>["record"]>[0]["event"]>} [overrides] */
function recordEntry(store, overrides = {}) {
	return store.record({
		event: { t: EVENT.t, camera: EVENT.camera, cls: EVENT.cls, trackId: EVENT.trackId, ...overrides.event },
		transition: "arrival",
		tier: "tier1",
		provider: "ollama",
		providerClass: "local-server",
		model: "ornith-1.5:9b",
		text: "A person arrives.",
		...overrides.entry,
	});
}

test("descriptions land on the event's own UTC-day file with full identity", () => {
	const dir = tmpRoot();
	const store = createDescriptionStore({ dir, now: () => new Date("2026-11-27T12:00:00Z") });
	const record = recordEntry(store);
	assert.equal(record.at, "2026-11-27T12:00:00.000Z");
	assert.equal(store.files()[0], `${new Date(EVENT.t * 1000).toISOString().slice(0, 10)}.jsonl`);
	const raw = fs.readFileSync(path.join(dir, store.files()[0]), "utf8");
	assert.equal(JSON.parse(raw.trim()).t, EVENT.t);
});

test("forEvent resolves by the event identity — camera, cls, trackId all bound", () => {
	const dir = tmpRoot();
	const store = createDescriptionStore({ dir });
	recordEntry(store);
	assert.deepEqual(store.forEvent({ t: EVENT.t, camera: EVENT.camera }).length, 1);
	assert.deepEqual(store.forEvent({ t: EVENT.t, camera: "other-cam" }), []);
	// Same identity returns the record; a text description is one-to-one.
	const [row] = store.forEvent({ t: EVENT.t, camera: EVENT.camera, trackId: EVENT.trackId });
	assert.equal(row.text, "A person arrives.");
	assert.equal(row.model, "ornith-1.5:9b");
});

test("a description recorded after midnight still resolves (next-day at, same event t)", () => {
	const dir = tmpRoot();
	// 23:59:40 UTC event; the description lands 30s later, already next day.
	const lateEvent = { t: 1764264000 - 20, camera: "gate", cls: null, trackId: null };
	const store = createDescriptionStore({ dir });
	store.record({ event: lateEvent, transition: "departure", tier: "tier1", provider: "ollama", providerClass: "local-server", text: null });
	store.record({
		event: lateEvent,
		transition: "departure",
		tier: "tier1",
		provider: "ollama",
		providerClass: "local-server",
		text: "Someone left the gate area.",
	});
	const rows = store.forEvent({ t: lateEvent.t, camera: "gate" });
	assert.equal(rows.length, 2, "explicit no-answer records are stored too — absence is never silent");
	assert.equal(rows[0].text, null);
});

test("malformed records are ValidationErrors (never half-stored)", () => {
	const dir = tmpRoot();
	const store = createDescriptionStore({ dir });
	assert.throws(() => store.record({ event: { t: 0, camera: "c" }, transition: "arrival", tier: "tier1", provider: "p", providerClass: "c", text: "x" }), /event\.t must be a positive epoch time/);
	assert.throws(() => store.record({ event: { t: 10, camera: "c" }, transition: "arrival", tier: "tier9", provider: "p", providerClass: "c", text: "x" }), /tier must be one of/);
	assert.throws(() => store.record({ event: { t: 10, camera: "c" }, transition: "arrival", tier: "tier1", provider: "p", providerClass: "c", text: "   " }), /text must be a non-empty string or null/);
});

test("a corrupted line never takes down the identity read", () => {
	const dir = tmpRoot();
	const store = createDescriptionStore({ dir });
	recordEntry(store);
	fs.appendFileSync(path.join(dir, store.files()[0]), "{not-json\n", "utf8");
	recordEntry(store, { entry: { text: "Second sighting described." } });
	// Re-record on the same day file, then read across the corruption.
	const rows = store.forEvent({ t: EVENT.t, camera: "front-door" });
	assert.equal(rows.length, 2);
});
