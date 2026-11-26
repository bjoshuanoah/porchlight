// PORCH-137: the Porchlight Home tab. One screen, one hub's homes — the
// home switcher swaps EVERYTHING below it (areas, devices, scenes,
// automations, recent activity); rooms and outdoor areas group separately;
// device controls render the hub's confirmed last-known state only (the
// anti-optimism rule is home-model.js's `renderedControlValue` — a tap never
// flips a switch visually; loading/confirmed/failed are three distinct
// states); recent activity walks the audit window with Load more. Pure
// logic and copy ride home-model.js; the wire rides home-actions.js through
// the shared actions object.
import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  Alert, Box, Button, Checkbox, Chip, CircularProgress, Dialog, DialogActions, DialogContent,
  DialogTitle, Divider, FormControl, FormControlLabel, IconButton, InputLabel, MenuItem, Paper,
  Select, Stack, Switch, TextField, Tooltip, Typography,
} from "@mui/material";
import AddOutlined from "@mui/icons-material/AddOutlined";
import CheckCircleOutlined from "@mui/icons-material/CheckCircleOutlined";
import PlayArrowOutlined from "@mui/icons-material/PlayArrowOutlined";
import RefreshOutlined from "@mui/icons-material/RefreshOutlined";
import { dateOf, relativeTime } from "./time.js";
import {
  automationTriggerLabel, commandReasonOf, commandStatusOf, groupDevicesByArea,
  nextCommandState, readActiveHomeId, renderedControlValue, writeActiveHomeId,
} from "./home-model.js";

const messageOf = (error) => error?.message || "That did not work. Please try again.";

function originOf(serverUrl) {
  try {
    return serverUrl ? new URL(serverUrl).origin : null;
  } catch {
    return null;
  }
}

// Per-capability controls: a device carrying switch/light renders on/off.
const CONTROL_CAPABILITIES = ["switch", "light"];
const hasControl = (device) => device.capabilities.some((capability) => CONTROL_CAPABILITIES.includes(capability));
const controllableOf = (devices) => devices.filter(hasControl);

const COMMAND_LABELS = { turnOn: "Turn on", turnOff: "Turn off" };
const commandLabel = (command) => COMMAND_LABELS[command] ?? command;

const EVENT_CLASSES = ["vehicle", "person", "animal", "button", "door"];

const AUDIT_LABELS = {
  "home.created": "Home created",
  "home.renamed": "Home renamed",
  "area.created": "Area added",
  "area.renamed": "Area renamed",
  "device.registered": "Device added",
  "device.updated": "Device updated",
  "device.read": "Device status read",
  "device.command": "Device command",
  "scene.created": "Scene created",
  "scene.run": "Scene run",
  "automation.created": "Automation created",
  "automation.updated": "Automation updated",
};
const auditLabel = (type) => AUDIT_LABELS[type] ?? String(type || "Event").replace(/[._-]+/g, " ").replace(/^./, (c) => c.toUpperCase());

const AUDIT_LIMIT = 10;
const CONFIRMED_HOLD_MS = 2200;

function SectionHeader({ title, action }) {
  return (
    <Stack direction="row" alignItems="center" justifyContent="space-between" sx={{ mt: 4, mb: 1.5 }}>
      <Typography variant="h6">{title}</Typography>
      {action}
    </Stack>
  );
}

function EmptyLine({ children }) {
  return (
    <Typography variant="body2" sx={{ color: "text.secondary", py: 0.75 }}>
      {children}
    </Typography>
  );
}

/** One action-row editor shared by the scene and automation dialogs: a
 * device pick plus what that device should do, one row per step. */
function ActionRows({ devices, rows, setRows }) {
  const setRow = (index, patch) =>
    setRows(rows.map((row, at) => (at === index ? { ...row, ...patch } : row)));
  return (
    <Stack spacing={1.5}>
      {rows.length === 0 && <EmptyLine>No actions picked yet — add one below.</EmptyLine>}
      {rows.map((row, index) => (
        <Stack key={index} direction={{ xs: "column", sm: "row" }} spacing={1.5} alignItems={{ sm: "center" }}>
          <Select
            size="small"
            value={row.deviceId}
            displayEmpty
            onChange={(event) => setRow(index, { deviceId: event.target.value, command: "turnOn" })}
            sx={{ minWidth: { xs: "100%", sm: 200 } }}
          >
            <MenuItem value="" disabled><em>Pick a device</em></MenuItem>
            {devices.map((device) => (
              <MenuItem key={device._id} value={device._id}>{device.name}</MenuItem>
            ))}
          </Select>
          <Select
            size="small"
            value={row.command}
            displayEmpty
            onChange={(event) => setRow(index, { command: event.target.value })}
            sx={{ minWidth: { xs: "100%", sm: 160 } }}
          >
            <MenuItem value="" disabled><em>What it does</em></MenuItem>
            <MenuItem value="turnOn">Turn on</MenuItem>
            <MenuItem value="turnOff">Turn off</MenuItem>
          </Select>
          <Button size="small" onClick={() => setRows(rows.filter((_row, at) => at !== index))}>Remove</Button>
        </Stack>
      ))}
      <Box>
        <Button
          size="small"
          startIcon={<AddOutlined />}
          disabled={!devices.length}
          onClick={() => setRows([...rows, { deviceId: "", command: "" }])}
        >
          Add action
        </Button>
      </Box>
    </Stack>
  );
}

