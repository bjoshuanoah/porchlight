// Storage (PORCH-136): the first-run storage questions (ac-1), the live
// backend status with tier usage and drive health (ac-4), the manual
// failback a degraded write demands, per-camera recording controls
// (ac-3), and retention rules. Every server response is shown in plain
// language — loading is never an error, and refused requests surface the
// service's own words verbatim.
import React, { useEffect, useState } from "react";
import Alert from "@mui/material/Alert";
import Button from "@mui/material/Button";
import Chip from "@mui/material/Chip";
import Collapse from "@mui/material/Collapse";
import IconButton from "@mui/material/IconButton";
import AddIcon from "@mui/icons-material/Add";
import DeleteIcon from "@mui/icons-material/Delete";
import MenuItem from "@mui/material/MenuItem";
import Paper from "@mui/material/Paper";
import Stack from "@mui/material/Stack";
import Table from "@mui/material/Table";
import TableBody from "@mui/material/TableBody";
import TableCell from "@mui/material/TableCell";
import TableContainer from "@mui/material/TableContainer";
import TableHead from "@mui/material/TableHead";
import TableRow from "@mui/material/TableRow";
import TextField from "@mui/material/TextField";
import Typography from "@mui/material/Typography";

const EVENT_CLASSES = ["person", "animal", "vehicle"];

// Plain-language names for the recorder's backend states. "unreachable"
// source is explained separately below; setup happens whenever the store
// says recording is not configured.
const STATE_LABELS = {
  primary: "Recording to your primary storage location.",
  "degraded-write": "The primary location is not responding, so recordings are going to the failover location.",
  unavailable: "Storage is not working right now, so recordings are not being saved.",
  "not-configured": "Nothing is saved yet — tell Porchlight where recordings should go.",
};

