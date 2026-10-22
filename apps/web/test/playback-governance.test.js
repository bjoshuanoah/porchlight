// Playback governance (PORCH-123, Brian Oct 22 2026): play state binds to
// visibility and exactly one inline video plays at a time app-wide. The
// registry is client-side only — play state never crosses any wire, and no
// mute write rides any pause/resume path (PORCH-121 carries untouched).
// The registry machine is pinned as a pure contract module; the MediaItem
// wiring and the viewer overlay wiring are pinned as source contracts
// (house style: media-stability pins).
//
// The fake element forwards play/pause events into the registry exactly
// like MediaItem's watchPlayback does: the event-forwarding IS the
// suppressed-governance-pause contract's other half (a real element fires
// onPause synchronously inside the element.pause() call).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import {
  newPlaybackSlotKey, registerPlaybackSlot, slotVisibility, notifyPlayback,
  playbackSlotElementReady, playbackSlotPlayRejected,
  playbackOverlayOpen, playbackOverlayClose, playingMediaIds,
} from "../src/playback-governance.js";
import { heldSoundOn } from "../src/video-mute.js";

const webRoot = fileURLToPath(new URL("../", import.meta.url));
const social = await readFile(join(webRoot, "src/social.jsx"), "utf8");
const viewer = await readFile(join(webRoot, "src/photo-viewer.jsx"), "utf8");
const governance = await readFile(join(webRoot, "src/playback-governance.js"), "utf8");

function fakeSlot(mediaKey) {
  const element = { paused: true };
  const calls = [];
  const forward = (isPlaying) => notifyPlayback(element.slotKey, isPlaying);
  element.play = () => {
    if (element.paused) { element.paused = false; calls.push("play"); forward(true); }
  };
  element.pause = () => {
    if (!element.paused) { element.paused = true; calls.push("pause"); forward(false); }
  };
  element.slotKey = newPlaybackSlotKey(mediaKey);
  const release = registerPlaybackSlot(element.slotKey, mediaKey, {
    play: () => { element.play(); return true; },
    pause: () => element.pause(),
  });
  return { mediaKey, slotKey: element.slotKey, element, calls, release };
}

test("PORCH-123 ac-1: a playing video scrolled off the viewport pauses on its own; re-entry plays at held state", () => {
  const slot = fakeSlot("gov_a");
  slotVisibility(slot.slotKey, true);
  assert.ok(slot.element.paused === false, "a visible slot starts playing without member action");
  slotVisibility(slot.slotKey, false);
  assert.ok(slot.element.paused, "leaving the viewport pauses without member action");
  // No mute write rode either transition: the controlled call list is
  // play/pause only — pause never re-mutes, resume never de-mutes.
  assert.deepEqual(slot.calls, ["play", "pause"]);
  slotVisibility(slot.slotKey, true);
  assert.ok(slot.element.paused === false, "re-entry resumes playback at the held mute state");
  slot.release();
});

test("PORCH-123 ac-2: exactly one element plays — the previously playing slot pauses without member action", () => {
  const a = fakeSlot("gov_b1");
  const b = fakeSlot("gov_b2");
  slotVisibility(a.slotKey, true);
  slotVisibility(b.slotKey, true);
  assert.ok(b.element.paused === false && a.element.paused, "the most recently entered slot plays");
  assert.deepEqual(playingMediaIds(), ["gov_b2"]);
  // Scrolling a back into view takes the one playing slot over, all by the
  // registry, with no member hunting.
  slotVisibility(a.slotKey, false);
  assert.ok(b.element.paused === false, "the visible slot keeps the playing state");
  slotVisibility(a.slotKey, true);
  assert.ok(a.element.paused === false && b.element.paused, "the re-entered slot plays, the other pauses");
  assert.deepEqual(playingMediaIds(), ["gov_b1"]);
  // The member pausing a (panel/frame tap: a raw element pause outside the
  // registry) is the member's held speech: re-entry never overrides it.
  a.element.pause();
  assert.deepEqual(playingMediaIds(), ["gov_b2"], "the visible, eligible slot plays");
  slotVisibility(a.slotKey, false);
  slotVisibility(a.slotKey, true);
  assert.ok(a.element.paused, "a member-paused slot stays paused through visibility changes");
  assert.ok(b.element.paused === false);
  a.release();
  b.release();
});

