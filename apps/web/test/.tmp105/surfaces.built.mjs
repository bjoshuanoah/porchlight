// src/photo-viewer.jsx
import React, { useCallback, useEffect, useRef, useState } from "react";
import { Alert, Box, Button, IconButton, Stack, Typography } from "@mui/material";
import { CloseOutlined, OpenInFullOutlined, PhotoLibraryOutlined, ShareOutlined } from "@mui/icons-material";

// src/theme.js
import { createTheme } from "@mui/material/styles";
var bootTokens = {
  bootBg: "#0B1622",
  bootInk: "#FCFAE8",
  bootStatusInk: "#B3A48B",
  // PORCH-119: the dusk scene's light layers — mode-invariant scene paint
  // (the brand amber family on the navy canvas), riding the token layer
  // like every other boot value. The static pre-JS canvas (index.html)
  // carries the same literals only as fallback-only var() values (it must
  // paint before JS, so its custom properties resolve late); the React
  // layer consumes the properties bare — screens carry no literal color.
  bootDuskHalo: "radial-gradient(circle closest-side, rgba(255,190,87,.30) 0%, rgba(255,190,87,.12) 42%, rgba(255,190,87,0) 70%)",
  bootDuskGlow: "radial-gradient(closest-side, rgba(255,190,87,.26) 0%, rgba(255,190,87,.09) 55%, rgba(255,190,87,0) 78%)",
  bootDuskMote: "radial-gradient(circle at 40% 40%, #FFF6D8 0%, #FFE2B0 40%, #FFBE57 75%, rgba(255,190,87,0) 100%)",
  bootDuskSparkGlow: "0 0 6px 2px rgba(255,226,176,.75), 0 0 18px 5px rgba(255,190,87,.28)",
  bootDuskEdge: "rgba(255,190,87,.65)",
  bootDuskHover: "rgba(255,190,87,.12)"
};
var lightTokens = {
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
  // Vote arrows (PORCH-104, second round, Brian Oct 19, 2026): green for
  // Lift, red for Lower, shown on hover or when the viewer has taken that
  // action — per-mode values picked for contrast on the mode's own surface;
  // the resting arrow keeps the action bar's default ink.
  voteUp: "#2E7D32",
  voteDown: "#B3261E",
  timelineDivider: "#ECE8E1",
  shadowCard: "0 1px 2px rgba(18,32,51,.05), 0 4px 14px rgba(18,32,51,.04)",
  shadowModal: "0 20px 60px rgba(18,32,51,.18)",
  shadowCompose: "0 6px 18px rgba(216,138,36,.28)",
  // PORCH-144: the mobile composer sheet tokens — the flush sheet's upward
  // shadow lifts from the page; the staged-media scrim and its ink sit over
  // photo/video previews (remove control, play glyph, duration chip).
  shadowSheet: "0 -8px 40px rgba(16,36,58,.26)",
  // PORCH-144: the desktop composer modal's backdrop scrim (the prior
  // desktop contract's token set) — dim over the page, ≤4px blur.
  composeBackdrop: "rgba(10,20,32,.48)",
  mediaOverlay: "rgba(16,36,58,.72)",
  mediaOverlayHover: "rgba(16,36,58,.88)",
  mediaOverlayInk: "#FFFFFF",
  appbarBg: "rgba(255,255,255,.96)",
  lampGlow: "rgba(255,190,87,.45)",
  lampGlowSoft: "rgba(255,190,87,.35)",
  // Ink that sits on amber fills (compose circle, current-step): navy in
  // light, the dark ink in dark — verified ≥4.5:1 against both ambers.
  amberInk: "#10243A",
  ...bootTokens
};
var darkTokens = {
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
  // Lifted steps of the same two arrow accents (contrast on charcoal).
  voteUp: "#81C784",
  voteDown: "#E57373",
  timelineDivider: "#38302A",
  shadowCard: "0 1px 2px rgba(0,0,0,.4), 0 4px 14px rgba(0,0,0,.28)",
  shadowModal: "0 20px 60px rgba(0,0,0,.5)",
  shadowCompose: "0 6px 18px rgba(232,165,79,.30)",
  // PORCH-144: the sheet's dark steps stay in the warm family — the scrim
  // rides the mode's own charcoal ink, never a cold gray.
  shadowSheet: "0 -8px 40px rgba(0,0,0,.45)",
  // PORCH-144: the desktop modal's backdrop scrim — the mode's own warm
  // charcoal deepening the dim, never a cold gray.
  composeBackdrop: "rgba(23,18,14,.6)",
  mediaOverlay: "rgba(23,18,14,.72)",
  mediaOverlayHover: "rgba(23,18,14,.88)",
  mediaOverlayInk: "#F3EDE6",
  appbarBg: "rgba(23,18,14,.96)",
  lampGlow: "rgba(255,190,87,.32)",
  lampGlowSoft: "rgba(255,190,87,.22)",
  amberInk: "#17120E",
  ...bootTokens
};
var fontFamily = 'Inter, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
var motion = {
  ease: "cubic-bezier(.2,.8,.2,1)",
  min: 140,
  base: 180,
  entering: 220
};
var themeBase = {
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
    button: { fontSize: "0.9375rem", lineHeight: "20px", fontWeight: 600, textTransform: "none" }
  },
  shape: { borderRadius: 10 },
  breakpoints: { values: { xs: 0, sm: 480, md: 768, lg: 900, xl: 1280 } },
  transitions: {
    duration: { shortest: motion.min, shorter: motion.min, short: 170, standard: motion.base, complex: motion.base, enteringScreen: motion.entering },
    easing: { easeInOut: motion.ease, easeOut: motion.ease, easeIn: motion.ease, sharp: motion.ease }
  }
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
      page: tokens.page,
      subtle: tokens.subtle,
      warm: tokens.warm,
      border: tokens.border,
      borderStrong: tokens.borderStrong,
      muted: tokens.text.muted,
      amberSoft: tokens.amberSoft,
      amberGlow: tokens.amberGlow,
      voteUp: tokens.voteUp,
      voteDown: tokens.voteDown
    }
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
        sizeSmall: { minHeight: 36 }
      }
    },
    MuiIconButton: {
      styleOverrides: { root: { width: 44, height: 44, padding: 10, flexShrink: 0, transitionDuration: `${motion.base}ms`, transitionTimingFunction: motion.ease } }
    },
    MuiCard: {
      styleOverrides: { root: { border: `1px solid ${tokens.border}`, borderRadius: 14, boxShadow: tokens.shadowCard } }
    },
    MuiDialog: {
      styleOverrides: { paper: { borderRadius: 18, boxShadow: tokens.shadowModal } }
    },
    MuiTextField: { defaultProps: { variant: "outlined" } },
    // PORCH-043 (Brian, Oct 14, 2026): the viewport locks (user-scalable=no),
    // so involuntary iOS focus zoom is starved structurally instead: every
    // text-entry control (composer, search, reply composer, PIN entry) keeps
    // a computed font-size ≥ 16px. inputs, multiline textareas, and the MUI
    // Select focus target all ride the .MuiInputBase-input class.
    MuiInputBase: {
      styleOverrides: {
        input: { fontSize: "1rem" }
      }
    },
    // Front-door fields are 48px tall (spec: owner bootstrap and member join).
    // PORCH-035: resting input borders carry the token value with no residue
    // from the focus fix — focus is MUI's neutral stronger border on the same
    // notched outline, nothing additive, in both modes.
    MuiOutlinedInput: {
      styleOverrides: {
        root: { minHeight: 48 },
        notchedOutline: { borderColor: tokens.border }
      }
    },
    MuiAvatar: {
      styleOverrides: { root: { backgroundColor: tokens.amberSoft, color: tokens.navy, fontWeight: 600 } }
    },
    MuiChip: {
      styleOverrides: { root: { fontWeight: 600, transitionDuration: `${motion.min}ms` } }
    },
    // Mobile tab bar: 24px icons over 11px labels, 44px minimum targets —
    // the root selector keeps the selected tab at the same 11px token.
    MuiBottomNavigationAction: {
      styleOverrides: {
        root: {
          minWidth: 44,
          "& .MuiBottomNavigationAction-label": { fontSize: "0.6875rem", lineHeight: "13px", letterSpacing: 0 },
          "&.Mui-selected .MuiBottomNavigationAction-label": { fontSize: "0.6875rem", lineHeight: "13px", letterSpacing: 0 }
        }
      }
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
          boxShadow: tokens === lightTokens ? "0 0 0 3px rgba(216,138,36,.28)" : "0 0 0 3px rgba(232,165,79,.32)"
        },
        // Text-entry surfaces only: text inputs of every text-ish type, textareas,
        // native selects, and the MUI Select focus target (div.MuiSelect-select,
        // the element that actually receives focus inside an outlined Select).
        // checkbox/radio/button/file inputs stay on the ring — they have no
        // stronger-border counterpart, so removing the ring there would strip
        // their only focus indicator.
        "input:not([type=checkbox]):not([type=radio]):not([type=button]):not([type=submit]):not([type=reset]):not([type=range]):not([type=color]):not([type=file]):focus-visible, textarea:focus-visible, select:focus-visible, .MuiSelect-select:focus-visible": {
          boxShadow: "none"
        },
        "@media (prefers-reduced-motion: reduce)": {
          "*, *::before, *::after": { animationDuration: "0.01ms !important", transitionDuration: "0.01ms !important" }
        }
      }
    }
  };
}
var themes = {};
function themeFor(displayMode) {
  const key = displayMode === "dark" ? "dark" : "light";
  if (!themes[key]) {
    const set = key === "dark" ? darkTokens : lightTokens;
    themes[key] = createTheme({ ...themeBase, palette: paletteFor(set), components: componentsFor(set) });
  }
  return themes[key];
}
var theme = themeFor("light");
var CSS_VAR_NAMES = [
  ["page", "page"],
  ["surface", "surface"],
  ["subtle", "subtle"],
  ["warm", "warm"],
  ["border", "border"],
  ["borderStrong", "border-strong"],
  ["textPrimary", "text-primary"],
  ["textSecondary", "text-secondary"],
  ["textMuted", "text-muted"],
  ["textInverse", "text-inverse"],
  ["amber", "amber"],
  ["amberHover", "amber-hover"],
  ["amberSoft", "amber-soft"],
  ["amberGlow", "amber-glow"],
  ["voteUp", "vote-up"],
  ["voteDown", "vote-down"],
  ["timelineDivider", "timeline-divider"],
  ["shadowCard", "shadow-card"],
  ["shadowModal", "shadow-modal"],
  ["shadowCompose", "shadow-compose"],
  ["shadowSheet", "shadow-sheet"],
  ["composeBackdrop", "compose-backdrop"],
  ["mediaOverlay", "media-overlay"],
  ["mediaOverlayHover", "media-overlay-hover"],
  ["mediaOverlayInk", "media-overlay-ink"],
  ["appbarBg", "appbar-bg"],
  ["lampGlow", "lamp-glow"],
  ["lampGlowSoft", "lamp-glow-soft"],
  ["amberInk", "amber-ink"],
  // PORCH-095: the boot's mode-invariant brand palette (one navy canvas,
  // both modes) — declared in both blocks, so the boot surfaces consume
  // custom properties like every other screen.
  ["bootBg", "boot-bg"],
  ["bootInk", "boot-ink"],
  ["bootStatusInk", "boot-status-ink"],
  // PORCH-119: scene paint (halo, floor glow, glowing particle heads,
  // retry edge and hover) lives in the token layer.
  ["bootDuskHalo", "boot-dusk-halo"],
  ["bootDuskGlow", "boot-dusk-glow"],
  ["bootDuskMote", "boot-dusk-mote"],
  ["bootDuskSparkGlow", "boot-dusk-spark-glow"],
  ["bootDuskEdge", "boot-dusk-edge"],
  ["bootDuskHover", "boot-dusk-hover"]
];
var cssVars = Object.fromEntries(
  CSS_VAR_NAMES.map(([key, name]) => [key, `var(--porch-${name})`])
);
function tokenAlpha(hex, alpha) {
  const value = String(hex).replace("#", "");
  return `rgba(${parseInt(value.slice(0, 2), 16)}, ${parseInt(value.slice(2, 4), 16)}, ${parseInt(value.slice(4, 6), 16)}, ${alpha})`;
}

