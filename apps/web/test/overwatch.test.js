// PORCH-140: the family Overwatch surfaces. The pure model pins directly
// (node --test); the real screen and the real wire half bundle with esbuild
// and render with a stubbed api/connection (the share-flows render-sweep
// pattern) — no fetch, no MUI theme Provider, SSR-safe surface.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { readFile, rm, mkdir } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import React from "react";
import { renderToString } from "react-dom/server";

import {
  boundsOf, clampFrameRate, clipGroupCopy, closeToleranceFor, DEFAULT_HANDOFF_MINUTES,
  dialCap, dialCopy, dialRange, dialStep, entityClassLabel, extendZoneDraft,
  followButtonLabel, gapGroupCopy, groupTimelineEntries, isFollowable, moveZoneVertex,
  pointFromClick, polygonToSvgPoints, streamClipCopy, travelTimeKey, travelTimeUpdate,
  trackedStateLabel, UNCOVERED_LABEL, visitWhoCopy, visitWhereCopy, viewBoxOf, zoneViewBox,
  zonesTouch,
} from "../src/overwatch-model.js";

const here = dirname(fileURLToPath(import.meta.url));
const webRoot = fileURLToPath(new URL("../", import.meta.url));
const src = async (file) => await readFile(join(webRoot, file), "utf8");
const mainSource = await src("src/main.jsx");
const actionsSource = await src("src/overwatch-actions.js");

const EXTERNALS = ["react", "react-dom", "@mui/*", "@emotion/*", "@noble/*"];

const tmpRoot = join(here, `.tmp140-${process.pid}`);
await mkdir(tmpRoot, { recursive: true });
after(async () => { await rm(tmpRoot, { recursive: true, force: true }); });

/** The bundled entry for one render sweep. */
let Surface = null;
async function screenSurface() {
  if (Surface) return Surface;
  await build({
    stdin: { contents: 'export { Overwatch, OverwatchMap, TrackedList, UncoveredList, VisitTimeline, FollowedStream, DialLive } from "./src/overwatch.jsx";', resolveDir: webRoot, loader: "jsx", sourcefile: "entry.jsx" },
    bundle: true, format: "esm", jsx: "automatic", platform: "neutral",
    external: EXTERNALS,
    outfile: join(tmpRoot, "screen.built.mjs"), logLevel: "silent",
  });
  Surface = await import(join(tmpRoot, "screen.built.mjs"));
  return Surface;
}

/* ---- the model: zone geometry and the map's projection ----------------- */

test("model ac: polygon points map to an SVG points string in map space", () => {
  assert.equal(polygonToSvgPoints([[10, 20], [30, 20], [30, 40]]), "10,20 30,20 30,40");
  // The first vertices of an in-progress draft render too — a draft is not a
  // valid polygon yet but it is on the map already.
  assert.equal(polygonToSvgPoints([[1, 2]]), "1,2");
  // Garbage contributes nothing, never a guess.
  assert.equal(polygonToSvgPoints([[1, 2], ["x", 3], [null, null], [4, 5]]), "1,2 4,5");
  assert.equal(polygonToSvgPoints("nope"), "");
  assert.equal(polygonToSvgPoints([]), "");
});

test("model ac: the map's viewBox is the zones' union expanded by a margin", () => {
  const zones = [
    { cameraId: "cam_a", polygon: [[0, 0], [10, 0], [10, 10], [0, 10]] },
    { cameraId: "cam_b", polygon: [[20, 5], [30, 5], [30, 15], [20, 5]] },
  ];
  assert.deepEqual(boundsOf(zones, 5), { minX: -5, minY: -5, maxX: 35, maxY: 20 });
  assert.equal(viewBoxOf({ minX: -5, minY: -5, maxX: 35, maxY: 20 }), "-5 -5 40 25");
  assert.equal(zoneViewBox(zones, 5), "-5 -5 40 25");
  // No zones: no frame — the surface renders its empty line, not an invented map.
  assert.equal(zoneViewBox([]), null);
  assert.equal(zoneViewBox(null), null);
});

