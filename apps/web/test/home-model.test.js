// PORCH-137: the Home tab model is the contract of record. ac-1 area
// grouping (rooms and outdoor areas stay SEPARATE section lists, ordered by
// `order` asc with a name tiebreak), ac-2 stale labeling copy, ac-3 the
// command machine (loading is distinct from confirmed and failed, and the
// rendered control value NEVER flips optimistically), ac-4 plain-language
// trigger lines, ac-5 the per-origin active-home memory. Pure imports only —
// node --test loads this without a loader, like every sibling suite.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  COMMAND_STATES, COMMAND_FAILED_FALLBACK, automationTriggerLabel, commandReasonOf,
  commandStatusOf, controlValueOf, deviceView, grantStatusLabel, groupDevicesByArea,
  isVisitorAccess, nextCommandState, readActiveHomeId, renderedControlValue,
  summarizeScopes, writeActiveHomeId,
} from "../src/home-model.js";
import { readLocal, writeLocal } from "../src/store.js";

const area = (_id, name, kind, order) => ({ _id, name, kind, order });
const deviceRow = (areaId, name, extra = {}) => ({ _id: `d:${name}`, areaId, name, ...extra });

test("ac-1: rooms and outdoor areas group separately, order asc with a name tiebreak", () => {
  const areas = [
    area("out2", "Zane Yard", "outdoor", 2),
    area("r2", "Kitchen", "room", 2),
    area("out1", "Backyard", "outdoor", 1),
    area("r1", "Living Room", "room", 1),
    area("r1b", "Attic", "room", 1), // same order as Living Room — name breaks the tie
  ];
  const devices = [
    deviceRow("r2", "Kettle"),
    deviceRow("out1", "Sprinkler"),
    deviceRow("r1b", "Lantern"),
    deviceRow("out2", "Gate cam"),
    deviceRow("r1", "Lamp"),
  ];
  const grouped = groupDevicesByArea(devices, areas);
  // Attic and Living Room share order 1 — the name tiebreak puts Attic first.
  assert.deepEqual(grouped.rooms.map(({ area: row }) => row.name), ["Attic", "Living Room", "Kitchen"]);
  assert.deepEqual(grouped.outdoor.map(({ area: row }) => row.name), ["Backyard", "Zane Yard"]);
  assert.deepEqual(
    grouped.rooms.flatMap(({ devices: rows }) => rows.map((row) => row.name)),
    ["Lantern", "Lamp", "Kettle"],
  );
  // A device whose area is missing rides the synthetic last bucket — never stranded.
  const withStray = groupDevicesByArea([deviceRow("nope", "Ghost plug")], areas);
  assert.deepEqual(withStray.rooms.at(-1).devices.map((row) => row.name), ["Ghost plug"]);
  assert.deepEqual(withStray.rooms.at(-1).area.name, "Unassigned");
});

test("ac-2: stale devices carry the 'As of <time> — <reason>' label; fresh rows carry none", () => {
  const stale = deviceView({
    _id: "d1",
    name: "Porch light",
    capabilities: ["light", "switch"],
    lastKnownState: { on: true },
    stateConfirmedAt: "2026-11-25T20:00:00Z",
    stale: true,
    staleReason: "The hub has not heard from it since Tuesday.",
  });
  assert.equal(stale.stale, true);
  assert.equal(stale.staleReason, "The hub has not heard from it since Tuesday.");
  assert.match(stale.staleLabel, /^As of /);
  assert.ok(stale.staleLabel.includes("The hub has not heard from it since Tuesday."));
  assert.ok(stale.staleLabel.includes("—"), "the label separates the read time from the reason");
  assert.equal(stale.on, true);
  assert.equal(stale.stateText, "On");

  const fresh = deviceView({
    _id: "d2", name: "Hall lamp", capabilities: ["switch"],
    lastKnownState: { on: false }, stateConfirmedAt: "2026-11-25T20:00:00Z", stale: false, staleReason: null,
  });
  assert.equal(fresh.staleLabel, null);
  assert.equal(fresh.stateText, "Off");

  const unknown = deviceView({ _id: "d3", name: "New plug", capabilities: ["switch"] });
  assert.equal(unknown.stateText, "Unknown");
  assert.equal(unknown.on, null);
});

