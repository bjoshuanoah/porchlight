/**
 * PORCH-121 (Brian, Oct 21, 2026): member-owned video mute state, session
 * scope. The video element's real audio state is the single source of the
 * rendered control; this store only holds the member's explicit choice so
 * every lifecycle surface that re-creates the element (the slot's
 * key=attempt re-issue, a virtualization unmount/remount, a feed remount)
 * initializes the fresh element from the held choice instead of re-muting
 * over it. No server write, no per-identity persistence: the choice lives
 * in the member's interaction for the session, keyed by media id
 * (origin-unique), so the same media on the card and the detail view holds
 * one choice.
 */
const heldMute = new Map();

/**
 * The member's held sound-on choice for a video: true (audibly unmuted),
 * false (the member explicitly re-muted), null when the member has not
 * spoken yet (the muted autoplay start is then the element's own initial
 * condition).
 */
export function heldSoundOn(mediaId) {
  const key = String(mediaId);
  return heldMute.has(key) ? heldMute.get(key) : null;
}

/**
 * Hold the member's mute choice — the element state after their tap. The
 * element writes are the only mute writes; this mirrors them.
 */
export function holdMute(mediaId, soundOn) {
  heldMute.set(String(mediaId), soundOn === true);
}

/**
 * What a (re)mounted element initializes from: the held member choice when
 * one exists, else the muted autoplay start (PORCH-049 ruling carries).
 */
export function initialMuted(mediaId) {
  return heldSoundOn(mediaId) !== true;
}