test("PORCH-123 ac-2: a member-started play takes the playing slot over", () => {
  const a = fakeSlot("gov_c1");
  const b = fakeSlot("gov_c2");
  slotVisibility(a.slotKey, true);
  slotVisibility(b.slotKey, true); // b entered most recently → plays, a pauses
  assert.deepEqual(playingMediaIds(), ["gov_c2"]);
  // The member pauses b (panel/frame tap: a raw element pause outside the
  // registry) — the previously playing a becomes the visible candidate and
  // plays again.
  b.element.pause();
  assert.ok(b.element.paused && a.element.paused === false);
  assert.deepEqual(playingMediaIds(), ["gov_c1"]);
  // The member plays b again: the member's play takes the one playing slot
  // over — a pauses on its own, no hunting.
  b.element.paused = false;
  notifyPlayback(b.slotKey, true);
  assert.ok(a.element.paused, "the member's play pauses the previous one without hunting it down");
  assert.deepEqual(playingMediaIds(), ["gov_c2"]);
  a.release();
  b.release();
});

test("PORCH-123 ac-3: a governance pause is never member speech — the resume holds the mute state", () => {
  const slot = fakeSlot("gov_d");
  slotVisibility(slot.slotKey, true);
  slotVisibility(slot.slotKey, false); // governance pause; its own onPause forwards inside
  slotVisibility(slot.slotKey, true);
  assert.ok(slot.element.paused === false, "a governance-paused slot resumes on re-entry");
  // No pause/resume path wrote mute anywhere: the member never spoke, so
  // the held store for this media id is still untouched (muted start).
  assert.equal(heldSoundOn("gov_d"), null);
  slot.release();
});

test("PORCH-123 ac-5: an unmounted playing slot pauses and never resumes unseen; remount in view resumes", () => {
  const slot = fakeSlot("gov_e");
  slotVisibility(slot.slotKey, true);
  assert.deepEqual(playingMediaIds(), ["gov_e"]);
  slot.release(); // the virtualization unmount of the playing slot
  assert.equal(playingMediaIds().length, 0, "nothing plays after the playing slot unmounts");
  // Remount: a fresh element registering on a visible slot resumes at held
  // state.
  const remounted = fakeSlot("gov_e2");
  slotVisibility(remounted.slotKey, true);
  playbackSlotElementReady(remounted.slotKey);
  assert.ok(remounted.element.paused === false, "the remounted visible slot resumes at held state");
  remounted.release();
});

test("PORCH-123 ac-5: the viewer is the one playing surface; closing returns the ordinary rule", () => {
  const slot = fakeSlot("gov_f");
  slotVisibility(slot.slotKey, true);
  assert.deepEqual(playingMediaIds(), ["gov_f"]);
  playbackOverlayOpen();
  assert.equal(playingMediaIds().length, 0, "opening the viewer pauses the inline element beneath");
  // Even a newly mounted, newly visible slot under the overlay starts
  // nothing.
  const covered = fakeSlot("gov_f3");
  slotVisibility(covered.slotKey, true);
  assert.equal(playingMediaIds().length, 0, "nothing new plays while the overlay holds the screen");
  playbackOverlayClose();
  // Closing returns the ordinary rule: visible resumes at held state —
  // the most recently entered visibility plays (covered entered last).
  assert.ok(covered.element.paused === false && slot.element.paused);
  assert.deepEqual(playingMediaIds(), ["gov_f3"]);
  // Refcount parity: a second open/close pairs up cleanly.
  playbackOverlayOpen();
  assert.equal(playingMediaIds().length, 0);
  playbackOverlayClose();
  assert.ok(covered.element.paused === false, "the parity close restores the ordinary rule");
  slot.release();
  covered.release();
});

test("PORCH-123 ac-2: an element-less candidate yields to the next most-recent visible slot", () => {
  const loaded = fakeSlot("gov_g");
  slotVisibility(loaded.slotKey, true);
  // A later-entered slot whose element has not landed yet (blob path) must
  // not starve or stop the loaded one: its play control reports no element.
  const laterKey = newPlaybackSlotKey("gov_g2");
  const laterRelease = registerPlaybackSlot(laterKey, "gov_g2", {
    play: () => false,
    pause: () => {},
  });
  slotVisibility(laterKey, true);
  assert.deepEqual(playingMediaIds(), ["gov_g"], "the loaded slot keeps the one playing state");
  laterRelease();
  loaded.release();
});

