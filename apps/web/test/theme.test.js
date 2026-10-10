import { test } from "node:test";
import assert from "node:assert/strict";
import { theme, tokens } from "../src/theme.js";

// PORCH-022: every applied value must be the normative token from the UI
// Implementation Specification — a regression here is the exact bug owners
// saw as a "generic" look instead of the Porchlight design system.
test("palette carries the Porchlight tokens, not framework defaults", () => {
  assert.equal(theme.palette.mode, "light");
  assert.equal(theme.palette.background.default, tokens.page);
  assert.equal(tokens.page, "#F7F5F0");
  assert.equal(theme.palette.background.paper, "#FFFFFF");
  assert.equal(theme.palette.primary.main, "#10243A"); // navy: type + identity
  assert.equal(theme.palette.secondary.main, "#D88A24"); // amber: primary action
  assert.equal(theme.palette.secondary.dark, "#C87918");
  assert.equal(theme.palette.divider, "#E4E0D8");
  assert.equal(theme.palette.text.primary, "#122033");
  assert.equal(theme.palette.text.secondary, "#66717F");
  assert.equal(theme.palette.text.disabled, "#929AA4");
  assert.equal(theme.palette.porchlight.subtle, "#F2EFE8");
  assert.equal(theme.palette.porchlight.warm, "#FBF7EE");
  assert.equal(theme.palette.porchlight.borderStrong, "#D4CEC2");
  assert.equal(theme.palette.porchlight.amberSoft, "#F7E8CE");
  assert.equal(theme.palette.porchlight.amberGlow, "#FFBE57");
});

test("Inter font with the published type scale", () => {
  assert.match(theme.typography.fontFamily, /\bInter\b/);
  // H1 28/36 with a 24px mobile floor via clamp; Display 32/40.
  assert.equal(theme.typography.h1.lineHeight, "36px");
  assert.match(theme.typography.h1.fontSize, /^clamp\(/);
  assert.match(theme.typography.display.fontSize, /2rem\)$/);
  assert.equal(theme.typography.display.lineHeight, "40px");
  assert.equal(theme.typography.h2.lineHeight, "30px");
  assert.equal(theme.typography.h3.fontSize, "1.125rem"); // 18/26
  assert.equal(theme.typography.body1.fontSize, "0.9375rem"); // Body 15/23
  assert.equal(theme.typography.body1.lineHeight, "23px");
  assert.equal(theme.typography.bodyLarge.fontSize, "1.0625rem"); // 17/27
  assert.equal(theme.typography.bodyLarge.lineHeight, "27px");
  assert.equal(theme.typography.body2.fontSize, "0.875rem"); // 14/20
  assert.equal(theme.typography.body2.lineHeight, "20px");
  assert.equal(theme.typography.subtitle2.fontWeight, 600); // Label 13/18·600
  assert.equal(theme.typography.caption.fontSize, "0.75rem"); // Metadata 12/17
  assert.equal(theme.typography.caption.lineHeight, "17px");
});

test("shape, breakpoints, motion, and component tokens", () => {
  assert.equal(theme.shape.borderRadius, 10); // buttons + inputs
  assert.equal(theme.components.MuiCard.styleOverrides.root.borderRadius, 14); // cards
  assert.equal(theme.components.MuiDialog.styleOverrides.paper.borderRadius, 18); // modal
  assert.equal(theme.components.MuiOutlinedInput.styleOverrides.root.minHeight, 48); // front-door fields
  assert.equal(theme.components.MuiButton.defaultProps.color, "secondary"); // amber primary action
  assert.equal(theme.breakpoints.values.lg, 900); // desktop shell activates at 900
  assert.equal(theme.breakpoints.values.xl, 1280);
  assert.equal(theme.transitions.duration.standard, 180); // 140–220ms band
  assert.equal(theme.transitions.duration.enteringScreen, 220);
  assert.equal(theme.transitions.duration.short, 170);
  assert.equal(theme.transitions.easing.easeInOut, "cubic-bezier(.2,.8,.2,1)");
});

// PORCH-035 (Brian, Oct 14, 2026): inputs indicate focus with the stronger
// border alone — the theme-wide amber ring never reaches an input, so the
// orange additive border is gone from every text field, textarea, and select.
test("PORCH-035: amber ring survives on non-input focusables, never on inputs", () => {
  const overrides = theme.components.MuiCssBaseline.styleOverrides;
  // The ring rule itself is unchanged for buttons, links, tabs, chips…
  assert.equal(overrides["*:focus-visible"].boxShadow, "0 0 0 3px rgba(216,138,36,.28)");
  assert.equal(overrides["*:focus-visible"].outline, "2px solid transparent");
  // …and one theme-level exclusion covers every text-entry surface: text-ish
  // input types, textareas, native selects, and the MUI Select focus target
  // (div.MuiSelect-select is the element that receives focus inside an
  // outlined Select, not the wrapper input element).
  const excludeInputs = overrides[
    "input:not([type=checkbox]):not([type=radio]):not([type=button]):not([type=submit]):not([type=reset]):not([type=range]):not([type=color]):not([type=file]):focus-visible, textarea:focus-visible, select:focus-visible, .MuiSelect-select:focus-visible"
  ];
  assert.equal(excludeInputs.boxShadow, "none");
});