test("model ac: a canvas click maps back into map coordinates", () => {
  const rect = { left: 10, top: 20, width: 200, height: 100 };
  const point = pointFromClick({ clientX: 110, clientY: 70 }, rect, "0 0 100 50");
  assert.deepEqual(point, [50, 25]);
  // Degenerate or unreadable inputs refuse to invent a point.
  assert.equal(pointFromClick({ clientX: 0, clientY: 0 }, { left: 0, top: 0, width: 0, height: 100 }, "0 0 10 10"), null);
  assert.equal(pointFromClick({ clientX: 0, clientY: 0 }, rect, "nonsense"), null);
});

test("model ac: the close tolerance carries the console's 2.5%-of-width grammar", () => {
  assert.equal(closeToleranceFor(400), 10);
  assert.equal(closeToleranceFor(400, 2.5), 10);
  assert.equal(closeToleranceFor(0), 0);
});

test("model ac: click-to-add-vertex — first click starts, near-first click closes, closure freezes the draft", () => {
  const t = 1;
  let step = extendZoneDraft(null, [10, 10], t);
  assert.deepEqual(step.draft, [[10, 10]]);
  assert.equal(step.closed, false);
  step = extendZoneDraft(step.draft, [20, 10], t);
  step = extendZoneDraft(step.draft, [20, 20], t);
  assert.equal(step.draft.length, 3);
  // A third click far from the first vertex extends.
  step = extendZoneDraft(step.draft, [20, 19.5], t);
  assert.equal(step.draft.length, 4);
  assert.equal(step.closed, false);
  // The click of record: inside the tolerance of the FIRST vertex — the draft
  // completes and further canvas clicks add nothing (ZoneEditor's grammar).
  const finished = extendZoneDraft(step.draft, [10.2, 10.2], t);
  assert.equal(finished.closed, true);
  assert.equal(finished.draft.length, 4);
  // Once complete, the grammar stays frozen: the caller carries `closed` and
  // every further canvas click is a no-op until Save or Discard.
  const frozen = extendZoneDraft(finished.draft, [15, 15], t, true);
  assert.equal(frozen.closed, true);
  assert.deepEqual(frozen.draft, finished.draft);
  // A non-point is a no-op: the draft never invents a vertex.
  assert.equal(extendZoneDraft(step.draft, null, t).closed, false);
  assert.deepEqual(extendZoneDraft(step.draft, null, t).draft, step.draft);
});

test("model ac: a dragged vertex moves cloned, out-of-range drags are no-ops", () => {
  const polygon = [[0, 0], [10, 0], [10, 10]];
  const moved = moveZoneVertex(polygon, 1, [12, 3]);
  assert.deepEqual(moved, [[0, 0], [12, 3], [10, 10]]);
  assert.deepEqual(polygon, [[0, 0], [10, 0], [10, 10]], "the source polygon never mutates");
  assert.deepEqual(moveZoneVertex(polygon, 9, [1, 1]), polygon);
  assert.deepEqual(moveZoneVertex(polygon, 1, null), polygon);
});

test("model ac: zones that touch suggest a pair; separated zones do not", () => {
  const touching = { polygon: [[0, 0], [10, 0], [10, 10], [0, 10]] };
  const sharingEdge = { polygon: [[10.05, 0], [20, 0], [20, 10], [10.05, 10]] };
  const apart = { polygon: [[30, 0], [40, 0], [40, 10], [30, 10]] };
  assert.equal(zonesTouch(touching, sharingEdge), true, "float drift inside the epsilon still touches");
  assert.equal(zonesTouch(touching, apart), false);
  assert.equal(zonesTouch(touching, null), false);
  assert.equal(zonesTouch(null, touching), false);
});

/* ---- the model: adjacency and travel time ------------------------------ */

test("model ac: travel-time keys are the contract's a|b shape, canonicalized", () => {
  assert.equal(travelTimeKey("cam_b", "cam_a"), "cam_a|cam_b");
  assert.equal(travelTimeKey("cam_a", "cam_b"), "cam_a|cam_b");
  const update = travelTimeUpdate("cam_a|cam_b", 12.4);
  assert.deepEqual(update, { key: "cam_a|cam_b", min: 12, max: 12 });
  // Junk minutes seed to the declared default, never NaN.
  assert.deepEqual(travelTimeUpdate("cam_a|cam_b", "nonsense"),
    { key: "cam_a|cam_b", min: DEFAULT_HANDOFF_MINUTES, max: DEFAULT_HANDOFF_MINUTES });
});

