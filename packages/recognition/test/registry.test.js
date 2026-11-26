// registry.test.js — PORCH-141 ac-1/ac-3/ac-5/ac-6 store law: enrollment
// shape, rename-by-reference, the deletion purge (descriptors, plate reads,
// sighting history, annotations gone; audits count what went away), the
// household export, and the opt-in switch of record.

import { test } from "node:test";
import assert from "node:assert/strict";

import { createMemoryStore } from "@porchlight/shared";

import { AUDIT_TYPES, createRegistryService } from "../src/registry.js";

/** In-memory store + audit trail; the same shape the hub mounts. */
function fixture() {
	const auditRows = [];
	const audit = {
		record(row) {
			auditRows.push(row);
			return row;
		},
	};
	const registry = createRegistryService({ store: createMemoryStore(), audit });
	return { registry, auditRows };
}

const FACE_DESCRIPTOR = [0.9, 0.1, 0];
const OTHER_DESCRIPTOR = [0.05, 0.8, 0.4];

test("settingsOf: a household that never opted in reads disabled (opt-in default)", async () => {
	const { registry } = fixture();
	const settings = await registry.settingsOf("home-1");
	assert.equal(settings.enabled, false);
	// Uncalibrated: the threshold of record is null — matching fails toward
	// uncertainty until calibration lands.
	assert.equal(settings.assertThreshold, null);
});

test("ac-6 toggle of record: on/off persist, land in audit, resume without re-enrollment", async () => {
	const { registry, auditRows } = fixture();
	await registry.enroll({ homeId: "home-1", kind: "face", name: "Mom", descriptors: [FACE_DESCRIPTOR] });
	await registry.setEnabled({ homeId: "home-1", enabled: true, actorDid: "did:owner" });
	assert.equal((await registry.settingsOf("home-1")).enabled, true);
	await registry.setEnabled({ homeId: "home-1", enabled: false, actorDid: "did:owner" });
	assert.equal((await registry.settingsOf("home-1")).enabled, false);
	// Nothing was deleted on off — the entry and its history still render.
	const entries = await registry.listEntries("home-1");
	assert.equal(entries.length, 1);
	assert.equal(entries[0].name, "Mom");
	await registry.setEnabled({ homeId: "home-1", enabled: true, actorDid: "did:owner" });
	const toggles = auditRows.filter((row) => row.type === AUDIT_TYPES.TOGGLE);
	assert.equal(toggles.length, 3);
	assert.deepEqual(toggles.map((row) => row.detail.to), [true, false, true]);
	assert.equal(toggles[0].actorIdentityRef, "did:owner");
});

test("setEnabled refuses a non-boolean switch", async () => {
	const { registry } = fixture();
	await assert.rejects(
		registry.setEnabled({ homeId: "home-1", enabled: /** @type {any} */ ("yes") }),
		/on or off/,
	);
});

test("ac-1 enroll a face entry with local descriptors", async () => {
	const { registry, auditRows } = fixture();
	const entry = await registry.enroll({
		homeId: "home-1",
		kind: "face",
		name: "Mom",
		descriptors: [FACE_DESCRIPTOR],
		actorDid: "did:owner",
	});
	assert.equal(entry.kind, "face");
	assert.equal(entry.name, "Mom");
	assert.deepEqual(entry.descriptors, [FACE_DESCRIPTOR]);
	assert.ok(String(entry._id).startsWith("fce_"));
	assert.equal(auditRows.at(-1).type, AUDIT_TYPES.ENROLL);
});

test("ac-1 enroll a vehicle with a plate read; plate shape enforced", async () => {
	const { registry } = fixture();
	const entry = await registry.enroll({
		homeId: "home-1",
		kind: "vehicle",
		name: "Dad's truck",
		descriptors: [[0.2, 0.9, 0]],
		plateText: "6tri889",
	});
	assert.equal(entry.kind, "vehicle");
	assert.equal(entry.plateText, "6TRI889");
	await assert.rejects(() =>
		registry.enroll({ homeId: "home-1", kind: "vehicle", name: "Bad", descriptors: [], plateText: "not a plate!" }),
	);
});

