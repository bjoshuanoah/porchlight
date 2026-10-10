// Link previews (PORCH-052) client contract: compose detection, the body
// segmenter that renders pasted URLs as real links (external links open in
// a new tab, the standing law), and the render classes the hub resolution
// feeds.
import { test } from "node:test";
import assert from "node:assert/strict";
import { firstUrlIn, linkSegments } from "../src/link-preview.js";
import { renditionSrc, renditionSrcset, stampedAspect } from "../src/media-rung.js";

test("ac-3: compose detection finds the first http(s) URL in a draft", () => {
  assert.equal(firstUrlIn("Look https://www.youtube.com/watch?v=abc then stop"), "https://www.youtube.com/watch?v=abc");
  assert.equal(firstUrlIn("http://family.example/photo"), "http://family.example/photo");
  assert.equal(firstUrlIn("no link here"), null);
  assert.equal(firstUrlIn(""), null);
});

test("ac-4: pasted URLs render as links that open in a new tab", () => {
  const segments = linkSegments("Read https://news.example/story today");
  assert.deepEqual(segments, [
    { text: "Read ", url: null },
    { text: "https://news.example/story", url: "https://news.example/story" },
    { text: " today", url: null },
  ]);
  assert.deepEqual(linkSegments("plain text only"), [{ text: "plain text only", url: null }]);
  assert.deepEqual(linkSegments(""), []);
});

test("ac-2: the card's og:image rides the hub's own origin through the rendition contract", () => {
  const og = {
    mediaId: "med_og",
    width: 1200,
    height: 630,
    aspect: 1.9048,
    renditions: [
      { kind: "feed-thumb", sha256: "a".repeat(64), width: 640, height: 336, bytes: 100 },
      { kind: "album", sha256: "b".repeat(64), width: 1080, height: 567, bytes: 140 },
    ],
  };
  const src = renditionSrc(og, "https://hub.example");
  assert.equal(src, "https://hub.example/api/social/media/med_og/renditions/feed-thumb?v=" + "a".repeat(64));
  assert.equal(renditionSrcset(og, "https://hub.example").includes("https://hub.example/api/social/media/med_og/renditions/album"), true);
  assert.equal(stampedAspect(og), 1.9048);
});