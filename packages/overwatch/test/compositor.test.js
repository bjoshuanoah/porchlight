// compositor.test.js — PORCH-140 ac-4 composite pass acceptance behavior:
// ONE interpreter call per pass regardless of camera count, ONE stitched
// image with per-tile row copies verified pixel-exact, live cadence changes
// immediately after dial.set, audited follow-bump engage/release cadence,
// layout-version stability refusal without an interpreter call, and
// annotation mapping back to camera space.

import { test } from "node:test";
import assert from "node:assert/strict";
import fsDefault from "node:fs";
import osDefault from "node:os";
import pathDefault from "node:path";

import { createConfigStore, ConfigValidationError } from "../src/config-store.js";
import { createAuditLog } from "../src/audit.js";
import { createDial } from "../src/dial.js";
import {
	DEFAULT_LAYOUT_VERSION,
	TILE_MAX_WIDTH,
	MissingFrameError,
	LayoutStabilityError,
	createCompositeEvaluator,
	createCompositeScheduler,
	buildLayout,
	resolveAnnotation,
} from "../src/compositor.js";

/** Fresh temp file path per test. */
function tempPath(name) {
	const dir = fsDefault.mkdtempSync(pathDefault.join(osDefault.tmpdir(), `overwatch-${name}-`));
	return pathDefault.join(dir, `${name}.json`);
}

/** RGB frame with every pixel painted a per-pixel pattern (r=x, g=y, b=7). */
function makeFrame(width, height) {
	const data = new Uint8Array(width * height * 3);
	for (let y = 0; y < height; y++) {
		for (let x = 0; x < width; x++) {
			const i = (y * width + x) * 3;
			data[i] = x;
			data[i + 1] = y;
			data[i + 2] = 7;
		}
	}
	return { width, height, data };
}

/**
 * Recording interpreter: counts calls, returns one descriptive annotation
 * per call (never creates tracks).
 */
function recordingInterpreter(annotations = []) {
	const calls = [];
	return {
		calls,
		interpreter(input) {
			calls.push(input);
			return annotations;
		},
	};
}

function evaluateFixture(cameraIds, frameSizes, interpreterCalls) {
	const store = createConfigStore({ path: tempPath("compositor") });
	const audit = createAuditLog();
	const dial = createDial({ store, audit });
	const evaluator = createCompositeEvaluator({ store, dial, interpreter: interpreterCalls, audit });
	evaluator.selectCameras(cameraIds, frameSizes);
	return { store, audit, dial, evaluator };
}

test("ONE interpreter call per pass for N cameras, over ONE stitched image", () => {
	const frameSizes = { left: { width: 2, height: 2 }, mid: { width: 2, height: 3 }, right: { width: 2, height: 2 } };
	const recorded = recordingInterpreter([{ x: 1, y: 1, w: 1, h: 1 }]);
	const { evaluator } = evaluateFixture(["left", "mid", "right"], frameSizes, recorded.interpreter);

	const pass = evaluator.evaluate({
		frames: { left: makeFrame(2, 2), mid: makeFrame(2, 3), right: makeFrame(2, 2) },
	});

	// Exactly one interpreter call for three cameras, with the full composite.
	assert.equal(recorded.calls.length, 1);
	assert.equal(pass.interpreterCalls, 1);
	assert.equal(recorded.calls[0].image.width, 6); // three 2px tiles in one row
	assert.equal(recorded.calls[0].image.height, 3); // tallest tile
	assert.equal(recorded.calls[0].image.data.byteLength, 6 * 3 * 3);
});

