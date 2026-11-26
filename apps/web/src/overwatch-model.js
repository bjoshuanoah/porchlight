// PORCH-140: the family Overwatch surfaces' model of record. Pure data, copy
// and math — no DOM, no React, no network — so `node --test` loads it
// directly (the home-model.js / camera-model.js discipline). The screen
// (overwatch.jsx) renders from this module's vocabulary; overwatch-actions.js
// is the wire half against the Overwatch REST plane. Zones live in map
// coordinates end to end; the property map is an SVG whose viewBox IS the
// map space (map bounds expanded by a margin), so a saved polygon covers the
// same ground at any rendered size.

import { relativeTime } from "./time.js";

// ---------------------------------------------------------------------------
// Map and zone geometry
// ---------------------------------------------------------------------------

/** The map margin of record: the zones' union expanded by this many map
 * units gives the property map its frame. */
export const VIEWBOX_MARGIN = 12;

const finite = (value) => typeof value === "number" && Number.isFinite(value);

const asPoint = (point) => (Array.isArray(point) && finite(point[0]) && finite(point[1]) ? [point[0], point[1]] : null);

/** A zone polygon of record: at least 3 finite map-space vertices. */
export function polygonIsValid(polygon) {
  return Array.isArray(polygon) && polygon.map(asPoint).filter(Boolean).length >= 3;
}

const pointsOf = (zones) =>
  (Array.isArray(zones) ? zones : [])
    .flatMap((zone) => (Array.isArray(zone?.polygon) ? zone.polygon.map(asPoint) : []))
    .filter(Boolean);

/** The union of the zones' polygons expanded by `margin` map units — the
 * property map's frame of record. Never the other way around. */
export function boundsOf(zones, margin = VIEWBOX_MARGIN) {
  const points = pointsOf(zones);
  if (!points.length) return null;
  const xs = points.map((point) => point[0]);
  const ys = points.map((point) => point[1]);
  const pad = finite(margin) && margin >= 0 ? margin : VIEWBOX_MARGIN;
  return {
    minX: Math.min(...xs) - pad,
    minY: Math.min(...ys) - pad,
    maxX: Math.max(...xs) + pad,
    maxY: Math.max(...ys) + pad,
  };
}

/** The map's SVG viewBox string in map space — the browser does the
 * projection, the model just states it. */
export function viewBoxOf(bounds) {
  if (!bounds) return null;
  const width = bounds.maxX - bounds.minX;
  const height = bounds.maxY - bounds.minY;
  if (!(width > 0) || !(height > 0)) return null;
  return `${bounds.minX} ${bounds.minY} ${width} ${height}`;
}

export function zoneViewBox(zones, margin) {
  return viewBoxOf(boundsOf(zones, margin));
}

/** A polygon's SVG `points` value — map-space coordinates verbatim, since
 * the drawn viewBox is the same map space. Lenient on purpose: the in-progress
 * draft renders its first vertices before it is a valid polygon, while an
 * all-empty input contributes nothing, never a guess. */
export function polygonToSvgPoints(polygon) {
  if (!Array.isArray(polygon)) return "";
  return polygon
    .map(asPoint)
    .filter(Boolean)
    .map((point) => `${point[0]},${point[1]}`)
    .join(" ");
}

/** A canvas click back into map coordinates. `rect` is the rendered SVG
 * element's getBoundingClientRect(), `viewBox` the map-space viewBox string.
 * The surface keeps the SVG's aspect ratio equal to the viewBox's, so the
 * projection stays linear with no letterbox. */
export function pointFromClick(point, rect, viewBox) {
  if (!point || !rect || !rect.width || !rect.height) return null;
  const parts = String(viewBox ?? "").trim().split(/\s+/).map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isFinite(part)) || parts[2] <= 0 || parts[3] <= 0) return null;
  const [minX, minY, width, height] = parts;
  return [
    minX + ((point.clientX - rect.left) / rect.width) * width,
    minY + ((point.clientY - rect.top) / rect.height) * height,
  ];
}

const distanceOf = (a, b) => Math.hypot(b[0] - a[0], b[1] - a[1]);

/** Zone-editor close tolerance in map units: the camera frame's 2.5%-of-width
 * click grammar (console ZoneEditor CLOSE_TOLERANCE_PERCENT), carried to the
 * map's span. */
export function closeToleranceFor(span, percent = 2.5) {
  const value = finite(span) && span > 0 ? span : 0;
  return (value * (finite(percent) && percent > 0 ? percent : 2.5)) / 100;
}

/**
 * The console ZoneEditor's click-to-add-vertex grammar, in map coordinates:
 * the first click starts a draft; further clicks add vertices; clicking the
 * first vertex (inside `closeTolerance`) completes the draft; while the draft
 * stands complete (`closed`), further canvas clicks add nothing until Save or
 * Discard. Anything unrecognized is a no-op: the draft never invents a vertex.
 */
