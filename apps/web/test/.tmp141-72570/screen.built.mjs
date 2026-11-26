// src/people.jsx
import React, { useEffect, useMemo, useState } from "react";
import {
  Alert,
  Box,
  Button,
  Chip,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  FormControl,
  InputLabel,
  MenuItem,
  Paper,
  Select,
  Stack,
  Switch,
  TextField,
  Typography
} from "@mui/material";
import AddOutlined from "@mui/icons-material/AddOutlined";
import DeleteOutlined from "@mui/icons-material/DeleteOutlined";
import DownloadOutlined from "@mui/icons-material/DownloadOutlined";
import EditOutlined from "@mui/icons-material/EditOutlined";

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

// src/people-model.js
var HEADING = "People & Things";
var FACES_TITLE = "Faces";
var VEHICLES_TITLE = "Vehicles";
var KIND_LABELS = { face: "Face", vehicle: "Vehicle" };
function kindLabel(kind) {
  return KIND_LABELS[kind] ?? null;
}
var ON_POSTURE_COPY = "Recognition is on for this home \u2014 recognized sightings annotate events and visits at the confidence shown, and every computation stays on the hub. The zero-computation audit rides the metrics below.";
var OFF_POSTURE_COPY = "Recognition is off for this home \u2014 nothing computes and no new sightings annotate. The registry below keeps rendering with existing entries and history, and no entry is ever cleared by a switch. Flip recognition on at the head of People & Things to enroll or resume.";
var SWITCH_LABEL = "Recognition";
function settingsPosture(settings) {
  const on = settings?.enabled === true;
  return {
    on,
    copy: on ? ON_POSTURE_COPY : OFF_POSTURE_COPY
  };
}
var SWITCH_VIEWER_COPY = "Only the family owner can change this switch.";
function confidencePercent(confidence) {
  const value = Number(confidence);
  if (typeof confidence !== "number" || !Number.isFinite(value) || value < 0 || value > 1) return null;
  return Math.round(value * 100);
}
function decisionLabel(name, decision, confidence) {
  if (typeof name !== "string" || name.trim() === "") return null;
  if (decision === "asserted") return name;
  const percent = confidencePercent(confidence);
  return `looks like ${name}${percent == null ? "" : ` (${percent}%)`}`;
}
var nonEmpty = (value) => typeof value === "string" && value.trim() !== "";
function entriesOf(entries, kind) {
  return (Array.isArray(entries) ? entries : []).filter((entry) => entry?.kind === kind);
}
var ENROLLED_HOUSEHOLD_LABEL = "Household";
var ENROLLED_VISIT_LABEL = "Enrolled for a visit";
function entrySubtitle(entry) {
  const kind = kindLabel(entry?.kind) ?? "Entry";
  if (entry?.kind === "vehicle" && nonEmpty(entry?.plateText)) return `${kind} \xB7 Plate ${entry.plateText}`;
  return kind;
}
var ACCOUNTABILITY_PREFIX = "Accountability note:";
function enrolledForCopy(entry) {
  if (entry?.enrolledFor === "visit") {
    const note = nonEmpty(entry?.accountabilityNote) ? ` \u2014 ${ACCOUNTABILITY_PREFIX} ${entry.accountabilityNote}` : "";
    return `${ENROLLED_VISIT_LABEL}${note}`;
  }
  if (entry?.enrolledFor === "household") return ENROLLED_HOUSEHOLD_LABEL;
  return null;
}
function sightingCountCopy(entry) {
  const count = Array.isArray(entry?.sightings) ? entry.sightings.length : 0;
  return count === 1 ? "1 sighting" : `${count} sightings`;
}
function sightDateCopy(at) {
  const seconds = Number(at);
  if (!Number.isFinite(seconds) || seconds <= 0) return null;
  return relativeTime(new Date(seconds * 1e3).toISOString());
}
function sightingCopy(sighting) {
  const when = sightDateCopy(sighting?.at);
  const where = nonEmpty(sighting?.cameraId) ? ` \xB7 Camera ${sighting.cameraId}` : "";
  return `${when ?? "Unknown time"}${where}`;
}
var ENROLL_FOR_OPTIONS = [
  { value: "household", label: ENROLLED_HOUSEHOLD_LABEL },
  { value: "visit", label: ENROLLED_VISIT_LABEL }
];
function frameFromDataUrl(dataUrl) {
  if (typeof dataUrl !== "string") return null;
  const match = dataUrl.match(/^data:image\/jpeg;base64,([A-Za-z0-9+/=]+)$/);
  return match ? { format: "jpeg", data: match[1] } : null;
}
function validateEnrollDraft(draftInput) {
  const { kind, name, frames, plateText, enrolledFor, accountabilityNote } = draftInput ?? {};
  if (!nonEmpty(name)) return "Give this entry a name.";
  if (kind === "face") {
    if (!Array.isArray(frames) || frames.length === 0) return "Add a photo showing the face to enroll.";
  } else if (kind === "vehicle") {
    if (!nonEmpty(plateText) && (!Array.isArray(frames) || frames.length === 0)) {
      return "A vehicle entry carries a plate text or a photo.";
    }
  }
  if (enrolledFor === "visit" && !nonEmpty(accountabilityNote)) {
    return "Enrolling for a visit requires the enrolling member's accountability note.";
  }
  return null;
}
function purgeCopy(purged) {
  const counts = purged?.purged ?? {};
  const list = [
    `${counts.descriptorVectors ?? 0} descriptor vector${(counts.descriptorVectors ?? 0) === 1 ? "" : "s"}`,
    `${counts.plateReads ?? 0} plate read${(counts.plateReads ?? 0) === 1 ? "" : "s"}`,
    `${counts.sightings ?? 0} sighting${(counts.sightings ?? 0) === 1 ? "" : "s"}`,
    `${counts.annotations ?? 0} annotation${(counts.annotations ?? 0) === 1 ? "" : "s"}`
  ];
  return `Deleted. Purged ${list.join(", ")}.`;
}
function metricsCopy(metrics) {
  const rows = [
    ["descriptorComputations", "descriptor computations"],
    ["plateReads", "plate reads"],
    ["recognitionRuns", "recognition runs"],
    ["refusedDisabled", "runs refused while off"]
  ];
  return rows.map(([key, label]) => `${Number(metrics?.[key] ?? 0)} ${label}`).join(" \xB7 ");
}
function evidenceWindow(at, halfWindowSec = 60) {
  const seconds = Number(at);
  if (!Number.isFinite(seconds) || seconds <= 0) return null;
  return {
    from: new Date((seconds - halfWindowSec) * 1e3).toISOString(),
    to: new Date((seconds + halfWindowSec) * 1e3).toISOString()
  };
}
function sightedEvent(events, sighting) {
  if (!nonEmpty(sighting?.eventId)) return null;
  return (Array.isArray(events) ? events : []).find((event) => event?._id === sighting.eventId) ?? null;
}
function sightingHasEvidence(sighting) {
  return nonEmpty(sighting?.cameraId) && nonEmpty(sighting?.eventId);
}
var EVIDENCE_UNOPENABLE_COPY = "This sighting has no camera moment linked to it yet \u2014 its evidence opens once the sighting references an event.";

