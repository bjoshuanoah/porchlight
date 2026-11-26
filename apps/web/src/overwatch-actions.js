// PORCH-140: the Overwatch tab's wire half — one `request(connection, "overwatch/…")`
// per action, riding the open connection's membership session token exactly
// the way the family's other hub writes do (the established request shape;
// every Overwatch route is owner-only hub-side, so a non-owner's 403 is the
// error the screen renders). Body shapes are the route contract verbatim:
// plain JSON — { polygon: [[x, y]…] }, { pairs }, { updates }, { frameRate },
// { fromEntityId, toEntityId } — no signing envelope. All screen-testable
// logic lives in overwatch-model.js.

import { request } from "./api.js";

const enc = encodeURIComponent;

function requireConnection(active) {
  if (!active?.url || !active.token || !active.identity?.id) {
    throw new Error("Connect this device to your family's hub to manage Overwatch.");
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

/** The plane's updates shape of record: an object keyed by sorted pair key
 *  ("a|b" → { min, max }). Accepts either the model's [{ key, min, max }]
 *  rows or an already-keyed map; malformed rows never reach the wire. */
function travelUpdatesWire(updates) {
  const rows = Array.isArray(updates)
    ? updates.map((row) => [row?.key, row])
    : Object.entries(updates ?? {}).map(([key, row]) => [key, { key, ...row }]);
  const map = {};
  for (const [key, row] of rows) {
    const pair = String(key ?? "");
    if (!pair.includes("|")) continue;
    map[pair] = { min: Number(row?.min), max: Number(row?.max) };
  }
  return map;
}

/** The visits list window the plane requires (epoch seconds). No explicit
 *  window reads the last 24 hours of the hub's clock. */
const VISIT_WINDOW_SEC = 24 * 60 * 60;

export function createOverwatchActions({ active } = {}) {
  const connection = () => requireConnection(active);

  return {
    // (a) The property map's state of record: zones, cameras, adjacency,
    // travel times, and the dial's current fact.
    loadState: () => request(connection(), "overwatch/state"),

    saveZone: (cameraId, polygon) => request(connection(), `overwatch/zones/${enc(cameraId)}`, {
      method: "PUT", body: JSON.stringify({ polygon: Array.isArray(polygon) ? polygon : [] }),
    }),

    deleteZone: (cameraId) => request(connection(), `overwatch/zones/${enc(cameraId)}`, { method: "DELETE" }),

    saveAdjacency: (pairs) => request(connection(), "overwatch/adjacency", {
      method: "PUT", body: JSON.stringify({ pairs: Array.isArray(pairs) ? pairs : [] }),
    }),

    saveTravelTime: (updates) => request(connection(), "overwatch/travel-time", {
      method: "PUT", body: JSON.stringify({ updates: travelUpdatesWire(updates) }),
    }),

    // (d) The overview dial. The server clamps to capFps and answers
    // { frameRate, clamped } — the screen renders that answer.
    loadDial: () => request(connection(), "overwatch/dial"),

    saveDial: (frameRate) => request(connection(), "overwatch/dial", {
      method: "PUT", body: JSON.stringify({ frameRate: Number(frameRate) }),
    }),

    // (b) Tracked objects, the per-entity follow flag, and the followed
    // entity's stream (current state + ordered clips).
    loadTracked: () => request(connection(), "overwatch/tracked"),

    followEntity: (entityId) => request(connection(), `overwatch/tracked/${enc(entityId)}/follow`, { method: "POST" }),

    unfollowEntity: (entityId) => request(connection(), `overwatch/tracked/${enc(entityId)}/follow`, { method: "DELETE" }),

    loadEntityStream: (entityId) => request(connection(), `overwatch/tracked/${enc(entityId)}/stream`),

    // (c) Visits and their ordered timelines. The plane requires the window
    // (epoch seconds); no explicit window reads the last 24 hours.
    loadVisits: ({ from, to } = {}) => {
      // The plane requires epoch seconds; epoch numbers pass through and ISO
      // stamps convert. No explicit window reads the last 24 hours.
      const coerce = (value) => {
        if (value == null) return null;
        const num = Number(value);
        return Number.isFinite(num) ? num : Date.parse(value) / 1000;
      };
      const toNum = coerce(to);
      const fromNum = coerce(from);
      const windowTo = Number.isFinite(toNum) ? Math.floor(toNum) : Math.floor(Date.now() / 1000);
      const windowFrom = Number.isFinite(fromNum) ? Math.floor(fromNum) : windowTo - VISIT_WINDOW_SEC;
      return request(connection(), `overwatch/visits${queryString({ from: windowFrom, to: windowTo })}`);
    },

    loadVisitTimeline: (visitId) => request(connection(), `overwatch/visits/${enc(visitId)}/timeline`),

    // (e) The two-entity association flag ("keep separate").
    flagAssociation: ({ fromEntityId, toEntityId } = {}) => request(connection(), "overwatch/association/flag", {
      method: "POST", body: JSON.stringify({ fromEntityId: String(fromEntityId ?? ""), toEntityId: String(toEntityId ?? "") }),
    }),

    // The Overwatch audit trail, newest first, windowed like the home audit.
    loadAudit: ({ type, limit } = {}) => request(connection(), `overwatch/audit${queryString({ type, limit })}`),
  };
}
