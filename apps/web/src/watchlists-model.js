// PORCH-142: the Watchlists surfaces' model of record. Pure data, copy and
// joins — no DOM, no React, no network — so `node --test` loads it directly
// (the people-model.js / camera-model.js discipline). The screen
// (watchlists.jsx) renders from this module's vocabulary; watchlists-actions.js
// is the wire half against the recognition REST plane.
//
// The honesty law lives here: a watchlist class is a few-shot learner, and
// every surface says so BEFORE training happens — the expected-accuracy
// sentence renders verbatim, and detections below a class's calibrated
// threshold render "looks like" — never an asserted name.

import { confidencePercent, sightDateCopy } from "./people-model.js";

const nonEmpty = (value) => typeof value === "string" && value.trim() !== "";

const firstNonEmpty = (...values) => values.find((value) => nonEmpty(value)) ?? null;

// ---------------------------------------------------------------------------
// Heading and the few-shot honesty copy of record
// ---------------------------------------------------------------------------

export const HEADING = "Watchlists";

/** The honest few-shot bound statement of record. The `expectedAccuracy.note`
 * sentence renders VERBATIM on every surface that shows or creates a class —
 * promised accuracy is never invented beyond it. */
export const ACCURACY_NOTE =
  "Each example teaches a narrow look-alike class; accuracy grows with the pool. The class asserts only at or above its calibrated threshold — below it detections render 'looks like'.";

/** The teaching copy of record: what a watchlist is, said plainly, with the
 * expected-accuracy sentence riding inside it. */
export const TEACHING_COPY =
  "A watchlist teaches the hub to recognize a thing from a handful of example photos, computed and stored on your hub like the People & Things registry — trained classes are not biometric entries. " + ACCURACY_NOTE;

export const CREATE_TITLE = "Train a new class";

// ---------------------------------------------------------------------------
// Tracking scope: the chip + the plain-language hint
// ---------------------------------------------------------------------------

export const SCOPE_HINTS = {
  tracked: "Tracked classes take part in tracking — an asserted sighting of this class is followed between cameras, the same way people and vehicles are.",
  "detection-only": "Detection-only classes label what a camera sees, frame by frame — they are never followed between cameras as a tracked thing.",
};

/** A class view's scope label: "Tracked" | "Detection only"; null for an
 * unreadable scope — the chip drops rather than guesses. */
export function scopeLabel(trackingScope) {
  if (trackingScope === "tracked") return "Tracked";
  if (trackingScope === "detection-only") return "Detection only";
  return null;
}

/** The plain-language hint under a scope chip; null for an unreadable scope. */
export function scopeHint(trackingScope) {
  return SCOPE_HINTS[trackingScope] ?? null;
}

// ---------------------------------------------------------------------------
// The expected-accuracy statement (the class row's honesty line)
// ---------------------------------------------------------------------------

/**
 * A class view's expected-accuracy statement, composed from the hub's
 * `expectedAccuracy` answer: the note verbatim, the trained example count,
 * and the held-out replay hit rate when one was measured. Nothing renders
 * without ground — no answer, no note, no invented percent.
 */
export function accuracyStatement(clsView) {
  const accuracy = clsView?.expectedAccuracy ?? null;
  if (!accuracy || typeof accuracy !== "object") return null;
  const parts = [];
  if (nonEmpty(accuracy.note)) parts.push(accuracy.note.trim());
  const percent = confidencePercent(accuracy.hitRate);
  const examples = Number(accuracy.exemplars);
  if (Number.isFinite(examples) && examples > 0) {
    parts.push(`Trained on ${examples} example photo${examples === 1 ? "" : "s"}.`);
  }
  if (percent != null) parts.push(`Held-out replays currently match ${percent}% of the time.`);
  return parts.length > 0 ? parts.join(" ") : null;
}

// ---------------------------------------------------------------------------
// Example photo thumbnails (bounded DOM) and the delete receipt
// ---------------------------------------------------------------------------

/** The DOM stays bounded: at most FOUR example thumbnails render per class. */
export const THUMBNAIL_CAP = 4;

/** A class view's example-photo thumbnails — real JPEG data URLs only,
 * capped at the render bound. */
export function thumbnailsOf(clsView) {
  return (Array.isArray(clsView?.exemplars) ? clsView.exemplars : [])
    .map((exemplar) => (typeof exemplar?.image === "string" && exemplar.image.startsWith("data:image/") ? exemplar.image : null))
    .filter(Boolean)
    .slice(0, THUMBNAIL_CAP);
}