/* ---- the model: the dial ----------------------------------------------- */

test("model ac: dial range honors the cap and clamps inside it", () => {
  assert.deepEqual(dialRange(5), { min: 1, max: 5 });
  assert.deepEqual(dialRange(2.7), { min: 1, max: 2 });
  assert.deepEqual(dialRange(null), { min: 1, max: 1 });
  assert.equal(dialCap("7"), 7);
  assert.equal(clampFrameRate(99, 5), 5);
  assert.equal(clampFrameRate(0, 5), 1);
  assert.equal(clampFrameRate(3.6, 5), 4);
  assert.equal(clampFrameRate("nonsense", 5), 1);
  assert.equal(dialStep(4, "up", 5), 5);
  assert.equal(dialStep(1, "down", 5), 1);
});

test("model ac: dial copy states the cap and the audit fact", () => {
  const copy = dialCopy(5);
  assert.match(copy, /1 to 5/);
  assert.match(copy, /audited/i);
  assert.match(dialCopy(2.4), /caps this dial at 2/);
});

/* ---- the model: tracked entities and followability --------------------- */

test("model ac: people and vehicles are followable; packages never are", () => {
  assert.equal(isFollowable("person"), true);
  assert.equal(isFollowable("vehicle"), true);
  assert.equal(isFollowable("package"), false);
  assert.equal(isFollowable("animal"), false);
  assert.equal(isFollowable(undefined), false);
  assert.equal(isFollowable(""), false);
  assert.equal(entityClassLabel("person"), "Person");
  assert.equal(entityClassLabel("package"), "Package");
  assert.equal(entityClassLabel("drone"), null, "unknown classes render the fallback, never a guess");
});

test("model ac: tracked state copy and the follow button's one contract", () => {
  assert.equal(trackedStateLabel("arrival"), "Arrived");
  assert.equal(trackedStateLabel("movement"), "Moving");
  assert.equal(trackedStateLabel("stationary"), "Stationary");
  assert.equal(trackedStateLabel("departure"), "Departing");
  assert.equal(trackedStateLabel("anything-else"), null);
  assert.equal(followButtonLabel(true), "Stop following");
  assert.equal(followButtonLabel(false), "Follow");
});

/* ---- the model: visits, timeline grouping, and gaps -------------------- */

test("model ac: consecutive same-kind (camera, state) entries group; order holds", () => {
  const groups = groupTimelineEntries([
    { kind: "state", state: "arrival", cameraId: "cam_a", from: "t0", to: "t1" },
    { kind: "state", state: "arrival", cameraId: "cam_a", from: "t1", to: "t2" },
    { kind: "state", state: "movement", cameraId: "cam_a", from: "t2", to: "t3" },
    { kind: "clip", cameraId: "cam_a", path: "/c1.mp4", from: "t2", to: "t4" },
    { kind: "clip", cameraId: "cam_a", path: "/c2.mp4", from: "t4", to: "t6" },
    { kind: "clip", cameraId: "cam_b", path: "/c3.mp4", from: "t6", to: "t7" },
  ]);
  assert.deepEqual(groups.map((group) => [group.kind, group.cameraId, group.count]), [
    ["state", "cam_a", 2],
    ["state", "cam_a", 1],
    ["clip", "cam_a", 2],
    ["clip", "cam_b", 1],
  ]);
  // The grouped clips' paths and widened span survive the merge.
  assert.deepEqual(groups[2].paths, ["/c1.mp4", "/c2.mp4"]);
  assert.deepEqual(groups[2].from, "t2");
  assert.deepEqual(groups[2].to, "t6");
  assert.deepEqual(groups[0].states, ["arrival", "arrival"]);
  // A state change splits the group even on the same camera — the narrative
  // keeps both steps.
  assert.equal(groups[0].state, "arrival");
  assert.equal(groups[1].state, "movement");
});

