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