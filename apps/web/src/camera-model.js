// PORCH-139: the family camera surfaces' model half. Pure copy + math the
// camera surfaces render from — live grid states, the health planes'
// plain-language explanations, playback gaps, natural-aspect inline rules,
// media URLs for the bounded scoped-engine-token proxy, and the alert copy
// contract (observations as fact, inferences as conditional, never an
// invented claim). All screen-testable logic lives here; the wire rides
// home-actions.js, the JSX is this model's projection.

import { videoInlineMasked } from "./photo-first.js";

/**
 * Natural aspect per the Porchlight video rules (PORCH-121 carries): inline,
 * a feed more portrait than the 3:4 extent masks into the fixed extent; a
 * feed at or above the extent plays its true stamped ratio; the full-screen
 * viewer is ALWAYS natural aspect (the mask never reaches the viewer).
 */
export function inlineAspectRatio(feed) {
  const aspect = aspectOf(feed);
  if (aspect === null) return "16 / 9";
  return videoInlineMasked(aspect) ? "3 / 4" : ratioTextOf(feed.aspect);
}

export function viewerAspectRatio(feed) {
  const aspect = aspectOf(feed);
  return aspect === null ? "16 / 9" : ratioTextOf(feed.aspect);
}

export function isPortraitFeed(feed) {
  const aspect = aspectOf(feed);
  return aspect !== null && aspect < 1;
}

function aspectOf(feed) {
  const { width, height } = feed?.aspect ?? {};
  const w = Number(width);
  const h = Number(height);
  return w > 0 && h > 0 ? w / h : null;
}

function ratioTextOf(aspect) {
  const w = Number(aspect?.width);
  const h = Number(aspect?.height);
  return (w > 0 && h > 0) ? `${w} / ${h}` : "16 / 9";
}

/**
 * The camera bridge's media proxy URL — the SAME single experience at home
 * and away (no separate remote mode): the hub origin serves the standing
 * engine path behind the scoped view token. `token` is minted per view
 * session and never rides anywhere else (no header work for media tags).
 */
export function mediaUrl({ origin, homeId, cameraId, path, token }) {
  const base = String(origin ?? "").replace(/\/+$/, "") || (typeof window !== "undefined" ? window.location.origin : "");
  if (!base || !homeId || !cameraId || !token) return null;
  return `${base}/api/home/homes/${encodeURIComponent(homeId)}/cameras/${encodeURIComponent(cameraId)}/media?path=${encodeURIComponent(String(path ?? ""))}&token=${encodeURIComponent(token)}`;
}


/**
 * The feed's surface state. Offline cameras, disabled recording, and
 * unavailable feeds each NAME their state — a camera present but not
 * recording, or recording but detection-dead, never renders as a healthy
 * blank feed.
 */
export function feedPlayState(feed) {
  const planes = feed?.health ?? {};
  const recordingState = planes.recording?.state ?? "unavailable";
  const playbackState = planes.playback?.state ?? "unavailable";
  if (recordingState === "offline" || playbackState === "offline") {
    return { kind: "gap", reason: "offline", copy: `${feed?.name ?? "This camera"} is offline right now — live view returns when it reconnects.` };
  }
  if (!feed?.live?.path || feed?.live?.gap) {
    return { kind: "gap", reason: "unavailable", copy: gapCopy(feed?.live?.gap ?? "unavailable") };
  }
  if (recordingState === "disabled") {
    return { kind: "live", note: healthExplain({ plane: "recording", state: "disabled" }, feed) };
  }
  if (recordingState === "unavailable" || playbackState === "unavailable") {
    return { kind: "live", note: healthExplain({ plane: "recording", state: "unavailable" }, feed) };
  }
  return { kind: "live", note: null };
}

/**
 * The health planes, explained independently (recording / playback /
 * detection / audio, the last joining in PORCH-153): a camera recording but
 * not detecting, or not hearing, reads as its own state.
 */
const HEALTH_COPY = {
  recording: {
    recording: (feed) => `${feed?.name ?? "This camera"} is recording.`,
    disabled: (feed) => `Recording is turned off for ${feed?.name ?? "this camera"} — live view continues, but nothing is captured.`,
    offline: (feed) => `${feed?.name ?? "This camera"} is offline — recording paused while it reconnects.`,
    degraded: () => "Recording is running degraded — the engine will explain what it kept.",
    unavailable: () => "The recording status can't be read right now.",
  },
  playback: {
    live: () => "Playback is serving normally.",
    degraded: () => "Playback is serving with reduced quality right now.",
    offline: () => "Playback is offline — past footage can't be watched at the moment.",
    unavailable: () => "The playback status can't be read right now.",
  },
  detection: {
    ok: () => "Detection is on — people, vehicles, and animals raise events.",
    unhealthy: () => "Detection isn't running for this camera right now — nothing is raising camera events, but recording and playback continue.",
    disabled: () => "Detection is off for this camera — no camera events, no impact on recording or playback.",
    offline: () => "Detection is offline for this camera right now.",
    unavailable: () => "The detection status can't be read right now.",
  },
  // The audio plane (PORCH-153): sounds raise camera events only while the
  // audio analysis consumer runs; a consumer loss degrades audio events ONLY
  // — recording and visual detection continue, and the copy says so.
  audio: {
    ok: () => "Audio detection is on — sounds raise camera events.",
    degraded: () => "Audio event analysis isn't running for this camera right now — sounds aren't raising camera events, but recording and visual detection continue.",
    disabled: () => "Audio detection is off for this camera — nothing listens, and recording stays on.",
    offline: () => "Audio detection is offline for this camera right now.",
    unavailable: () => "The audio detection status can't be read right now.",
  },
};