// src/photo-first.js
var PORTRAIT_EXTENT = 3 / 4;
var photoFirst = {
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
  // The old mobile inter-post divider is retired. This warm-neutral token
  // now separates the post's controls from its in-feed conversation.
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
  // Header→caption 8–12; caption→media 12; media→actions 8–16;
  // actions→rendered reactions 12; reactions→replies divider 12;
  // divider→first comment 8–12.
  spacing: {
    headerCaption: 8,
    captionMedia: 12,
    mediaUtility: 8,
    utilityActions: 16,
    actionsReactions: 12,
    reactionsSlice: 12,
    endToDivider: 16
  }
};

// src/install.js
var INSTALL_USAGE_GATE_MS = 2 * 60 * 1e3;
var INSTALL_SUPPRESSION_MS = 14 * 24 * 60 * 60 * 1e3;

// src/photo-viewer.js
var viewerTokens = {
  page: darkTokens.page,
  surface: darkTokens.surface,
  subtle: darkTokens.subtle,
  border: darkTokens.border,
  text: darkTokens.text.primary,
  textSecondary: darkTokens.text.secondary,
  amber: darkTokens.amber,
  amberHover: darkTokens.amberHover,
  amberInk: darkTokens.amberInk,
  scrim: tokenAlpha(darkTokens.page, 0.55),
  backdropBlur: "blur(10px)"
};
var motion2 = { ease: "cubic-bezier(.2,.8,.2,1)", base: 180 };
var FADE_MS = motion2.base;

