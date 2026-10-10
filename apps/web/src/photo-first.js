import { lightTokens, darkTokens } from "./theme.js";

// PORCH-043 build contract — "Photo-First Timeline: Build Contract"
// (Porchlight UI initiative, TS §5, Brian Oct 14, 2026). The published
// values live in one module so the timeline renders from a single source
// and the tests pin the contract (apps/web/test/photo-first.test.js).
// Scope note: this treatment supersedes the Oct 9 card styling on timeline
// surfaces only (mobile decisions stay mobile-only; the PORCH-041 detail
// card keeps its own treatment).
export const photoFirst = {
  // Responsive switch: the mobile treatment applies below 900px — the MUI
  // lg breakpoint (theme.js) breaks at exactly 900, matching the contract's
  // @media (max-width: 899.98px) switch.
  mobileBelow: 900,
  // 16px text rail: every textual element (header, caption, utility row,
  // action row, reactions, conversation content) sits on it; media alone
  // ignores it.
  rail: 16,
  // Desktop card padding (Oct 9 tokens). Media pulls past it so the media
  // spans the full interior post width with no internal horizontal padding.
  postPad: 20,
  // Post separation ships as the continuous-album 1px warm-neutral divider
  // (preferred mode; no card gap mode on mobile). The value rides the token
  // layer as a custom property — light per PORCH-043, dark per PORCH-042 —
  // so the feed divider never carries a screen-level mode branch.
  dividerColor: "var(--porch-timeline-divider)",
  dividerValues: { light: lightTokens.timelineDivider, dark: darkTokens.timelineDivider },
  // Extreme images only: the single crop-adjacent allowance. Landscapes and
  // ordinary portraits never cap; the natural ratio governs.
  extremeCap: "85vh",
  // The reserved frame's warm placeholder wash (PORCH-049 ac-2): the
  // aspect-ratio box shows this while media bytes are still arriving —
  // photos and video alike (the poster is video's own placeholder once it
  // lands). Token-layer contract like the divider: the custom property
  // resolves per mode with no screen-level branch. The subtle surface is
  // the wash of record — visibly distinct from both page and paper.
  mediaWash: "var(--porch-subtle)",
  mediaWashValues: { light: lightTokens.subtle, dark: darkTokens.subtle },
  // 12–14px media radius permitted at ≥900px; mobile media is square-cornered.
  desktopMediaRadius: 12,
  // Mobile vertical rhythm in px — 25–30% tighter than the Oct 9 spacing:
  // Header→caption 8–12; Caption→media 12; Media→utility 8; Utility→actions
  // 16; Actions→reactions 12; Reactions→conversation slice 8 (PORCH-046);
  // slice→divider 16.
  spacing: {
    headerCaption: 8,
    captionMedia: 12,
    mediaUtility: 8,
    utilityActions: 16,
    actionsReactions: 12,
    // PORCH-046: Reactions → conversation slice sits 8px above the card's
    // last text on the 16px mobile rail (build contract rhythm table).
    reactionsSlice: 8,
    endToDivider: 16,
  },
};
// PORCH-045 (Brian, Oct 10, 2026 user-testing note): as the member swipes
// between slides of differing aspect ratios, the page slides into the
// right size — the track height interpolates between the two bounding
// slides' heights from the scroll fraction instead of holding the tallest
// slide's space. Slides are never cropped to it: each keeps its natural
// photo-first height and only the visible window adapts. Unmeasurable
// slides (not yet laid out) carry the nearest measured neighbor; anything
// unmeasurable at both ends leaves the track at its natural height (null).
export function adaptiveTrackHeight(heights, slidePosition) {
  const clean = (Array.isArray(heights) ? heights : []).map((height) =>
    Number.isFinite(height) && height > 0 ? height : null,
  );
  if (!clean.length) return null;
  const position = Math.min(clean.length - 1, Math.max(0, Number.isFinite(slidePosition) ? slidePosition : 0));
  const lower = Math.floor(position);
  // Each boundary resolves to the nearest measurable slide height; a slide
  // whose box is not laid out yet carries its measured neighbor until its
  // real box resolves (legacy media without stamped geometry, mid-load).
  let from = null;
  for (let index = lower; index >= 0 && from == null; index -= 1) from = clean[index];
  for (let index = lower + 1; index < clean.length && from == null; index += 1) from = clean[index];
  if (from == null) return null;
  const next = Math.min(clean.length - 1, lower + 1);
  const to = clean[next] ?? from;
  return Math.round(from + (to - from) * (position - lower));
}

// PORCH-045 (Brian, Oct 14, 2026): the carousel's position math. The
// scroll-snap track's slide is the one nearest the scroll offset — release
// snapping to the nearest slide is the contract (ac-2), so position derives
// by rounding, never truncation.
export function carouselIndex(scrollLeft, slideWidth, count) {
  if (!(slideWidth > 0) || !(count > 0)) return 0;
  return Math.min(count - 1, Math.max(0, Math.round(scrollLeft / slideWidth)));
}