// ac-4 (PORCH-035): with no focus on any input, resting borders match the
// design tokens exactly and carry no residue from the focus fix.
test("PORCH-035: resting input borders are the token value", () => {
  const outlined = theme.components.MuiOutlinedInput.styleOverrides;
  assert.equal(outlined.notchedOutline.borderColor, "#E4E0D8"); // tokens.border
  assert.equal(outlined.root.minHeight, 48); // unchanged front-door height
});

// ac-2 (PORCH-035): one theme-level fix. No screen file may carry its own
// focus styling (focus-visible/:focus/Mui-focused) — the CssBaseline rule in
// theme.js is the single mechanism, so the orange ring cannot reappear on a
// screen nobody visited during the fix.
test("PORCH-035: focus styling exists only in the theme layer", async () => {
  const { readdir, readFile } = await import("node:fs/promises");
  const { join, dirname } = await import("node:path");
  const { fileURLToPath } = await import("node:url");
  const srcDir = join(dirname(fileURLToPath(new URL(import.meta.url))), "..", "src");
  const focusPattern = /focus-visible|:focus\b|Mui-focused/;
  for (const name of await readdir(srcDir)) {
    if (name === "theme.js") continue;
    const source = await readFile(join(srcDir, name), "utf8");
    assert.doesNotMatch(source, focusPattern, `${name} carries per-screen focus styling`);
  }
});
// ── PORCH-042 (Brian, Oct 14, 2026): light and dark modes — one token
// contract, two renderings; dark is the porch-lamp family, never generic. ──

import { themeFor, lightTokens as light, darkTokens as dark } from "../src/theme.js";

// ac-3: the dark surfaces are a warm charcoal-brown family. Warmth invariant:
// red ≥ green ≥ blue on every surface/border token — never neutral gray,
// never blue-shifted.
test("PORCH-042: the dark token set is the warm porch-lamp charcoal family, never gray or blue-shifted", () => {
  assert.equal(dark.page, "#17120E");
  assert.equal(dark.surface, "#221B16");
  assert.equal(dark.subtle, "#2A221C");
  assert.equal(dark.warm, "#241D18");
  assert.equal(dark.border, "#38302A");
  assert.equal(dark.borderStrong, "#453A32");
  const surfaces = [dark.page, dark.surface, dark.subtle, dark.warm, dark.border, dark.borderStrong];
  for (const hex of surfaces) {
    const r = parseInt(hex.slice(1, 3), 16), g = parseInt(hex.slice(3, 5), 16), b = parseInt(hex.slice(5, 7), 16);
    assert.ok(r > g && g > b, `${hex} must be warm (r > g > b), never neutral gray or blue-shifted`);
  }
  // Amber stays primary; ink on amber stays readable in both directions.
  assert.equal(dark.amber, "#E8A54F");
  assert.equal(dark.amberHover, "#F0B365");
  assert.equal(dark.amberSoft, "#3D2E1C");
  assert.equal(dark.amberGlow, "#FFBE57");
  assert.equal(dark.text.primary, "#F3EDE6");
  assert.equal(dark.text.secondary, "#B8AC9F");
  assert.equal(dark.text.inverse, "#17120E");
});

// ac-3: two token sets, one component code — the dark theme materializes
// from the same structure, with zero screen-level branching.
test("PORCH-042: the dark MUI theme is a rendering of the same token contract", () => {
  const darkTheme = themeFor("dark");
  assert.equal(darkTheme.palette.mode, "dark");
  assert.equal(darkTheme.palette.background.default, dark.page);
  assert.equal(darkTheme.palette.background.paper, dark.surface);
  assert.equal(darkTheme.palette.text.primary, dark.text.primary);
  assert.equal(darkTheme.palette.text.secondary, dark.text.secondary);
  assert.equal(darkTheme.palette.divider, dark.border);
  assert.equal(darkTheme.palette.secondary.main, dark.amber);
  assert.equal(darkTheme.palette.secondary.dark, dark.amberHover);
  // Brand weight rides warm light text: the navy ink of light mode retires.
  assert.equal(darkTheme.palette.primary.main, dark.text.primary);
  assert.equal(darkTheme.palette.porchlight.amberSoft, dark.amberSoft);
  // One component code: identical structural surface, no mode forks.
  assert.deepEqual(Object.keys(themeFor("light")), Object.keys(darkTheme));
  assert.deepEqual(Object.keys(themeFor("light").components), Object.keys(darkTheme.components));
  assert.equal(JSON.stringify(themeFor("light").typography), JSON.stringify(darkTheme.typography));
  assert.equal(JSON.stringify(themeFor("light").breakpoints), JSON.stringify(darkTheme.breakpoints));
  // Memoized: switches swap one prebuilt theme, first paint stays cheap.
  assert.equal(themeFor("dark"), darkTheme);
  // The light set is untouched by the mode system (PORCH-022 pins stay valid).
  assert.equal(theme.palette.background.default, light.page);
  assert.equal(theme.palette.primary.main, light.navy);
});