test("model ac: gap entries group by reason and copy as explained gaps", () => {
  const groups = groupTimelineEntries([
    { kind: "gap", reason: "camera-outage", from: "2026-11-25T15:14:00Z", to: "2026-11-25T15:27:00Z" },
    { kind: "gap", reason: "camera-outage", from: "2026-11-25T15:27:00Z", to: "2026-11-25T15:31:00Z" },
    { kind: "gap", reason: "coverage-hole", from: "2026-11-25T16:00:00Z", to: "2026-11-25T16:05:00Z" },
  ]);
  assert.equal(groups.length, 2);
  assert.equal(groups[0].count, 2);
  assert.equal(gapGroupCopy(groups[0]).startsWith("Camera outage — "), true);
  assert.match(gapGroupCopy(groups[0]), /–/, "the spans render, never fabricated content");
  assert.match(gapGroupCopy(groups[1]), /^Coverage hole/);
  // A gap with no reason still explains itself honestly.
  assert.match(gapGroupCopy({ kind: "gap", from: "1", to: "2" }), /^Gap in coverage/);
});

test("model ac: clip and stream copies name the camera, the count, and the span", () => {
  assert.match(clipGroupCopy({ kind: "clip", cameraId: "cam_a", count: 2, from: "a", to: "b" }), /2 clips/);
  assert.match(clipGroupCopy({ kind: "clip", cameraId: "cam_a", count: 2, from: "a", to: "b" }), /Camera cam_a/);
  assert.match(streamClipCopy({ cameraId: "cam_b" }), /Camera cam_b/, "a stream clip always names its camera");
  assert.match(streamClipCopy({ cameraId: "cam_b" }), /1 clip/);
});

test("model ac: visit summaries are honest about who and where", () => {
  assert.equal(visitWhoCopy([{ entityId: "e1", cls: "person" }, { entityId: "e2", cls: "vehicle" }]), "Person, Vehicle");
  assert.equal(visitWhoCopy(["e1", "e2"]), "2 tracked objects");
  assert.equal(visitWhoCopy([]), "No tracked objects.");
  assert.equal(visitWhereCopy(["cam_a", "cam_b"]), "Cameras cam_a, cam_b.");
  assert.equal(visitWhereCopy([{ cameraId: "cam_a" }]), "Camera cam_a.");
  assert.equal(visitWhereCopy([]), "Unknown cameras.");
  assert.equal(UNCOVERED_LABEL, "Uncovered");
});

/* ---- the screen: rendered sweeps ---------------------------------------
 * renderToString never runs effects, so the sweeps render the screen's
 * exported sections of record with the same fixtures the stub plane serves;
 * the full screen render pins the honest first paint. */

test("screen ac: the tracked list renders a follow control only for person and vehicle", async () => {
  const { TrackedList } = await (await screenSurface());
  const noops = { onFollowToggle: () => {}, onFlag: () => {} };
  const html = renderToString(React.createElement(TrackedList, {
    entities: stubFixtures.tracked.tracked, flagFrom: null, ...noops,
  }));
  assert.match(html, />Person</);
  assert.match(html, />Vehicle</);
  assert.match(html, />Package</);
  // Live state rides the row.
  assert.match(html, /Moving/);
  assert.match(html, /Stationary/);
  // One Follow (the person), one Follow-terminator for the followed vehicle.
  assert.equal((html.match(/>Follow</g) ?? []).length, 1);
  assert.equal((html.match(/>Stop following</g) ?? []).length, 1);
  // The followed vehicle shows its chip; the package carries neither button —
  // packages are never followable, whatever their state.
  assert.match(html, /Following/);
});

