// PORCH-142: the Watchlists surfaces. The pure model pins directly
// (node --test) — copy, joins, and refusals, no DOM, no network (the
// people-model.test.js discipline): the honesty surface pins the few-shot
// bound statement of record verbatim, the scope chips label honestly, the
// flag→correction join only ever names a resolvable ground, and the class
// draft + detections answers refuse junk rather than guess.
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  ACCURACY_NOTE, TEACHING_COPY, SCOPE_HINTS, THUMBNAIL_CAP,
  accuracyStatement, correctionTargetOf, detectionCopy, detectionsForClass,
  examplesCopy, purgeReceipt, scopeHint, scopeLabel, thumbnailsOf,
  trainedObservationsOf, validateClassDraft,
} from "../src/watchlists-model.js";

/* ---- the honesty surface: the few-shot bound copy of record ------------- */

test("model ac-6: the teaching copy carries the expected-accuracy sentence verbatim", () => {
  assert.match(TEACHING_COPY, /Watchlists|^A watchlist/);
  // The bound statement of record rides the teaching copy verbatim — a
  // surface that paraphrases it breaks the honesty law.
  assert.ok(TEACHING_COPY.includes(ACCURACY_NOTE));
  assert.match(ACCURACY_NOTE, /narrow look-alike class/);
  assert.match(ACCURACY_NOTE, /calibrated threshold/);
  assert.match(ACCURACY_NOTE, /'looks like'/);
});

/* ---- the scope chip + its plain-language hint --------------------------- */

test("model ac-6: scope labels read Tracked / Detection only, nothing guessed", () => {
  assert.equal(scopeLabel("tracked"), "Tracked");
  assert.equal(scopeLabel("detection-only"), "Detection only");
  assert.equal(scopeLabel("junk"), null);
  assert.equal(scopeLabel(null), null);

  assert.match(scopeHint("tracked"), /followed between cameras/);
  assert.equal(scopeHint("tracked"), SCOPE_HINTS.tracked);
  assert.match(scopeHint("detection-only"), /never followed/);
  assert.equal(scopeHint("junk"), null);
});

/* ---- the expected-accuracy statement (the class row's honesty line) ----- */

test("model ac-6: accuracyStatement composes the note, the example count, and the measured hit rate", () => {
  const view = {
    expectedAccuracy: { note: ACCURACY_NOTE, hitRate: 0.72, exemplars: 3 },
  };
  assert.equal(accuracyStatement(view), `${ACCURACY_NOTE} Trained on 3 example photos. Held-out replays currently match 72% of the time.`);

  // One example photo, no measured rate yet — the sentence alone, no percent.
  assert.equal(
    accuracyStatement({ expectedAccuracy: { note: ACCURACY_NOTE, hitRate: null, exemplars: 1 } }),
    `${ACCURACY_NOTE} Trained on 1 example photo.`,
  );

  // No expected-accuracy answer: nothing renders, never a promise.
  assert.equal(accuracyStatement({}), null);
  assert.equal(accuracyStatement(null), null);
  assert.equal(accuracyStatement({ expectedAccuracy: null }), null);

  // Junk notes drop; a measured rate alone still renders.
  assert.equal(
    accuracyStatement({ expectedAccuracy: { note: "  ", hitRate: 0.5, exemplars: 0 } }),
    "Held-out replays currently match 50% of the time.",
  );
  // Junk hit rates drop the percent rather than misstate it.
  assert.equal(
    accuracyStatement({ expectedAccuracy: { note: "Some note.", hitRate: 1.4, exemplars: 2 } }),
    "Some note. Trained on 2 example photos.",
  );
});

/* ---- the flag→correction join (the home flag hook's ground) ------------- */

const JPEG = "data:image/jpeg;base64,QUJD";

test("model ac-3: trainedObservationsOf keeps only observations that name a trained class", () => {
  const event = {
    observations: [
      { label: "Newspaper carrier", confidence: 0.9 },
      { label: "person", confidence: 0.95 },
      { cls: "Red sedan", confidence: 0.8 },
      { label: "cat", confidence: 0.7 },
      null,
    ],
  };
  const rows = trainedObservationsOf(event, ["Newspaper carrier", "Red sedan"]);
  assert.deepEqual(rows, [
    { label: "Newspaper carrier", confidence: 0.9 },
    { cls: "Red sedan", confidence: 0.8 },
  ]);

  // Junk events and junk label pools contribute nothing.
  assert.deepEqual(trainedObservationsOf(null, ["Newspaper carrier"]), []);
  assert.deepEqual(trainedObservationsOf(event, null), []);
  assert.deepEqual(trainedObservationsOf(event, []), []);
  assert.deepEqual(trainedObservationsOf({ observations: "junk" }, ["cat"]), []);
});