test("composite tiles are pixel-perfect row copies: tile pixel at origin matches source buffer", () => {
	const frameSizes = { a: { width: 2, height: 2 }, b: { width: 2, height: 2 } };
	const { evaluator } = evaluateFixture(["a", "b"], frameSizes, null);
	const frameA = makeFrame(2, 2);
	const frameB = makeFrame(2, 2);
	const pass = evaluator.evaluate({ frames: { a: frameA, b: frameB } });

	assert.equal(pass.layout.width, 4);
	assert.equal(pass.layout.height, 2);
	assert.deepEqual(pass.layout.tiles.map((t) => t.cameraId), ["a", "b"]);
	assert.deepEqual(pass.layout.tiles.map((t) => t.scale), [1, 1]);
	assert.deepEqual(pass.layout.tiles.map((t) => t.origin), [
		{ x: 0, y: 0 },
		{ x: 2, y: 0 },
	]);
	assert.deepEqual(pass.layout.tiles.map((t) => t.source), [
		{ width: 2, height: 2 },
		{ width: 2, height: 2 },
	]);

	const image = pass.image.data;
	const px = (x, y) => {
		const i = (y * 4 + x) * 3;
		return [image[i], image[i + 1], image[i + 2]];
	};
	// Tile a at origin (0, 0): composite pixel equals source pixel.
	assert.deepEqual(px(0, 0), [0, 0, 7]);
	assert.deepEqual(px(1, 1), [1, 1, 7]);
	// Tile b at origin (2, 0): its origin pixel equals frame b's pixel (0, 0).
	assert.deepEqual(px(2, 0), [0, 0, 7]);
	assert.deepEqual(px(3, 1), [1, 1, 7]);
});

test("missing frame for an active camera throws MissingFrameError and runs no pass", () => {
	const recorded = recordingInterpreter();
	const { evaluator } = evaluateFixture(
		["a", "b"],
		{ a: { width: 2, height: 2 }, b: { width: 2, height: 2 } },
		recorded.interpreter,
	);
	assert.throws(
		() => evaluator.evaluate({ frames: { a: makeFrame(2, 2) } }),
		MissingFrameError,
	);
	assert.equal(recorded.calls.length, 0);
});

test("mixed layout-version evaluate refuses without an interpreter call; version moves only via audited bumps", () => {
	const recorded = recordingInterpreter();
	const { audit, evaluator } = evaluateFixture(
		["a", "b"],
		{ a: { width: 2, height: 2 }, b: { width: 2, height: 2 } },
		recorded.interpreter,
	);
	const frames = { a: makeFrame(2, 2), b: makeFrame(2, 2) };

	assert.equal(DEFAULT_LAYOUT_VERSION, 1);
	assert.equal(evaluator.layoutVersion, 1);
	const before = evaluator.evaluate({ frames });
	assert.equal(before.interpreterCalls, 1);
	assert.equal(recorded.calls.length, 1);

	const bump = evaluator.bumpLayoutVersion({ reason: "tile-size change", actorIdentityRef: "owner-did" });
	assert.deepEqual(bump, { from: 1, to: 2 });
	assert.equal(evaluator.layoutVersion, 2);

	// A consumer still holding the old version is refused BEFORE any work.
	assert.throws(
		() => evaluator.evaluate({ frames, layoutVersion: 1 }),
		(error) => error instanceof LayoutStabilityError && /1.+2/.test(error.message),
	);
	assert.equal(recorded.calls.length, 1); // unchanged — no interpreter call

	// The bump is an explicit audited event.
	const bumps = audit.list({ type: "layout-version-bump" });
	assert.equal(bumps.length, 1);
	assert.deepEqual(bumps[0].detail, { from: 1, to: 2, reason: "tile-size change" });

	// Current-version evaluates still run.
	assert.equal(evaluator.evaluate({ frames, layoutVersion: 2 }).interpreterCalls, 1);
});