// src/install.js
var INSTALL_USAGE_GATE_MS = 2 * 60 * 1e3;
var INSTALL_SUPPRESSION_MS = 14 * 24 * 60 * 60 * 1e3;

// src/share-matrix.js
function downloadBlob(blob, fileName) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = fileName;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 6e4);
}

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

// src/camera-model.js
function mediaUrl({ origin, homeId, cameraId, path, token }) {
  const base = String(origin ?? "").replace(/\/+$/, "") || (typeof window !== "undefined" ? window.location.origin : "");
  if (!base || !homeId || !cameraId || !token) return null;
  return `${base}/api/home/homes/${encodeURIComponent(homeId)}/cameras/${encodeURIComponent(cameraId)}/media?path=${encodeURIComponent(String(path ?? ""))}&token=${encodeURIComponent(token)}`;
}
function gapCopy(reason) {
  switch (reason) {
    case "retention-expired":
      return "That footage was recorded past this camera's retention window \u2014 expired footage can't play anymore.";
    case "recording-disabled":
      return "Recording was off at that moment \u2014 nothing was captured to play.";
    case "degraded":
      return "The camera engine is running degraded right now \u2014 try again shortly.";
    case "offline":
      return "The camera was offline at that moment \u2014 nothing was captured.";
    default:
      return "The footage wasn't available at that moment \u2014 the engine couldn't serve it.";
  }
}
function eventEvidence(event) {
  const ref = (event?.evidenceRefs ?? []).find((row) => row?.kind === "still" || row?.kind === "clip" || row?.kind === "segment");
  if (ref && ref.path) return { kind: ref.kind, path: ref.path, cameraId: event?.observations?.[0]?.cameraId ?? null };
  const gap = (event?.evidenceRefs ?? []).find((row) => row?.kind === "gap");
  if (gap) return { kind: "gap", copy: gapCopy(gap.reason) };
  return { kind: "gap", copy: gapCopy("unavailable") };
}

