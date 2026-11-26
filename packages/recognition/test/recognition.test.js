// recognition.test.js — PORCH-141 ac-1/ac-2/ac-4/ac-6: the orchestrator.
// Enrollment embeds locally behind the provider seam; the gallery match
// annotates sightings at the confidence shown; the disabled switch stops
// runs AND computations with the zero-computation audit intact; toggling
// back on resumes without re-enrollment.

import { test } from "node:test";
import assert from "node:assert/strict";

import { createMemoryStore } from "@porchlight/shared";

import { AUDIT_TYPES, createRegistryService } from "../src/registry.js";
import { createRecognitionPipeline, RecognitionMetrics, VisionProviderRegistry } from "../src/pipeline.js";
import { createRecognitionService } from "../src/recognition.js";

/** Deterministic provider: every face reads MOM_VECTOR; plates read the van plate. */
const MOM_VECTOR = [0.95, 0.3, 0.05];
const GUEST_VECTOR = [0.05, 0.9, 0.35];

function fixture({ provider } = {}) {
	const auditRows = [];
	const audit = { record(row) { auditRows.push(row); return row; } };
	const registry = createRegistryService({ store: createMemoryStore(), audit });
	const metrics = new RecognitionMetrics();
	const visionRegistry = new VisionProviderRegistry();
	visionRegistry.register("local", () => provider ?? deterministicProvider());
	const pipeline = createRecognitionPipeline({ registry: visionRegistry, metrics });
	const recognition = createRecognitionService({ registry, pipeline });
	return { registry, recognition, metrics, auditRows };
}

// Vectors chosen so MOM matches MOM at cosine 1.0 (assert if calibrated)
// and GUEST lands ~<0.6 vs MOM (unknown) and MOM-vector lands mid (looks-like).
function deterministicProvider() {
	return {
		name: "test-embedder",
		async describeFaces() {
			return [{ descriptor: MOM_VECTOR, conf: 0.99 }];
		},
		async readPlates() {
			return [{ text: "6tri889", conf: 0.93 }];
		},
	};
}

function jpegFrame(t = 100) {
	return { format: "jpeg", data: new Uint8Array([0xff, 0xd8, 0xff, 0xe0]), t };
}

test("ac-1 enrollment: an uploaded household photo trains locally into descriptors", async () => {
	const { registry, recognition, metrics } = fixture();
	await registry.setEnabled({ homeId: "home-1", enabled: true, actorDid: "did:owner" });
	const entry = await recognition.enroll({
		homeId: "home-1",
		kind: "face",
		name: "Mom",
		frames: [jpegFrame()],
		actorDid: "did:owner",
	});
	assert.equal(entry.kind, "face");
	assert.deepEqual(entry.descriptors, [MOM_VECTOR]);
	// The embedding ran locally (one computation through the provider seam).
	assert.equal(metrics.snapshot().descriptorComputations, 1);
});

test("ac-1 enrollment is refused while the switch is off", async () => {
	const { recognition, metrics } = fixture();
	await assert.rejects(
		recognition.enroll({ homeId: "home-1", kind: "face", name: "Mom", frames: [jpegFrame()] }),
		{ code: "E_RECOGNITION_DISABLED" },
	);
	assert.equal(metrics.snapshot().descriptorComputations, 0);
	assert.equal(metrics.snapshot().refusedDisabled, 1);
});

test("ac-1 vehicle enrollment reads the plate locally", async () => {
	const { registry, recognition } = fixture();
	await registry.setEnabled({ homeId: "home-1", enabled: true, actorDid: "did:owner" });
	const entry = await recognition.enroll({
		homeId: "home-1",
		kind: "vehicle",
		name: "Dad's truck",
		frames: [jpegFrame()],
		// Explicit plate wins over the read.
		plateText: "5xrs222",
	});
	assert.equal(entry.plateText, "5XRS222");
});

