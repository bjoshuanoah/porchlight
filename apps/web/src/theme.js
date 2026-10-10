import { createTheme } from "@mui/material/styles";

// Porchlight design tokens — normative values from the UI Implementation
// Specification v1 (Oct 9, 2026, amended Oct 14, 2026, PORCH-I-003 tech spec
// §3 "UI Implementation Standard: Design Tokens, Shell, and Screens").
// Warm page, navy typography, amber as the single accent of warmth and
// primary action — never the dominant page color.
export const tokens = {
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
};

// Motion: 140–220ms on one gentle easing curve; reduced-motion resets in
// MuiCssBaseline below. Banned motion (bounce, confetti, reward pulses)
// never enters the app because nothing here uses such effects.
const motion = {
  ease: "cubic-bezier(.2,.8,.2,1)",
  min: 140,
  base: 180,
  entering: 220,
};

// Inter is the application font. Scale is px/line-height/weight pairs from
// the specification; mobile minimums ride clamp() so small screens never
// dip below the published floor (H1 24, H2 20, Body 15).
const fontFamily = 'Inter, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';

export const theme = createTheme({
  palette: {
    mode: "light",
    primary: { main: tokens.navy, contrastText: "#FFFFFF" },
    secondary: { main: tokens.amber, dark: tokens.amberHover, light: tokens.amberGlow, contrastText: tokens.text.primary },
    background: { default: tokens.page, paper: tokens.surface },
    text: { primary: tokens.text.primary, secondary: tokens.text.secondary, disabled: tokens.text.muted },
    divider: tokens.border,
    porchlight: {
      page: tokens.page, subtle: tokens.subtle, warm: tokens.warm,
      border: tokens.border, borderStrong: tokens.borderStrong,
      muted: tokens.text.muted, amberSoft: tokens.amberSoft, amberGlow: tokens.amberGlow,
    },
  },
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
  components: {
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
      styleOverrides: { root: { border: `1px solid ${tokens.border}`, borderRadius: 14, boxShadow: "0 1px 2px rgba(18,32,51,.05), 0 4px 14px rgba(18,32,51,.04)" } },
    },
    MuiDialog: {
      styleOverrides: { paper: { borderRadius: 18, boxShadow: "0 20px 60px rgba(18,32,51,.18)" } },
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
    // PORCH-035: resting input borders carry the token value (#E4E0D8) with no
    // residue from the focus fix — focus is MUI's neutral stronger border on
    // the same notched outline, nothing additive.
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
        "*:focus-visible": {
          outline: "2px solid transparent",
          boxShadow: "0 0 0 3px rgba(216,138,36,.28)",
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
  },
});