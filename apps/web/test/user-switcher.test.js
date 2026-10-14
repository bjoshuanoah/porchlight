// Header user switcher (PORCH-076): the shell header's top-right avatar menu
// carries exactly the identities registered on this device plus Sign out,
// rides the existing shared-device switch law (the PORCH-075-verified
// sequence through switchIdentity, PIN-gated by IdentityPinEntry), and the
// Profile destination renders as Settings. Source-level assertions follow
// the established suite pattern (switch-identity.test.js, brand-lockup.test.js):
// the SPA has no DOM harness, so the pins read the shipped source and walk
// its real structure.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const identitySource = await readFile(join(here, "..", "src", "identity.jsx"), "utf8");
const mainSource = await readFile(join(here, "..", "src", "main.jsx"), "utf8");

function slice(source, from, to) {
  const start = source.indexOf(from);
  assert.notEqual(start, -1, `source block "${from}" not found`);
  const end = to === undefined ? source.length : source.indexOf(to, start + from.length);
  assert.notEqual(end, -1, `source end "${to}" not found`);
  return source.slice(start, end);
}

// The user switcher component: everything between its declaration and the
// next boundary marker after it. IdentityPinEntry ships directly before it,
// so the slice ends at the next top-level declaration.
const switcher = slice(identitySource, "export function UserSwitcher(", "\nfunction invitationUrl(");
const pinEntry = slice(identitySource, "export function IdentityPinEntry(", "export function UserSwitcher(");