test("resolveAnnotation maps per-tile coords back to camera space for a 2-tile layout", () => {
	const layout = buildLayout(["leftcam", "rightcam"], {
		leftcam: { width: 4, height: 4 },
		rightcam: { width: 4, height: 4 },
	});

	// Rect origin inside tile leftcam (origin 0,0): camera space = tile space.
	assert.deepEqual(resolveAnnotation({ x: 2, y: 1, w: 1, h: 1 }, layout), {
		x: 2,
		y: 1,
		w: 1,
		h: 1,
		cameraId: "leftcam",
	});
	// Rect origin inside tile rightcam (origin 4,0): subtract origin.
	assert.deepEqual(resolveAnnotation({ x: 5, y: 3, w: 2, h: 2 }, layout), {
		cameraId: "rightcam",
		x: 1,
		y: 3,
		w: 2,
		h: 2,
	});
	// Unknown tile: annotation dropped.
	assert.equal(resolveAnnotation({ x: 99, y: 0 }, layout), null);
	assert.equal(resolveAnnotation({ x: 2, y: 4 }, layout), null);

	// Scale division: wider sources downscale to TILE_MAX_WIDTH.
	const wide = buildLayout(["wide"], { wide: { width: TILE_MAX_WIDTH * 2, height: 100 } });
	assert.equal(wide.tiles[0].scale, 0.5);
	const mapped = resolveAnnotation({ x: 64, y: 10, w: 4, h: 2 }, wide);
	assert.deepEqual(mapped, { cameraId: "wide", x: 128, y: 20, w: 8, h: 4 });
});

test("cadence is live: nextDelay changes immediately after dial.set", () => {
	const store = createConfigStore({ path: tempPath("cadence") });
	const audit = createAuditLog();
	const dial = createDial({ store, audit });
	const evaluator = createCompositeEvaluator({ store, dial, audit });
	const scheduler = createCompositeScheduler({ evaluator, dial });

	dial.set({ frameRate: 5 });
	assert.equal(scheduler.nextDelay("cam-a", []), 200); // 1000 / 5
	dial.set({ frameRate: 2 });
	assert.equal(scheduler.nextDelay("cam-a", []), 500); // live — same scheduler, no rebuild
});

test("follow bump engages/releases audited and cadence follows the bumped rate", () => {
	const store = createConfigStore({ path: tempPath("bump") });
	const audit = createAuditLog();
	const dial = createDial({ store, audit });
	const evaluator = createCompositeEvaluator({ store, dial, audit });
	const scheduler = createCompositeScheduler({ evaluator, dial });
	dial.set({ frameRate: 2 });

	// Engage: audited, and the cadence immediately uses the bumped rate.
	evaluator.setFollowBump("cam-a", true, { actorIdentityRef: "family-did" });
	assert.deepEqual(evaluator.activeFollowBumps(), ["cam-a"]);
	assert.equal(scheduler.nextDelay("cam-a"), 250); // 1000 / (2 + 2)
	assert.equal(scheduler.nextDelay("cam-b"), 500); // unbumped camera unchanged
	const engaged = audit.list({ type: "follow-bump-engage" });
	assert.equal(engaged.length, 1);
	assert.deepEqual(engaged[0].detail, { cameraId: "cam-a" });
	assert.equal(engaged[0].actorIdentityRef, "family-did");

	// Re-engage with the same state: explicit state changes only — no event.
	evaluator.setFollowBump("cam-a", true);
	assert.equal(audit.list({ type: "follow-bump-engage" }).length, 1);

	// Release: audited, cadence returns to the plain rate.
	evaluator.setFollowBump("cam-a", false, { actorIdentityRef: "family-did" });
	assert.deepEqual(evaluator.activeFollowBumps(), []);
	assert.equal(scheduler.nextDelay("cam-a"), 500);
	const released = audit.list({ type: "follow-bump-release" });
	assert.equal(released.length, 1);
	assert.deepEqual(released[0].detail, { cameraId: "cam-a" });

	const bumpRows = audit
		.list()
		.map((r) => r.type)
		.filter((t) => t === "follow-bump-engage" || t === "follow-bump-release");
	assert.deepEqual(bumpRows, ["follow-bump-release", "follow-bump-engage"]);
});