test("screen ac: the map renders authored zones only — uncovered cameras stay listed, never drawn", async () => {
  const { OverwatchMap, UncoveredList } = await (await screenSurface());
  const zones = stubFixtures.state.zones;
  const viewBox = zoneViewBox(zones);
  const map = renderToString(React.createElement(OverwatchMap, { zones, viewBox, draft: null, cameraId: "cam_yard" }));
  // Exactly one polygon: the authored driveway zone, its map-space points verbatim.
  assert.equal((map.match(/<polygon /g) ?? []).length, 1);
  assert.match(map, /points="0,0 24,0 24,16 0,16"/);
  assert.match(map, /viewBox="-12 -12 48 40"/, "the viewBox is the union expanded by the margin");
  // The uncovered list never renders a zone — it lists and says so.
  const list = renderToString(React.createElement(UncoveredList, {
    cameras: stubFixtures.state.cameras,
    zoneOfCamera: (id) => (id === "cam_driveway" ? zones[0] : null),
    onPick: () => {},
  }));
  assert.match(list, /cam_yard · Uncovered/);
  // SSR interleaves comments between adjacent text nodes — assert the
  // sentence by its contiguous tail.
  assert.match(list, /uncovered — no zone is inferred\./);
  assert.doesNotMatch(list, /<polygon/);
  // A camera with a zone never lands in the uncovered list.
  assert.doesNotMatch(list, /cam_driveway · Uncovered/);
});

test("screen ac: gap entries render distinctly as explained gaps, never as content", async () => {
  const { VisitTimeline } = await (await screenSurface());
  const entries = [
    { kind: "state", state: "arrival", cameraId: "cam_a", from: "2026-11-25T12:00:00", to: "2026-11-25T12:01:00" },
    { kind: "clip", cameraId: "cam_a", path: "/c1.mp4", from: "2026-11-25T12:01:00", to: "2026-11-25T12:04:00" },
    { kind: "gap", reason: "camera-outage", from: "2026-11-25T12:04:00", to: "2026-11-25T12:14:00" },
    { kind: "state", state: "stationary", cameraId: "cam_b", from: "2026-11-25T12:14:00", to: "2026-11-25T12:20:00" },
  ];
  const html = renderToString(React.createElement(VisitTimeline, { entries }));
  assert.match(html, /Gap/, "the gap carries its distinct marker");
  assert.match(html, /Camera outage/, "the reason of record renders");
  assert.match(html, /12:0[14]/, "the outage's own span renders");
  assert.match(html, /Arrived/);
  assert.match(html, /1 clip/);
  assert.match(html, /Stationary/);
  // Nothing inside the gap is fabricated: no camera, no clip, no path.
  const gapStart = html.indexOf("Camera outage");
  assert.notEqual(gapStart, -1);
  const gapChunk = html.slice(gapStart, gapStart + 420);
  assert.doesNotMatch(gapChunk, /cam_a|cam_b|clip|\.mp4/);
});

test("screen ac: the followed entity's stream renders state and ordered clips", async () => {
  const { FollowedStream } = await (await screenSurface());
  const html = renderToString(React.createElement(FollowedStream, {
    stream: { entityId: "e_car", cls: "vehicle", state: "movement", clips: [
      { cameraId: "cam_yard", path: "/a.mp4", from: "2026-11-25T12:00:00", to: "2026-11-25T12:02:00" },
      { cameraId: "cam_driveway", path: "/b.mp4", from: "2026-11-25T12:02:00", to: "2026-11-25T12:04:00" },
    ] },
  }));
  // SSR splits adjacent text nodes with comments — assert the atoms.
  assert.match(html, /Vehicle/);
  assert.match(html, /Moving/);
  assert.match(html, /Camera cam_yard/);
  assert.match(html, /Camera cam_driveway/);
  // Order holds: yard's clip precedes driveway's.
  assert.ok(html.indexOf("Camera cam_yard") < html.indexOf("Camera cam_driveway"));
});

test("screen ac: the dial respects the cap of record", async () => {
  const { DialLive } = await (await screenSurface());
  const html = renderToString(React.createElement(DialLive, { capFps: 5, initial: 3, onSave: async () => ({ frameRate: 3, clamped: false }) }));
  assert.match(html, /aria-valuemax="5"/);
  assert.match(html, /aria-valuemin="1"/);
  assert.match(html, /aria-valuenow="3"/);
  assert.match(html, /caps this dial at 5/, "the cap copy rides the dial");
  assert.match(html, /audited/);
  assert.match(html, /fps/);
});