test("model ac-3: correctionTargetOf resolves the flagged event's camera+track, or nothing", () => {
  // The last observation wins, and both halves must resolve.
  assert.deepEqual(
    correctionTargetOf({
      observations: [
        { cameraId: "cam_1", trackId: "trk_1" },
        { cameraId: "cam_2", trackId: "trk_2" },
      ],
    }),
    { cameraId: "cam_2", trackId: "trk_2" },
  );

  // The timeline projection keeps only label+confidence per observation, so
  // the event's own copies carry the ground.
  assert.deepEqual(
    correctionTargetOf({ trackId: "trk_9", cameraRefs: ["cam_9"], observations: [{ label: "Red sedan" }] }),
    { cameraId: "cam_9", trackId: "trk_9" },
  );

  // A camera alone, or a track alone, never feeds a correction.
  assert.equal(correctionTargetOf({ trackId: "trk_9", observations: [{ label: "Red sedan" }] }), null);
  assert.equal(correctionTargetOf({ cameraRefs: ["cam_9"], observations: [{ label: "Red sedan" }] }), null);
  assert.equal(correctionTargetOf(null), null);
  assert.equal(correctionTargetOf({}), null);
});

/* ---- class drafts (the create flow's refusals) --------------------------- */

test("model ac-6: validateClassDraft refuses junk with the hub's plain language", () => {
  const frame = { format: "jpeg", data: "QUJD" };
  assert.equal(validateClassDraft({ label: "Red sedan", frames: [frame] }), null);
  assert.equal(validateClassDraft({ label: "Newspaper carrier", frames: [{ format: "jpeg", data: JPEG.slice("data:image/jpeg;base64,".length) }] }), null);

  // Junk labels refuse.
  assert.equal(validateClassDraft({ frames: [frame] }), "Give this class a name.");
  assert.equal(validateClassDraft({ label: "   ", frames: [frame] }), "Give this class a name.");

  // Missing or empty frames refuse.
  assert.equal(validateClassDraft({ label: "Red sedan" }), "Add at least one photo showing the thing to learn.");
  assert.equal(validateClassDraft({ label: "Red sedan", frames: [] }), "Add at least one photo showing the thing to learn.");

  // The frames' format of record is jpeg — anything else refuses.
  assert.equal(
    validateClassDraft({ label: "Red sedan", frames: [{ format: "png", data: "QUJD" }] }),
    "Use JPEG photos — another picture format can't teach the class.",
  );
  assert.equal(
    validateClassDraft({ label: "Red sedan", frames: [{ format: "jpeg" }] }),
    "Use JPEG photos — another picture format can't teach the class.",
  );

  // Junk drafts refuse rather than crash or guess.
  assert.equal(validateClassDraft(null), "Give this class a name.");
  assert.equal(validateClassDraft({}), "Give this class a name.");
});

/* ---- a class's recorded detections (the bounded reviews) ----------------- */

const DETECTIONS = [
  { _id: "det_2", label: "Red sedan", decision: "asserted", confidence: 0.91, cameraId: "cam_1", trackId: "trk_1", at: 1_760_000_000 },
  { _id: "det_1", label: "Red sedan", decision: "looks-like", confidence: 0.55, cameraId: "cam_1", at: 1_759_999_000 },
  null,
  { label: "", decision: "asserted" },
  { _id: "det_0", label: "Red sedan" },
];

test("model ac-3: detectionsForClass answers the rows of record, junk dropped, hub order kept", () => {
  const rows = detectionsForClass({ detections: DETECTIONS });
  assert.deepEqual(
    rows.map((row) => row._id),
    ["det_2", "det_1"],
  );
  // Honest empty answers, and junk answers contribute nothing.
  assert.deepEqual(detectionsForClass({ detections: [] }), []);
  assert.deepEqual(detectionsForClass({}), []);
  assert.deepEqual(detectionsForClass(null), []);
});

test("model ac-3: a detection row's copy renders when and where, honest unknown time", () => {
  // Where renders when the row carries it.
  assert.match(detectionCopy({ at: 1_760_000_000, cameraId: "cam_1", trackId: "trk_1" }), / · Camera cam_1 · Track trk_1$/);
  assert.match(detectionCopy({ at: 1_760_000_000, cameraId: "cam_1" }), / · Camera cam_1$/);
  // A row with no ground carries no decoration; a bad epoch renders the
  // honest unknown time rather than a guessed date.
  assert.match(detectionCopy({ at: 0 }), /^Unknown time$/);
  assert.equal(detectionCopy(null), "Unknown time");
});

/* ---- thumbnails, counts, and the purge receipt --------------------------- */

test("model ac-6: thumbnails cap at four and keep only real image data URLs", () => {
  const exemplars = Array.from({ length: 6 }, (_, index) => ({ image: `data:image/jpeg;base64,${index}` }));
  const thumbs = thumbnailsOf({ exemplars });
  assert.equal(thumbs.length, THUMBNAIL_CAP);
  assert.equal(thumbs[0], exemplars[0].image);
  // Junk images drop rather than render.
  assert.deepEqual(
    thumbnailsOf({ exemplars: [{ image: "https://example.test/x.jpg" }, { image: JPEG }, null] }),
    [JPEG],
  );
  assert.deepEqual(thumbnailsOf(null), []);
});

