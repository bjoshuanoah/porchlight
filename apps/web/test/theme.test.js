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