test("ac-3a: the command machine holds four distinct states and confirmed arrives only from the server", () => {
  assert.deepEqual(COMMAND_STATES, ["idle", "loading", "confirmed", "failed"]);
  // A tap starts loading — and NEVER confirms, never fails on its own.
  assert.equal(nextCommandState("idle", "start").status, "loading");
  assert.equal(nextCommandState("loading", "start").status, "loading");
  assert.equal(commandStatusOf({}, "d1"), "idle", "an absent device is idle, never loading/failed");
  // The server response alone moves loading → confirmed/failed.
  assert.equal(nextCommandState("loading", "confirmed").status, "confirmed");
  const failed = nextCommandState("loading", "failed", "The bulb did not answer.");
  assert.equal(failed.status, "failed");
  assert.equal(failed.reason, "The bulb did not answer.");
  assert.equal(nextCommandState("loading", "failed").reason, COMMAND_FAILED_FALLBACK);
  // clear returns to idle; unknown outcomes change nothing.
  assert.deepEqual(nextCommandState(failed, "clear"), { status: "idle", reason: null });
  assert.deepEqual(nextCommandState("loading", "polled"), { status: "loading", reason: null });
  // confirmed never originates from a tap outcome (only an explicit server
  // response outcome reaches it through this machine, hence from loading).
  const states = { d1: { status: "loading", reason: null } };
  assert.equal(commandStatusOf(states, "d1"), "loading");
  assert.equal(commandReasonOf({ d1: failed }, "d1"), "The bulb did not answer.");
});

test("ac-3b: the rendered control value always reads lastKnownState — the pending intent is never consulted", () => {
  const device = { _id: "d1", name: "Porch light", lastKnownState: { on: false } };
  // While a turnOn tap is in flight, the rendered value stays OFF — the
  // confirmed value. An optimistic flip cannot even be expressed here.
  assert.equal(renderedControlValue(device, { command: "turnOn", status: "loading" }), false);
  assert.equal(renderedControlValue(device, { command: "turnOff", status: "loading" }), false);
  assert.equal(renderedControlValue(device, null), false);
  const confirmedOn = { _id: "d1", lastKnownState: { on: true } };
  assert.equal(renderedControlValue(confirmedOn, { command: "turnOff", status: "loading" }), true);
  assert.equal(controlValueOf({ on: 0 }), false);
  assert.equal(controlValueOf("turnOn"), true);
  assert.equal(controlValueOf(undefined), null);
});

test("ac-4: trigger labels read in plain language", () => {
  const areas = [area("a1", "Driveway", "outdoor", 1)];
  assert.equal(
    automationTriggerLabel({ eventClass: "vehicle", areaId: "a1", timeWindow: { afterDark: true } }, areas),
    "when a vehicle is detected in Driveway after dark",
  );
  assert.equal(
    automationTriggerLabel({ eventClass: "door", areaName: "Front porch", timeWindow: { from: "22:00", to: "06:00" } }),
    "when a door is opened in Front porch between 22:00 and 06:00",
  );
  assert.equal(automationTriggerLabel({ eventClass: "button" }), "when a button is pressed");
  assert.equal(automationTriggerLabel({ eventClass: "person" }), "when a person is detected");
  assert.equal(automationTriggerLabel({ eventClass: "animal" }), "when an animal is detected");
  // An unresolvable area drops the phrase — it never guesses a name.
  assert.equal(
    automationTriggerLabel({ eventClass: "vehicle", areaId: "gone" }, areas),
    "when a vehicle is detected",
  );
  assert.equal(automationTriggerLabel(null), "when something happens");
});

test("ac-5: the active home id persists per hub origin through a storage-like", () => {
  const storageFor = () => {
    const map = new Map();
    return {
      getItem: (key) => (map.has(key) ? map.get(key) : null),
      setItem: (key, value) => { map.set(key, String(value)); },
    };
  };
  const hubA = storageFor();
  const hubB = storageFor();
  assert.equal(readActiveHomeId(hubA, "http://home.example"), null, "empty storage reads null, never undefined");

  writeActiveHomeId(hubA, "http://home.example", "home-1");
  writeActiveHomeId(hubB, "http://other.example", "home-9");
  // Same browser storage key vocabulary (store.js origin prefix), different origins never cross.
  assert.equal(readActiveHomeId(hubA, "http://home.example"), "home-1");
  assert.equal(readActiveHomeId(hubB, "http://other.example"), "home-9");
  assert.equal(readActiveHomeId(hubA, "http://other.example"), null);

  // The row rides readLocal/writeLocal exactly (key porch:<origin>:<field>).
  assert.equal(readLocal(hubA, "http://home.example", "home-active", null), "home-1");
  writeLocal(hubA, "http://home.example", "home-active", "home-2");
  assert.equal(readActiveHomeId(hubA, "http://home.example"), "home-2");

  // Guards: junk writes and reads change nothing.
  writeActiveHomeId(hubA, "http://home.example", "");
  writeActiveHomeId(hubA, null, "home-3");
  writeActiveHomeId(null, "http://home.example", "home-3");
  assert.equal(readActiveHomeId(hubA, "http://home.example"), "home-2");
  assert.equal(readActiveHomeId(null, "http://home.example"), null);
  assert.equal(readActiveHomeId(hubA, ""), null);
});

