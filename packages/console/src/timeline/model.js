// Timeline model (PORCH-130) — the pure, node-testable half of the
// Timeline screen. Everything here works on epoch seconds in UTC, the unit
// of record across the engine REST contract (segments carry `start`/`end`
// in seconds; events carry `t`).
//
// Playback chain and seek behavior of record for v0:
//   • Chaining — when the current clip ends, `nextOf` walks the camera's
//     flattened day segment list (sorted by start) and hands back the next
//     segment regardless of which hour it lives in, so playback runs
//     continuously across hour boundaries within the selected day. A gap
//     between clips is skipped, not played.
//   • Seeking — the scrubber shows one hour at a time. A pointer target
//     time maps to the segment containing it via `segmentForAt` and the
//     clip is loaded with a computed offset (`at - segment.start`): v0
//     seeks by loading the right clip and jumping to the offset, and
//     continues smoothly only when the target already sits inside the
//     clip currently loaded. Boundary rule: a segment covers
//     [start, end) — the exact `end` second of one clip belongs to the
//     next clip, or to nothing when no clip follows.
//   • Event markers — `eventMarkers` sorts by time and drops exact
//     duplicates (same time, class, source, camera) so a re-delivered
//     event never doubles the marks; a detection and an audio event at the
//     same second stay distinct.

const HOUR_RE = /^([01]\d|2[0-3])$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// --- segments --------------------------------------------------------------

export function byStart(a, b) {
  return a.start - b.start;
}

// A day of segments, one hour at a time, flattened into a single ordered
// list — the unit `nextOf` and `segmentForAt` both walk.
export function flattenSegments(hours) {
  return (hours ?? [])
    .flatMap((hour) => hour?.segments ?? [])
    .filter((segment) => segment && Number.isFinite(segment.start) && Number.isFinite(segment.end) && segment.end >= segment.start)
    .sort(byStart);
}

// The segment that plays after `current` — the next segment by start time
// on the flattened day list, spanning hour boundaries; null ends the day.
export function nextOf(segments, current) {
  if (!current) return null;
  const ordered = [...segments].sort(byStart);
  const index = ordered.findIndex((segment) => segment === current || segment.ref === current.ref);
  if (index < 0 || index + 1 >= ordered.length) return null;
  return ordered[index + 1];
}

// The segment covering `at`: [start, end) — the exact end second belongs
// to the next segment, the exact start second belongs to this one, a gap
// returns null (the caller earns its own plain-language moment).
export function segmentForAt(segments, at) {
  if (!Number.isFinite(at) || !Array.isArray(segments)) return null;
  const ordered = [...segments].sort(byStart);
  for (const segment of ordered) {
    if (at < segment.start) return null;
    if (at < segment.end) return segment;
  }
  return null;
}

// Where `at` sits inside a segment — the offset v0 applies to
// video.currentTime after loading the clip.
export function offsetInSegment(segment, at) {
  return at - segment.start;
}

// --- days and hours --------------------------------------------------------

// Sorted "HH" hours; anything but a 00–23 hour string is dropped so a
// half-written response never breaks the chips.
export function dayHours(day) {
  const hours = Array.isArray(day?.hours) ? day.hours : [];
  return [...hours].filter((hour) => HOUR_RE.test(hour)).sort();
}

// The hour after `hour` on a day's chip list; null ends the day.
export function nextHour(hours, hour) {
  const ordered = dayHours({ hours });
  const index = ordered.indexOf(hour);
  if (index < 0 || index + 1 >= ordered.length) return null;
  return ordered[index + 1];
}

// Sorted "YYYY-MM-DD" dates.
export function dayDates(days) {
  return (days ?? [])
    .map((day) => day?.date)
    .filter((date) => DATE_RE.test(date ?? ""))
    .sort();
}

// Epoch seconds of "YYYY-MM-DD" "HH" in UTC; null when the parts are
// malformed rather than a wrong-but-plausible number.
export function hourStart(date, hour) {
  if (!DATE_RE.test(date ?? "") || !HOUR_RE.test(hour ?? "")) return null;
  const [year, month, day] = date.split("-").map(Number);
  return Date.UTC(year, month - 1, day, Number(hour)) / 1000;
}

// [start, end) epoch seconds of one calendar hour in UTC.
export function hourWindow(date, hour) {
  const start = hourStart(date, hour);
  if (start === null) return null;
  return { start, end: start + 3600 };
}

// "HH:MM:SS" UTC clock label for a marker or chip subtitle.
export function formatClock(seconds) {
  const total = Math.floor(Number(seconds));
  if (!Number.isFinite(total) || total < 0) return "";
  const hh = String(Math.floor(total / 3600) % 24).padStart(2, "0");
  const mm = String(Math.floor((total % 3600) / 60)).padStart(2, "0");
  const ss = String(total % 60).padStart(2, "0");
  return `${hh}:${mm}:${ss}`;
}

// --- event markers ---------------------------------------------------------

const MARKER_KEY = (event) => `${event?.t}|${event?.cls ?? ""}|${event?.source ?? ""}|${event?.camera ?? ""}`;

// Detection + audio events as marks: sorted by time, exact duplicates
// dropped, each carrying where it belongs on the hour strip.
export function eventMarkers(events) {
  const seen = new Set();
  const markers = [];
  for (const event of events ?? []) {
    if (!Number.isFinite(event?.t)) continue;
    const key = MARKER_KEY(event);
    if (seen.has(key)) continue;
    seen.add(key);
    markers.push({
      t: event.t,
      cls: event.cls ?? "unknown",
      source: event.source ?? "detection",
      camera: event.camera ?? null,
    });
  }
  return markers.sort((a, b) => a.t - b.t);
}

export { HOUR_RE, DATE_RE };
