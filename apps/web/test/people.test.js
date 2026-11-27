// PORCH-141: the People & Things surfaces. The pure model pins directly
// (node --test); the real screen and the real wire half bundle with esbuild
// and render with a stubbed api/connection (the overwatch.test.js render-sweep
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
  annotationsForEntity, annotationsForEvent, annotationsForTrackRow, annotationsForVisit,
  annotationLines, confidencePercent, decisionLabel, decisionLabelOf, entriesOf, entrySubtitle,
  enrolledForCopy, evidenceWindow, frameFromDataUrl, metricsCopy, namesByEntryId,
  OFF_POSTURE_COPY, purgeCopy, sightingCopy, sightingCountCopy, sightingHasEvidence,
  sightedEvent, sightDateCopy, settingsPosture, validateEnrollDraft,
} from "../src/people-model.js";

const here = dirname(fileURLToPath(import.meta.url));
const webRoot = fileURLToPath(new URL("../", import.meta.url));
const src = async (file) => await readFile(join(webRoot, file), "utf8");
const mainSource = await src("src/main.jsx");
const homeSource = await src("src/home.jsx");
const overwatchSource = await src("src/overwatch.jsx");
const actionsSource = await src("src/people-actions.js");

const EXTERNALS = ["react", "react-dom", "@mui/*", "@emotion/*", "@noble/*"];

const tmpRoot = join(here, `.tmp141-${process.pid}`);
await mkdir(tmpRoot, { recursive: true });
after(async () => { await rm(tmpRoot, { recursive: true, force: true }); });

/** The bundled entry for one render sweep. */
let Surface = null;
async function screenSurface() {
  if (Surface) return Surface;
  await build({
    stdin: { contents: 'export { People, RecognitionSwitch, EntryRow, SightingRow } from "./src/people.jsx";', resolveDir: webRoot, loader: "jsx", sourcefile: "entry.jsx" },
    bundle: true, format: "esm", jsx: "automatic", platform: "neutral",
    external: EXTERNALS,
    outfile: join(tmpRoot, "screen.built.mjs"), logLevel: "silent",
  });
  Surface = await import(join(tmpRoot, "screen.built.mjs"));
  return Surface;
}

/* ---- the uncertainty law: one decision-label helper -------------------- */

const NOW_MS = 1_760_000_000_000; // a fixed "now" so relative copy is stable

test("model ac-2: asserted matches render the name plainly; looks-like never asserts", () => {
  assert.equal(decisionLabel("Mom", "asserted", 0.99), "Mom");
  assert.equal(decisionLabel("Dad's truck", "looks-like", 0.823), "looks like Dad's truck (82%)");
  // The uncalibrated posture: no confidence, bare looks-like — never a guess.
  assert.equal(decisionLabel("Mom", "looks-like", undefined), "looks like Mom");
  // Any decision that is not asserted is treated under the uncertainty law.
  assert.equal(decisionLabel("Mom", "unknown-decision", 0.5), "looks like Mom (50%)");
  // Junk and out-of-range confidence drop the percent rather than misstate it.
  assert.equal(decisionLabel("Mom", "looks-like", "0.9"), "looks like Mom");
  assert.equal(decisionLabel("Mom", "looks-like", 1.4), "looks like Mom");
  assert.equal(decisionLabel("Mom", "looks-like", -0.1), "looks like Mom");
  // No entry name: nothing renders, never a guessed identity.
  assert.equal(decisionLabel(undefined, "asserted", 1), null);
  assert.equal(decisionLabel("  ", "looks-like", 0.5), null);
});

test("model ac-2: confidence percents come from 0–1 only", () => {
  assert.equal(confidencePercent(0.5), 50);
  assert.equal(confidencePercent(0), 0);
  assert.equal(confidencePercent(1), 100);
  assert.equal(confidencePercent(0.5), 50);
  assert.equal(confidencePercent(null), null);
  assert.equal(confidencePercent("x"), null);
});

test("model ac-1: the name index joins annotations to entries by reference", () => {
  const names = namesByEntryId([
    { _id: "fce_1", name: "Mom" },
    { _id: "veh_1", name: "Dad's truck" },
    { _id: "fce_2", name: "  " },
    {},
  ]);
  assert.deepEqual(names, { fce_1: "Mom", veh_1: "Dad's truck" });
  assert.equal(
    decisionLabelOf(names, { entryId: "veh_1", decision: "looks-like", confidence: 0.72 }),
    "looks like Dad's truck (72%)",
  );
  // An unresolved entry renders nothing.
  assert.equal(decisionLabelOf(names, { entryId: "fce_9", decision: "asserted" }), null);
  assert.equal(decisionLabelOf(null, { entryId: "fce_1", decision: "asserted" }), null);
});

