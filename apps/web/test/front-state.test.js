import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { bootRoute, readSignedOut, markSignedOut, clearSignedOut } from "../src/front-state.js";

const webRoot = fileURLToPath(new URL("..", import.meta.url));

function fakeStorage() {
  const map = new Map();
  return {
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => void map.set(key, String(value)),
    removeItem: (key) => void map.delete(key),
  };
}

const face = (id) => ({ url: "http://hub.test", identity: { id, name: id }, deviceId: "dev-1" });

test("ac-1: a signed-out registered device boots into the front state — one face included (PORCH-055)", () => {
  assert.equal(bootRoute({ pathname: "/", search: "", connections: [face("june")], signedOut: true }), "/who-is-here");
  // The shared rule keeps the chooser too, but the marker alone is enough.
  assert.equal(bootRoute({ pathname: "/", search: "", connections: [face("june"), face("amy")], signedOut: true }), "/who-is-here");
});

test("ac-2: the forever-logged-in path is untouched (PORCH-055)", () => {
  // No open session, no signed-out marker: direct timeline reopen.
  assert.equal(bootRoute({ pathname: "/", search: "", connections: [face("june")], signedOut: false }), "/timeline");
  // The shared-device chooser rule (multiple registrations, or a pinned face).
  assert.equal(bootRoute({ pathname: "/", search: "", connections: [face("june"), face("amy")], signedOut: false }), "/who-is-here");
  assert.equal(bootRoute({ pathname: "/", search: "", connections: [face("june")], signedOut: false, pinned: true }), "/who-is-here");
});

test("ac-4: grant consumption wins over the front state, deep paths ride their own routes (PORCH-055)", () => {
  // A join link tapped while the front state is showing routes into its flow.
  assert.equal(bootRoute({ pathname: "/", search: "?invite=inv-code_123", connections: [face("june")], signedOut: true }), "/join");
  assert.equal(bootRoute({ pathname: "/", search: "?invite=inv-code_123", connections: [face("june"), face("amy")], signedOut: true }), "/join");
  // The join and device-link paths own their grants wherever the device is.
  assert.equal(bootRoute({ pathname: "/join/inv-code_123", search: "", connections: [face("june")], signedOut: true }), "/join/inv-code_123");
  assert.equal(bootRoute({ pathname: "/device-link/dl-grant", search: "", connections: [face("june")], signedOut: true }), "/device-link/dl-grant");
  // A zero-registration device is the join front door, query or not.
  assert.equal(bootRoute({ pathname: "/", search: "", connections: [], signedOut: false }), "/join");
  assert.equal(bootRoute({ pathname: "/", search: "?invite=inv-code_123", connections: [], signedOut: false }), "/join");
});

test("ac-3/ac-5: no signed-out marker means a device without registrations never sees the chooser", () => {
  assert.equal(bootRoute({ pathname: "/", search: "", connections: [], signedOut: true }), "/join");
});

test("the signed-out marker is a client-local, per-origin toggle", () => {
  const storage = fakeStorage();
  assert.equal(readSignedOut(storage, "http://hub.test"), false);
  markSignedOut(storage, "http://hub.test");
  assert.equal(readSignedOut(storage, "http://hub.test"), true);
  // Per-origin: another hub's marker state is independent.
  assert.equal(readSignedOut(storage, "http://other.test"), false);
  // An identity opening clears the marker locally.
  clearSignedOut(storage, "http://hub.test");
  assert.equal(readSignedOut(storage, "http://hub.test"), false);
});

test("ac-5: the front state greets the family and the Add someone sheet keeps exactly two doors (PORCH-055)", async () => {
  const source = await readFile(join(webRoot, "src", "identity.jsx"), "utf8");
  const chooser = source.slice(
    source.indexOf("export function WhoIsHere"),
    source.indexOf("function invitationUrl"),
  );
  assert.match(chooser, /Who's using Porchlight\?/);
  // The former direct-join affordance is superseded by the Add someone sheet.
  assert.doesNotMatch(chooser, /Join another network/);
  assert.doesNotMatch(chooser, /"Choose"/);
  assert.match(chooser, /Add someone/);
  assert.match(chooser, /Already in \{networkName\(data\)\}/);
  assert.match(chooser, /New here/);
  // Exactly the two doors: pairing-code entry and the join surface.
  assert.match(chooser, /navigate\?\.\('\/pair'\)/);
  assert.match(chooser, /navigate\?\.\('\/join'\)/);
});

test("ac-1: the front state renders bare — app-shell chrome only mounts behind a front-door gate (PORCH-055)", async () => {
  const source = await readFile(join(webRoot, "src", "main.jsx"), "utf8");
  // Both AppBar and the bottom tab bar render only outside the front door,
  // and the WhoIsHere route sits inside that gate.
  assert.match(source, /\{!frontDoor && <AppBar/);
  assert.match(source, /\{!frontDoor && <Paper/);
  assert.match(source, /const frontDoor = .*route === "\/who-is-here"/);
  // The screens learn the signed-out regime only through data, no state fork.
  assert.match(source, /frontState: readSignedOut\(stored, origin\)/);
});

test("ac-2: the superseded direct-to-timeline sign-out reopen is gone (PORCH-055)", async () => {
  const source = await readFile(join(webRoot, "src", "identity.jsx"), "utf8");
  assert.doesNotMatch(source, /opens straight into your timeline/);
  assert.match(source, /Switch person/);
});