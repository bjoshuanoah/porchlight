// Link previews (PORCH-052) client contract: compose detection, the body
// segmenter that renders pasted URLs as real links (external links open in
// a new tab, the standing law), and the render classes the hub resolution
// feeds.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { firstUrlIn, linkSegments } from "../src/link-preview.js";
import { renditionSrc, renditionSrcset, stampedAspect } from "../src/media-rung.js";

const src = (name) => readFile(join(import.meta.dirname, "..", name), "utf8");

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

// Brian's Oct 10 report (PORCH-052): previews must SHOW the image — not a
// collapsed 96px side thumbnail — and a failed image load drops out of the
// card instead of rendering a broken-image glyph.
test("ac-2 (rework): the card renders image-forward with the failed-image drop-out", async () => {
  const block = await src("src/link-preview.jsx");
  const card = block.slice(block.indexOf("Card class (Brian's Oct 10 report"), block.indexOf("function hostOf("));
  // The image leads: it renders before the text row in the card's source
  // order (the collapsed side-thumb row is gone).
  const imageAt = card.indexOf('component="img"');
  assert.ok(imageAt > 0, "the card carries the og:image");
  const textRowAt = card.indexOf('<Stack direction="row" spacing={1}');
  assert.ok(imageAt > 0 && imageAt < textRowAt, "the image leads the card before the text row");
  assert.doesNotMatch(card, /width: compact \? 48 : 96/, "the collapsed side-thumbnail layout is gone");
  // The card-width ladder request: the card renders from ~68ch/desktop and
  // near-viewport mobile, so sizes names the card width (never the old 96px).
  assert.match(card, /sizes="\(max-width: 899px\) calc\(100vw - 32px\), 68ch"/);
  // Never banner-scale: the image is capped inside the card's band.
  assert.match(card, /maxHeight: compact \? 140 : 260/);
  // A failed image load drops out of the card (no broken-image glyph) and
  // the text row still carries the preview.
  assert.match(card, /onError=\{\(\) => setImageFailed\(true\)\}/);
  assert.match(card, /og\?\.mediaId && !imageFailed/);
});