// Brand lockup (PORCH-032): the new lamp mark with the navy wordmark.
// The mark ships as app/web/public/lamp-mark.png (trimmed from the approved
// logo asset, brand/lamp-logo-original.png); the wordmark rides the Inter
// token set in navy so the lockup always matches the design tokens.
// Surfaces of record: shell wordmark, join/setup headers, empty states.
import React from "react";
import { Box, Typography } from "@mui/material";

export function Lockup({ size = 28, wordmarkSx, ...props }) {
  return (
    <Box component="span" sx={{ display: "inline-flex", alignItems: "center" }} {...props}>
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