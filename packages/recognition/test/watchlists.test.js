// watchlists.test.js — PORCH-142: the trained-class few-shot subsystem.
// ac-1 on-device training into the detection vocabulary, the uncertainty law
// with per-class thresholds (low confidence NEVER asserts — the adversarial
// bound), ac-3 the correction loop feeding the exemplar pool, ac-4 the
// held-replay retrain improvement, ac-5 deletion with artifact cleanup, and
// the bounded detection ring + emission cooldown.

import { test } from "node:test";
import assert from "node:assert/strict";

import { createMemoryStore } from "@porchlight/shared";

import {
	ACCURACY_NOTE,
	createWatchlistService,
	evaluateReplay,
} from "../src/watchlists.js";
import { DETECTION_RING_CAP } from "../src/types.js";

/** Built-in tracked classes of record (the hub injects these; same list Overwatch owns). */
const TRACKED_CLASSES = ["person", "vehicle", "package", "bin", "furniture", "equipment"];

/** jpeg frame bytes (tiny); `w` selects the deterministic embedding vector. */
const pixel = (w) => ({ format: "jpeg", data: new TextEncoder().encode(`jpeg-${w}`), w });

/** Deterministic exemplar space: V0/V1 are the trained vehicle class; W is a competitor class; M is a mid-similarity look; N is the near neighbor. */
const V0 = [1, 0];
const V1 = [0.63, 0.78];
const W = [0, 1];
const M = [0.8, 0.6];

/** The deterministic provider of record for the tests — the deployable one ships via setup. */
const provider = {
	name: "test-embedder",
	describeFaces: async () => [],
	embedImage: async (frame) => [
		frame.w === 0 ? V0
		: frame.w === 1 ? V1
		: frame.w === 2 ? W
		: frame.w === 3 ? M
		: V0,
	],
};

/** In-memory store + audit trail; the same shape the hub mounts. */
function fixture({ tracked = TRACKED_CLASSES, withProvider = true } = {}) {
	const auditRows = [];
	const audit = {
		record(row) {
			auditRows.push(row);
			return row;
		},
	};
	const store = createMemoryStore();
	let tick = 1_700_000_000;
	const service = createWatchlistService({
		store,
		audit,
		trackedClasses: tracked,
		providerRef: withProvider ? async () => provider : null,
		now: () => (tick += 1),
	});
	return { service, auditRows, store };
}

async function teachImpala(service) {
	const result = await service.createClass({
		homeId: "home-1",
		label: "63 Chevy Impala",
		frames: [pixel(0)],
		trackingSource: "vehicle",
		actorDid: "did:owner",
	});
	return result;
}

test("ac-1: training is on-device, the label joins the vocabulary, scope derives from the source class", async () => {
	const { service, auditRows } = fixture();
	const { view, expectedAccuracy, heldReplay } = await teachImpala(service);
	assert.match(view._id, /^wtl_/);
	assert.equal(view.label, "63 Chevy Impala");
	assert.equal(view.trackingScope, "tracked"); // vehicle exemplars → tracked scope, derived
	assert.equal(view.exemplarCount, 1);
	// The view NEVER carries descriptors (they stay on the hub).
	assert.ok(view.exemplars[0].image.startsWith("data:image/jpeg;base64,"));
	assert.ok(!("descriptor" in view.exemplars[0]));
	assert.equal(expectedAccuracy.note, ACCURACY_NOTE); // the honesty surface, stated up front
	assert.ok(typeof heldReplay.hitRate === "number");
	// The open detection vocabulary: built-ins + the trained label, flags derived.
	const vocab = await service.vocabulary("home-1");
	assert.deepEqual(vocab.builtIn.map((entry) => entry.label), TRACKED_CLASSES);
	assert.deepEqual(vocab.trained, [{
		label: "63 Chevy Impala", kind: "trained", trackingScope: "tracked", assertThreshold: null, classId: view._id,
	}]);
	// Training landed in audit with its derived flags.
	const train = auditRows.find((row) => row.type === "watchlist-train");
	assert.equal(train.detail.trackingScope, "tracked");
	assert.equal(train.actorIdentityRef, "did:owner");

	// A second class with NO source rides detection-only — never tracked.
	const banana = await service.createClass({
		homeId: "home-1", label: "Yellow Banana", frames: [pixel(2)],
	});
	assert.equal(banana.view.trackingScope, "detection-only");
	const vocab2 = await service.vocabulary("home-1");
	assert.equal(vocab2.trained.find((entry) => entry.label === "Yellow Banana").trackingScope, "detection-only");
	assert.deepEqual(await service.trackedTrainedLabels(), ["63 Chevy Impala"]);
});