/** One device card: identity chips, the hub's confirmed last-known state and
 * its read time, the stale label with its reason, and the on/off controls
 * bound to the command machine. */
function DeviceRow({ view, command, onCommand, onRefresh }) {
  const loading = command.status === "loading";
  const confirmed = command.status === "confirmed";
  const failed = command.status === "failed";
  // The rendered on/off value: the device row's confirmed last-known state,
  // NEVER the clicked intent (the model refuses to consult it, so an
  // optimistic flip is impossible by construction).
  const rendered = renderedControlValue(view.raw, command.pendingCommand);
  const controls = view.capabilities.some((capability) => CONTROL_CAPABILITIES.includes(capability));
  return (
    <Paper
      elevation={0}
      sx={{
        p: 2, borderRadius: 3, bgcolor: "var(--porch-surface)",
        border: "1px solid",
        borderColor: failed || view.stale ? "error.main" : "var(--porch-border)",
      }}
    >
      <Stack direction="row" alignItems="flex-start" justifyContent="space-between" spacing={1}>
        <Box sx={{ minWidth: 0 }}>
          <Typography variant="subtitle1" sx={{ fontWeight: 600 }}>{view.name}</Typography>
          <Stack direction="row" spacing={0.75} sx={{ mt: 0.75, flexWrap: "wrap", rowGap: 0.75 }}>
            {view.capabilities.map((capability) => (
              <Chip key={capability} label={capability} size="small" variant="outlined" sx={{ height: 22, fontSize: 12 }} />
            ))}
            {!view.capabilities.length && (
              <Chip label="No capabilities" size="small" variant="outlined" sx={{ height: 22, fontSize: 12, color: "text.muted" }} />
            )}
          </Stack>
        </Box>
        <Tooltip title="Read this device's current status">
          <IconButton size="small" onClick={onRefresh} aria-label={`Refresh ${view.name}`}>
            <RefreshOutlined fontSize="small" />
          </IconButton>
        </Tooltip>
      </Stack>
      <Typography variant="body2" sx={{ mt: 1.5, color: view.stateText === "Unknown" ? "text.muted" : "text.primary" }}>
        {view.stateText === "Unknown"
          ? "No status yet — refresh to ask the device."
          : `${view.stateText} · read ${view.asOf || dateOf(view.stateConfirmedAt) || "recently"}`}
      </Typography>
      {view.stale && (
        <Typography variant="body2" sx={{ mt: 0.5, color: "error.main" }}>
          {view.staleLabel}
        </Typography>
      )}
      {failed && (
        <Typography variant="body2" sx={{ mt: 0.5, color: "error.main" }}>
          {command.reason || "The device did not respond."}
        </Typography>
      )}
      {(controls || loading || confirmed) && (
        <Stack direction="row" spacing={1.5} alignItems="center" sx={{ mt: 1.5, flexWrap: "wrap", rowGap: 1 }}>
          {controls && (
            <>
              <Button size="small" variant={rendered === true ? "contained" : "outlined"} disabled={loading} onClick={() => onCommand("turnOn")}>
                Turn on
              </Button>
              <Button size="small" variant={rendered === false ? "contained" : "outlined"} disabled={loading} onClick={() => onCommand("turnOff")}>
                Turn off
              </Button>
            </>
          )}
          {loading && (
            <Stack direction="row" spacing={1} alignItems="center" sx={{ color: "text.secondary" }}>
              <CircularProgress size={16} color="inherit" />
              <Typography variant="body2" sx={{ color: "text.secondary" }}>Sending to the device…</Typography>
            </Stack>
          )}
          {confirmed && (
            <Stack direction="row" spacing={0.75} alignItems="center">
              <CheckCircleOutlined fontSize="small" sx={{ color: "var(--porch-vote-up)" }} />
              <Typography variant="body2" sx={{ color: "var(--porch-vote-up)" }}>Done</Typography>
            </Stack>
          )}
        </Stack>
      )}
    </Paper>
  );
}

function AreaSection({ groups, empty, renderCard }) {
  return (
    <Box>
      {groups.length === 0 && <EmptyLine>{empty}</EmptyLine>}
      {groups.map(({ area, devices }) => (
        <Box key={area._id ?? area.name} sx={{ mb: 2.5 }}>
          <Typography variant="subtitle2" sx={{ color: "text.secondary", mb: 1 }}>
            {area.name}
          </Typography>
          {devices.length === 0
            ? <EmptyLine>No devices here yet.</EmptyLine>
            : (
              <Box sx={{ display: "grid", gap: 1.5, gridTemplateColumns: { xs: "1fr", sm: "repeat(auto-fill, minmax(300px, 1fr))" } }}>
                {devices.map((view) => renderCard(view))}
              </Box>
            )}
        </Box>
      ))}
    </Box>
  );
}