test("ac-1: switcher trigger renders for any open session, menu = device faces + Sign out", () => {
  // The trigger is the open identity's avatar (initials fallback), 36px
  // class, with an accessible name; single-identity devices are not gated
  // out and no shared-device threshold exists in the component.
  assert.match(switcher, /aria-label="Who is here"/);
  assert.match(switcher, /sx=\{\{ width: 36, height: 36/);
  assert.match(switcher, /ownFaceSources\(data\?\.identityAccount \?\? null\)/);
  assert.doesNotMatch(switcher, /faces\.length\s*>\s*1/);
  assert.doesNotMatch(switcher, /sharedDevice/);

  // The menu rows are exactly this device's registrations (the WhoIsHere
  // face filter) plus one Sign out action.
  assert.match(switcher, /connection\?\.identity\?\.id && connection\.deviceId/);
  assert.match(switcher, /<Divider \/>/);
  assert.match(switcher, /aria-label="Sign out"/);
  assert.match(switcher, /primary="Sign out"/);

  // No session, no switcher — the guard the front states rely on.
  assert.match(switcher, /if \(!data\?\.identity\?\.id\) return null;/);

  // The shell mounts the switcher in the header on every breakpoint, and
  // only where a session can be open (the AppBar itself is !frontDoor).
  const appbar = slice(mainSource, "<AppBar position=\"sticky\"", "</AppBar>");
  assert.match(appbar, /<UserSwitcher \{\.\.\.props\} \/>/);
  const appbarGuardStart = mainSource.indexOf("!frontDoor && <AppBar");
  assert.notEqual(appbarGuardStart, -1, "AppBar is not frontDoor-gated");
  assert.match(mainSource.slice(appbarGuardStart, mainSource.indexOf("</AppBar>")), /^!frontDoor/);
  // Mobile 56px / desktop 64px toolbar heights ride the same header.
  assert.match(appbar, /minHeight: \{ xs: 56, lg: 64 \}/);
});

test("ac-2: tapping a face opens it under the shared-device law, PIN-gated", () => {
  // Faces open through the existing switch action (the PORCH-075-verified
  // sequence lives in actions.switchIdentity); the switcher adds no second
  // session path.
  assert.match(switcher, /operation\.run\('switchIdentity', \[face\.identity\.id\]\)/);

  // The open identity's row is marked and non-interactive; no other row is.
  assert.match(switcher, /disabled=\{isOpen \|\| operation\.busy\}/);
  assert.match(switcher, /aria-current=\{isOpen \? 'true' : undefined\}/);
  assert.match(switcher, /\{isOpen && <CheckOutlined/);

  // A set per-identity PIN prompts IdentityPinEntry before the open.
  assert.match(switcher, /if \(storedPin\(face\)\) \{ setPinFor\(face\.identity\.id\); return; \}/);
  assert.match(switcher, /<Dialog open=\{Boolean\(chosen\)\}/);
  assert.match(switcher, /<IdentityPinEntry face=\{chosen\}/);
  // IdentityPinEntry verifies the local digest and then runs the same
  // switch action — one code path, no replacement mechanics.
  assert.match(pinEntry, /pinDigest\(pin, record\.salt\) !== record\.digest/);
  assert.match(pinEntry, /operation\.run\('switchIdentity', \[face\.identity\.id\]\)/);

  // The menu holds one open session's error surface instead of vanishing:
  // a failed switch keeps the menu open with the plain error row.
  assert.match(switcher, /if \(result\) setMenuOpen\(false\)/);
  assert.match(switcher, /\{operation\.error && <MenuItem disabled/);
});

test("ac-3: Sign out is the existing sign-out contract", () => {
  // The switcher defers to actions.signOut — session clear only, device
  // stays registered — and its fallback lands the same WhoIsHere front
  // state. The switcher itself never touches registrations or tokens.
  assert.match(switcher, /if \(typeof actions\?\.signOut === 'function'\) actions\.signOut\(\);/);
  assert.match(switcher, /navigate\?\.\('\/who-is-here'\)/);
  assert.doesNotMatch(switcher, /removeItem|saveConnections|identityToken/);
  // The front-state reopen law is pinned elsewhere (front-state.test.js,
  // main.jsx signOut); this surface may not diverge from it.
  assert.match(mainSource, /markSignedOut\(stored, origin\)/);
  assert.match(mainSource, /clearSignedOut\(stored, origin\)/);
});

test("ac-4: chrome discipline and copy audit hold", () => {
  // The trimmed headers gain exactly one control: the switcher avatar. No
  // create-post, search-moments, or albums action returns to the header,
  // and the retired interim Switch person control is gone.
  const appbar = slice(mainSource, "<AppBar position=\"sticky\"", "</AppBar>");
  assert.doesNotMatch(appbar, /Albums|albums|Search|search/);
  assert.doesNotMatch(mainSource, /Switch person/);
  // It never renders in the front state or the full-screen WhoIsHere
  // chooser: WhoIsHere carries no switcher and the AppBar is frontDoor-gated.
  const whoIsHere = slice(identitySource, "export function WhoIsHere(", "export function IdentityPinEntry(");
  assert.doesNotMatch(whoIsHere, /UserSwitcher/);

  // Family vocabulary only: the standing audit gate covers identity.jsx —
  // its JSXText and spaced string literals, switcher menu included — and
  // audit.test.js runs that script against the live tree.

  // The Profile destination renders as Settings: labels, routes, page
  // branch, and the retired Profile labels swept member-facing.
  assert.match(mainSource, /const primary = \["\/timeline", "\/groups", "\/compose", "\/settings"\];/);
  assert.match(mainSource, /const labels = \["Timeline", "Groups", "Compose", "Settings"\];/);
  assert.match(mainSource, /route === "\/settings"\) page = <Settings/);
  // Stale /profile deep links land on the renamed destination.
  assert.match(mainSource, /next === "\/profile" \? "\/settings" : next/);
  // Nav sweeps to /settings everywhere; the "/profile" string survives only
  // in the deep-link mapping and an unrelated server API path.
  assert.doesNotMatch(mainSource, /navigate\("\/profile"\)/);
  assert.doesNotMatch(mainSource, /route === "\/profile"/);
  assert.match(identitySource, /<Heading title="Settings"/);
  assert.doesNotMatch(identitySource, /"Profile"|"profile"|\bprofile section\b/);
  // The Settings account block retires the redundant Switch button (the
  // header switcher owns switching now); the plain sign-out action stays.
  const settings = slice(identitySource, "export function Settings(", "The device front state (PORCH-055)");
  assert.doesNotMatch(settings, /Switch person/);
  assert.match(settings, /actions\.signOut\(\)/);
  // The front-state pairing guidance now names Settings.
  assert.match(identitySource, /open Settings, tap “Make pairing code”/);
});