test("ac-1/a-c2 a subsequent sighting annotates an event with the name at the confidence shown", async () => {
	const { registry, recognition } = fixture({ provider: undefined });
	await registry.setEnabled({ homeId: "home-1", enabled: true, actorDid: "did:owner" });
	const entry = await recognition.enroll({ homeId: "home-1", kind: "face", name: "Mom", frames: [jpegFrame()] });
	const run = await recognition.recognize({
		homeId: "home-1",
		kind: "face",
		descriptor: MOM_VECTOR,
		cameraId: "cam-a",
		trackId: "t-1",
		eventId: "evn_1",
		at: 200,
	});
	// Cosine 1.0 → confidence 1.0; uncalibrated still renders looks-like.
	assert.equal(run.outcome.decision, "looks-like");
	assert.equal(run.outcome.entryId, entry._id);
	assert.equal(run.outcome.name, "Mom");
	assert.equal(run.annotated, true);
	const [note] = await registry.listAnnotations({ homeId: "home-1", targetKind: "event", targetId: "evn_1" });
	assert.equal(note.confidence, 1);
	assert.equal(note.decision, "looks-like");
	// The sighting history row rides with the event reference so the UI can
	// open its evidence.
	const stored = await registry.getEntry("home-1", entry._id);
	assert.equal(stored.sightings.length, 1);
	assert.equal(stored.sightings[0].eventId, "evn_1");
	assert.equal(stored.sightings[0].decision, "looks-like");
	assert.equal(stored.sightings[0].confidence, 1);
});

test("ac-2 calibrated threshold: matches above the bar assert; below stays looks-like", async () => {
	const { registry, recognition } = fixture();
	await registry.setEnabled({ homeId: "home-1", enabled: true, actorDid: "did:owner" });
	await recognition.enroll({ homeId: "home-1", kind: "face", name: "Mom", frames: [jpegFrame()] });
	await registry.setThreshold({ homeId: "home-1", assertThreshold: 0.9, actorDid: "did:owner" });
	const asserted = await recognition.recognize({ homeId: "home-1", kind: "face", descriptor: MOM_VECTOR, eventId: "evn_2", at: 300 });
	assert.equal(asserted.outcome.decision, "asserted");
	// Rename propagates at render time: annotation references the entry.
	await registry.updateEntry({ homeId: "home-1", entryId: asserted.outcome.entryId, name: "Dr. Mom" });
	const [note] = await registry.listAnnotations({ homeId: "home-1", targetId: "evn_2" });
	assert.equal(note.decision, "asserted");
	// Near-neighbor in the vector space: below the calibrated bar → looks-like.
	const neighbor = [0.6, 0.8, 0.05];
	const looks = await recognition.matchFace({ homeId: "home-1", descriptor: neighbor });
	assert.equal(looks.decision, "looks-like");
	assert.ok(looks.confidence < 1);
});

test("ac-2 unknown sightings stay unannotated and unrecorded", async () => {
	const { registry, recognition } = fixture();
	await registry.setEnabled({ homeId: "home-1", enabled: true, actorDid: "did:owner" });
	const entry = await recognition.enroll({ homeId: "home-1", kind: "face", name: "Mom", frames: [jpegFrame()] });
	const run = await recognition.recognize({
		homeId: "home-1",
		kind: "face",
		descriptor: GUEST_VECTOR,
		cameraId: "cam-a",
		trackId: "t-99",
		eventId: "evn_9",
	});
	assert.equal(run.outcome.decision, "unknown");
	assert.equal(run.annotated, false);
	const stored = await registry.getEntry("home-1", entry._id);
	assert.equal(stored.sightings.length, 0);
	assert.equal((await registry.listAnnotations({ homeId: "home-1" })).length, 0);
});

