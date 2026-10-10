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
// PORCH-045 (Brian, Oct 14, 2026): the carousel's position math. The
// scroll-snap track's slide is the one nearest the scroll offset — release
// snapping to the nearest slide is the contract (ac-2), so position derives
// by rounding, never truncation.
export function carouselIndex(scrollLeft, slideWidth, count) {
  if (!(slideWidth > 0) || !(count > 0)) return 0;
  return Math.min(count - 1, Math.max(0, Math.round(scrollLeft / slideWidth)));
}
