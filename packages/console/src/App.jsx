import React, { useCallback, useEffect, useState } from "react";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import CssBaseline from "@mui/material/CssBaseline";
import Divider from "@mui/material/Divider";
import MenuItem from "@mui/material/MenuItem";
import Menu from "@mui/material/Menu";
import TextField from "@mui/material/TextField";
import Toolbar from "@mui/material/Toolbar";
import Typography from "@mui/material/Typography";
import Container from "@mui/material/Container";
import Tab from "@mui/material/Tab";
import Tabs from "@mui/material/Tabs";

import { api } from "./api.js";
import { MODES, readStoredMode, writeStoredMode } from "./mode.js";
import { consoleTabs } from "./tabs.js";
import ZoneEditor from "./screens/ZoneEditor.jsx";
import CompositionInspector from "./screens/CompositionInspector.jsx";
import SpeedCalibration from "./screens/SpeedCalibration.jsx";
import Profiles from "./screens/Profiles.jsx";
import Storage from "./screens/Storage.jsx";
import Compute from "./screens/Compute.jsx";
import Transcripts from "./screens/Transcripts.jsx";
import LiveGrid from "./screens/LiveGrid.jsx";
import Timeline from "./screens/Timeline.jsx";
import Status from "./screens/Status.jsx";
import Wizard from "./screens/Wizard.jsx";

const MODE_LABELS = { light: "Light", dark: "Dark", system: "System" };

// Toolbar mode switcher (PORCH-130): the menu holds the device preference
// (System by default, read from browser-local storage); picking writes the
// stored mode and dispatches the same-tab change event that the console
// mode bootstrap in main.jsx resolves into the active theme. App never
// branches on the resolved mode — the theme provider owns that.
export default function App() {
  const [modePref, setModePref] = useState(() => readStoredMode(window.localStorage));
  const [modeAnchor, setModeAnchor] = useState(null);

  // First-run gate (PORCH-130): until /api/setup says completed, the only
  // thing on screen is the wizard — no tab bar, no camera toolbar.
  const [setup, setSetup] = useState(null); // null = still asking; { completed, ... }
  const [setupError, setSetupError] = useState("");
  const [setupRound, setSetupRound] = useState(0);

  const [cameras, setCameras] = useState([]);
  const [cameraId, setCameraId] = useState("");
  const [loadError, setLoadError] = useState("");
  const [tab, setTab] = useState(consoleTabs[0].id);

  const setupDone = setup?.completed === true;

  useEffect(() => {
    let cancelled = false;
    setSetup(null);
    setSetupError("");
    api
      .getSetup()
      .then((state) => {
        if (!cancelled) setSetup(state ?? { completed: false });
      })
      .catch((error) => {
        if (!cancelled) setSetupError(error.message);
      });
    return () => {
      cancelled = true;
    };
  }, [setupRound]);

  const reloadCameras = useCallback(async () => {
    try {
      const list = await api.listCameras();
      setCameras(list ?? []);
      setCameraId((current) => (list?.some((candidate) => candidate.id === current) ? current : ""));
      setLoadError("");
    } catch (error) {
      setLoadError(error.message);
    }
  }, []);

  useEffect(() => {
    if (!setupDone) return;
    reloadCameras();
  }, [setupDone, reloadCameras]);

  const camera = cameras.find((candidate) => candidate.id === cameraId) ?? null;

  function pickMode(mode) {
    setModeAnchor(null);
    if (!MODES.includes(mode)) return;
    setModePref(mode);
    writeStoredMode(window.localStorage, mode);
    window.dispatchEvent(new Event("porchlight:mode-changed"));
  }

  // --- the wizard gate: fullscreen setup, nothing else renders -------------

  if (!setupDone) {
    return (
      <Box sx={{ display: "flex", flexDirection: "column", minHeight: "100dvh" }}>
        <CssBaseline />
        <Box
          sx={{
            flex: 1,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            px: 2,
            py: 6,
          }}
        >
          {setupError ? (
            <Box sx={{ textAlign: "center" }}>
              <Typography color="error" sx={{ mb: 2 }}>
                Setup could not be reached: {setupError}
              </Typography>
              <Button variant="outlined" onClick={() => setSetupRound((round) => round + 1)}>
                Try again
              </Button>
            </Box>
          ) : setup ? (
            <Wizard onComplete={() => setSetupRound((round) => round + 1)} />
          ) : (
            <Typography color="text.secondary">Opening setup…</Typography>
          )}
        </Box>
      </Box>
    );
  }

  // --- the console shell ----------------------------------------------------

  return (
    <Box sx={{ display: "flex", flexDirection: "column", minHeight: "100dvh" }}>
      <CssBaseline />
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
        <Button
          size="small"
          variant="outlined"
          aria-haspopup="menu"
          aria-expanded={Boolean(modeAnchor)}
          onClick={(event) => setModeAnchor(event.currentTarget)}
        >
          {MODE_LABELS[modePref] ?? "System"}
        </Button>
        <Menu anchorEl={modeAnchor} open={Boolean(modeAnchor)} onClose={() => setModeAnchor(null)}>
          {MODES.map((mode) => (
            <MenuItem key={mode} selected={mode === modePref} onClick={() => pickMode(mode)}>
              {MODE_LABELS[mode]}
            </MenuItem>
          ))}
        </Menu>
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
        {tab === "live" && <LiveGrid api={api} cameras={cameras} />}
        {tab === "timeline" && <Timeline api={api} cameras={cameras} />}
        {tab === "camera" && <ZoneEditor camera={camera} api={api} onCamerasChanged={reloadCameras} />}
        {tab === "composition" && <CompositionInspector camera={camera} api={api} />}
        {tab === "speed" && <SpeedCalibration camera={camera} api={api} />}
        {tab === "profiles" && <Profiles camera={camera} cameras={cameras} api={api} />}
        {tab === "storage" && <Storage api={api} />}
        {tab === "compute" && <Compute api={api} />}
        {tab === "transcripts" && <Transcripts api={api} />}
        {tab === "status" && <Status api={api} />}
      </Container>
      <Tabs
        value={tab}
        onChange={(event, next) => setTab(next)}
        variant="scrollable"
        scrollButtons={false}
        sx={{
          // Bottom tab bar on narrow widths (PORCH-135, the Porchlight
          // console tab pattern): the bar docks to the viewport bottom on
          // xs and stays in flow above sm. scrollable + no scroll buttons
          // keep all tabs reachable on a narrow viewport (PORCH-130).
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
  );
}
