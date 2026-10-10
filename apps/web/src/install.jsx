// Install surfaces (PORCH-051): the Android custom "Install Web App" CTA and
// the iOS/Safari guided install card. One component, one porch styling; the
// surfaces render only outside standalone mode (never over an installed app),
// both are dismissible, and the dismissal suppression window is a
// browser-local per-origin write the caller owns (store.js + install.js).
import React from "react";
import { Box, Button, IconButton, Paper, Stack, Typography } from "@mui/material";
import CloseOutlined from "@mui/icons-material/CloseOutlined";
import IosShareOutlined from "@mui/icons-material/IosShareOutlined";
import { LampMark } from "./brand.jsx";

const cardSx = {
  position: "fixed",
  left: 12,
  right: 12,
  mx: "auto",
  maxWidth: 1180,
  zIndex: 12,
  p: { xs: 1.5, sm: 2 },
  borderRadius: 2,
  border: "1px solid",
  borderColor: "divider",
  background: "var(--porch-surface)",
  // The banner never covers the tab bar (bottom: 84 clear it above the
  // 68px bar + safe inset) and never its own safe-area gap.
  bottom: { xs: "calc(84px + env(safe-area-inset-bottom))", sm: 16 },
  pb: "calc(24px + env(safe-area-inset-bottom))",
};

export function InstallCta({ kind, onInstall, onDismiss }) {
  if (!kind) return null;
  if (kind === "android") {
    return (
      <Paper elevation={0} role="region" aria-label="Install Porchlight" sx={cardSx}>
        <Stack direction="row" alignItems="center" spacing={2}>
          <LampMark size={38} />
          <Box sx={{ flex: 1, minWidth: 0 }}>
            <Typography sx={{ fontWeight: 650, color: "text.primary" }}>Add Porchlight to your home screen</Typography>
            <Typography variant="body2" sx={{ color: "text.secondary" }}>Open this place like an app — full screen, straight from the home screen.</Typography>
          </Box>
          <Button variant="contained" color="secondary" onClick={onInstall}>Install Web App</Button>
          <Button onClick={onDismiss}>Not now</Button>
        </Stack>
      </Paper>
    );
  }
  return (
    <Paper elevation={0} role="region" aria-label="Install Porchlight" sx={cardSx}>
      <Stack direction="row" alignItems="center" spacing={1.5}>
        <IosShareOutlined sx={{ fontSize: 32, color: "var(--porch-amber)" }} />
        <Box sx={{ flex: 1, minWidth: 0 }}>
          <Typography sx={{ fontWeight: 650, color: "text.primary" }}>Install Porchlight on this device</Typography>
          <Typography variant="body2" sx={{ color: "text.secondary" }}>
            To install, tap the <IosShareOutlined sx={{ fontSize: "1em", verticalAlign: "-.125em", color: "var(--porch-amber)" }} role="img" aria-label="Share" /> Share icon and select “Add to Home Screen”.
          </Typography>
        </Box>
        <IconButton aria-label="Dismiss" size="small" onClick={onDismiss}><CloseOutlined /></IconButton>
      </Stack>
    </Paper>
  );
}