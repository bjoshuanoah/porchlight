// Link previews (PORCH-052) client contract: compose detection, the body
// segmenter that renders pasted URLs as real links (external links open in
// a new tab, the standing law), and the render classes the hub resolution
// feeds.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { readFile, rm, mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";
import { build } from "esbuild";
import React from "react";
import { renderToString } from "react-dom/server";
import { firstUrlIn, linkSegments } from "../src/link-preview.js";
import { renditionSrc, renditionSrcset, stampedAspect } from "../src/media-rung.js";

const src = (name) => readFile(join(import.meta.dirname, "..", name), "utf8");

// PORCH-086 render sweep: the facade is bundled and rendered server-side
// with the real MUI, so the render contracts are checked against the DOM
// the member actually gets (the same harness shape reply-order.test.js
// sweeps the comment surfaces with).
const outDir = join(import.meta.dirname, ".tmp086");
let previewModule = null;
async function previews() {
  if (previewModule) return previewModule;
  await mkdir(outDir, { recursive: true });
  await build({
    stdin: { contents: 'export { LinkPreviewBlock } from "./link-preview.jsx";', resolveDir: dirname(fileURLToPath(new URL("../src/link-preview.jsx", import.meta.url))), loader: "jsx", sourcefile: "entry.jsx" },
    bundle: true, format: "esm", jsx: "automatic", platform: "neutral",
    external: ["react", "react-dom", "@mui/*", "@emotion/*", "@noble/*", "socket.io-client", "unicode-emoji-json", "react-transition-group", "hoist-non-react-statics"],
    outfile: join(outDir, "previews.built.mjs"), logLevel: "silent",
  });
  previewModule = await import(join(outDir, "previews.built.mjs"));
  return previewModule;
}
after(async () => { await rm(outDir, { recursive: true, force: true }); });

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
// PORCH-086 (Brian, Oct 15 — "for Apple Music I'm having to tap it twice to
// see it actually show up"): the facade left the play act on a tiny icon
// button, so a tap on the facade body landed on a dead layer and the
// provider embed only revealed on a second tap. The facade is ONE
// interactive surface now: the whole card carries the play act, any tap on
// it swaps in the provider iframe (the ruled tap-to-play act; the iframe's
// allow attribute and no-autoplay posture are untouched), and the same
// first-paint shape holds for every embed-class provider.
test("PORCH-086 ac-1: the whole facade is the play control — one tap, no dead tap layer", async () => {
  const block = await src("src/link-preview.jsx");
  const facade = block.slice(block.indexOf("if (!playing) {"), block.indexOf('component="iframe"'));
  // The play act rides the whole facade surface as one button.
  assert.match(facade, /component="button"/);
  assert.match(facade, /type="button"/);
  assert.match(facade, /onClick=\{\(\) => setPlaying\(true\)\}/);
  assert.match(facade, /aria-label=\{`Play \$\{PROVIDER_LABELS\[preview\.provider\] \?\? "the shared"\} link`\}/);
  // The old icon button — the only clickable element and the dead-tap
  // layer's reason — is gone from the facade; the glyph is decoration.
  assert.doesNotMatch(facade, /<IconButton/);
  assert.match(facade, /aria-hidden/);
});

test("PORCH-086 ac-1 (render sweep): the facade renders as one accessible button for every provider", async () => {
  const { LinkPreviewBlock } = await previews();
  for (const [provider, label] of [["apple_music", "Apple Music"], ["spotify", "Spotify"], ["youtube", "YouTube"], ["oembed", "Shared link"]]) {
    const html = renderToString(React.createElement(LinkPreviewBlock, {
      preview: { kind: "embed", provider, embedUrl: `https://embed.example/${provider}`, title: null, siteName: null },
      origin: "https://hub",
    }));
    assert.match(html, /<button[^>]*aria-label="Play (- )?[^"]*"/, label);
    assert.equal((html.match(/<button/g) ?? []).length, 1, `${label}: exactly one interactive element on the facade`);
    assert.ok(!/<button[^>]*>/g.test(html.slice(html.indexOf("</button>"))), `${label}: no nested interactive element inside the facade`);
  }
  // The iframe never autoplays and always renders only after the tap (the
  // contract of record, PORCH-052).
  const block = await src("src/link-preview.jsx");
  const iframe = block.slice(block.indexOf('component="iframe"'), block.indexOf("/  // Card class (Brian's Oct 10 report"));
  assert.doesNotMatch(iframe, /autoplay/i);
  assert.match(block, /allow="encrypted-media; clipboard-write; picture-in-picture"/);
});
