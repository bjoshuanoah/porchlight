import { createTheme } from "@mui/material/styles";

// Porchlight design tokens — one token contract, two renderings (PORCH-042).
//
// Light set: normative values from the UI Implementation Specification v1
// (Oct 9, 2026, amended Oct 14, 2026, PORCH-I-003 tech spec §3 "UI
// Implementation Standard: Design Tokens, Shell, and Screens"). Shipped under
// PORCH-022; its palette pins stay authoritative and are unchanged here.
//
// Dark set: the porch-lamp family from the "Display Modes" build contract
// (tech spec §6, Oct 14, 2026) — warm charcoal-brown surfaces, warm light
// text, amber as the primary action, lamp-glow accents sparing. Marked
// "proposed, calibrate against WCAG 2.2 AA at build"; the calibration
// applied at build: textMuted raised #867B6F → #9A8E81 to pass AA 4.5:1 on
// every dark surface (the proposed value reached only ~4.5:1 on the page and
// ~4.1:1 once on the card surface). No other value moved. Warmth invariant:
// every dark surface token satisfies red ≥ green ≥ blue (never neutral gray,
// never blue-shifted).
export const lightTokens = {
  page: "#F7F5F0",
  surface: "#FFFFFF",
  subtle: "#F2EFE8",
  warm: "#FBF7EE",
  border: "#E4E0D8",
  borderStrong: "#D4CEC2",
  text: { primary: "#122033", secondary: "#66717F", muted: "#929AA4", inverse: "#FFFFFF" },
  navy: "#10243A",
  amber: "#D88A24",
  amberHover: "#C87918",
  amberSoft: "#F7E8CE",
  amberGlow: "#FFBE57",
  timelineDivider: "#ECE8E1",
  shadowCard: "0 1px 2px rgba(18,32,51,.05), 0 4px 14px rgba(18,32,51,.04)",
  shadowModal: "0 20px 60px rgba(18,32,51,.18)",
  shadowCompose: "0 6px 18px rgba(216,138,36,.28)",
  appbarBg: "rgba(255,255,255,.96)",
  lampGlow: "rgba(255,190,87,.45)",
  lampGlowSoft: "rgba(255,190,87,.35)",
  // Ink that sits on amber fills (compose circle, current-step): navy in
  // light, the dark ink in dark — verified ≥4.5:1 against both ambers.
  amberInk: "#10243A",
};

export const darkTokens = {
  page: "#17120E",
  surface: "#221B16",
  subtle: "#2A221C",
  warm: "#241D18",
  border: "#38302A",
  borderStrong: "#453A32",
  text: { primary: "#F3EDE6", secondary: "#B8AC9F", muted: "#9A8E81", inverse: "#17120E" },
  // The navy ink of light mode retires in dark; brand weight rides the warm
  // light text (build contract: "brand weight rides warm light text").
  navy: "#F3EDE6",
  amber: "#E8A54F",
  amberHover: "#F0B365",
  amberSoft: "#3D2E1C",
  amberGlow: "#FFBE57",
  timelineDivider: "#38302A",
  shadowCard: "0 1px 2px rgba(0,0,0,.4), 0 4px 14px rgba(0,0,0,.28)",
  shadowModal: "0 20px 60px rgba(0,0,0,.5)",
  shadowCompose: "0 6px 18px rgba(232,165,79,.30)",
  appbarBg: "rgba(23,18,14,.96)",
  lampGlow: "rgba(255,190,87,.32)",
  lampGlowSoft: "rgba(255,190,87,.22)",
  amberInk: "#17120E",
};

// Back-compat alias: the Oct 9 light set (the existing `tokens` import
// surface stays the light set; screens consume `cssVars` below).
export const tokens = lightTokens;

const fontFamily = 'Inter, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';

// Motion: 140–220ms on one gentle easing curve; reduced-motion resets in
// MuiCssBaseline below. Banned motion (bounce, confetti, reward pulses)
// never enters the app because nothing here uses such effects.
const motion = {
  ease: "cubic-bezier(.2,.8,.2,1)",
  min: 140,
  base: 180,
  entering: 220,
};

