// config-store.test.js — PORCH-140 ac-6 + ac-4 dial acceptance behavior:
// owner-authored zones persist across restart; invalid polygons, adjacency
// pairs, and travel priors are rejected with nothing persisted; cameras
// without a zone are never eligible; dial clamps to cap with audited rows,
// stays silent on no-change sets, and bumps the effective rate.

import { test } from "node:test";
import assert from "node:assert/strict";
import fsDefault from "node:fs";
import osDefault from "node:os";
import pathDefault from "node:path";

import { createConfigStore, ConfigValidationError } from "../src/config-store.js";
import {
	DEFAULT_BENCHMARK_CAP_FPS,
	BUMP_DELTA_FPS,
	createDial,
} from "../src/dial.js";
import { createAuditLog } from "../src/audit.js";

/** Fresh temp file path per test. */
function tempPath(name) {
	const dir = fsDefault.mkdtempSync(pathDefault.join(osDefault.tmpdir(), `overwatch-${name}-`));
	return pathDefault.join(dir, "config.json");
}

test("authored zones persist and a NEW store instance on the same path reads them (config-survives-restarts)", () => {
	const path = tempPath("restart");
	const polygon = [
		[0, 0],
		[4, 0],
		[4, 3],
		[0, 3],
	];
	const store = createConfigStore({ path });
	store.setZone("front-door", polygon, { authoredBy: "owner-did" });
	store.update((draft) => {
		draft.adjacency.push(["front-door", "driveway"]);
		draft.travelTime["driveway|front-door"] = { min: 1, max: 5 };
	});

	// The restart path: a new store on the same file re-reads the doc.
	const restarted = createConfigStore({ path });
	assert.deepEqual(restarted.getState().coverageZones, [
		{
			cameraId: "front-door",
			polygon,
			authoredAt: store.getState().coverageZones[0].authoredAt,
			authoredBy: "owner-did",
		},
	]);
	assert.deepEqual(restarted.getState().adjacency, [["driveway", "front-door"]]);
	assert.deepEqual(restarted.getState().travelTime, { "driveway|front-door": { min: 1, max: 5 } });
	assert.deepEqual(restarted.eligibleCameraIds(), ["front-door"]);

	// reload() is the in-place restart path on the live instance.
	const live = createConfigStore({ path });
	live.update((draft) => {
		draft.dial.frameRate = 2;
	});
	const reloaded = restarted.reload();
	assert.equal(reloaded.dial.frameRate, 2);
	assert.equal(reloaded.coverageZones.length, 1);
});

test("invalid polygons, adjacency pairs, and travel priors are rejected with NOTHING persisted", () => {
	const path = tempPath("invalid");
	const store = createConfigStore({ path });
	store.setZone("cam-a", [
		[0, 0],
		[1, 0],
		[1, 1],
	]);
	const before = fsDefault.readFileSync(path, "utf8");
	const beforeState = store.getState();

	// Polygon with fewer than 3 points.
	assert.throws(
		() =>
			store.setZone("cam-b", [
				[0, 0],
				[1, 1],
			]),
		ConfigValidationError,
	);
	// Polygon point that is not a finite [x, y] pair.
	assert.throws(
		() =>
			store.setZone("cam-b", [
				[0, 0],
				[1, Number.NaN],
				[1, 1],
			]),
		ConfigValidationError,
	);
	// Self-pair adjacency.
	assert.throws(
		() =>
			store.update((draft) => {
				draft.adjacency.push(["cam-a", "cam-a"]);
			}),
		(error) => error instanceof ConfigValidationError && error.message.includes("self-pair"),
	);
	// Travel prior with min > max.
	assert.throws(
		() =>
			store.update((draft) => {
				draft.travelTime["cam-a|cam-b"] = { min: 9, max: 2 };
			}),
		ConfigValidationError,
	);
	// Travel prior keyed in unsorted form.
	assert.throws(
		() =>
			store.update((draft) => {
				draft.travelTime["cam-b|cam-a"] = { min: 0, max: 2 };
			}),
		(error) => error instanceof ConfigValidationError && error.message.includes("sorted pair"),
	);

	// Nothing persisted: file bytes unchanged, live state unchanged.
	assert.equal(fsDefault.readFileSync(path, "utf8"), before);
	assert.deepEqual(store.getState(), beforeState);
	// Invalid zone never entered the store either.
	assert.deepEqual(store.eligibleCameraIds(), ["cam-a"]);
});

test("a camera with no authored zone is never zone-eligible", () => {
	const store = createConfigStore({ path: tempPath("eligibility") });
	store.setZone("backyard", [
		[0, 0],
		[2, 0],
		[2, 2],
	]);
	assert.deepEqual(store.eligibleCameraIds(), ["backyard"]);
});