// --- dialogs ----------------------------------------------------------------

function HomeDialogs({
  dialog, busy, dialogError, closeDialog,
  home, areas, controllableDevices,
  onCreateHome, onRenameHome, onAddArea, onAddDevice, onAddScene, onAddAutomation,
}) {
  const [name, setName] = useState("");
  const [kind, setKind] = useState("room");
  const [areaId, setAreaId] = useState("");
  const [capabilities, setCapabilities] = useState([]);
  const [extraCapabilities, setExtraCapabilities] = useState("");
  const [adapterName, setAdapterName] = useState("");
  const [adapterBinding, setAdapterBinding] = useState("");
  const [actionRows, setActionRows] = useState([{ deviceId: "", command: "" }]);
  const [eventClass, setEventClass] = useState("vehicle");
  const [afterDark, setAfterDark] = useState(false);
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");

  useEffect(() => {
    // Each open starts from the dialog's own resting draft.
    setName("");
    setKind("room");
    setAreaId("");
    if (controllableDevices.length) {
      setActionRows([{ deviceId: controllableDevices[0]._id, command: "turnOn" }]);
    } else {
      setActionRows([{ deviceId: "", command: "" }]);
    }
    setEventClass("vehicle");
    setAfterDark(false);
    setFrom("");
    setTo("");
  }, [dialog]); // eslint-disable-line react-hooks/exhaustive-deps

  const errorLine = dialogError && <Alert severity="warning" sx={{ mt: 2 }}>{dialogError}</Alert>;
  const open = (key) => dialog === key;

  return (
    <>
      {/* Create home */}
      <Dialog open={open("create-home")} onClose={closeDialog} fullWidth maxWidth="xs">
        <DialogTitle>Create a home</DialogTitle>
        <DialogContent>
          <TextField autoFocus margin="dense" label="Home name" fullWidth value={name} onChange={(event) => setName(event.target.value)} />
          {errorLine}
        </DialogContent>
        <DialogActions>
          <Button onClick={closeDialog}>Cancel</Button>
          <Button variant="contained" disabled={busy || !name.trim()} onClick={() => onCreateHome({ name })}>
            {busy ? <CircularProgress size={18} /> : "Create"}
          </Button>
        </DialogActions>
      </Dialog>

      {/* Rename home (owner only — the button that opens it is owner-gated) */}
      <Dialog open={open("rename-home")} onClose={closeDialog} fullWidth maxWidth="xs">
        <DialogTitle>Rename {home?.name || "this home"}</DialogTitle>
        <DialogContent>
          <TextField autoFocus margin="dense" label="New name" fullWidth value={name} onChange={(event) => setName(event.target.value)} />
          {errorLine}
        </DialogContent>
        <DialogActions>
          <Button onClick={closeDialog}>Cancel</Button>
          <Button variant="contained" disabled={busy || !name.trim()} onClick={() => onRenameHome({ name })}>
            {busy ? <CircularProgress size={18} /> : "Rename"}
          </Button>
        </DialogActions>
      </Dialog>

      {/* Add area */}
      <Dialog open={open("add-area")} onClose={closeDialog} fullWidth maxWidth="xs">
        <DialogTitle>Add an area</DialogTitle>
        <DialogContent>
          <TextField autoFocus margin="dense" label="Area name" fullWidth value={name} onChange={(event) => setName(event.target.value)} />
          <FormControl fullWidth margin="dense">
            <InputLabel>Kind</InputLabel>
            <Select value={kind} label="Kind" onChange={(event) => setKind(event.target.value)}>
              <MenuItem value="room">Room</MenuItem>
              <MenuItem value="outdoor">Outdoor area</MenuItem>
            </Select>
          </FormControl>
          {errorLine}
        </DialogContent>
        <DialogActions>
          <Button onClick={closeDialog}>Cancel</Button>
          <Button variant="contained" disabled={busy || !name.trim()} onClick={() => onAddArea({ name, kind })}>
            {busy ? <CircularProgress size={18} /> : "Add area"}
          </Button>
        </DialogActions>
      </Dialog>

      {/* Register device */}
      <Dialog open={open("add-device")} onClose={closeDialog} fullWidth maxWidth="xs">
        <DialogTitle>Register a device</DialogTitle>
        <DialogContent>
          <TextField autoFocus margin="dense" label="Device name" fullWidth value={name} onChange={(event) => setName(event.target.value)} />
          <FormControl fullWidth margin="dense">
            <InputLabel>Area</InputLabel>
            <Select value={areaId} label="Area" onChange={(event) => setAreaId(event.target.value)}>
              {areas.map((area) => <MenuItem key={area._id} value={area._id}>{area.name}</MenuItem>)}
            </Select>
          </FormControl>
          <FormControlLabel
            control={<Checkbox checked={capabilities.includes("switch")} onChange={(event) => setCapabilities((current) => (event.target.checked ? [...current, "switch"] : current.filter((item) => item !== "switch")))} />}
            label="Can switch on and off"
          />
          <FormControlLabel
            control={<Checkbox checked={capabilities.includes("light")} onChange={(event) => setCapabilities((current) => (event.target.checked ? [...current, "light"] : current.filter((item) => item !== "light")))} />}
            label="Is a light"
          />
          <TextField
            margin="dense" label="Other capabilities (comma-separated)" fullWidth value={extraCapabilities}
            onChange={(event) => setExtraCapabilities(event.target.value)} placeholder="motion, temperature"
          />
          <TextField margin="dense" label="Adapter" fullWidth value={adapterName} onChange={(event) => setAdapterName(event.target.value)} placeholder="hue" />
          <TextField margin="dense" label="Adapter binding" fullWidth value={adapterBinding} onChange={(event) => setAdapterBinding(event.target.value)} placeholder="living-lamp-1" />
          {errorLine}
        </DialogContent>
        <DialogActions>
          <Button onClick={closeDialog}>Cancel</Button>
          <Button
            variant="contained"
            disabled={busy || !name.trim() || !areaId || !adapterName.trim()}
            onClick={() => onAddDevice({
              name,
              areaId,
              capabilities: [...capabilities, ...extraCapabilities.split(",").map((item) => item.trim()).filter(Boolean)],
              adapter: { name: adapterName.trim(), binding: adapterBinding.trim() },
            })}
          >
            {busy ? <CircularProgress size={18} /> : "Register"}
          </Button>
        </DialogActions>
      </Dialog>

      {/* New scene */}
      <Dialog open={open("add-scene")} onClose={closeDialog} fullWidth maxWidth="sm">
        <DialogTitle>New scene</DialogTitle>
        <DialogContent>
          <TextField autoFocus margin="dense" label="Scene name" fullWidth value={name} onChange={(event) => setName(event.target.value)} />
          <Box sx={{ mt: 2 }}>
            <ActionRows devices={controllableDevices} rows={actionRows} setRows={setActionRows} />
          </Box>
          {errorLine}
        </DialogContent>
        <DialogActions>
          <Button onClick={closeDialog}>Cancel</Button>
          <Button
            variant="contained"
            disabled={busy || !name.trim() || !actionRows.some((row) => row.deviceId && row.command)}
            onClick={() => onAddScene({ name, rows: actionRows })}
          >
            {busy ? <CircularProgress size={18} /> : "Save scene"}
          </Button>
        </DialogActions>
      </Dialog>

      {/* New automation */}
      <Dialog open={open("add-automation")} onClose={closeDialog} fullWidth maxWidth="sm">
        <DialogTitle>New automation</DialogTitle>
        <DialogContent>
          <TextField autoFocus margin="dense" label="Automation name" fullWidth value={name} onChange={(event) => setName(event.target.value)} />
          <FormControl fullWidth margin="dense">
            <InputLabel>When this happens</InputLabel>
            <Select value={eventClass} label="When this happens" onChange={(event) => setEventClass(event.target.value)}>
              {EVENT_CLASSES.map((value) => <MenuItem key={value} value={value}>{EVENT_CLASS_LABELS[value]}</MenuItem>)}
            </Select>
          </FormControl>
          <FormControl fullWidth margin="dense">
            <InputLabel>In an area (optional)</InputLabel>
            <Select value={areaId} label="In an area (optional)" onChange={(event) => setAreaId(event.target.value)}>
              <MenuItem value=""><em>Anywhere</em></MenuItem>
              {areas.map((area) => <MenuItem key={area._id} value={area._id}>{area.name}</MenuItem>)}
            </Select>
          </FormControl>
          <FormControlLabel
            control={<Checkbox checked={afterDark} onChange={(event) => setAfterDark(event.target.checked)} />}
            label="Only after dark"
          />
          {!afterDark && (
            <Stack direction="row" spacing={1.5} sx={{ mt: 0.5 }}>
              <TextField label="From (optional)" type="time" fullWidth value={from} onChange={(event) => setFrom(event.target.value)} />
              <TextField label="Until (optional)" type="time" fullWidth value={to} onChange={(event) => setTo(event.target.value)} />
            </Stack>
          )}
          <Box sx={{ mt: 2 }}>
            <Typography variant="subtitle2" sx={{ mb: 1 }}>What it does</Typography>
            <ActionRows devices={controllableDevices} rows={actionRows} setRows={setActionRows} />
          </Box>
          {errorLine}
        </DialogContent>
        <DialogActions>
          <Button onClick={closeDialog}>Cancel</Button>
          <Button
            variant="contained"
            disabled={busy || !name.trim() || !actionRows.some((row) => row.deviceId && row.command)}
            onClick={() => onAddAutomation({ name, eventClass, areaId, afterDark, from, to, rows: actionRows })}
          >
            {busy ? <CircularProgress size={18} /> : "Save automation"}
          </Button>
        </DialogActions>
      </Dialog>
    </>
  );
}