test("ac-6: scope summaries read as name — plain verb lines, with truthful fallbacks", () => {
  const devices = [{ _id: "dev-1", name: "Porch light" }, { _id: "dev-2", name: "Kettle" }];
  const areas = [{ _id: "area-1", name: "Driveway" }];
  const scenes = [{ _id: "scene-1", name: "Movie night" }];

  // View only, view+control, control-only, name resolution per resource type.
  assert.deepEqual(summarizeScopes(
    [
      { resourceType: "device", resourceRef: "dev-1", verbs: ["view"] },
      { resourceType: "scene", resourceRef: "scene-1", verbs: ["view", "control"] },
      { resourceType: "area", resourceRef: "area-1", verbs: ["view", "control"] },
      { resourceType: "device", resourceRef: "dev-2", verbs: ["control"] },
    ],
    devices, areas, scenes,
  ), [
    "Porch light — see",
    "Movie night — see and control",
    "Driveway — see and control",
    "Kettle — control",
  ]);

  // A scope naming something the home no longer has renders its kind, never a
  // guess; empty and junk inputs render as nothing.
  assert.deepEqual(
    summarizeScopes([{ resourceType: "device", resourceRef: "gone", verbs: ["view"] }], devices, areas, scenes),
    ["A device — see"],
  );
  assert.deepEqual(summarizeScopes([], devices, areas, scenes), []);
  assert.deepEqual(summarizeScopes(undefined), []);
  // Junk rows are dropped, never rendered; a row that names nothing real and
  // carries no verbs renders as its bare kind line.
  assert.deepEqual(summarizeScopes([null, { resourceType: "vehicle" }]), ["A resource"]);
});

test("ac-7: grant status labels mirror the server's own order — revoked, then expired, then live", () => {
  const now = "2026-11-26T12:00:00.000Z";
  const live = { expiresAt: "2026-11-26T12:00:00.001Z", revokedAt: null };
  const expiredByMoment = { expiresAt: "2026-11-26T12:00:00.000Z", revokedAt: null };
  const expired = { expiresAt: "2026-11-25T00:00:00.000Z", revokedAt: null };
  const revoked = { expiresAt: "2026-11-27T00:00:00.000Z", revokedAt: "2026-11-26T10:00:00.000Z" };
  // Revocation beats a future checkout; the checkout moment itself (<= now) has passed.
  assert.equal(grantStatusLabel(live, now), "Live");
  assert.equal(grantStatusLabel(expiredByMoment, now), "Expired");
  assert.equal(grantStatusLabel(expired, now), "Expired");
  assert.equal(grantStatusLabel(revoked, now), "Revoked");
  // A revoked grant stays revoked whatever the clock does next.
  assert.equal(grantStatusLabel(revoked, "2026-11-26T20:00:00.000Z"), "Revoked");

  // No now means now — a live card reads live now and expired a second later
  // without a caller-supplied clock drifting the answer.
  const justNow = { expiresAt: new Date().toISOString(), revokedAt: null };
  assert.equal(grantStatusLabel(justNow), "Expired");

  // Junk can never invent a state.
  assert.equal(grantStatusLabel(null), "Unknown");
  assert.equal(grantStatusLabel(undefined), "Unknown");
});

test("ac-8: the visitor flag answers for the two visit classes only", () => {
  assert.equal(isVisitorAccess({ accessClass: "individual-grant", role: null, scopes: [] }), true);
  assert.equal(isVisitorAccess({ accessClass: "family-grant", role: null, scopes: [] }), true);
  assert.equal(isVisitorAccess({ accessClass: "owner-membership", role: "owner", scopes: null }), false);
  assert.equal(isVisitorAccess({ accessClass: "owner-membership", role: "member", scopes: null }), false);
  assert.equal(isVisitorAccess(null), false);
  assert.equal(isVisitorAccess(undefined), false);
  assert.equal(isVisitorAccess({}), false);
});
