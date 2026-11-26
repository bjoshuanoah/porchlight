// PORCH-142: the Watchlists surfaces' wire half — one `request(connection,
// "recognition/watchlists…")` per action, riding the open connection's
// membership session token exactly the way People & Things does (the
// established request shape). Path and body shapes are the recognition
// plane's watchlists contract verbatim: `?homeId=` everywhere, { homeId,
// label, frames } to train a class, { homeId, frames, replay? } to retrain,
// { homeId, cameraId?, trackId? } to feed a flagged event back as a
// correction, { homeId, assertThreshold } for per-class calibration. Every
// mutation is owner-only hub-side, so a non-owner's 403 is the error the
// screen renders. All screen-testable logic lives in watchlists-model.js.

import { request } from "./api.js";

const enc = encodeURIComponent;

function requireConnection(active) {
  if (!active?.url || !active.token || !active.identity?.id) {
    throw new Error("Connect this device to your family's hub to manage Watchlists.");
  }
  return active;
}

const queryString = (params) => {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params ?? {})) {
    if (value != null) search.set(key, String(value));
  }
  const suffix = search.toString();
  return suffix ? `?${suffix}` : "";
};

export function createWatchlistActions({ active } = {}) {
  const connection = () => requireConnection(active);

  return {
    // The trained-class list: every class view with its example thumbnails,
    // scope, and expected-accuracy answer.
    loadWatchlists: (homeId) => request(connection(), `recognition/watchlists${queryString({ homeId })}`),

    loadWatchlistClass: (classId, homeId) => request(
      connection(),
      `recognition/watchlists/${enc(classId)}${queryString({ homeId })}`,
    ),

    // Train a new class: the label and the uploaded JPEG frames (base64 in
    // JSON, same shape as enrollment). The hub computes locally and answers
    // { class, expectedAccuracy, heldReplay } — the screen renders the
    // expected-accuracy answer, never a promised score of its own.
    createWatchlistClass: ({ homeId, label, frames } = {}) => request(
      connection(),
      "recognition/watchlists",
      {
        method: "POST",
        body: JSON.stringify({
          homeId,
          label: String(label ?? "").trim(),
          ...(Array.isArray(frames) && frames.length > 0 ? { frames } : {}),
        }),
      },
    ),

    // Retrain with more examples: frames only (the replay evaluation is a
    // hub-side input — the web never invents it); the pool grows, the
    // held-out replay runs hub-side, and the fresh class view (with its
    // expectedAccuracy) comes back.
    retrainWatchlistClass: ({ classId, homeId, frames } = {}) => request(
      connection(),
      `recognition/watchlists/${enc(classId)}/retrain`,
      {
        method: "POST",
        body: JSON.stringify({
          homeId,
          ...(Array.isArray(frames) && frames.length > 0 ? { frames } : {}),
        }),
      },
    ),

    // Feed a flagged event back as a correction: the hub resolves the flagged
    // detection's own crop descriptor when no descriptor rides the call (most
    // recent detection row matching cameraId+trackId), so the flag hook calls
    // with where-and-who only on the class-less corrections route. The hub
    // answers 404 ("no recorded detection to feed back") when nothing
    // matches — a state the flag hook swallows.
    correctFromFlaggedEvent: ({ homeId, cameraId, trackId, eventId } = {}) => request(
      connection(),
      "recognition/watchlists/corrections",
      {
        method: "POST",
        body: JSON.stringify({
          homeId,
          ...(cameraId ? { cameraId: String(cameraId) } : {}),
          ...(trackId ? { trackId: String(trackId) } : {}),
          ...(eventId ? { eventId: String(eventId) } : {}),
        }),
      },
    ),

    // THE DELETION PURGE: the class's example photos and its recorded
    // detections go with it (the purged counts return for the receipt).
    // Confirm-then-refetch is the screen's discipline.
    deleteWatchlistClass: (classId, homeId) => request(
      connection(),
      `recognition/watchlists/${enc(classId)}${queryString({ homeId })}`,
      { method: "DELETE" },
    ),

    // The vocabulary read: built-in tracked classes plus every trained class
    // (label, kind, trackingScope, assertThreshold) — the joins' label pool.
    loadWatchlistVocabulary: (homeId) => request(
      connection(),
      `recognition/watchlists/vocabulary${queryString({ homeId })}`,
    ),

    // A class's recorded detections, bounded and newest first — no
    // descriptors ever ride a REST view.
    loadWatchlistDetections: (classId, homeId, limit) => request(
      connection(),
      `recognition/watchlists/${enc(classId)}/detections${queryString({ homeId, limit })}`,
    ),
  };
}
