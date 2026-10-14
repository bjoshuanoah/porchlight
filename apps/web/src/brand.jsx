// Brand lockup (PORCH-032): the new lamp mark with the navy wordmark.
// The mark ships as app/web/public/lamp-mark.png (trimmed from the approved
// logo asset, brand/lamp-logo-original.png); the wordmark rides the Inter
// token set in navy so the lockup always matches the design tokens.
// Surfaces of record: shell wordmark, join/setup headers, empty states.
import React from "react";
import { Box, Typography } from "@mui/material";

export function Lockup({ size = 28, wordmarkSx, sx, ...props }) {
  // The horizontal row is the lockup's own contract (PORCH-072 ac-4): icon
  // left, wordmark right, one row, never stacked. Call-site sx rides the
  // array merge so a caller's spacing/flex props can never clobber the
  // layout sx that keeps this container a single horizontal row.
  return (
    <Box component="span" sx={[{ display: "inline-flex", alignItems: "center" }, ...(Array.isArray(sx) ? sx : sx ? [sx] : [])]} {...props}>
      <Box component="img" src="/lamp-mark.png" alt="" aria-hidden="true"
        sx={{ height: size, width: "auto", display: "block" }} />
      <Typography component="span" sx={{ ml: 1, fontWeight: 650, fontSize: "1rem", lineHeight: "24px", color: "primary.main", ...wordmarkSx }}>Porchlight</Typography>
    </Box>
  );
}

// The lamp mark alone, riding the warm glow — for illustrations that name
// the brand by shape rather than by word (empty timeline, setup panel).
export function LampMark({ size, sx }) {
  return <Box component="img" src="/lamp-mark.png" alt="" aria-hidden="true"
    sx={{ width: size, height: "auto", display: "block", ...sx }} />;
}