/* ---- the posture: the switch of record's two states -------------------- */

test("model ac-6: the posture names off as nothing-computes and points at the head for enrollment", () => {
  const off = settingsPosture({ enabled: false });
  assert.equal(off.on, false);
  assert.equal(off.copy, OFF_POSTURE_COPY);
  assert.match(off.copy, /off for this home/);
  assert.match(off.copy, /head of People & Things/);
  assert.match(off.copy, /keeps rendering/);
  assert.doesNotMatch(off.copy, /entries (?:are|will be) cleared/i, "a switch never promises to clear the registry");

  const on = settingsPosture({ enabled: true, assertThreshold: 0.79 });
  assert.equal(on.on, true);
  assert.match(on.copy, /on for this home/);

  // Unread settings default honestly to off.
  assert.equal(settingsPosture(null).on, false);
  assert.equal(settingsPosture({}).on, false);
});

/* ---- annotation joins (ac-1 decoration) -------------------------------- */

const fixtures = {
  annotations: [
    { entryId: "fce_1", targetKind: "event", targetId: "evn_1", confidence: 0.93, decision: "asserted" },
    { entryId: "fce_2", targetKind: "track", targetId: "t-7", cameraId: "cam_a", trackId: "t-7", confidence: 0.61, decision: "looks-like" },
    { entryId: "veh_1", targetKind: "entity", targetId: "e_car", cameraId: "cam_b", trackId: "t-9", confidence: 0.88, decision: "asserted" },
    { entryId: "veh_1", targetKind: "visit", targetId: "v1", cameraId: "cam_a", trackId: "t-7", confidence: 0.95, decision: "asserted" },
  ],
  names: namesByEntryId([{ _id: "fce_1", name: "Mom" }, { _id: "fce_2", name: "Sam" }, { _id: "veh_1", name: "Dad's truck" }]),
};

test("model ac-1: event rows join annotations by target id and by track id", () => {
  const event = { _id: "evn_1", observations: [] };
  const joined = annotationsForEvent(fixtures.annotations, event);
  assert.deepEqual(joined.map((row) => row.targetId), ["evn_1"]);
  assert.deepEqual(annotationLines(fixtures.names, joined), ["Mom"], "asserted rows render the name plainly");

  // By track: the event's own track identity (and its observations') joins
  // the by-track rows.
  const trackedEvent = { _id: "evn_2", trackId: "t-7" };
  assert.deepEqual(annotationsForEvent(fixtures.annotations, trackedEvent).map((row) => row.entryId), ["fce_2"]);
  const observed = { _id: "evn_3", observations: [{ label: "person", trackId: "t-7" }] };
  assert.deepEqual(annotationsForEvent(fixtures.annotations, observed).map((row) => row.entryId), ["fce_2"]);
  // The decoration never asserts a looks-like row: the label carries the law.
  assert.deepEqual(
    annotationLines(fixtures.names, annotationsForEvent(fixtures.annotations, observed)),
    ["looks like Sam (61%)"],
  );
  // Unknown sightings: no rows exist, so no label ever appears.
  assert.deepEqual(annotationsForEvent(fixtures.annotations, { _id: "evn_x" }), []);
  assert.deepEqual(annotationsForEvent(null, { _id: "evn_1" }), []);
  assert.deepEqual(annotationsForEvent(fixtures.annotations, null), []);
});

