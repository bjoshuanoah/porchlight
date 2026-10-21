// The picker's mobile keyboard contract (PORCH-120, Brian Oct 21 2026):
// on mobile-class widths, with the keyboard risen over the picker's search
// field, the picker positions INSIDE the visual viewport — the focused
// field, the active results, and the selectable grid stay visible and the
// nothing-pickable-sits-beneath-the-keyboard law holds at every scroll
// position. Desktop-class widths keep the anchored popover exactly as
// shipped (the viewport contract is the mobile-class path only).
//
// The geometry here is pure so the visual-viewport assertion is unit
// testable: the picker applies this state as its Popover anchor while the
// keyboard is risen and drops back to the resting anchor the moment the
// visible viewport recovers (the in-progress pick never scrolls out from
// under the finger — the grid DOM node never remounts).
//
// No third-party viewport or keyboard library enters the bundle; the
// measurements come from the browser's own visualViewport API.

/** The mobile-class line — matches the theme's lg:900 breakpoint and the
 *  photo-first mobile rail (mobileBelow: 900): at or below this width the
 *  viewport contract engages. */
export const MOBILE_CLASS_MAX = 899.95;

/** How much visible-viewport shrink counts as a risen keyboard (a browser
 *  chrome resize is far smaller than any software keyboard). */
export const KEYBOARD_MIN = 120;

/** The picker's margin from the visual viewport edges while docked. */
export const DOCK_MARGIN = 8;

/**
 * The dock geometry for the risen-keyboard state, or null when the popover
 * rests as shipped. `visualViewport` is the browser's VisualViewport (page
 * coordinates are `offsetTop`/`offsetLeft` relative to the layout
 * viewport). Dock height never drops below the picker's minimum usable
 * grid (160), so the contract fails visibly rather than silently
 * collapsing; width clamps at zero defensively.
 *
 * Returns `{ top, left, width, height, keyboardTop }` in page coordinates:
 * the Popover's anchorPosition (top-left) and the paper's size caps;
 * `keyboardTop` is the page-coordinate line the keyboard occupies —
 * nothing pickable may sit beneath it.
 */
export function keyboardDock({
  innerWidth = 0,
  innerHeight = 0,
  visualViewport = null,
  margin = DOCK_MARGIN,
} = {}) {
  const viewport = visualViewport;
  if (!viewport || typeof viewport.height !== "number" || typeof viewport.offsetTop !== "number") return null;
  if (typeof innerWidth !== "number" || !(innerWidth <= MOBILE_CLASS_MAX)) return null;
  // The keyboard covers the bottom of the LAYOUT viewport — the visible
  // viewport's window-coordinate shrink measures it (page scroll lives in
  // offsetTop, not in the shrink).
  const hiddenBelow = innerHeight - viewport.height;
  if (!(hiddenBelow >= KEYBOARD_MIN)) return null;
  return {
    top: Math.round(viewport.offsetTop + margin),
    left: Math.round(viewport.offsetLeft + margin),
    width: Math.max(0, Math.round(viewport.width - margin * 2)),
    height: Math.max(160, Math.round(viewport.height - margin * 2)),
    keyboardTop: Math.round(viewport.offsetTop + viewport.height),
  };
}