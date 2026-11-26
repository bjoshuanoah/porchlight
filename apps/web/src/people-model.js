// PORCH-141: the People & Things surfaces' model of record. Pure data, copy
// and joins — no DOM, no React, no network — so `node --test` loads it
// directly (the overwatch-model.js / camera-model.js discipline). The screen
// (people.jsx) renders from this module's vocabulary; people-actions.js is
// the wire half against the recognition REST plane.
//
// The uncertainty law lives here, not in the screens: decision "asserted"
// renders the entry's name plainly; decision "looks-like" renders
// "looks like <name> (<pct>%)" with the confidence shown — a looks-like row
// NEVER asserts a name. Unknown sightings are unannotated upstream, so no
// row exists for them and nothing is invented here.

import { relativeTime } from "./time.js";

// ---------------------------------------------------------------------------
// Heading, kinds, and the switch of record's posture copy
// ---------------------------------------------------------------------------

export const HEADING = "People & Things";

export const FACES_TITLE = "Faces";
export const VEHICLES_TITLE = "Vehicles";

export const KIND_LABELS = { face: "Face", vehicle: "Vehicle" };

/** null for an unrecognized kind — the screen renders its own fallback,
 * never a guessed kind. */
export function kindLabel(kind) {
  return KIND_LABELS[kind] ?? null;
}

/** The head's posture line while recognition runs. The audit fact rides it —
 * descriptor computations are auditable in the metrics plane. */
export const ON_POSTURE_COPY =
  "Recognition is on for this home — recognized sightings annotate events and visits at the confidence shown, and every computation stays on the hub. The zero-computation audit rides the metrics below.";

/** OFF is a posture, not an error state: registry and history keep rendering,
 * and the copy explains the switch at the People & Things head. */
export const OFF_POSTURE_COPY =
  "Recognition is off for this home — nothing computes and no new sightings annotate. The registry below keeps rendering with existing entries and history, and no entry is ever cleared by a switch. Flip recognition on at the head of People & Things to enroll or resume.";

/** The switch's own label-of-record; the toggle is the household-visible
 * control of the biometric opt-in law. */
export const SWITCH_LABEL = "Recognition";

/** The posture of record for a settings row: `on` is the honest fact, the
 * copy explains the two states in plain language. */
export function settingsPosture(settings) {
  const on = settings?.enabled === true;
  return {
    on,
    copy: on ? ON_POSTURE_COPY : OFF_POSTURE_COPY,
  };
}

/** The owner-only hint under the switch when this viewer can't change it. */
export const SWITCH_VIEWER_COPY = "Only the family owner can change this switch.";

// ---------------------------------------------------------------------------
// The uncertainty law: one decision-label helper for every surface
// ---------------------------------------------------------------------------

/** A confidence (0–1) as the whole percent the UI shows; junk stays null —
 * the label drops its percent rather than guessing. */
export function confidencePercent(confidence) {
  const value = Number(confidence);
  if (typeof confidence !== "number" || !Number.isFinite(value) || value < 0 || value > 1) return null;
  return Math.round(value * 100);
}

/**
 * The one decision-label helper of record (the uncertainty law):
 *   asserted  → the name, plainly ("Mom")
 *   looks-like (or any unasserted decision) → "looks like Mom (82%)" with the
 *   confidence shown — NEVER an asserted name; an unread confidence renders
 *   "looks like Mom" bare rather than inventing a percent.
 * Null without a name — an unresolvable row renders nothing, never a guess.
 */
export function decisionLabel(name, decision, confidence) {
  if (typeof name !== "string" || name.trim() === "") return null;
  if (decision === "asserted") return name;
  const percent = confidencePercent(confidence);
  return `looks like ${name}${percent == null ? "" : ` (${percent}%)`}`;
}

/**
 * The entry-name index surfaces join against: entryId → name, from one
 * registry read. Renaming an entry renames history through this join — the
 * annotation rows carry references, never copied names.
 */
