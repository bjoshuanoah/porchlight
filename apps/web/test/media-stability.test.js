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
import { stampedAspect, mediaFileName } from "../src/media-rung.js";
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

test("PORCH-049 ac-3 + Brian's Oct 10 turn: no panel before the first tap, then pause, restart, mute, fullscreen", () => {
  // The direct rendition element and the blob-loader element share the
  // posture: playback begins with the sound off, inline, poster filling
  // the reserved frame. PORCH-123 (Brian, Oct 22, 2026): the start is
  // visibility-driven — the unconditional autoplay attribute is gone (an
  // element that mounted off-screen never plays), the registry starts the
  // visible slot muted, and no `autoPlay` remains on any video element.
  assert.match(social, /muted playsInline/);
  assert.doesNotMatch(social.slice(social.indexOf('function MediaItem'), social.indexOf('function mediaShape')), /autoPlay/);
  assert.match(social, /component="video" src=\{videoPlayable\} poster=\{videoPoster\}/);
  // No native chrome ever, and nothing of the panel before the first tap:
  // no `controls` attribute on any video element, and the playback panel
  // renders only behind the panelOpen gate (initially false).
  const videoElement = social.slice(social.indexOf('directVideo && <Box'), social.indexOf('{post.type === \'audio\''));
  assert.ok(!/\bcontrols\b/.test(videoElement));
  assert.match(social, /const \[panelOpen, setPanelOpen\] = useState\(false\);/);
  assert.match(social, /const playbackPanel = panelOpen && </);
  // The first tap on the media frame is the only door: sound arrives by
  // the muted element property (property, not attribute: autoplay reads
  // the property) and the panel opens with it.
  assert.match(social, /onClick=\{tapVideo\}/);
  assert.match(social, /element\.muted = false;/);
  assert.match(social, /setPanelOpen\(true\);/);
  // The member's mute choice (PORCH-121): a (re)mounted element initializes
  // from the held choice (never a hard muted re-assert over an explicit
  // unmute), the element's volumechange mirrors back into the one state,
  // and the panel's mute toggle writes the element and follows it —
  // no lifecycle re-mute path survives.
  assert.match(social, /element\.muted = initialMuted\(id\);/);
  assert.match(social, /onVolumeChange=\{mirrorMute\}/);
  assert.match(social, /element\.muted = !element\.muted;/);
  // After the first tap the panel owns the playback (Brian, 10/10: pause,
  // restart, un/mute, full screen built in): pause/resume truth rides the
  // element's play/pause events, restart replays from the top, mute rides
  // the property, fullscreen takes the standard API with the iOS webkit
  // fallback.
  assert.match(social, /onPlay=\{watchPlayback\} onPause=\{watchPlayback\}/);
  assert.match(social, /element\.currentTime = 0;/);
  assert.match(social, /element\.requestFullscreen/);
  assert.match(social, /webkitEnterFullscreen/);
});

test("PORCH-121: mute state is member-owned and held — the element is the truth, no override path survives", () => {
  // The rendered control derives from the element-mirroring state, which
  // every write path sets from the element after the touch, and
  // volumechange reconciles anything written outside the client's taps
  // (native fullscreen player controls).
  assert.match(social, /aria-label=\{soundOn \? 'Mute' : 'Unmute'\}/);
  assert.match(social, /const mirrorMute = \(event\) => \{/);
  assert.match(social, /const value = !event\.currentTarget\.muted;/);
  assert.match(social, /holdMute\(id, !element\.muted\);/);
  // The held store is a session interaction, keyed by media id — no
  // per-identity persistence, no server write anywhere.
  const muteModule = social.slice(social.indexOf("import { heldSoundOn"), social.indexOf("const rows ="));
  assert.doesNotMatch(muteModule, /request|api\.|body:/);
  // No re-apply effect writes muted anywhere in the media family: the
  // metadata handler captures geometry only.
  const mediaItem = social.slice(social.indexOf('function MediaItem'), social.indexOf('async function mediaShape'));
  assert.doesNotMatch(mediaItem, /muted = !soundOn/);
  assert.doesNotMatch(mediaItem, /el\.muted = true/);
});

test("PORCH-121 extent rule: inline portrait masking and the retired 16:9 frame", () => {
  // Only a video more portrait than 3:4 takes the ruled 3:4 mask; the
  // boundary is inclusive on the natural side (3:4 itself plays true).
  assert.match(social, /videoInlineMasked\(reserved\)/);
  assert.match(social, /aspectRatio: '3 \/ 4', overflow: 'hidden'/);
  // The masked element fills the fixed frame covered, center-cropped —
  // the poster rides the same treatment.
  assert.match(social, /objectFit: 'cover'/);
  // Natural true-ratio videos keep the stamped box at full media width —
  // and no 16:9 literal renders anywhere in the media family: the forced
  // 16:9 frame is retired on every breakpoint.
  const mediaItem = social.slice(social.indexOf('function MediaItem'), social.indexOf('async function mediaShape'));
  assert.doesNotMatch(mediaItem, /16 \/ 9/);
});

test("PORCH-049 turn: media sharing rides the ··· menus after the PORCH-082 retirement", async () => {
  // The per-image "download original and share" row is retired (PORCH-082):
  // no per-media Share or Get original button renders on any media surface,
  // and share stays reachable through the ··· overflow menus (PORCH-078).
  // The share sheet's file naming still maps content types (the viewer's
  // overlay download names its file the same way).
  const overlay = await readFile(join(webRoot, "src/photo-viewer.jsx"), "utf8");
  assert.doesNotMatch(social, />Share<\/Button>/);
  assert.match(overlay, /aria-label="Media overlay"/);
  // The share file is named from its content type (stable, extensionless
  // blobs never reach the sheet).
  assert.equal(mediaFileName("abc123", { type: "video/mp4" }), "abc123.mp4");
  assert.equal(mediaFileName("abc123", { type: "image/jpeg;charset=utf-8" }), "abc123.jpg");
  assert.equal(mediaFileName("abc123", { type: "video/x-matroska" }), "abc123.mp4");
  assert.equal(mediaFileName("abc123", { type: "image/avif" }), "abc123.jpg");
  assert.equal(mediaFileName("abc123", { type: "" }), "abc123.bin");
});

test("PORCH-049 ac-2: legacy media without stamps never gets a reserved box", () => {
  // No geometry, no box: the intrinsic fallback renders (the loader decodes
  // before the first paint so dimensions resolving never relayouts).
  assert.doesNotMatch(social, /aspectRatio: `\$\{reserved\}`[^;]*\}\s*:\s*\{\};?\s*\/\/ legacy/);
  // The legacy spinner (bounded, deterministic) stays the unstamped
  // fallback's placeholder — a zero-height wash box would corrupt layout.
  assert.match(social, /<CircularProgress size=\{20\} aria-label="Loading media"/);
});