function formatBytes(bytes) {
  const value = Number(bytes);
  if (!Number.isFinite(value)) return "—";
  if (value < 1024) return `${value} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let scaled = value;
  let unit = -1;
  while (scaled >= 1024 && unit < units.length - 1) {
    scaled /= 1024;
    unit += 1;
  }
  return `${scaled >= 10 ? Math.round(scaled) : scaled.toFixed(1)} ${units[unit]}`;
}

function scopeLabel(rule, cameraName) {
  if (rule?.zoneId) return `Zone: ${rule.zoneId}${rule?.cameraId ? ` on ${cameraName(rule.cameraId)}` : ""}`;
  if (rule?.cameraId) return `Camera: ${cameraName(rule.cameraId)}`;
  if (rule?.eventClass) return `Events: ${rule.eventClass}`;
  return "Everything";
}

export default function Storage({ api }) {
  const [storage, setStorage] = useState(null);
  const [cameras, setCameras] = useState([]);
  const [modes, setModes] = useState({}); // cameraId → effective recording mode
  const [rules, setRules] = useState([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [error, setError] = useState(""); // action failures — the server's own words, kept until the next action
  const [status, setStatus] = useState("");

  // First-run setup (ac-1)
  const [primary, setPrimary] = useState("");
  const [failoverOpen, setFailoverOpen] = useState(false);
  const [failover, setFailover] = useState("");
  const [retentionDays, setRetentionDays] = useState("");
  const [testResult, setTestResult] = useState(null); // { ok, text }
  const [testing, setTesting] = useState(false);
  const [saving, setSaving] = useState(false);

  // Manual failback (ac-4)
  const [failbackNote, setFailbackNote] = useState(null); // { ok, text }
  const [failingBack, setFailingBack] = useState(false);

  // Recording controls (ac-3)
  const [recordNotes, setRecordNotes] = useState({}); // cameraId → inline result text
  const [busyCamera, setBusyCamera] = useState("");

  // Retention rules form
  const [ruleScope, setRuleScope] = useState("everything");
  const [ruleCameraId, setRuleCameraId] = useState("");
  const [ruleZoneCameraId, setRuleZoneCameraId] = useState("");
  const [ruleZoneId, setRuleZoneId] = useState("");
  const [zoneOptions, setZoneOptions] = useState([]);
  const [ruleEventClass, setRuleEventClass] = useState("");
  const [ruleKeepDays, setRuleKeepDays] = useState("");
  const [ruleError, setRuleError] = useState("");

  useEffect(() => {
    refreshAll();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps -- initial load

  async function refreshAll() {
    setLoading(true);
    try {
      const [storageDoc, cameraList, ruleList] = await Promise.all([api.getStorage(), api.listCameras(), api.listStorageRules()]);
      setStorage(storageDoc ?? null);
      setCameras(cameraList ?? []);
      setRules(ruleList ?? []);
      setModes(await loadModes(cameraList ?? []));
      setLoadError("");
    } catch (failure) {
      setLoadError(failure.message);
    } finally {
      setLoading(false);
    }
  }

  async function loadModes(cameraList) {
    const resolved = {};
    await Promise.all(
      cameraList.map(async (camera) => {
        try {
          const knobs = await api.getKnobs(camera.id);
          resolved[camera.id] = knobs?.knobs?.recordingMode?.value ?? "";
        } catch {
          resolved[camera.id] = ""; // a knob miss is never a console error
        }
      }),
    );
    return resolved;
  }

  useEffect(() => {
    if (ruleScope !== "zone" || !ruleZoneCameraId) {
      setZoneOptions([]);
      return undefined;
    }
    let cancelled = false;
    api
      .listZones(ruleZoneCameraId)
      .then((zones) => {
        if (!cancelled) {
          setZoneOptions(zones ?? []);
          setRuleZoneId("");
        }
      })
      .catch(() => setZoneOptions([])); // a zone miss is never a console error
    return () => {
      cancelled = true;
    };
  }, [api, ruleScope, ruleZoneCameraId]); // eslint-disable-line react-hooks/exhaustive-deps -- scope choice is the trigger

  const needsSetup = !storage || storage.state === "not-configured" || storage.configured === false;
  const cameraName = (id) => cameras.find((camera) => camera.id === id)?.name || id;

  async function runTest() {
    setTesting(true);
    setTestResult(null);
    try {
      const result = await api.testStorageLocation(primary.trim());
      setTestResult({ ok: Boolean(result?.ok), text: "That location is usable for storing recordings." });
    } catch (failure) {
      setTestResult({ ok: false, text: failure.message });
    } finally {
      setTesting(false);
    }
  }

  async function saveSetup() {
    setSaving(true);
    try {
      const body = { primary: primary.trim() };
      if (failoverOpen && failover.trim()) body.failover = failover.trim();
      if (String(retentionDays).trim()) body.eventRetentionDays = Number(retentionDays);
      const doc = await api.configureStorage(body);
      setError("");
      setStatus("Storage saved.");
      setStorage(doc);
      await refreshAll();
    } catch (failure) {
      // The service's plain-language 422 verbatim — never auto-cleared.
      setError(failure.message);
      setStatus("");
    } finally {
      setSaving(false);
    }
  }

  async function runFailback() {
    setFailingBack(true);
    setFailbackNote(null);
    try {
      await api.storageFailback();
      setFailbackNote({ ok: true, text: "Recordings are going to the primary location again." });
      await refreshAll();
    } catch (failure) {
      // A 409 refusal (or any other error) keeps the service's own words.
      setFailbackNote({ ok: false, text: failure.message });
    } finally {
      setFailingBack(false);
    }
  }

  async function record(camera, action) {
    setBusyCamera(camera.id);
    try {
      const result = await api.manualRecord(camera.id, action);
      setRecordNotes((current) => ({
        ...current,
        [camera.id]: result?.ok === false
          ? result.reason
          : action === "start"
            ? `Recording started on ${camera.name || camera.id}.`
            : `Recording stopped on ${camera.name || camera.id}.`,
      }));
    } catch (failure) {
      setRecordNotes((current) => ({ ...current, [camera.id]: failure.message }));
    } finally {
      setBusyCamera("");
    }
  }

  function ruleBody() {
    const body = { keepDays: Number(ruleKeepDays) };
    if (ruleScope === "camera" && ruleCameraId) body.cameraId = ruleCameraId;
    if (ruleScope === "zone" && ruleZoneCameraId && ruleZoneId) {
      body.cameraId = ruleZoneCameraId;
      body.zoneId = ruleZoneId;
    }
    if (ruleScope === "event" && ruleEventClass) body.eventClass = ruleEventClass;
    return body;
  }

  async function addRule() {
    setRuleError("");
    try {
      await api.addStorageRule(ruleBody());
      setStatus("Retention rule added.");
      setRuleScope("everything");
      setRuleCameraId("");
      setRuleZoneCameraId("");
      setRuleZoneId("");
      setRuleEventClass("");
      setRuleKeepDays("");
      setRules(await api.listStorageRules());
    } catch (failure) {
      setRuleError(failure.message);
    }
  }

  async function removeRule(rule) {
    setRuleError("");
    try {
      await api.deleteStorageRule(rule.id);
      setStatus("Retention rule removed.");
      setRules(await api.listStorageRules());
    } catch (failure) {
      // A 404 for an already-gone rule surfaces verbatim.
      setRuleError(failure.message);
    }
  }

  if (loading && !storage) {
    return <Typography color="text.secondary">Loading storage status…</Typography>;
  }

  return (
    <Stack spacing={2}>
      {loadError && (
        <Stack direction="row" spacing={2} alignItems="center">
          <Typography color="error" sx={{ mr: "auto" }}>
            {loadError}
          </Typography>
          <Button variant="outlined" onClick={refreshAll}>
            Retry
          </Button>
        </Stack>
      )}
      {error && <Typography color="error">{error}</Typography>}
      {status && !error && <Typography color="text.secondary">{status}</Typography>}

      <Stack direction="row" spacing={2} alignItems="center">
        <Typography variant="subtitle2" sx={{ mr: "auto" }}>
          Storage
        </Typography>
        <Button size="small" variant="outlined" onClick={refreshAll} disabled={loading}>
          Refresh
        </Button>
      </Stack>

      {storage?.source === "unreachable" && (
        <Alert severity="warning">
          The recorder can't be reached right now, so what follows is the last status Porchlight knew.
          {storage.reason ? ` The recorder said: ${storage.reason}` : ""}
        </Alert>
      )}

      {needsSetup ? (
        <SetupForm
          primary={primary}
          setPrimary={setPrimary}
          failoverOpen={failoverOpen}
          setFailoverOpen={setFailoverOpen}
          failover={failover}
          setFailover={setFailover}
          retentionDays={retentionDays}
          setRetentionDays={setRetentionDays}
          testResult={testResult}
          testing={testing}
          runTest={runTest}
          saving={saving}
          saveSetup={saveSetup}
        />
      ) : (
        <>
          <StatusView storage={storage} />
          {storage.state === "degraded-write" && (
            <Paper variant="outlined" sx={{ p: 2 }}>
              <Stack direction="row" spacing={2} alignItems="center" sx={{ flexWrap: "wrap" }}>
                <Typography sx={{ mr: "auto" }}>Recordings are going to the failover location. Switch back?</Typography>
                <Button variant="contained" onClick={runFailback} disabled={failingBack}>
                  Use the primary location again
                </Button>
              </Stack>
              {failbackNote && (
                <Typography color={failbackNote.ok ? "text.secondary" : "error"} sx={{ mt: 1 }}>
                  {failbackNote.text}
                </Typography>
              )}
            </Paper>
          )}
        </>
      )}

      <RecordingModes cameras={cameras} modes={modes} recordNotes={recordNotes} busyCamera={busyCamera} record={record} />

      <RuleSection
        rules={rules}
        cameras={cameras}
        cameraName={cameraName}
        ruleScope={ruleScope}
        setRuleScope={setRuleScope}
        ruleCameraId={ruleCameraId}
        setRuleCameraId={setRuleCameraId}
        ruleZoneCameraId={ruleZoneCameraId}
        setRuleZoneCameraId={setRuleZoneCameraId}
        ruleZoneId={ruleZoneId}
        setRuleZoneId={setRuleZoneId}
        zoneOptions={zoneOptions}
        ruleEventClass={ruleEventClass}
        setRuleEventClass={setRuleEventClass}
        ruleKeepDays={ruleKeepDays}
        setRuleKeepDays={setRuleKeepDays}
        ruleError={ruleError}
        addRule={addRule}
        removeRule={removeRule}
      />
    </Stack>
  );
}

function SetupForm({
  primary, setPrimary,
  failoverOpen, setFailoverOpen,
  failover, setFailover,
  retentionDays, setRetentionDays,
  testResult, testing, runTest,
  saving, saveSetup,
}) {
  return (
    <Paper variant="outlined" sx={{ p: 2 }}>
      <Typography variant="subtitle2">Set up storage</Typography>
      <Stack spacing={2} sx={{ mt: 1 }}>
        <TextField
          label="Where should we store your data?"
          size="small"
          value={primary}
          onChange={(event) => setPrimary(event.target.value)}
          sx={{ minWidth: 320 }}
          placeholder="/media/porchlight"
        />
        <Stack direction="row" spacing={2} alignItems="center">
          <Button size="small" variant="outlined" onClick={() => setFailoverOpen(!failoverOpen)}>
            {failoverOpen ? "Remove failover location" : "Add a failover location"}
          </Button>
          <Button size="small" variant="outlined" onClick={runTest} disabled={!primary.trim() || testing}>
            Test location
          </Button>
        </Stack>
        <Collapse in={failoverOpen}>
          <TextField
            label="If that is down, where should we store your data instead?"
            size="small"
            value={failover}
            onChange={(event) => setFailover(event.target.value)}
            sx={{ minWidth: 320 }}
            placeholder="/media/porchlight-failover"
          />
        </Collapse>
        <TextField
          select
          label="Keep event recordings for"
          size="small"
          value={retentionDays}
          onChange={(event) => setRetentionDays(event.target.value)}
          helperText="Optional — how long event recordings stay before the rolling cleanup."
          sx={{ width: 200 }}
        >
          <MenuItem value="">Default</MenuItem>
          {[3, 7, 14, 30, 90].map((days) => (
            <MenuItem key={days} value={String(days)}>
              {days} days
            </MenuItem>
          ))}
        </TextField>
        {testResult && (
          <Typography color={testResult.ok ? "text.secondary" : "error"}>{testResult.text}</Typography>
        )}
        <Stack direction="row" spacing={2}>
          <Button variant="contained" onClick={saveSetup} disabled={!primary.trim() || saving}>
            Save storage
          </Button>
        </Stack>
      </Stack>
    </Paper>
  );
}

function StatusView({ storage }) {
  const usage = storage?.usage?.tiers ?? {};
  const disk = storage?.usage?.diskUsedFraction;
  return (
    <Paper variant="outlined" sx={{ p: 2 }}>
      <Typography variant="subtitle2">Storage status</Typography>
      <Typography sx={{ mt: 0.5 }}>{STATE_LABELS[storage.state] ?? storage.state}</Typography>

      {storage.reason && (
        <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5 }}>
          {storage.reason}
        </Typography>
      )}

      {storage.driveHealthy === false && (
        <Alert severity="error" sx={{ mt: 1 }}>
          {storage.driveReason
            ? `The storage drive has a problem: ${storage.driveReason}`
            : "The storage drive needs attention."}
        </Alert>
      )}

      {storage.paused ? (
        <Chip sx={{ mt: 1 }} size="small" color="warning" label="Recording is paused" />
      ) : null}

      <Stack spacing={0.5} sx={{ mt: 1 }}>
        <Typography variant="body2">Primary location: {storage.primary ?? "—"}</Typography>
        {storage.failover && (
          <Typography variant="body2">Failover location: {storage.failover}</Typography>
        )}
      </Stack>

      <TableContainer sx={{ mt: 1 }}>
        <Table size="small">
          <TableHead>
            <TableRow>
              <TableCell>Recordings</TableCell>
              <TableCell>Clips</TableCell>
              <TableCell>Space used</TableCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {["rolling", "events", "manual"].map((tier) => (
              <TableRow key={tier}>
                <TableCell>{tier === "rolling" ? "Rolling (auto-cleaning)" : tier === "events" ? "Event clips" : "Manual clips"}</TableCell>
                <TableCell>{usage[tier]?.segments ?? 0}</TableCell>
                <TableCell>{formatBytes(usage[tier]?.bytes)}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </TableContainer>
      {Number.isFinite(disk) && (
        <Typography variant="body2" color="text.secondary" sx={{ mt: 1 }}>
          Disk used: {Math.round(disk * 100)}%
        </Typography>
      )}
    </Paper>
  );
}

function RecordingModes({ cameras, modes, recordNotes, busyCamera, record }) {
  return (
    <Paper variant="outlined" sx={{ p: 2 }}>
      <Typography variant="subtitle2">Recording</Typography>
      {cameras.length === 0 && (
        <Typography variant="body2" color="text.secondary" sx={{ mt: 1 }}>
          No cameras are configured yet.
        </Typography>
      )}
      <Stack spacing={1} sx={{ mt: 1 }}>
        {cameras.map((camera) => {
          const mode = modes[camera.id];
          return (
            <Paper key={camera.id} variant="outlined" sx={{ p: 1.5 }}>
              <Stack direction="row" spacing={2} alignItems="center" sx={{ flexWrap: "wrap" }}>
                <Typography sx={{ fontWeight: 600 }}>{camera.name || camera.id}</Typography>
                <Chip
                  size="small"
                  variant="outlined"
                  label={mode ? `Mode: ${mode}` : "Mode: unknown"}
                />
                <Stack direction="row" spacing={1} sx={{ ml: "auto" }}>
                  <Button
                    size="small"
                    variant="outlined"
                    disabled={busyCamera === camera.id}
                    onClick={() => record(camera, "start")}
                  >
                    Start now
                  </Button>
                  <Button
                    size="small"
                    variant="outlined"
                    disabled={busyCamera === camera.id}
                    onClick={() => record(camera, "stop")}
                  >
                    Stop
                  </Button>
                </Stack>
              </Stack>
              {recordNotes[camera.id] && (
                <Typography variant="body2" color="text.secondary" sx={{ mt: 1 }}>
                  {recordNotes[camera.id]}
                </Typography>
              )}
            </Paper>
          );
        })}
      </Stack>
    </Paper>
  );
}

function RuleSection({
  rules, cameraName,
  ruleScope, setRuleScope,
  ruleCameraId, setRuleCameraId,
  ruleZoneCameraId, setRuleZoneCameraId,
  ruleZoneId, setRuleZoneId,
  zoneOptions,
  ruleEventClass, setRuleEventClass,
  ruleKeepDays, setRuleKeepDays,
  ruleError, addRule, removeRule,
}) {
  return (
    <Paper variant="outlined" sx={{ p: 2 }}>
      <Typography variant="subtitle2">Retention rules</Typography>
      <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5 }}>
        Rules keep specific recordings past the rolling cleanup window.
      </Typography>

      {rules.length === 0 && (
        <Typography variant="body2" color="text.secondary" sx={{ mt: 1 }}>
          No rules yet — everything follows the rolling cleanup.
        </Typography>
      )}
      {rules.map((rule) => (
        <Stack key={rule.id ?? `${rule.cameraId}-${rule.eventClass}-${rule.zoneId}`} direction="row" spacing={2} alignItems="center" sx={{ mt: 1, flexWrap: "wrap" }}>
          <Typography sx={{ mr: "auto" }}>
            {scopeLabel(rule, cameraName)} — keep {rule.keepDays} {rule.keepDays === 1 ? "day" : "days"}
          </Typography>
          <IconButton
            size="small"
            aria-label={`Delete the "${scopeLabel(rule, cameraName)}" rule`}
            onClick={() => removeRule(rule)}
          >
            <DeleteIcon fontSize="small" />
          </IconButton>
        </Stack>
      ))}

      <Stack direction="row" spacing={2} sx={{ mt: 2, flexWrap: "wrap" }} alignItems="center">
        <TextField
          select
          label="Keep what?"
          size="small"
          value={ruleScope}
          onChange={(event) => setRuleScope(event.target.value)}
          sx={{ minWidth: 180 }}
        >
          <MenuItem value="everything">Everything</MenuItem>
          <MenuItem value="camera">A camera</MenuItem>
          <MenuItem value="zone">A zone</MenuItem>
          <MenuItem value="event">An event class</MenuItem>
        </TextField>
        {ruleScope === "camera" && (
          <TextField
            select
            label="Camera"
            size="small"
            value={ruleCameraId}
            onChange={(event) => setRuleCameraId(event.target.value)}
            sx={{ minWidth: 200 }}
          >
            {cameras.map((camera) => (
              <MenuItem key={camera.id} value={camera.id}>
                {camera.name || camera.id}
              </MenuItem>
            ))}
          </TextField>
        )}
        {ruleScope === "zone" && (
          <>
            <TextField
              select
              label="Camera"
              size="small"
              value={ruleZoneCameraId}
              onChange={(event) => setRuleZoneCameraId(event.target.value)}
              sx={{ minWidth: 200 }}
            >
              {cameras.map((camera) => (
                <MenuItem key={camera.id} value={camera.id}>
                  {camera.name || camera.id}
                </MenuItem>
              ))}
            </TextField>
            {ruleZoneCameraId && (
              <TextField
                select
                label="Zone"
                size="small"
                value={ruleZoneId}
                onChange={(event) => setRuleZoneId(event.target.value)}
                sx={{ minWidth: 200 }}
              >
                {zoneOptions.map((zone) => (
                  <MenuItem key={zone.id} value={zone.id}>
                    {zone.name || zone.id}
                  </MenuItem>
                ))}
              </TextField>
            )}
          </>
        )}
        {ruleScope === "event" && (
          <TextField
            select
            label="Event class"
            size="small"
            value={ruleEventClass}
            onChange={(event) => setRuleEventClass(event.target.value)}
            sx={{ minWidth: 160 }}
          >
            {EVENT_CLASSES.map((eventClass) => (
              <MenuItem key={eventClass} value={eventClass}>
                {eventClass}
              </MenuItem>
            ))}
          </TextField>
        )}
        <TextField
          label="Keep for (days)"
          size="small"
          type="number"
          value={ruleKeepDays}
          onChange={(event) => setRuleKeepDays(event.target.value)}
          sx={{ width: 150 }}
          slotProps={{ htmlInput: { min: 1 } }}
        />
        <Button variant="contained" startIcon={<AddIcon />} onClick={addRule} disabled={!ruleKeepDays}>
          Add rule
        </Button>
      </Stack>
      {ruleError && (
        <Typography color="error" sx={{ mt: 1 }}>
          {ruleError}
        </Typography>
      )}
    </Paper>
  );
}