test("model ac-6: example-photo counts and the purge receipt count exactly", () => {
  assert.equal(examplesCopy({ exemplars: [1, 2, 3] }), "3 example photos");
  assert.equal(examplesCopy({ exemplars: [1] }), "1 example photo");
  assert.equal(examplesCopy({}), "0 example photos");

  assert.equal(
    purgeReceipt({ purged: { classId: "wtl_1", exemplars: 4, detections: 12 } }),
    "Deleted. Purged 4 example photos and 12 recorded detections.",
  );
  assert.equal(purgeReceipt({ purged: { exemplars: 1, detections: 1 } }), "Deleted. Purged 1 example photo and 1 recorded detection.");
  assert.equal(purgeReceipt(null), "Deleted. Purged 0 example photos and 0 recorded detections.");
});

/* ---- the wiring of record (main.jsx + home.jsx + the wire half) --------- */

const { readFile } = await import("node:fs/promises");
const { join } = await import("node:path");
const { fileURLToPath } = await import("node:url");
const webRoot = fileURLToPath(new URL("../", import.meta.url));
const src = async (file) => await readFile(join(webRoot, file), "utf8");
const mainSource = await src("src/main.jsx");
const homeSource = await src("src/home.jsx");
const actionsSource = await src("src/watchlists-actions.js");

test("wiring ac-6: the Watchlists tab registers exactly where the other screens do", () => {
  assert.match(mainSource, /import \{ Watchlists \} from "\.\/watchlists\.jsx";/);
  assert.match(mainSource, /import \{ createWatchlistActions \} from "\.\/watchlists-actions\.js";/);
  assert.match(mainSource, /\.\.\.createWatchlistActions\(\{ active, navigate \}\)/);
  assert.match(mainSource, /else if \(route === "\/watchlists"\) page = <Watchlists \{\.\.\.props\} \/>;/);
  // The nav affordance rides the same primary/labels/icons trio, appended
  // AFTER the People & Things entry (index 7; compose stays special-cased
  // at index 3).
  assert.match(mainSource, /"\/settings", "\/overwatch", "\/people", "\/watchlists"\]/);
  assert.match(mainSource, /"Compose", "Settings", "Overwatch", "People & Things", "Watchlists"\]/);
  assert.match(mainSource, /<FaceOutlined \/>, <LabelOutlined \/>/);
});

test("wiring ac-3: the home flag hook feeds a resolvable correction target back best-effort", () => {
  // The flag rides the watchlists model's target join, after a successful
  // flagCameraEvent, and the call never carries a guess.
  assert.match(homeSource, /import \{ correctionTargetOf \} from "\.\/watchlists-model\.js";/);
  assert.match(homeSource, /const target = correctionTargetOf\(answer\?\.event \?\? event\);/);
  assert.match(homeSource, /await actions\.correctFromFlaggedEvent\?\.\(\{/);
  assert.match(homeSource, /correctFromFlaggedEvent[\s\S]{0,400}catch \{\}/, "the best-effort call is swallowed");
});

test("wiring ac-6: the wire file carries the full contract of routes", () => {
  const routes = [
    ["loadWatchlists", /`recognition\/watchlists\$\{queryString\(\{ homeId \}\)\}`/],
    ["loadWatchlistClass", /`recognition\/watchlists\/\$\{enc\(classId\)\}\$\{queryString\(\{ homeId \}\)\}`/],
    ["createWatchlistClass", /"recognition\/watchlists"/],
    ["retrainWatchlistClass", /`recognition\/watchlists\/\$\{enc\(classId\)\}\/retrain`/],
    ["correctFromFlaggedEvent", /"recognition\/watchlists\/corrections"/],
    ["deleteWatchlistClass", /`recognition\/watchlists\/\$\{enc\(classId\)\}\$\{queryString\(\{ homeId \}\)\}`/],
    ["loadWatchlistVocabulary", /`recognition\/watchlists\/vocabulary\$\{queryString\(\{ homeId \}\)\}`/],
    ["loadWatchlistDetections", /`recognition\/watchlists\/\$\{enc\(classId\)\}\/detections\$\{queryString\(\{ homeId, limit \}\)\}`/],
  ];
  for (const [action, needle] of routes) {
    const start = actionsSource.indexOf(`${action}`);
    assert.notEqual(start, -1, `action ${action} exists`);
    const block = actionsSource.slice(start, start + 900);
    assert.match(block, needle, `${action} rides its contract route`);
  }
  // Plain contract bodies — no signing envelope on the recognition plane,
  // and `?homeId=` everywhere the contract names it.
  assert.match(actionsSource, /JSON\.stringify\(\{\s*\n\s*homeId,/);
  assert.doesNotMatch(actionsSource, /signDevicePayload/);
});