test("model ac-1: overwatch tracked rows and visits join by target and by cameraId+trackId", () => {
  // The entity-targeted join.
  assert.deepEqual(annotationsForEntity(fixtures.annotations, { entityId: "e_car" }).map((row) => row.targetId), ["e_car"]);
  // The cameraId+trackId pair join — both must name the row's ground; a row
  // that targets an entity rides the target join instead, while any other
  // row whose track lands here decorates (a visit-targeted row for the same
  // track and camera included).
  assert.deepEqual(
    annotationsForEntity(fixtures.annotations, { entityId: "e_p", cameraId: "cam_a", trackId: "t-7" }).map((row) => row.targetId),
    ["t-7", "v1"],
  );
  // A camera alone never decorates.
  assert.deepEqual(annotationsForEntity(fixtures.annotations, { entityId: "e_p", cameraId: "cam_a" }), []);
  assert.deepEqual(annotationsForEntity(fixtures.annotations, null), []);

  // Visits join by targetId and by cameraId+trackId against the visit's own
  // cameras and entities.
  const visit = { visitId: "v1", cameras: ["cam_a", "cam_b"], entities: [{ entityId: "e_p", trackId: "t-7" }] };
  const joined = annotationsForVisit(fixtures.annotations, visit);
  assert.deepEqual(joined.map((row) => row.targetId), ["t-7", "v1"]);
  const bare = { visitId: "v2", cameras: ["cam_a"], entities: [{ entityId: "e_p" }] };
  // A visit with no tracked identity joins only its own visitId — the pair
  // join needs a track on the row's side.
  assert.deepEqual(annotationsForVisit(fixtures.annotations, bare), []);
  assert.deepEqual(annotationsForVisit(fixtures.annotations, null), []);
});

test("model ac-1: visit timeline rows join cameraId+trackId; a lone camera never matches", () => {
  const row = { kind: "clip", cameraId: "cam_a", trackId: "t-7" };
  assert.deepEqual(annotationsForTrackRow(fixtures.annotations, row).map((r) => r.entryId), ["fce_2", "veh_1"]);
  // Camera mismatch refuses even with the same track.
  assert.deepEqual(annotationsForTrackRow(fixtures.annotations, { cameraId: "cam_z", trackId: "t-7" }), []);
  // A timeline row without a track identity never decorates.
  assert.deepEqual(annotationsForTrackRow(fixtures.annotations, { cameraId: "cam_a" }), []);
});

test("model ac-1: annotation lines dedupe and drop unresolved references", () => {
  const rows = [
    { entryId: "fce_1", decision: "asserted" },
    { entryId: "fce_1", decision: "asserted" },
    { entryId: "fce_missing", decision: "asserted" },
    { entryId: "fce_2", decision: "looks-like", confidence: 0.4 },
  ];
  assert.deepEqual(annotationLines(fixtures.names, rows), ["Mom", "looks like Sam (40%)"]);
  assert.equal(annotationLines(fixtures.names, []), null);
  assert.equal(annotationLines({}, rows), null);
});

/* ---- registry rows ------------------------------------------------------ */

const entryMom = {
  _id: "fce_1", kind: "face", name: "Mom",
  enrolledFor: "visit", accountabilityNote: "Sam asked for her during the visit",
  sightings: [
    { at: Math.floor(NOW_MS / 1000), cameraId: "cam_driveway", eventId: "evn_1", confidence: 0.93, decision: "asserted" },
    { at: Math.floor(NOW_MS / 1000) - 3600, decision: "looks-like", confidence: 0.44 },
  ],
};
const entryTruck = { _id: "veh_1", kind: "vehicle", name: "Dad's truck", plateText: "6TRI889", sightings: [] };

test("model: registry sections filter by kind and honest counts", () => {
  const all = [entryMom, entryTruck, { _id: "x", kind: "other", name: "?" }];
  assert.deepEqual(entriesOf(all, "face").map((row) => row._id), ["fce_1"]);
  assert.deepEqual(entriesOf(all, "vehicle").map((row) => row._id), ["veh_1"]);
  assert.deepEqual(entriesOf([], "face"), []);
  assert.deepEqual(entriesOf(null, "face"), []);
  assert.equal(sightingCountCopy(entryMom), "2 sightings");
  assert.equal(sightingCountCopy(entryTruck), "0 sightings");
  assert.equal(sightingCountCopy({}), "0 sightings");
});

test("model: entry subtitles and the enrolledFor accountability line", () => {
  assert.equal(entrySubtitle(entryMom), "Face");
  assert.equal(entrySubtitle(entryTruck), "Vehicle · Plate 6TRI889");
  assert.equal(entrySubtitle({ kind: "vehicle", name: "x" }), "Vehicle");
  assert.equal(entrySubtitle({}), "Entry");
  assert.equal(enrolledForCopy(entryMom), "Enrolled for a visit — Accountability note: Sam asked for her during the visit");
  assert.equal(enrolledForCopy({ enrolledFor: "household" }), "Household");
  assert.equal(enrolledForCopy({}), null);
});

