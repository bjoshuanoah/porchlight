// PORCH-045 — Multi-image posts render as a swipeable carousel.
// Pins the ruled contract (Brian, Oct 14, 2026): a single swipeable
// carousel on every breakpoint, the Oct 9 grid treatments and the +3
// overlay superseded, slides obeying the photo-first media rules
// (PORCH-043), a quantity-only position indicator, and interactions that
// stay bound to the post.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { carouselIndex, photoFirst } from '../src/photo-first.js';

const social = readFileSync(fileURLToPath(new URL('../src/social.jsx', import.meta.url)), 'utf8');

test('PORCH-045 ac-2: release snaps to the nearest slide', () => {
  // Position rounds to the nearest slide, never truncates.
  assert.equal(carouselIndex(0, 390, 5), 0);
  assert.equal(carouselIndex(400, 390, 5), 1);
  assert.equal(carouselIndex(194, 390, 5), 0);
  assert.equal(carouselIndex(196, 390, 5), 1);
  assert.equal(carouselIndex(780, 390, 5), 2);
  // The ends clamp; degenerate widths never divide.
  assert.equal(carouselIndex(99999, 390, 2), 1);
  assert.equal(carouselIndex(-120, 390, 5), 0);
  assert.equal(carouselIndex(100, 0, 5), 0);
  assert.equal(carouselIndex(100, 390, 0), 0);
});

test('PORCH-045 ac-1: multi-image posts render one swipeable carousel, grids stay out', () => {
  // Media routes multi-image photo posts to the carousel on every breakpoint.
  assert.match(social, /ids\.length > 1 && post\.type === 'photo'\)\s*\{\s*return <MediaCarousel/);
  assert.match(social, /return <MediaCarousel ids=\{ids\} post=\{post\} actions=\{actions\} detail=\{detail\} \/>/);
  // The snap track is the single carousel shape; slides map the whole set.
  assert.match(social, /scrollSnapType: 'x mandatory'/);
  assert.match(social, /aria-roledescription="slide"/);
  // The superseded Oct 9 grid treatments and the +3 overlay render nowhere.
  assert.doesNotMatch(social, /MediaGrid|first-four-with|large-and-stacked|'\+3'|"+3"/);
  // The carousel owns the breakout once for the whole series (photo-first
  // PORCH-043): edge-to-edge mobile media with the rail intact for text.
  assert.match(social, /const carouselBreakoutSx = \{/);
  assert.match(social, /width: \{ xs: `calc\(100% \+ \$\{2 \* photoFirst\.rail\}px\)`, lg: `calc\(100% \+ \$\{2 \* photoFirst\.postPad\}px\)` \},/);
  assert.equal(photoFirst.rail, 16);
  assert.equal(photoFirst.postPad, 20);
});

test('PORCH-045 ac-2: one slide per gesture; near-vertical drags scroll the timeline; desktop arrows', () => {
  // scroll-snap-stop always halts momentum at the adjacent slide.
  assert.match(social, /scrollSnapStop: 'always'/);
  // Horizontal touch drags swipe the track and near-vertical drags chain to
  // the timeline: the touch-action must permit both pan axes. A vertical-only
  // value (pan-y alone) starves the horizontal swipe entirely (user-testing
  // failure "Carousel is not swipeable").
  assert.match(social, /touchAction: 'pan-x pan-y'/);
  assert.doesNotMatch(social, /touchAction: 'pan-y'/);
  // Arrow affordances cover desktop and hide on mobile.
  assert.match(social, /function CarouselArrows\(/);
  assert.match(social, /display: \{ xs: 'none', lg: 'inline-flex' \}/);
  assert.match(social, /aria-label="Previous image"/);
  assert.match(social, /aria-label="Next image"/);
});

test('PORCH-045 ac-3: slides obey the photo-first media rules', () => {
  // Slide mode omits its own breakout: the track owns it once, slides are
  // exact media width and never nest in a padded frame.
  assert.match(social, /const breakout = !detail && media && !slide;/);
  assert.match(social, /<MediaItem id=\{id\} post=\{post\} actions=\{actions\} detail=\{detail\} slide \/>/);
  // Natural aspect ratio per slide with the 85vh contain cap rides the
  // existing fitSx; no fixed pixel track height exists in the carousel.
  assert.match(social, /photoFirst\.extremeCap/);
  const carousel = social.slice(social.indexOf('// Shared snap-track treatment'), social.indexOf('function Media('));
  assert.doesNotMatch(carousel, /height: '(?:\d+)px'/);
  // The breakout is applied to the carousel wrapper, not per slide.
  assert.match(carousel, /position: 'relative', \.\.\.\(!detail \? carouselBreakoutSx : \{\}\)/);
});

test('PORCH-045 ac-4: quiet position indicator, quantity only', () => {
  // The "2/5"-style indicator renders the actual position and count.
  assert.match(social, /\{position \+ 1\}\/\{count\}/);
  assert.match(social, /color: 'porchlight\.muted'/);
  // No engagement counts or popularity language enter the carousel surface.
  const carousel = social.slice(social.indexOf('// Shared snap-track treatment'), social.indexOf('function Media('));
  assert.doesNotMatch(carousel, /\b(?:likes?|hearts?|views?|followers?|trending|popular|for you)\b/i);
});

test('PORCH-045 ac-5: interactions bind to the post, never the slide', () => {
  // The carousel writes no interaction state: no invoke, no reaction, vote,
  // or reply call lives in the carousel; the slide position is local state.
  const carousel = social.slice(social.indexOf('function MediaCarousel'), social.indexOf('// PORCH-045: upload previews'));
  assert.doesNotMatch(carousel, /\binvoke\(|\bunreact\b|\bsubmitReply\b/);
  // PostCard's writes bind to the post object, never to a slide. The
  // optimistic card reply (PORCH-046) rides the same submitReply call.
  const postCard = social.slice(social.indexOf('function PostCard'), social.indexOf('</Card>;') + 9);
  assert.match(postCard, /invoke\(actions, 'vote', post/);
  assert.match(postCard, /invoke\(actions, 'submitReply', post/);
  const reactions = social.slice(social.indexOf('function PresentReactions'), social.indexOf('function PostCard'));
  assert.match(reactions, /invoke\(actions, isOwn \? 'unreact' : 'react', post/);
});

test('PORCH-045: composer upload previews render the carousel preview shape', () => {
  assert.match(social, /function ComposerPreviewCarousel\(\{ files \}\)/);
  assert.match(social, /type === 'photo' && <ComposerPreviewCarousel files=\{files\} \/>/);
  // Same snap track, same slide treatment, same quantity indicator.
  const preview = social.slice(social.indexOf('function ComposerPreviewCarousel'), social.indexOf('function Media('));
  assert.match(preview, /sx=\{carouselTrackSx\}/);
  assert.match(preview, /carouselSlideSx/);
  assert.match(preview, /\{position \+ 1\}\/\{count\}/);
});