/** One class row's example-photo count copy: honest zero included. */
export function examplesCopy(clsView) {
  const count = Array.isArray(clsView?.exemplars) ? clsView.exemplars.length : 0;
  return count === 1 ? "1 example photo" : `${count} example photos`;
}

/** The delete answer's plain-language receipt (confirm-then-refetch): exactly
 * what went away, count by count. */
export function purgeReceipt(purged) {
  const counts = purged?.purged ?? purged ?? {};
  const exemplars = Number(counts.exemplars ?? 0);
  const detections = Number(counts.detections ?? 0);
  return `Deleted. Purged ${exemplars} example photo${exemplars === 1 ? "" : "s"} and ${detections} recorded detection${detections === 1 ? "" : "s"}.`;
}

// ---------------------------------------------------------------------------
// Flagged events → corrections (the home flag hook + the honest join)
// ---------------------------------------------------------------------------

/** A trained-label set from one list of label strings — the join key the
 * trained-observation filter matches against. */
export function trainedLabelSet(trainedLabels) {
  return new Set((Array.isArray(trainedLabels) ? trainedLabels : []).filter(nonEmpty));
}

/**
 * A flagged event's observations that name a trained class: only facts the
 * hub itself asserts back — labels outside the trained list contribute
 * nothing. `trainedLabels` is the caller's set (the vocabulary read's
 * trained labels).
 */
export function trainedObservationsOf(event, trainedLabels) {
  const labels = trainedLabelSet(trainedLabels);
  return (Array.isArray(event?.observations) ? event.observations : [])
    .filter((observation) => labels.has(observation?.label) || labels.has(observation?.cls))
    .map((observation) => observation);
}

/**
 * The correction target a flagged event names: the camera and track of the
 * event's LAST observation, falling back to the event's own copies (the
 * timeline projection keeps only label+confidence per observation, while the
 * event carries its trackId and camera refs). Both must resolve — a camera
 * alone or a track alone never feeds a correction; null otherwise.
 */
export function correctionTargetOf(event) {
  const observations = Array.isArray(event?.observations) ? event.observations : [];
  const last = observations.length > 0 ? observations[observations.length - 1] : null;
  const cameraId = firstNonEmpty(last?.cameraId, event?.cameraId, Array.isArray(event?.cameraRefs) ? event.cameraRefs[0] : null);
  const trackId = firstNonEmpty(last?.trackId, event?.trackId);
  return nonEmpty(cameraId) && nonEmpty(trackId) ? { cameraId, trackId } : null;
}

// ---------------------------------------------------------------------------
// Class drafts (the create flow's client-side refusals)
// ---------------------------------------------------------------------------

/**
 * The client-side shape check for a class draft — the same plain language
 * the hub refuses with, before the wire ever sees it:
 *   - every class needs a name;
 *   - every class needs at least one example photo frame;
 *   - the frames' format of record is "jpeg" (frameFromDataUrl's shape).
 * Null = the draft may ride the wire; the hub's own refusals still render
 * verbatim (403 non-owner, 422 plain-language).
 */
export function validateClassDraft(draftInput) {
  const { label, frames } = draftInput ?? {};
  if (!nonEmpty(label)) return "Give this class a name.";
  if (!Array.isArray(frames) || frames.length === 0) return "Add at least one photo showing the thing to learn.";
  const valid = frames.every((frame) => frame?.format === "jpeg" && typeof frame?.data === "string" && frame.data !== "");
  if (!valid) return "Use JPEG photos — another picture format can't teach the class.";
  return null;
}

// ---------------------------------------------------------------------------
// Recorded detections (a class's own panel)
// ---------------------------------------------------------------------------

/** A detections answer's rows of record: null answers contribute nothing;
 * junk rows drop rather than render half a fact. The hub's order (newest
 * first) is preserved. */
export function detectionsForClass(answer) {
  return (Array.isArray(answer?.detections) ? answer.detections : []).filter(
    (row) => row != null && nonEmpty(row.label) && nonEmpty(row.decision),
  );
}

/** One detection row's copy: when, and where (camera and track when the row
 * carries them). */
export function detectionCopy(row) {
  const when = sightDateCopy(row?.at) ?? "Unknown time";
  const where = nonEmpty(row?.cameraId) ? ` · Camera ${row.cameraId}` : "";
  const track = nonEmpty(row?.trackId) ? ` · Track ${row.trackId}` : "";
  return `${when}${where}${track}`;
}