const EVENT_CLASS_LABELS = { vehicle: "A vehicle", person: "A person", animal: "An animal", button: "A button press", door: "A door" };

/** The Home tab's whole surface, for any signed-in connection — the module
 * never gates on social bootstrap; homes and the active home ride this
 * screen's own fetch state plus the origin-scoped active-home memory. */
export function HomeDashboard({ data, actions }) {
  const origin = originOf(data?.server?.url) || (typeof window !== "undefined" ? window.location.origin : null);
  const storage = typeof window !== "undefined" ? window.localStorage : null;

  const [homes, setHomes] = useState([]);
  const [homesError, setHomesError] = useState("");
  const [homesLoading, setHomesLoading] = useState(true);

  // The active home and everything the switcher swaps in one place.
  const [home, setHome] = useState(null);
  const [areas, setAreas] = useState([]);
  const [devices, setDevices] = useState([]);
  const [scenes, setScenes] = useState([]);
  const [automations, setAutomations] = useState([]);
  const [homeLoading, setHomeLoading] = useState(false);
  const [homeError, setHomeError] = useState("");

  // Per-device command lifecycles (device id → state entry).
  const [commandStates, setCommandStates] = useState({});
  const timers = useRef(new Map());

  const [sceneResults, setSceneResults] = useState({});
  const [audit, setAudit] = useState({ events: [], hasMore: false, offset: 0 });
  const [auditError, setAuditError] = useState("");
  const [auditLoading, setAuditLoading] = useState(false);

  const [dialog, setDialog] = useState(null);
  const [busy, setBusy] = useState(false);
  const [dialogError, setDialogError] = useState("");
  const [snack, setSnack] = useState("");

  const applyDetail = (detail) => {
    setHome(detail?.home ?? null);
    setAreas(Array.isArray(detail?.areas) ? detail.areas : []);
    setDevices(Array.isArray(detail?.devices) ? detail.devices : []);
    setScenes(Array.isArray(detail?.scenes) ? detail.scenes : []);
    setAutomations(Array.isArray(detail?.automations) ? detail.automations : []);
    setCommandStates({}); // the switcher swaps everything, command states included
    setSceneResults({});
  };

  const loadHome = async (homeId) => {
    setHomeError("");
    setHomeLoading(true);
    try {
      const detail = await actions.loadHome(homeId);
      applyDetail(detail);
      setAudit({ events: [], hasMore: false, offset: 0 });
      loadAudit(homeId, 0);
    } catch (error) {
      setHomeError(messageOf(error));
    } finally {
      setHomeLoading(false);
    }
  };

  const loadAudit = async (homeId, offset) => {
    setAuditError("");
    setAuditLoading(true);
    try {
      const result = await actions.loadAudit(homeId, { limit: AUDIT_LIMIT, offset });
      const events = Array.isArray(result?.events) ? result.events : [];
      setAudit((current) => ({
        events: offset > 0 ? [...(current.events ?? []), ...events] : events,
        hasMore: result?.hasMore === true,
        offset: (offset ?? 0) + events.length,
      }));
    } catch (error) {
      setAuditError(messageOf(error));
    } finally {
      setAuditLoading(false);
    }
  };

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setHomesError("");
      setHomesLoading(true);
      try {
        const result = await actions.loadHomes();
        if (cancelled) return;
        const rows = Array.isArray(result?.homes) ? result.homes : [];
        setHomes(rows);
        if (rows.length) {
          // The active home persists per hub origin; fall back to the first.
          const stored = readActiveHomeId(storage, origin);
          const target = rows.find((row) => row._id === stored) ?? rows[0];
          writeActiveHomeId(storage, origin, target._id);
          const detail = await actions.loadHome(target._id);
          if (cancelled) return;
          applyDetail(detail);
          loadAudit(target._id, 0);
        }
      } catch (error) {
        if (!cancelled) setHomesError(messageOf(error));
      } finally {
        if (!cancelled) setHomesLoading(false);
      }
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => () => {
    for (const timer of timers.current.values()) clearTimeout(timer);
    timers.current.clear();
  }, []);

  const switchHome = async (homeId) => {
    if (!homeId || homeId === home?._id) return;
    writeActiveHomeId(storage, origin, homeId);
    await loadHome(homeId);
  };

  const ownerHere = home?.role === "owner";
  const grouped = useMemo(() => groupDevicesByArea(devices, areas), [devices, areas]);

  const runCommand = async (view, command) => {
    const deviceId = view.id;
    setCommandStates((current) => ({ ...current, [deviceId]: nextCommandState(current[deviceId], "start") }));
    try {
      const result = await actions.sendDeviceCommand(deviceId, command);
      // Confirmed ONLY from the server's own response; the returned device
      // row replaces the old one, and the rendered switch moves now — from
      // the confirmed row's lastKnownState, never from the tap.
      const row = result?.device;
      if (row?._id) setDevices((current) => current.map((item) => (item._id === row._id ? row : item)));
      setCommandStates((current) => ({ ...current, [deviceId]: nextCommandState(current[deviceId], "confirmed") }));
      timers.current.set(deviceId, setTimeout(() => {
        setCommandStates((current) => ({ ...current, [deviceId]: nextCommandState(current[deviceId], "clear") }));
        timers.current.delete(deviceId);
      }, CONFIRMED_HOLD_MS));
    } catch (failure) {
      const unreachable = failure?.code === "E_DEVICE_UNREACHABLE";
      const denied = failure?.code === "E_NOT_PERMITTED";
      const reason = unreachable
        ? `${view.name} did not respond just now. Its status may be out of date.`
        : messageOf(failure);
      setCommandStates((current) => ({ ...current, [deviceId]: nextCommandState(current[deviceId], "failed", reason) }));
      if (denied || unreachable) {
        const row = failure?.body?.device;
        if (row?._id) setDevices((current) => current.map((item) => (item._id === row._id ? row : item)));
      }
    }
  };

  const refreshDevice = async (view) => {
    try {
      const result = await actions.refreshDeviceState(home?._id, view.id);
      const row = result?.device;
      if (row?._id) setDevices((current) => current.map((item) => (item._id === row._id ? row : item)));
    } catch (error) {
      setSnack(messageOf(error));
    }
  };

  const runScene = async (scene) => {
    try {
      const result = await actions.runScene(scene._id);
      await loadHome(home._id); // the run moves devices; reload the confirmed rows
      // The outcome chips land AFTER the reload (the reload resets scene
      // results with everything else) so they survive to be read.
      setSceneResults((current) => ({
        ...current,
        [scene._id]: Array.isArray(result?.results) ? result.results : [],
      }));
    } catch (error) {
      setSnack(messageOf(error));
    }
  };

  const toggleAutomation = async (automation) => {
    try {
      const result = await actions.updateAutomation(automation._id, { enabled: !automation.enabled });
      const row = result?.automation;
      if (row?._id) setAutomations((current) => current.map((item) => (item._id === row._id ? row : item)));
    } catch (error) {
      setSnack(messageOf(error));
    }
  };

  const openDialog = (name_) => {
    setDialogError("");
    setDialog(name_);
  };

  const closeDialog = () => {
    setDialog(null);
    setDialogError("");
    setBusy(false);
  };

  const reportDialogError = (error) => {
    setDialogError(messageOf(error));
    setBusy(false);
  };

  const submitWith = (action) => async (draft) => {
    setBusy(true);
    setDialogError("");
    try {
      await action(draft);
      closeDialog();
    } catch (error) {
      reportDialogError(error);
    }
  };

  const submitCreateHome = submitWith(async ({ name: name_ }) => {
    await actions.createHome(name_);
    const result = await actions.loadHomes();
    const rows = Array.isArray(result?.homes) ? result.homes : [];
    setHomes(rows);
    const created = rows.find((row) => row.name === (name_ ?? "").trim()) ?? rows[rows.length - 1];
    if (created) {
      writeActiveHomeId(storage, origin, created._id);
      await loadHome(created._id);
    }
  });

  const submitRenameHome = submitWith(async ({ name: name_ }) => {
    const result = await actions.renameHome(home._id, name_);
    const row = result?.home;
    if (row?._id) {
      setHome((current) => ({ ...current, ...row }));
      setHomes((current) => current.map((item) => (item._id === row._id ? { ...item, name: row.name } : item)));
    } else {
      await loadHome(home._id);
    }
  });

  const submitAddArea = submitWith(async (draft) => {
    await actions.createArea(home._id, { name: draft.name, kind: draft.kind });
    await loadHome(home._id);
  });

  const submitAddDevice = submitWith(async (draft) => {
    await actions.registerDevice(home._id, draft);
    await loadHome(home._id);
  });

  const submitAddScene = submitWith(async ({ name: name_, rows }) => {
    await actions.createScene(home._id, { name: name_, actions: rows.filter((row) => row.deviceId && row.command) });
    await loadHome(home._id);
  });

  const submitAddAutomation = submitWith(async ({ name: name_, eventClass, areaId, afterDark, from, to, rows }) => {
    const timeWindow = afterDark
      ? { afterDark: true }
      : (from || to
        ? { ...(from ? { from } : {}), ...(to ? { to } : {}) }
        : undefined);
    const trigger = { eventClass, ...(areaId ? { areaId } : {}), ...(timeWindow ? { timeWindow } : {}) };
    await actions.createAutomation(home._id, {
      name: name_,
      trigger,
      actions: rows.filter((row) => row.deviceId && row.command),
      enabled: true,
    });
    await loadHome(home._id);
  });

  const controllableDevices = controllableOf(devices);
  const deviceName = (deviceId) => devices.find((device) => device._id === deviceId)?.name;
  const actorName = (event) => (event?.actorIdentityRef && event.actorIdentityRef === data?.identity?.id ? "You" : "A family member");
  const commandEntry = (deviceId) => ({
    status: commandStatusOf(commandStates, deviceId),
    reason: commandReasonOf(commandStates, deviceId),
  });

  const renderCard = (view) => (
    <DeviceRow
      key={view.id}
      view={view}
      command={commandEntry(view.id)}
      onCommand={(command) => runCommand(view, command)}
      onRefresh={() => refreshDevice(view)}
    />
  );

  // --- render ----------------------------------------------------------------
  if (homesLoading && !homes.length) {
    return (
      <Stack direction="row" spacing={2} alignItems="center" justifyContent="center" sx={{ py: 6 }}>
        <CircularProgress size={22} />
        <Typography color="text.secondary">Opening your homes…</Typography>
      </Stack>
    );
  }

  if (homesError && !homes.length) {
    return <Alert severity="warning" sx={{ mt: 2 }}>{homesError}</Alert>;
  }

  if (!homes.length) {
    return (
      <Box sx={{ py: 8, textAlign: "center" }}>
        <Typography variant="h5" sx={{ mb: 1 }}>Your family's homes</Typography>
        <Typography color="text.secondary" sx={{ mb: 3 }}>
          No homes yet — create your first home.
        </Typography>
        <Button variant="contained" startIcon={<AddOutlined />} onClick={() => openDialog("create-home")}>
          Create a home
        </Button>
        <HomeDialogs
          dialog={dialog} busy={busy} dialogError={dialogError} closeDialog={closeDialog}
          homes={homes} areas={[]} controllableDevices={[]}
          onCreateHome={submitCreateHome}
        />
      </Box>
    );
  }

  const anyDevices = devices.length > 0;

  return (
    <Box sx={{ pb: 4 }}>
      {/* Home switcher bar: switching swaps every section below. */}
      <Stack direction="row" spacing={1} alignItems="center" sx={{ flexWrap: "wrap", rowGap: 1 }}>
        {homes.map((item) => (
          <Chip
            key={item._id}
            label={item.name}
            onClick={() => switchHome(item._id)}
            color={item._id === home?._id ? "primary" : "default"}
            variant={item._id === home?._id ? "filled" : "outlined"}
          />
        ))}
        <Chip label="New home" onClick={() => openDialog("create-home")} sx={{ borderStyle: "dashed" }} />
      </Stack>

      <Stack direction="row" alignItems="center" spacing={1.5} sx={{ mt: 1.5 }}>
        <Typography variant="h4">{home?.name || "Your home"}</Typography>
        {ownerHere && <Button size="small" onClick={() => openDialog("rename-home")}>Rename</Button>}
      </Stack>
      {home && (
        <Typography variant="body2" sx={{ color: "text.secondary", mt: 0.5 }}>
          {ownerHere ? "You look after this home." : "You belong to this home."}
        </Typography>
      )}
      {homeError && <Alert severity="warning" sx={{ mt: 2 }}>{homeError}</Alert>}
      {homeLoading && (
        <Stack direction="row" spacing={1.5} alignItems="center" sx={{ mt: 2 }}>
          <CircularProgress size={18} />
          <Typography variant="body2" sx={{ color: "text.secondary" }}>Loading this home…</Typography>
        </Stack>
      )}

      {/* Rooms */}
      <SectionHeader
        title="Rooms"
        action={(
          <Button size="small" startIcon={<AddOutlined />} onClick={() => openDialog("add-area")}>
            Add area
          </Button>
        )}
      />
      <AreaSection groups={grouped.rooms} empty="No rooms yet — add an area to place devices in." renderCard={renderCard} />

      {/* Outdoor areas always render as their own section, never mixed in. */}
      <SectionHeader title="Outdoor areas" />
      <AreaSection groups={grouped.outdoor} empty="No outdoor areas yet." renderCard={renderCard} />

      <Box sx={{ mt: 2 }}>
        <Button
          size="small"
          startIcon={<AddOutlined />}
          onClick={() => openDialog("add-device")}
          disabled={!areas.length}
        >
          {anyDevices ? "Register another device" : "Register your first device"}
        </Button>
      </Box>
      <Divider sx={{ mt: 4 }} />

      {/* Scenes */}
      <SectionHeader
        title="Scenes"
        action={(
          <Button
            size="small"
            startIcon={<AddOutlined />}
            onClick={() => openDialog("add-scene")}
            disabled={!controllableDevices.length}
          >
            New scene
          </Button>
        )}
      />
      {scenes.length === 0 && <EmptyLine>No scenes yet — group a few device actions into one tap.</EmptyLine>}
      {scenes.map((scene) => (
        <Paper key={scene._id} elevation={0} sx={{ p: 2, mb: 1.25, borderRadius: 3, border: "1px solid", borderColor: "var(--porch-border)", bgcolor: "var(--porch-surface)" }}>
          <Stack direction="row" alignItems="center" justifyContent="space-between">
            <Typography variant="subtitle1" sx={{ fontWeight: 600 }}>{scene.name}</Typography>
            <Button size="small" startIcon={<PlayArrowOutlined />} onClick={() => runScene(scene)}>Run</Button>
          </Stack>
          <Typography variant="body2" sx={{ color: "text.secondary", mt: 0.5 }}>
            {(scene.actions ?? []).map((action) => `${deviceName(action.deviceId) ?? "A device"} — ${commandLabel(action.command)}`).join(" · ") || "No actions in this scene yet."}
          </Typography>
          {sceneResults[scene._id] && (
            <Stack direction="row" spacing={1} sx={{ mt: 1.5, flexWrap: "wrap", rowGap: 1 }}>
              {sceneResults[scene._id].length === 0
                ? <Typography variant="body2" sx={{ color: "text.secondary" }}>Nothing to run.</Typography>
                : sceneResults[scene._id].map((result, index) => (
                  <Chip
                    key={index}
                    size="small"
                    variant="outlined"
                    icon={result.outcome === "confirmed" ? <CheckCircleOutlined sx={{ color: "var(--porch-vote-up)" }} /> : undefined}
                    label={result.outcome === "confirmed"
                      ? `${deviceName(result.deviceId) ?? "A device"}: ${commandLabel(result.command).toLowerCase()} — done`
                      : `${deviceName(result.deviceId) ?? "A device"}: ${result.reason || "did not respond"}`}
                    sx={result.outcome === "confirmed" ? {} : { color: "error.main", borderColor: "error.main" }}
                  />
                ))}
            </Stack>
          )}
        </Paper>
      ))}
      <Divider sx={{ mt: 4 }} />

      {/* Automations */}
      <SectionHeader
        title="Automations"
        action={(
          <Button
            size="small"
            startIcon={<AddOutlined />}
            onClick={() => openDialog("add-automation")}
            disabled={!controllableDevices.length}
          >
            New automation
          </Button>
        )}
      />
      {automations.length === 0 && <EmptyLine>No automations yet — let the house act on its own.</EmptyLine>}
      {automations.map((automation) => (
        <Paper key={automation._id} elevation={0} sx={{ p: 2, mb: 1.25, borderRadius: 3, border: "1px solid", borderColor: "var(--porch-border)", bgcolor: "var(--porch-surface)" }}>
          <Stack direction="row" alignItems="center" justifyContent="space-between">
            <Typography variant="subtitle1" sx={{ fontWeight: 600 }}>{automation.name}</Typography>
            <FormControlLabel
              control={<Switch checked={automation.enabled === true} onChange={() => toggleAutomation(automation)} />}
              label={automation.enabled === true ? "On" : "Off"}
              labelPlacement="start"
            />
          </Stack>
          <Typography variant="body2" sx={{ color: "text.secondary", mt: 0.5 }}>
            {automationTriggerLabel(automation.trigger, areas)}
          </Typography>
          <Typography variant="body2" sx={{ color: "text.secondary", mt: 0.25 }}>
            {(automation.actions ?? []).map((action) => `${deviceName(action.deviceId) ?? "A device"} — ${commandLabel(action.command)}`).join(" · ") || "No actions in this automation yet."}
          </Typography>
          <Typography variant="body2" sx={{ color: "text.muted", mt: 0.5 }}>
            {automation.lastFiredAt ? `Last fired ${relativeTime(automation.lastFiredAt)}.` : "It has not fired yet."}
          </Typography>
        </Paper>
      ))}
      <Divider sx={{ mt: 4 }} />

      {/* Recent activity (audit) */}
      <SectionHeader title="Recent activity" />
      {auditError && <Alert severity="warning" sx={{ mb: 1.5 }}>{auditError}</Alert>}
      {!auditError && (audit.events ?? []).length === 0 && (
        <EmptyLine>{auditLoading ? "Loading recent activity…" : "Nothing has happened in this home yet."}</EmptyLine>
      )}
      {(audit.events ?? []).map((event) => (
        <Stack
          key={event._id}
          direction={{ xs: "column", sm: "row" }}
          spacing={{ xs: 0.25, sm: 1.5 }}
          sx={{ py: 0.75, borderBottom: "1px solid", borderColor: "var(--porch-border)" }}
        >
          <Typography variant="body2" sx={{ fontWeight: 600, minWidth: { sm: 150 }, maxWidth: { sm: 280 } }}>
            {auditLabel(event.type)}
          </Typography>
          <Typography variant="body2" sx={{ color: "text.secondary", flex: 1 }}>
            {actorName(event)}
            {event.deviceId && deviceName(event.deviceId) ? ` · ${deviceName(event.deviceId)}` : ""}
            {event.outcome && event.outcome !== "confirmed" ? ` · ${event.outcome === "failed" ? "it did not go through" : event.outcome}` : ""}
          </Typography>
          <Typography variant="body2" sx={{ color: "text.muted" }} title={dateOf(event.at)}>
            {relativeTime(event.at)}
          </Typography>
        </Stack>
      ))}
      {audit.hasMore && !auditLoading && (
        <Box sx={{ mt: 1.5 }}>
          <Button size="small" onClick={() => loadAudit(home._id, audit.offset)}>Load more</Button>
        </Box>
      )}

      <HomeDialogs
        dialog={dialog} busy={busy} dialogError={dialogError} closeDialog={closeDialog}
        home={home} homes={homes} areas={areas} controllableDevices={controllableDevices}
        onCreateHome={submitCreateHome}
        onRenameHome={submitRenameHome}
        onAddArea={submitAddArea}
        onAddDevice={submitAddDevice}
        onAddScene={submitAddScene}
        onAddAutomation={submitAddAutomation}
      />

      {snack && (
        <Alert severity="warning" onClose={() => setSnack("")} sx={{ position: "fixed", bottom: 96, left: 24, zIndex: 30, maxWidth: 420 }}>
          {snack}
        </Alert>
      )}
    </Box>
  );
}

export default HomeDashboard;