export function namesByEntryId(entries) {
  const names = {};
  for (const entry of Array.isArray(entries) ? entries : []) {
    if (entry?._id && typeof entry.name === "string" && entry.name.trim() !== "") {
      names[entry._id] = entry.name;
    }
  }
  return names;
}

/** The entry name an annotation references; null when unresolved. */
function nameOf(names, row) {
  const byId = names ?? {};
  const name = row?.entryId ? byId[row.entryId] : null;
  return typeof name === "string" && name.trim() !== "" ? name : null;
}

/** One annotation row's rendered label under the uncertainty law. */
export function decisionLabelOf(names, row) {
  return decisionLabel(nameOf(names, row), row?.decision, row?.confidence);
}

// ---------------------------------------------------------------------------
// Annotation joins (ac-1: recognized identities annotate events and visits)
// ---------------------------------------------------------------------------

const nonEmpty = (value) => typeof value === "string" && value.trim() !== "";

const unique = (values) => [...new Set((Array.isArray(values) ? values : []).filter(nonEmpty))];

/** The track ids an event row carries — the join key for by-track
 * annotation rows (the engine's own track identity, carried on the event). */
export function eventTrackIds(event) {
  return unique([
    event?.trackId,
    ...(Array.isArray(event?.observations) ? event.observations.map((obs) => obs?.trackId) : []),
  ]);
}

/** The camera ids a row carries (an entity's cameras, a visit's cameras). */
function cameraIdSet(values) {
  return new Set(unique(values));
}

/** The cameraId+trackId pair join: both must name the row's ground — a
 * camera alone or a track alone never decorates (ambiguous by design). */
function joinedByCameraTrack(annotation, cameraIds, trackIds) {
  if (!nonEmpty(annotation?.cameraId) || !nonEmpty(annotation?.trackId)) return false;
  return cameraIdSet(cameraIds).has(annotation.cameraId)
    && new Set(unique(trackIds)).has(annotation.trackId);
}

/**
 * Event join of record: event-targeted rows with targetId === the event's id,
 * plus by-track rows (targetKind "track" — the pure track-identity rows)
 * matched on the event's own track ids. Rows that target a visit or an
 * entity decorate those surfaces, never this one. Unknown sightings have no
 * rows at all, so an event with no matches renders no decoration.
 */
export function annotationsForEvent(annotations, event) {
  const trackIds = new Set(eventTrackIds(event));
  return (Array.isArray(annotations) ? annotations : []).filter((annotation) => {
    if (!annotation) return false;
    if (annotation.targetKind === "event") return annotation.targetId != null && annotation.targetId === event?._id;
    return annotation.targetKind === "track" && trackIds.has(annotation.trackId);
  });
}

/**
 * Tracked-entity join of record (overwatch rows): entity-targeted rows carry
 * targetId === entityId; track rows join cameraId+trackId when the entity
 * row carries its live track identity.
 */
export function annotationsForEntity(annotations, entity) {
  return (Array.isArray(annotations) ? annotations : []).filter((annotation) => {
    if (!annotation) return false;
    if (annotation.targetKind === "entity") return annotation.targetId != null && annotation.targetId === entity?.entityId;
    return joinedByCameraTrack(annotation, [entity?.cameraId, ...(entity?.cameraIds ?? [])], [entity?.trackId]);
  });
}

/**
 * Visit join of record (overwatch rows): visit-targeted rows carry
 * targetId === visitId; track rows join the visit's cameras and any track
 * ids its entities carry.
 */
export function annotationsForVisit(annotations, visit) {
  const cameraIds = [...(visit?.cameras ?? [])];
  const trackIds = (Array.isArray(visit?.entities) ? visit.entities : []).map((entity) => entity?.trackId);
  return (Array.isArray(annotations) ? annotations : []).filter((annotation) => {
    if (!annotation) return false;
    if (annotation.targetKind === "visit") return annotation.targetId != null && annotation.targetId === visit?.visitId;
    return joinedByCameraTrack(annotation, cameraIds, trackIds);
  });
}

/**
 * One timeline row's join (a visit's clip/state/gap entries): pure
 * cameraId+trackId against that row's own fields.
 */