test("screen ac: with an empty hub the surface opens honestly empty", async () => {
  const { Overwatch } = await (await screenSurface());
  const { actions, calls } = stubActions({
    state: { zones: [], cameras: [], adjacency: [], travelTime: {}, dial: null },
    tracked: { tracked: [] },
    visits: { visits: [] },
    audit: { records: [] },
  });
  const html = renderToString(React.createElement(Overwatch, { actions }));
  assert.match(html, /Nothing is moving in view right now\./);
  assert.match(html, /No visits recorded in the window yet\./);
  assert.match(html, /No Overwatch activity recorded yet\./);
  // The reads of record all fired once on mount.
  assert.deepEqual(calls, [], "SSR renders without fetch churn; reads are effects");
});

const stubFixtures = {
  state: {
    zones: [{ cameraId: "cam_driveway", polygon: [[0, 0], [24, 0], [24, 16], [0, 16]], authoredAt: "2026-11-25T10:00:00Z", authoredBy: "owner" }],
    cameras: [
      { cameraId: "cam_driveway", zone: "cam_driveway", uncovered: false },
      { cameraId: "cam_yard", zone: null, uncovered: true },
    ],
    adjacency: [["cam_driveway", "cam_yard"]],
    travelTime: { "cam_driveway|cam_yard": { min: 10, max: 10 } },
    dial: { frameRate: 3, capFps: 5, activeCameraIds: ["cam_driveway", "cam_yard"] },
  },
  tracked: {
    tracked: [
      { entityId: "e_person", cls: "person", entityState: "movement", cameraIds: ["cam_driveway"], lastSeenAt: "2026-11-25T12:00:00Z", followed: false },
      { entityId: "e_car", cls: "vehicle", entityState: "stationary", cameraIds: ["cam_yard"], lastSeenAt: "2026-11-25T12:05:00Z", followed: true },
      { entityId: "e_pkg", cls: "package", entityState: "stationary", cameraIds: ["cam_yard"], lastSeenAt: "2026-11-25T11:50:00Z", followed: false },
    ],
  },
  visits: {
    visits: [
      { visitId: "v1", from: "2026-11-25T12:00:00Z", to: "2026-11-25T12:14:00Z", entities: [{ entityId: "e_person", cls: "person" }], cameras: ["cam_driveway", "cam_yard"] },
    ],
  },
  audit: { records: [{ _id: "a1", type: "zone.authored", at: "2026-11-25T10:00:00Z" }] },
};

/** Records every wire call; answers from the fixture plan. */
function stubActions(plan = {}) {
  const calls = [];
  const answer = (route) => {
    if (route.startsWith("overwatch/state") && !route.startsWith("overwatch/stateful")) return plan.state ?? stubFixtures.state;
    if (route.startsWith("overwatch/tracked") && route === "overwatch/tracked") return plan.tracked ?? stubFixtures.tracked;
    if (route.startsWith("overwatch/tracked/") && route.endsWith("/stream")) return plan.stream ?? { entityId: "e_car", state: "stationary", clips: [] };
    if (route.startsWith("overwatch/visits") && route === "overwatch/visits") return plan.visits ?? stubFixtures.visits;
    if (route.startsWith("overwatch/visits/")) return plan.timeline ?? { timeline: [] };
    if (route.startsWith("overwatch/audit")) return plan.audit ?? stubFixtures.audit;
    if (route === "overwatch/dial") return plan.dial ?? { frameRate: 3, clamped: false };
    return {};
  };
  const record = (method) => async (connection, route, init = {}) => {
    if ((init.method ?? "GET") !== method) return answer(route);
    calls.push({ method: init.method ?? "GET", route, body: init.body ? JSON.parse(init.body) : null });
    return answer(route);
  };
  const actions = {
    loadState: record("GET"),
    loadTracked: record("GET"),
    loadDial: record("GET"),
    loadVisits: record("GET"),
    loadEntityStream: record("GET"),
    loadVisitTimeline: record("GET"),
    loadAudit: record("GET"),
    saveZone: record("PUT"),
    deleteZone: record("DELETE"),
    saveAdjacency: record("PUT"),
    saveTravelTime: record("PUT"),
    saveDial: record("PUT"),
    followEntity: record("POST"),
    unfollowEntity: record("DELETE"),
    flagAssociation: record("POST"),
  };
  return { actions, calls };
}