export function extendZoneDraft(draft, point, closeTolerance, closed = false) {
  const asCurrent = Array.isArray(draft) ? draft.map(asPoint).filter(Boolean) : null;
  if (closed) return { draft: asCurrent, closed: true };
  const asNext = asPoint(point);
  if (!asNext) return { draft: asCurrent, closed: false };
  if (!asCurrent || asCurrent.length === 0) return { draft: [asNext], closed: false };
  if (asCurrent.length >= 3 && distanceOf(asNext, asCurrent[0]) <= (finite(closeTolerance) && closeTolerance > 0 ? closeTolerance : 0)) {
    return { draft: asCurrent, closed: true };
  }
  return { draft: [...asCurrent, asNext], closed: false };
}

/** One dragged vertex moves, cloned — the source polygon is never mutated. */
export function moveZoneVertex(polygon, index, point) {
  const asNext = asPoint(point);
  if (!Array.isArray(polygon) || index == null || index < 0 || index >= polygon.length || !asNext) {
    return Array.isArray(polygon) ? [...polygon] : [];
  }
  return polygon.map((vertex, at) => (at === index ? asNext : vertex));
}

/** Do two zones touch — the adjacency declaration UI proposes only pairs
 * whose zones share ground. A small epsilon absorbs float drift. */
export function zonesTouch(zoneA, zoneB, epsilon = 0.5) {
  const bounds = (zone) => {
    const points = Array.isArray(zone?.polygon) ? zone.polygon.map(asPoint).filter(Boolean) : [];
    if (!points.length) return null;
    return {
      minX: Math.min(...points.map((p) => p[0])),
      minY: Math.min(...points.map((p) => p[1])),
      maxX: Math.max(...points.map((p) => p[0])),
      maxY: Math.max(...points.map((p) => p[1])),
    };
  };
  const a = bounds(zoneA);
  const b = bounds(zoneB);
  if (!a || !b || !finite(epsilon) || epsilon < 0) return false;
  return (
    a.minX - epsilon <= b.maxX &&
    b.minX - epsilon <= a.maxX &&
    a.minY - epsilon <= b.maxY &&
    b.minY - epsilon <= a.maxY
  );
}

// ---------------------------------------------------------------------------
// Adjacency + travel time
// ---------------------------------------------------------------------------

/** The travel-time map's key of record ("a|b"), canonicalized in sorted pair
 * order — the same key shape the REST state answers with, stable for either
 * pair order the map was authored in. */
export function travelTimeKey(cameraIdA, cameraIdB) {
  const a = String(cameraIdA ?? "");
  const b = String(cameraIdB ?? "");
  return a <= b ? `${a}|${b}` : `${b}|${a}`;
}

/** The handoff minutes a new pair starts from (the declaration UI's seed). */
export const DEFAULT_HANDOFF_MINUTES = 10;

/** One travel-time update for the wire (`{ key, min, max }`), minutes clamped
 * to a sane non-negative whole. */
export function travelTimeUpdate(key, minutes) {
  const value = Math.max(0, Math.round(Number(minutes)));
  const bound = Number.isFinite(value) ? value : DEFAULT_HANDOFF_MINUTES;
  return { key: String(key ?? ""), min: bound, max: bound };
}

// ---------------------------------------------------------------------------
// Dial (live overview frame rate)
// ---------------------------------------------------------------------------

export const DIAL_MIN_FPS = 1;

/** The cap of record: a whole number never below the floor — never NaN. */
export function dialCap(capFps) {
  const value = Number(capFps);
  if (!Number.isFinite(value)) return DIAL_MIN_FPS;
  return Math.max(DIAL_MIN_FPS, Math.floor(value));
}

export function dialRange(capFps) {
  return { min: DIAL_MIN_FPS, max: dialCap(capFps) };
}

/** Client-side clamp into [1, capFps]; the server clamps too and answers
 * { frameRate, clamped } — the surface renders that answer, here only the
 * control's own bound keeps the draft honest. */
export function clampFrameRate(value, capFps) {
  const cap = dialCap(capFps);
  const requested = Math.round(Number(value));
  if (!Number.isFinite(requested)) return DIAL_MIN_FPS;
  return Math.min(cap, Math.max(DIAL_MIN_FPS, requested));
}

export function dialStep(value, direction, capFps) {
  const delta = direction === "down" ? -1 : 1;
  return clampFrameRate(Number(value) + delta, capFps);
}

/** The dial's contract copy: the cap is stated, and the audit fact rides it —
 * frame-rate changes are audited, never silent. */
export function dialCopy(capFps) {
  const cap = dialCap(capFps);
  return `Frame rate of the live overview, 1 to ${cap} per second — the hub caps this dial at ${cap}. Changes are audited.`;
}

