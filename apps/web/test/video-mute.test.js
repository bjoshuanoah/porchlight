// Member-owned video mute state and the portrait extent (PORCH-121,
// Brian Oct 21, 2026; extent corrected Oct 22, 2026). The pure rules are
// pinned as a contract module; the JSX posture rides as source contracts
// in media-stability.test.js.
import { test } from "node:test";
import assert from "node:assert/strict";
import { heldSoundOn, holdMute, initialMuted } from "../src/video-mute.js";
import { PORTRAIT_EXTENT, videoInlineMasked } from "../src/photo-first.js";

test("PORCH-121: the held choice starts empty — the muted autoplay start is the element's own initial condition", () => {
  assert.equal(heldSoundOn("med_a"), null);
  assert.equal(initialMuted("med_a"), true, "a member who has not spoken gets the muted start");
});

test("PORCH-121: the member's explicit choice holds for the session and re-initializes every remount", () => {
  holdMute("med_b", true); // the member unmuted audibly
  assert.equal(heldSoundOn("med_b"), true);
  assert.equal(initialMuted("med_b"), false, "a remounted element initializes unmuted, never re-muted over the choice");
  holdMute("med_b", false); // the member tapped the mute control again
  assert.equal(heldSoundOn("med_b"), false);
  assert.equal(initialMuted("med_b"), true);
  // The choice is per video (keyed by the origin-unique media id), not per
  // device session: another video's autoplay start is untouched.
  assert.equal(heldSoundOn("med_c"), null);
});

test("PORCH-121 extent rule: only a video more portrait than 3:4 inline-masks to 3:4", () => {
  assert.equal(typeof PORTRAIT_EXTENT, "number");
  assert.ok(Math.abs(PORTRAIT_EXTENT - 0.75) < 1e-9);
  // The 9:16 class is masked.
  assert.equal(videoInlineMasked(9 / 16), true);
  assert.equal(videoInlineMasked(0.62), true);
  // Square, 4:5, 3:4 itself, and landscapes all play their true ratio.
  assert.equal(videoInlineMasked(1), false, "square shows its true 1:1 ratio, never cropped to 3:4");
  assert.equal(videoInlineMasked(4 / 5), false);
  assert.equal(videoInlineMasked(3 / 4), false, "the extent is inclusive on the natural side");
  assert.equal(videoInlineMasked(16 / 9), false);
  // No geometry states no mask (the intrinsic fallback renders).
  assert.equal(videoInlineMasked(null), false);
  assert.equal(videoInlineMasked(0), false);
});