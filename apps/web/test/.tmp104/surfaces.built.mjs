var __defProp = Object.defineProperty;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __esm = (fn, res, err) => function __init() {
  if (err) throw err[0];
  try {
    return fn && (res = (0, fn[__getOwnPropNames(fn)[0]])(fn = 0)), res;
  } catch (e) {
    throw err = [e], e;
  }
};
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};

// src/theme.js
import { createTheme } from "@mui/material/styles";
function paletteFor(tokens2) {
  const dark = tokens2 === darkTokens;
  return {
    mode: dark ? "dark" : "light",
    // Primary is the brand/identity color: navy in light; in dark the navy
    // ink retires and brand weight rides the warm light text.
    primary: { main: tokens2.navy, contrastText: dark ? tokens2.text.inverse : "#FFFFFF" },
    // Amber stays the primary action color in both modes; the hover step
    // darkens in light and lifts in dark (darkTokens.amberHover #F0B365).
    secondary: { main: tokens2.amber, dark: tokens2.amberHover, light: tokens2.amberGlow, contrastText: tokens2.text.inverse },
    background: { default: tokens2.page, paper: tokens2.surface },
    text: { primary: tokens2.text.primary, secondary: tokens2.text.secondary, disabled: tokens2.text.muted },
    divider: tokens2.border,
    porchlight: {
      page: tokens2.page,
      subtle: tokens2.subtle,
      warm: tokens2.warm,
      border: tokens2.border,
      borderStrong: tokens2.borderStrong,
      muted: tokens2.text.muted,
      amberSoft: tokens2.amberSoft,
      amberGlow: tokens2.amberGlow,
      voteUp: tokens2.voteUp,
      voteDown: tokens2.voteDown
    }
  };
}
function componentsFor(tokens2) {
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
      styleOverrides: { root: { border: `1px solid ${tokens2.border}`, borderRadius: 14, boxShadow: tokens2.shadowCard } }
    },
    MuiDialog: {
      styleOverrides: { paper: { borderRadius: 18, boxShadow: tokens2.shadowModal } }
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
        notchedOutline: { borderColor: tokens2.border }
      }
    },
    MuiAvatar: {
      styleOverrides: { root: { backgroundColor: tokens2.amberSoft, color: tokens2.navy, fontWeight: 600 } }
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
        body: { backgroundColor: tokens2.page },
        // PORCH-035 (Brian, Oct 14, 2026): the amber focus ring serves keyboard
        // wayfinding on non-input focusables only (buttons, links, tabs, chips).
        // Inputs and textareas indicate focus with MUI's stronger border alone —
        // the ring below never reaches an input element, and this is the only
        // focus rule in the app: no per-screen patch can reintroduce it.
        // PORCH-042: the ring alpha calibrates per mode (dark lifts from the
        // light alphas so the ring stays visible on charcoal surfaces).
        "*:focus-visible": {
          outline: "2px solid transparent",
          boxShadow: tokens2 === lightTokens ? "0 0 0 3px rgba(216,138,36,.28)" : "0 0 0 3px rgba(232,165,79,.32)"
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
function themeFor(displayMode) {
  const key = displayMode === "dark" ? "dark" : "light";
  if (!themes[key]) {
    const set = key === "dark" ? darkTokens : lightTokens;
    themes[key] = createTheme({ ...themeBase, palette: paletteFor(set), components: componentsFor(set) });
  }
  return themes[key];
}
function tokenAlpha(hex, alpha) {
  const value = String(hex).replace("#", "");
  return `rgba(${parseInt(value.slice(0, 2), 16)}, ${parseInt(value.slice(2, 4), 16)}, ${parseInt(value.slice(4, 6), 16)}, ${alpha})`;
}
var bootTokens, lightTokens, darkTokens, fontFamily, motion, themeBase, themes, theme, CSS_VAR_NAMES, cssVars;
var init_theme = __esm({
  "src/theme.js"() {
    bootTokens = {
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
    lightTokens = {
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
    darkTokens = {
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
    fontFamily = 'Inter, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
    motion = {
      ease: "cubic-bezier(.2,.8,.2,1)",
      min: 140,
      base: 180,
      entering: 220
    };
    themeBase = {
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
    themes = {};
    theme = themeFor("light");
    CSS_VAR_NAMES = [
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
    cssVars = Object.fromEntries(
      CSS_VAR_NAMES.map(([key, name]) => [key, `var(--porch-${name})`])
    );
  }
});

// src/emoji-data.js
import emojiJson from "unicode-emoji-json/data-by-group.json" with { type: "json" };
function emojiRowOf(emoji, fallback = null) {
  return ROW_BY_EMOJI.get(emoji) ?? fallback ?? { emoji, name: emoji, slug: "" };
}
function termMatches(row, term) {
  if (row.name.includes(term) || row.slug.includes(term)) return true;
  return SEARCH_ALIASES.get(row.emoji)?.some((alias) => alias.includes(term)) ?? false;
}
function searchEmojis(query, emojis = EMOJI_CATEGORIES.flatMap((group) => group.emojis)) {
  const terms = tokens(query);
  if (!terms.length) return emojis;
  return emojis.filter((row) => terms.every((term) => termMatches(row, term)));
}
var EMOJI_CATEGORIES, SEARCH_ALIASES, ROW_BY_EMOJI, tokens;
var init_emoji_data = __esm({
  "src/emoji-data.js"() {
    EMOJI_CATEGORIES = emojiJson.filter((group) => group.slug !== "components").map((group) => ({
      slug: group.slug,
      label: group.name,
      emojis: group.emojis.map((row) => ({ emoji: row.emoji, name: row.name, slug: row.slug }))
    }));
    SEARCH_ALIASES = /* @__PURE__ */ new Map([
      ["\u{1F4AF}", ["100", "perfect score", "score"]]
    ]);
    ROW_BY_EMOJI = new Map(
      EMOJI_CATEGORIES.flatMap((group) => group.emojis).map((row) => [row.emoji, row])
    );
    tokens = (query) => String(query || "").toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  }
});

// src/emoji-viewport.js
function keyboardDock({
  innerWidth = 0,
  innerHeight = 0,
  visualViewport = null,
  margin = DOCK_MARGIN
} = {}) {
  const viewport = visualViewport;
  if (!viewport || typeof viewport.height !== "number" || typeof viewport.offsetTop !== "number") return null;
  if (typeof innerWidth !== "number" || !(innerWidth <= MOBILE_CLASS_MAX)) return null;
  const hiddenBelow = innerHeight - viewport.height;
  if (!(hiddenBelow >= KEYBOARD_MIN)) return null;
  return {
    top: Math.round(viewport.offsetTop + margin),
    left: Math.round(viewport.offsetLeft + margin),
    width: Math.max(0, Math.round(viewport.width - margin * 2)),
    height: Math.max(160, Math.round(viewport.height - margin * 2)),
    keyboardTop: Math.round(viewport.offsetTop + viewport.height)
  };
}
var MOBILE_CLASS_MAX, KEYBOARD_MIN, DOCK_MARGIN;
var init_emoji_viewport = __esm({
  "src/emoji-viewport.js"() {
    MOBILE_CLASS_MAX = 899.95;
    KEYBOARD_MIN = 120;
    DOCK_MARGIN = 8;
  }
});

// src/emoji-picker.jsx
var emoji_picker_exports = {};
__export(emoji_picker_exports, {
  FREQUENT_EMPTY_STATE: () => FREQUENT_EMPTY_STATE,
  FREQUENT_LABEL: () => FREQUENT_LABEL,
  FREQUENT_SLUG: () => FREQUENT_SLUG,
  PickerBody: () => PickerBody,
  default: () => EmojiPicker
});
import React6, { useEffect as useEffect4, useMemo as useMemo2, useState as useState5 } from "react";
import { Box as Box4, IconButton as IconButton2, Popover, Stack as Stack3, Tab, Tabs, TextField, Typography as Typography4 } from "@mui/material";
import { jsx as jsx5, jsxs as jsxs5 } from "react/jsx-runtime";
function useKeyboardDock(open) {
  const [dock, setDock] = useState5(null);
  useEffect4(() => {
    if (!open) {
      setDock(null);
      return void 0;
    }
    const viewport = window.visualViewport;
    if (!viewport) return void 0;
    const measure = () => setDock(keyboardDock({
      innerWidth: window.innerWidth,
      innerHeight: window.innerHeight,
      visualViewport: viewport
    }));
    measure();
    viewport.addEventListener("resize", measure);
    viewport.addEventListener("scroll", measure);
    window.addEventListener("resize", measure);
    return () => {
      viewport.removeEventListener("resize", measure);
      viewport.removeEventListener("scroll", measure);
      window.removeEventListener("resize", measure);
      setDock(null);
    };
  }, [open]);
  return dock;
}
function EmojiPicker({ anchorEl, open, onClose, own = /* @__PURE__ */ new Set(), onToggle, busy, frequent = [] }) {
  const [query, setQuery] = useState5("");
  const [category, setCategory] = useState5(0);
  useEffect4(() => {
    if (open) {
      setQuery("");
      setCategory(0);
    }
  }, [open]);
  const dock = useKeyboardDock(open);
  const results = useMemo2(() => query.trim() ? searchEmojis(query) : category === 0 ? frequent.map((emoji) => emojiRowOf(emoji)) : EMOJI_CATEGORIES[category - 1]?.emojis ?? [], [query, category, frequent]);
  const searching = Boolean(query.trim());
  const gridMax = dock ? Math.max(120, Math.round(dock.height) - 96) : RESTING_GRID_MAX;
  return /* @__PURE__ */ jsx5(
    Popover,
    {
      open,
      anchorEl,
      onClose,
      anchorReference: dock ? "anchorPosition" : "anchorEl",
      anchorPosition: dock ? { top: dock.top, left: dock.left } : void 0,
      anchorOrigin: { vertical: "top", horizontal: "left" },
      transformOrigin: dock ? { vertical: "top", horizontal: "left" } : { vertical: "bottom", horizontal: "left" },
      slotProps: {
        paper: {
          elevation: 0,
          sx: {
            width: 356,
            // Docked: the paper lives INSIDE the visual viewport (the risen
            // keyboard occupies from keyboardTop down — nothing pickable
            // sits beneath); resting: the shipped anchored popover.
            ...dock ? {
              maxWidth: Math.round(dock.width),
              maxHeight: Math.round(dock.height),
              overflow: "hidden"
            } : { maxWidth: "92vw" },
            p: 2,
            borderRadius: "18px",
            border: `1px solid ${cssVars.border}`,
            boxShadow: cssVars.shadowModal
          }
        }
      },
      children: /* @__PURE__ */ jsx5(
        PickerBody,
        {
          query,
          onQuery: setQuery,
          category,
          onCategory: setCategory,
          results,
          searching,
          own,
          onToggle,
          busy,
          frequent,
          gridMax
        }
      )
    }
  );
}
function PickerBody({
  query,
  onQuery,
  category,
  onCategory,
  results = [],
  searching = false,
  own = /* @__PURE__ */ new Set(),
  onToggle,
  busy,
  frequent = [],
  gridMax = RESTING_GRID_MAX
}) {
  const ownRow = (emoji) => own?.has(emoji);
  const pick = (emoji) => {
    if (!busy) onToggle?.(emoji, ownRow(emoji));
  };
  const tabs = useMemo2(() => [FREQUENT_TAB, ...EMOJI_CATEGORIES], []);
  const gridEmpty = searching ? /* @__PURE__ */ jsx5(Typography4, { variant: "body2", color: "text.secondary", sx: { py: 2, textAlign: "center" }, children: "No emoji matched that search." }) : category === 0 && frequent.length === 0 ? /* @__PURE__ */ jsx5(Typography4, { variant: "body2", color: "text.secondary", sx: { py: 2, textAlign: "center" }, children: FREQUENT_EMPTY_STATE }) : null;
  return /* @__PURE__ */ jsxs5(Stack3, { spacing: 1.5, children: [
    /* @__PURE__ */ jsx5(
      TextField,
      {
        size: "small",
        label: "Search emoji",
        value: query,
        onChange: (event) => onQuery(event.target.value),
        inputProps: { "aria-label": "Search emoji" },
        placeholder: "heart, sun, laugh\u2026"
      }
    ),
    !searching && /* @__PURE__ */ jsx5(Tabs, { value: category, onChange: (event, next) => onCategory(next), variant: "scrollable", scrollButtons: false, allowScrollButtonsMobile: true, sx: { minHeight: 36 }, children: tabs.map((group) => /* @__PURE__ */ jsx5(
      Tab,
      {
        label: shortLabel(group.label),
        sx: { minHeight: 36, py: 0.5, px: 1.5, fontSize: 12, fontWeight: 600 },
        "aria-label": `${group.label} emoji category`
      },
      group.slug
    )) }),
    /* @__PURE__ */ jsxs5(
      Box4,
      {
        role: "listbox",
        "aria-label": searching ? "Emoji search results" : "Emoji picker grid",
        sx: {
          overflowY: "auto",
          maxHeight: gridMax,
          // The keyboard-rise restore (PORCH-120) rides the standard motion
          // token — the grid's measure change eases, the pick never jumps.
          transition: (theme2) => theme2.transitions.create("max-height", { duration: theme2.transitions.duration.standard })
        },
        children: [
          /* @__PURE__ */ jsx5(Box4, { sx: { display: "grid", gridTemplateColumns: "repeat(7, 44px)", justifyContent: "center", gap: 0.25 }, children: results.map((row) => {
            const ownEmoji = ownRow(row.emoji);
            return /* @__PURE__ */ jsx5(
              IconButton2,
              {
                onClick: () => pick(row.emoji),
                "aria-pressed": Boolean(ownEmoji),
                "aria-label": `${row.name}${ownEmoji ? " \u2014 tap to remove your reaction" : ""}`,
                disabled: busy,
                sx: {
                  width: 44,
                  height: 44,
                  fontSize: 22,
                  borderRadius: "10px",
                  backgroundColor: ownEmoji ? cssVars.amberSoft : "transparent",
                  border: `1px solid ${ownEmoji ? cssVars.amber : "transparent"}`,
                  "&:hover": { backgroundColor: ownEmoji ? cssVars.amberSoft : cssVars.subtle }
                },
                children: row.emoji
              },
              row.slug || row.emoji
            );
          }) }),
          gridEmpty
        ]
      }
    )
  ] });
}
var FREQUENT_SLUG, FREQUENT_LABEL, FREQUENT_EMPTY_STATE, FREQUENT_TAB, RESTING_GRID_MAX, shortLabel;
var init_emoji_picker = __esm({
  "src/emoji-picker.jsx"() {
    init_theme();
    init_emoji_data();
    init_emoji_viewport();
    FREQUENT_SLUG = "frequently-used";
    FREQUENT_LABEL = "Frequently Used";
    FREQUENT_EMPTY_STATE = "React a few times and your favorites will appear here.";
    FREQUENT_TAB = { slug: FREQUENT_SLUG, label: FREQUENT_LABEL };
    RESTING_GRID_MAX = 272;
    shortLabel = (label) => label.split(" & ")[0];
  }
});

// src/social.jsx
import React7, { Suspense, lazy, useEffect as useEffect5, useLayoutEffect as useLayoutEffect2, useRef as useRef3, useState as useState6, useCallback as useCallback2 } from "react";
import {
  Alert as Alert2,
  Avatar as Avatar2,
  Box as Box5,
  Button as Button2,
  Card,
  CardContent,
  Chip as Chip2,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Divider,
  FormControl,
  IconButton as IconButton3,
  InputLabel,
  List,
  ListItemButton,
  ListItemText,
  Menu,
  MenuItem,
  Paper,
  Popover as Popover2,
  Popper,
  Select,
  Snackbar,
  Stack as Stack4,
  Switch,
  TextField as TextField2,
  Tooltip,
  Typography as Typography5
} from "@mui/material";

// src/lantern.jsx
import React, { useEffect, useLayoutEffect, useRef, useState } from "react";

// src/loader-assets.js
var LOADER_ANIM_SRC = "/loader.webp";
var LOADER_STILL_SRC = "/loader-still.webp";
var LOADER_ANIM_W = 137;
var LOADER_ANIM_H = 170;
var LOADER_MARK_H = 40;

// src/lantern.jsx
import { Fragment, jsx, jsxs } from "react/jsx-runtime";
var CSS = `
@keyframes porch95-fade { from { opacity: 1; } to { opacity: 0; } }
.porch118-webp { display: block; }
.porch118-webp-still { display: none; }
.porch-dusk-scene { position: relative; isolation: isolate; width: 300px; height: 340px; display: flex; align-items: center; justify-content: center; }
.porch-dusk-mark { position: relative; z-index: 3; opacity: 0; display: block; transition: opacity 300ms ease-out; }
.porch-dusk-mark-loaded { opacity: 1; }
.porch-dusk-halo {
  position: absolute; left: 50%; top: 50%; width: 320px; height: 330px; z-index: 0;
  transform: translate(-50%, -50%); border-radius: 50%;
  background: var(--porch-boot-dusk-halo);
  animation: porch-dusk-breathe 4.8s ease-in-out infinite;
}
.porch-dusk-glow {
  position: absolute; left: 50%; top: 292px; width: 440px; height: 130px; z-index: 0;
  transform: translate(-50%, -50%) scaleY(.42); border-radius: 50%;
  background: var(--porch-boot-dusk-glow);
  animation: porch-dusk-breathe 4.8s ease-in-out infinite; animation-delay: -2.4s;
}
/* Breathing (ac-4): the light layers only, opacity only \u2014 softening and
   brightening, never flashing, never moving the mark. */
@keyframes porch-dusk-breathe { 0%, 100% { opacity: .72; } 50% { opacity: 1; } }
.porch-dusk-particles { position: absolute; inset: 0; z-index: 0; }
/* Brian, Oct 22, second amendment: count +300% (6 \u2192 24 motes) and
   spread +200% (each mote's field extent \xD73 \u2014 the widest orbit now
   sweeps 384px, 3\xD7 the prior 128px ceiling). The tiered radii keep
   near-lantern depth against the wide field, alternating direction
   stays, never a uniform swarm. The orbit composes from translate
   waypoints so the mark's own layers stay untouched, and the motes
   stay z-under the mark: passing "behind" the lantern reads as the
   orbit wrapping it. Each load starts every mote at a random point of
   its orbit \u2014 randomizeMoteStarts offsets the animation into a
   per-load phase. */
.porch-dusk-particle {
  position: absolute; left: 50%; top: 50%; width: 5px; height: 5px; border-radius: 50%; opacity: .9;
  background: var(--porch-boot-dusk-mote);
  box-shadow: var(--porch-boot-dusk-spark-glow);
  animation: porch-dusk-orbit var(--d, 21s) ease-in-out infinite;
}
.porch-dusk-particle:nth-child(even) { animation-direction: reverse; }
/* The elliptical orbit: four eased waypoints around the anchor with a
   gentle rotate wiggle \u2014 curved everywhere, never a straight strobe. */
@keyframes porch-dusk-orbit {
  0%   { transform: translate(var(--r, 88px), 0) rotate(-90deg); }
  25%  { transform: translate(calc(var(--r, 88px) * .12), calc(var(--ry, 40px) * -1)) rotate(-180deg); }
  50%  { transform: translate(calc(var(--r, 88px) * -.92), calc(var(--ry, 40px) * -.12)) rotate(-270deg); }
  75%  { transform: translate(calc(var(--r, 88px) * -.06), var(--ry, 40px)) rotate(-360deg); }
  100% { transform: translate(var(--r, 88px), 0) rotate(-450deg); }
}
.porch-dusk-particle:nth-child(1) { --r: 264px; --ry: 114px; --d: 21s; animation-delay: -4s; }
.porch-dusk-particle:nth-child(2) { --r: 336px; --ry: 156px; --d: 27s; animation-delay: -13s; }
.porch-dusk-particle:nth-child(3) { --r: 222px; --ry: 90px;  --d: 18s; animation-delay: -9s; }
.porch-dusk-particle:nth-child(4) { --r: 384px; --ry: 174px; --d: 30s; animation-delay: -2s; }
.porch-dusk-particle:nth-child(5) { --r: 288px; --ry: 132px; --d: 23s; animation-delay: -17s; }
.porch-dusk-particle:nth-child(6) { --r: 324px; --ry: 102px; --d: 26s; animation-delay: -21s; }
.porch-dusk-particle:nth-child(7) { --r: 148px; --ry: 64px;  --d: 16s; animation-delay: -1s; }
.porch-dusk-particle:nth-child(8) { --r: 232px; --ry: 96px;  --d: 22s; animation-delay: -11s; }
.porch-dusk-particle:nth-child(9) { --r: 110px; --ry: 48px;  --d: 15s; animation-delay: -7s; }
.porch-dusk-particle:nth-child(10) { --r: 300px; --ry: 128px; --d: 28s; animation-delay: -19s; }
.porch-dusk-particle:nth-child(11) { --r: 186px; --ry: 78px;  --d: 19s; animation-delay: -3s; }
.porch-dusk-particle:nth-child(12) { --r: 344px; --ry: 148px; --d: 29s; animation-delay: -25s; }
.porch-dusk-particle:nth-child(13) { --r: 132px; --ry: 56px;  --d: 17s; animation-delay: -14s; }
.porch-dusk-particle:nth-child(14) { --r: 258px; --ry: 108px; --d: 24s; animation-delay: -6s; }
.porch-dusk-particle:nth-child(15) { --r: 96px;  --ry: 42px;  --d: 14s; animation-delay: -10s; }
.porch-dusk-particle:nth-child(16) { --r: 312px; --ry: 136px; --d: 27s; animation-delay: -22s; }
.porch-dusk-particle:nth-child(17) { --r: 210px; --ry: 88px;  --d: 20s; animation-delay: -15s; }
.porch-dusk-particle:nth-child(18) { --r: 358px; --ry: 160px; --d: 31s; animation-delay: -8s; }
.porch-dusk-particle:nth-child(19) { --r: 122px; --ry: 52px;  --d: 16s; animation-delay: -5s; }
.porch-dusk-particle:nth-child(20) { --r: 274px; --ry: 120px; --d: 25s; animation-delay: -24s; }
.porch-dusk-particle:nth-child(21) { --r: 170px; --ry: 72px;  --d: 18s; animation-delay: -12s; }
.porch-dusk-particle:nth-child(22) { --r: 368px; --ry: 168px; --d: 32s; animation-delay: -18s; }
.porch-dusk-particle:nth-child(23) { --r: 200px; --ry: 84px;  --d: 21s; animation-delay: -20s; }
.porch-dusk-particle:nth-child(24) { --r: 288px; --ry: 118px; --d: 26s; animation-delay: -16s; }
/* Fixed-height status box (ac-6): crossfading children swap in place, the
   surrounding layout never shifts. */
.porch95-statusbox { position: relative; height: 20px; width: 300px; }
.porch95-status {
  position: absolute; left: 0; right: 0; top: 0; text-align: center; white-space: nowrap;
  opacity: 0; transition: opacity 250ms ease;
  color: var(--porch-boot-status-ink); font-size: 14px;
  font-family: Inter, system-ui, sans-serif;
}
.porch95-status-on { opacity: 1; }
.porch95-wordmark {
  color: var(--porch-boot-ink); font-size: 21px; font-weight: 650;
  letter-spacing: .02em; font-family: Inter, system-ui, sans-serif;
}
/* ac-9: the one polite announcement, invisible on the canvas; every
   decorative layer carries aria-hidden in markup. */
.porch95-announce {
  position: absolute; width: 1px; height: 1px; overflow: hidden;
  clip: rect(0 0 0 0); clip-path: inset(50%); white-space: nowrap;
}
/* ac-11: the earned boot failure holds \u2014 clear copy, one plain retry. */
.porch95-fail { display: flex; flex-direction: column; align-items: center; gap: 14px; padding-top: 2px; }
.porch95-fail-copy {
  color: var(--porch-boot-ink); font-size: 15px; font-family: Inter, system-ui, sans-serif;
  text-align: center; max-width: 340px; line-height: 1.5;
}
.porch95-retry {
  appearance: none; background: transparent; border: 1px solid var(--porch-boot-dusk-edge);
  border-radius: 999px; color: var(--porch-boot-ink); cursor: pointer;
  font-family: Inter, system-ui, sans-serif; font-size: 15px; font-weight: 600; padding: 9px 24px;
}
/* The amber attention ring on this non-input focusable is the global
   mechanism from the theme baseline (the PORCH-035 rule layer) \u2014 no
   per-screen styling of its own here. */
.porch95-retry:hover { background: var(--porch-boot-dusk-hover); }
/* Only the in-app animated loader swaps to its still frame. */
@media (prefers-reduced-motion: reduce) {
  .porch118-webp { display: none; }
  .porch118-webp-still { display: block; }
}
/* ac-8: the dusk lighting holds static, the particles rest, and status
   swaps are instant (no crossfade). */
@media (prefers-reduced-motion: reduce) {
  .porch-dusk-particle { display: none; }
  .porch-dusk-halo, .porch-dusk-glow { animation: none; opacity: .85; }
  .porch-dusk-mark, .porch95-status { transition: none; }
}
`;
function Mark({ height = LOADER_MARK_H }) {
  const style = { height, width: "auto" };
  return /* @__PURE__ */ jsxs(Fragment, { children: [
    /* @__PURE__ */ jsx(
      "img",
      {
        className: "porch118-webp",
        src: LOADER_ANIM_SRC,
        width: LOADER_ANIM_W,
        height: LOADER_ANIM_H,
        alt: "",
        "aria-hidden": "true",
        focusable: "false",
        style
      }
    ),
    /* @__PURE__ */ jsx(
      "img",
      {
        className: "porch118-webp-still",
        src: LOADER_STILL_SRC,
        width: LOADER_ANIM_W,
        height: LOADER_ANIM_H,
        alt: "",
        "aria-hidden": "true",
        focusable: "false",
        style
      }
    )
  ] });
}
function LanternLoader({ size = LOADER_MARK_H, label, style }) {
  const pad = Math.round(size * 0.35);
  return /* @__PURE__ */ jsxs("div", { role: "status", "aria-label": label, style: {
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    minWidth: size + pad * 2,
    minHeight: size + pad * 2,
    ...style
  }, children: [
    /* @__PURE__ */ jsx("style", { children: CSS }),
    /* @__PURE__ */ jsx(Mark, { height: size })
  ] });
}

// src/social.jsx
import {
  AddReactionOutlined,
  ArrowDownwardOutlined,
  ArrowUpwardOutlined,
  ChevronLeft,
  ChevronRight,
  FullscreenOutlined,
  MoreHorizOutlined,
  MoreVertOutlined,
  PauseOutlined,
  PlayArrowOutlined,
  ReplayOutlined,
  ReplyOutlined,
  VolumeOffOutlined,
  VolumeUpOutlined
} from "@mui/icons-material";

// src/photo-viewer.jsx
import React2, { useCallback, useEffect as useEffect2, useRef as useRef2, useState as useState2 } from "react";
import { Alert, Box, Button, IconButton, Stack, Typography } from "@mui/material";
import { CloseOutlined, OpenInFullOutlined, PhotoLibraryOutlined, ShareOutlined } from "@mui/icons-material";

// src/media-blob.js
var mediaBlobs = /* @__PURE__ */ new Map();
var CACHE_LIMIT = 200;
var EVICT_AFTER_MS = 6e4;
function mediaBlobKey({ origin, mediaId, kind, version = null } = {}) {
  return `${String(origin)}|${String(mediaId)}|${String(kind)}|${version ?? ""}`;
}
function readMediaBlob(key) {
  const row = mediaBlobs.get(key) ?? null;
  if (row) row.at = Date.now();
  return row;
}
function putMediaBlob(key, { url, blob, shape = null }) {
  const previous = mediaBlobs.get(key);
  if (previous && previous.url !== url) {
    try {
      URL.revokeObjectURL(previous.url);
    } catch {
    }
  }
  const row = { url, blob, shape, at: Date.now() };
  mediaBlobs.set(key, row);
  if (mediaBlobs.size > CACHE_LIMIT) evict();
  return row;
}
function evict() {
  const cutoff = Date.now() - EVICT_AFTER_MS;
  let oldestKey = null;
  let oldestAt = Infinity;
  for (const [key, row2] of mediaBlobs) {
    if (row2.at < oldestAt) {
      oldestAt = row2.at;
      oldestKey = key;
    }
  }
  if (oldestKey === null) return;
  if (mediaBlobs.get(oldestKey).at > cutoff) return;
  const row = mediaBlobs.get(oldestKey);
  try {
    URL.revokeObjectURL(row.url);
  } catch {
  }
  mediaBlobs.delete(oldestKey);
}

// src/media-slot.js
var MEDIA_RETRY_BUDGET = 2;
var MEDIA_RETRY_BACKOFF_MS = 1200;
var MEDIA_ATTEMPT_TIMEOUT_MS = 3e4;
function mediaFailureClass(status) {
  return status === 404 || status === 410 ? "failed-terminal" : "failed-retryable";
}
function mediaRetryDelayMs(retryNumber = 1) {
  return MEDIA_RETRY_BACKOFF_MS * Math.max(1, Math.min(MEDIA_RETRY_BUDGET, retryNumber));
}

// src/photo-first.js
init_theme();
var PORTRAIT_EXTENT = 3 / 4;
function videoInlineMasked(aspect) {
  return typeof aspect === "number" && aspect > 0 && aspect < PORTRAIT_EXTENT;
}
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
function adaptiveTrackHeight(heights, slidePosition) {
  const clean = (Array.isArray(heights) ? heights : []).map(
    (height) => Number.isFinite(height) && height > 0 ? height : null
  );
  if (!clean.length) return null;
  const position = Math.min(clean.length - 1, Math.max(0, Number.isFinite(slidePosition) ? slidePosition : 0));
  const lower = Math.floor(position);
  let from = null;
  for (let index = lower; index >= 0 && from == null; index -= 1) from = clean[index];
  for (let index = lower + 1; index < clean.length && from == null; index += 1) from = clean[index];
  if (from == null) return null;
  const next = Math.min(clean.length - 1, lower + 1);
  const to = clean[next] ?? from;
  return Math.round(from + (to - from) * (position - lower));
}
function carouselIndex(scrollLeft, slideWidth, count) {
  if (!(slideWidth > 0) || !(count > 0)) return 0;
  return Math.min(count - 1, Math.max(0, Math.round(scrollLeft / slideWidth)));
}

// src/media-rung.js
function renditionUrl(origin, mediaId, kind, sha256) {
  const base = String(origin || "").replace(/\/+$/, "");
  return `${base}/api/social/media/${encodeURIComponent(mediaId)}/renditions/${encodeURIComponent(kind)}?v=${encodeURIComponent(sha256)}`;
}
function renditionSrcset(meta, origin) {
  const rungs = (meta?.renditions ?? []).filter((rung) => rung.sha256 && (rung.width ?? 0) > 0 && rung.kind !== "poster" && rung.kind !== "playable").sort((a, b) => (a.width ?? 0) - (b.width ?? 0));
  return rungs.map((rung) => `${renditionUrl(origin, meta.mediaId, rung.kind, rung.sha256)} ${rung.width}w`).join(", ");
}
function timelineImageSizes() {
  return `(max-width: ${photoFirst.mobileBelow - 1}px) 100vw, calc(min(780px, 100vw - 40px) + ${2 * photoFirst.postPad}px)`;
}
function detailImageSizes(meta) {
  const aspect = meta?.width && meta?.height ? meta.width / meta.height : 1.5;
  const widest = Math.max(64, Math.min(820, Math.round(720 * aspect)));
  return `(max-width: ${photoFirst.mobileBelow - 1}px) 100vw, ${widest}px`;
}
function renditionSrc(meta, origin) {
  const rungs = (meta?.renditions ?? []).filter((rung) => rung.sha256 && (rung.width ?? 0) > 0);
  const smallest = rungs.reduce(
    (narrowest, rung) => (rung.width ?? 0) < (narrowest?.width ?? Infinity) ? rung : narrowest,
    null
  );
  return smallest ? renditionUrl(origin, meta.mediaId, smallest.kind, smallest.sha256) : null;
}
function playableVideoUrl(meta, origin) {
  const playable = (meta?.renditions ?? []).find((rung) => rung.kind === "playable" && rung.sha256);
  return playable ? renditionUrl(origin, meta.mediaId, "playable", playable.sha256) : null;
}
function posterUrl(meta, origin) {
  const poster = meta?.poster;
  return poster?.sha256 ? renditionUrl(origin, meta.mediaId, "poster", poster.sha256) : null;
}
function stampedAspect(meta) {
  if (typeof meta?.aspect === "number" && meta.aspect > 0) return meta.aspect;
  if ((meta?.width ?? 0) > 0 && (meta?.height ?? 0) > 0) return meta.width / meta.height;
  return null;
}
function mediaFileName(mediaId, blob) {
  const extByType = {
    "image/jpeg": "jpg",
    "image/png": "png",
    "image/gif": "gif",
    "image/webp": "webp",
    "image/heic": "heic",
    "image/heif": "heif",
    "video/mp4": "mp4",
    "video/webm": "webm",
    "video/quicktime": "mov"
  };
  const type = String(blob?.type ?? "").split(";")[0];
  const ext = extByType[type] ?? (type.startsWith("video/") ? "mp4" : type.startsWith("image/") ? "jpg" : "bin");
  return `${mediaId}.${ext}`;
}
function rungKindForViewport(meta, viewportWidth, devicePixelRatio) {
  if (meta?.poster?.sha256) return "playable";
  const rungs = (meta?.renditions ?? []).filter((rung) => rung.sha256 && (rung.width ?? 0) > 0 && rung.kind !== "poster" && rung.kind !== "playable").sort((a, b) => (a.width ?? 0) - (b.width ?? 0));
  if (rungs.length === 0) return null;
  const need = Math.min(meta.width ?? Infinity, Math.ceil(viewportWidth * (devicePixelRatio || 1)));
  const fitting = rungs.filter((rung) => rung.width >= need);
  return (fitting.length > 0 ? fitting[0] : rungs[rungs.length - 1]).kind;
}

// src/feed-filter.js
var identityOf = (row) => String(row?._id ?? row?.id ?? "");
var originOf = (post) => post?.originNetworkId ?? post?.networkId ?? post?.origin?.id;
var networkId = (data) => data?.network?._id ?? data?.network?.id;
var originName = (post, data) => post?.origin?.name ?? post?.network ?? (String(originOf(post)) === String(networkId(data)) || !originOf(post) ? data?.network?.name : null) ?? originOf(post) ?? "This network";
var postKey = (post) => `${post?.origin ?? originOf(post) ?? ""}:${identityOf(post)}`;
function visibleAtOrigin(post, data) {
  return !originOf(post) || !networkId(data) || String(originOf(post)) === String(networkId(data)) || data.connections?.some(
    (connection) => String(connection.networkId) === String(originOf(post)) || post.origin && String(connection.url).replace(/\/$/, "") === String(post.origin).replace(/\/$/, "")
  );
}

// src/playback-governance.js
var slots = /* @__PURE__ */ new Map();
var playing = /* @__PURE__ */ new Set();
var visibilityTick = 0;
var overlayDepth = 0;
var governedPauseKey = null;
var slotCounter = 0;
function candidateEligible(slot) {
  return Boolean(slot) && slot.visible && !slot.memberPaused && !slot.blocked && Boolean(slot.ctrl);
}
function pauseSlot(key) {
  const slot = slots.get(key);
  if (!slot || !playing.has(key)) return;
  governedPauseKey = key;
  slot.ctrl.pause();
  if (governedPauseKey === key) governedPauseKey = null;
}
function playSlot(slot) {
  const played = slot.ctrl.play();
  return played === true;
}
function reconcile(preferKey = null) {
  if (overlayDepth > 0) {
    for (const key of [...playing]) pauseSlot(key);
    return;
  }
  let candidate = null;
  if (preferKey && candidateEligible(slots.get(preferKey))) candidate = slots.get(preferKey);
  if (!candidate) {
    const eligible = [...slots.values()].filter(candidateEligible).sort((a, b) => b.visibleAt - a.visibleAt);
    for (const slot of eligible) {
      if (playSlot(slot)) {
        candidate = slot;
        break;
      }
    }
  }
  for (const key of [...slots.keys()]) {
    if (key !== candidate?.key) pauseSlot(key);
  }
}
function newPlaybackSlotKey(mediaId) {
  slotCounter += 1;
  return `${String(mediaId)}#${slotCounter}`;
}
function registerPlaybackSlot(slotKey, mediaId, ctrl) {
  const key = String(slotKey);
  const slot = slots.get(key) ?? { key, mediaKey: String(mediaId), visible: false, visibleAt: -Infinity, memberPaused: false, blocked: false, ctrl: null };
  slot.ctrl = ctrl ?? slot.ctrl;
  slots.set(key, slot);
  return function release() {
    const held = slots.get(key);
    slots.delete(key);
    const wasPlaying = playing.delete(key);
    if (governedPauseKey === key) governedPauseKey = null;
    if (held?.visible && wasPlaying && overlayDepth === 0) reconcile();
  };
}
function slotVisibility(slotKey, intersecting) {
  const key = String(slotKey);
  const slot = slots.get(key);
  if (!slot) return;
  const wasVisible = slot.visible;
  slot.visible = intersecting === true;
  if (slot.visible && !wasVisible) {
    slot.visibleAt = visibilityTick += 1;
    slot.blocked = false;
  }
  if (overlayDepth > 0) return;
  reconcile();
}
function notifyPlayback(slotKey, isPlaying) {
  const key = String(slotKey);
  const slot = slots.get(key);
  if (!slot) return;
  if (isPlaying) {
    slot.memberPaused = false;
    playing.add(key);
    if (overlayDepth > 0) {
      pauseSlot(key);
      return;
    }
    reconcile(key);
    return;
  }
  playing.delete(key);
  if (governedPauseKey === key) {
    governedPauseKey = null;
    return;
  }
  slot.memberPaused = true;
  if (overlayDepth === 0) reconcile();
}
function playbackSlotElementReady(slotKey) {
  const key = String(slotKey);
  const slot = slots.get(key);
  if (!slot) return;
  slot.blocked = false;
  if (overlayDepth > 0 || !slot.visible) return;
  reconcile();
}
function playbackSlotPlayRejected(slotKey) {
  const slot = slots.get(String(slotKey));
  if (!slot) return;
  slot.blocked = true;
  if (overlayDepth === 0) reconcile();
}
function playbackOverlayOpen() {
  overlayDepth += 1;
  reconcile();
}
function playbackOverlayClose() {
  overlayDepth = Math.max(0, overlayDepth - 1);
  if (overlayDepth === 0) reconcile();
}

// src/install.js
var INSTALL_USAGE_GATE_MS = 2 * 60 * 1e3;
var INSTALL_SUPPRESSION_MS = 14 * 24 * 60 * 60 * 1e3;
function webkitClass(userAgent) {
  return /webkit/i.test(userAgent || "") && !/Chrom(e|ium)|Edg\//i.test(userAgent || "");
}

// src/share-matrix.js
var ANDROID_SHEET_SET_LIMIT = 10;
function shareTouchCapable(env = {}) {
  if (env.touchCapable !== void 0) return Boolean(env.touchCapable);
  if (typeof navigator === "undefined") return false;
  return (navigator.maxTouchPoints ?? 0) > 0;
}
function shareDeviceClass(env = {}) {
  const touch = env.touchCapable !== void 0 ? Boolean(env.touchCapable) : shareTouchCapable(env);
  if (!touch) return "desktop";
  const userAgent = env.userAgent ?? (typeof navigator !== "undefined" ? navigator?.userAgent : "");
  return webkitClass(userAgent) ? "ios" : "android";
}
function shareFileCapable(env = {}) {
  const share = env.share ?? (typeof navigator !== "undefined" ? navigator?.share : void 0);
  const canShare = env.canShare ?? (typeof navigator !== "undefined" ? navigator?.canShare : void 0);
  if (typeof share !== "function" || typeof canShare !== "function") return false;
  try {
    return Boolean(canShare.call(navigator, { files: [new File([], "porchlight-probe", { type: "image/png" })] }));
  } catch {
    return false;
  }
}
function overlayOriginalAction(env = {}) {
  return shareTouchCapable(env) ? "share" : "download";
}
function endCardPlan({ deviceClass, photos = 0, shareCapable } = {}) {
  const capable = shareCapable !== void 0 ? Boolean(shareCapable) : shareFileCapable();
  if (deviceClass === "desktop" || !capable) {
    return { kind: "zip-download", verb: "Fetching your originals\u2026", label: "Download all originals" };
  }
  if (deviceClass === "ios") {
    return { kind: "share-zip", verb: "Sharing your originals\u2026", label: "Share all originals" };
  }
  if (photos <= ANDROID_SHEET_SET_LIMIT) {
    return { kind: "share-files", verb: "Sharing your originals\u2026", label: "Share all originals" };
  }
  return { kind: "share-zip", verb: "Sharing your originals\u2026", label: "Share all originals" };
}
function shareFileOf(blob, fileName) {
  return new File([blob], fileName, { type: blob?.type || "application/octet-stream" });
}
function downloadBlob(blob, fileName) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = fileName;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 6e4);
}
async function shareOriginal(blob, fileName, env = {}) {
  const share = env.share ?? navigator?.share;
  const canShare = env.canShare ?? navigator?.canShare;
  const download = env.download ?? downloadBlob;
  if (blob instanceof Blob && typeof share === "function" && typeof canShare === "function") {
    try {
      const file = shareFileOf(blob, fileName);
      if (canShare.call(navigator, { files: [file] })) {
        await share.call(navigator, { files: [file], title: "Porchlight" });
        return { mode: "shared" };
      }
    } catch (error) {
      if (error?.name === "AbortError") return { mode: "shared", dismissed: true };
    }
  }
  if (blob instanceof Blob) download(blob, fileName);
  return { mode: "downloaded" };
}

// src/photo-viewer.js
init_theme();
var POSITION_HOLD_MS = 4e3;
var DEFAULT_ZOOM = 2;
var DOUBLE_TAP_MS = 300;
var MAX_ZOOM = 5;
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
function fitDimensions(width, height, viewportWidth, viewportHeight) {
  if (!(width > 0) || !(height > 0) || !(viewportWidth > 0) || !(viewportHeight > 0)) return null;
  const scale = Math.min(viewportWidth / width, viewportHeight / height);
  return { width: width * scale, height: height * scale };
}
function panBounds(scale, viewportWidth, viewportHeight, fitWidth, fitHeight) {
  const clamp = (value) => Number.isFinite(value) ? value : 0;
  return {
    x: clamp(Math.max(0, (scale * fitWidth - viewportWidth) / 2)),
    y: clamp(Math.max(0, (scale * fitHeight - viewportHeight) / 2))
  };
}
function clampPan(x, y, bounds) {
  return {
    x: Math.min(bounds.x, Math.max(-bounds.x, x)),
    y: Math.min(bounds.y, Math.max(-bounds.y, y))
  };
}
function anchoredPan(prev, nextScale, anchorX, anchorY) {
  if (!(prev.scale > 0)) return { x: 0, y: 0 };
  const unitX = (anchorX - prev.x) / prev.scale;
  const unitY = (anchorY - prev.y) / prev.scale;
  return { x: anchorX - unitX * nextScale, y: anchorY - unitY * nextScale };
}
function zoomTo(prev, nextScale, anchorX, anchorY, viewportWidth, viewportHeight, fitWidth, fitHeight) {
  if (!(nextScale > 1.05) || !(fitWidth > 0)) return { scale: 1, x: 0, y: 0 };
  const scale = Math.min(MAX_ZOOM, nextScale);
  const bounds = panBounds(scale, viewportWidth, viewportHeight, fitWidth, fitHeight);
  const pan = clampPan(anchoredPan(prev, scale, anchorX, anchorY).x, anchoredPan(prev, scale, anchorX, anchorY).y, bounds);
  return { scale, x: pan.x, y: pan.y };
}
function pinchTo(prev, startDistance, nowDistance, anchorX, anchorY, viewportWidth, viewportHeight, fitWidth, fitHeight) {
  if (!(startDistance > 0)) return { ...prev };
  return zoomTo(prev, prev.scale * (nowDistance / startDistance), anchorX, anchorY, viewportWidth, viewportHeight, fitWidth, fitHeight);
}
function wheelZoom(prev, deltaY, anchorX, anchorY, viewportWidth, viewportHeight, fitWidth, fitHeight) {
  const factor = Math.exp(-(Number.isFinite(deltaY) ? deltaY : 0) * 2e-3);
  return zoomTo(prev, prev.scale * factor, anchorX, anchorY, viewportWidth, viewportHeight, fitWidth, fitHeight);
}
function needsOriginal(meta, scale, viewportWidth, devicePixelRatio) {
  if (!(scale > 1)) return false;
  const rungs = (meta?.renditions ?? []).filter((rung) => rung.sha256 && (rung.width ?? 0) > 0 && rung.kind !== "poster" && rung.kind !== "playable").sort((a, b) => (a.width ?? 0) - (b.width ?? 0));
  const largest = rungs.length ? rungs[rungs.length - 1].width : null;
  if (largest == null) return false;
  const need = viewportWidth * (devicePixelRatio || 1) * scale;
  return need > largest && (meta?.width ?? Infinity) > largest;
}
function viewerTotalCount(photoCount) {
  return Math.max(0, photoCount) + 1;
}

// src/photo-viewer.jsx
import { Fragment as Fragment2, jsx as jsx2, jsxs as jsxs2 } from "react/jsx-runtime";
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
  return /* @__PURE__ */ jsxs2(
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
        shareAction ? /* @__PURE__ */ jsxs2(
          Button,
          {
            size: "small",
            disabled: shareAction.busy,
            onClick: shareAction.run,
            sx: { px: 0.75, minWidth: 0, fontSize: 14, fontWeight: 600, color: viewerTokens.text },
            children: [
              /* @__PURE__ */ jsx2(ShareOutlined, { fontSize: "small", sx: { mr: 0.5 } }),
              " Share"
            ]
          }
        ) : /* @__PURE__ */ jsx2(
          Button,
          {
            size: "small",
            disabled: downloadBusy,
            onClick: onDownload,
            sx: { px: 0.75, minWidth: 0, fontSize: 14, fontWeight: 600, color: viewerTokens.text },
            children: "\u2193 Original"
          }
        ),
        onExpand && /* @__PURE__ */ jsx2(
          IconButton,
          {
            size: "small",
            "aria-label": "View full screen",
            onClick: onExpand,
            sx: { color: viewerTokens.text },
            children: /* @__PURE__ */ jsx2(OpenInFullOutlined, { fontSize: "small" })
          }
        )
      ]
    }
  );
}
function ViewerSlidePhoto({ post, id, actions, origin, originalUrl, active, zoom, fit }) {
  const meta = post?.mediaMeta?.[id] ?? null;
  const direct = Boolean(meta && actions?.mediaTransport && renditionSrc(meta, origin));
  const [resource, setResource] = useState2(null);
  const [phase, setPhase] = useState2("pending");
  const [attempt, setAttempt] = useState2(0);
  const retriesRef = useRef2(MEDIA_RETRY_BUDGET);
  useEffect2(() => {
    if (direct) return void 0;
    const kind = meta ? rungKindForViewport(meta, window.innerWidth, window.devicePixelRatio || 1) : "original";
    const identity = mediaBlobKey({ origin, mediaId: id, kind: kind ?? "original", version: null });
    const cached = readMediaBlob(identity);
    if (cached) {
      setResource(cached);
      setPhase("loaded");
      return void 0;
    }
    let live = true;
    setResource(null);
    setPhase("pending");
    Promise.resolve().then(() => typeof actions?.getMedia === "function" ? actions.getMedia(id, kind ?? "original", origin, null) : Promise.reject(new Error("Media is not available here yet."))).then(async (blob) => {
      if (!(blob instanceof Blob) || !live) return;
      const url2 = URL.createObjectURL(blob);
      const row = putMediaBlob(identity, { url: url2, blob, shape: {} });
      setResource(row);
      setPhase("loaded");
    }).catch((error) => {
      if (!live) return;
      if (mediaFailureClass(error?.status) === "failed-terminal") {
        setPhase("failed-terminal");
        return;
      }
      setPhase("failed-retryable");
      if (retriesRef.current <= 0) return;
      retriesRef.current -= 1;
      setTimeout(() => {
        if (live) setAttempt((n) => n + 1);
      }, mediaRetryDelayMs(MEDIA_RETRY_BUDGET - retriesRef.current));
    });
    return () => {
      live = false;
    };
  }, [id, origin, direct, attempt]);
  const zoomed = active && zoom.scale > 1;
  const url = originalUrl ?? (direct ? renditionSrc(meta, origin) : resource?.url);
  if (phase === "failed-terminal") {
    return /* @__PURE__ */ jsx2(Box, { role: "status", "aria-label": "This moment is no longer available", sx: {
      ...fit ? { width: fit.width, height: fit.height } : {},
      aspectRatio: stampedAspect(meta) ?? 1.5,
      maxWidth: "100%",
      maxHeight: "100%",
      bgcolor: viewerTokens.subtle,
      borderRadius: 1,
      display: "flex",
      alignItems: "center",
      justifyContent: "center",
      px: 2,
      py: 2
    }, children: /* @__PURE__ */ jsx2(Typography, { component: "span", sx: { textAlign: "center", fontSize: 13, lineHeight: "20px" }, children: "Your hub did not return the media." }) });
  }
  if (!url) {
    return /* @__PURE__ */ jsx2(Box, { "aria-label": "Loading photo", sx: {
      ...fit ? { width: fit.width, height: fit.height } : {},
      aspectRatio: stampedAspect(meta) ?? 1.5,
      maxWidth: "100%",
      maxHeight: "100%",
      bgcolor: viewerTokens.subtle,
      borderRadius: 1
    } });
  }
  const transform = active && zoom.scale !== 1 ? `translate3d(${zoom.x}px, ${zoom.y}px, 0) scale(${zoom.scale})` : void 0;
  const box = fit ? { width: fit.width, height: fit.height } : { maxWidth: "100%", maxHeight: "100%", aspectRatio: stampedAspect(meta) ?? 1.5 };
  return /* @__PURE__ */ jsx2(
    Box,
    {
      component: "img",
      src: url,
      alt: post.text || "Shared photo",
      draggable: false,
      onError: () => {
        const probeUrl = renditionSrc(meta, origin);
        const probe = probeUrl ? fetch(probeUrl).then((answer) => answer.status, () => 0) : Promise.resolve(0);
        probe.then((status) => {
          if (!active) return;
          if (mediaFailureClass(status) === "failed-terminal") {
            setPhase("failed-terminal");
            return;
          }
          if (retriesRef.current <= 0) return;
          retriesRef.current -= 1;
          setTimeout(() => setAttempt((n) => n + 1), mediaRetryDelayMs(MEDIA_RETRY_BUDGET - retriesRef.current));
        });
      },
      sx: {
        display: "block",
        objectFit: "contain",
        ...box,
        transform,
        willChange: zoomed ? "transform" : void 0,
        userSelect: "none",
        WebkitUserSelect: "none",
        // Direct manipulation never interpolates; the settle back to fit does.
        ...zoomed ? {} : settleSx
      }
    },
    `viewer-${attempt}`
  );
}
function PluralImages(count) {
  return `${count} full-resolution image${count === 1 ? "" : "s"}`;
}
var endCardCopy = {
  "share-zip": { heading: "Share all originals", busy: "Sharing your originals\u2026" },
  "share-files": { heading: "Share all originals", busy: "Sharing your originals\u2026" },
  "zip-download": { heading: "Download all originals", busy: "Fetching your originals\u2026" }
};
function EndCardSlide({ count, onBulk, plan }) {
  const copy = endCardCopy[plan.kind] ?? endCardCopy["zip-download"];
  const [busy, setBusy] = useState2(false);
  const [error, setError] = useState2("");
  const run = async () => {
    setError("");
    setBusy(true);
    try {
      await onBulk();
    } catch (failure) {
      setError(failure?.message || "That did not work. Please try again.");
    } finally {
      setBusy(false);
    }
  };
  return /* @__PURE__ */ jsx2(
    Box,
    {
      "aria-roledescription": "slide",
      "aria-label": "Download all originals",
      sx: {
        flex: "0 0 100%",
        width: "100%",
        minWidth: 0,
        scrollSnapAlign: "start",
        scrollSnapStop: "always",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        p: 3
      },
      children: /* @__PURE__ */ jsxs2(Stack, { spacing: 2, alignItems: "center", sx: { maxWidth: 420, textAlign: "center" }, children: [
        /* @__PURE__ */ jsx2(PhotoLibraryOutlined, { sx: { fontSize: 44, color: viewerTokens.amber } }),
        /* @__PURE__ */ jsx2(Typography, { variant: "h3", sx: { color: viewerTokens.text }, children: copy.heading }),
        /* @__PURE__ */ jsx2(Typography, { variant: "body2", sx: { color: viewerTokens.textSecondary }, children: PluralImages(count) }),
        /* @__PURE__ */ jsx2(
          Button,
          {
            variant: "contained",
            disabled: busy,
            onClick: run,
            sx: {
              height: 48,
              px: 3,
              borderRadius: 9999,
              minWidth: 220,
              bgcolor: viewerTokens.amber,
              "&:hover": { bgcolor: viewerTokens.amberHover },
              color: viewerTokens.amberInk
            },
            children: busy ? copy.busy : copy.heading
          }
        ),
        error && /* @__PURE__ */ jsx2(Alert, { severity: "error", sx: { width: "100%" }, children: error })
      ] })
    }
  );
}
function PhotoViewer({ post, ids, actions, startIndex = 0, onClose }) {
  const photos = (Array.isArray(ids) ? ids : []).filter(Boolean);
  const origin = post?.origin ?? originOf(post);
  const total = viewerTotalCount(photos.length);
  const shareActive = overlayOriginalAction() === "share";
  const [position, setPosition] = useState2(Math.min(Math.max(startIndex, 0), Math.max(0, photos.length - 1)));
  const [zoom, setZoom] = useState2({ scale: 1, x: 0, y: 0 });
  const [chromeUp, setChromeUp] = useState2(true);
  const [originalUrl, setOriginalUrl] = useState2(null);
  const [viewport, setViewport] = useState2(() => ({ width: window.innerWidth, height: window.innerHeight }));
  const trackRef = useRef2(null);
  const chromeTimer = useRef2(null);
  const originals = useRef2(/* @__PURE__ */ new Map());
  const zoomRef = useRef2(zoom);
  zoomRef.current = zoom;
  const closeRef = useRef2(onClose);
  closeRef.current = onClose;
  const onEndCard = photos.length > 0 && position === photos.length;
  const activeId = !onEndCard ? photos[Math.min(position, photos.length - 1)] : null;
  const activeMeta = activeId ? post?.mediaMeta?.[activeId] ?? null : null;
  const fit = activeMeta?.width && activeMeta?.height ? fitDimensions(activeMeta.width, activeMeta.height, viewport.width, viewport.height) : null;
  const fitRef = useRef2(fit);
  fitRef.current = fit;
  const fitOfTarget = (target) => {
    if (fitRef.current) return fitRef.current;
    try {
      const rect = target?.getBoundingClientRect?.();
      if (!rect || !(rect.width > 0)) return null;
      const scale = zoomRef.current.scale || 1;
      return { width: rect.width / scale, height: rect.height / scale };
    } catch {
      return null;
    }
  };
  const revealChrome = useCallback(() => {
    setChromeUp(true);
    if (chromeTimer.current) clearTimeout(chromeTimer.current);
    chromeTimer.current = setTimeout(() => setChromeUp(false), POSITION_HOLD_MS);
  }, []);
  useEffect2(() => {
    revealChrome();
    return () => {
      if (chromeTimer.current) clearTimeout(chromeTimer.current);
    };
  }, [revealChrome]);
  useEffect2(() => {
    const measure = () => setViewport({ width: window.innerWidth, height: window.innerHeight });
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, []);
  const closeViewer = useCallback(() => {
    if (window.history.state?.porchlightPhotoViewer) window.history.back();
    else closeRef.current?.();
  }, []);
  useEffect2(() => {
    const root = document.documentElement;
    const prevOverflow = root.style.overflow;
    root.style.overflow = "hidden";
    window.history.pushState({ porchlightPhotoViewer: true }, "");
    playbackOverlayOpen();
    const onPop = () => closeRef.current?.();
    const onKey = (event) => {
      if (event.key === "Escape") closeViewer();
    };
    window.addEventListener("popstate", onPop);
    window.addEventListener("keydown", onKey);
    return () => {
      root.style.overflow = prevOverflow;
      window.removeEventListener("popstate", onPop);
      window.removeEventListener("keydown", onKey);
      playbackOverlayClose();
    };
  }, [closeViewer]);
  useEffect2(() => {
    const node = trackRef.current;
    if (!node) return void 0;
    const onWheel = (event) => {
      event.preventDefault();
      const current = fitOfTarget(event.target);
      if (!current) return;
      const ax = event.clientX - viewport.width / 2;
      const ay = event.clientY - viewport.height / 2;
      setZoom((prev) => wheelZoom(prev, event.deltaY, ax, ay, viewport.width, viewport.height, current.width, current.height));
    };
    node.addEventListener("wheel", onWheel, { passive: false });
    return () => node.removeEventListener("wheel", onWheel);
  }, [viewport]);
  useEffect2(() => {
    const node = trackRef.current;
    if (!node) return void 0;
    const onDoubleClick = (event) => {
      const current = fitOfTarget(event.target);
      if (!current) return;
      event.preventDefault();
      const ax = event.clientX - viewport.width / 2;
      const ay = event.clientY - viewport.height / 2;
      setZoom((prev) => zoomTo(
        prev,
        prev.scale > 1 ? 1 : DEFAULT_ZOOM,
        ax,
        ay,
        viewport.width,
        viewport.height,
        current.width,
        current.height
      ));
    };
    const onClick = () => revealChrome();
    node.addEventListener("dblclick", onDoubleClick);
    node.addEventListener("click", onClick);
    return () => {
      node.removeEventListener("dblclick", onDoubleClick);
      node.removeEventListener("click", onClick);
    };
  }, [viewport, revealChrome]);
  const pinchRef = useRef2(null);
  const panRef = useRef2(null);
  const lastTapRef = useRef2(null);
  const tapRef = useRef2(null);
  useEffect2(() => {
    const node = trackRef.current;
    if (!node) return void 0;
    const midpoint = (a, b) => ({ x: (a.clientX + b.clientX) / 2, y: (a.clientY + b.clientY) / 2 });
    const distance = (a, b) => Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
    const anchor = (x, y) => ({ x: x - viewport.width / 2, y: y - viewport.height / 2 });
    const onTouchStart = (event) => {
      if (event.touches.length === 2) {
        const current = fitOfTarget(event.target);
        if (!current) return;
        const [a, b] = event.touches;
        pinchRef.current = {
          startDistance: distance(a, b),
          startZoom: zoomRef.current,
          mid: midpoint(a, b)
        };
        event.preventDefault();
      } else if (event.touches.length === 1) {
        const touch = event.touches[0];
        tapRef.current = { x: touch.clientX, y: touch.clientY, moved: false };
        if (zoomRef.current.scale > 1) {
          panRef.current = { x: touch.clientX, y: touch.clientY };
          event.preventDefault();
        }
      }
    };
    const onTouchMove = (event) => {
      const current = fitRef.current;
      if (pinchRef.current && event.touches.length >= 2 && current) {
        const [a, b] = event.touches;
        const mid = midpoint(a, b);
        const anchored = anchor(mid.x, mid.y);
        event.preventDefault();
        setZoom(pinchTo(
          pinchRef.current.startZoom,
          pinchRef.current.startDistance,
          distance(a, b),
          anchored.x,
          anchored.y,
          viewport.width,
          viewport.height,
          current.width,
          current.height
        ));
      } else if (panRef.current && event.touches.length === 1) {
        const touch = event.touches[0];
        const dx = touch.clientX - panRef.current.x;
        const dy = touch.clientY - panRef.current.y;
        panRef.current = { x: touch.clientX, y: touch.clientY };
        if (tapRef.current) tapRef.current.moved = true;
        event.preventDefault();
        setZoom((prev) => {
          const bounds = panBounds(prev.scale, viewport.width, viewport.height, current?.width ?? Infinity, current?.height ?? Infinity);
          return { ...prev, x: Math.min(bounds.x, Math.max(-bounds.x, prev.x + dx)), y: Math.min(bounds.y, Math.max(-bounds.y, prev.y + dy)) };
        });
      }
    };
    const onTouchEnd = (event) => {
      if (pinchRef.current) {
        pinchRef.current = null;
        setZoom((prev) => {
          if (prev.scale <= 1.05) return { scale: 1, x: 0, y: 0 };
          const current = fitRef.current;
          if (!current) return prev;
          const bounds = panBounds(prev.scale, viewport.width, viewport.height, current.width, current.height);
          return { ...prev, x: Math.min(bounds.x, Math.max(-bounds.x, prev.x)), y: Math.min(bounds.y, Math.max(-bounds.y, prev.y)) };
        });
        return;
      }
      panRef.current = null;
      const touch = event.changedTouches[0];
      const tap = tapRef.current;
      tapRef.current = null;
      if (!tap || tap.moved || !fitOfTarget(event.target)) return;
      const now = performance.now();
      const prior = lastTapRef.current;
      if (prior && now - prior.at <= DOUBLE_TAP_MS && Math.hypot(prior.x - tap.x, prior.y - tap.y) <= 40) {
        lastTapRef.current = null;
        const anchored = anchor(tap.x, tap.y);
        event.preventDefault();
        setZoom((prev) => zoomTo(
          prev,
          prev.scale > 1 ? 1 : DEFAULT_ZOOM,
          anchored.x,
          anchored.y,
          viewport.width,
          viewport.height,
          fitRef.current.width,
          fitRef.current.height
        ));
        return;
      }
      lastTapRef.current = { at: now, x: tap.x, y: tap.y };
      revealChrome();
    };
    const onTouchCancel = () => {
      pinchRef.current = null;
      panRef.current = null;
      tapRef.current = null;
    };
    node.addEventListener("touchstart", onTouchStart, { passive: false });
    node.addEventListener("touchmove", onTouchMove, { passive: false });
    node.addEventListener("touchend", onTouchEnd, { passive: false });
    node.addEventListener("touchcancel", onTouchCancel);
    return () => {
      node.removeEventListener("touchstart", onTouchStart);
      node.removeEventListener("touchmove", onTouchMove);
      node.removeEventListener("touchend", onTouchEnd);
      node.removeEventListener("touchcancel", onTouchCancel);
    };
  }, [viewport, revealChrome]);
  useEffect2(() => {
    const node = trackRef.current;
    if (!node || zoom.scale <= 1) return void 0;
    let dragging = null;
    const onPointerDown = (event) => {
      if (event.pointerType === "touch") return;
      dragging = { x: event.clientX, y: event.clientY };
      node.setPointerCapture?.(event.pointerId);
      event.preventDefault();
    };
    const onPointerMove = (event) => {
      if (!dragging) return;
      const dx = event.clientX - dragging.x;
      const dy = event.clientY - dragging.y;
      dragging = { x: event.clientX, y: event.clientY };
      const current = fitRef.current;
      if (!current) return;
      setZoom((prev) => {
        const bounds = panBounds(prev.scale, viewport.width, viewport.height, current.width, current.height);
        return { ...prev, x: Math.min(bounds.x, Math.max(-bounds.x, prev.x + dx)), y: Math.min(bounds.y, Math.max(-bounds.y, prev.y + dy)) };
      });
    };
    const onPointerUp = (event) => {
      if (!dragging) return;
      dragging = null;
      node.releasePointerCapture?.(event.pointerId);
    };
    node.addEventListener("pointerdown", onPointerDown);
    node.addEventListener("pointermove", onPointerMove);
    node.addEventListener("pointerup", onPointerUp);
    node.addEventListener("pointercancel", onPointerUp);
    return () => {
      node.removeEventListener("pointerdown", onPointerDown);
      node.removeEventListener("pointermove", onPointerMove);
      node.removeEventListener("pointerup", onPointerUp);
      node.removeEventListener("pointercancel", onPointerUp);
    };
  }, [zoom.scale, viewport]);
  useEffect2(() => {
    const track = trackRef.current;
    if (track) track.style.overflowX = zoom.scale > 1 ? "hidden" : "auto";
  }, [zoom.scale]);
  useEffect2(() => {
    if (!activeId || !fit) return void 0;
    if (!needsOriginal(activeMeta, zoom.scale, viewport.width, window.devicePixelRatio || 1)) return void 0;
    const cached = originals.current.get(activeId);
    if (cached) {
      setOriginalUrl(cached);
      return void 0;
    }
    let live = true;
    (typeof actions?.getMedia === "function" ? actions.getMedia(activeId, "original", origin, null) : Promise.reject(new Error("Media is not available here yet."))).then((blob) => {
      if (!(blob instanceof Blob) || !live) return;
      const url = URL.createObjectURL(blob);
      originals.current.set(activeId, url);
      setOriginalUrl(url);
    }).catch(() => {
    });
    return () => {
      live = false;
    };
  }, [activeId, activeMeta, fit, zoom.scale, viewport, actions, origin]);
  const originalFor = onEndCard ? null : needsOriginal(activeMeta, zoom.scale, viewport.width, window.devicePixelRatio || 1) ? originalUrl ?? (activeId ? originals.current.get(activeId) : null) : null;
  const handleScroll = (event) => {
    const track = event.currentTarget;
    const next = carouselIndex(track.scrollLeft, track.clientWidth, total);
    if (next !== position) {
      setPosition(next);
      setZoom({ scale: 1, x: 0, y: 0 });
      setOriginalUrl(null);
      revealChrome();
    }
  };
  const [downloadError, setDownloadError] = useState2("");
  const fetchOriginal = async () => {
    if (!activeId) return null;
    if (typeof actions?.getMedia !== "function") throw new Error("Media is not available here yet.");
    const blob = await actions.getMedia(activeId, "original", origin, null);
    if (!(blob instanceof Blob)) throw new Error("Your hub did not return the original.");
    return blob;
  };
  const shareFromViewer = async () => {
    const blob = await fetchOriginal();
    if (!blob) return;
    await shareOriginal(blob, mediaFileName(activeId, blob));
  };
  const downloadOriginal = async () => {
    if (!activeId) return;
    const blob = await fetchOriginal();
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = mediaFileName(activeId, blob);
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 1e3);
  };
  const downloadActive = () => {
    setDownloadError("");
    return downloadOriginal().catch((failure) => setDownloadError(failure?.message || "That did not work. Please try again."));
  };
  const shareOrDownload = () => {
    setDownloadError("");
    const run = shareActive ? shareFromViewer : downloadOriginal;
    return run().catch((failure) => setDownloadError(failure?.message || "That did not work. Please try again."));
  };
  const chips = {
    position: "absolute",
    left: "50%",
    bottom: "calc(20px + env(safe-area-inset-bottom))",
    transform: "translateX(-50%)",
    zIndex: 3,
    px: 1.5,
    py: 0.5,
    borderRadius: 9999,
    bgcolor: viewerTokens.scrim,
    backdropFilter: viewerTokens.backdropBlur,
    WebkitBackdropFilter: viewerTokens.backdropBlur,
    opacity: chromeUp ? 1 : 0,
    pointerEvents: "none",
    ...fade()
  };
  return /* @__PURE__ */ jsxs2(
    Box,
    {
      role: "dialog",
      "aria-modal": "true",
      "aria-label": "Photo viewer",
      sx: {
        position: "fixed",
        inset: 0,
        zIndex: 1300,
        bgcolor: viewerTokens.page,
        color: viewerTokens.text,
        userSelect: "none",
        WebkitUserSelect: "none"
      },
      children: [
        /* @__PURE__ */ jsxs2(Box, { ref: trackRef, onScroll: handleScroll, sx: {
          display: "flex",
          width: "100%",
          height: "100%",
          overflowX: "auto",
          overflowY: "hidden",
          scrollSnapType: "x mandatory",
          scrollBehavior: "auto",
          overscrollBehaviorX: "contain",
          touchAction: "pan-x pan-y",
          scrollbarWidth: "none",
          "&::-webkit-scrollbar": { display: "none" }
        }, children: [
          photos.map((id) => /* @__PURE__ */ jsx2(
            Box,
            {
              "aria-roledescription": "slide",
              sx: {
                flex: "0 0 100%",
                width: "100%",
                minWidth: 0,
                scrollSnapAlign: "start",
                scrollSnapStop: "always",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                p: 0
              },
              children: /* @__PURE__ */ jsx2(
                ViewerSlidePhoto,
                {
                  post,
                  id,
                  actions,
                  origin,
                  originalUrl: originalFor,
                  active: !onEndCard,
                  zoom,
                  fit
                }
              )
            },
            id
          )),
          photos.length > 0 && /* @__PURE__ */ jsx2(
            EndCardSlide,
            {
              count: photos.length,
              plan: endCardPlan({ deviceClass: shareActive ? shareDeviceClass() : "desktop", photos: photos.length, shareCapable: shareFileCapable() }),
              onBulk: async () => {
                if (typeof actions?.bulkOriginals !== "function") throw new Error("Bulk download is not available here yet.");
                await actions.bulkOriginals(post);
              }
            }
          )
        ] }),
        /* @__PURE__ */ jsxs2(
          Stack,
          {
            direction: "row",
            spacing: 0.25,
            alignItems: "center",
            "aria-label": "Viewer controls",
            sx: {
              position: "absolute",
              top: "calc(8px + env(safe-area-inset-top))",
              right: 8,
              zIndex: 3,
              bgcolor: viewerTokens.scrim,
              backdropFilter: viewerTokens.backdropBlur,
              WebkitBackdropFilter: viewerTokens.backdropBlur,
              borderRadius: 9999,
              px: 0.75,
              py: 0.25,
              boxShadow: 2,
              opacity: chromeUp ? 1 : 0,
              pointerEvents: chromeUp ? "auto" : "none",
              ...fade()
            },
            children: [
              activeId && /* @__PURE__ */ jsx2(
                Button,
                {
                  size: "small",
                  onClick: () => shareOrDownload(),
                  sx: { px: 0.75, minWidth: 0, fontSize: 14, fontWeight: 600, color: viewerTokens.text },
                  children: shareActive ? /* @__PURE__ */ jsxs2(Fragment2, { children: [
                    /* @__PURE__ */ jsx2(ShareOutlined, { fontSize: "small", sx: { mr: 0.5 } }),
                    " Share"
                  ] }) : /* @__PURE__ */ jsx2(Fragment2, { children: "\u2193 Original" })
                }
              ),
              /* @__PURE__ */ jsx2(IconButton, { size: "small", "aria-label": "Close", onClick: closeViewer, sx: { color: viewerTokens.text }, children: /* @__PURE__ */ jsx2(CloseOutlined, { fontSize: "small" }) })
            ]
          }
        ),
        downloadError && /* @__PURE__ */ jsx2(Alert, { severity: "error", sx: {
          position: "absolute",
          top: "calc(48px + env(safe-area-inset-top))",
          left: "50%",
          transform: "translateX(-50%)",
          zIndex: 3,
          maxWidth: "min(92vw, 480px)"
        }, children: downloadError }),
        /* @__PURE__ */ jsxs2(
          Typography,
          {
            component: "div",
            "aria-label": `Image ${Math.min(position + 1, total)} of ${total}`,
            sx: { ...chips, fontSize: 12, lineHeight: "20px", color: viewerTokens.text },
            children: [
              position + 1,
              "/",
              total
            ]
          }
        )
      ]
    }
  );
}

// src/social.jsx
init_theme();

// src/video-mute.js
var heldMute = /* @__PURE__ */ new Map();
function heldSoundOn(mediaId) {
  const key = String(mediaId);
  return heldMute.has(key) ? heldMute.get(key) : null;
}
function holdMute(mediaId, soundOn) {
  heldMute.set(String(mediaId), soundOn === true);
}
function initialMuted(mediaId) {
  return heldSoundOn(mediaId) !== true;
}

// src/mentions.js
function mentionAnchor(value, caret = value.length) {
  const before = String(value).slice(0, Math.max(0, Math.min(caret, String(value).length)));
  const match = /(?:^|\s)@([^\n@]*)$/.exec(before);
  if (!match) return null;
  return { start: match.index + match[0].length - match[1].length - 1, query: match[1] };
}
function applyMention(value, anchor, name) {
  if (!anchor) return { text: value, caret: null };
  const before = String(value).slice(0, anchor.start);
  const after = String(value).slice(anchor.start + anchor.query.length + 1);
  const token = `@${name} `;
  return { text: `${before}${token}${after}`, caret: anchor.start + token.length };
}
function mentionDraft(anchor, appliedNames = []) {
  if (!anchor) return null;
  const query = anchor.query.trim();
  if (query && appliedNames.some((name) => typeof name === "string" && name.toLowerCase() === query.toLowerCase())) {
    return null;
  }
  return anchor;
}
function mentionSegments(body, names = []) {
  const text = String(body ?? "");
  const list = [...new Set((Array.isArray(names) ? names : []).filter((entry) => typeof entry === "string" && entry))].sort((a, b) => b.length - a.length);
  if (!text || !list.length) return text ? [{ text, mention: null }] : [];
  const escaped = list.map((name) => name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  const pattern = new RegExp(`(?:^|(?<=\\s))@(${escaped.join("|")})`, "gi");
  const segments = [];
  let last = 0;
  let match;
  while (match = pattern.exec(text)) {
    const canonical = list.find((name) => name.toLowerCase() === match[1].toLowerCase());
    if (match.index > last) segments.push({ text: text.slice(last, match.index), mention: null });
    segments.push({ text: match[0], mention: canonical });
    last = match.index + match[0].length;
  }
  const rest = text.slice(last);
  if (rest) segments.push({ text: rest, mention: null });
  return segments;
}

// src/media-recovery.js
var listeners = /* @__PURE__ */ new Set();
function onMediaRecovery(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

// src/avatar-face.js
import React3, { useEffect as useEffect3, useMemo, useState as useState3 } from "react";
import { Avatar } from "@mui/material";
function rungOf(metas, kind) {
  if (Array.isArray(metas)) return metas.find((rung) => rung?.kind === kind) ?? null;
  if (metas && typeof metas === "object") return metas[kind] ?? null;
  return null;
}
async function loadAvatarFace({ origin, did, metas, kind, load }) {
  const version = rungOf(metas, kind)?.sha256 ?? null;
  if (!origin || !did || !kind || !version) return null;
  const identity = mediaBlobKey({ origin, mediaId: `avatar:${did}`, kind, version });
  const cached = readMediaBlob(identity);
  if (cached) return cached;
  if (typeof load !== "function") return null;
  const blob = await load({ origin, did, kind, version });
  if (!(blob instanceof Blob)) return null;
  return putMediaBlob(identity, { url: URL.createObjectURL(blob), blob });
}
function useAvatarFaceUrl({ origin, did, metas, kind, load }) {
  const version = useMemo(() => rungOf(metas, kind)?.sha256 ?? null, [metas, kind]);
  const identity = useMemo(
    () => origin && did && kind && version ? mediaBlobKey({ origin, mediaId: `avatar:${did}`, kind, version }) : null,
    [origin, did, kind, version]
  );
  const [url, setUrl] = useState3(() => identity ? readMediaBlob(identity)?.url ?? null : null);
  useEffect3(() => {
    if (!identity) {
      setUrl(null);
      return void 0;
    }
    const cached = readMediaBlob(identity);
    if (cached?.url) {
      setUrl(cached.url);
      return void 0;
    }
    let alive = true;
    Promise.resolve().then(() => loadAvatarFace({ origin, did, metas, kind, load })).then((row) => {
      if (alive) setUrl(row?.url ?? null);
    }).catch(() => {
      if (alive) setUrl(null);
    });
    return () => {
      alive = false;
    };
  }, [identity, origin, did, metas, kind, load]);
  return url;
}
function AvatarFace({ origin, did, metas, kind, load, src, children, ...props }) {
  const url = useAvatarFaceUrl({ origin, did, metas, kind, load });
  return React3.createElement(Avatar, { ...props, src: url ?? src ?? void 0 }, children);
}

// src/brand.jsx
import React4 from "react";
import { Box as Box2, Typography as Typography2 } from "@mui/material";
import { jsx as jsx3, jsxs as jsxs3 } from "react/jsx-runtime";

// src/reactions.js
function reactionRowsOf(value) {
  return Array.isArray(value) ? value.filter((row) => row?.emoji) : [];
}
function ownEmojiRows(rows, ownDid) {
  const did = String(ownDid ?? "");
  return new Set((rows ?? []).filter((row) => String(row.memberDid ?? "") === did).map((row) => row.emoji));
}
function reflectReaction(base, { emoji, ownDid, isOwn, reaction }) {
  const did = String(ownDid ?? "");
  const rows = Array.isArray(base) ? base : [];
  if (!did || !emoji) return rows;
  const ownRow = (row) => row.emoji === emoji && String(row.memberDid ?? "") === did;
  if (isOwn) return rows.filter((row) => !ownRow(row));
  if (rows.some(ownRow)) return rows;
  return [...rows, {
    emoji,
    memberDid: did,
    _id: reaction?._id ?? `local:${emoji}`,
    createdAt: reaction?.createdAt ?? (/* @__PURE__ */ new Date()).toISOString()
  }];
}
function optimisticToggle(base, { emoji, ownDid, isOwn }) {
  const rows = Array.isArray(base) ? base : [];
  if (!emoji) return rows;
  return reflectReaction(rows, {
    emoji,
    ownDid,
    isOwn: isOwn ? true : false,
    reaction: isOwn ? null : { _id: `local:${emoji}`, createdAt: (/* @__PURE__ */ new Date()).toISOString() }
  });
}
function reactionChips(rows) {
  const byEmoji = /* @__PURE__ */ new Map();
  for (const row of Array.isArray(rows) ? rows : []) {
    if (!row?.emoji) continue;
    let chip = byEmoji.get(row.emoji);
    if (!chip) {
      chip = { emoji: row.emoji, reactors: [], seen: /* @__PURE__ */ new Set() };
      byEmoji.set(row.emoji, chip);
    }
    const did = String(row.memberDid ?? "");
    const key = did || `row:${row._id ?? row.createdAt ?? row.emoji}`;
    if (chip.seen.has(key)) continue;
    chip.seen.add(key);
    chip.reactors.push(row);
  }
  return [...byEmoji.values()];
}
function revealMachine({
  open,
  close = () => {
  },
  overPopover = () => false,
  intentMs = 300,
  pressMs = 500,
  graceMs = 140,
  settleMs = 500,
  timers = { setTimeout, clearTimeout }
} = {}) {
  const state = { intent: null, press: null, grace: null, settle: null, suppress: false, anchor: null };
  const clear = (slot) => {
    if (state[slot]) {
      timers.clearTimeout(state[slot]);
      state[slot] = null;
    }
  };
  const silence = () => {
    for (const slot of ["intent", "press", "grace", "settle"]) clear(slot);
    state.suppress = false;
  };
  return {
    // A plain tap; false only while a long-press release is being consumed.
    click() {
      if (state.suppress) {
        state.suppress = false;
        clear("settle");
        return false;
      }
      return true;
    },
    hoverStart(emoji, anchor, event) {
      if (event && event.pointerType && event.pointerType !== "mouse") return;
      if (state.grace) clear("grace");
      if (state.intent || state.press) return;
      state.anchor = anchor;
      state.intent = timers.setTimeout(() => {
        state.intent = null;
        open({ emoji, anchor: state.anchor });
      }, intentMs);
    },
    hoverLeave() {
      clear("intent");
      if (!state.anchor || state.grace) return;
      state.grace = timers.setTimeout(() => {
        state.grace = null;
        if (!overPopover()) {
          state.anchor = null;
          silence();
          close();
        }
      }, graceMs);
    },
    paperEnter() {
      clear("grace");
    },
    paperLeave() {
      silence();
      state.anchor = null;
      close();
    },
    pressStart(emoji, anchor) {
      if (state.grace) clear("grace");
      if (state.press || state.intent) return;
      state.anchor = anchor;
      state.press = timers.setTimeout(() => {
        state.press = null;
        state.suppress = true;
        open({ emoji, anchor });
      }, pressMs);
    },
    pressEnd() {
      if (state.press) {
        clear("press");
        return false;
      }
      if (state.suppress) {
        state.settle = timers.setTimeout(() => {
          state.settle = null;
          state.suppress = false;
        }, settleMs);
        return true;
      }
      return true;
    },
    silence
  };
}
function ownVoteOf(myVote) {
  return myVote === "up" || myVote === "down" ? myVote : null;
}
function upCountOf(upCount) {
  const value = Number(upCount);
  return Number.isFinite(value) ? value : null;
}
function castVoteState(post, direction) {
  const held = ownVoteOf(post?.myVote);
  if (direction !== "up" && direction !== "down") return null;
  const count = upCountOf(post?.upCount) ?? 0;
  if (held === direction) {
    return { vote: null, count: Math.max(0, count + (direction === "up" ? -1 : 0)) };
  }
  return {
    vote: direction,
    count: Math.max(0, count + (direction === "up" ? 1 : held === "up" ? -1 : 0))
  };
}

// src/groups.js
function canManageGroup(group = null, data = {}) {
  const did = data?.identity?.id;
  if (!group || !did) return false;
  if (group.createdBy && String(group.createdBy) === String(did)) return true;
  return (data?.members ?? []).some((entry) => entry?.did === did && entry?.role === "owner");
}

// src/group-settings.js
var GROUP_COLOR_ROWS = Object.freeze([
  { value: "#D88A24", name: "Amber" },
  { value: "#C4674B", name: "Terracotta" },
  { value: "#C9A227", name: "Gold" },
  { value: "#7E8F6E", name: "Sage" },
  { value: "#4E8F86", name: "Teal" },
  { value: "#5B7FA6", name: "Blue" },
  { value: "#8E6E95", name: "Plum" },
  { value: "#B0578D", name: "Rose" }
]);
var GROUP_PRIVACY_ROWS = Object.freeze([
  {
    value: "public",
    label: "Public",
    line: "Public: any member can find it and join."
  },
  {
    value: "private",
    label: "Private",
    line: "Private: invite-only."
  }
]);

// src/time.js
function dateOf(value) {
  if (!value || Number.isNaN(new Date(value).valueOf())) return "";
  return new Intl.DateTimeFormat(void 0, { dateStyle: "medium" }).format(new Date(value));
}
function relativeTime(value, now = Date.now()) {
  if (!value) return "";
  const then = new Date(value).valueOf();
  if (Number.isNaN(then)) return "";
  const seconds = Math.round((now - then) / 1e3);
  if (seconds < 60) return "now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days < 7) return `${days}d ago`;
  return dateOf(value);
}

// src/slice.js
var REPLY_SLICE_LIMIT = 4;
var replyKey = (reply) => String(reply?._id ?? reply?.id ?? "");
function rootResponsesOf(row) {
  if (Array.isArray(row?.replies)) return row.replies.length;
  const count = Number(row?.responseCount);
  return Number.isFinite(count) && count > 0 ? count : 0;
}
var newestFirst = (a, b) => a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0;
function ruledOrder(roots, countOf = rootResponsesOf) {
  return (roots ?? []).slice().sort((a, b) => {
    const threadedA = countOf(a) > 0 ? 1 : 0;
    const threadedB = countOf(b) > 0 ? 1 : 0;
    if (threadedA !== threadedB) return threadedB - threadedA;
    return newestFirst(a, b);
  });
}
function conversationOf(post) {
  const replies = Array.isArray(post?.replySlice) ? post.replySlice : [];
  const total = Number.isFinite(post?.replyTotal) ? post.replyTotal : replies.length;
  return { replies, total };
}
function windowOf(replies) {
  return ruledOrder(replies).slice(0, REPLY_SLICE_LIMIT);
}
function byIdMap(replies) {
  return new Map((replies ?? []).map((reply) => [replyKey(reply), reply]));
}
function repliesByParent(comments) {
  const byParent = /* @__PURE__ */ new Map();
  for (const reply of comments ?? []) {
    const key = reply?.parentId || "";
    if (!byParent.has(key)) byParent.set(key, []);
    byParent.get(key).push(reply);
  }
  for (const [key, rows] of byParent) {
    byParent.set(key, rows.sort((a, b) => a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0));
  }
  return byParent;
}
function sliceDisplay(post, local = null) {
  const base = conversationOf(post);
  const serverIds = byIdMap(base.replies);
  const pending = (local?.pending ?? []).filter((reply) => replyKey(reply) && !serverIds.has(replyKey(reply)));
  const confirmed = (local?.confirmed ?? []).filter((entry) => replyKey(entry?.reply) && !serverIds.has(replyKey(entry.reply))).map((entry) => entry.reply);
  const merged = [...base.replies.filter((entry) => replyKey(entry)), ...confirmed, ...pending];
  const windowed = windowOf(merged);
  const total = Math.max(base.total + pending.length + confirmed.length, windowed.length);
  return { replies: windowed, total };
}
function expanderCount(total) {
  return Math.max(0, total - REPLY_SLICE_LIMIT);
}
function reconcileConfirmed(confirmed, serverTotal) {
  return (confirmed ?? []).filter(
    (entry) => !Number.isFinite(serverTotal) || serverTotal < entry.basis + 1
  );
}
function rootAncestorId(id, rows) {
  const key = String(id ?? "");
  const byId = new Map((rows ?? []).filter((row) => replyKey(row)).map((row) => [replyKey(row), row]));
  let current = byId.get(key);
  let guard = 0;
  while (current?.parentId && guard < 32) {
    const parent = byId.get(current.parentId);
    if (!parent || parent === current) break;
    current = parent;
    guard += 1;
  }
  return current ? replyKey(current) : key;
}
function reconcileNestedRows(rows, served) {
  const servedIds = new Set((Array.isArray(served) ? served : []).map((row) => replyKey(row)).filter(Boolean));
  return {
    pending: (rows?.pending ?? []).filter((row) => !servedIds.has(replyKey(row))),
    confirmed: (rows?.confirmed ?? []).filter((row) => !servedIds.has(replyKey(row)))
  };
}
function pendingReply(post, body, { did, name, localId, parentId = null }) {
  return {
    _id: localId,
    postId: post?._id ?? post?.id ?? null,
    parentId,
    authorDid: did ?? null,
    authorName: name ?? null,
    body,
    createdAt: (/* @__PURE__ */ new Date()).toISOString()
  };
}

// src/link-preview.jsx
import React5, { useState as useState4 } from "react";
import { Box as Box3, Chip, Stack as Stack2, Typography as Typography3 } from "@mui/material";

// src/link-preview.js
function linkSegments(text) {
  const value = String(text ?? "");
  if (!value) return [];
  const pattern = /https?:\/\/[^\s<>"')\]]+/g;
  const segments = [];
  let last = 0;
  let match;
  while (match = pattern.exec(value)) {
    if (match.index > last) segments.push({ text: value.slice(last, match.index), url: null });
    segments.push({ text: match[0], url: match[0] });
    last = match.index + match[0].length;
  }
  const rest = value.slice(last);
  if (rest) segments.push({ text: rest, url: null });
  return segments;
}
function previewOrigin(post, data = {}) {
  return post?.origin ?? data?.server?.url ?? null;
}

// src/link-preview.jsx
import { jsx as jsx4, jsxs as jsxs4 } from "react/jsx-runtime";
var PROVIDER_LABELS = {
  youtube: "YouTube",
  spotify: "Spotify",
  apple_music: "Apple Music",
  oembed: "Shared link"
};
function LinkedBody({ text }) {
  const segments = linkSegments(text);
  if (segments.length === 0) return null;
  return segments.map(
    (segment, index) => segment.url ? /* @__PURE__ */ jsx4(
      Box3,
      {
        component: "a",
        href: segment.url,
        target: "_blank",
        rel: "noopener noreferrer",
        sx: { color: "primary.main", textDecoration: "underline", textUnderlineOffset: 2, overflowWrap: "anywhere" },
        children: segment.text
      },
      index
    ) : /* @__PURE__ */ jsx4("span", { children: segment.text }, index)
  );
}
function LinkPreviewBlock({ preview, origin, compact = false }) {
  const [playing2, setPlaying] = useState4(false);
  if (!preview || preview.kind !== "embed" && preview.kind !== "card") return null;
  if (preview.kind === "embed") {
    if (!preview.embedUrl) return null;
    if (!playing2) {
      return /* @__PURE__ */ jsxs4(
        Box3,
        {
          component: "button",
          type: "button",
          onClick: () => setPlaying(true),
          "aria-label": `Play ${PROVIDER_LABELS[preview.provider] ?? "the shared"} link`,
          sx: {
            mt: 1,
            maxWidth: "68ch",
            width: "100%",
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: 1.5,
            px: 1.25,
            py: 0.75,
            border: 1,
            borderRadius: 2,
            borderColor: "divider",
            bgcolor: "background.default",
            cursor: "pointer",
            textAlign: "left",
            "&:hover": { bgcolor: "action.hover" }
          },
          children: [
            /* @__PURE__ */ jsxs4(Stack2, { spacing: 0, sx: { minWidth: 0 }, children: [
              /* @__PURE__ */ jsx4(Typography3, { variant: "body2", fontWeight: 600, fontSize: 14, sx: { overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }, children: PROVIDER_LABELS[preview.provider] ?? "Shared link" }),
              /* @__PURE__ */ jsx4(Typography3, { variant: "caption", color: "porchlight.muted", children: "Tap to play" })
            ] }),
            /* @__PURE__ */ jsx4(Box3, { component: "span", "aria-hidden": true, sx: { fontSize: 20, lineHeight: 1, color: "text.primary", flexShrink: 0 }, children: "\u25B6" })
          ]
        }
      );
    }
    return /* @__PURE__ */ jsx4(
      Box3,
      {
        component: "iframe",
        src: preview.embedUrl,
        title: preview.provider ? `${PROVIDER_LABELS[preview.provider] ?? preview.provider} embed` : "Link embed",
        allow: "encrypted-media; clipboard-write; picture-in-picture",
        allowFullScreen: true,
        referrerPolicy: "strict-origin-when-cross-origin",
        sx: {
          mt: 1,
          display: "block",
          width: "100%",
          maxWidth: compact ? 320 : 480,
          aspectRatio: "16 / 9",
          border: 0,
          borderRadius: 2
        }
      }
    );
  }
  const og = preview.ogImage ?? null;
  const [imageFailed, setImageFailed] = useState4(false);
  const src = og?.mediaId && !imageFailed ? renditionSrc(og, origin) : null;
  return /* @__PURE__ */ jsxs4(
    Box3,
    {
      component: "a",
      href: preview.url,
      target: "_blank",
      rel: "noopener noreferrer",
      "aria-label": preview.title ? `Open ${preview.title}` : "Open shared link",
      sx: {
        mt: 1,
        display: "block",
        maxWidth: "68ch",
        overflow: "hidden",
        p: 1,
        border: 1,
        borderRadius: 2,
        borderColor: "divider",
        bgcolor: "background.default",
        color: "inherit",
        textDecoration: "none"
      },
      children: [
        src && /* @__PURE__ */ jsx4(
          Box3,
          {
            component: "img",
            src,
            srcSet: og.renditions?.length ? renditionSrcset(og, origin) || void 0 : void 0,
            sizes: "(max-width: 899px) calc(100vw - 32px), 68ch",
            alt: preview.title ?? preview.siteName ?? "Link preview",
            loading: "lazy",
            decoding: "async",
            referrerPolicy: "no-referrer",
            onError: () => setImageFailed(true),
            sx: {
              display: "block",
              width: "100%",
              aspectRatio: og.width && og.height ? `${og.width} / ${og.height}` : "2 / 1",
              objectFit: "cover",
              borderRadius: 1,
              bgcolor: "background.paper",
              maxHeight: compact ? 140 : 260
            }
          }
        ),
        /* @__PURE__ */ jsxs4(Stack2, { direction: "row", spacing: 1, alignItems: "center", sx: { pt: src ? 0.75 : 0 }, children: [
          /* @__PURE__ */ jsxs4(Stack2, { sx: { minWidth: 0, flex: 1 }, children: [
            preview.title && /* @__PURE__ */ jsx4(Typography3, { variant: "body2", fontWeight: 600, fontSize: 14, sx: { overflow: "hidden", display: "-webkit-box", WebkitLineClamp: compact ? 1 : 2, WebkitBoxOrient: "vertical" }, children: preview.title }),
            preview.siteName && /* @__PURE__ */ jsx4(Typography3, { variant: "caption", color: "porchlight.muted", children: preview.siteName })
          ] }),
          /* @__PURE__ */ jsx4(Chip, { label: hostOf(preview.url), size: "small", variant: "outlined", sx: { fontSize: "0.6875rem", height: "22px", flexShrink: 0 } })
        ] })
      ]
    }
  );
}
function hostOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return null;
  }
}

// src/member-directory.js
async function copyLink(text) {
  if (!text) return false;
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    try {
      const field = document.createElement("textarea");
      field.value = text;
      field.setAttribute("readonly", "");
      field.style.position = "fixed";
      field.style.opacity = "0";
      document.body.appendChild(field);
      field.select();
      const ok = document.execCommand("copy");
      field.remove();
      return ok;
    } catch {
      return false;
    }
  }
}

// src/share.js
function photoCountOf(post) {
  if (post?.type !== "photo") return 0;
  const refs = Array.isArray(post?.mediaRefs) ? post.mediaRefs : [];
  return refs.map((ref) => typeof ref === "string" ? ref : ref?.mediaId ?? ref?._id ?? ref?.id).filter(Boolean).length;
}
function shareAuthorName(post, data) {
  const attributed = (post?.author?.name ?? post?.authorName ?? "").trim();
  if (attributed) return attributed;
  if (String(post?.authorId ?? post?.authorDid ?? "") === String(data?.identity?.id ?? "")) {
    return (data?.identity?.name ?? "").trim() || "A family member";
  }
  return "A family member";
}
function postShareText(post, ownDid, data = {}) {
  const count = photoCountOf(post);
  if (count > 0) return `${shareAuthorName(post, data)} shared ${count} photos on Porchlight`;
  const isOwn = ownDid != null && String(post?.authorId ?? post?.authorDid ?? "") === String(ownDid);
  if (isOwn) return "View my post on Porchlight";
  return `${shareAuthorName(post, data)} posted on Porchlight`;
}
function postDeepLink(post, base) {
  return `${String(base ?? "").replace(/\/+$/, "")}/posts/${encodeURIComponent(identityOf(post))}`;
}
async function sharePost({
  post,
  ownDid,
  data = {},
  base,
  share,
  copy
} = {}) {
  const link = postDeepLink(post, base);
  const text = postShareText(post, ownDid, data);
  const nativeShare = share ?? (typeof navigator !== "undefined" ? navigator?.share : void 0);
  if (typeof nativeShare === "function") {
    try {
      await nativeShare({ title: "Porchlight", text, url: link });
      return { mode: "native" };
    } catch (error) {
      if (error?.name === "AbortError") return { mode: "native", dismissed: true };
    }
  }
  const copied = Boolean(await (copy ?? copyLink)(link));
  return { mode: "copy", copied, link, text };
}

// src/lifecycle.js
var viewerDidOf = (data) => data?.identity?.id ?? null;
var authorDidOf = (row) => row?.authorDid ?? row?.authorId ?? null;
function viewerIsNetworkOwner(data) {
  const did = viewerDidOf(data);
  return Boolean(did) && (data?.members ?? []).some(
    (entry) => entry?.did === did && entry?.role === "owner"
  );
}
var sameOriginAsViewerNetwork = (post, data) => {
  if (!originOf(post) || !networkId(data)) return true;
  return String(originOf(post)) === String(networkId(data));
};
function canEditPost(post, data = {}) {
  return Boolean(post) && Boolean(visibleAtOrigin(post, data)) && authorDidOf(post) === viewerDidOf(data);
}
function canDeletePost(post, data = {}) {
  if (!post || !visibleAtOrigin(post, data)) return false;
  return canEditPost(post, data) || viewerIsNetworkOwner(data) && sameOriginAsViewerNetwork(post, data);
}
function canEditComment(row, data = {}) {
  return Boolean(row) && authorDidOf(row) === viewerDidOf(data);
}
function canDeleteComment(row, data = {}) {
  if (!row) return false;
  if (canEditComment(row, data)) return true;
  return viewerIsNetworkOwner(data) && sameOriginAsViewerNetwork(row, data);
}
function lifecycleMenuItems({ edit = false, remove = false } = {}) {
  const items = [];
  if (edit) items.push("edit");
  if (remove) items.push("delete");
  return items;
}
function editLocationRows(post, data = {}) {
  const did = viewerDidOf(data);
  const rows = (data?.groups ?? []).filter((group) => Array.isArray(group?.members) && group.members.includes(did)).map((group) => ({ id: identityOf(group), label: group.name ?? identityOf(group) }));
  return [{ id: "", label: "General timeline" }, ...rows];
}
function currentLocationId(post) {
  return post?.groupId ? String(post.groupId) : "";
}
var GENERAL_LOCATION_ID = "";

// src/emoji-usage.js
var cache = /* @__PURE__ */ new Map();
function keyOf(connection) {
  const identity = connection?.identity?.id ? String(connection.identity.id) : "";
  let origin = "";
  try {
    origin = connection?.url ? new URL(connection.url).origin : "";
  } catch {
    origin = "";
  }
  return `${identity}@${origin}`;
}
function cachedUsage(connection) {
  return cache.get(keyOf(connection)) ?? [];
}
async function loadUsage(connection, read) {
  const key = keyOf(connection);
  const current = read instanceof Promise ? await read : read;
  const list = Array.isArray(current?.emoji) ? current.emoji.filter((row) => typeof row === "string" && row.length > 0) : null;
  if (list) cache.set(key, list);
  return cache.get(key) ?? [];
}
function recordSessionUse(connection, emoji) {
  const key = keyOf(connection);
  const list = cache.get(key) ?? [];
  const next = [emoji, ...list.filter((row) => row !== emoji)];
  cache.set(key, next);
  return next;
}

// src/social.jsx
import { Fragment as Fragment3, jsx as jsx6, jsxs as jsxs6 } from "react/jsx-runtime";
var EmojiPicker2 = lazy(() => Promise.resolve().then(() => (init_emoji_picker(), emoji_picker_exports)));
var memberName = (id, data) => id && id === data.identity?.id ? data.identity.name || "You" : "Member";
var messageOf = (error) => error?.message || "That did not work. Please try again.";
function invoke(actions, key, ...args) {
  if (typeof actions?.[key] !== "function") throw new Error("This action is not available here yet.");
  return actions[key](...args);
}
function useOperation() {
  const [busy, setBusy] = useState6(false);
  const [error, setError] = useState6("");
  async function run(callback, onSuccess, onFailure) {
    setError("");
    setBusy(true);
    try {
      if (typeof callback !== "function") throw new Error("This action is not available here yet.");
      const result = await callback();
      await onSuccess?.(result);
      return result;
    } catch (failure) {
      setError(messageOf(failure));
      onFailure?.(failure);
      return void 0;
    } finally {
      setBusy(false);
    }
  }
  return { busy, error, setError, run };
}
function MediaItem({ id, post, actions, detail = false, slide = false, index = 0, onExpand = null }) {
  const meta = post?.mediaMeta?.[id] ?? null;
  const direct = Boolean(meta && actions?.mediaTransport);
  const [resource, setResource] = useState6(null);
  const [phase, setPhase] = useState6("pending");
  const [attempt, setAttempt] = useState6(0);
  const phaseRef = useRef3(phase);
  phaseRef.current = phase;
  const attemptRef = useRef3(attempt);
  attemptRef.current = attempt;
  const failedAttemptRef = useRef3(-1);
  const frameRef = useRef3(null);
  const visibleRef = useRef3(false);
  const retriesRef = useRef3(MEDIA_RETRY_BUDGET);
  const retryTimerRef = useRef3(null);
  const guardTimerRef = useRef3(null);
  const operation = useOperation();
  const getMedia = actions?.getMedia;
  const origin = post?.origin ?? originOf(post);
  const clearSlotTimers = useCallback2(() => {
    if (retryTimerRef.current) {
      clearTimeout(retryTimerRef.current);
      retryTimerRef.current = null;
    }
    if (guardTimerRef.current) {
      clearTimeout(guardTimerRef.current);
      guardTimerRef.current = null;
    }
  }, []);
  const slotFailed = useCallback2((status, at = null) => {
    const atNow = attemptRef.current;
    if (at != null && at !== atNow) return;
    if (failedAttemptRef.current === atNow) return;
    failedAttemptRef.current = atNow;
    clearSlotTimers();
    if (mediaFailureClass(status) === "failed-terminal") {
      setPhase("failed-terminal");
      return;
    }
    setPhase("failed-retryable");
    if (!visibleRef.current || retriesRef.current <= 0) return;
    retriesRef.current -= 1;
    const retryNumber = MEDIA_RETRY_BUDGET - retriesRef.current;
    retryTimerRef.current = setTimeout(() => {
      retryTimerRef.current = null;
      setAttempt((n) => n + 1);
    }, mediaRetryDelayMs(retryNumber));
  }, [clearSlotTimers]);
  const slotLoaded = useCallback2(() => {
    clearSlotTimers();
    setPhase("loaded");
  }, [clearSlotTimers]);
  useEffect5(() => {
    const node = frameRef.current;
    if (!node || typeof IntersectionObserver !== "function") {
      visibleRef.current = true;
      return clearSlotTimers;
    }
    const observer = new IntersectionObserver((entries) => {
      const entry = entries[entries.length - 1];
      visibleRef.current = entry.isIntersecting;
      if (!entry.isIntersecting) {
        if (retryTimerRef.current) {
          clearTimeout(retryTimerRef.current);
          retryTimerRef.current = null;
        }
        return;
      }
      if (phaseRef.current !== "failed-retryable" || retryTimerRef.current) return;
      retriesRef.current = MEDIA_RETRY_BUDGET;
      setAttempt((n) => n + 1);
    }, { rootMargin: "160px", threshold: 0.01 });
    observer.observe(node);
    return () => {
      clearSlotTimers();
      observer.disconnect();
    };
  }, [clearSlotTimers]);
  useEffect5(() => onMediaRecovery(() => {
    if (phaseRef.current !== "failed-retryable" || !visibleRef.current) return;
    clearSlotTimers();
    retriesRef.current = MEDIA_RETRY_BUDGET;
    setAttempt((n) => n + 1);
  }), [clearSlotTimers]);
  useEffect5(() => {
    if (direct) return void 0;
    const kind = meta ? rungKindForViewport(meta, window.innerWidth, window.devicePixelRatio) : "original";
    const version = kind ? meta?.renditions?.find((rung) => rung.kind === kind)?.sha256 ?? null : null;
    const identity = mediaBlobKey({ origin, mediaId: id, kind: kind ?? "original", version });
    const posterSha = post.type === "video" ? meta?.poster?.sha256 ?? null : null;
    const posterIdentity = posterSha ? mediaBlobKey({ origin, mediaId: id, kind: "poster", version: posterSha }) : null;
    const cached = readMediaBlob(identity);
    if (cached) {
      setResource({
        blob: cached.blob,
        url: cached.url,
        posterUrl: posterIdentity ? readMediaBlob(posterIdentity)?.url ?? null : null,
        ...cached.shape ?? {}
      });
      setPhase("loaded");
      return void 0;
    }
    let active = true;
    setResource(null);
    setPhase("pending");
    const posterPromise = posterIdentity ? getMedia(id, "poster", origin, posterSha).catch(() => null) : null;
    Promise.resolve().then(() => {
      if (typeof getMedia !== "function") throw new Error("Media is not available here yet.");
      const bytesPromise = getMedia(id, kind ?? "original", origin, version);
      return Promise.all([bytesPromise, posterPromise]);
    }).then(async ([blob, posterBlob]) => {
      if (!(blob instanceof Blob)) throw new Error("Your hub did not return the media.");
      if (!active) return;
      const shape = meta && meta.width ? { width: meta.width, height: meta.height } : await mediaShape(blob, post.type);
      const url = URL.createObjectURL(blob);
      const posterUrlObj = posterBlob instanceof Blob ? URL.createObjectURL(posterBlob) : null;
      const row = putMediaBlob(identity, { url, blob, shape });
      if (posterIdentity && posterUrlObj) putMediaBlob(posterIdentity, { url: posterUrlObj, blob: posterBlob });
      setResource({ blob, url: row.url, posterUrl: posterUrlObj ?? null, ...shape });
      setPhase("loaded");
    }).catch((error) => {
      if (active) slotFailed(error?.status, attempt);
    });
    return () => {
      active = false;
    };
  }, [id, getMedia, origin, direct, attempt, slotFailed]);
  const media = post.type === "photo" || post.type === "video";
  const breakout = !detail && media && !slide;
  const mediaSx = breakout ? {
    // img/video are replaced elements: the breakout needs both the negative
    // rail margins and the matching width so the element spans the full
    // post-container width (100% + both rail paddings).
    width: { xs: `calc(100% + ${2 * photoFirst.rail}px)`, lg: `calc(100% + ${2 * photoFirst.postPad}px)` },
    mx: { xs: -photoFirst.rail / 8, lg: -(photoFirst.postPad / 8) },
    borderRadius: { xs: "0px", lg: `${photoFirst.desktopMediaRadius}px` },
    overflow: "hidden",
    display: "block",
    bgcolor: photoFirst.mediaWash
  } : {
    display: "block",
    width: media || post.type === "audio" ? "100%" : void 0,
    maxHeight: detail ? 720 : void 0,
    borderRadius: detail ? 2 : slide ? 0 : void 0,
    bgcolor: media ? photoFirst.mediaWash : "background.default"
  };
  const reserved = resource?.width && resource?.height ? resource.width / resource.height : stampedAspect(meta);
  const portraitMasked = post.type === "video" && videoInlineMasked(reserved);
  const fitSx = media && reserved ? portraitMasked ? { aspectRatio: "3 / 4", overflow: "hidden", ...detail ? { maxWidth: "540px" } : {} } : { aspectRatio: `${reserved}`, maxHeight: detail ? 720 : photoFirst.extremeCap, objectFit: "contain" } : {};
  const maskedVideoSx = portraitMasked ? { display: "block", width: "100%", height: "100%", objectFit: "cover", cursor: "pointer" } : { display: "block", width: "100%", cursor: "pointer" };
  const slideRailSx = slide ? {
    pl: { xs: `${photoFirst.rail}px`, lg: `${photoFirst.postPad}px` },
    pr: { xs: `${photoFirst.rail}px`, lg: `${photoFirst.postPad}px` }
  } : {};
  const videoPoster = meta ? posterUrl(meta, origin) : null;
  const videoPlayable = meta ? playableVideoUrl(meta, origin) : null;
  const [soundOn, setSoundOn] = useState6(() => heldSoundOn(id) ?? false);
  const [panelOpen, setPanelOpen] = useState6(false);
  const [playing2, setPlaying] = useState6(true);
  const videoRef = useRef3(null);
  const slotKeyRef = useRef3(null);
  if (!slotKeyRef.current) slotKeyRef.current = newPlaybackSlotKey(id);
  const [overlayShown, setOverlayShown] = useState6(false);
  const tapTogglesOverlay = typeof navigator === "object" && navigator.maxTouchPoints > 0;
  const togglePlayback = (element) => {
    if (!element) return;
    if (element.paused) {
      const resume = element.play();
      if (resume?.catch) resume.catch(() => {
      });
    } else element.pause();
  };
  const tapVideo = (event) => {
    if (!panelOpen) {
      setPanelOpen(true);
      setOverlayShown(true);
      const element = event.currentTarget;
      element.muted = false;
      setSoundOn(!element.muted);
      holdMute(id, !element.muted);
      return;
    }
    togglePlayback(event.currentTarget);
  };
  const syncGeometry = (event) => {
    if (!meta.width && event.target) setResource({ width: event.target.videoWidth, height: event.target.videoHeight });
  };
  const mirrorMute = (event) => {
    const value = !event.currentTarget.muted;
    setSoundOn(value);
    holdMute(id, value);
  };
  const toggleMute = () => {
    const element = videoRef.current;
    if (!element) return;
    element.muted = !element.muted;
    setSoundOn(!element.muted);
    holdMute(id, !element.muted);
  };
  const restartVideo = () => {
    const element = videoRef.current;
    if (!element) return;
    element.currentTime = 0;
    togglePlayback(element);
  };
  const fullscreenVideo = () => {
    const element = videoRef.current;
    if (!element) return;
    if (typeof element.requestFullscreen === "function") element.requestFullscreen().catch(() => {
    });
    else if (typeof element.webkitEnterFullscreen === "function") element.webkitEnterFullscreen();
  };
  const watchPlayback = (event) => {
    setPlaying(event.type === "play");
    notifyPlayback(slotKeyRef.current, event.type === "play");
  };
  const governancePlay = useCallback2(() => {
    const element = videoRef.current;
    if (!element) return false;
    const resume = element.play();
    if (resume?.catch) {
      resume.catch((error) => {
        if (error?.name === "AbortError") return;
        playbackSlotPlayRejected(slotKeyRef.current);
      });
    }
    return true;
  }, []);
  const governancePause = useCallback2(() => {
    const element = videoRef.current;
    if (element) element.pause();
  }, []);
  const attachVideo = useCallback2((element) => {
    videoRef.current = element;
    if (!element) return;
    element.muted = initialMuted(id);
    playbackSlotElementReady(slotKeyRef.current);
  }, [id]);
  useEffect5(() => {
    if (post.type !== "video") return void 0;
    const release = registerPlaybackSlot(slotKeyRef.current, id, { play: governancePlay, pause: governancePause });
    if (typeof IntersectionObserver !== "function") {
      slotVisibility(slotKeyRef.current, true);
      return release;
    }
    const playbackObserver = new IntersectionObserver((entries) => {
      const entry = entries[entries.length - 1];
      slotVisibility(slotKeyRef.current, entry.isIntersecting);
    }, { rootMargin: "0px", threshold: 0.5 });
    playbackObserver.observe(frameRef.current);
    return () => {
      playbackObserver.disconnect();
      release();
    };
  }, [post.type, id, governancePlay, governancePause]);
  const classifyDirectFailure = (url) => {
    const at = attemptRef.current;
    const timeoutSignal = typeof AbortSignal !== "undefined" && typeof AbortSignal.timeout === "function" ? AbortSignal.timeout(MEDIA_ATTEMPT_TIMEOUT_MS) : void 0;
    fetch(url, { signal: timeoutSignal }).then(
      (probe) => slotFailed(probe.status, at),
      () => slotFailed(0, at)
    );
  };
  useEffect5(() => {
    if (!direct || post.type !== "photo" && post.type !== "video") return void 0;
    guardTimerRef.current = setTimeout(() => {
      guardTimerRef.current = null;
      if (phaseRef.current === "loaded" || phaseRef.current === "failed-terminal") return;
      slotFailed(0);
    }, MEDIA_ATTEMPT_TIMEOUT_MS);
    return () => {
      if (guardTimerRef.current) {
        clearTimeout(guardTimerRef.current);
        guardTimerRef.current = null;
      }
    };
  }, [direct, post.type, attempt, slotFailed]);
  const directImg = post.type === "photo" && direct;
  const directVideo = post.type === "video" && direct;
  const playbackPanel = panelOpen && /* @__PURE__ */ jsx6(
    Box5,
    {
      "aria-label": "Playback panel",
      sx: { position: "absolute", inset: 0, pointerEvents: "none", display: "flex", alignItems: "flex-end", p: 1 },
      children: /* @__PURE__ */ jsxs6(Stack4, { direction: "row", spacing: 0.25, sx: {
        pointerEvents: "auto",
        bgcolor: "background.paper",
        borderRadius: 9999,
        border: "1px solid",
        borderColor: "divider",
        px: 0.5,
        py: 0.25,
        boxShadow: 2
      }, children: [
        /* @__PURE__ */ jsx6(IconButton3, { "aria-label": playing2 ? "Pause" : "Play", size: "small", onClick: () => togglePlayback(videoRef.current), children: playing2 ? /* @__PURE__ */ jsx6(PauseOutlined, { fontSize: "small" }) : /* @__PURE__ */ jsx6(PlayArrowOutlined, { fontSize: "small" }) }),
        /* @__PURE__ */ jsx6(IconButton3, { "aria-label": "Restart", size: "small", onClick: restartVideo, children: /* @__PURE__ */ jsx6(ReplayOutlined, { fontSize: "small" }) }),
        /* @__PURE__ */ jsx6(IconButton3, { "aria-label": soundOn ? "Mute" : "Unmute", size: "small", onClick: toggleMute, children: soundOn ? /* @__PURE__ */ jsx6(VolumeUpOutlined, { fontSize: "small" }) : /* @__PURE__ */ jsx6(VolumeOffOutlined, { fontSize: "small" }) }),
        /* @__PURE__ */ jsx6(IconButton3, { "aria-label": "Full screen", size: "small", onClick: fullscreenVideo, children: /* @__PURE__ */ jsx6(FullscreenOutlined, { fontSize: "small" }) })
      ] })
    }
  );
  return /* @__PURE__ */ jsxs6(
    Box5,
    {
      ref: frameRef,
      onMouseEnter: () => setOverlayShown(true),
      onMouseLeave: () => setOverlayShown(false),
      sx: { position: post.type === "photo" || post.type === "video" ? "relative" : void 0 },
      children: [
        directImg && phase !== "failed-terminal" && /* @__PURE__ */ jsx6(
          Box5,
          {
            component: "img",
            src: renditionSrc(meta, origin) ?? playableVideoUrl(meta, origin),
            srcSet: renditionSrcset(meta, origin) || void 0,
            sizes: detail ? detailImageSizes(meta) : timelineImageSizes(),
            alt: post.text || "Shared photo",
            loading: "lazy",
            decoding: "async",
            onLoad: slotLoaded,
            onClick: (event) => {
              if (tapTogglesOverlay) setOverlayShown((shown) => !shown);
              event.stopPropagation();
            },
            onError: () => classifyDirectFailure(renditionSrc(meta, origin) ?? playableVideoUrl(meta, origin)),
            sx: { ...mediaSx, ...fitSx }
          },
          `img-${attempt}`
        ),
        post.type === "photo" && !direct && resource && /* @__PURE__ */ jsx6(
          Box5,
          {
            component: "img",
            src: resource.url,
            alt: post.text || "Shared photo",
            loading: "lazy",
            onClick: (event) => {
              if (tapTogglesOverlay) setOverlayShown((shown) => !shown);
              event.stopPropagation();
            },
            sx: { ...mediaSx, ...fitSx }
          }
        ),
        directVideo && phase !== "failed-terminal" && /* @__PURE__ */ jsxs6(Box5, { sx: { position: "relative", ...mediaSx, ...fitSx }, children: [
          /* @__PURE__ */ jsx6(
            Box5,
            {
              component: "video",
              src: videoPlayable,
              poster: videoPoster,
              muted: true,
              playsInline: true,
              preload: "metadata",
              onClick: tapVideo,
              ref: attachVideo,
              onLoadedMetadata: (event) => {
                syncGeometry(event);
                slotLoaded();
              },
              onPlay: watchPlayback,
              onPause: watchPlayback,
              onVolumeChange: mirrorMute,
              onError: () => classifyDirectFailure(videoPlayable),
              sx: maskedVideoSx
            }
          ),
          playbackPanel
        ] }, `vid-${attempt}`),
        post.type === "video" && !direct && resource && /* @__PURE__ */ jsxs6(Box5, { sx: { position: "relative", ...mediaSx, ...fitSx }, children: [
          /* @__PURE__ */ jsx6(
            Box5,
            {
              component: "video",
              src: resource.url,
              poster: resource.posterUrl ?? void 0,
              muted: true,
              playsInline: true,
              onClick: tapVideo,
              ref: attachVideo,
              onLoadedMetadata: (event) => {
                syncGeometry(event);
                slotLoaded();
              },
              onPlay: watchPlayback,
              onPause: watchPlayback,
              onVolumeChange: mirrorMute,
              onError: () => slotFailed(0),
              sx: maskedVideoSx
            }
          ),
          playbackPanel
        ] }),
        post.type === "audio" && /* @__PURE__ */ jsx6(Box5, { component: "audio", src: resource?.url, controls: true, preload: "none", sx: { width: "100%" } }),
        post.type === "audio" && phase === "failed-terminal" && /* @__PURE__ */ jsx6(Typography5, { component: "p", sx: { fontSize: 13, lineHeight: "20px", color: "porchlight.muted" }, children: "Your hub did not return the media." }),
        phase === "failed-terminal" && (post.type === "photo" || post.type === "video") && !resource && /* @__PURE__ */ jsx6(Box5, { role: "status", "aria-label": "This moment is no longer available", sx: {
          ...mediaSx,
          ...fitSx,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          px: 2
        }, children: /* @__PURE__ */ jsx6(Typography5, { component: "span", sx: { textAlign: "center", fontSize: 13, lineHeight: "20px", color: "porchlight.muted" }, children: "Your hub did not return the media." }) }),
        !resource && !direct && post.type !== "audio" && phase !== "failed-terminal" && reserved ? /* @__PURE__ */ jsx6(Box5, { role: "status", "aria-label": "Loading media", sx: { ...mediaSx, ...fitSx } }) : !resource && !direct && post.type !== "audio" && phase === "pending" && !reserved && /* @__PURE__ */ jsx6(CircularProgress, { size: 20, "aria-label": "Loading media", sx: slideRailSx }),
        operation.error && /* @__PURE__ */ jsx6(Alert2, { severity: "error", sx: slideRailSx, children: operation.error }),
        (post.type === "photo" || post.type === "video") && (directImg || directVideo || resource) ? (() => {
          const shareOriginalHere = overlayOriginalAction() === "share";
          return /* @__PURE__ */ jsx6(
            MediaOverlay,
            {
              shown: overlayShown,
              downloadBusy: operation.busy,
              onDownload: () => operation.run(async () => {
                const blob = resource?.blob ?? await invoke(actions, "getMedia", id, "original", origin);
                if (!(blob instanceof Blob)) throw new Error("Your hub did not return the original.");
                const url = URL.createObjectURL(blob);
                const anchor = document.createElement("a");
                anchor.href = url;
                anchor.download = mediaFileName(id, blob);
                anchor.click();
                setTimeout(() => URL.revokeObjectURL(url), 1e3);
              }),
              shareAction: shareOriginalHere ? { busy: operation.busy, run: () => operation.run(async () => {
                const blob = resource?.blob ?? await invoke(actions, "getMedia", id, "original", origin);
                if (!(blob instanceof Blob)) throw new Error("Your hub did not return the original.");
                await shareOriginal(blob, mediaFileName(id, blob));
              }) } : null,
              onExpand: post.type === "photo" && onExpand ? () => onExpand(index) : void 0
            }
          );
        })() : null
      ]
    }
  );
}
async function mediaShape(blob, type) {
  if (type === "photo") {
    const bitmap = await createImageBitmap(blob);
    const shape = { width: bitmap.width, height: bitmap.height };
    bitmap.close();
    return shape;
  }
  if (type === "video") {
    return new Promise((resolve, reject) => {
      const element = document.createElement("video");
      element.preload = "metadata";
      const done = (value) => {
        element.src = "";
        resolve(value);
      };
      element.onloadedmetadata = () => done({ width: element.videoWidth, height: element.videoHeight });
      element.onerror = () => reject(new Error("Your hub did not return playable video."));
      element.src = URL.createObjectURL(blob);
    });
  }
  return {};
}
var carouselTrackSx = {
  display: "flex",
  overflowX: "auto",
  // The visible window adopts the active slide's height (useAdaptiveTrackHeight):
  // neighboring slides keep their natural height and are clipped here, never
  // cropped — vertical panning stays chained to the page because the track
  // has no scrollable vertical overflow.
  overflowY: "hidden",
  scrollSnapType: "x mandatory",
  // One slide per horizontal gesture (ac-2): scroll-snap-stop always halts
  // momentum at the adjacent slide and release snaps to the nearest one.
  // The track pan is touch-scrollable in both axes: horizontal drags swipe
  // the native overflow-x track, and near-vertical drags chain to the
  // timeline because the track itself has no vertical overflow. Any
  // touch-action restricting the horizontal pan (e.g. pan-y alone) starves
  // the swipe gesture entirely.
  touchAction: "pan-x pan-y",
  overscrollBehaviorX: "contain",
  alignItems: "flex-start",
  scrollbarWidth: "none",
  "&::-webkit-scrollbar": { display: "none" }
};
var carouselSlideSx = {
  flex: "0 0 100%",
  width: "100%",
  minWidth: 0,
  scrollSnapAlign: "start",
  scrollSnapStop: "always"
};
var carouselBreakoutSx = {
  width: { xs: `calc(100% + ${2 * photoFirst.rail}px)`, lg: `calc(100% + ${2 * photoFirst.postPad}px)` },
  mx: { xs: -photoFirst.rail / 8, lg: -photoFirst.postPad / 8 },
  borderRadius: { xs: 0, lg: `${photoFirst.desktopMediaRadius}px` },
  overflow: "hidden"
};
function useAdaptiveTrackHeight(trackRef, count) {
  const [adaptiveHeight, setAdaptiveHeight] = useState6(null);
  const measure = useCallback2(() => {
    const track = trackRef.current;
    if (!track || count < 2 || !(track.clientWidth > 0)) return;
    const heights = Array.from(track.children, (slide) => slide.getBoundingClientRect().height);
    setAdaptiveHeight(adaptiveTrackHeight(heights, track.scrollLeft / track.clientWidth));
  }, [trackRef, count]);
  useLayoutEffect2(() => {
    const track = trackRef.current;
    if (!track || count < 2) return void 0;
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(track);
    Array.from(track.children).forEach((slide) => observer.observe(slide));
    return () => observer.disconnect();
  }, [trackRef, count, measure]);
  return [adaptiveHeight, measure];
}
function CarouselArrows({ atStart, atEnd, onPrev, onNext }) {
  const base = {
    position: "absolute",
    top: "50%",
    transform: "translateY(-50%)",
    display: { xs: "none", lg: "inline-flex" },
    width: 44,
    height: 48,
    color: "text.primary",
    bgcolor: "background.paper",
    border: "1px solid",
    borderColor: "divider",
    "&:hover": { bgcolor: "action.hover" }
  };
  return /* @__PURE__ */ jsxs6(Fragment3, { children: [
    /* @__PURE__ */ jsx6(IconButton3, { "aria-label": "Previous image", disabled: atStart, onClick: onPrev, sx: { ...base, left: 12 }, children: /* @__PURE__ */ jsx6(ChevronLeft, {}) }),
    /* @__PURE__ */ jsx6(IconButton3, { "aria-label": "Next image", disabled: atEnd, onClick: onNext, sx: { ...base, right: 12 }, children: /* @__PURE__ */ jsx6(ChevronRight, {}) })
  ] });
}
function MediaCarousel({ ids, post, actions, detail = false, onExpand = null }) {
  const trackRef = useRef3(null);
  const [position, setPosition] = useState6(0);
  const count = ids.length;
  const [adaptiveHeight, measure] = useAdaptiveTrackHeight(trackRef, count);
  const slideBy = (step) => {
    const track = trackRef.current;
    if (!track) return;
    const next = Math.min(count - 1, Math.max(0, carouselIndex(track.scrollLeft, track.clientWidth, count) + step));
    track.scrollTo({ left: next * track.clientWidth, behavior: "smooth" });
  };
  return /* @__PURE__ */ jsxs6(Box5, { sx: { mt: detail ? 2 : photoFirst.spacing.captionMedia / 8 }, children: [
    /* @__PURE__ */ jsxs6(Box5, { sx: { position: "relative", ...!detail ? carouselBreakoutSx : {} }, children: [
      /* @__PURE__ */ jsx6(Box5, { ref: trackRef, onScroll: (event) => {
        const target = event.currentTarget;
        setPosition(carouselIndex(target.scrollLeft, target.clientWidth, count));
        measure();
      }, style: adaptiveHeight != null ? { height: adaptiveHeight } : void 0, sx: carouselTrackSx, children: ids.map((id, index) => /* @__PURE__ */ jsx6(Box5, { "aria-roledescription": "slide", "aria-label": `Image ${index + 1} of ${count}`, sx: carouselSlideSx, children: /* @__PURE__ */ jsx6(MediaItem, { id, post: kindPost(post, id), actions, detail, slide: true, index, onExpand }) }, `${id}-${index}`)) }),
      /* @__PURE__ */ jsx6(CarouselArrows, { atStart: position === 0, atEnd: position === count - 1, onPrev: () => slideBy(-1), onNext: () => slideBy(1) })
    ] }),
    /* @__PURE__ */ jsxs6(Typography5, { component: "div", "aria-label": `Image ${position + 1} of ${count}`, sx: { mt: 0.5, px: 0, fontSize: 12, lineHeight: "17px", color: "porchlight.muted" }, children: [
      position + 1,
      "/",
      count
    ] })
  ] });
}
function refKindOf(post, id) {
  const contentType = post?.mediaMeta?.[id]?.contentType;
  if (typeof contentType === "string") {
    if (contentType.startsWith("image/")) return "photo";
    if (contentType.startsWith("video/")) return "video";
    if (contentType.startsWith("audio/")) return "audio";
  }
  return post?.type === "photo" || post?.type === "video" || post?.type === "audio" ? post.type : null;
}
function kindPost(post, id) {
  const kind = refKindOf(post, id);
  return kind && kind !== post?.type ? { ...post, type: kind } : post;
}
function Media({ post, actions, detail = false }) {
  const media = Array.isArray(post?.mediaRefs) ? post.mediaRefs : [];
  const ids = media.map((entry) => typeof entry === "string" ? entry : entry?.mediaId ?? entry?._id ?? entry?.id).filter(Boolean);
  const [viewerIndex, setViewerIndex] = useState6(null);
  const mixed = post.type === "mixed";
  const viewerIds = mixed ? ids.filter((id) => refKindOf(post, id) === "photo") : ids;
  const viewerOpens = (post.type === "photo" || mixed) && (mixed ? viewerIds.length > 0 : ids.length > 0);
  const photoView = viewerOpens && viewerIndex != null && refKindOf(post, ids[viewerIndex]) === "photo";
  const startIndex = mixed && viewerIndex != null ? viewerIds.indexOf(ids[viewerIndex]) : viewerIndex;
  const onExpand = viewerOpens ? (index) => setViewerIndex(Math.min(Math.max(index, 0), ids.length - 1)) : null;
  if (!ids.length) return null;
  const surface = ids.length > 1 && (post.type === "photo" || mixed) ? /* @__PURE__ */ jsx6(MediaCarousel, { ids, post, actions, detail, onExpand }) : /* @__PURE__ */ jsx6(Stack4, { spacing: 0, sx: { mt: detail ? 2 : photoFirst.spacing.captionMedia / 8 }, children: ids.map((id, index) => /* @__PURE__ */ jsx6(MediaItem, { id, post: kindPost(post, id), actions, detail, index, onExpand }, `${id}-${index}`)) });
  return /* @__PURE__ */ jsxs6(Fragment3, { children: [
    surface,
    photoView && /* @__PURE__ */ jsx6(PhotoViewer, { post, ids: viewerIds, actions, startIndex, onClose: () => setViewerIndex(null) })
  ] });
}
function ReactionReveal({ chip, ownDid, data, post, actions }) {
  return /* @__PURE__ */ jsx6(Stack4, { role: "list", "aria-label": `Who reacted with ${chip.emoji}`, spacing: 0.75, sx: { minWidth: 150, maxWidth: 260 }, children: chip.reactors.map((row) => {
    const isOwn = Boolean(ownDid) && String(row.memberDid ?? "") === ownDid;
    const name = isOwn ? data.identity?.name || "You" : row.memberName ?? memberName(row.memberDid, data);
    if (!(row.memberDid ?? row._id ?? name)) return null;
    return /* @__PURE__ */ jsxs6(Stack4, { role: "listitem", direction: "row", spacing: 1, alignItems: "center", "data-testid": "reaction-reveal-row", children: [
      /* @__PURE__ */ jsx6(
        AvatarFace,
        {
          origin: post?.origin ?? originOf(post),
          did: row.memberDid ?? null,
          metas: row.memberAvatar ?? null,
          kind: "header",
          load: actions?.loadAvatarRendition,
          sx: { width: 24, height: 24, fontSize: 11 },
          children: (name || "Member").trim().charAt(0).toUpperCase()
        }
      ),
      /* @__PURE__ */ jsxs6(Typography5, { variant: "caption", color: "text.primary", fontWeight: isOwn ? 600 : 400, sx: { whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }, children: [
        name,
        isOwn ? " (you)" : ""
      ] })
    ] }, String(row.memberDid ?? row._id ?? name));
  }) });
}
function PresentReactions({ post, comment = null, data, actions, reactionState, spacingY = 2, actionBar = null, actionRow = null, trailingAction = null }) {
  const subject = comment ?? post;
  const [internalRows, setInternalRows] = useState6(() => (
    // Decorated cards seed synchronously from the feed read (first paint
    // carries arriving reactions; no loader fetch rides them). The
    // controlled detail surface stays null until its own load runs.
    comment ? reactionRowsOf(subject?.reactionRows) : reactionState ? null : reactionRowsOf(post?.reactionRows)
  ));
  const rows = comment ? internalRows : reactionState?.rows ?? internalRows;
  const setRows = comment ? setInternalRows : reactionState?.setRows ?? setInternalRows;
  const [anchor, setAnchor] = useState6(null);
  const operation = useOperation();
  const ownDid = data.identity ? String(data.identity.id) : "";
  const [frequent, setFrequent] = useState6(() => cachedUsage({ identity: data.identity ?? null, url: post?.origin ?? "" }));
  const refreshUsage = () => {
    setFrequent(cachedUsage({ identity: data.identity ?? null, url: post?.origin ?? "" }));
    try {
      const read = invoke(actions, "emojiUsage", post);
      loadUsage({ identity: data.identity ?? null, url: post?.origin ?? "" }, Promise.resolve(read).catch(() => null)).then((list) => setFrequent(list));
    } catch {
    }
  };
  const serverRows = reactionRowsOf(subject?.reactionRows);
  const serverSignature = serverRows.map((row) => `${row.emoji}:${row.memberDid ?? ""}:${row._id ?? ""}`).join("|");
  const lastServerRef = useRef3(null);
  useEffect5(() => {
    if (!Object.prototype.hasOwnProperty.call(subject ?? {}, "reactionRows")) return;
    if (lastServerRef.current === serverSignature) return;
    lastServerRef.current = serverSignature;
    setRows(serverRows);
  }, [serverSignature]);
  useEffect5(() => {
    if (comment) {
      if (!Object.prototype.hasOwnProperty.call(comment, "reactionRows")) setRows(reactionRowsOf(null));
      return void 0;
    }
    if (Object.prototype.hasOwnProperty.call(post ?? {}, "reactionRows")) return void 0;
    let current = true;
    setRows(null);
    Promise.resolve().then(() => invoke(actions, "loadReactions", post)).then((value) => {
      if (current) setRows(reactionRowsOf(value));
    }).catch(() => {
      if (current) setRows([]);
    });
    return () => {
      current = false;
    };
  }, [identityOf(subject)]);
  const own = ownEmojiRows(rows, ownDid);
  const toggle = (emoji, isOwn) => {
    setAnchor(null);
    if (!ownDid || operation.busy) return;
    const before = rows;
    setRows(optimisticToggle(rows ?? [], { emoji, ownDid, isOwn }));
    operation.run(
      () => comment ? invoke(actions, isOwn ? "unreactComment" : "reactComment", post, comment, emoji) : invoke(actions, isOwn ? "unreact" : "react", post, emoji),
      (result) => {
        if (result?.reaction && !isOwn) {
          setRows((current) => reflectReaction(current ?? [], {
            emoji,
            ownDid,
            isOwn: false,
            reaction: result.reaction
          }));
          setFrequent(recordSessionUse({ identity: data.identity ?? null, url: post?.origin ?? "" }, emoji));
        }
      },
      // Rollback (ac-2): a failed write never leaves a phantom reaction.
      () => setRows(before)
    );
  };
  const [reveal, setReveal] = useState6(null);
  const paperRef = useRef3(null);
  const machineRef = useRef3(null);
  if (!machineRef.current) {
    machineRef.current = revealMachine({
      open: ({ emoji, anchor: anchor2 }) => setReveal({ emoji, anchor: anchor2 }),
      close: () => setReveal(null),
      overPopover: () => Boolean(paperRef.current?.matches(":hover"))
    });
  }
  const machine = machineRef.current;
  const closeReveal = () => {
    machine.silence();
    setReveal(null);
  };
  const chips = reactionChips(rows ?? []);
  const revealChip = reveal ? chips.find((chip) => chip.emoji === reveal.emoji) ?? null : null;
  const lastPointerRef = useRef3(0);
  useEffect5(() => {
    if (reveal && !revealChip) closeReveal();
  }, [Boolean(reveal), revealChip]);
  useEffect5(() => {
    if (!reveal) return void 0;
    const onEscape = (event) => {
      if (event.key === "Escape") closeReveal();
    };
    const onOutside = (event) => {
      if (reveal.anchor && reveal.anchor.contains(event.target)) return;
      if (paperRef.current && paperRef.current.contains(event.target)) return;
      closeReveal();
    };
    document.addEventListener("keydown", onEscape);
    document.addEventListener("pointerdown", onOutside, true);
    return () => {
      document.removeEventListener("keydown", onEscape);
      document.removeEventListener("pointerdown", onOutside, true);
    };
  }, [Boolean(reveal), reveal?.emoji, reveal?.anchor]);
  useEffect5(() => () => machine.silence(), [machine]);
  const chipClick = (chip) => {
    if (!machine.click()) return;
    toggle(chip.emoji, own.has(chip.emoji));
  };
  const chipList = chips.map((chip) => {
    const ownEmoji = own.has(chip.emoji);
    const peopleCount = chip.reactors.length;
    return /* @__PURE__ */ jsx6(
      Chip2,
      {
        size: "small",
        component: "button",
        type: "button",
        label: /* @__PURE__ */ jsxs6(Fragment3, { children: [
          chip.emoji,
          peopleCount > 1 && /* @__PURE__ */ jsx6(Box5, { component: "span", sx: { ml: 0.25, fontSize: 13, fontWeight: 600, lineHeight: 1, color: "inherit" }, children: peopleCount })
        ] }),
        "aria-pressed": ownEmoji,
        "aria-label": peopleCount > 1 ? `Reaction ${chip.emoji}, ${peopleCount} people` : ownEmoji ? `Your reaction ${chip.emoji}` : `Reaction ${chip.emoji}`,
        "aria-haspopup": "dialog",
        onClick: () => chipClick(chip),
        onPointerEnter: (event) => machine.hoverStart(chip.emoji, event.currentTarget, event),
        onPointerLeave: (event) => {
          if (event.pointerType === "mouse") machine.hoverLeave();
        },
        onTouchStart: (event) => machine.pressStart(chip.emoji, event.currentTarget, event),
        onTouchEnd: () => machine.pressEnd(),
        onTouchCancel: () => machine.pressEnd(),
        onContextMenu: (event) => event.preventDefault(),
        onPointerDown: () => {
          lastPointerRef.current = Date.now();
        },
        onFocus: (event) => {
          if (Date.now() - lastPointerRef.current > 300) machine.hoverStart(chip.emoji, event.currentTarget, void 0);
        },
        onBlur: closeReveal,
        sx: {
          // PORCH-101 (Brian, Oct 19): a comment chip renders at the row's own
          // 32px height — the same height as Reply, the overflow, and the
          // add-emoji control on that row; post chips keep the 40px family.
          ...comment ? { height: 32, minHeight: 32, minWidth: 32, fontSize: 16 } : { minHeight: 40, minWidth: 40, fontSize: 20 },
          cursor: "pointer",
          userSelect: "none",
          WebkitTouchCallout: "none",
          ...ownEmoji ? { bgcolor: "porchlight.amberSoft", border: "1px solid", borderColor: "porchlight.amber", color: "text.primary" } : {}
        }
      },
      chip.emoji
    );
  });
  const chipRow = chipList.length > 0 ? /* @__PURE__ */ jsx6(
    Stack4,
    {
      direction: "row",
      spacing: 0,
      flexWrap: "wrap",
      alignItems: "center",
      sx: { gap: "4px" },
      "aria-label": "Reactions from your family",
      children: chipList
    }
  ) : null;
  return /* @__PURE__ */ jsxs6(Fragment3, { children: [
    /* @__PURE__ */ jsxs6(
      Stack4,
      {
        direction: "row",
        spacing: actionBar || actionRow ? 0 : 1,
        alignItems: "center",
        flexWrap: "wrap",
        sx: { ...actionBar ? { justifyContent: "flex-start", gap: "8px" } : { ...actionRow ? { justifyContent: "flex-start", gap: "4px" } : {} }, mt: spacingY },
        "aria-label": actionBar ? "Post actions" : actionRow ? "Comment actions" : "Reactions from your family",
        children: [
          actionBar,
          actionRow,
          comment && chipRow,
          !actionBar && !actionRow && !comment && chipList,
          /* @__PURE__ */ jsx6(Tooltip, { title: "React", children: /* @__PURE__ */ jsx6("span", { children: /* @__PURE__ */ jsx6(
            IconButton3,
            {
              "aria-label": actionBar ? "React" : "Add a reaction",
              "aria-haspopup": "dialog",
              disabled: operation.busy || Boolean(data?.offline),
              onClick: (event) => {
                setAnchor(event.currentTarget);
                refreshUsage();
              },
              sx: actionBar ? { width: 36, height: 36, p: 0, "&::after": { content: '""', position: "absolute", inset: -4 } } : actionRow || comment ? { width: 32, height: 32, p: 0, color: "text.secondary", "&::after": { content: '""', position: "absolute", inset: -4 } } : { width: 40, height: 40, border: `1px dashed ${cssVars.borderStrong}` },
              children: /* @__PURE__ */ jsx6(AddReactionOutlined, { fontSize: "small", sx: !actionBar && (actionRow || comment) ? { fontSize: 18 } : void 0 })
            }
          ) }) }),
          trailingAction
        ]
      }
    ),
    actionBar && chipRow && /* @__PURE__ */ jsx6(
      Stack4,
      {
        direction: "row",
        spacing: 1,
        flexWrap: "wrap",
        "aria-label": "Reactions from your family",
        sx: { mt: photoFirst.spacing.actionsReactions / 8 },
        children: chipList
      }
    ),
    anchor && /* @__PURE__ */ jsx6(Suspense, { fallback: /* @__PURE__ */ jsx6(LanternLoader, { size: 20, label: "Your reaction picker" }), children: /* @__PURE__ */ jsx6(EmojiPicker2, { open: true, anchorEl: anchor, onClose: () => setAnchor(null), own, onToggle: toggle, busy: operation.busy, frequent }) }),
    reveal && revealChip && /* @__PURE__ */ jsx6(
      Popper,
      {
        open: true,
        placement: "bottom",
        anchorEl: reveal.anchor,
        modifiers: [{ name: "offset", options: { offset: [0, 6] } }],
        sx: { zIndex: 1300 },
        children: /* @__PURE__ */ jsx6(
          Paper,
          {
            elevation: 0,
            ref: paperRef,
            onPointerEnter: () => machine.paperEnter(),
            onPointerLeave: (event) => {
              if (event.pointerType === "mouse") closeReveal();
            },
            sx: { p: 1, px: 1.25, borderRadius: "12px", border: `1px solid ${cssVars.border}`, boxShadow: cssVars.shadowModal, cursor: "default" },
            children: /* @__PURE__ */ jsx6(ReactionReveal, { chip: revealChip, ownDid, data, post, actions })
          }
        )
      }
    ),
    operation.error && /* @__PURE__ */ jsx6(Typography5, { variant: "caption", color: "error", sx: { width: "100%" }, children: operation.error })
  ] });
}
function PostCard({ post, data, actions, navigate, detail = false, onHide, reactionState, groupMenu = null, onVoteApplied = null }) {
  const [voteOverride, setVoteOverride] = useState6(null);
  useEffect5(() => {
    if (!voteOverride) return void 0;
    if ((post?.myVote ?? null) === voteOverride.vote) setVoteOverride(null);
    return void 0;
  }, [voteOverride, post?.myVote]);
  const [localHidden, setLocalHidden] = useState6(false);
  const [composerFor, setComposerFor] = useState6(null);
  const [drafts] = useState6(() => /* @__PURE__ */ new Map());
  const openComposer = (target) => {
    setEditFor(null);
    setComposerFor(target);
  };
  const holdDraft = (target, text) => {
    if (text) drafts.set(target, text);
    else drafts.delete(target);
  };
  const readDraft = (target) => drafts.get(target);
  const operation = useOperation();
  const [localConversation, setLocalConversation] = useState6(() => ({ pending: [], confirmed: [] }));
  const replyCountRef = useRef3(0);
  const [menuAnchor, setMenuAnchor] = useState6(null);
  const [tombstoned, setTombstoned] = useState6(false);
  const [deleteOpen, setDeleteOpen] = useState6(false);
  const [editFor, setEditFor] = useState6(null);
  const [commentDelete, setCommentDelete] = useState6(null);
  const [removedIds, setRemovedIds] = useState6(() => /* @__PURE__ */ new Set());
  const [editedFields, setEditedFields] = useState6(null);
  useEffect5(() => {
    if (!editedFields) return void 0;
    if ((post.text ?? null) === (editedFields.text ?? null) && String(post.groupId ?? "") === String(editedFields.groupId ?? "")) {
      setEditedFields(null);
    }
    return void 0;
  }, [editedFields, post.text, post.groupId]);
  const [removeOpen, setRemoveOpen] = useState6(false);
  const [shareNote, setShareNote] = useState6("");
  const [shareError, setShareError] = useState6("");
  const [shareSnackbar, setShareSnackbar] = useState6("");
  const sliceIdentity = post ? `${identityOf(post)}:${Array.isArray(post.replySlice) ? post.replySlice.map((reply) => reply._id).join("|") : ""}:${Number.isFinite(post.replyTotal) ? post.replyTotal : ""}` : "";
  useEffect5(() => {
    setLocalConversation((current) => ({
      ...current,
      confirmed: reconcileConfirmed(current.confirmed, post ? conversationOf(post).total : null)
    }));
  }, [sliceIdentity]);
  if (localHidden || tombstoned || actions?.isHidden?.(post) || !visibleAtOrigin(post, data)) return null;
  const row = editedFields ? {
    ...post,
    ...editedFields.text !== void 0 ? { text: editedFields.text } : {},
    ...editedFields.groupId !== void 0 ? { groupId: editedFields.groupId, groupName: editedFields.groupName ?? null } : {}
  } : post;
  const removesPostGroup = Boolean(post?.groupId) && (data?.groups ?? []).some((item) => identityOf(item) === String(post.groupId) && canManageGroup(item, data));
  const openPost = () => navigate?.(`/posts/${encodeURIComponent(identityOf(post))}`);
  const runShare = () => {
    setMenuAnchor(null);
    setShareNote("");
    setShareError("");
    sharePost({
      post,
      ownDid: data.identity ? String(data.identity.id) : null,
      data,
      base: typeof window !== "undefined" ? window.location.origin : ""
    }).then((result) => {
      if (result.mode === "copy") {
        if (result.copied) {
          setShareNote("Link copied.");
          setShareSnackbar("Link copied.");
        } else {
          setShareError("Your browser does not offer sharing or copying here yet. Open the post and copy its link from the address bar.");
          setShareSnackbar("Your browser does not offer sharing or copying here yet.");
        }
      }
    }).catch(() => {
      setShareError("The share did not go through. Try again.");
      setShareSnackbar("The share did not go through. Try again.");
    });
  };
  const submitOptimistic = (body, parentId, mentions) => {
    const localId = `local:reply-${Date.now()}-${replyCountRef.current += 1}`;
    const optimisticRow = pendingReply(post, body, {
      did: data.identity ? String(data.identity.id) : null,
      name: data.identity?.name ?? "You",
      localId
    });
    if (!parentId) setLocalConversation((current) => ({ ...current, pending: [...current.pending, optimisticRow] }));
    const revert = () => setLocalConversation((current) => ({ ...current, pending: current.pending.filter((row2) => row2._id !== localId) }));
    return Promise.resolve().then(() => invoke(actions, "submitReply", post, body, parentId, mentions)).then((result) => {
      if (!result?.comment || !identityOf(result.comment)) {
        revert();
        throw new Error("The family server did not confirm this reply. Reload the conversation before trying again.");
      }
      if (!parentId) setLocalConversation((current) => ({
        pending: current.pending.filter((row2) => row2._id !== localId),
        confirmed: [...current.confirmed, {
          reply: { ...result.comment, postId: result.comment.postId ?? identityOf(post) },
          basis: conversationOf(post).total
        }]
      }));
      return result;
    }, (failure) => {
      revert();
      throw failure;
    });
  };
  const displaySlice = detail ? null : sliceDisplay(post, localConversation);
  const ownsPostEdit = canEditPost(post, data);
  const ownsPostDelete = canDeletePost(post, data);
  const openEdit = () => {
    setComposerFor(null);
    setEditFor("post");
  };
  const applyEditResult = (fields) => {
    setEditedFields((current) => ({ ...current ?? {}, ...fields }));
    setEditFor(null);
    holdDraft("edit:post", "");
  };
  const deleteThisPostConfirm = () => {
    setDeleteOpen(false);
    setTombstoned(true);
    operation.run(() => invoke(actions, "deletePost", post), () => {
    }, () => {
      setTombstoned(false);
    });
  };
  const removeCommentRow = (row2) => {
    const id = identityOf(row2);
    setRemovedIds((current) => new Set(current).add(id));
    operation.run(
      () => invoke(actions, "deleteComment", post, id),
      () => {
      },
      () => {
        setRemovedIds((current) => {
          const next = new Set(current);
          next.delete(id);
          return next;
        });
      }
    );
  };
  const editCommentRow = (row2) => {
    setComposerFor(null);
    setEditFor(identityOf(row2));
  };
  const cardSx = detail ? void 0 : {
    width: "100%",
    borderRadius: { xs: 0, lg: "14px" },
    border: { xs: "none", lg: `1px solid ${cssVars.border}` },
    boxShadow: { xs: "none", lg: cssVars.shadowCard }
  };
  const compactIconSx = { width: 36, height: 36, p: 0, "&::after": { content: '""', position: "absolute", inset: -4 } };
  const servedVote = ownVoteOf(post?.myVote);
  const servedUpCount = upCountOf(post?.upCount);
  const effectiveVote = voteOverride ? voteOverride.vote : servedVote;
  const upCount = voteOverride ? voteOverride.count : servedUpCount;
  const castVote = (direction) => {
    if (operation.busy || data.offline) return;
    const next = castVoteState(post, direction);
    if (!next) return;
    setVoteOverride(next);
    operation.run(
      // The RESOLVED write rides, never the clicked direction: a clear's
      // vote is null and the action routes the signed DELETE (PORCH-114) —
      // a held click must never re-state the held vote (cast/change only
      // fires for a real cast or flip).
      () => invoke(actions, "vote", post, next.vote ?? null),
      (result) => {
        const effective = result?.vote?.effective;
        setVoteOverride(effective ? { vote: effective, count: next.count } : next.vote === null ? next : null);
        onVoteApplied?.(result);
      },
      () => setVoteOverride(null)
    );
  };
  const voteButton = (direction, label, Icon) => {
    const taken = effectiveVote === direction;
    const accent = direction === "up" ? "porchlight.voteUp" : "porchlight.voteDown";
    return /* @__PURE__ */ jsx6(Tooltip, { title: label, children: /* @__PURE__ */ jsx6("span", { children: /* @__PURE__ */ jsxs6(
      IconButton3,
      {
        "aria-label": label,
        disabled: operation.busy || data.offline,
        sx: {
          ...compactIconSx,
          // My action marks the arrow persistently; a hover touches the
          // same arrow in that button's own accent either way.
          ...taken ? { "& svg": { color: accent } } : {},
          "&:hover svg": { color: accent }
        },
        "data-testid": `vote-${direction}`,
        onClick: () => castVote(direction),
        children: [
          /* @__PURE__ */ jsx6(Icon, { fontSize: "small" }),
          direction === "up" && upCount > 0 && /* @__PURE__ */ jsx6(Typography5, { component: "span", sx: { fontSize: 13, lineHeight: 1, fontWeight: 600, color: "porchlight.muted", ml: 0.5 }, children: upCount })
        ]
      }
    ) }) });
  };
  return /* @__PURE__ */ jsx6(Card, { sx: cardSx, "data-feed-entry": postKey(post) || void 0, children: /* @__PURE__ */ jsxs6(CardContent, { sx: { p: detail ? "20px" : { xs: "16px", lg: "20px" }, "&:last-child": { pb: detail ? "20px" : { xs: "16px", lg: "20px" } } }, children: [
    /* @__PURE__ */ jsxs6(Stack4, { direction: "row", justifyContent: "space-between", alignItems: "flex-start", gap: 1, children: [
      /* @__PURE__ */ jsxs6(Stack4, { direction: "row", spacing: 1.5, alignItems: "center", children: [
        /* @__PURE__ */ jsx6(
          AvatarFace,
          {
            origin: post?.origin ?? originOf(post),
            did: post.authorId ?? post.authorDid ?? null,
            kind: "header",
            metas: post.authorAvatar ?? null,
            load: actions?.loadAvatarRendition,
            sx: { width: detail ? 40 : 36, height: detail ? 40 : 36, fontSize: detail ? 17 : 15 },
            children: (post.author?.name ?? post.authorName ?? memberName(post.authorId, data)).trim().charAt(0).toUpperCase()
          }
        ),
        /* @__PURE__ */ jsxs6(Box5, { children: [
          /* @__PURE__ */ jsx6(Typography5, { variant: "body2", fontWeight: 600, fontSize: 15, color: "text.primary", children: post.author?.name ?? post.authorName ?? memberName(post.authorId, data) }),
          /* @__PURE__ */ jsxs6(Stack4, { direction: "row", spacing: 1, alignItems: "center", flexWrap: "wrap", children: [
            /* @__PURE__ */ jsx6(Chip2, { label: `From ${originName(post, data)}`, size: "small", variant: "outlined", sx: { fontSize: "0.75rem", height: "24px" } }),
            row.groupName && /* @__PURE__ */ jsx6(Chip2, { label: row.groupName, size: "small", sx: { bgcolor: "porchlight.amberSoft", color: "primary.main", fontSize: "0.6875rem", height: "24px" }, "data-testid": "location-chip" }),
            /* @__PURE__ */ jsx6(Typography5, { variant: "caption", color: "porchlight.muted", children: dateOf(post.createdAt) })
          ] })
        ] })
      ] }),
      /* @__PURE__ */ jsxs6(Box5, { sx: { display: "flex", alignItems: "center", flexShrink: 0 }, children: [
        groupMenu,
        /* @__PURE__ */ jsx6(
          IconButton3,
          {
            "aria-label": "Post options",
            "aria-haspopup": "menu",
            "aria-expanded": Boolean(menuAnchor),
            onClick: (event) => setMenuAnchor(event.currentTarget),
            children: /* @__PURE__ */ jsx6(MoreHorizOutlined, {})
          }
        ),
        /* @__PURE__ */ jsxs6(Menu, { anchorEl: menuAnchor, open: Boolean(menuAnchor), onClose: () => setMenuAnchor(null), children: [
          !detail && /* @__PURE__ */ jsx6(MenuItem, { onClick: () => {
            setMenuAnchor(null);
            openPost();
          }, children: "Open conversation" }),
          ownsPostEdit && /* @__PURE__ */ jsx6(MenuItem, { "data-testid": "edit-post", onClick: () => {
            setMenuAnchor(null);
            openEdit();
          }, children: "Edit" }),
          ownsPostDelete && /* @__PURE__ */ jsx6(MenuItem, { "data-testid": "delete-post", disabled: data.offline, onClick: () => {
            setMenuAnchor(null);
            setDeleteOpen(true);
          }, children: "Delete" }),
          /* @__PURE__ */ jsx6(MenuItem, { onClick: runShare, children: "Share" }),
          /* @__PURE__ */ jsx6(MenuItem, { disabled: operation.busy, onClick: () => {
            setMenuAnchor(null);
            operation.run(() => invoke(actions, "hide", post), () => {
              setLocalHidden(true);
              onHide?.(post);
            });
          }, children: "Hide" }),
          removesPostGroup && /* @__PURE__ */ jsx6(
            MenuItem,
            {
              disabled: operation.busy,
              "data-testid": "remove-group-post",
              onClick: () => {
                setMenuAnchor(null);
                setRemoveOpen(true);
              },
              children: "Remove"
            }
          )
        ] })
      ] })
    ] }),
    editFor === "post" && !data.offline && /* @__PURE__ */ jsx6(
      PostEditForm,
      {
        post,
        row,
        data,
        initial: readDraft("edit:post") ?? { text: row.text ?? "", locationId: currentLocationId(row) },
        onDraft: (value) => holdDraft("edit:post", value),
        onSaved: applyEditResult,
        onCancel: () => {
          setEditFor(null);
          holdDraft("edit:post", "");
        },
        onSubmit: (fields) => invoke(actions, "editPost", post, fields)
      }
    ),
    editFor !== "post" && row.text && /* @__PURE__ */ jsx6(Box5, { sx: { mt: detail ? 2 : 1 }, children: /* @__PURE__ */ jsx6(Typography5, { sx: { whiteSpace: "pre-wrap", overflowWrap: "anywhere", fontSize: detail ? 17 : 16, lineHeight: detail ? "27px" : "25px", maxWidth: "68ch" }, children: /* @__PURE__ */ jsx6(LinkedBody, { text: row.text }) }) }),
    post.preview && /* @__PURE__ */ jsx6(LinkPreviewBlock, { preview: post.preview, origin: previewOrigin(post, data) }),
    /* @__PURE__ */ jsx6(Media, { post, actions, detail }),
    detail ? /* @__PURE__ */ jsxs6(Stack4, { direction: "row", spacing: 1, sx: { mt: 2 }, children: [
      voteButton("up", "Lift", ArrowUpwardOutlined),
      voteButton("down", "Lower", ArrowDownwardOutlined)
    ] }) : /* @__PURE__ */ jsx6(
      PresentReactions,
      {
        post,
        data,
        actions,
        reactionState,
        spacingY: photoFirst.spacing.utilityActions / 8,
        actionBar: /* @__PURE__ */ jsxs6(Fragment3, { children: [
          voteButton("up", "Lift", ArrowUpwardOutlined),
          voteButton("down", "Lower", ArrowDownwardOutlined),
          /* @__PURE__ */ jsx6(Tooltip, { title: "Reply", children: /* @__PURE__ */ jsx6("span", { children: /* @__PURE__ */ jsx6(
            IconButton3,
            {
              "aria-label": "Reply",
              "aria-expanded": composerFor === "post",
              disabled: data.offline,
              sx: compactIconSx,
              onClick: () => setComposerFor(composerFor === "post" ? null : "post"),
              children: /* @__PURE__ */ jsx6(ReplyOutlined, { fontSize: "small" })
            }
          ) }) })
        ] })
      }
    ),
    !detail && composerFor === "post" && !data.offline && /* @__PURE__ */ jsx6(
      ReplyForm,
      {
        label: "Write a reply",
        replyingTo: "this post",
        offline: data.offline,
        post,
        actions,
        initialText: readDraft("post"),
        onDraft: (text) => holdDraft("post", text),
        onDone: () => {
          setComposerFor(null);
          holdDraft("post", "");
        },
        onSubmit: (body, mentions) => submitOptimistic(body, null, mentions)
      }
    ),
    detail && /* @__PURE__ */ jsx6(PresentReactions, { post, data, actions, reactionState }),
    !detail && /* @__PURE__ */ jsx6(
      ReplySliceBlock,
      {
        post,
        slice: displaySlice,
        data,
        actions,
        offline: data.offline,
        origin: previewOrigin(post, data),
        onReply: submitOptimistic,
        navigate,
        composerFor,
        onReplyTarget: openComposer,
        onDraftDone: holdDraft,
        readDraft,
        onComposerClosed: () => setComposerFor(null),
        removedIds,
        editFor,
        onEditTarget: editCommentRow,
        onDeleteComment: setCommentDelete,
        onCommentDeleted: removeCommentRow,
        onEditClosed: () => setEditFor(null)
      },
      identityOf(post)
    ),
    shareNote && /* @__PURE__ */ jsx6(Typography5, { color: "text.secondary", role: "status", sx: { mt: 1 }, children: shareNote }),
    shareError && /* @__PURE__ */ jsx6(Alert2, { severity: "warning", sx: { mt: 1 }, children: shareError }),
    /* @__PURE__ */ jsxs6(Dialog, { open: deleteOpen, onClose: () => setDeleteOpen(false), fullWidth: true, maxWidth: "xs", children: [
      /* @__PURE__ */ jsx6(DialogTitle, { children: "Delete this post?" }),
      /* @__PURE__ */ jsx6(DialogContent, { children: /* @__PURE__ */ jsx6(Typography5, { children: "Its conversation goes with it \u2014 the replies and reactions are removed too. This cannot be undone here." }) }),
      /* @__PURE__ */ jsxs6(DialogActions, { children: [
        /* @__PURE__ */ jsx6(Button2, { onClick: () => setDeleteOpen(false), children: "Cancel" }),
        /* @__PURE__ */ jsx6(
          Button2,
          {
            color: "error",
            variant: "contained",
            disabled: operation.busy || data.offline,
            "data-testid": "confirm-delete-post",
            onClick: deleteThisPostConfirm,
            children: "Delete post"
          }
        )
      ] })
    ] }),
    /* @__PURE__ */ jsxs6(Dialog, { open: Boolean(commentDelete), onClose: () => setCommentDelete(null), fullWidth: true, maxWidth: "xs", children: [
      /* @__PURE__ */ jsx6(DialogTitle, { children: "Delete this comment?" }),
      /* @__PURE__ */ jsx6(DialogContent, { children: /* @__PURE__ */ jsx6(Typography5, { children: "This comment and the replies that follow it are removed. This cannot be undone here." }) }),
      /* @__PURE__ */ jsxs6(DialogActions, { children: [
        /* @__PURE__ */ jsx6(Button2, { onClick: () => setCommentDelete(null), children: "Cancel" }),
        /* @__PURE__ */ jsx6(
          Button2,
          {
            color: "error",
            variant: "contained",
            disabled: operation.busy,
            "data-testid": "confirm-delete-comment",
            onClick: () => {
              const row2 = commentDelete;
              setCommentDelete(null);
              removeCommentRow(row2);
            },
            children: "Delete comment"
          }
        )
      ] })
    ] }),
    /* @__PURE__ */ jsxs6(Dialog, { open: removeOpen, onClose: () => setRemoveOpen(false), fullWidth: true, maxWidth: "xs", children: [
      /* @__PURE__ */ jsx6(DialogTitle, { children: "Remove this post?" }),
      /* @__PURE__ */ jsx6(DialogContent, { children: /* @__PURE__ */ jsx6(Typography5, { children: "This removes the post everywhere it appears \u2014 the group's timeline, the main feed that carries it, and its replies and reactions. It cannot be undone." }) }),
      /* @__PURE__ */ jsxs6(DialogActions, { children: [
        /* @__PURE__ */ jsx6(Button2, { onClick: () => setRemoveOpen(false), children: "Cancel" }),
        /* @__PURE__ */ jsx6(
          Button2,
          {
            color: "error",
            variant: "contained",
            disabled: operation.busy,
            "data-testid": "confirm-remove-group-post",
            onClick: () => {
              setRemoveOpen(false);
              operation.run(() => invoke(actions, "removeGroupPost", post), () => {
                setLocalHidden(true);
                onHide?.(post);
              });
            },
            children: "Remove post"
          }
        )
      ] })
    ] }),
    /* @__PURE__ */ jsx6(
      Snackbar,
      {
        open: Boolean(shareSnackbar || shareError),
        onClose: () => {
          setShareError("");
          setShareSnackbar("");
        },
        message: shareSnackbar || (shareError ? "The share did not go through. Try again." : "")
      }
    ),
    operation.error && /* @__PURE__ */ jsx6(Alert2, { severity: "error", sx: { mt: 1 }, children: operation.error })
  ] }) });
}
function PostEditForm({ post, row, data = {}, initial, onDraft = null, onSaved = null, onCancel = null, onSubmit }) {
  const [text, setText] = useState6(initial?.text ?? "");
  const [locationId, setLocationId] = useState6(initial?.locationId ?? currentLocationId(post));
  const operation = useOperation();
  const offline = Boolean(data.offline);
  const locationRows = editLocationRows(post, data);
  const stage = { text, locationId };
  const report = (next) => {
    onDraft?.(next);
  };
  return /* @__PURE__ */ jsxs6(Stack4, { component: "form", spacing: 1.5, sx: { my: 1.5 }, onSubmit: (event) => {
    event.preventDefault();
    if (offline || operation.busy || !text.trim()) return;
    operation.run(
      // One write: the post's text and target ride the same signed edit.
      () => onSubmit({ text: text.trim(), groupId: locationId === GENERAL_LOCATION_ID ? null : locationId }),
      () => onSaved?.(stage),
      () => {
      }
      // the composer stays open; the full draft holds through the failure
    );
  }, children: [
    /* @__PURE__ */ jsx6(
      TextField2,
      {
        fullWidth: true,
        label: "Edit your post",
        value: text,
        disabled: offline,
        multiline: true,
        minRows: 2,
        onChange: (event) => {
          const next = { ...stage, text: event.target.value };
          setText(event.target.value);
          report(next);
        },
        helperText: offline ? "Editing needs your family server. It is unreachable right now." : void 0
      }
    ),
    /* @__PURE__ */ jsx6(
      TextField2,
      {
        fullWidth: true,
        select: true,
        "data-testid": "edit-location",
        label: "Post to",
        value: locationId,
        disabled: offline,
        onChange: (event) => {
          const next = { ...stage, locationId: event.target.value };
          setLocationId(event.target.value);
          report(next);
        },
        children: locationRows.map((item) => /* @__PURE__ */ jsx6(MenuItem, { value: item.id, children: item.label }, item.id || "general"))
      }
    ),
    (row?.mediaRefs ?? row?.mediaIds ?? []).length > 0 && /* @__PURE__ */ jsx6(Typography5, { variant: "caption", color: "text.secondary", children: "Media is set as posted. To change it, delete this post and post it again." }),
    /* @__PURE__ */ jsxs6(Stack4, { direction: "row", spacing: 1, children: [
      /* @__PURE__ */ jsx6(Button2, { type: "submit", variant: "contained", disabled: offline || operation.busy || !text.trim(), sx: { alignSelf: "flex-start" }, children: operation.busy ? "Saving\u2026" : "Save changes" }),
      /* @__PURE__ */ jsx6(Button2, { "data-testid": "cancel-edit-post", disabled: operation.busy, onClick: () => onCancel?.(), children: "Cancel" })
    ] }),
    operation.error && /* @__PURE__ */ jsx6(Alert2, { severity: "error", "data-testid": "edit-error", children: operation.error })
  ] });
}
function CommentEditForm({ row, initialText, onDraft = null, onDone = null, onCancel = null, onSubmit }) {
  const [text, setText] = useState6(initialText ?? "");
  const operation = useOperation();
  return /* @__PURE__ */ jsxs6(Stack4, { component: "form", spacing: 1, sx: { my: 1 }, onSubmit: (event) => {
    event.preventDefault();
    if (operation.busy || !text.trim()) return;
    operation.run(
      () => onSubmit(text.trim()),
      () => {
        setText("");
        onDraft?.("");
        onDone?.();
      },
      () => {
      }
      // keep the composer open, draft held through the failure
    );
  }, children: [
    /* @__PURE__ */ jsx6(
      TextField2,
      {
        fullWidth: true,
        label: "Edit your comment",
        value: text,
        multiline: true,
        minRows: 2,
        "data-testid": "comment-edit-field",
        onChange: (event) => {
          setText(event.target.value);
          onDraft?.(event.target.value);
        }
      }
    ),
    /* @__PURE__ */ jsxs6(Stack4, { direction: "row", spacing: 1, children: [
      /* @__PURE__ */ jsx6(Button2, { type: "submit", variant: "contained", disabled: operation.busy || !text.trim(), sx: { alignSelf: "flex-start" }, "data-testid": "comment-edit-save", children: operation.busy ? "Saving\u2026" : "Save changes" }),
      /* @__PURE__ */ jsx6(Button2, { "data-testid": "comment-edit-cancel", disabled: operation.busy, onClick: () => onCancel?.(), children: "Cancel" })
    ] }),
    operation.error && /* @__PURE__ */ jsx6(Alert2, { severity: "error", "data-testid": "comment-edit-error", children: operation.error })
  ] });
}
function CommentOverflow({ row, data = {}, offline = false, onEdit = null, onDelete = null }) {
  const [anchor, setAnchor] = useState6(null);
  const items = lifecycleMenuItems({ edit: canEditComment(row, data), remove: canDeleteComment(row, data) });
  if (!items.length) return null;
  return /* @__PURE__ */ jsxs6(Fragment3, { children: [
    /* @__PURE__ */ jsx6(
      IconButton3,
      {
        "aria-label": "Comment options",
        "aria-haspopup": "menu",
        "aria-expanded": Boolean(anchor),
        "data-testid": "comment-options",
        sx: { width: 32, height: 32, p: 0, color: "text.secondary", "&::after": { content: '""', position: "absolute", inset: -4 } },
        onClick: (event) => setAnchor(event.currentTarget),
        children: /* @__PURE__ */ jsx6(MoreHorizOutlined, { sx: { fontSize: 18 } })
      }
    ),
    /* @__PURE__ */ jsxs6(Menu, { anchorEl: anchor, open: Boolean(anchor), onClose: () => setAnchor(null), children: [
      canEditComment(row, data) && /* @__PURE__ */ jsx6(
        MenuItem,
        {
          "data-testid": "edit-comment",
          disabled: offline,
          onClick: () => {
            setAnchor(null);
            onEdit?.(row);
          },
          children: "Edit"
        }
      ),
      canDeleteComment(row, data) && /* @__PURE__ */ jsx6(
        MenuItem,
        {
          "data-testid": "delete-comment",
          disabled: offline,
          onClick: () => {
            setAnchor(null);
            onDelete?.(row);
          },
          children: "Delete"
        }
      )
    ] })
  ] });
}
function ReplySliceBlock({
  post,
  slice,
  data,
  actions,
  offline,
  origin,
  onReply,
  navigate,
  composerFor = null,
  onReplyTarget = null,
  onDraftDone = null,
  readDraft = null,
  onComposerClosed = null,
  removedIds = null,
  editFor = null,
  onEditTarget = null,
  onDeleteComment = null,
  onCommentDeleted = null,
  onEditClosed = null
}) {
  const [loaded, setLoaded] = useState6(null);
  const [showAll, setShowAll] = useState6(false);
  const [expandedRoots, setExpandedRoots] = useState6(() => /* @__PURE__ */ new Set());
  const [busy, setBusy] = useState6(false);
  const [error, setError] = useState6("");
  const [treeRows, setTreeRows] = useState6(() => ({ pending: [], confirmed: [] }));
  const treeCountRef = useRef3(0);
  const signature = `${slice.total}:${slice.replies.map((row) => `${identityOf(row)}:${row.responseCount ?? 0}`).join("|")}`;
  const scoped = (comments) => comments.filter((row) => (!row.postId || String(row.postId) === identityOf(post)) && (!row.networkId || !originOf(post) || String(row.networkId) === String(originOf(post))));
  const load = async () => {
    if (loaded) return loaded;
    setBusy(true);
    setError("");
    try {
      const result = await invoke(actions, "loadComments", post);
      if (!Array.isArray(result?.comments)) throw new Error("The family server did not return this conversation.");
      const comments = scoped(result.comments);
      setLoaded(comments);
      setTreeRows((current) => reconcileNestedRows(current, comments));
      return comments;
    } catch (failure) {
      setError(messageOf(failure));
      return null;
    } finally {
      setBusy(false);
    }
  };
  useEffect5(() => {
    if (!loaded || offline) return void 0;
    let active = true;
    Promise.resolve().then(() => invoke(actions, "loadComments", post)).then((result) => {
      if (active && Array.isArray(result?.comments)) {
        const comments = scoped(result.comments);
        setLoaded(comments);
        setTreeRows((current) => reconcileNestedRows(current, comments));
      }
    }).catch(() => {
    });
    return () => {
      active = false;
    };
  }, [signature]);
  const freshRows = [...treeRows.confirmed, ...treeRows.pending];
  const byParent = repliesByParent([...loaded ?? [], ...freshRows]);
  const isRemoved = (row) => Boolean(removedIds?.has?.(identityOf(row)));
  const roots = showAll && loaded ? repliesByParent([...loaded, ...slice.replies.filter((row) => !loaded.some((item) => identityOf(item) === identityOf(row)))]).get("") ?? [] : slice.replies;
  const visibleRoots = roots.filter((row) => !isRemoved(row));
  const more = showAll ? 0 : expanderCount(slice.total);
  if (!visibleRoots.length && !more) return null;
  const expand = async (id) => {
    if (offline || busy) return;
    if (!await load()) return;
    if (id) setExpandedRoots((current) => new Set(current).add(id));
    else setShowAll(true);
  };
  const targetRows = () => [...loaded ?? [], ...freshRows, ...slice.replies];
  const submitNested = async (body, parentId, mentions) => {
    const localId = `local:nested-${Date.now()}-${treeCountRef.current += 1}`;
    setExpandedRoots((current) => new Set(current).add(rootAncestorId(String(parentId), targetRows())));
    if (!loaded) void load();
    const optimistic = pendingReply(post, body, {
      did: data.identity ? String(data.identity.id) : null,
      name: data.identity?.name ?? "You",
      localId,
      parentId
    });
    setTreeRows((current) => ({ ...current, pending: [...current.pending, optimistic] }));
    const revert = () => setTreeRows((current) => ({
      ...current,
      pending: current.pending.filter((row) => row._id !== localId)
    }));
    return Promise.resolve().then(() => onReply(body, parentId, mentions)).then((result) => {
      if (!result?.comment || !identityOf(result.comment) || !scoped([result.comment]).length) {
        revert();
        throw new Error("The family server did not confirm this reply. Reload the conversation before trying again.");
      }
      setTreeRows((current) => ({
        pending: current.pending.filter((row) => row._id !== localId),
        confirmed: [
          ...current.confirmed.filter((row) => identityOf(row) !== identityOf(result.comment)),
          { ...result.comment, postId: result.comment.postId ?? identityOf(post) }
        ]
      }));
      return result;
    }, (failure) => {
      revert();
      throw failure;
    });
  };
  const submitCommentEdit = async (row, body) => {
    const id = identityOf(row);
    const snapshot = loaded;
    if (snapshot?.some((item) => identityOf(item) === id)) {
      setLoaded((current) => current ? current.map((item) => identityOf(item) === id ? { ...item, body } : item) : current);
    }
    try {
      return await invoke(actions, "editComment", post, id, body);
    } catch (failure) {
      if (snapshot) setLoaded(snapshot);
      throw failure;
    }
  };
  const renderRow = (reply, depth = 0, seen = /* @__PURE__ */ new Set(), rootId = identityOf(reply)) => {
    const id = identityOf(reply);
    if (!id || seen.has(id) || isRemoved(reply)) return null;
    const children = byParent.get(id) ?? [];
    const count = reply.responseCount ?? children.length;
    const open = expandedRoots.has(rootId);
    const nextSeen = new Set(seen).add(id);
    return /* @__PURE__ */ jsxs6(Box5, { sx: {
      ml: depth ? { xs: Math.min(depth, 2) * 2, lg: Math.min(depth, 3) * 3.5 } : 0,
      ...depth ? { borderLeft: "1px solid", borderColor: "divider", pl: 1 } : {}
    }, children: [
      /* @__PURE__ */ jsxs6(Stack4, { direction: "row", spacing: 1, alignItems: "flex-start", children: [
        /* @__PURE__ */ jsx6(
          AvatarFace,
          {
            origin,
            did: reply.authorDid ?? reply.authorId ?? null,
            kind: "header",
            metas: reply.authorAvatar ?? null,
            load: actions?.loadAvatarRendition,
            sx: { width: 30, height: 30, fontSize: 13 },
            children: (reply.author?.name ?? reply.authorName ?? memberName(reply.authorDid, data)).trim().charAt(0).toUpperCase()
          }
        ),
        /* @__PURE__ */ jsxs6(Box5, { sx: { minWidth: 0, flex: 1 }, children: [
          /* @__PURE__ */ jsxs6(Typography5, { variant: "caption", color: "porchlight.muted", children: [
            reply.authorName ?? memberName(reply.authorDid, data),
            " \xB7 ",
            relativeTime(reply.createdAt)
          ] }),
          /* @__PURE__ */ jsx6(Typography5, { variant: "body2", sx: { whiteSpace: "pre-wrap", overflowWrap: "anywhere" }, children: renderReplyBody(reply, data, navigate) }),
          reply.preview && /* @__PURE__ */ jsx6(LinkPreviewBlock, { preview: reply.preview, origin: origin ?? previewOrigin(reply, data), compact: true }),
          !offline && depth < 8 ? /* @__PURE__ */ jsx6(
            PresentReactions,
            {
              post,
              comment: reply,
              data,
              actions,
              spacingY: 1,
              actionRow: /* @__PURE__ */ jsx6(
                Button2,
                {
                  size: "small",
                  onClick: () => onReplyTarget?.(id === composerFor ? null : id),
                  sx: { px: 0, minWidth: 0 },
                  children: "Reply"
                }
              ),
              trailingAction: /* @__PURE__ */ jsx6(
                CommentOverflow,
                {
                  row: reply,
                  data,
                  offline,
                  onEdit: (r) => onEditTarget?.(r),
                  onDelete: (r) => onDeleteComment?.(r)
                }
              )
            }
          ) : /* @__PURE__ */ jsx6(PresentReactions, { post, comment: reply, data, actions, spacingY: 1 }),
          !offline && composerFor === id && /* @__PURE__ */ jsx6(Box5, { sx: { ml: { xs: 2, lg: 3.5 }, pl: 1, borderLeft: "1px solid", borderColor: "divider" }, children: /* @__PURE__ */ jsx6(
            ReplyForm,
            {
              label: "Your reply",
              replyingTo: reply.author?.name ?? reply.authorName ?? memberName(reply.authorDid, data),
              offline,
              post,
              actions,
              initialText: readDraft?.(composerTarget) ?? "",
              onDraft: (text) => onDraftDone?.(composerTarget, text),
              onDone: () => {
                onComposerClosed?.();
                onDraftDone?.(composerTarget, "");
              },
              onSubmit: (body, mentions) => submitNested(body, composerTarget, mentions)
            },
            composerTarget
          ) }),
          !open && count > 0 && /* @__PURE__ */ jsx6(
            Button2,
            {
              size: "small",
              disabled: offline || busy,
              onClick: () => expand(id),
              sx: { display: "block", px: 0, minWidth: 0, color: "secondary.main" },
              children: `View ${count} more responses`
            }
          )
        ] })
      ] }),
      open && children.map((child) => renderRow(child, depth + 1, nextSeen, rootId))
    ] }, id);
  };
  const composerTarget = composerFor && composerFor !== "post" ? composerFor : null;
  const editTarget = editFor && editFor !== "post" ? editFor : null;
  const editRow = editTarget ? (slice?.replies ?? []).find((row) => identityOf(row) === editTarget) ?? (loaded ?? []).find((row) => identityOf(row) === editTarget) : null;
  return /* @__PURE__ */ jsxs6(Box5, { sx: { mt: photoFirst.spacing.reactionsSlice / 8, borderTop: "1px solid", borderColor: photoFirst.dividerColor, pt: 1.25 }, children: [
    /* @__PURE__ */ jsx6(Stack4, { spacing: 1, children: visibleRoots.map((reply) => renderRow(reply)) }),
    more > 0 && /* @__PURE__ */ jsx6(
      Button2,
      {
        size: "small",
        disabled: offline || busy,
        onClick: () => expand(null),
        sx: { mt: 1, px: 0, minWidth: 0, fontSize: 14, fontWeight: 600, color: "secondary.main" },
        children: `View ${more} more comments`
      }
    ),
    editTarget && !offline && /* @__PURE__ */ jsx6(
      CommentEditForm,
      {
        row: editRow,
        initialText: readDraft?.(`edit:${editTarget}`) ?? editRow?.body ?? "",
        onDraft: (text) => onDraftDone?.(`edit:${editTarget}`, text),
        onDone: () => {
          onEditClosed?.();
          onDraftDone?.(`edit:${editTarget}`, "");
        },
        onCancel: () => {
          onEditClosed?.();
          onDraftDone?.(`edit:${editTarget}`, "");
        },
        onSubmit: (body) => submitCommentEdit(editRow, body)
      },
      `edit:${editTarget}`
    ),
    error && /* @__PURE__ */ jsx6(Alert2, { severity: "error", sx: { mt: 1 }, children: error })
  ] });
}
var mentionSegmentsOf = (reply) => mentionSegments(reply.body, reply.mentionNames);
var canSeeDirectory = (data) => Boolean(data?.identity?.id) && (data?.members ?? []).some((entry) => entry?.did === data?.identity?.id && entry?.role === "owner");
function Mention({ text, data, navigate }) {
  const emphasis = { color: "primary.main", fontWeight: 650, bgcolor: "porchlight.amberSoft", borderRadius: "4px", px: 0.4 };
  if (canSeeDirectory(data) && typeof navigate === "function") {
    return /* @__PURE__ */ jsx6(Typography5, { component: "span", onClick: () => navigate("/members"), title: "View the family", sx: { ...emphasis, cursor: "pointer" }, children: text });
  }
  return /* @__PURE__ */ jsx6(Typography5, { component: "span", sx: emphasis, children: text });
}
function renderReplyBody(reply, data, navigate) {
  return mentionSegmentsOf(reply).map((segment, index) => segment.mention ? /* @__PURE__ */ jsx6(Mention, { text: segment.text, data, navigate }, index) : /* @__PURE__ */ jsx6(React7.Fragment, { children: segment.text }, index));
}
function ReplyForm({ label, onSubmit, offline, post, actions, replyingTo = null, initialText = "", onDraft = null, onDone = null }) {
  const [text, setText] = useState6(initialText);
  const [mention, setMention] = useState6(null);
  const [candidates, setCandidates] = useState6([]);
  const [pickedNames, setPickedNames] = useState6([]);
  const [pickedDids, setPickedDids] = useState6([]);
  const inputRef = useRef3(null);
  const fieldRef = useRef3(null);
  const requestRef = useRef3(0);
  const operation = useOperation();
  const queryCandidates = (value, caret) => {
    const anchor = mentionDraft(mentionAnchor(value, caret), pickedNames);
    setMention(anchor ? { anchor } : null);
    const token = ++requestRef.current;
    if (!anchor || typeof actions?.mentionCandidates !== "function") {
      setCandidates([]);
      return;
    }
    Promise.resolve().then(() => actions.mentionCandidates(post, anchor.query)).then((result) => {
      if (requestRef.current === token) setCandidates((result?.candidates ?? []).filter((row) => row?.name));
    }).catch(() => {
      if (requestRef.current === token) setCandidates([]);
    });
  };
  const onTextChange = (event) => {
    const value = event.target.value;
    setText(value);
    onDraft?.(value);
    queryCandidates(value, event.target.selectionStart ?? value.length);
  };
  const pick = (candidate) => {
    if (!mention) return;
    const applied = applyMention(text, mention.anchor, candidate.name);
    setText(applied.text);
    if (applied.caret !== null && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.setSelectionRange(applied.caret, applied.caret);
    }
    setPickedNames((current) => [...current, candidate.name]);
    setPickedDids((current) => current.includes(candidate.did) ? current : [...current, candidate.did]);
    setMention(null);
    setCandidates([]);
  };
  const closeMention = () => {
    setMention(null);
    setCandidates([]);
  };
  return /* @__PURE__ */ jsxs6(Stack4, { component: "form", spacing: 1, sx: { my: 1 }, onSubmit: (event) => {
    event.preventDefault();
    if (text.trim()) operation.run(() => onSubmit(text.trim(), [...pickedDids]), () => {
      setText("");
      setMention(null);
      setCandidates([]);
      setPickedNames([]);
      setPickedDids([]);
      onDraft?.("");
      onDone?.();
    });
  }, children: [
    replyingTo && /* @__PURE__ */ jsx6(Typography5, { variant: "caption", color: "text.secondary", "data-testid": "reply-target", children: `Replying to ${replyingTo}` }),
    /* @__PURE__ */ jsxs6(Box5, { ref: fieldRef, sx: { position: "relative" }, children: [
      /* @__PURE__ */ jsx6(
        TextField2,
        {
          fullWidth: true,
          inputRef: (element) => {
            inputRef.current = element;
          },
          label,
          value: text,
          onChange: onTextChange,
          onKeyDown: (event) => {
            if (event.key === "Escape" && mention) {
              event.stopPropagation();
              closeMention();
            }
          },
          multiline: true,
          minRows: 2,
          helperText: offline ? void 0 : "Type @ to mention someone by name."
        }
      ),
      mention && candidates.length > 0 && /* @__PURE__ */ jsx6(
        Popover2,
        {
          open: true,
          anchorEl: fieldRef.current,
          onClose: closeMention,
          anchorOrigin: { vertical: "bottom", horizontal: "left" },
          transformOrigin: { vertical: "top", horizontal: "left" },
          disableAutoFocus: true,
          disableEnforceFocus: true,
          slotProps: { paper: { sx: { maxHeight: 280, minWidth: 220 }, elevation: 3 } },
          children: /* @__PURE__ */ jsx6(List, { dense: true, disablePadding: true, children: candidates.map((candidate) => /* @__PURE__ */ jsx6(ListItemButton, { onClick: () => pick(candidate), sx: { minHeight: 44 }, children: /* @__PURE__ */ jsx6(ListItemText, { primary: candidate.name }) }, candidate.did)) })
        }
      )
    ] }),
    /* @__PURE__ */ jsx6(Button2, { type: "submit", variant: "contained", disabled: offline || operation.busy || !text.trim(), sx: { alignSelf: "flex-start" }, children: operation.busy ? "Sending\u2026" : "Send reply" }),
    operation.error && /* @__PURE__ */ jsx6(Alert2, { severity: "error", children: operation.error })
  ] });
}
export {
  PostCard
};