export function annotationsForTrackRow(annotations, row) {
  if (!nonEmpty(row?.trackId)) return [];
  return (Array.isArray(annotations) ? annotations : []).filter((annotation) =>
    annotation?.trackId === row.trackId
    && (row?.cameraId == null || !nonEmpty(annotation?.cameraId) || annotation.cameraId === row.cameraId));
}

/** Distinct labels for a matched set — the rendered decoration: the name
 * plainly for asserted rows, "looks like name (pct%)" otherwise. */
export function annotationLines(names, rows) {
  const lines = (Array.isArray(rows) ? rows : [])
    .map((row) => decisionLabelOf(names, row))
    .filter((line) => line != null);
  return [...new Set(lines)].length > 0 ? [...new Set(lines)] : null;
}

// ---------------------------------------------------------------------------
// Registry entries: filters, row copy, sightings
// ---------------------------------------------------------------------------

/** The registry section's rows: one kind's entries, oldest added last —
 * the hub's answer order of record is preserved. */
export function entriesOf(entries, kind) {
  return (Array.isArray(entries) ? entries : []).filter((entry) => entry?.kind === kind);
}

export const ENROLLED_HOUSEHOLD_LABEL = "Household";
export const ENROLLED_VISIT_LABEL = "Enrolled for a visit";

/** An entry's subtitle: the kind, the plate where a vehicle carries one. */
export function entrySubtitle(entry) {
  const kind = kindLabel(entry?.kind) ?? "Entry";
  if (entry?.kind === "vehicle" && nonEmpty(entry?.plateText)) return `${kind} · Plate ${entry.plateText}`;
  return kind;
}

export const ACCOUNTABILITY_PREFIX = "Accountability note:";

/** The enrollment meta line: the enrolledFor marker and, for a visit
 * enrollment, the enrolling member's accountability note renders verbatim —
 * the software records accountability; it never manufactures consent. */
export function enrolledForCopy(entry) {
  if (entry?.enrolledFor === "visit") {
    const note = nonEmpty(entry?.accountabilityNote) ? ` — ${ACCOUNTABILITY_PREFIX} ${entry.accountabilityNote}` : "";
    return `${ENROLLED_VISIT_LABEL}${note}`;
  }
  if (entry?.enrolledFor === "household") return ENROLLED_HOUSEHOLD_LABEL;
  return null;
}

/** One entry row's sighting-count copy: honest zero included. */
export function sightingCountCopy(entry) {
  const count = Array.isArray(entry?.sightings) ? entry.sightings.length : 0;
  return count === 1 ? "1 sighting" : `${count} sightings`;
}

/** A sighting's absolute timestamp: the registry stores epoch seconds; a
 * bad epoch renders nothing, never a guess. */
export function sightDateCopy(at) {
  const seconds = Number(at);
  if (!Number.isFinite(seconds) || seconds <= 0) return null;
  return relativeTime(new Date(seconds * 1000).toISOString());
}

/** One sighting row's copy: when and where. */
export function sightingCopy(sighting) {
  const when = sightDateCopy(sighting?.at);
  const where = nonEmpty(sighting?.cameraId) ? ` · Camera ${sighting.cameraId}` : "";
  return `${when ?? "Unknown time"}${where}`;
}

// ---------------------------------------------------------------------------
// Enrollment drafts
// ---------------------------------------------------------------------------

export const ENROLL_FOR_OPTIONS = [
  { value: "household", label: ENROLLED_HOUSEHOLD_LABEL },
  { value: "visit", label: ENROLLED_VISIT_LABEL },
];

/** A data URL's base64 payload as the contract's enrollment frame — only a
 * real JPEG data URL converts (the frames' format of record is "jpeg");
 * anything else contributes nothing, never a guessed frame. */
export function frameFromDataUrl(dataUrl) {
  if (typeof dataUrl !== "string") return null;
  const match = dataUrl.match(/^data:image\/jpeg;base64,([A-Za-z0-9+/=]+)$/);
  return match ? { format: "jpeg", data: match[1] } : null;
}

