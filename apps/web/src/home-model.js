// PORCH-137: the Home tab's model of record. Pure data and copy — no DOM,
// no React import, no network — so `node --test` loads it directly, the
// console-tabs discipline. The screen (home.jsx) renders from this module's
// vocabulary; home-actions.js is the wire half.

import { readLocal, writeLocal } from "./store.js";
import { relativeTime } from "./time.js";

// ---------------------------------------------------------------------------
// Device view
// ---------------------------------------------------------------------------

/** The device row's readable control value: true (on) / false (off) / null
 * (unknown). lastKnownState shapes the hub may serve — a boolean-ish object,
 * or the last command echo. Anything unrecognized stays null: the screen
 * renders "Unknown", never a guess. */
export function controlValueOf(state) {
  if (state == null) return null;
  if (typeof state === "boolean") return state;
  if (typeof state === "object") {
    if (typeof state.on === "boolean") return state.on;
    if (state.on === 1) return true;
    if (state.on === 0) return false;
    return null;
  }
  if (typeof state === "number") return state !== 0;
  if (typeof state === "string") {
    const value = state.trim().toLowerCase();
    if (["on", "turnon", "true", "1", "open"].includes(value)) return true;
    if (["off", "turnoff", "false", "0", "closed"].includes(value)) return false;
  }
  return null;
}

/** Plain-language last-known state text (the card's state line). */
export function deviceStateText(state) {
  if (state == null) return "Unknown";
  const value = controlValueOf(state);
  if (value === true) return "On";
  if (value === false) return "Off";
  if (typeof state === "string") return state.trim();
  if (typeof state === "number" || typeof state === "boolean") return String(state);
  if (typeof state === "object") {
    const on = state.on;
    const rest = Object.keys(state).filter((key) => key !== "on");
    const head = typeof on === "boolean" ? (on ? "On" : "Off") : null;
    const parts = rest.map((key) => `${key} ${String(state[key])}`);
    return [head, ...parts].filter(Boolean).join(", ") || "Reported";
  }
  return "Unknown";
}

/**
 * The one normalized shape device cards render. `staleLabel` carries the
 * contract copy: "As of <time> — <reason>" — ONLY when the row is stale; a
 * fresh row's staleLabel is null and the card never shows stale chrome.
 */
export function deviceView(device) {
  const row = device ?? {};
  const stale = row.stale === true;
  const view = {
    id: row._id ?? row.id ?? null,
    name: row.name || "Unnamed device",
    homeId: row.homeId ?? null,
    areaId: row.areaId ?? null,
    capabilities: Array.isArray(row.capabilities) ? row.capabilities : [],
    adapter: row.adapter && typeof row.adapter === "object" ? row.adapter : null,
    state: row.lastKnownState ?? null,
    on: controlValueOf(row.lastKnownState),
    stateText: deviceStateText(row.lastKnownState),
    stateConfirmedAt: row.stateConfirmedAt ?? null,
    asOf: row.stateConfirmedAt ? relativeTime(row.stateConfirmedAt) : "",
    stale,
    staleReason: stale ? row.staleReason || "Its status could not be confirmed." : null,
  };
  view.staleLabel = stale
    ? `As of ${view.asOf || "its last update"} — ${view.staleReason}`
    : null;
  return view;
}

// ---------------------------------------------------------------------------
// Areas / grouping
// ---------------------------------------------------------------------------

const areaName = (area) => area?.name || "Unnamed area";
const areaOrder = (area) => (typeof area?.order === "number" ? area.order : 0);

function compareAreas(a, b) {
  const byOrder = areaOrder(a.area) - areaOrder(b.area);
  if (byOrder !== 0) return byOrder;
  return areaName(a.area).localeCompare(areaName(b.area));
}

function compareDevices(a, b) {
  return (a.name ?? "").localeCompare(b.name ?? "");
}

/**
 * Devices grouped under their area, kind room vs outdoor — two SEPARATE
 * section lists, the PORCH-137 contract. Areas sort by `order` ascending
 * with a name tiebreak; devices sort by name inside their area. A device
 * whose area is missing rides one synthetic "Unassigned" area at the end of
 * the rooms section (never dropped, never invented into an outdoor section).
 */
export function groupDevicesByArea(devices, areas) {
  const roomBuckets = [];
  const outdoorBuckets = [];
  for (const area of Array.isArray(areas) ? areas : []) {
    if (!area || typeof area !== "object") continue;
    const bucket = { area: { ...area, kind: area.kind === "outdoor" ? "outdoor" : "room" }, devices: [] };
    (bucket.area.kind === "outdoor" ? outdoorBuckets : roomBuckets).push(bucket);
  }
  const buckets = new Map(
    [...roomBuckets, ...outdoorBuckets].map((bucket) => [bucket.area._id ?? bucket.area.id ?? null, bucket]),
  );
  const unassigned = { area: { _id: null, name: "Unassigned", kind: "room", order: Number.MAX_SAFE_INTEGER }, devices: [] };
  for (const device of Array.isArray(devices) ? devices : []) {
    if (!device || typeof device !== "object") continue;
    const bucket = buckets.get(device.areaId ?? null) ?? unassigned;
    bucket.devices.push(deviceView(device));
  }
  for (const bucket of [...roomBuckets, ...outdoorBuckets, unassigned]) {
    bucket.devices.sort(compareDevices);
  }
  roomBuckets.sort(compareAreas);
  outdoorBuckets.sort(compareAreas);
  const rooms = [...roomBuckets, ...(unassigned.devices.length ? [unassigned] : [])];
  rooms.sort(compareAreas); // keeps Unassigned (order MAX_SAFE_INTEGER) last on ties
  return { rooms, outdoor: outdoorBuckets };
}

