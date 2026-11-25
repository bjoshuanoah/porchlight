// PORCH-143 — Mixed photo/video posts: the mixed carousel on card and
// detail. Pins the rendered contract (Brian, Nov 25, 2026): a mixed post
// renders through the shipped PORCH-045 carousel machinery in attachment
// order, the slides are kind-aware (each slide media renders its own photo
// or video element), the viewer stays the photo sequence and opens only
// from a photo slide, and single-shaped posts render exactly as they did.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const social = readFileSync(fileURLToPath(new URL('../src/social.jsx', import.meta.url)), 'utf8');

test('PORCH-143: the per-reference kind rides the payload mediaMeta, ingest-stamped, never client-asserted', () => {
  // refKindOf resolves from the stamped contentType; a legacy payload
  // without stamps falls back to the single post shape (null otherwise).
  assert.match(social, /function refKindOf\(post, id\) \{/);
  assert.match(social, /const contentType = post\?\.mediaMeta\?\.\[id\]\?\.contentType;/);
  assert.match(social, /if \(contentType\.startsWith\('image\/'\)\) return 'photo';/);
  assert.match(social, /if \(contentType\.startsWith\('video\/'\)\) return 'video';/);
  assert.match(social, /if \(contentType\.startsWith\('audio\/'\)\) return 'audio';/);
  // Every consumer switches per reference; no mixed-vs-single fork forks the
  // MediaItem branch tree (the per-slide kind copy drives the branches).
  assert.match(social, /function kindPost\(post, id\) \{/);
  assert.match(social, /post=\{kindPost\(post, id\)\}/);
});

test('PORCH-143: a mixed post renders the carousel on card and detail; single-shaped posts keep their stack', () => {
  // The carousel gate admits mixed beside photo; the per-slide kind copy
  // rides both the carousel slides and the plain stack.
  assert.match(social, /ids\.length > 1 && \(post\.type === 'photo' \|\| mixed\)/);
  assert.match(social, /<MediaItem key=\{`\$\{id\}-\$\{index\}`\} id=\{id\} post=\{kindPost\(post, id\)\}/);
  // Attachment order: the slide list maps the mediaRefs order as given.
  const carousel = social.slice(social.indexOf('function MediaCarousel('), social.indexOf('function ComposerPreviewCarousel('));
  const media = social.slice(social.indexOf('function refKindOf('), social.indexOf('return <PostCard'));
  assert.match(carousel, /ids\.map\(\(id, index\)/);
  // No mixed-specific carousel variant exists — the shipped machinery only.
  assert.doesNotMatch(media, /MixedCarousel|mixed-carousel|function MixedMedia/);
});

test('PORCH-143: the viewer is the photo sequence of a mixed post and opens only from a photo slide', () => {
  assert.match(social, /const viewerIds = mixed \? ids\.filter\(\(id\) => refKindOf\(post, id\) === 'photo'\) : ids;/);
  assert.match(social, /refKindOf\(post, ids\[viewerIndex\]\) === 'photo'/);
  assert.match(social, /const startIndex = mixed && viewerIndex != null \? viewerIds\.indexOf\(ids\[viewerIndex\]\) : viewerIndex;/);
  assert.match(social, /<PhotoViewer post=\{post\} ids=\{viewerIds\}/);
});