test("model: sighting rows copy when/where and the evidence affordance's gate", () => {
  assert.ok(typeof sightDateCopy(NOW_MS / 1000) === "string" && sightDateCopy(NOW_MS / 1000).length > 0);
  assert.equal(sightDateCopy("nope"), null);
  assert.equal(sightDateCopy(null), null);
  const nowSeconds = Math.floor(Date.now() / 1000);
  assert.match(sightingCopy({ at: nowSeconds, cameraId: "cam_driveway" }), /Camera cam_driveway/);
  assert.match(sightingCopy({ at: nowSeconds }), /now/, "a camera-less sighting still names its moment");
  assert.equal(sightingHasEvidence({ cameraId: "cam_a", eventId: "evn_1" }), true);
  assert.equal(sightingHasEvidence({ cameraId: "cam_a" }), false);
  assert.equal(sightingHasEvidence({ eventId: "evn_1" }), false);
});

/* ---- enrollment drafts -------------------------------------------------- */

test("model: the client refuses a malformed enrollment draft in plain language", () => {
  assert.equal(validateEnrollDraft({ kind: "face", frames: [{ format: "jpeg", data: "AA" }], name: " Mom " }), null, "trimmed names pass");
  assert.equal(validateEnrollDraft(undefined), "Give this entry a name.");
  assert.equal(validateEnrollDraft({ kind: "face", frames: [{ format: "jpeg", data: "AA" }], name: "" }), "Give this entry a name.");
  assert.equal(validateEnrollDraft({ kind: "face", frames: [], name: "Mom" }), "Add a photo showing the face to enroll.");
  assert.match(validateEnrollDraft({ kind: "face", name: "Mom" }), /Add a photo showing the face/);
  assert.match(validateEnrollDraft({ kind: "vehicle", name: "Truck" }), /plate text or a photo/);
  assert.equal(validateEnrollDraft({ kind: "vehicle", name: "Truck", plateText: "6TRI889" }), null, "plate-only vehicles enroll");
  assert.equal(validateEnrollDraft({ kind: "vehicle", name: "Truck", frames: [{ format: "jpeg", data: "AA" }] }), null);
  assert.match(
    validateEnrollDraft({ kind: "face", name: "Vera", frames: [{ format: "jpeg", data: "AA" }], enrolledFor: "visit" }),
    /accountability note/,
    "visit enrollment requires the enrolling member's accountability note",
  );
  assert.equal(
    validateEnrollDraft({ kind: "face", name: "Vera", frames: [{ format: "jpeg", data: "AA" }], enrolledFor: "visit", accountabilityNote: "asked by Sam" }),
    null,
  );
  assert.equal(validateEnrollDraft(null), "Give this entry a name.");
});

test("model: only real JPEG data URLs become contract frames", () => {
  assert.deepEqual(frameFromDataUrl("data:image/jpeg;base64,QUJD"), { format: "jpeg", data: "QUJD" });
  assert.equal(frameFromDataUrl("data:image/png;base64,QUJD"), null);
  assert.equal(frameFromDataUrl("QUJD"), null);
  assert.equal(frameFromDataUrl(null), null);
});

/* ---- purge receipt, metrics, evidence joins ----------------------------- */

test("model ac-3: the purge receipt counts exactly what went away", () => {
  assert.equal(
    purgeCopy({ purged: { entryId: "fce_1", descriptorVectors: 1, plateReads: 0, sightings: 2, annotations: 3 } }),
    "Deleted. Purged 1 descriptor vector, 0 plate reads, 2 sightings, 3 annotations.",
  );
  assert.equal(purgeCopy({}), "Deleted. Purged 0 descriptor vectors, 0 plate reads, 0 sightings, 0 annotations.");
  assert.equal(purgeCopy(null), "Deleted. Purged 0 descriptor vectors, 0 plate reads, 0 sightings, 0 annotations.");
});

test("model ac-4: the zero-computation audit line carries the four counters", () => {
  assert.equal(
    metricsCopy({ descriptorComputations: 12, plateReads: 3, recognitionRuns: 9, refusedDisabled: 4 }),
    "12 descriptor computations · 3 plate reads · 9 recognition runs · 4 runs refused while off",
  );
  assert.equal(metricsCopy({}), "0 descriptor computations · 0 plate reads · 0 recognition runs · 0 runs refused while off");
  assert.equal(metricsCopy(null), "0 descriptor computations · 0 plate reads · 0 recognition runs · 0 runs refused while off");
});