/* ---- the wire half ----------------------------------------------------- */

/** The real overwatch-actions.js, bundled with its api.js import replaced by
 * an inline recorder — one self-contained module carrying both the factory
 * and the `record` array, so nothing is resolved from disk at import time.
 * The /api/ join is proven (api.js's own job). */
const ACTIONS_STUB = [
  'const record = [];',
  'export { record };',
  'async function request(connection, path, init = {}) {',
  '  const target = new URL(`/api/${String(path).replace(/^\\/+/, "")}`, connection.url);',
  '  record.push({',
  '    connection,',
  '    url: target.toString(),',
  '    method: init.method ?? "GET",',
  '    body: init.body ? JSON.parse(init.body) : null,',
  '  });',
  '  return { ok: true };',
  '}',
].join("\n");

async function bundledActions() {
  const real = await readFile(join(webRoot, "src/overwatch-actions.js"), "utf8");
  const seeded = real.replace('import { request } from "./api.js";', ACTIONS_STUB);
  assert.notEqual(seeded, real, "the api.js import is the stub seam");
  const outfile = join(tmpRoot, "actions.built.mjs");
  await build({
    stdin: {
      contents: `${seeded}\n`,
      resolveDir: webRoot, loader: "js", sourcefile: "overwatch-actions.js",
    },
    bundle: true, format: "esm", platform: "neutral",
    outfile, logLevel: "silent",
  });
  return await import(outfile);
}

test("wire ac: every contract route rides request() with the exact path, method, body", async () => {
  const { createOverwatchActions, record } = await bundledActions();
  const active = { url: "https://hub.family", token: "member-token", identity: { id: "did_owner" }, deviceId: "dev" };

  const actions = createOverwatchActions({ active });
  record.length = 0;
  const run = async (label, promise, expected) => {
    await promise;
    const call = record.pop();
    assert.ok(call, label);
    assert.equal(call.connection, active, label);
    assert.equal(call.url, expected.url, label);
    assert.equal(call.method, expected.method ?? "GET", label);
    if (expected.body) assert.deepEqual(call.body, expected.body, label);
  };
  const base = "https://hub.family/api/overwatch";
  const NOW_SEC = Math.floor(Date.now() / 1000);
  await run("state", actions.loadState(), { url: `${base}/state` });
  await run("dial-read", actions.loadDial(), { url: `${base}/dial` });
  await run("dial-write", actions.saveDial(4), { method: "PUT", url: `${base}/dial`, body: { frameRate: 4 } });
  await run("tracked", actions.loadTracked(), { url: `${base}/tracked` });
  await run("follow", actions.followEntity("e_person"), { method: "POST", url: `${base}/tracked/e_person/follow` });
  await run("unfollow", actions.unfollowEntity("e_person"), { method: "DELETE", url: `${base}/tracked/e_person/follow` });
  await run("stream", actions.loadEntityStream("e_person"), { url: `${base}/tracked/e_person/stream` });
  await run("zone-put", actions.saveZone("cam_driveway", [[0, 0], [1, 1]]), {
    method: "PUT", url: `${base}/zones/cam_driveway`, body: { polygon: [[0, 0], [1, 1]] },
  });
  await run("zone-delete", actions.deleteZone("cam_driveway"), { method: "DELETE", url: `${base}/zones/cam_driveway` });
  await run("adjacency", actions.saveAdjacency([["a", "b"]]), { method: "PUT", url: `${base}/adjacency`, body: { pairs: [["a", "b"]] } });
  await run("travel-time", actions.saveTravelTime([{ key: "a|b", min: 10, max: 10 }]), {
    method: "PUT", url: `${base}/travel-time`, body: { updates: { "a|b": { min: 10, max: 10 } } },
  });
  await run("flag", actions.flagAssociation({ fromEntityId: "e1", toEntityId: "e2" }), {
    method: "POST", url: `${base}/association/flag`, body: { fromEntityId: "e1", toEntityId: "e2" },
  });
  await run("visits-window", actions.loadVisits({ from: "2026-11-25T00:00:00Z", to: "2026-11-26T00:00:00Z" }), {
    url: `${base}/visits?from=${Date.parse("2026-11-25T00:00:00Z") / 1000}&to=${Date.parse("2026-11-26T00:00:00Z") / 1000}`,
  });
  await run("visits-default", actions.loadVisits({}), { url: `${base}/visits?from=${NOW_SEC - 86400}&to=${NOW_SEC}` });
  await run("visit-timeline", actions.loadVisitTimeline("v1"), { url: `${base}/visits/v1/timeline` });
  await run("audit", actions.loadAudit({ type: "dial", limit: 10 }), { url: `${base}/audit?type=dial&limit=10` });
  assert.equal(record.length, 0, "each action rode exactly one request");

  // No open connection: the honest guard, never a silent no-op.
  assert.throws(() => createOverwatchActions({ active: null }).loadState(), /Connect this device/);
  assert.throws(() => createOverwatchActions({ active: { url: "https://hub.family" } }).loadState(), /Connect this device/);
});