test("ac-1 visit-enrolled face carries the enrolledFor marker + accountability note", async () => {
	const { registry } = fixture();
	const entry = await registry.enroll({
		homeId: "home-1",
		kind: "face",
		name: "Visitor Sam",
		descriptors: [FACE_DESCRIPTOR],
		enrolledFor: "visit",
		accountabilityNote: "Enrolled by Dad for the weekend visit",
	});
	assert.equal(entry.enrolledFor, "visit");
	assert.equal(entry.accountabilityNote, "Enrolled by Dad for the weekend visit");
	await assert.rejects(() =>
		registry.enroll({ homeId: "home-1", kind: "face", name: "NoNote", descriptors: [FACE_DESCRIPTOR], enrolledFor: "visit" }),
		/accountability note/,
	);
});

test("rename-by-reference: updating the name needs no annotation rewrite", async () => {
	const { registry } = fixture();
	const entry = await registry.enroll({ homeId: "home-1", kind: "face", name: "Mom", descriptors: [FACE_DESCRIPTOR] });
	await registry.annotate({
		homeId: "home-1",
		entryId: entry._id,
		targetKind: "event",
		targetId: "evn_1",
		cameraId: "cam-a",
		trackId: "t-1",
		confidence: 0.97,
		decision: "asserted",
	});
	const renamed = await registry.updateEntry({ homeId: "home-1", entryId: entry._id, name: "Dr. Mom" });
	assert.equal(renamed.name, "Dr. Mom");
	// The annotation still points at the entry: rendering resolves the NEW
	// name from the reference (rename renames history).
	const [note] = await registry.listAnnotations({ homeId: "home-1", targetId: "evn_1" });
	assert.equal(note.entryId, entry._id);
	assert.deepEqual(await registry.listAnnotations({ homeId: "home-1", entryId: entry._id }), [note]);
});

test("recordSighting appends history bounded by the cap", async () => {
	const { registry } = fixture();
	const entry = await registry.enroll({ homeId: "home-1", kind: "face", name: "Mom", descriptors: [FACE_DESCRIPTOR] });
	for (let i = 0; i < 210; i += 1) {
		await registry.recordSighting("home-1", entry._id, { at: i, cameraId: "cam-a", trackId: `t-${i}` });
	}
	const stored = await registry.getEntry("home-1", entry._id);
	assert.equal(stored.sightings.length, 200);
	assert.equal(stored.sightings[0].at, 10);
});

test("ac-3 the deletion purge: descriptors, plate reads, sighting history, and annotations are purged; audit counts", async () => {
	const { registry, auditRows } = fixture();
	const vehicle = await registry.enroll({
		homeId: "home-1",
		kind: "vehicle",
		name: "Dad's truck",
		descriptors: [[0.2, 0.9, 0]],
		plateText: "6TRI889",
	});
	await registry.recordSighting("home-1", vehicle._id, { at: 50, cameraId: "cam-a", trackId: "t-9" });
	await registry.annotate({
		homeId: "home-1",
		entryId: vehicle._id,
		targetKind: "event",
		targetId: "evn_2",
		cameraId: "cam-a",
		trackId: "t-9",
		confidence: 0.99,
		decision: "asserted",
	});
	const purged = await registry.purgeEntry({ homeId: "home-1", entryId: vehicle._id, actorDid: "did:owner" });
	assert.deepEqual(purged.purged, {
		entryId: vehicle._id,
		descriptorVectors: 1,
		plateReads: 1,
		sightings: 1,
		annotations: 1,
	});
	await assert.rejects(() => registry.getEntry("home-1", vehicle._id), { code: "E_NOT_FOUND" });
	assert.deepEqual(await registry.listAnnotations({ homeId: "home-1" }), []);
	const purgeRow = auditRows.find((row) => row.type === AUDIT_TYPES.PURGE);
	assert.ok(purgeRow);
	assert.deepEqual(purgeRow.detail, {
		entryId: vehicle._id,
		kind: "vehicle",
		name: "Dad's truck",
		descriptors: 1,
		plateReads: 1,
		sightings: 1,
		annotations: 1,
	});
});