/**
 * The client-side shape check for an enrollment draft — the same plain
 * language the plane refuses with, before the wire ever sees it:
 *   - every entry needs a name;
 *   - faces need at least one photo frame (descriptors compute locally);
 *   - vehicles carry a plate text or a photo;
 *   - VISIT enrollment REQUIRES the enrolling member's accountability note.
 * Null = the draft may ride the wire; the hub's own refusals still render
 * verbatim (409 disabled, 422 plain-language).
 */
export function validateEnrollDraft(draftInput) {
  const { kind, name, frames, plateText, enrolledFor, accountabilityNote } = draftInput ?? {};
  if (!nonEmpty(name)) return "Give this entry a name.";
  if (kind === "face") {
    if (!Array.isArray(frames) || frames.length === 0) return "Add a photo showing the face to enroll.";
  } else if (kind === "vehicle") {
    if (!nonEmpty(plateText) && (!Array.isArray(frames) || frames.length === 0)) {
      return "A vehicle entry carries a plate text or a photo.";
    }
  }
  if (enrolledFor === "visit" && !nonEmpty(accountabilityNote)) {
    return "Enrolling for a visit requires the enrolling member's accountability note.";
  }
  return null;
}

// ---------------------------------------------------------------------------
// Purge, export, and the zero-computation audit
// ---------------------------------------------------------------------------

/** The purge answer's plain-language receipt (confirm-then-refetch): exactly
 * what went away, count by count. */
export function purgeCopy(purged) {
  const counts = purged?.purged ?? {};
  const list = [
    `${counts.descriptorVectors ?? 0} descriptor vector${(counts.descriptorVectors ?? 0) === 1 ? "" : "s"}`,
    `${counts.plateReads ?? 0} plate read${(counts.plateReads ?? 0) === 1 ? "" : "s"}`,
    `${counts.sightings ?? 0} sighting${(counts.sightings ?? 0) === 1 ? "" : "s"}`,
    `${counts.annotations ?? 0} annotation${(counts.annotations ?? 0) === 1 ? "" : "s"}`,
  ];
  return `Deleted. Purged ${list.join(", ")}.`;
}

/** The zero-computation audit line (ac-4): the metrics plane's four counters,
 * rendered so a disabled home can show zero computations happened. */
export function metricsCopy(metrics) {
  const rows = [
    ["descriptorComputations", "descriptor computations"],
    ["plateReads", "plate reads"],
    ["recognitionRuns", "recognition runs"],
    ["refusedDisabled", "runs refused while off"],
  ];
  return rows
    .map(([key, label]) => `${Number(metrics?.[key] ?? 0)} ${label}`)
    .join(" · ");
}

// ---------------------------------------------------------------------------
// Open evidence (the camera-model join, reused here)
// ---------------------------------------------------------------------------

/** The playback window around a sighting (epoch seconds) for the timeline
 * read whose events carry the linked evidence. */
export function evidenceWindow(at, halfWindowSec = 60) {
  const seconds = Number(at);
  if (!Number.isFinite(seconds) || seconds <= 0) return null;
  return {
    from: new Date((seconds - halfWindowSec) * 1000).toISOString(),
    to: new Date((seconds + halfWindowSec) * 1000).toISOString(),
  };
}

/** The event a sighting references, from the home timeline's answer — null
 * when the moment's event isn't in the window (the evidence renderer then
 * shows the honest unavailable copy). */
export function sightedEvent(events, sighting) {
  if (!nonEmpty(sighting?.eventId)) return null;
  return (Array.isArray(events) ? events : []).find((event) => event?._id === sighting.eventId) ?? null;
}

/** A sighting's evidence affordance exists only when the sighting names the
 * ground to open: a camera and its event reference. */
export function sightingHasEvidence(sighting) {
  return nonEmpty(sighting?.cameraId) && nonEmpty(sighting?.eventId);
}

export const EVIDENCE_UNOPENABLE_COPY =
  "This sighting has no camera moment linked to it yet — its evidence opens once the sighting references an event.";