/* ---- the wiring of record ---------------------------------------------- */

test("wiring ac: the route registers exactly where the other screens do", () => {
  // The dispatch line sits in the shell's routeOf-driven page ladder.
  assert.match(mainSource, /else if \(route === "\/overwatch"\) page = <Overwatch \{\.\.\.props\} \/>;/);
  assert.match(mainSource, /import \{ Overwatch \} from "\.\/overwatch\.jsx";/);
  assert.match(mainSource, /import \{ createOverwatchActions \} from "\.\/overwatch-actions\.js";/);
  assert.match(mainSource, /\.\.\.createOverwatchActions\(\{ active, navigate \}\)/);
  // The nav affordance rides the same primary/labels/icons trio every family
  // tab uses (the header and the mobile bottom navigation both derive).
  assert.match(mainSource, /"\/settings", "\/overwatch"\]/);
  assert.match(mainSource, /"Compose", "Settings", "Overwatch"\]/);
  assert.match(mainSource, /<VideocamOutlined \/>/);
});

test("wiring ac: the wire file carries the full contract of routes", () => {
  const routes = [
    ["loadState", /"overwatch\/state"/],
    ["saveZone", /`overwatch\/zones\/\$\{enc\(cameraId\)\}`/],
    ["deleteZone", /`overwatch\/zones\/\$\{enc\(cameraId\)\}`/],
    ["saveAdjacency", /"overwatch\/adjacency"/],
    ["saveTravelTime", /"overwatch\/travel-time"/],
    ["loadDial", /"overwatch\/dial"/],
    ["saveDial", /"overwatch\/dial"/],
    ["loadTracked", /"overwatch\/tracked"/],
    ["followEntity", /`overwatch\/tracked\/\$\{enc\(entityId\)\}\/follow`/],
    ["unfollowEntity", /`overwatch\/tracked\/\$\{enc\(entityId\)\}\/follow`/],
    ["loadEntityStream", /`overwatch\/tracked\/\$\{enc\(entityId\)\}\/stream`/],
    ["loadVisits", /`overwatch\/visits\$\{queryString\(\{ from: windowFrom, to: windowTo \}\)\}`/],
    ["loadVisitTimeline", /`overwatch\/visits\/\$\{enc\(visitId\)\}\/timeline`/],
    ["flagAssociation", /"overwatch\/association\/flag"/],
    ["loadAudit", /`overwatch\/audit/],
  ];
  for (const [action, needle] of routes) {
    const start = actionsSource.indexOf(`${action}`);
    assert.notEqual(start, -1, `action ${action} exists`);
    const block = actionsSource.slice(start, start + 1200);
    assert.match(block, needle, `${action} rides its contract route`);
  }
  // Plain contract bodies — no signing envelope on the Overwatch plane.
  assert.match(actionsSource, /JSON\.stringify\(\{ polygon/);
  assert.match(actionsSource, /JSON\.stringify\(\{ pairs/);
  assert.match(actionsSource, /JSON\.stringify\(\{ updates/);
  assert.doesNotMatch(actionsSource, /payload.*signature|signDevicePayload/);
});