export function healthExplain({ plane, state }, feed) {
  const table = HEALTH_COPY[plane];
  const entry = table?.[state] ?? table?.unavailable;
  return entry ? entry(feed) : "The camera status can't be read right now.";
}

export function healthNotes(feed) {
  const planes = feed?.health ?? {};
  return [
    { plane: "recording", note: healthExplain({ plane: "recording", state: planes.recording?.state ?? "unavailable" }, feed), state: planes.recording?.state ?? "unavailable" },
    { plane: "playback", note: healthExplain({ plane: "playback", state: planes.playback?.state ?? "unavailable" }, feed), state: planes.playback?.state ?? "unavailable" },
    { plane: "detection", note: healthExplain({ plane: "detection", state: planes.detection?.state ?? "unavailable" }, feed), state: planes.detection?.state ?? "unavailable" },
    { plane: "audio", note: healthExplain({ plane: "audio", state: planes.audio?.state ?? "unavailable" }, feed), state: planes.audio?.state ?? "unavailable" },
  ];
}

/** Explained playback gaps — the reasons the engine's index answers with. */
export function gapCopy(reason) {
  switch (reason) {
    case "retention-expired":
      return "That footage was recorded past this camera's retention window — expired footage can't play anymore.";
    case "recording-disabled":
      return "Recording was off at that moment — nothing was captured to play.";
    case "degraded":
      return "The camera engine is running degraded right now — try again shortly.";
    case "offline":
      return "The camera was offline at that moment — nothing was captured.";
    default:
      return "The footage wasn't available at that moment — the engine couldn't serve it.";
  }
}

/** The evidence ref an event carries: a still to open, or the gap to explain. */
export function eventEvidence(event) {
  const ref = (event?.evidenceRefs ?? []).find((row) => row?.kind === "still" || row?.kind === "clip" || row?.kind === "segment");
  if (ref && ref.path) return { kind: ref.kind, path: ref.path, cameraId: (event?.observations?.[0]?.cameraId) ?? null };
  const gap = (event?.evidenceRefs ?? []).find((row) => row?.kind === "gap");
  if (gap) return { kind: "gap", copy: gapCopy(gap.reason) };
  return { kind: "gap", copy: gapCopy("unavailable") };
}

/**
 * The alert copy contract of record (PRD 3): the factual label renders as
 * fact; the interpretive copy renders conditional — "when the footage
 * supports it" — NEVER as fact. The pair is one unit: a surface that drops
 * either half breaks the desc-and-transcript-never-unseen class of laws.
 */
export function alertCopy(event) {
  const factual = event?.alert?.text ?? "Camera activity was seen.";
  const interpretive = event?.alert?.interpretive ?? null;
  return {
    factual,
    interpretive,
    /** The conditional lead-in copy for an interpretive reading. */
    conditional: interpretive ? "Likely reading, when the footage supports it" : null,
  };
}

/** Contract sweep: an inference must never ride the factual label. */
export function factContainsInference(event) {
  const factual = event?.alert?.text ?? "";
  const interpretive = event?.alert?.interpretive ?? "";
  if (!interpretive) return false;
  return factual.includes(interpretive) || factual === interpretive;
}

/**
 * Playback: events grouped for the calendar view — the viewer's local day
 * (the bridge normalizes to UTC; the surface renders in local time).
 */
export function eventsByDay(events) {
  const days = new Map();
  for (const event of events ?? []) {
    const at = new Date(String(event?.startedAt ?? ""));
    if (Number.isNaN(at.getTime())) continue;
    const key = `${at.getFullYear()}-${String(at.getMonth() + 1).padStart(2, "0")}-${String(at.getDate()).padStart(2, "0")}`;
    if (!days.has(key)) days.set(key, []);
    days.get(key).push(event);
  }
  return days;
}

/** The camera's timeline row set: seek-to-known-time math helper. */
export function localInputValue(iso) {
  const at = new Date(String(iso ?? ""));
  if (Number.isNaN(at.getTime())) return null;
  const pad = (n) => String(n).padStart(2, "0");
  return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}T${pad(at.getHours())}:${pad(at.getMinutes())}`;
}