// src/people.jsx
import { Fragment, jsx, jsxs } from "react/jsx-runtime";
var messageOf = (error) => error?.message || "That did not work. Please try again.";
var ownerOf = (home) => home?.access?.role === "owner" || home?.role === "owner";
var originOf = (serverUrl) => {
  try {
    return serverUrl ? new URL(serverUrl).origin : null;
  } catch {
    return null;
  }
};
function SectionHeader({ title, action }) {
  return /* @__PURE__ */ jsxs(Stack, { direction: "row", alignItems: "center", justifyContent: "space-between", sx: { mt: 4, mb: 1.5 }, children: [
    /* @__PURE__ */ jsx(Typography, { variant: "h6", children: title }),
    action
  ] });
}
function EmptyLine({ children }) {
  return /* @__PURE__ */ jsx(Typography, { variant: "body2", sx: { color: "text.secondary", py: 0.75 }, children });
}
function RecognitionSwitch({ settings, ownerHere, busy, error, onToggle }) {
  const posture = settingsPosture(settings);
  return /* @__PURE__ */ jsxs(Box, { sx: { mt: 2 }, children: [
    /* @__PURE__ */ jsxs(Paper, { variant: "outlined", sx: { p: 2 }, children: [
      /* @__PURE__ */ jsxs(Stack, { direction: "row", alignItems: "center", justifyContent: "space-between", spacing: 1.5, sx: { flexWrap: "wrap", useFlexGap: true }, children: [
        /* @__PURE__ */ jsxs(Stack, { sx: { minWidth: 0 }, children: [
          /* @__PURE__ */ jsxs(Stack, { direction: "row", spacing: 1, alignItems: "center", children: [
            /* @__PURE__ */ jsx(Typography, { variant: "subtitle2", sx: { fontWeight: 600 }, children: SWITCH_LABEL }),
            /* @__PURE__ */ jsx(Chip, { size: "small", label: posture.on ? "On" : "Off", color: posture.on ? "success" : "default" })
          ] }),
          /* @__PURE__ */ jsx(Typography, { variant: "body2", sx: { color: "text.secondary", mt: 0.5 }, children: ownerHere ? "Off means recognition stops upstream entirely \u2014 nothing computes, no annotations appear \u2014 while the registry and its history keep rendering. Turning it back on resumes without re-enrollment." : SWITCH_VIEWER_COPY })
        ] }),
        /* @__PURE__ */ jsx(
          Switch,
          {
            checked: posture.on,
            disabled: !ownerHere || busy,
            inputProps: { "aria-label": SWITCH_LABEL },
            onChange: (event) => onToggle(event.target.checked)
          }
        )
      ] }),
      error && /* @__PURE__ */ jsx(Alert, { severity: "warning", sx: { mt: 1.5 }, children: error })
    ] }),
    !posture.on && /* @__PURE__ */ jsx(Alert, { severity: "info", sx: { mt: 1.5 }, icon: false, children: OFF_POSTURE_COPY }),
    /* @__PURE__ */ jsx(Typography, { variant: "body2", sx: { color: "text.secondary", mt: 1.5 }, children: posture.copy })
  ] });
}
function SightingRow({ entryName, sighting, evidence, onOpen }) {
  const label = decisionLabel(entryName, sighting?.decision, sighting?.confidence);
  const openable = sightingHasEvidence(sighting);
  return /* @__PURE__ */ jsxs(Stack, { spacing: 0.5, sx: { py: 0.75 }, children: [
    /* @__PURE__ */ jsxs(Stack, { direction: "row", spacing: 1, alignItems: "center", sx: { flexWrap: "wrap", useFlexGap: true }, children: [
      /* @__PURE__ */ jsx(Typography, { variant: "body2", sx: { color: "text.secondary" }, children: sightingCopy(sighting) }),
      label && /* @__PURE__ */ jsx(Chip, { size: "small", label }),
      openable && /* @__PURE__ */ jsx(Button, { size: "small", onClick: () => onOpen(sighting), children: "Open evidence" })
    ] }),
    evidence?.phase === "loading" && /* @__PURE__ */ jsx(Typography, { variant: "caption", sx: { color: "text.secondary" }, children: "Opening that moment's footage\u2026" }),
    evidence?.phase === "still" && /* @__PURE__ */ jsx(Box, { component: "img", src: evidence.url, alt: "Sighting evidence", sx: { width: "100%", maxWidth: 420, borderRadius: 2 } }),
    evidence?.phase === "gap" && /* @__PURE__ */ jsx(Typography, { variant: "caption", sx: { display: "block", color: "text.secondary" }, children: evidence.copy })
  ] });
}
function EntryRow({ entry, evidence, onRename, onDelete, onOpenEvidence, defaultOpen = false }) {
  const [open, setOpen] = useState(defaultOpen === true);
  const meta = enrolledForCopy(entry);
  return /* @__PURE__ */ jsxs(Paper, { variant: "outlined", sx: { p: 2, mb: 1.5 }, children: [
    /* @__PURE__ */ jsxs(Stack, { direction: "row", alignItems: "center", justifyContent: "space-between", spacing: 1.5, sx: { flexWrap: "wrap", useFlexGap: true }, children: [
      /* @__PURE__ */ jsxs(Stack, { sx: { minWidth: 0 }, children: [
        /* @__PURE__ */ jsx(Typography, { variant: "subtitle2", sx: { fontWeight: 600 }, children: entry?.name }),
        /* @__PURE__ */ jsxs(Typography, { variant: "body2", sx: { color: "text.secondary", mt: 0.5 }, children: [
          entrySubtitle(entry),
          " \xB7 ",
          sightingCountCopy(entry)
        ] })
      ] }),
      /* @__PURE__ */ jsxs(Stack, { direction: "row", spacing: 1, alignItems: "center", children: [
        /* @__PURE__ */ jsx(Button, { size: "small", onClick: () => setOpen(!open), children: open ? "Hide sightings" : "Review sightings" }),
        /* @__PURE__ */ jsx(Button, { size: "small", startIcon: /* @__PURE__ */ jsx(EditOutlined, {}), onClick: () => onRename(entry), children: "Rename" }),
        /* @__PURE__ */ jsx(Button, { size: "small", startIcon: /* @__PURE__ */ jsx(DeleteOutlined, {}), color: "error", onClick: () => onDelete(entry), children: "Delete" })
      ] })
    ] }),
    meta && /* @__PURE__ */ jsx(Typography, { variant: "body2", sx: { mt: 1 }, children: meta }),
    open && /* @__PURE__ */ jsxs(Stack, { sx: { mt: 1, borderTop: "1px solid", borderColor: "divider", pt: 1 }, children: [
      (Array.isArray(entry?.sightings) ? entry.sightings : []).length === 0 && /* @__PURE__ */ jsx(EmptyLine, { children: "No sightings recorded yet \u2014 recognition will annotate them here as they happen." }),
      (Array.isArray(entry?.sightings) ? entry.sightings : []).map((sighting, index) => /* @__PURE__ */ jsx(
        SightingRow,
        {
          entryName: entry?.name,
          sighting,
          evidence: evidence?.[`${entry?._id}:${rowKeyOf(sighting)}`],
          onOpen: (sighting_) => onOpenEvidence(entry, sighting_)
        },
        index
      ))
    ] })
  ] });
}
function rowKeyOf(sighting) {
  return `${sighting?.at ?? ""}:${sighting?.cameraId ?? ""}`;
}
function EnrollDialog({ kind, open, busy, error, onClose, onSubmit }) {
  const [name, setName] = useState("");
  const [plateText, setPlateText] = useState("");
  const [enrolledFor, setEnrolledFor] = useState("household");
  const [accountabilityNote, setNote] = useState("");
  const [frames, setFrames] = useState([]);
  const [formError, setFormError] = useState("");
  const reset = () => {
    setName("");
    setPlateText("");
    setEnrolledFor("household");
    setNote("");
    setFrames([]);
    setFormError("");
  };
  const pickPhoto = (files) => {
    const list = Array.from(files ?? []).slice(0, 3);
    const frames2 = [];
    let pending = list.length;
    let refused = false;
    for (const file of list) {
      const reader = new FileReader();
      reader.onload = () => {
        const frame = frameFromDataUrl(String(reader.result ?? ""));
        if (frame) frames2.push(frame);
        else refused = true;
        pending -= 1;
        if (pending === 0) {
          setFrames(frames2.slice(0, 3));
          setFormError(refused && frames2.length === 0 ? "Use a JPEG photo." : "");
        }
      };
      reader.readAsDataURL(file);
    }
  };
  const submit = () => {
    const draft = { kind, name, frames, plateText, enrolledFor, accountabilityNote };
    const refusal = validateEnrollDraft(draft);
    if (refusal) {
      setFormError(refusal);
      return;
    }
    setFormError("");
    onSubmit(draft);
  };
  return /* @__PURE__ */ jsxs(Dialog, { open, onClose: () => {
    reset();
    onClose();
  }, maxWidth: "sm", fullWidth: true, children: [
    /* @__PURE__ */ jsx(DialogTitle, { children: kind === "face" ? `Add a face to ${FACES_TITLE}` : `Add a vehicle to ${VEHICLES_TITLE}` }),
    /* @__PURE__ */ jsx(DialogContent, { children: /* @__PURE__ */ jsxs(Stack, { spacing: 1.5, sx: { mt: 1 }, children: [
      (error || formError) && /* @__PURE__ */ jsx(Alert, { severity: "warning", children: error || formError }),
      /* @__PURE__ */ jsx(TextField, { size: "small", label: "Name", value: name, onChange: (event) => setName(event.target.value) }),
      kind === "face" && /* @__PURE__ */ jsxs(Button, { variant: "outlined", component: "label", startIcon: /* @__PURE__ */ jsx(AddOutlined, {}), children: [
        frames.length > 0 ? `${frames.length} photo frame${frames.length === 1 ? "" : "s"} attached` : "Add a JPEG photo of the face",
        /* @__PURE__ */ jsx("input", { type: "file", accept: "image/jpeg", hidden: true, multiple: true, onChange: (event) => pickPhoto(event.target.files) })
      ] }),
      kind === "vehicle" && /* @__PURE__ */ jsxs(Fragment, { children: [
        /* @__PURE__ */ jsx(TextField, { size: "small", label: "Plate text", value: plateText, onChange: (event) => setPlateText(event.target.value), helperText: "Optional \u2014 leave the plate empty and add a photo instead." }),
        /* @__PURE__ */ jsxs(Button, { variant: "outlined", component: "label", startIcon: /* @__PURE__ */ jsx(AddOutlined, {}), children: [
          frames.length > 0 ? `${frames.length} photo frame${frames.length === 1 ? "" : "s"} attached` : "Add a JPEG photo",
          /* @__PURE__ */ jsx("input", { type: "file", accept: "image/jpeg", hidden: true, multiple: true, onChange: (event) => pickPhoto(event.target.files) })
        ] })
      ] }),
      /* @__PURE__ */ jsxs(FormControl, { size: "small", fullWidth: true, children: [
        /* @__PURE__ */ jsx(InputLabel, { children: "Enrolled for" }),
        /* @__PURE__ */ jsx(Select, { value: enrolledFor, label: "Enrolled for", onChange: (event) => setEnrolledFor(event.target.value), children: ENROLL_FOR_OPTIONS.map((option) => /* @__PURE__ */ jsx(MenuItem, { value: option.value, children: option.label }, option.value)) })
      ] }),
      enrolledFor === "visit" && /* @__PURE__ */ jsx(
        TextField,
        {
          size: "small",
          label: "Accountability note",
          value: accountabilityNote,
          onChange: (event) => setNote(event.target.value),
          helperText: `Required for a visit enrollment \u2014 you, the enrolling member, own the consent responsibility. ${ACCOUNTABILITY_PREFIX} records it with the entry.`
        }
      )
    ] }) }),
    /* @__PURE__ */ jsxs(DialogActions, { children: [
      /* @__PURE__ */ jsx(Button, { onClick: () => {
        reset();
        onClose();
      }, children: "Cancel" }),
      /* @__PURE__ */ jsx(Button, { variant: "contained", disabled: busy, onClick: submit, children: "Add entry" })
    ] })
  ] });
}
function RenameDialog({ entry, open, busy, error, onClose, onSubmit }) {
  const [name, setName] = useState(entry?.name ?? "");
  const [plateText, setPlateText] = useState(entry?.plateText ?? "");
  return /* @__PURE__ */ jsxs(Dialog, { open, onClose, maxWidth: "sm", fullWidth: true, children: [
    /* @__PURE__ */ jsxs(DialogTitle, { children: [
      "Rename ",
      entry?.name
    ] }),
    /* @__PURE__ */ jsx(DialogContent, { children: /* @__PURE__ */ jsxs(Stack, { spacing: 1.5, sx: { mt: 1 }, children: [
      error && /* @__PURE__ */ jsx(Alert, { severity: "warning", children: error }),
      /* @__PURE__ */ jsx(TextField, { size: "small", label: "Name", value: name, onChange: (event) => setName(event.target.value) }),
      entry?.kind === "vehicle" && /* @__PURE__ */ jsx(TextField, { size: "small", label: "Plate text", value: plateText, onChange: (event) => setPlateText(event.target.value) })
    ] }) }),
    /* @__PURE__ */ jsxs(DialogActions, { children: [
      /* @__PURE__ */ jsx(Button, { onClick: onClose, children: "Cancel" }),
      /* @__PURE__ */ jsx(Button, { variant: "contained", disabled: busy, onClick: () => onSubmit(entry, { name, plateText }), children: "Save" })
    ] })
  ] });
}
function DeleteDialog({ entry, open, busy, error, receipt, onClose, onSubmit }) {
  return /* @__PURE__ */ jsxs(Dialog, { open, onClose, maxWidth: "sm", fullWidth: true, children: [
    /* @__PURE__ */ jsxs(DialogTitle, { children: [
      "Delete ",
      entry?.name,
      "?"
    ] }),
    /* @__PURE__ */ jsx(DialogContent, { children: /* @__PURE__ */ jsxs(Stack, { spacing: 1.5, sx: { mt: 1 }, children: [
      error && /* @__PURE__ */ jsx(Alert, { severity: "warning", children: error }),
      receipt && /* @__PURE__ */ jsx(Alert, { severity: "info", icon: false, children: receipt }),
      /* @__PURE__ */ jsx(Typography, { variant: "body2", sx: { color: "text.secondary" }, children: "Deleting purges this entry's descriptors, plate reads, and sighting history, and removes the identity annotations from past events \u2014 the events keep their factual content. This cannot be undone." })
    ] }) }),
    /* @__PURE__ */ jsxs(DialogActions, { children: [
      /* @__PURE__ */ jsx(Button, { onClick: onClose, children: "Keep entry" }),
      /* @__PURE__ */ jsx(Button, { variant: "contained", color: "error", disabled: busy, onClick: () => onSubmit(entry), children: "Delete and purge" })
    ] })
  ] });
}
function People({ data, actions }) {
  const origin = originOf(data?.server?.url) || (typeof window !== "undefined" ? window.location.origin : null);
  const [homeId, setHomeId] = useState(null);
  const [ownerHere, setOwnerHere] = useState(false);
  const [hasHome, setHasHome] = useState(true);
  const [settings, setSettings] = useState(null);
  const [entries, setEntries] = useState([]);
  const [metrics, setMetrics] = useState(null);
  const [error, setError] = useState("");
  const [switchBusy, setSwitchBusy] = useState(false);
  const [switchError, setSwitchError] = useState("");
  const [enrollKind, setEnrollKind] = useState(null);
  const [enrollBusy, setEnrollBusy] = useState(false);
  const [enrollError, setEnrollError] = useState("");
  const [renaming, setRenaming] = useState(null);
  const [renameBusy, setRenameBusy] = useState(false);
  const [renameError, setRenameError] = useState("");
  const [deleting, setDeleting] = useState(null);
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [deleteError, setDeleteError] = useState("");
  const [deleteReceipt, setDeleteReceipt] = useState("");
  const [viewToken, setViewToken] = useState(null);
  const [evidence, setEvidence] = useState({});
  const reloadRegistry = async (id = homeId) => {
    if (!id) return;
    try {
      const [registry, counts] = await Promise.all([actions.loadEntries(id), actions.loadMetrics(id)]);
      setEntries(Array.isArray(registry?.entries) ? registry.entries : []);
      setMetrics(counts?.metrics ?? null);
      setError("");
    } catch (failure) {
      setError(messageOf(failure));
    }
  };
  const reloadSettings = async (id = homeId) => {
    if (!id) return;
    try {
      const answer = await actions.loadRecognitionSettings(id);
      setSettings(answer?.settings ?? null);
    } catch (failure) {
      setSwitchError(messageOf(failure));
    }
  };
  useEffect(() => {
    let stale = false;
    void (async () => {
      setError("");
      try {
        const homes = await actions.loadHomes();
        const first = Array.isArray(homes?.homes) ? homes.homes[0] : null;
        if (!first?._id) {
          if (!stale) setHasHome(false);
          return;
        }
        const detail = await actions.loadHome(first._id);
        if (stale) return;
        setHomeId(first._id);
        setOwnerHere(ownerOf(detail?.home));
        setHasHome(true);
        await Promise.all([
          reloadSettings(first._id),
          reloadRegistry(first._id)
        ]);
      } catch (failure) {
        if (!stale) setError(messageOf(failure));
      }
    })();
    return () => {
      stale = true;
    };
  }, []);
  const toggleRecognition = async (next) => {
    setSwitchBusy(true);
    setSwitchError("");
    try {
      await actions.saveRecognitionSettings(homeId, next);
      await reloadSettings();
    } catch (failure) {
      setSwitchError(messageOf(failure));
    } finally {
      setSwitchBusy(false);
    }
  };
  const enroll = async (draft) => {
    setEnrollBusy(true);
    setEnrollError("");
    try {
      await actions.enrollEntry({ homeId, ...draft });
      setEnrollKind(null);
      await reloadRegistry();
    } catch (failure) {
      setEnrollError(messageOf(failure));
    } finally {
      setEnrollBusy(false);
    }
  };
  const rename = async (entry, patch) => {
    setRenameBusy(true);
    setRenameError("");
    try {
      await actions.renameEntry(entry._id, homeId, patch);
      setRenaming(null);
      await reloadRegistry();
    } catch (failure) {
      setRenameError(messageOf(failure));
    } finally {
      setRenameBusy(false);
    }
  };
  const confirmDelete = async (entry) => {
    setDeleteBusy(true);
    setDeleteError("");
    try {
      const answer = await actions.deleteEntry(entry._id, homeId);
      setDeleting(null);
      setDeleteReceipt(purgeCopy(answer));
      await reloadRegistry();
    } catch (failure) {
      setDeleteError(messageOf(failure));
    } finally {
      setDeleteBusy(false);
    }
  };
  const openEvidence = async (entry, sighting) => {
    const key = `${entry?._id}:${rowKeyOf(sighting)}`;
    if (!sightingHasEvidence(sighting)) {
      setEvidence((current) => ({ ...current, [key]: { phase: "gap", copy: EVIDENCE_UNOPENABLE_COPY } }));
      return;
    }
    setEvidence((current) => ({ ...current, [key]: { phase: "loading" } }));
    try {
      const window_ = evidenceWindow(sighting.at);
      if (!window_) throw new Error("That sighting's moment can't be read.");
      let token = viewToken;
      if (!token) {
        const session = await actions.openViewSession(homeId);
        token = session?.token ?? null;
        if (token) setViewToken(token);
      }
      const timeline = await actions.loadTimeline(homeId, { from: window_.from, to: window_.to, cameraId: sighting.cameraId });
      const event = sightedEvent(timeline?.events, sighting);
      const ref = eventEvidence(event);
      if (ref.kind === "gap" || !ref.cameraId || !ref.path) {
        setEvidence((current) => ({ ...current, [key]: { phase: "gap", copy: ref.copy ?? gapCopy("unavailable") } }));
        return;
      }
      const url = mediaUrl({ origin, homeId, cameraId: ref.cameraId, path: ref.path, token });
      setEvidence((current) => ({ ...current, [key]: url ? { phase: "still", url } : { phase: "gap", copy: gapCopy("unavailable") } }));
    } catch (failure) {
      setEvidence((current) => ({ ...current, [key]: { phase: "gap", copy: messageOf(failure) } }));
    }
  };
  const exportRegistry = async () => {
    setDeleteError("");
    try {
      const bundle = await actions.exportRegistry(homeId);
      downloadBlob(
        new Blob([JSON.stringify(bundle, null, 2)], { type: "application/json" }),
        `porchlight-registry-${homeId}.json`
      );
    } catch (failure) {
      setError(messageOf(failure));
    }
  };
  const faces = useMemo(() => entriesOf(entries, "face"), [entries]);
  const vehicles = useMemo(() => entriesOf(entries, "vehicle"), [entries]);
  return /* @__PURE__ */ jsxs(Box, { sx: { maxWidth: 760, mx: "auto", px: { xs: 2, sm: 3 }, py: { xs: 2, sm: 3 }, pb: 12 }, children: [
    /* @__PURE__ */ jsx(Typography, { variant: "h4", sx: { mb: 0.5 }, children: HEADING }),
    /* @__PURE__ */ jsx(Typography, { variant: "body2", sx: { color: "text.secondary" }, children: `The household's known faces and vehicles, built locally on the hub and owned by you. Recognized identities annotate events and visits with the confidence shown; uncertain matches say "looks like", never a bare name.` }),
    error && /* @__PURE__ */ jsx(Alert, { severity: "warning", sx: { mt: 2 }, children: error }),
    !hasHome && /* @__PURE__ */ jsx(Alert, { severity: "info", sx: { mt: 2 }, children: "No home is open on this device yet \u2014 connect to your family's hub first." }),
    /* @__PURE__ */ jsx(RecognitionSwitch, { settings, ownerHere, busy: switchBusy, error: switchError, onToggle: toggleRecognition }),
    metrics && /* @__PURE__ */ jsxs(Typography, { variant: "body2", sx: { color: "text.secondary", mt: 1.5 }, children: [
      "Zero-computation audit \u2014 ",
      metricsCopy(metrics)
    ] }),
    /* @__PURE__ */ jsx(
      SectionHeader,
      {
        title: FACES_TITLE,
        action: ownerHere && /* @__PURE__ */ jsx(Button, { size: "small", startIcon: /* @__PURE__ */ jsx(AddOutlined, {}), onClick: () => {
          setEnrollError("");
          setEnrollKind("face");
        }, children: "Add a face" })
      }
    ),
    faces.length === 0 && /* @__PURE__ */ jsx(EmptyLine, { children: "No faces enrolled yet." }),
    faces.map((entry) => /* @__PURE__ */ jsx(
      EntryRow,
      {
        entry,
        evidence,
        onRename: setRenaming,
        onDelete: (candidate) => {
          setDeleteReceipt("");
          setDeleting(candidate);
        },
        onOpenEvidence: openEvidence
      },
      entry?._id
    )),
    /* @__PURE__ */ jsx(
      SectionHeader,
      {
        title: VEHICLES_TITLE,
        action: ownerHere && /* @__PURE__ */ jsx(Button, { size: "small", startIcon: /* @__PURE__ */ jsx(AddOutlined, {}), onClick: () => {
          setEnrollError("");
          setEnrollKind("vehicle");
        }, children: "Add a vehicle" })
      }
    ),
    vehicles.length === 0 && /* @__PURE__ */ jsx(EmptyLine, { children: "No vehicles enrolled yet." }),
    vehicles.map((entry) => /* @__PURE__ */ jsx(
      EntryRow,
      {
        entry,
        evidence,
        onRename: setRenaming,
        onDelete: (candidate) => {
          setDeleteReceipt("");
          setDeleting(candidate);
        },
        onOpenEvidence: openEvidence
      },
      entry?._id
    )),
    ownerHere && /* @__PURE__ */ jsx(
      SectionHeader,
      {
        title: "Your data",
        action: /* @__PURE__ */ jsx(Button, { size: "small", startIcon: /* @__PURE__ */ jsx(DownloadOutlined, {}), onClick: exportRegistry, children: "Export registry" })
      }
    ),
    ownerHere && /* @__PURE__ */ jsx(EmptyLine, { children: "Export writes the whole registry \u2014 entries, descriptors, plate reads, sightings \u2014 to one file you download. The registry never leaves the hub any other way." }),
    /* @__PURE__ */ jsx(
      EnrollDialog,
      {
        kind: enrollKind,
        open: enrollKind != null,
        busy: enrollBusy,
        error: enrollError,
        onClose: () => {
          setEnrollKind(null);
          setEnrollError("");
        },
        onSubmit: enroll
      }
    ),
    renaming && /* @__PURE__ */ jsx(
      RenameDialog,
      {
        entry: renaming,
        open: true,
        busy: renameBusy,
        error: renameError,
        onClose: () => {
          setRenaming(null);
          setRenameError("");
        },
        onSubmit: rename
      }
    ),
    deleting && /* @__PURE__ */ jsx(
      DeleteDialog,
      {
        entry: deleting,
        open: true,
        busy: deleteBusy,
        error: deleteError,
        receipt: deleteReceipt,
        onClose: () => {
          setDeleting(null);
          setDeleteError("");
        },
        onSubmit: confirmDelete
      }
    )
  ] });
}
export {
  EntryRow,
  People,
  RecognitionSwitch,
  SightingRow
};