test("PORCH-123 ac-2: a rejected play holds the slot out of candidacy and the next candidate plays", () => {
  const healthy = fakeSlot("gov_h");
  slotVisibility(healthy.slotKey, true);
  const failingKey = newPlaybackSlotKey("gov_h2");
  const attempts = [];
  const failingRelease = registerPlaybackSlot(failingKey, "gov_h2", {
    play: () => { attempts.push("play-attempt"); return false; },
    pause: () => {},
  });
  slotVisibility(failingKey, true); // its element does not accept the play
  assert.deepEqual(playingMediaIds(), ["gov_h"], "the healthy slot keeps playing");
  playbackSlotPlayRejected(failingKey); // element.play() rejected (not an AbortError)
  assert.deepEqual(playingMediaIds(), ["gov_h"]);
  playbackSlotElementReady(failingKey); // the remount re-arms this slot's candidacy
  assert.deepEqual(attempts, ["play-attempt", "play-attempt"], "the remounted element is asked again");
  failingRelease();
  healthy.release();
});

test("PORCH-123 ac-6: the registry is invisible and wire-free", () => {
  // No network write anywhere in the module: no fetch/XHR/beacon/URL write,
  // no payload field, no storage write, no envelope.
  assert.doesNotMatch(governance, /fetch\(|XMLHttpRequest|sendBeacon|localStorage|sessionStorage|indexedDB/);
  // No mute write anywhere in governance: it writes the play state only.
  assert.doesNotMatch(governance, /\.muted/);
  // No DOM mutation, no UI, no chrome: the module renders no element and
  // touches no DOM attribute.
  assert.doesNotMatch(governance, /document\.|createElement|setAttribute|className|aria-|data-/);
  // No persistence and no cross-surface channel: session scope, module
  // memory only.
  assert.doesNotMatch(governance, /postMessage|BroadcastChannel|EventSource|WebSocket|api/);
});

test("PORCH-123: MediaItem wiring — the strictly-viewport observer, no autoplay, one attach path", () => {
  const mediaItem = social.slice(social.indexOf('function MediaItem'), social.indexOf('async function mediaShape'));
  // The playback observer owns the play state with no pre-fetch margin:
  // rootMargin 0px at the half-visible threshold — a playing (or audible)
  // video is on the member's screen.
  assert.match(social, /slotVisibility\(slotKeyRef\.current, entry\.isIntersecting\);\s*\}, \{ rootMargin: '0px', threshold: 0\.5 \}\)/);
  // The byte-owned fetch observer is untouched beside it (160px margin).
  assert.match(social, /rootMargin: '160px', threshold: 0\.01/);
  // Every video element registers, and element truth forwards both ways.
  assert.match(social, /registerPlaybackSlot\(slotKeyRef\.current, id, \{ play: governancePlay, pause: governancePause \}\)/);
  assert.match(social, /onPlay=\{watchPlayback\} onPause=\{watchPlayback\}/);
  assert.match(social, /notifyPlayback\(slotKeyRef\.current, event\.type === 'play'\);/);
  // The mute law composition: the attach path initializes from the held
  // choice (the only mute write in the family), while the governance
  // play/pause controls are mute-free.
  const governanceControls = mediaItem.slice(mediaItem.indexOf('const governancePlay'), mediaItem.indexOf('// PORCH-123 strictly-viewport playback observer'));
  assert.match(governanceControls, /element\.muted = initialMuted\(id\);/);
  const playPausePaths = governanceControls.slice(governanceControls.indexOf('const governancePlay'), governanceControls.indexOf('const attachVideo'));
  assert.doesNotMatch(playPausePaths, /\.muted/);
  // No playing-state data crosses any wire: MediaItem's governance wiring
  // issues no request.
  assert.doesNotMatch(governanceControls, /fetch\(|invoke\(/);
});

test("PORCH-123: the viewer overlay wiring rides the viewer lifecycle", () => {
  assert.match(viewer, /playbackOverlayOpen\(\);/);
  assert.match(viewer, /playbackOverlayClose\(\);/);
  // Open rides the pushState/open effect; close its cleanup (back/Escape
  // included) — no hand-off machinery of its own.
  assert.ok(viewer.indexOf('playbackOverlayOpen();') < viewer.indexOf("window.addEventListener('popstate'"));
  assert.ok(viewer.indexOf('playbackOverlayClose();') > viewer.indexOf("window.removeEventListener('popstate'"));
});

test("PORCH-123: the registry keys are instance-unique per mounted media item", () => {
  const first = newPlaybackSlotKey("gov_k");
  const second = newPlaybackSlotKey("gov_k");
  assert.notEqual(first, second, "the same media on card and detail is two slots");
  assert.notEqual(newPlaybackSlotKey("gov_l"), first);
});