// ac-4: WCAG 2.2 AA contrast audit across both modes. Amber action and state
// colors on dark are checked explicitly (amber text actions are 14px/600 —
// regular text, so 4.5:1 applies, not the 3:1 large-text floor).
function luminance(hex) {
  const channels = [hex.slice(1, 3), hex.slice(3, 5), hex.slice(5, 7)].map((c) => {
    const v = parseInt(c, 16) / 255;
    return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
}
function contrast(a, b) {
  const la = luminance(a), lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

// Calibration of record (PORCH-042): dark textMuted moved #867B6F → #9A8E81
// because the proposed value reached only ~4.1:1 on the card surface
// (#221B16); the raised value passes 4.5:1 on page, surface, subtle, warm.
test("PORCH-042: dark text tiers and amber actions pass WCAG 2.2 AA on every dark surface", () => {
  const surfaces = [dark.page, dark.surface, dark.subtle, dark.warm];
  for (const surface of surfaces) {
    assert.ok(contrast(dark.text.primary, surface) >= 4.5, `text primary on ${surface}`);
    assert.ok(contrast(dark.text.secondary, surface) >= 4.5, `text secondary on ${surface}`);
    assert.ok(contrast(dark.text.muted, surface) >= 4.5, `text muted on ${surface}`);
    assert.ok(contrast(dark.amber, surface) >= 4.5, `amber action text on ${surface}`);
    assert.ok(contrast(dark.text.inverse, dark.amber) >= 4.5, `ink on amber (${dark.text.inverse})`);
  }
  // Lamp-glow accents (large/soft glow surfaces only) hold the 3:1 floor.
  assert.ok(contrast(dark.amberGlow, dark.surface) >= 3, "amber glow on dark surface");
});

// PORCH-042 must not fork the light set (its palette pins are PORCH-022's
// regression surface), so the light audit here pins exactly what the mode
// system depends on: the theme materializes the unchanged light tokens and
// the ink-on-amber pairings still hold. Contrast deficiencies inside the
// pinned light set (muted/disabled tier, amber-on-page ~2.5:1,
// secondary-on-subtle ~4.3:1) are PORCH-022 ship states outside this scope.
test("PORCH-042: the light set is materialized unchanged and its ink-on-amber pairings hold", () => {
  assert.equal(theme.palette.mode, "light");
  assert.equal(theme.palette.background.default, light.page);
  assert.ok(contrast(light.navy, light.amber) >= 4.5, "navy ink on amber");
  assert.ok(contrast(light.text.primary, light.amberSoft) >= 4.5, "navy text on amber-soft chips");
  assert.ok(contrast(light.text.primary, light.page) >= 4.5, "text primary on the warm page");
  assert.ok(contrast(light.text.secondary, light.page) >= 4.5, "text secondary on the warm page");
});

// ac-3 guardrail: components consume custom properties only — screen code
// carries no literal color values. theme.js is the token layer and mode.js
// is storage-only; index.html is the pre-paint script whose two page hexes
// must equal the token sets (pinned in display-modes.test.js).
test("PORCH-042: no screen file carries a literal color or a mode branch", async () => {
  const { readdir, readFile } = await import("node:fs/promises");
  const { join, dirname } = await import("node:path");
  const { fileURLToPath } = await import("node:url");
  const srcDir = join(dirname(fileURLToPath(new URL(import.meta.url))), "..", "src");
  const colorPattern = /#[0-9a-fA-F]{3,8}\b|rgba?\(|\.css/i;
  const branchPattern = /data-theme|prefers-color-scheme|matchMedia/;
  // main.jsx is the switching machinery (it subscribes to the device
  // preference), not a screen: the no-branch rule governs screen files.
  const machinery = new Set(["theme.js", "mode.js", "main.jsx"]);
  for (const name of await readdir(srcDir)) {
    if (machinery.has(name)) continue;
    const source = await readFile(join(srcDir, name), "utf8");
    assert.doesNotMatch(source, colorPattern, `${name} carries a literal color (tokens/consume custom properties)`);
    assert.doesNotMatch(source, branchPattern, `${name} branches on display mode (two token sets, one component code)`);
  }
});