// ---------------------------------------------------------------------------
// Tracked entities
// ---------------------------------------------------------------------------

/** Follow buttons exist for people and vehicles only — packages (and any
 * other class) are never followable. */
export const FOLLOWABLE_CLASSES = ["person", "vehicle"];

export function isFollowable(cls) {
  return FOLLOWABLE_CLASSES.includes(cls);
}

const CLASS_LABELS = { person: "Person", vehicle: "Vehicle", package: "Package", animal: "Animal" };

/** null for an unrecognized class — the screen renders its own fallback,
 * never a guessed class. */
export function entityClassLabel(cls) {
  return CLASS_LABELS[cls] ?? null;
}

const STATE_LABELS = { arrival: "Arrived", movement: "Moving", stationary: "Stationary", departure: "Departing" };

/** The entity/visit states' plain-language copy; null for an unrecognized
 * state (the screen renders "Unknown", never an invented state). */
export function trackedStateLabel(state) {
  return STATE_LABELS[state] ?? null;
}

export const FOLLOW_BUTTON_LABEL = "Follow";
export const UNFOLLOW_BUTTON_LABEL = "Stop following";

/** The one follow button's copy per the row's followed flag. */
export function followButtonLabel(followed) {
  return followed ? UNFOLLOW_BUTTON_LABEL : FOLLOW_BUTTON_LABEL;
}

// Association flags ("keep separate" copy): the two-entity declaration.
export const FLAG_BUTTON_LABEL = "Keep separate";
export const FLAG_PENDING_LABEL = "Pick the other one";

/** The tracked row's cameras line. */
export function trackedCamerasCopy(cameraIds) {
  const ids = Array.isArray(cameraIds) ? cameraIds.filter(Boolean) : [];
  if (!ids.length) return "Not seen by a camera yet.";
  return ids.length === 1 ? `Seen by ${ids[0]}.` : `Seen by ${ids.join(", ")}.`;
}

// ---------------------------------------------------------------------------
// Visits and timelines
// ---------------------------------------------------------------------------

const entityIdOf = (entity) => (typeof entity === "string" ? entity : entity?.entityId);
const entityClsOf = (entity) => (typeof entity === "object" && entity !== null ? entity.cls : undefined);

export function visitEntityIds(entities) {
  return (Array.isArray(entities) ? entities : []).map(entityIdOf).filter(Boolean);
}

/** The visit's who-line: the entities' class labels when the visit carries
 * them, otherwise an honest count — never an invented identity. */
export function visitWhoCopy(entities) {
  const rows = Array.isArray(entities) ? entities : [];
  const labels = rows.map(entityClsOf).map(entityClassLabel).filter(Boolean);
  if (labels.length) return labels.join(", ");
  const count = visitEntityIds(rows).length;
  if (!count) return "No tracked objects.";
  return count === 1 ? "1 tracked object" : `${count} tracked objects`;
}

export function visitWhereCopy(cameras) {
  const ids = (Array.isArray(cameras) ? cameras : []).flatMap((camera) =>
    typeof camera === "string" ? [camera] : camera?.cameraId ? [camera.cameraId] : [],
  );
  if (!ids.length) return "Unknown cameras.";
  return ids.length === 1 ? `Camera ${ids[0]}.` : `Cameras ${ids.join(", ")}.`;
}

const sameDay = (a, b) =>
  new Date(a).getFullYear() === new Date(b).getFullYear() &&
  new Date(a).getMonth() === new Date(b).getMonth() &&
  new Date(a).getDate() === new Date(b).getDate();

const timeOf = (value) => {
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) return "";
  return new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" }).format(date);
};

/** The span a visit, clip or gap renders as. Same calendar day: times only;
 * a crossing span says which dates. An unread bound renders empty, never a
 * guess — callers drop empty halves. */
export function spanCopy(from, to) {
  const start = timeOf(from);
  const end = timeOf(to);
  if (!start && !end) return "";
  const dated =
    !Number.isNaN(new Date(from).valueOf()) &&
    !Number.isNaN(new Date(to).valueOf()) &&
    !sameDay(from, to) &&
    Boolean(start) &&
    Boolean(end);
  if (dated) return `${datePrefix(from)}${start} – ${end}`;
  return start && end ? `${start} – ${end}` : start || end || "";
}

function datePrefix(value) {
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) return "";
  return `${new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" }).format(date)} `;
}

const GAP_LABELS = { "camera-outage": "Camera outage", outage: "Camera outage", camera_outage: "Camera outage" };

/** A gap's explained label — camera outage is the reason of record; any other
 * supplied reason humanizes, and a missing one stays an honest "Gap in
 * coverage". Never fabricated content inside the gap: the span is all there is. */
export function gapReasonLabel(reason) {
  if (!reason) return "Gap in coverage";
  return (
    GAP_LABELS[reason] ??
    String(reason)
      .replace(/[-_]+/g, " ")
      .replace(/^./, (c) => c.toUpperCase())
  );
}

