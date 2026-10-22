/**
 * PORCH-123 (Brian, Oct 22, 2026): playback governance — play state binds to
 * visibility and exactly one inline video plays at a time. The defect of
 * record (audio heard from a video the member cannot see) dies by
 * construction: the audible video is always the one playing, and the one
 * playing is always in the viewport.
 *
 * Composition with PORCH-121 (member-owned mute): this module governs the
 * PLAY state only. It never touches `muted` on any element — pause never
 * re-mutes, resume never de-mutes, and the held member choice
 * (video-mute.js) initializes every element. No pause/resume path writes
 * any mute state.
 *
 * The registry is a module-scoped map of playing slots: client-side only,
 * session scope. No server write, no payload field on any event wire,
 * nothing in any envelope (a playing-state write would be a mute-class
 * override of the member's experience plus a new wire field). No UI ever
 * renders the registry — no highlight, no flash, no badge, no indicator;
 * the no-player-chrome law carries and the registry stays invisible by
 * construction.
 *
 * Precedence among multiple visible candidates: the slot that most recently
 * entered visibility plays; the others pause until they are the most recent
 * ([Assumed] tuned at build; supersede here if Brian wants a different
 * precedence). When the playing slot leaves, the previous most-recent
 * visible slot takes over, so a visible, playable video is always the one
 * playing and nothing off-screen ever plays.
 */

// slotKey is instance-unique (newPlaybackSlotKey) so the same media id on
// two mounted surfaces (card and detail) never shares one element control.
const slots = new Map();
// Element truth: slot keys whose element is in the playing state (ride the
// element's play/pause events, never ahead of them).
const playing = new Set();
// Monotonic visibility-entry tick: "most recently entered visibility" with
// no clock dependency.
let visibilityTick = 0;
// Full-screen overlay depth (the photo viewer is the overlay of record):
// while any overlay is open its content is the one playing surface and the
// inline elements beneath stay paused; closing returns to the ordinary
// visibility rule.
let overlayDepth = 0;
// A governance-initiated pause is in flight: its onPause is the registry's
// own write, never a member speech.
let governedPauseKey = null;
let slotCounter = 0;

function candidateEligible(slot) {
  return Boolean(slot) && slot.visible && !slot.memberPaused && !slot.blocked && Boolean(slot.ctrl);
}

function pauseSlot(key) {
  const slot = slots.get(key);
  if (!slot || !playing.has(key)) return;
  governedPauseKey = key;
  slot.ctrl.pause();
  // element.pause() on a paused element fires no event; the suppress flag
  // must not outlive the call.
  if (governedPauseKey === key) governedPauseKey = null;
}

function playSlot(slot) {
  const played = slot.ctrl.play();
  // element.play() reports its promise asynchronously; event truth
  // (notifyPlayback) records the outcome either way.
  return played === true;
}

/**
 * One reconciliation: at most one slot plays, and it is the most recently
 * entered visible eligible candidate (or the preferred slot, e.g. a slot
 * the member just started themselves). Every other slot pauses — the
 * previously playing one included, without member action.
 */
function reconcile(preferKey = null) {
  if (overlayDepth > 0) {
    // The overlay pauses everything beneath it and admits nothing new.
    for (const key of [...playing]) pauseSlot(key);
    return;
  }
  let candidate = null;
  if (preferKey && candidateEligible(slots.get(preferKey))) candidate = slots.get(preferKey);
  if (!candidate) {
    const eligible = [...slots.values()].filter(candidateEligible)
      .sort((a, b) => b.visibleAt - a.visibleAt);
    // An element that exists and accepts the play request wins; an absent
    // element (blob path not landed yet) yields to the next candidate.
    for (const slot of eligible) {
      if (playSlot(slot)) { candidate = slot; break; }
    }
  }
  for (const key of [...slots.keys()]) {
    if (key !== candidate?.key) pauseSlot(key);
  }
}

/**
 * An instance-unique slot key for one mounted media item: the same media id
 * may be mounted twice (card and detail); each element is its own slot.
 */
export function newPlaybackSlotKey(mediaId) {
  slotCounter += 1;
  return `${String(mediaId)}#${slotCounter}`;
}