test("model: the evidence window and the sighted event join", () => {
  const window_ = evidenceWindow(1_760_000_000);
  assert.equal(window_.from, new Date((1_760_000_000 - 60) * 1000).toISOString());
  assert.equal(window_.to, new Date((1_760_000_000 + 60) * 1000).toISOString());
  assert.equal(evidenceWindow("nope"), null);
  assert.equal(evidenceWindow(null), null);

  const events = [{ _id: "evn_1" }, { _id: "evn_2" }];
  assert.equal(sightedEvent(events, { eventId: "evn_2" }), events[1]);
  assert.equal(sightedEvent(events, { cameraId: "cam_a" }), null);
  assert.equal(sightedEvent(events, { eventId: "evn_9" }), null);
  assert.equal(sightedEvent(null, { eventId: "evn_1" }), null);
});

/* ---- the screen: rendered sweeps ----------------------------------------
 * renderToString never runs effects, so the sweeps render the screen's
 * exported sections of record; the full screen render pins the honest first
 * paint (empty states, posture banner, no fetch churn). */

test("screen ac-6: the switch of record renders its state and the off posture", async () => {
  const { RecognitionSwitch } = await (await screenSurface());
  const noop = () => {};
  const off = renderToString(React.createElement(RecognitionSwitch, {
    settings: { homeId: "h1", enabled: false, assertThreshold: null, updatedAt: null, updatedBy: null },
    ownerHere: true, busy: false, error: "", onToggle: noop,
  }));
  assert.match(off, />Off</);
  assert.match(off, /type="checkbox"/, "the toggle rides a real checkbox input");
  assert.match(off, /stops upstream entirely/);
  assert.match(off, /without re-enrollment/);
  assert.match(off, /head of People (&amp;|&) Things/, "the off banner explains the switch at the People & Things head");
  assert.doesNotMatch(off, /checked=""/, "off means off");

  const on = renderToString(React.createElement(RecognitionSwitch, {
    settings: { homeId: "h1", enabled: true, assertThreshold: null, updatedAt: null, updatedBy: null },
    ownerHere: true, busy: false, error: "", onToggle: noop,
  }));
  assert.match(on, />On</);
  assert.match(on, /checked=""/);

  // A non-owner sees the switch disabled with the viewer hint.
  const viewer = renderToString(React.createElement(RecognitionSwitch, {
    settings: { homeId: "h1", enabled: true }, ownerHere: false, busy: false, error: "", onToggle: noop,
  }));
  assert.match(viewer, /disabled/);
  assert.match(viewer, /Only the family owner can change this switch\./);
});