// Mode-independent half of the theme: the Oct 9 type scale, spacing shape,
// breakpoints, and transitions are identical for both modes.
const themeBase = {
  typography: {
    fontFamily,
    // clamp slopes reach the desktop size by the 900px shell breakpoint and
    // never dip below the mobile minimum (Display 24/40, H1 24, H2 20).
    display: { fontSize: "clamp(1.5rem, 1rem + 1.25vw, 2rem)", lineHeight: "40px", fontWeight: 650 },
    h1: { fontSize: "clamp(1.5rem, 1rem + 1.06vw, 1.75rem)", lineHeight: "36px", fontWeight: 650 },
    h2: { fontSize: "clamp(1.25rem, 1.05rem + 0.63vw, 1.375rem)", lineHeight: "30px", fontWeight: 650 },
    h3: { fontSize: "1.125rem", lineHeight: "26px", fontWeight: 650 },
    h4: { fontSize: "1.125rem", lineHeight: "26px", fontWeight: 650 },
    h5: { fontSize: "1rem", lineHeight: "24px", fontWeight: 650 },
    h6: { fontSize: "1rem", lineHeight: "22px", fontWeight: 650 },
    subtitle1: { fontSize: "0.9375rem", lineHeight: "23px" },
    subtitle2: { fontSize: "0.8125rem", lineHeight: "18px", fontWeight: 600 },
    bodyLarge: { fontSize: "1.0625rem", lineHeight: "27px" },
    body1: { fontSize: "0.9375rem", lineHeight: "23px" },
    body2: { fontSize: "0.875rem", lineHeight: "20px" },
    caption: { fontSize: "0.75rem", lineHeight: "17px" },
    button: { fontSize: "0.9375rem", lineHeight: "20px", fontWeight: 600, textTransform: "none" },
  },
  shape: { borderRadius: 10 },
  breakpoints: { values: { xs: 0, sm: 480, md: 768, lg: 900, xl: 1280 } },
  transitions: {
    duration: { shortest: motion.min, shorter: motion.min, short: 170, standard: motion.base, complex: motion.base, enteringScreen: motion.entering },
    easing: { easeInOut: motion.ease, easeOut: motion.ease, easeIn: motion.ease, sharp: motion.ease },
  },
};

function paletteFor(tokens) {
  const dark = tokens === darkTokens;
  return {
    mode: dark ? "dark" : "light",
    // Primary is the brand/identity color: navy in light; in dark the navy
    // ink retires and brand weight rides the warm light text.
    primary: { main: tokens.navy, contrastText: dark ? tokens.text.inverse : "#FFFFFF" },
    // Amber stays the primary action color in both modes; the hover step
    // darkens in light and lifts in dark (darkTokens.amberHover #F0B365).
    secondary: { main: tokens.amber, dark: tokens.amberHover, light: tokens.amberGlow, contrastText: tokens.text.inverse },
    background: { default: tokens.page, paper: tokens.surface },
    text: { primary: tokens.text.primary, secondary: tokens.text.secondary, disabled: tokens.text.muted },
    divider: tokens.border,
    porchlight: {
      page: tokens.page, subtle: tokens.subtle, warm: tokens.warm,
      border: tokens.border, borderStrong: tokens.borderStrong,
      muted: tokens.text.muted, amberSoft: tokens.amberSoft, amberGlow: tokens.amberGlow,
    },
  };
}

function componentsFor(tokens) {
  return {
    // Primary actions are amber by default; navy stays the typography and
    // identity color. Contained buttons carry the amber hover automatically
    // (secondary.dark = tokens.amberHover).
    MuiButton: {
      defaultProps: { color: "secondary" },
      styleOverrides: {
        root: { borderRadius: 10, minHeight: 44, textTransform: "none", fontWeight: 600, transitionDuration: `${motion.base}ms`, transitionTimingFunction: motion.ease },
        sizeSmall: { minHeight: 36 },
      },
    },
    MuiIconButton: {
      styleOverrides: { root: { width: 44, height: 44, padding: 10, flexShrink: 0, transitionDuration: `${motion.base}ms`, transitionTimingFunction: motion.ease } },
    },
    MuiCard: {
      styleOverrides: { root: { border: `1px solid ${tokens.border}`, borderRadius: 14, boxShadow: tokens.shadowCard } },
    },
    MuiDialog: {
      styleOverrides: { paper: { borderRadius: 18, boxShadow: tokens.shadowModal } },
    },
    MuiTextField: { defaultProps: { variant: "outlined" } },
    // PORCH-043 (Brian, Oct 14, 2026): the viewport locks (user-scalable=no),
    // so involuntary iOS focus zoom is starved structurally instead: every
    // text-entry control (composer, search, reply composer, PIN entry) keeps
    // a computed font-size ≥ 16px. inputs, multiline textareas, and the MUI
    // Select focus target all ride the .MuiInputBase-input class.
    MuiInputBase: {
      styleOverrides: {
        input: { fontSize: "1rem" },
      },
    },
    // Front-door fields are 48px tall (spec: owner bootstrap and member join).
    // PORCH-035: resting input borders carry the token value with no residue
    // from the focus fix — focus is MUI's neutral stronger border on the same
    // notched outline, nothing additive, in both modes.
    MuiOutlinedInput: {
      styleOverrides: {
        root: { minHeight: 48 },
        notchedOutline: { borderColor: tokens.border },
      },
    },
    MuiAvatar: {
      styleOverrides: { root: { backgroundColor: tokens.amberSoft, color: tokens.navy, fontWeight: 600 } },
    },
    MuiChip: {
      styleOverrides: { root: { fontWeight: 600, transitionDuration: `${motion.min}ms` } },
    },
    // Mobile tab bar: 24px icons over 11px labels, 44px minimum targets —
    // the root selector keeps the selected tab at the same 11px token.
    MuiBottomNavigationAction: {
      styleOverrides: {
        root: {
          minWidth: 44,
          "& .MuiBottomNavigationAction-label": { fontSize: "0.6875rem", lineHeight: "13px", letterSpacing: 0 },
          "&.Mui-selected .MuiBottomNavigationAction-label": { fontSize: "0.6875rem", lineHeight: "13px", letterSpacing: 0 },
        },
      },
    },
    MuiCssBaseline: {
      styleOverrides: {
        body: { backgroundColor: tokens.page },
        // PORCH-035 (Brian, Oct 14, 2026): the amber focus ring serves keyboard
        // wayfinding on non-input focusables only (buttons, links, tabs, chips).
        // Inputs and textareas indicate focus with MUI's stronger border alone —
        // the ring below never reaches an input element, and this is the only
        // focus rule in the app: no per-screen patch can reintroduce it.
        // PORCH-042: the ring alpha calibrates per mode (dark lifts from the
        // light alphas so the ring stays visible on charcoal surfaces).
        "*:focus-visible": {
          outline: "2px solid transparent",
          boxShadow: tokens === lightTokens ? "0 0 0 3px rgba(216,138,36,.28)" : "0 0 0 3px rgba(232,165,79,.32)",
        },
        // Text-entry surfaces only: text inputs of every text-ish type, textareas,
        // native selects, and the MUI Select focus target (div.MuiSelect-select,
        // the element that actually receives focus inside an outlined Select).
        // checkbox/radio/button/file inputs stay on the ring — they have no
        // stronger-border counterpart, so removing the ring there would strip
        // their only focus indicator.
        "input:not([type=checkbox]):not([type=radio]):not([type=button]):not([type=submit]):not([type=reset]):not([type=range]):not([type=color]):not([type=file]):focus-visible, textarea:focus-visible, select:focus-visible, .MuiSelect-select:focus-visible": {
          boxShadow: "none",
        },
        "@media (prefers-reduced-motion: reduce)": {
          "*, *::before, *::after": { animationDuration: "0.01ms !important", transitionDuration: "0.01ms !important" },
        },
      },
    },
  };
}