test("adjacency pairs are normalized sorted inside the pair and deduped; duplicate zone replaces", () => {
	const path = tempPath("normalize");
	const store = createConfigStore({ path });
	store.update((draft) => {
		draft.adjacency.push(["cam-b", "cam-a"], ["cam-a", "cam-b"]);
	});
	assert.deepEqual(store.getState().adjacency, [["cam-a", "cam-b"]]);

	store.setZone("cam-a", [
		[0, 0],
		[1, 0],
		[1, 1],
	]);
	// Duplicate cameraId zone = replace (one zone per camera).
	store.setZone("cam-a", [
		[1, 1],
		[2, 1],
		[2, 2],
	]);
	const zones = store.getState().coverageZones;
	assert.equal(zones.length, 1);
	assert.deepEqual(zones[0].polygon, [
		[1, 1],
		[2, 1],
		[2, 2],
	]);
});

test("correlationConfig() derives the EntityMergeService config from the single top-level source", () => {
	const path = tempPath("correlation");
	const store = createConfigStore({ path });
	store.update((draft) => {
		draft.adjacency.push(["left", "right"]);
		draft.travelTime["left|right"] = { min: 0, max: 10 };
		draft.correlation.separatePairs.push("left:p1|right:r7");
	});
	const derived = store.correlationConfig();
	assert.deepEqual(derived.adjacency, [["left", "right"]]);
	assert.deepEqual(derived.travelTime, { "left|right": { min: 0, max: 10 } });
	assert.deepEqual(derived.separatePairs, ["left:p1|right:r7"]);
	assert.equal(typeof derived.trackIdleSec, "number");
	assert.equal(typeof derived.joinThreshold, "number");
	// Single source of truth: the persisted correlation block holds no copies.
	assert.equal("adjacency" in store.getState().correlation, false);
	assert.equal("travelTime" in store.getState().correlation, false);
});

test("dial clamps out-of-range rates to [1, capFps] and audits the clamped set", () => {
	const store = createConfigStore({ path: tempPath("clamp") });
	const audit = createAuditLog();
	const dial = createDial({ store, audit });

	assert.equal(DEFAULT_BENCHMARK_CAP_FPS, 5);
	// Start inside the range so the clamped sets below are real changes.
	dial.set({ frameRate: 3 });
	const over = dial.set({ frameRate: 50, actorIdentityRef: "owner-did", homeId: "home-1" });
	assert.deepEqual(over, { frameRate: 5, clamped: true, changed: true });
	assert.deepEqual(dial.get(), { frameRate: 5, capFps: 5 });

	const under = dial.set({ frameRate: 0 });
	assert.deepEqual(under, { frameRate: 1, clamped: true, changed: true });

	const rows = audit.list({ type: "dial-change" });
	assert.equal(rows.length, 3);
	assert.deepEqual(rows[0].detail, { requested: 0, applied: 1, clamped: true });
	assert.deepEqual(rows[1].detail, { requested: 50, applied: 5, clamped: true });
	assert.equal(rows[1].actorIdentityRef, "owner-did");
	assert.equal(rows[1].homeId, "home-1");
	assert.equal(store.getState().dial.frameRate, 1);
});

test("dial set with an identical value changes nothing and audits nothing", () => {
	const store = createConfigStore({ path: tempPath("nochange") });
	const audit = createAuditLog();
	const dial = createDial({ store, audit });

	const first = dial.set({ frameRate: 3 });
	assert.deepEqual(first, { frameRate: 3, clamped: false, changed: true });
	const again = dial.set({ frameRate: 3 });
	assert.deepEqual(again, { frameRate: 3, clamped: false, changed: false });
	assert.equal(audit.list({ type: "dial-change" }).length, 1);
	// updatedAt bumped only by the real change: two audits would have meant a third write.
	const rows = audit.list({ type: "dial-change" });
	assert.deepEqual(rows[0].detail, { requested: 3, applied: 3, clamped: false });
});

test("effectiveFrameRateFor applies the follow bump with BUMP_DELTA_FPS clamped by capFps", () => {
	const store = createConfigStore({ path: tempPath("bump-math") });
	const dial = createDial({ store, audit: createAuditLog() });
	assert.equal(BUMP_DELTA_FPS, 2);

	dial.set({ frameRate: 2 });
	assert.equal(dial.effectiveFrameRateFor("cam-a", []), 2);
	assert.equal(dial.effectiveFrameRateFor("cam-a", ["cam-a"]), 4); // 2 + 2
	assert.equal(dial.effectiveFrameRateFor("cam-a", ["cam-b"]), 2); // bump on another camera

	// Bump rate clamps at the cap: min(4 + 2, 5) = 5.
	dial.set({ frameRate: 4 });
	assert.equal(dial.effectiveFrameRateFor("cam-a", ["cam-a"]), 5);
});
