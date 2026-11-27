import React, { useEffect, useState } from "react";
import Box from "@mui/material/Box";
import CssBaseline from "@mui/material/CssBaseline";
import Divider from "@mui/material/Divider";
import MenuItem from "@mui/material/MenuItem";
import TextField from "@mui/material/TextField";
import { ThemeProvider, createTheme } from "@mui/material/styles";
import Toolbar from "@mui/material/Toolbar";
import Typography from "@mui/material/Typography";
import Container from "@mui/material/Container";
import Tab from "@mui/material/Tab";
import Tabs from "@mui/material/Tabs";

import { api } from "./api.js";
import { consoleTabs } from "./tabs.js";
import ZoneEditor from "./screens/ZoneEditor.jsx";
import CompositionInspector from "./screens/CompositionInspector.jsx";
import SpeedCalibration from "./screens/SpeedCalibration.jsx";
import Profiles from "./screens/Profiles.jsx";
import Storage from "./screens/Storage.jsx";
import Compute from "./screens/Compute.jsx";

const theme = createTheme({
  palette: { mode: "light" },
  typography: {
    fontFamily: 'Inter, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
  },
});

export default function App() {
  const [cameras, setCameras] = useState([]);
  const [cameraId, setCameraId] = useState("");
  const [loadError, setLoadError] = useState("");
  const [tab, setTab] = useState(consoleTabs[0].id);

  useEffect(() => {
    let cancelled = false;
    api
      .listCameras()
      .then((list) => {
        if (cancelled) return;
        setCameras(list ?? []);
        setCameraId((current) => current || list?.[0]?.id || "");
      })
      .catch((error) => {
        if (!cancelled) setLoadError(error.message);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const camera = cameras.find((candidate) => candidate.id === cameraId) ?? null;

  return (
    <ThemeProvider theme={theme}>
      <CssBaseline />
      <Box sx={{ display: "flex", flexDirection: "column", minHeight: "100dvh" }}>
        <Toolbar sx={{ gap: 2 }}>
          <Typography variant="h6" sx={{ mr: "auto" }}>
            Porchlight console
          </Typography>
          {loadError ? (
            <Typography color="error" variant="body2">
              {loadError}
            </Typography>
          ) : (
            <TextField
              select
              size="small"
              label="Camera"
              value={cameraId}
              onChange={(event) => setCameraId(event.target.value)}
              sx={{ minWidth: 200 }}
            >
              {cameras.map((candidate) => (
                <MenuItem key={candidate.id} value={candidate.id}>
                  {candidate.name || candidate.id}
                </MenuItem>
              ))}
            </TextField>
          )}
        </Toolbar>
        <Divider />
        <Container
          maxWidth="lg"
          sx={{
            flex: 1,
            py: { xs: 2, sm: 3 },
            pb: { xs: 10, sm: 3 },
          }}
        >
          {tab === "camera" && <ZoneEditor camera={camera} api={api} />}
          {tab === "composition" && <CompositionInspector camera={camera} api={api} />}
          {tab === "speed" && <SpeedCalibration camera={camera} api={api} />}
          {tab === "profiles" && <Profiles camera={camera} cameras={cameras} api={api} />}
          {tab === "storage" && <Storage api={api} />}
          {tab === "compute" && <Compute api={api} />}
        </Container>
        <Tabs
          value={tab}
          onChange={(event, next) => setTab(next)}
          variant="fullWidth"
          sx={{
            // Bottom tab bar on narrow widths (PORCH-135, the Porchlight
            // console tab pattern): the bar docks to the viewport bottom on
            // xs and stays in flow above sm.
            position: { xs: "fixed", sm: "static" },
            bottom: { xs: 0, sm: "auto" },
            left: { xs: 0, sm: "auto" },
            right: { xs: 0, sm: "auto" },
            bgcolor: { xs: "background.paper", sm: "transparent" },
            borderTop: 1,
            borderColor: "divider",
            zIndex: (t) => t.zIndex.appBar,
          }}
        >
          {consoleTabs.map(({ id, label }) => (
            <Tab key={id} value={id} label={label} sx={{ minHeight: 56 }} />
          ))}
        </Tabs>
      </Box>
    </ThemeProvider>
  );
}