test("ac-3 annotations on past events degrade to factual: only the annotation row is removed", async () => {
	const { registry } = fixture();
	const entry = await registry.enroll({ homeId: "home-1", kind: "face", name: "Mom", descriptors: [FACE_DESCRIPTOR] });
	await registry.annotate({
		homeId: "home-1",
		entryId: entry._id,
		targetKind: "event",
		targetId: "evn_3",
		confidence: 0.9,
		decision: "looks-like",
	});
	// Other annotations (a different entry) survive the purge untouched.
	const other = await registry.enroll({ homeId: "home-1", kind: "face", name: "Dad", descriptors: [OTHER_DESCRIPTOR] });
	await registry.annotate({
		homeId: "home-1",
		entryId: other._id,
		targetKind: "event",
		targetId: "evn_3",
		confidence: 0.8,
		decision: "looks-like",
	});
	await registry.purgeEntry({ homeId: "home-1", entryId: entry._id });
	const remaining = await registry.listAnnotations({ homeId: "home-1", targetId: "evn_3" });
	assert.equal(remaining.length, 1);
	assert.equal(remaining[0].entryId, other._id);
});

test("ac-3 the household export: every entry with descriptors, plate reads, and sightings", async () => {
	const { registry } = fixture();
	await registry.enroll({
		homeId: "home-1",
		kind: "vehicle",
		name: "Dad's truck",
		descriptors: [[0.2, 0.9, 0]],
		plateText: "6TRI889",
	});
	const face = await registry.enroll({ homeId: "home-2", kind: "face", name: "Neighbor", descriptors: [OTHER_DESCRIPTOR] });
	await registry.recordSighting("home-2", face._id, { at: 100, cameraId: "cam-b", trackId: "t-2" });
	const export1 = await registry.exportRegistry("home-1");
	assert.equal(export1.formatName, "porchlight-recognition-registry/1");
	assert.equal(export1.entries.length, 1);
	assert.equal(export1.entries[0].plateText, "6TRI889");
	const export2 = await registry.exportRegistry("home-2");
	assert.equal(export2.entries.length, 1);
	assert.equal(export2.entries[0].sightings.length, 1);
	assert.equal(export2.entries[0].descriptors.length, 1);
	// Settings ride the bundle too (the switch + calibration of record).
	assert.equal(export1.settings.enabled, false);
});

test("annotate validates shape; annotations list filters", async () => {
	const { registry } = fixture();
	const entry = await registry.enroll({ homeId: "home-1", kind: "face", name: "Mom", descriptors: [FACE_DESCRIPTOR] });
	await registry.annotate({
		homeId: "home-1",
		entryId: entry._id,
		targetKind: "track",
		targetId: "t-5",
		cameraId: "cam-a",
		trackId: "t-5",
		confidence: 0.7,
		decision: "looks-like",
	});
	await assert.rejects(() =>
		registry.annotate({ homeId: "home-1", entryId: entry._id, targetKind: /** @type {any} */ ("blog"), targetId: "x", confidence: 0.5, decision: "asserted" }),
	);
	await assert.rejects(() =>
		registry.annotate({ homeId: "home-1", entryId: entry._id, targetKind: "track", targetId: "x", confidence: /** @type {any} */ ("high"), decision: "asserted" }),
	);
	const forTrack = await registry.listAnnotations({ homeId: "home-1", trackId: "t-5" });
	assert.equal(forTrack.length, 1);
	assert.equal(forTrack[0].decision, "looks-like");
});