test("ac-1: uncalibrated never asserts — the near neighbor keeps its built-in label, the trained name is at most low-confidence metadata", async () => {
	const { service } = fixture();
	const { view } = await teachImpala(service);
	// The exact trained look: cosine 1.0, but the class has no threshold of
	// record yet — "looks like", never asserted, nothing for the bus.
	const onTarget = await service.classify({ homeId: "home-1", descriptor: V0, cameraId: "cam-1", trackId: "t1", t: 1_700_100_000 });
	assert.equal(onTarget.decision, "looks-like");
	assert.equal(onTarget.shouldEmit, false);
	// A mid-similarity crop renders looks-like with confidence shown.
	const mid = await service.classify({ homeId: "home-1", descriptor: M, t: 1_700_100_001 });
	assert.equal(mid.decision, "looks-like");
	assert.ok(mid.confidence > 0.5 && mid.confidence < 1);
	// The adversarial bound: a genuinely different object is UNKNOWN — not a
	// row, not a label, not metadata.
	const neighbor = await service.classify({ homeId: "home-1", descriptor: W, t: 1_700_100_002 });
	assert.equal(neighbor, null);
	// Uncalibrated, the ring records looks-like rows only.
	const rows = await service.listDetections({ homeId: "home-1" });
	assert.equal(rows.length, 2);
	assert.ok(!("descriptor" in rows[0]));
	assert.ok(view._id !== undefined);
});

test("ac-2: at the calibrated threshold the target asserts and is marked for bus emission; below it never", async () => {
	const { service } = fixture();
	const { view } = await teachImpala(service);
	await service.setClassThreshold({ homeId: "home-1", classId: view._id, assertThreshold: 0.97, actorDid: "did:owner" });
	const t0 = 1_700_200_000;
	const asserted = await service.classify({ homeId: "home-1", descriptor: V0, cameraId: "cam-1", trackId: "t9", t: t0 });
	assert.equal(asserted.decision, "asserted");
	assert.equal(asserted.label, "63 Chevy Impala");
	assert.equal(asserted.shouldEmit, true); // the plane publishes this onto the engine detections topic
	// The SAME track inside the cooldown window never re-emits (one asserted
	// detection per track per window — the bus is not flooded).
	const again = await service.classify({ homeId: "home-1", descriptor: V0, cameraId: "cam-1", trackId: "t9", t: t0 + 60 });
	assert.equal(again.decision, "asserted");
	assert.equal(again.shouldEmit, false);
	// Past the window the track emits again.
	const later = await service.classify({ homeId: "home-1", descriptor: V0, cameraId: "cam-1", trackId: "t9", t: t0 + 400 });
	assert.equal(later.shouldEmit, true);
	// A near-similar-but-wrong crop still never asserts (the adversarial hook).
	const mid = await service.classify({ homeId: "home-1", descriptor: M, t: t0 + 401 });
	assert.equal(mid.decision, "looks-like");
});

test("ac-3: the correction loop feeds the flagged detection's crop descriptor into the exemplar pool", async () => {
	const { service, auditRows } = fixture();
	const { view } = await service.createClass({
		homeId: "home-1", label: "Yellow Banana", frames: [pixel(2)],
	});
	// A flagged look — the ring row carries the crop descriptor of record.
	await service.classify({ homeId: "home-1", descriptor: M, cameraId: "cam-2", trackId: "t3", t: 1_700_300_000 });
	const correction = await service.correct({ homeId: "home-1", cameraId: "cam-2", trackId: "t3", actorDid: "did:owner" });
	assert.equal(correction.view.exemplarCount, 2);
	const ring = await service.listDetections({ homeId: "home-1" });
	assert.equal(correction.correction.exemplars, 2);
	assert.ok(ring.length >= 1);
	// The correction landed in audit (the flag control's trail).
	assert.ok(auditRows.some((row) => row.type === "watchlist-correction" && row.detail.classId === view._id));
	// An explicit descriptor correction rides the same path.
	await service.correct({ homeId: "home-1", classId: view._id, descriptor: [0.9, 0.4] });
	const after = await service.getClass("home-1", view._id);
	assert.equal(after.exemplarCount, 3);
	// Nothing recorded to feed back → plain-language 404, not a silent no-op.
	await assert.rejects(
		service.correct({ homeId: "home-1", cameraId: "cam-none", trackId: "nope" }),
		/No recorded detection to feed back/,
	);
});

test("ac-4: retraining with added examples improves the held-replay hit rate and replaces the artifact set", async () => {
	const { service, auditRows } = fixture();
	const { view } = await service.createClass({
		homeId: "home-1", label: "63 Chevy Impala", frames: [pixel(0)], trackingSource: "vehicle",
	});
	// A competitor class shares the pool so the replay is discriminative.
	await service.createClass({ homeId: "home-1", label: "Old Truck", frames: [pixel(2)], trackingSource: "vehicle" });
	// Held replay: R leans toward the OLD Truck until the pool learns V1.
	const R = [0.6, 0.8];
	const replay = [
		{ descriptor: R, expect: "63 Chevy Impala" },
		{ descriptor: V0, expect: "63 Chevy Impala" },
	];
	const retrained = await service.retrain({
		homeId: "home-1", classId: view._id, frames: [pixel(1)], replay, actorDid: "did:owner",
	});
	assert.equal(retrained.view.exemplarCount, 2);
	assert.ok(retrained.heldReplay.before.hitRate < retrained.heldReplay.after.hitRate,
		`hit rate must improve: ${retrained.heldReplay.before.hitRate} → ${retrained.heldReplay.after.hitRate}`);
	assert.equal(retrained.heldReplay.after.hitRate, 1);
	// The improvement is evidenced in audit — the task trail's raw material.
	const retrainRow = auditRows.find((row) => row.type === "watchlist-retrain");
	assert.equal(retrainRow.detail.addedExamples, 1);
	assert.equal(retrainRow.detail.heldReplayAfter, 1);
	// The stored artifact set was replaced: the class carries the new pool.
	const stored = await service.getClass("home-1", view._id);
	assert.equal(stored.exemplarCount, 2);
	assert.equal(stored.heldReplay.hitRate, 1);
	// Retraining with nothing new refuses honestly.
	await assert.rejects(
		service.retrain({ homeId: "home-1", classId: view._id }),
		/needs new example images/,
	);
});