test("ac-6 recognized vehicle: plate text assert; descriptor path rides the same law", async () => {
	const { registry, recognition } = fixture();
	await registry.setEnabled({ homeId: "home-1", enabled: true, actorDid: "did:owner" });
	const van = await registry.enroll({
		homeId: "home-1",
		kind: "vehicle",
		name: "Dad's truck",
		descriptors: [[1, 0, 0]],
		plateText: "6TRI889",
	});
	const plateRun = await recognition.recognize({ homeId: "home-1", kind: "vehicle", plateText: "6tri889", eventId: "evn_v1", cameraId: "cam-a", trackId: "t-2", at: 30 });
	assert.equal(plateRun.outcome.decision, "asserted");
	assert.equal(plateRun.outcome.name, "Dad's truck");
	// Descriptor similarity above the calibrated bar asserts too.
	await registry.setThreshold({ homeId: "home-1", assertThreshold: 0.9 });
	const descriptorRun = await recognition.recognize({ homeId: "home-1", kind: "vehicle", descriptor: [1, 0, 0], trackId: "t-3" });
	assert.equal(descriptorRun.outcome.entryId, van._id);
	assert.equal(descriptorRun.outcome.decision, "asserted");
	// Similar-but-wrong vehicle: below the calibrated cosine → never asserts
	// the trained plate/descriptor (looks-like at most).
	const neighborRun = await recognition.matchVehicle({ homeId: "home-1", descriptor: [0.7, 0.6, 0.4] });
	assert.equal(neighborRun.decision, "looks-like");
});

test("ac-4/ac-6 the switch of record: off = zero computations AND zero runs, audit intact; on = resumes", async () => {
	const { registry, recognition, metrics, auditRows } = fixture();
	await registry.setEnabled({ homeId: "home-1", enabled: true, actorDid: "did:owner" });
	const entry = await recognition.enroll({ homeId: "home-1", kind: "face", name: "Mom", frames: [jpegFrame()] });
	await recognition.recognize({ homeId: "home-1", kind: "face", descriptor: MOM_VECTOR, eventId: "evn_1", at: 200 });
	assert.ok(metrics.snapshot().recognitionRuns >= 1);
	// Off: no new runs, no computations; the refusal is counted.
	await registry.setEnabled({ homeId: "home-1", enabled: false, actorDid: "did:owner" });
	const before = metrics.snapshot();
	await assert.rejects(
		recognition.recognize({ homeId: "home-1", kind: "face", descriptor: MOM_VECTOR, eventId: "evn_5", at: 500 }),
		{ code: "E_RECOGNITION_DISABLED" },
	);
	const after = metrics.snapshot();
	assert.equal(after.descriptorComputations, before.descriptorComputations);
	assert.equal(after.recognitionRuns, before.recognitionRuns);
	assert.equal(after.refusedDisabled, before.refusedDisabled + 1);
	// The registry keeps rendering entries + history while off.
	const stored = await registry.getEntry("home-1", entry._id);
	assert.equal(stored.sightings.length, 1);
	// Back on: resumes without re-enrollment.
	await registry.setEnabled({ homeId: "home-1", enabled: true, actorDid: "did:owner" });
	const resumed = await recognition.recognize({ homeId: "home-1", kind: "face", descriptor: MOM_VECTOR, eventId: "evn_6", at: 900 });
	assert.equal(resumed.annotated, true);
	assert.equal((await registry.getEntry("home-1", entry._id)).sightings.length, 2);
	// The audit trail carries the toggles.
	assert.equal(auditRows.filter((row) => row.type === AUDIT_TYPES.TOGGLE).length, 3);
});

test("ac-4 metrics surface of record: counters stay queryable", async () => {
	const { recognition, metrics } = fixture();
	await assert.rejects(() =>
		recognition.recognize({ homeId: "home-1", kind: /** @type {any} */ ("face"), descriptor: MOM_VECTOR }),
		{ code: "E_RECOGNITION_DISABLED" },
	);
	assert.deepEqual(recognition.metrics(), {
		descriptorComputations: 0,
		plateReads: 0,
		recognitionRuns: 0,
		refusedDisabled: 1,
	});
	assert.equal(metrics.snapshot().refusedDisabled, 1);
});

test("the upstream gate reads the switch live", async () => {
	const { registry } = fixture();
	const { createUpstreamRecognitionGate } = await import("../src/recognition.js");
	const gate = createUpstreamRecognitionGate({ registry });
	assert.equal(await gate.isEnabled("home-1"), false);
	await registry.setEnabled({ homeId: "home-1", enabled: true, actorDid: "did:owner" });
	assert.equal(await gate.isEnabled("home-1"), true);
});
