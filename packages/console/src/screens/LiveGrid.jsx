// Live grid (PORCH-130): one card per camera with its same-origin MJPEG
// live view — the stream manager owns the framing and the <img> owns the
// reconnect, so the grid holds no polling of its own. A camera that stops
// answering gets its own plain-language line, never a silent card.
import React, { useState } from "react";
import Box from "@mui/material/Box";
import Paper from "@mui/material/Paper";
import Stack from "@mui/material/Stack";
import Typography from "@mui/material/Typography";

export default function LiveGrid({ api, cameras }) {
  const [failed, setFailed] = useState({}); // cameraId → true once the stream stops answering

  if (cameras.length === 0) {
    return <Typography color="text.secondary">No cameras are set up yet. Add one under the Cameras tab to watch its live view.</Typography>;
  }

  return (
    <Box sx={{ display: "grid", gap: 2, gridTemplateColumns: { xs: "1fr", sm: "repeat(2, 1fr)", lg: "repeat(3, 1fr)" } }}>
      {cameras.map((camera) => (
        <Paper key={camera.id} variant="outlined" sx={{ p: 2 }}>
          <Stack spacing={1.5}>
            <Typography variant="subtitle2">{camera.name || camera.id}</Typography>
            {failed[camera.id] ? (
              <Box
                sx={{
                  height: 180,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  bgcolor: "action.hover",
                  borderRadius: 1,
                  px: 2,
                }}
              >
                <Typography color="text.secondary" variant="body2" sx={{ textAlign: "center" }}>
                  The live view of {camera.name || camera.id} is unavailable right now. It will appear again when the camera's stream returns.
                </Typography>
              </Box>
            ) : (
              <Box
                component="img"
                src={api.liveUrl(camera.id)}
                alt={`Live view of ${camera.name || camera.id}`}
                sx={{ width: "100%", height: 180, objectFit: "cover", bgcolor: "#000", borderRadius: 1 }}
                onError={() => setFailed((current) => ({ ...current, [camera.id]: true }))}
              />
            )}
          </Stack>
        </Paper>
      ))}
    </Box>
  );
}