test("screen ac-1/ac-2: registry rows carry the uncertainty law and the accountability line", async () => {
  const { EntryRow } = await (await screenSurface());
  const noops = { onRename: () => {}, onDelete: () => {}, onOpenEvidence: () => {} };
  const html = renderToString(React.createElement(EntryRow, { entry: entryMom, evidence: {}, defaultOpen: true, ...noops }));
  assert.match(html, />Mom</);
  assert.match(html, /2 sightings/);
  assert.match(html, /Enrolled for a visit — Accountability note: Sam asked for her during the visit/);
  // The asserted sighting renders the plain name; the looks-like one never does.
  assert.match(html, /<span[^>]*>Mom<\/span>/, "the asserted chip is the plain name");
  assert.match(html, /looks like Mom \(44%\)/);
  assert.match(html, /Camera cam_driveway/);
  assert.match(html, /Open evidence/);

  const vehicle = renderToString(React.createElement(EntryRow, { entry: entryTruck, evidence: {}, defaultOpen: true, ...noops }));
  assert.match(vehicle, />Dad&#x27;s truck<|>Dad's truck</);
  assert.match(vehicle, /Plate 6TRI889/);
  assert.match(vehicle, /0 sightings/);
  assert.match(vehicle, /No sightings recorded yet/);
});

test("screen ac-1: a sighting's evidence affordance rides only openable sightings", async () => {
  const { SightingRow } = await (await screenSurface());
  const openable = renderToString(React.createElement(SightingRow, {
    entryName: "Mom", sighting: { at: NOW_MS / 1000, cameraId: "cam_a", eventId: "evn_1", decision: "asserted" },
    evidence: null, onOpen: () => {},
  }));
  assert.match(openable, /Open evidence/);
  assert.match(openable, /Camera cam_a/);

  const closed = renderToString(React.createElement(SightingRow, {
    entryName: "Mom", sighting: { at: NOW_MS / 1000, decision: "looks-like", confidence: 0.3 },
    evidence: null, onOpen: () => {},
  }));
  assert.match(closed, /looks like Mom \(30%\)/);
  assert.doesNotMatch(closed, /Open evidence/);

  // The still render and the explained gap render their own states.
  const still = renderToString(React.createElement(SightingRow, {
    entryName: "Mom", sighting: { at: 1, cameraId: "cam_a", eventId: "e" },
    evidence: { phase: "still", url: "https://hub/media/still.jpg" }, onOpen: () => {},
  }));
  assert.match(still, /src="https:\/\/hub\/media\/still\.jpg"/);
  const gap = renderToString(React.createElement(SightingRow, {
    entryName: "Mom", sighting: { at: 1, cameraId: "cam_a", eventId: "e" },
    evidence: { phase: "gap", copy: "The footage wasn't available at that moment." }, onOpen: () => {},
  }));
  assert.match(gap, /The footage wasn&#x27;t available at that moment\.|The footage wasn't available at that moment\./);
});

const stubFixtures = {
  homes: { homes: [{ _id: "home-1", name: "Maple" }] },
  homeDetail: { home: { _id: "home-1", access: { role: "owner" } } },
  settings: { settings: { homeId: "home-1", enabled: false, assertThreshold: null, updatedAt: null, updatedBy: null } },
  entries: { entries: [], count: 0 },
  metrics: { metrics: { descriptorComputations: 0, plateReads: 0, recognitionRuns: 0, refusedDisabled: 0 } },
};

test("screen: with an empty hub the surface opens honestly empty", async () => {
  const { People } = await (await screenSurface());
  const { actions, calls } = stubActions({});
  const html = renderToString(React.createElement(People, { data: { server: { url: "https://hub.family" } }, actions }));
  assert.match(html, /People &amp; Things</);
  assert.match(html, />Faces</);
  assert.match(html, />Vehicles</);
  assert.match(html, /No faces enrolled yet\./);
  assert.match(html, /No vehicles enrolled yet\./);
  // The switch of record is at the head with the off posture.
  assert.match(html, /Recognition is off for this home/);
  // SSR renders without fetch churn; reads are effects.
  assert.deepEqual(calls, [], "SSR renders without fetch churn; reads are effects");
});

/* The populated registry rows render from the hub's state only after the
 * mount effects run — SSR (renderToString never runs effects) pins the
 * honest empty paint above, and the populated rows are swept at their own
 * component level (EntryRow, SightingRow, RecognitionSwitch). */

/** Records every wire call; answers from the fixture plan. */
function stubActions(plan = {}) {
  const calls = [];
  const answer = (route) => {
    if (route.startsWith("recognition/settings")) return plan.settings ?? stubFixtures.settings;
    if (route.startsWith("recognition/entries")) return plan.entries ?? stubFixtures.entries;
    if (route.startsWith("recognition/metrics")) return plan.metrics ?? stubFixtures.metrics;
    if (route.startsWith("recognition/annotations")) return plan.annotations ?? { annotations: [], count: 0 };
    if (route.startsWith("recognition/export")) return plan.export ?? { exportedAt: "now", entries: [] };
    return {};
  };
  const record = (method) => async (connection, route, init = {}) => {
    void connection;
    if ((init.method ?? "GET") !== method) return answer(route);
    calls.push({ method: init.method ?? "GET", route, body: init.body ? JSON.parse(init.body) : null });
    return answer(route);
  };
  const actions = {
    loadHomes: record("GET"),
    loadHome: record("GET"),
    loadRecognitionSettings: record("GET"),
    saveRecognitionSettings: record("PUT"),
    loadEntries: record("GET"),
    loadEntry: record("GET"),
    enrollEntry: record("POST"),
    renameEntry: record("PATCH"),
    deleteEntry: record("DELETE"),
    exportRegistry: record("GET"),
    loadAnnotations: record("GET"),
    loadMetrics: record("GET"),
    openViewSession: () => ({ token: "view-token", cameras: [] }),
    loadTimeline: record("GET"),
    seekCamera: record("GET"),
  };
  return { actions, calls };
}


/* ---- the wire half ----------------------------------------------------- */

/** The real people-actions.js, bundled with its api.js import replaced by an
 * inline recorder — the overwatch.test.js pattern. The /api/ join is proven
 * (api.js's own job). */
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
  const real = await readFile(join(webRoot, "src/people-actions.js"), "utf8");
  const seeded = real.replace('import { request } from "./api.js";', ACTIONS_STUB);
  assert.notEqual(seeded, real, "the api.js import is the stub seam");
  const outfile = join(tmpRoot, "actions.built.mjs");
  await build({
    stdin: {
      contents: `${seeded}\n`,
      resolveDir: webRoot, loader: "js", sourcefile: "people-actions.js",
    },
    bundle: true, format: "esm", platform: "neutral",
    outfile, logLevel: "silent",
  });
  return await import(outfile);
}

test("wire ac: every recognition route rides request() with the exact path, method, body", async () => {
  const { createPeopleActions, record } = await bundledActions();
  const active = { url: "https://hub.family", token: "member-token", identity: { id: "did_owner" }, deviceId: "dev" };

  const actions = createPeopleActions({ active });
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
  const base = "https://hub.family/api/recognition";
  await run("settings-read", actions.loadRecognitionSettings("home-1"), { url: `${base}/settings?homeId=home-1` });
  await run("settings-on", actions.saveRecognitionSettings("home-1", true), {
    method: "PUT", url: `${base}/settings?homeId=home-1`, body: { enabled: true },
  });
  await run("settings-off", actions.saveRecognitionSettings("home-1", false), {
    method: "PUT", url: `${base}/settings?homeId=home-1`, body: { enabled: false },
  });
  await run("entries-list", actions.loadEntries("home-1"), { url: `${base}/entries?homeId=home-1` });
  await run("entries-kind", actions.loadEntries("home-1", "vehicle"), { url: `${base}/entries?homeId=home-1&kind=vehicle` });
  await run("entry-read", actions.loadEntry("fce_1", "home-1"), { url: `${base}/entries/fce_1?homeId=home-1` });
  await run("enroll-face", actions.enrollEntry({
    homeId: "home-1", kind: "face", name: "Mom",
    frames: [{ format: "jpeg", data: "QUJD" }],
    enrolledFor: "visit", accountabilityNote: "Sam asked for her",
  }), {
    method: "POST", url: `${base}/entries`,
    body: { homeId: "home-1", kind: "face", name: "Mom", frames: [{ format: "jpeg", data: "QUJD" }], enrolledFor: "visit", accountabilityNote: "Sam asked for her" },
  });
  await run("enroll-vehicle-plate", actions.enrollEntry({
    homeId: "home-1", kind: "vehicle", name: "Dad's truck", plateText: "6TRI889",
  }), {
    method: "POST", url: `${base}/entries`,
    body: { homeId: "home-1", kind: "vehicle", name: "Dad's truck", plateText: "6TRI889" },
  });
  await run("enroll-household", actions.enrollEntry({ homeId: "home-1", kind: "face", name: "Mom", frames: [{ format: "jpeg", data: "Q" }], enrolledFor: "household" }), {
    method: "POST", url: `${base}/entries`,
    body: { homeId: "home-1", kind: "face", name: "Mom", frames: [{ format: "jpeg", data: "Q" }], enrolledFor: "household" },
  });
  await run("rename", actions.renameEntry("fce_1", "home-1", { name: "Mom H." }), {
    method: "PATCH", url: `${base}/entries/fce_1?homeId=home-1`, body: { name: "Mom H." },
  });
  await run("rename-plate", actions.renameEntry("veh_1", "home-1", { name: "Truck", plateText: "6TRI889" }), {
    method: "PATCH", url: `${base}/entries/veh_1?homeId=home-1`, body: { name: "Truck", plateText: "6TRI889" },
  });
  await run("purge", actions.deleteEntry("fce_1", "home-1"), { method: "DELETE", url: `${base}/entries/fce_1?homeId=home-1` });
  await run("export", actions.exportRegistry("home-1"), { url: `${base}/export?homeId=home-1` });
  await run("annotations", actions.loadAnnotations("home-1"), { url: `${base}/annotations?homeId=home-1` });
  await run("metrics", actions.loadMetrics("home-1"), { url: `${base}/metrics?homeId=home-1` });
  assert.equal(record.length, 0, "each action rode exactly one request");

  // Malformed kinds never reach the wire; the hub's validation stays the record.
  await actions.enrollEntry({ homeId: "home-1", kind: "cat", name: "Whiskers" });
  const junk = record.pop();
  assert.deepEqual(junk.body, { homeId: "home-1", name: "Whiskers" });
  await actions.loadEntries("home-1", "nope");
  assert.equal(record.pop().url, `${base}/entries?homeId=home-1`);

  // No open connection: the honest guard, never a silent no-op.
  assert.throws(() => createPeopleActions({ active: null }).loadEntries("home-1"), /Connect this device/);
  assert.throws(() => createPeopleActions({ active: { url: "https://hub.family" } }).loadEntries("home-1"), /Connect this device/);
});

/* ---- the wiring of record ---------------------------------------------- */

test("wiring ac: the tab registers exactly where the other screens do", () => {
  // The dispatch line sits in the shell's routeOf-driven page ladder, right
  // after the Overwatch entry.
  assert.match(mainSource, /else if \(route === "\/people"\) page = <People \{\.\.\.props\} \/>;/);
  assert.match(mainSource, /import \{ People \} from "\.\/people\.jsx";/);
  assert.match(mainSource, /import \{ createPeopleActions \} from "\.\/people-actions\.js";/);
  assert.match(mainSource, /\.\.\.createPeopleActions\(\{ active, navigate \}\)/);
  // The nav affordance rides the same primary/labels/icons trio every family
  // tab uses, placed AFTER the overwatch entry and the People & Things entry
  // (PORCH-142 appends Watchlists at index 7, after People & Things).
  assert.match(mainSource, /"\/settings", "\/overwatch", "\/people", "\/watchlists", "\/agent"\]/);
  assert.match(mainSource, /"Compose", "Settings", "Overwatch", "People & Things", "Watchlists", "Agent"\]/);
  assert.match(mainSource, /<FaceOutlined \/>, <LabelOutlined \/>/);
});