// src/photo-viewer.jsx
import { Fragment, jsx, jsxs } from "react/jsx-runtime";
function fade() {
  return {
    transition: `opacity ${FADE_MS}ms ${motion2.ease}`,
    "@media (prefers-reduced-motion: reduce)": { transition: "opacity 0ms linear" }
  };
}
var settleSx = {
  transition: `transform ${FADE_MS}ms ${motion2.ease}`,
  "@media (prefers-reduced-motion: reduce)": { transition: "transform 0ms linear" }
};
function MediaOverlay({ shown, onDownload, onExpand, downloadBusy = false, shareAction = null }) {
  return /* @__PURE__ */ jsxs(
    Stack,
    {
      "aria-label": "Media overlay",
      onClick: (event) => event.stopPropagation(),
      onTouchStart: (event) => event.stopPropagation(),
      onPointerDown: (event) => event.stopPropagation(),
      direction: "row",
      spacing: 0.25,
      alignItems: "center",
      sx: {
        position: "absolute",
        top: 8,
        right: 8,
        zIndex: 2,
        bgcolor: viewerTokens.scrim,
        backdropFilter: viewerTokens.backdropBlur,
        WebkitBackdropFilter: viewerTokens.backdropBlur,
        borderRadius: 9999,
        px: 0.75,
        py: 0.25,
        opacity: shown ? 1 : 0,
        pointerEvents: shown ? "auto" : "none",
        ...fade()
      },
      children: [
        shareAction ? /* @__PURE__ */ jsxs(
          Button,
          {
            size: "small",
            disabled: shareAction.busy,
            onClick: shareAction.run,
            sx: { px: 0.75, minWidth: 0, fontSize: 14, fontWeight: 600, color: viewerTokens.text },
            children: [
              /* @__PURE__ */ jsx(ShareOutlined, { fontSize: "small", sx: { mr: 0.5 } }),
              " Share"
            ]
          }
        ) : /* @__PURE__ */ jsx(
          Button,
          {
            size: "small",
            disabled: downloadBusy,
            onClick: onDownload,
            sx: { px: 0.75, minWidth: 0, fontSize: 14, fontWeight: 600, color: viewerTokens.text },
            children: "\u2193 Original"
          }
        ),
        onExpand && /* @__PURE__ */ jsx(
          IconButton,
          {
            size: "small",
            "aria-label": "View full screen",
            onClick: onExpand,
            sx: { color: viewerTokens.text },
            children: /* @__PURE__ */ jsx(OpenInFullOutlined, { fontSize: "small" })
          }
        )
      ]
    }
  );
}
export {
  MediaOverlay
};