test("selectCameras persists activeCameraIds; a restart store rebuilds the same selection", () => {
	const path = tempPath("selection");
	const store = createConfigStore({ path });
	const audit = createAuditLog();
	const dial = createDial({ store, audit });
	const evaluator = createCompositeEvaluator({ store, dial, audit });
	evaluator.selectCameras(["cam-a", "cam-b"], { "cam-a": { width: 2, height: 2 }, "cam-b": { width: 2, height: 3 } });
	assert.deepEqual(store.getState().dial.activeCameraIds, ["cam-a", "cam-b"]);
	assert.deepEqual(evaluator.layout.cameraOrder, ["cam-a", "cam-b"]);

	// Layout is a pure function of (camera order, frame sizes): same inputs
	// through the buildLayout seam give the same tiles.
	assert.deepEqual(evaluator.layout.tiles, buildLayout(["cam-a", "cam-b"], {
		"cam-a": { width: 2, height: 2 },
		"cam-b": { width: 2, height: 3 },
	}).tiles);

	const restarted = createConfigStore({ path });
	assert.deepEqual(restarted.getState().dial.activeCameraIds, ["cam-a", "cam-b"]);
});

test("interpreter annotations come back mapped to camera space; unknown-tile annotations are dropped", () => {
	const frameSizes = { a: { width: 2, height: 2 }, b: { width: 2, height: 2 } };
	const recorded = recordingInterpreter([
		{ x: 0, y: 0, w: 2, h: 2 }, // in tile a
		{ x: 2, y: 1, w: 1, h: 1 }, // in tile b
		{ x: 50, y: 50, w: 1, h: 1 }, // no tile — dropped
	]);
	const { evaluator } = evaluateFixture(["a", "b"], frameSizes, recorded.interpreter);
	const pass = evaluator.evaluate({ frames: { a: makeFrame(2, 2), b: makeFrame(2, 2) } });
	assert.deepEqual(pass.annotations, [
		{ x: 0, y: 0, w: 2, h: 2, cameraId: "a" },
		{ x: 0, y: 1, w: 1, h: 1, cameraId: "b" },
	]);
});

test("audit log is file-backed JSONL: appends survive a new instance and filter newest-first", () => {
	const path = tempPath("audit-file");
	const first = createAuditLog({ path });
	first.record({ type: "dial-change", detail: { applied: 3 }, homeId: "home-1" });
	first.record({ type: "follow-bump-engage", detail: { cameraId: "cam-a" }, homeId: "home-1" });

	// Exactly one JSON line per record.
	const lines = fsDefault.readFileSync(path, "utf8").split("\n").filter((l) => l.trim() !== "");
	assert.equal(lines.length, 2);
	for (const line of lines) JSON.parse(line);

	// Restart path: a new instance re-reads the file and lists newest-first.
	const restarted = createAuditLog({ path });
	assert.deepEqual(restarted.list().map((r) => r.type), ["follow-bump-engage", "dial-change"]);
	assert.deepEqual(restarted.list({ type: "dial-change" }).map((r) => r.detail), [{ applied: 3 }]);
	assert.deepEqual(restarted.list({ homeId: "home-1" }).length, 2);
	assert.deepEqual(restarted.list({ homeId: "home-2" }), []);
	assert.deepEqual(restarted.list({ limit: 1 }).length, 1);

	// Records from the restarted instance append to the same file.
	restarted.record({ type: "zone-config-change" });
	assert.equal(createAuditLog({ path }).list({ type: "zone-config-change" }).length, 1);
});

test("zone-config-change audit is wired through store updates", () => {
	const path = tempPath("zone-audit");
	const store = createConfigStore({ path });
	const audit = createAuditLog();
	assert.throws(
		() =>
			store.update((draft) => {
				draft.coverageZones.push({ cameraId: "cam-a", polygon: [] });
			}),
		ConfigValidationError,
	);
	assert.equal(audit.list({ type: "zone-config-change" }).length, 0);
	store.setZone("cam-a", [
		[0, 0],
		[1, 0],
		[1, 1],
	]);
	audit.record({
		type: "zone-config-change",
		actorIdentityRef: "owner-did",
		homeId: "home-1",
		detail: { cameraId: "cam-a" },
	});
	assert.deepEqual(audit.list({ type: "zone-config-change" })[0].detail, { cameraId: "cam-a" });
});