/**
 * Register one video slot with its element controls. `ctrl.play()` returns
 * truthy when an element accepted (or already holds) the play request;
 * `ctrl.pause()` pauses it. Returns the release function — the unmount
 * cleanup (virtualization or route change included) pauses a playing slot
 * and never lets it auto-resume unseen; a remount re-enters through its own
 * visibility.
 */
export function registerPlaybackSlot(slotKey, mediaId, ctrl) {
  const key = String(slotKey);
  const slot = slots.get(key) ?? { key, mediaKey: String(mediaId), visible: false, visibleAt: -Infinity, memberPaused: false, blocked: false, ctrl: null };
  slot.ctrl = ctrl ?? slot.ctrl;
  slots.set(key, slot);
  return function release() {
    const held = slots.get(key);
    slots.delete(key);
    const wasPlaying = playing.delete(key);
    if (governedPauseKey === key) governedPauseKey = null;
    if (held?.visible && wasPlaying && overlayDepth === 0) reconcile();
  };
}

/**
 * The slot's strictly-viewport observation (rootMargin 0px, half-visible):
 * leaving the viewport pauses; entering starts playback at held mute state.
 * The slot-fetch observer (media-slot.js, rootMargin 160px) owns bytes and
 * rides unchanged beside this one.
 */
export function slotVisibility(slotKey, intersecting) {
  const key = String(slotKey);
  const slot = slots.get(key);
  if (!slot) return;
  const wasVisible = slot.visible;
  slot.visible = intersecting === true;
  if (slot.visible && !wasVisible) {
    slot.visibleAt = (visibilityTick += 1);
    slot.blocked = false;
  }
  if (overlayDepth > 0) return;
  reconcile();
}

/**
 * Element truth forwarded from the element's play/pause events. A play
 * event is the member's speech when the element started outside this
 * registry (panel/tap controls): it takes over — the previously playing
 * slot pauses on its own. A pause event outside a governance-initiated
 * pause is the member's held pause: it survives every visibility change
 * and re-entry never overrides it.
 */
export function notifyPlayback(slotKey, isPlaying) {
  const key = String(slotKey);
  const slot = slots.get(key);
  if (!slot) return;
  if (isPlaying) {
    slot.memberPaused = false;
    playing.add(key);
    if (overlayDepth > 0) {
      // A slot that somehow started under an overlay is not the playing
      // surface of record; pull it back.
      pauseSlot(key);
      return;
    }
    reconcile(key);
    return;
  }
  playing.delete(key);
  if (governedPauseKey === key) {
    governedPauseKey = null;
    return;
  }
  slot.memberPaused = true;
  if (overlayDepth === 0) reconcile();
}

/**
 * A (re)mounted element asks the registry to reconcile: a fresh element on
 * a visible, eligible slot starts playing; anything else stays paused.
 */
export function playbackSlotElementReady(slotKey) {
  const key = String(slotKey);
  const slot = slots.get(key);
  if (!slot) return;
  slot.blocked = false;
  if (overlayDepth > 0 || !slot.visible) return;
  reconcile();
}

/**
 * element.play() rejected (decode/load failure, not the benign AbortError
 * superseded by a pause): hold the slot out of candidacy until its next
 * visibility entry or element remount, and let the next candidate play.
 */
export function playbackSlotPlayRejected(slotKey) {
  const slot = slots.get(String(slotKey));
  if (!slot) return;
  slot.blocked = true;
  if (overlayDepth === 0) reconcile();
}

/**
 * The full-screen overlay opens: the overlay's content is the one playing
 * surface; every inline video beneath pauses (they are not on screen).
 * Refcounted so nested/held overlays compose.
 */
export function playbackOverlayOpen() {
  overlayDepth += 1;
  reconcile();
}

/**
 * The overlay closes: the ordinary visibility rule returns exactly —
 * visible slots resume at their held state, invisible ones stay paused.
 * Closing invents no hand-off machinery; it is one reconcile.
 */
export function playbackOverlayClose() {
  overlayDepth = Math.max(0, overlayDepth - 1);
  if (overlayDepth === 0) reconcile();
}

/**
 * Read-only snapshot for tests and audits: the media ids currently holding
 * the one playing state. Never rendered, never sent anywhere.
 */
export function playingMediaIds() {
  return [...playing].map((key) => slots.get(key)?.mediaKey ?? String(key).split('#')[0]);
}