// Link previews (PORCH-052, Link Previews pair): compose-time hub-side URL
// resolution rendered in two classes of record — the provider embed (tap to
// play, never autoplay) and the compact og:image card — with pasted URLs in
// the body rendered as real links. The pure helpers (detection, segmenter,
// hub-origin lookup) live in ./link-preview.js; this module is only the
// rendered surface.
//
// Privacy posture (paired PRD): the card's image always loads from the
// hub's own media pipeline (the og:image original + rendition set of
// record, served from the member's hub origin) — the member browser never
// loads a third-party preview image directly. The provider embed is the
// recorded one third-party-contact exception (rendering it contacts the
// provider from the member browser); it renders only after a member tap.

import React, { useState } from "react";
import { Box, Chip, IconButton, Stack, Typography } from "@mui/material";
import { renditionSrc, renditionSrcset } from "./media-rung.js";
import { linkSegments } from "./link-preview.js";

/** The provider embed's human label for its tap-to-play facade. */
const PROVIDER_LABELS = {
  youtube: "YouTube",
  spotify: "Spotify",
  apple_music: "Apple Music",
  oembed: "Shared link",
};

/**
 * Body text with pasted URLs rendered as links — external links open in a
 * new tab (ac-4). Rendered inside the caller's typographic frame, so the
 * layout rulings (16px mobile rail, 68ch desktop line, pre-wrap) hold.
 */
export function LinkedBody({ text }) {
  const segments = linkSegments(text);
  if (segments.length === 0) return null;
  return segments.map((segment, index) =>
    segment.url ? (
      <Box
        key={index}
        component="a"
        href={segment.url}
        target="_blank"
        rel="noopener noreferrer"
        sx={{ color: "primary.main", textDecoration: "underline", textUnderlineOffset: 2, overflowWrap: "anywhere" }}
      >
        {segment.text}
      </Box>
    ) : (
      <span key={index}>{segment.text}</span>
    ),
  );
}

/**
 * The link-preview block (PORCH-052): subordinate to family media —
 * compact, inside the 16px padding band (no media breakout), never
 * banner-scale.
 *
 * - embed class: a tap-to-play facade replaces the iframe until the member
 *   taps it; the iframe carries no autoplay allowance of any kind.
 * - card class: compact og:image card — title, site name, and the image
 *   served from the hub's own origin — taps open the link in a new tab.
 */
export function LinkPreviewBlock({ preview, origin, compact = false }) {
  const [playing, setPlaying] = useState(false);
  if (!preview || (preview.kind !== "embed" && preview.kind !== "card")) return null;
  if (preview.kind === "embed") {
    if (!preview.embedUrl) return null;
    if (!playing) {
      return (
        <Stack
          direction="row"
          spacing={1.5}
          alignItems="center"
          justifyContent="space-between"
          sx={{
            mt: 1,
            maxWidth: "68ch",
            px: 1.25,
            py: 0.75,
            border: 1,
            borderRadius: 2,
            borderColor: "divider",
            bgcolor: "background.default",
          }}
        >
          <Stack spacing={0} sx={{ minWidth: 0 }}>
            <Typography variant="body2" fontWeight={600} fontSize={14} sx={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              {PROVIDER_LABELS[preview.provider] ?? "Shared link"}
            </Typography>
            <Typography variant="caption" color="porchlight.muted">
              Tap to play
            </Typography>
          </Stack>
          <IconButton aria-label={`Play ${PROVIDER_LABELS[preview.provider] ?? "the shared"} link`} onClick={() => setPlaying(true)} sx={{ flexShrink: 0 }}>
            ▶
          </IconButton>
        </Stack>
      );
    }
    return (
      <Box
        component="iframe"
        src={preview.embedUrl}
        title={preview.provider ? `${PROVIDER_LABELS[preview.provider] ?? preview.provider} embed` : "Link embed"}
        allow="encrypted-media; clipboard-write; picture-in-picture"
        allowFullScreen
        referrerPolicy="strict-origin-when-cross-origin"
        sx={{
          mt: 1,
          display: "block",
          width: "100%",
          maxWidth: compact ? 320 : 480,
          aspectRatio: "16 / 9",
          border: 0,
          borderRadius: 2,
        }}
      />
    );
  }
  // Card class: the image always arrives from the hub's own origin (the
  // media pipeline's content-addressed rendition) — no third-party image
  // request ever leaves the member's browser (paired PRD privacy posture).
  const og = preview.ogImage ?? null;
  return (
    <Box
      component="a"
      href={preview.url}
      target="_blank"
      rel="noopener noreferrer"
      aria-label={preview.title ? `Open ${preview.title}` : "Open shared link"}
      sx={{
        mt: 1,
        display: "flex",
        gap: 1,
        alignItems: "center",
        maxWidth: "68ch",
        overflow: "hidden",
        p: 1,
        border: 1,
        borderRadius: 2,
        borderColor: "divider",
        bgcolor: "background.default",
        color: "inherit",
        textDecoration: "none",
      }}
    >
      {og?.mediaId && (
        <Box
          component="img"
          src={renditionSrc(og, origin) ?? undefined}
          srcSet={og.renditions?.length ? renditionSrcset(og, origin) || undefined : undefined}
          sizes={og.renditions?.length ? "96px" : undefined}
          alt={preview.title ?? preview.siteName ?? "Link preview"}
          loading="lazy"
          decoding="async"
          referrerPolicy="no-referrer"
          sx={{
            width: compact ? 48 : 96,
            flexShrink: 0,
            aspectRatio: og.width && og.height ? `${og.width} / ${og.height}` : "1 / 1",
            maxHeight: compact ? 48 : 96,
            objectFit: "cover",
            borderRadius: 1,
            bgcolor: "background.paper",
          }}
        />
      )}
      <Stack sx={{ minWidth: 0 }}>
        {preview.title && (
          <Typography variant="body2" fontWeight={600} fontSize={14} sx={{ overflow: "hidden", display: "-webkit-box", WebkitLineClamp: compact ? 1 : 2, WebkitBoxOrient: "vertical" }}>
            {preview.title}
          </Typography>
        )}
        {preview.siteName && (
          <Typography variant="caption" color="porchlight.muted">
            {preview.siteName}
          </Typography>
        )}
        <Chip label={hostOf(preview.url)} size="small" variant="outlined" sx={{ fontSize: "0.6875rem", height: "22px", alignSelf: "flex-start", mt: 0.25 }} />
      </Stack>
    </Box>
  );
}

function hostOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return null;
  }
}