test("wiring ac-1: the two decorations ride the pure people-model joins", () => {
  // home.jsx decorates its camera-activity events through the event join.
  assert.match(homeSource, /annotationsForEvent\(recognitions\.annotations, event\)/);
  assert.match(homeSource, /namesByEntryId/);
  // overwatch.jsx decorates tracked rows, visits, and timeline rows.
  assert.match(overwatchSource, /annotationsForEntity\(recognitions\.annotations, entity\)/);
  assert.match(overwatchSource, /annotationsForVisit\(recognitions\.annotations, visit\)/);
  assert.match(overwatchSource, /annotationsForTrackRow\(annotations, group\)/);
});

test("wiring ac: the wire file carries the full contract of routes", () => {
  const routes = [
    ["loadRecognitionSettings", /`recognition\/settings\$\{queryString\(\{ homeId \}\)\}`/],
    ["saveRecognitionSettings", /`recognition\/settings\$\{queryString\(\{ homeId \}\)\}`/],
    ["loadEntries", /`recognition\/entries\$\{queryString\(\{ homeId, kind: kindOf\(kind\) \}\)\}`/],
    ["loadEntry", /`recognition\/entries\/\$\{enc\(entryId\)\}\$\{queryString\(\{ homeId \}\)\}`/],
    ["enrollEntry", /"recognition\/entries"/],
    ["renameEntry", /`recognition\/entries\/\$\{enc\(entryId\)\}\$\{queryString\(\{ homeId \}\)\}`/],
    ["deleteEntry", /`recognition\/entries\/\$\{enc\(entryId\)\}\$\{queryString\(\{ homeId \}\)\}`/],
    ["exportRegistry", /`recognition\/export\$\{queryString\(\{ homeId \}\)\}`/],
    ["loadAnnotations", /`recognition\/annotations\$\{queryString\(\{ homeId \}\)\}`/],
    ["loadMetrics", /`recognition\/metrics\$\{queryString\(\{ homeId \}\)\}`/],
  ];
  for (const [action, needle] of routes) {
    const start = actionsSource.indexOf(`${action}`);
    assert.notEqual(start, -1, `action ${action} exists`);
    const block = actionsSource.slice(start, start + 900);
    assert.match(block, needle, `${action} rides its contract route`);
  }
  // Plain contract bodies — no signing envelope on the recognition plane.
  assert.match(actionsSource, /JSON\.stringify\(\{ enabled: enabled === true \}\)/);
  assert.match(actionsSource, /JSON\.stringify\(\{\s*\n\s*homeId,/);
  assert.doesNotMatch(actionsSource, /payload.*signature|signDevicePayload/);
});