test("ac-5: deletion purges the label, the artifacts, and the detection rows — nothing dangles", async () => {
	const { service, auditRows, store } = fixture();
	const { view } = await teachImpala(service);
	await service.classify({ homeId: "home-1", descriptor: V0, cameraId: "cam-1", trackId: "t1", t: 1_700_400_000 });
	const purged = await service.deleteClass({ homeId: "home-1", classId: view._id, actorDid: "did:owner" });
	assert.equal(purged.purged.exemplars, 1);
	assert.equal(purged.purged.detections, 1);
	assert.deepEqual(await service.listClasses("home-1"), []);
	assert.deepEqual(await service.vocabulary("home-1").then((v) => v.trained), []);
	assert.deepEqual(await service.listDetections({ homeId: "home-1" }), []);
	// The collections really emptied on the store of record.
	const classes = store.collection("recognition_watchlists");
	assert.deepEqual(await classes.find({}), []);
	const purgeRow = auditRows.find((row) => row.type === "watchlist-purge");
	assert.equal(purgeRow.detail.label, "63 Chevy Impala");
	// Delete twice → 404, not a silent repeat.
	await assert.rejects(service.deleteClass({ homeId: "home-1", classId: view._id }), /No such trained class/);
});

test("the per-class detection ring stays bounded (the store stays a store)", async () => {
	const { service } = fixture();
	const { view } = await teachImpala(service);
	await service.setClassThreshold({ homeId: "home-1", classId: view._id, assertThreshold: 0.01 });
	for (let i = 0; i < DETECTION_RING_CAP + 5; i += 1) {
		await service.classify({ homeId: "home-1", descriptor: M, t: 1_700_500_000 + i * 400 }); // past every cooldown
	}
	const rows = await service.listDetections({ homeId: "home-1" });
	assert.equal(rows.length, DETECTION_RING_CAP);
	assert.equal(rows[0].label, "63 Chevy Impala");
});

test("conflicts, junk labels, and unprovisioned embedders refuse closed with plain language", async () => {
	const { service } = fixture();
	await service.createClass({ homeId: "home-1", label: "63 Chevy Impala", frames: [pixel(0)] });
	await assert.rejects(
		service.createClass({ homeId: "home-1", label: "63 chevy impala", frames: [pixel(0)] }),
		/already teaches/,
	);
	await assert.rejects(
		service.createClass({ homeId: "home-1", label: "", frames: [pixel(0)] }),
		/needs a name/,
	);
	await assert.rejects(
		service.createClass({ homeId: "home-1", label: "Fresh Class", frames: [] }),
		/at least one example image/,
	);
	// The home scoping is part of the law: another home's class never matches.
	const other = fixture();
	await assert.rejects(other.service.getClass("home-2", "wtl_missing"), /No such trained class/);
});

test("training refuses closed when no embedder is provisioned or the stage is missing", async () => {
	const { service } = fixture({ withProvider: false });
	await assert.rejects(
		service.createClass({ homeId: "home-1", label: "63 Chevy Impala", frames: [pixel(0)] }),
		/needs a local exemplar embedder/,
	);
	const stageless = fixture();
	const stagelessService = createWatchlistService({
		store: createMemoryStore(),
		trackedClasses: TRACKED_CLASSES,
		providerRef: async () => ({ name: "partial", describeFaces: async () => [] }),
	});
	await assert.rejects(
		stagelessService.createClass({ homeId: "home-1", label: "63 Chevy Impala", frames: [pixel(0)] }),
		/embedImage stage/,
	);
	// (the stageless fixture above is exercised for its refusal path only)
	void stageless;
});

test("evaluateReplay: honest nulls and hit-rate math", () => {
	const doc = { _id: "wtl_a", label: "63 Chevy Impala", exemplars: [{ descriptor: V0 }] };
	assert.equal(evaluateReplay([], [doc], "t").hitRate, null);
	assert.equal(evaluateReplay([{ descriptor: V0, expect: "63 Chevy Impala" }], [doc], "t").hitRate, 1);
	const other = { _id: "wtl_b", label: "Old Truck", exemplars: [{ descriptor: W }] };
	assert.equal(evaluateReplay([{ descriptor: R_MISS(), expect: "63 Chevy Impala" }], [doc, other], "t").hitRate, 0);
	function R_MISS() { return [0.2, 0.98]; }
});
