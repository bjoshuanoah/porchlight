// Media layout stability and video playback (PORCH-049, Brian's
// media-optimization ruling Oct 14, 2026): the geometry stamp arrives in
// every payload, the reserved frame never reflows on load (warm wash for
// photos, poster for video, intrinsic fallback for legacy payloads, and no
// shimmer anywhere), and family video plays the way an image loads —
// muted inline autoplay with tap-for-sound. The pure helpers are pinned
// as a contract module; the MediaItem posture is pinned as source
// contracts (house style: photo-first/media-carousel pins).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { stampedAspect } from "../src/media-rung.js";
import { photoFirst } from "../src/photo-first.js";
import { lightTokens, darkTokens } from "../src/theme.js";

const webRoot = fileURLToPath(new URL("../", import.meta.url));
const social = await readFile(join(webRoot, "src/social.jsx"), "utf8");

test("PORCH-049 ac-2: the reserved frame derives from the stamped aspect, dims, or falls back intrinsically", () => {
  // The stamp of record (the payload's computed aspect) leads.
  assert.equal(stampedAspect({ aspect: 1.7778, width: 1280, height: 720 }), 1.7778);
  // A pre-PORCH-049 archive carrying only dims still reserves exactly.
  assert.equal(stampedAspect({ width: 1600, height: 1067 }), 1600 / 1067);
  // Legacy media with no geometry at all falls back to intrinsic sizing.
  assert.equal(stampedAspect({ width: null, height: null, aspect: null }), null);
  assert.equal(stampedAspect(null), null);
});

test("PORCH-049 ac-2: the placeholder wash is the token-layer subtle surface, never a literal", () => {
  assert.equal(photoFirst.mediaWash, "var(--porch-subtle)");
  assert.equal(photoFirst.mediaWashValues.light, lightTokens.subtle);
  assert.equal(photoFirst.mediaWashValues.dark, darkTokens.subtle);
});

test("PORCH-049 ac-2: media elements reserve the stamped box before and after load", () => {
  // The reserved aspect-ratio box derives from the stamp and applies to the
  // media element itself — identical geometry before and after bytes land.
  assert.match(social, /const reserved = resource\?\.width && resource\?\.height \? resource\.width \/ resource\.height : stampedAspect\(meta\);/);
  assert.match(social, /aspectRatio: `\$\{reserved\}`/);
  // The warm wash is the waiting-media surface — the element background,
  // not a hole — while bytes are still arriving on the direct path.
  assert.match(social, /bgcolor: photoFirst\.mediaWash/);
  // The blob-loader fallback renders the same reserved wash box while the
  // media decodes (stamped payloads), the legacy spinner only without
  // geometry — the intrinsic fallback keeps its bounded loading state.
  assert.match(social, /role="status" aria-label="Loading media"/);
  // No shimmer anywhere: no shimmer/pulse/skeleton animation enters the
  // media surfaces (the PORCH-043 spin rule carries; prose mentions don't
  // count — the slice is the rendered contract only).
  const mediaItem = social.slice(social.indexOf('function MediaItem'), social.indexOf('function mediaShape'));
  assert.ok(!/shimmer|skeleton/i.test(mediaItem));
  assert.doesNotMatch(mediaItem, /animation:|keyframes/);
});

test("PORCH-049 ac-3: family video plays the way an image loads — muted inline autoplay, tap for sound", () => {
  // The direct rendition element and the blob-loader element share the
  // posture: playback begins with the sound off, inline, poster filling
  // the reserved frame.
  assert.match(social, /autoPlay muted playsInline/);
  assert.match(social, /component="video" src=\{videoPlayable\} poster=\{videoPoster\}/);
  // No player chrome and no sound precede the tap: the video carries no
  // controls at all (audio keeps its transport).
  const videoElement = social.slice(social.indexOf('directVideo && <Box'), social.indexOf('{post.type === \'audio\''));
  assert.ok(!videoElement.includes("controls"));
  // Sound arrives only from a tap ON the media frame — toggling the muted
  // property (property, not attribute: autoplay reads the property).
  assert.match(social, /onClick=\{toggleSound\}/);
  assert.match(social, /event\.currentTarget\.muted = soundOn;/);
  // The muted property is load-bearing at mount and re-asserted on
  // metadata load (the boot-window retry remounts the element).
  assert.match(social, /if \(el\) el\.muted = true;/);
  assert.match(social, /event\.currentTarget\.muted = !soundOn;/);
});

test("PORCH-049 ac-2: legacy media without stamps never gets a reserved box", () => {
  // No geometry, no box: the intrinsic fallback renders (the loader decodes
  // before the first paint so dimensions resolving never relayouts).
  assert.doesNotMatch(social, /aspectRatio: `\$\{reserved\}`[^;]*\}\s*:\s*\{\};?\s*\/\/ legacy/);
  // The legacy spinner (bounded, deterministic) stays the unstamped
  // fallback's placeholder — a zero-height wash box would corrupt layout.
  assert.match(social, /<CircularProgress size=\{20\} aria-label="Loading media"/);
});