// One component code, two token sets: `themeFor(displayMode)` materializes
// the MUI theme per mode from the same token source; neither mode forks the
// structure. Memoized — a mode switch swaps a prebuilt theme in one render.
const themes = {};
export function themeFor(displayMode) {
  const key = displayMode === "dark" ? "dark" : "light";
  if (!themes[key]) {
    const set = key === "dark" ? darkTokens : lightTokens;
    themes[key] = createTheme({ ...themeBase, palette: paletteFor(set), components: componentsFor(set) });
  }
  return themes[key];
}

// The Oct 9 normative light theme (PORCH-022; its palette pins stay valid).
export const theme = themeFor("light");

// CSS custom properties — the surface screen code consumes (build contract:
// "components consume CSS custom properties only; no literal color values in
// screen code"). Both sets are declared in one static <style> block, resolved
// by html[data-theme], so a mode switch needs no CSS rewrite and no screen
// ever branches on mode.
const CSS_VAR_NAMES = [
  ["page", "page"], ["surface", "surface"], ["subtle", "subtle"], ["warm", "warm"],
  ["border", "border"], ["borderStrong", "border-strong"],
  ["textPrimary", "text-primary"], ["textSecondary", "text-secondary"],
  ["textMuted", "text-muted"], ["textInverse", "text-inverse"],
  ["amber", "amber"], ["amberHover", "amber-hover"], ["amberSoft", "amber-soft"], ["amberGlow", "amber-glow"],
  ["timelineDivider", "timeline-divider"],
  ["shadowCard", "shadow-card"], ["shadowModal", "shadow-modal"], ["shadowCompose", "shadow-compose"],
  ["appbarBg", "appbar-bg"], ["lampGlow", "lamp-glow"], ["lampGlowSoft", "lamp-glow-soft"],
  ["amberInk", "amber-ink"],
];

// Screen-facing token map: camelCase keys matching the token sets, values as
// custom-property references.
export const cssVars = Object.fromEntries(
  CSS_VAR_NAMES.map(([key, name]) => [key, `var(--porch-${name})`]),
);

function flatten(tokens) {
  return { ...tokens, textPrimary: tokens.text.primary, textSecondary: tokens.text.secondary, textMuted: tokens.text.muted, textInverse: tokens.text.inverse };
}

function declarations(tokens) {
  return CSS_VAR_NAMES.map(([key, name]) => `--porch-${name}:${tokens[key]};`).join("");
}

// Light block sits first (with the :root default), dark second: an
// html[data-theme="dark"] element matches both selectors and the later dark
// block wins, so the document always resolves the active mode from the
// pre-paint attribute alone.
export function tokenStyles() {
  return `:root,[data-theme="light"]{${declarations(flatten(lightTokens))}}`
    + `[data-theme="dark"]{${declarations(flatten(darkTokens))}}`;
}