// ---------------------------------------------------------------------------
// Command state machine
// ---------------------------------------------------------------------------

// The per-device command lifecycles. "idle" is the resting state; "loading"
// opens on a tap; "confirmed" opens ONLY from a server response (never from
// the tap — optimistic flips are banned); "failed" holds a plain-language
// reason and the device's last-known state stays rendered, now labeled stale.
export const COMMAND_STATES = ["idle", "loading", "confirmed", "failed"];

export const COMMAND_FAILED_FALLBACK = "The device did not respond.";

function asState(state) {
  if (typeof state === "string") return { status: state, reason: null };
  return { status: state?.status ?? "idle", reason: state?.reason ?? null };
}

/** One transition. Outcomes: "start" (tap → loading), "confirmed" | "failed"
 * (server response only), "clear" (back to idle). Anything else is a no-op
 * returning the current state — an unknown outcome never invents a state. */
export function nextCommandState(state, outcome, reason = null) {
  const current = asState(state);
  switch (outcome) {
    case "start":
      return { status: "loading", reason: null };
    case "confirmed":
      return { status: "confirmed", reason: null };
    case "failed":
      return { status: "failed", reason: reason || COMMAND_FAILED_FALLBACK };
    case "clear":
      return { status: "idle", reason: null };
    default:
      return current;
  }
}

/** The command state a device card renders, from the screen's per-device
 * map (device id → state). A device with no entry is idle — never loading,
 * never failed by default. */
export function commandStatusOf(states, deviceId) {
  return asState(states?.[deviceId]).status;
}

export function commandReasonOf(states, deviceId) {
  return asState(states?.[deviceId]).reason;
}

/**
 * The rendered on/off value. THE anti-optimism rule, pinned as an API: the
 * rendered control value ALWAYS reads the device row's confirmed
 * lastKnownState. `pendingCommand` (the clicked intent) is part of the
 * signature so callers cannot quietly drop it — and it is deliberately
 * never consulted: while a command is loading, this still returns the
 * device's last confirmed value, so the switch stays where the hub left it.
 */
export function renderedControlValue(device, pendingCommand) {
  void pendingCommand;
  return controlValueOf(device?.lastKnownState);
}

// ---------------------------------------------------------------------------
// Automations
// ---------------------------------------------------------------------------

const EVENT_PHRASES = {
  vehicle: "a vehicle is detected",
  person: "a person is detected",
  animal: "an animal is detected",
  button: "a button is pressed",
  door: "a door is opened",
};

/** Plain-language trigger line, e.g. "when a vehicle is detected in Driveway
 * after dark". Area resolution accepts an explicit areaName on the trigger
 * or the home's area list; an unresolvable area phrase is dropped, never
 * guesses. */
export function automationTriggerLabel(trigger, areas = []) {
  if (!trigger || typeof trigger !== "object") return "when something happens";
  const phrase = EVENT_PHRASES[trigger.eventClass] ?? "something happens";
  let label = `when ${phrase}`;
  const area = trigger.areaName
    ?? (trigger.areaId ? (Array.isArray(areas) ? areas : []).find((row) => (row?._id ?? row?.id) === trigger.areaId)?.name : undefined);
  if (area) label += ` in ${area}`;
  const window = trigger.timeWindow;
  if (window && typeof window === "object") {
    if (window.afterDark) label += " after dark";
    else if (window.from && window.to) label += ` between ${window.from} and ${window.to}`;
    else if (window.from) label += ` after ${window.from}`;
    else if (window.to) label += ` until ${window.to}`;
  }
  return label;
}

// ---------------------------------------------------------------------------
// Active home persistence (per hub origin)
// ---------------------------------------------------------------------------

// The active home id rides the store.js origin-scoped convention
// (`porch:<origin>:home-active`) — one device's picked home never leaks to
// another hub, and both helpers take a storage-like (localStorage in the
// app, a Map-backed stand-in in tests).
const ACTIVE_HOME_FIELD = "home-active";

export function readActiveHomeId(storage, origin) {
  if (!storage || typeof storage.getItem !== "function") return null;
  if (typeof origin !== "string" || !origin) return null;
  const value = readLocal(storage, origin, ACTIVE_HOME_FIELD, null);
  return typeof value === "string" && value ? value : null;
}

export function writeActiveHomeId(storage, origin, homeId) {
  if (!storage || typeof storage.setItem !== "function") return;
  if (typeof origin !== "string" || !origin) return;
  if (typeof homeId !== "string" || !homeId) return;
  writeLocal(storage, origin, ACTIVE_HOME_FIELD, homeId);
}