/** One gap group's full copy: the explained reason plus its span — the
 * explained gap ("Camera outage — 3:14 PM to 3:27 PM"). */
export function gapGroupCopy(group) {
  const reason = gapReasonLabel(group?.reason);
  const span = spanCopy(group?.from, group?.to);
  return span ? `${reason} — ${span}` : reason;
}

/**
 * Timeline entry grouping of record: consecutive entries of the same kind —
 * and the same camera, and the same state when they are states — merge into
 * one ordered group whose span widens to both ends. A change of kind, camera,
 * state or gap reason starts a new group, so the rendered narrative keeps the
 * visit's order without collapsing away what happened. Returns groups of
 * `{ kind, cameraId, state, reason, path, from, to, count, states, paths }`.
 */
export function groupTimelineEntries(entries) {
  const groups = [];
  for (const entry of Array.isArray(entries) ? entries : []) {
    const row = entry ?? {};
    const last = groups[groups.length - 1];
    const same =
      last &&
      last.kind === row.kind &&
      (last.cameraId ?? null) === (row.cameraId ?? null) &&
      (last.state ?? null) === (row.state ?? null) &&
      (last.reason ?? null) === (row.reason ?? null);
    if (same) {
      last.count += 1;
      if (row.path) last.paths.push(row.path);
      if (row.state) last.states.push(row.state);
      // from/to may be ISO strings or epoch numbers — widen comparably, never
      // by numeric coercion that NaNs on dates.
      if (row.from != null) last.from = last.from == null || row.from < last.from ? row.from : last.from;
      if (row.to != null) last.to = last.to == null || row.to > last.to ? row.to : last.to;
      continue;
    }
    groups.push({
      kind: row.kind,
      cameraId: row.cameraId ?? null,
      state: row.state ?? null,
      reason: row.reason ?? null,
      path: row.path ?? null,
      from: row.from ?? null,
      to: row.to ?? null,
      count: 1,
      states: [row.state].filter(Boolean),
      paths: [row.path].filter(Boolean),
    });
  }
  return groups;
}

/** A clip group's row copy: what was recorded, where, and when. An unread
 * span drops its half rather than rendering a dangling dash. */
export function clipGroupCopy(group) {
  const span = spanCopy(group?.from, group?.to);
  const where = group?.cameraId ? `Camera ${group.cameraId}` : "Camera unknown.";
  const count = group?.count ?? 1;
  const howMany = count === 1 ? "1 clip" : `${count} clips`;
  return span ? `${howMany} · ${where} — ${span}` : `${howMany} · ${where}.`;
}

/** A state entry's narrative line ("Arrived" / "Moving" / …). */
export function stateGroupCopy(group) {
  return trackedStateLabel(group?.state) ?? "Unknown";
}

/** The followed entity's stream: one clip's row copy. */
export function streamClipCopy(clip) {
  return clipGroupCopy({ ...clip, count: 1 });
}

/** The timeline's one rendered row for any group kind — the screen renders
 * this string verbatim so copy stays model-owned. */
export function timelineGroupCopy(group) {
  if (group?.kind === "gap") return gapGroupCopy(group);
  if (group?.kind === "clip") return clipGroupCopy(group);
  if (group?.kind === "state") return stateGroupCopy(group);
  return "Unrecognized entry.";
}

// ---------------------------------------------------------------------------
// Audit
// ---------------------------------------------------------------------------

const AUDIT_LABELS = {
  "zone.authored": "Zone drawn",
  "zone.deleted": "Zone deleted",
  "adjacency.authored": "Camera adjacency set",
  "travel-time.authored": "Travel time set",
  "dial": "Overview dial changed",
  "follow": "Follow set",
  "unfollow": "Follow ended",
  "association.flag": "Association flagged",
  "tracked": "Tracked object",
  "visits": "Visit recorded",
};

/** Plain-language audit rows, with the established humanize fallback. */
export function auditLabel(type) {
  return AUDIT_LABELS[type] ?? String(type || "Event").replace(/[._-]+/g, " ").replace(/^./, (c) => c.toUpperCase());
}

/** Relative time for audit and tracked rows (the shared time helper). */
export function trackedSeenCopy(lastSeenAt) {
  return lastSeenAt ? `Last seen ${relativeTime(lastSeenAt)}.` : "Not seen recently.";
}

// A camera row without a zone renders its honest chip — never an inferred zone.
export const UNCOVERED_LABEL = "Uncovered";

/** The map-adjacency chip copy for one declared pair. */
export function adjacencyPairCopy(pair) {
  const ids = Array.isArray(pair) ? pair.filter(Boolean) : [];
  return ids.length === 2 ? `${ids[0]} ↔ ${ids[1]}` : null;
}
