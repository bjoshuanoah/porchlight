// Transcripts (PORCH-155): the transcription plane settings surface —
// the method doc of record across its three scopes (global, per recording
// type, per camera) with the layer-visibility pattern, a per-camera/type
// inspector naming the winning layer, the stage's never-silent status
// (providers, embedder, cadence), semantic search over the stored
// transcripts, and the cascade audit line. Polls the status every 5
// seconds so degradations surface without a manual refresh. Drafts stay
// separate from the wire doc so a poll never clobbers what the user is
// editing; loading is never an error, and every service refusal surfaces
// its plain language verbatim.
import React, { useEffect, useRef, useState } from "react";
import Alert from "@mui/material/Alert";
import Button from "@mui/material/Button";
import Chip from "@mui/material/Chip";
import MenuItem from "@mui/material/MenuItem";
import Paper from "@mui/material/Paper";
import Stack from "@mui/material/Stack";
import TextField from "@mui/material/TextField";
import Typography from "@mui/material/Typography";

import {
  METHOD_CLASSES,
  METHOD_LABELS,
  SOURCE_LABELS,
  SOURCE_LAYERS,
  emptyMethodDoc,
  normalizeMethodForm,
  stateChipFor,
} from "../transcripts/model.js";

// Chip colors for the model's closed severities (same mapping as Compute).
const CHIP_COLOR = {
  neutral: "default",
  warning: "warning",
  error: "error",
  muted: "default",
};

// The winning-layer sentence per inspect source (layer-visibility law).
const WIN_SENTENCE = {
  camera: `${SOURCE_LAYERS.camera} wins over the recording-type and global layers.`,
  "recording-type": `${SOURCE_LAYERS["recording-type"]} wins over the global layer.`,
  global: `${SOURCE_LAYERS.global} applies — no camera override or per-recording-type method is set.`,
};

const RECORD_TYPES = Object.freeze(["rolling", "event"]);

export default function Transcripts({ api }) {
  // --- method scopes card ---------------------------------------------------
  // Draft (form strings; "" = inherit) kept separate from the wire doc.
  const [draft, setDraft] = useState(emptyMethodDraft());
  const [methodLoaded, setMethodLoaded] = useState(false);
  const [methodError, setMethodError] = useState("");
  const [saveNote, setSaveNote] = useState(null); // { ok, text }
  const [busySave, setBusySave] = useState(false);
  const cameraKey = useRef(0); // stable row ids for the override draft rows

  // --- inspect card ----------------------------------------------------------
  const [inspectCameraId, setInspectCameraId] = useState("");
  const [inspectType, setInspectType] = useState("rolling");
  const [inspectResult, setInspectResult] = useState(null);
  const [inspectError, setInspectError] = useState("");
  const [busyInspect, setBusyInspect] = useState(false);

  // --- status card (the 5-second poll) ----------------------------------------
  const [status, setStatus] = useState(null);
  const [statusError, setStatusError] = useState("");
  const [statusLoading, setStatusLoading] = useState(true);

  // --- search card ------------------------------------------------------------
  const [query, setQuery] = useState("");
  const [searchSourceType, setSearchSourceType] = useState("any");
  const [searchCameraId, setSearchCameraId] = useState("");
  const [results, setResults] = useState(null);
  const [searchError, setSearchError] = useState("");
  const [busySearch, setBusySearch] = useState(false);

  // --- cascade audit line -----------------------------------------------------
  const [audit, setAudit] = useState(null);

  useEffect(() => {
    let timer;
    refreshStatus();
    timer = setInterval(refreshStatus, 5000);
    return () => clearInterval(timer);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps -- poll on mount, cleaned up on unmount

  useEffect(() => {
    refreshMethod();
    refreshAudit();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps -- load once on mount

  async function refreshStatus() {
    try {
      setStatus(await api.getTranscriptionStatus());
      setStatusError("");
      setStatusLoading(false);
    } catch (failure) {
      // A poll that fails surfaces the service's words; loading is not failure.
      setStatusLoading(false);
      setStatusError(failure.message);
    }
  }

  async function refreshMethod() {
    try {
      const doc = await api.getTranscriptionMethod();
      setDraft(draftFrom(doc));
      setMethodLoaded(true);
      setMethodError("");
    } catch (failure) {
      setMethodLoaded(true); // loading is not failure; the words render verbatim
      setMethodError(failure.message);
    }
  }

  async function refreshAudit() {
    try {
      setAudit(await api.transcriptCascadeAudit());
    } catch {
      setAudit(null); // the audit line stays out when the plane refuses
    }
  }

  function draftFrom(doc) {
    const cameras = Object.entries(doc?.cameras ?? {}).map(([cameraId, method]) => ({
      key: ++cameraKey.current,
      cameraId,
      method: method ?? "",
    }));
    return {
      global: doc?.global ?? "",
      rolling: doc?.recordingTypes?.rolling ?? "",
      event: doc?.recordingTypes?.event ?? "",
      cameras,
    };
  }

  function setDraftField(field, value) {
    setDraft((current) => ({ ...current, [field]: value }));
  }

  function setDraftCamera(key, field, value) {
    setDraft((current) => ({
      ...current,
      cameras: current.cameras.map((row) => (row.key === key ? { ...row, [field]: value } : row)),
    }));
  }

  function addCamera() {
    setDraft((current) => ({ ...current, cameras: [...current.cameras, { key: ++cameraKey.current, cameraId: "", method: METHOD_CLASSES[0] }] }));
  }

  function removeCamera(key) {
    setDraft((current) => ({ ...current, cameras: current.cameras.filter((row) => row.key !== key) }));
  }

  function methodBody() {
    // Rows missing a camera id or method are simply not overrides — the
    // helper text says so; nothing is invented on the save path.
    return normalizeMethodForm({
      global: draft.global,
      recordingTypes: { rolling: draft.rolling, event: draft.event },
      cameras: Object.fromEntries(draft.cameras.filter((row) => row.cameraId.trim() && row.method).map((row) => [row.cameraId, row.method])),
    });
  }

  async function saveMethod() {
    setBusySave(true);
    setSaveNote(null);
    try {
      const payload = await api.putTranscriptionMethod(methodBody());
      setDraft(draftFrom(payload?.method));
      setSaveNote({ ok: true, text: "Transcription method saved." });
      setMethodError("");
      refreshMethod();
    } catch (failure) {
      // The service's plain-language 422 verbatim — kept until the next action.
      setSaveNote({ ok: false, text: failure.message });
    } finally {
      setBusySave(false);
    }
  }

  async function runInspect() {
    setBusyInspect(true);
    setInspectError("");
    try {
      setInspectResult(await api.inspectTranscriptionMethod(inspectCameraId.trim(), inspectType));
    } catch (failure) {
      setInspectResult(null);
      setInspectError(failure.message);
    } finally {
      setBusyInspect(false);
    }
  }

  async function runSearch() {
    setBusySearch(true);
    setSearchError("");
    try {
      const payload = await api.searchTranscripts({
        query: query.trim(),
        sourceType: searchSourceType === "any" ? undefined : searchSourceType,
        cameraId: searchCameraId.trim() === "" ? undefined : searchCameraId.trim(),
      });
      setResults(payload?.results ?? []);
    } catch (failure) {
      setResults(null);
      setSearchError(failure.message);
    } finally {
      setBusySearch(false);
    }
  }

  return (
    <Stack spacing={2}>
      {/* Method scopes card */}
      <Paper variant="outlined" sx={{ p: 2 }}>
        <Stack spacing={1}>
          <Typography variant="subtitle1" sx={{ mr: "auto" }}>
            Transcription method
          </Typography>
          {methodError && (
            <Stack direction="row" spacing={2} alignItems="center">
              <Typography color="error" sx={{ mr: "auto" }}>
                {methodError}
              </Typography>
              <Button size="small" variant="outlined" onClick={refreshMethod}>
                Retry
              </Button>
            </Stack>
          )}
          {methodLoaded && (
            <Stack spacing={1}>
              <Stack direction="row" spacing={2} useFlexGap sx={{ flexWrap: "wrap" }}>
                <TextField
                  select
                  size="small"
                  label="Global method"
                  value={draft.global}
                  onChange={(event) => setDraftField("global", event.target.value)}
                  sx={{ minWidth: 240 }}
                >
                  <MenuItem value="">
                    <em>inherit the built-in default</em>
                  </MenuItem>
                  {METHOD_CLASSES.map((method) => (
                    <MenuItem key={method} value={method}>
                      {METHOD_LABELS[method] ?? method}
                    </MenuItem>
                  ))}
                </TextField>
                {RECORD_TYPES.map((type) => (
                  <TextField
                    key={type}
                    select
                    size="small"
                    label={`${SOURCE_LABELS[type]} method`}
                    value={draft[type]}
                    onChange={(event) => setDraftField(type, event.target.value)}
                    sx={{ minWidth: 220 }}
                  >
                    <MenuItem value="">
                      <em>inherit the global method</em>
                    </MenuItem>
                    {METHOD_CLASSES.map((method) => (
                      <MenuItem key={method} value={method}>
                        {METHOD_LABELS[method] ?? method}
                      </MenuItem>
                    ))}
                  </TextField>
                ))}
              </Stack>

              <Typography variant="body2" color="text.secondary">
                Camera overrides win over the recording-type scopes; recording types win over the global method. A blank scope inherits the layer above it.
              </Typography>

              {draft.cameras.map((row) => (
                <Stack key={row.key} direction="row" spacing={2} alignItems="center" useFlexGap sx={{ flexWrap: "wrap" }}>
                  <TextField
                    size="small"
                    label="Camera id"
                    value={row.cameraId}
                    onChange={(event) => setDraftCamera(row.key, "cameraId", event.target.value)}
                    sx={{ minWidth: 180 }}
                  />
                  <TextField
                    select
                    size="small"
                    label="Method"
                    value={row.method}
                    onChange={(event) => setDraftCamera(row.key, "method", event.target.value)}
                    sx={{ minWidth: 220 }}
                  >
                    {METHOD_CLASSES.map((method) => (
                      <MenuItem key={method} value={method}>
                        {METHOD_LABELS[method] ?? method}
                      </MenuItem>
                    ))}
                  </TextField>
                  <Button size="small" onClick={() => removeCamera(row.key)}>
                    Remove
                  </Button>
                </Stack>
              ))}

              <Stack direction="row" spacing={2} alignItems="center" useFlexGap sx={{ flexWrap: "wrap" }}>
                <Button size="small" variant="outlined" onClick={addCamera}>
                  Add camera override
                </Button>
                <Button variant="contained" disabled={busySave} onClick={saveMethod}>
                  {busySave ? "Saving…" : "Save method"}
                </Button>
              </Stack>
              {saveNote && <Alert severity={saveNote.ok ? "success" : "warning"}>{saveNote.text}</Alert>}
            </Stack>
          )}
        </Stack>
      </Paper>

      {/* Inspect card */}
      <Paper variant="outlined" sx={{ p: 2 }}>
        <Stack spacing={1}>
          <Typography variant="subtitle1" sx={{ mr: "auto" }}>
            Inspect a camera
          </Typography>
          <Stack direction="row" spacing={2} alignItems="center" useFlexGap sx={{ flexWrap: "wrap" }}>
            <TextField
              size="small"
              label="Camera id"
              value={inspectCameraId}
              onChange={(event) => setInspectCameraId(event.target.value)}
              sx={{ minWidth: 180 }}
            />
            <TextField
              select
              size="small"
              label="Recording type"
              value={inspectType}
              onChange={(event) => setInspectType(event.target.value)}
              sx={{ minWidth: 200 }}
            >
              {RECORD_TYPES.map((type) => (
                <MenuItem key={type} value={type}>
                  {SOURCE_LABELS[type]}
                </MenuItem>
              ))}
            </TextField>
            <Button variant="outlined" disabled={busyInspect || inspectCameraId.trim() === ""} onClick={runInspect}>
              {busyInspect ? "Inspecting…" : "Inspect"}
            </Button>
          </Stack>
          {inspectError && (
            <Typography color="error">{inspectError}</Typography>
          )}
          {inspectResult && (
            <Stack spacing={1}>
              <Stack direction="row" spacing={1} alignItems="center" useFlexGap sx={{ flexWrap: "wrap" }}>
                <Typography>{METHOD_LABELS[inspectResult.method] ?? inspectResult.method}</Typography>
                <Chip size="small" label={SOURCE_LAYERS[inspectResult.source] ?? inspectResult.source} variant="outlined" />
              </Stack>
              <Typography variant="body2" color="text.secondary">
                {WIN_SENTENCE[inspectResult.source]}
                {inspectResult.source === "global" && inspectResult.layers?.builtIn
                  ? ` With nothing set, the built-in ${METHOD_LABELS[inspectResult.layers.builtIn] ?? inspectResult.layers.builtIn} is the floor of record.`
                  : ""}
              </Typography>
            </Stack>
          )}
        </Stack>
      </Paper>

      {/* Status card */}
      <Paper variant="outlined" sx={{ p: 2 }}>
        <Stack spacing={1}>
          <Stack direction="row" spacing={2} alignItems="center">
            <Typography variant="subtitle1" sx={{ mr: "auto" }}>
              Transcription status
            </Typography>
            <Button size="small" variant="outlined" onClick={refreshStatus}>
              Refresh
            </Button>
          </Stack>
          {statusError && (
            <Stack direction="row" spacing={2} alignItems="center">
              <Typography color="error" sx={{ mr: "auto" }}>
                {statusError}
              </Typography>
              <Button size="small" variant="outlined" onClick={refreshStatus}>
                Retry
              </Button>
            </Stack>
          )}
          {status && (
            <Stack spacing={1}>
              <Stack direction="row" spacing={1} alignItems="center" useFlexGap sx={{ flexWrap: "wrap" }}>
                <Chip
                  size="small"
                  color={status.state === "native" ? "success" : "error"}
                  label={status.state}
                />
                {status.reason && <Typography variant="body2">{status.reason}</Typography>}
              </Stack>
              {(status.provider ?? []).map((provider, index) => (
                <Stack key={provider.method ?? index} direction="row" spacing={1} alignItems="center" useFlexGap sx={{ flexWrap: "wrap" }}>
                  <Typography variant="body2">{METHOD_LABELS[provider.method] ?? provider.method ?? "unknown method"}</Typography>
                  {provider.name && <Chip size="small" variant="outlined" label={provider.name} />}
                  {provider.state && <Chip size="small" color={provider.state === "native" ? "success" : "warning"} label={provider.state} />}
                  {provider.reason && <Typography variant="body2" color="text.secondary">{provider.reason}</Typography>}
                </Stack>
              ))}
              <EmbedderRow embedder={status.embedder} />
              <CadenceRow cadence={status.cadence} />
            </Stack>
          )}
          {!status && !statusError && statusLoading && (
            <Typography color="text.secondary">Loading transcription status…</Typography>
          )}
        </Stack>
      </Paper>

      {/* Search card */}
      <Paper variant="outlined" sx={{ p: 2 }}>
        <Stack spacing={1}>
          <Typography variant="subtitle1" sx={{ mr: "auto" }}>
            Search transcripts
          </Typography>
          <Stack direction="row" spacing={2} alignItems="center" useFlexGap sx={{ flexWrap: "wrap" }}>
            <TextField
              size="small"
              label="Spoken phrase"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              helperText="A spoken phrase or its paraphrase."
              sx={{ minWidth: 320, "& .MuiFormHelperText-root": { whiteSpace: "nowrap" } }}
            />
            <TextField
              select
              size="small"
              label="Recording type"
              value={searchSourceType}
              onChange={(event) => setSearchSourceType(event.target.value)}
              sx={{ minWidth: 180 }}
            >
              <MenuItem value="any">Any</MenuItem>
              {RECORD_TYPES.map((type) => (
                <MenuItem key={type} value={type}>
                  {SOURCE_LABELS[type]}
                </MenuItem>
              ))}
            </TextField>
            <TextField
              size="small"
              label="Camera id (optional)"
              value={searchCameraId}
              onChange={(event) => setSearchCameraId(event.target.value)}
              sx={{ minWidth: 180 }}
            />
            <Button variant="contained" disabled={busySearch || query.trim() === ""} onClick={runSearch}>
              {busySearch ? "Searching…" : "Search"}
            </Button>
          </Stack>
          {searchError && (
            <Typography color="error">{searchError}</Typography>
          )}
          {results !== null && results.length === 0 && (
            <Typography color="text.secondary">No transcript matched that phrase.</Typography>
          )}
          {(results ?? []).map((result, index) => {
            const chip = stateChipFor(result);
            return (
              <Paper key={result.sourceRef ?? index} variant="outlined" sx={{ p: 1.5 }}>
                <Stack spacing={0.5}>
                  <Stack direction="row" spacing={1} alignItems="center" useFlexGap sx={{ flexWrap: "wrap" }}>
                    <Chip
                      size="small"
                      color={CHIP_COLOR[chip.severity]}
                      variant={chip.severity === "warning" ? "filled" : "outlined"}
                      label={chip.label}
                    />
                    <Chip size="small" variant="outlined" label={`${SOURCE_LABELS[result.sourceType] ?? result.sourceType} · ${result.cameraId}`} />
                    <Typography variant="body2" sx={{ mr: "auto" }}>
                      score {result.score}
                    </Typography>
                    {result.timeline?.path && (
                      <a href={result.timeline.path}>{result.timeline.label ?? result.timeline.path}</a>
                    )}
                  </Stack>
                  {result.text && <Typography variant="body2">“{result.text}”</Typography>}
                </Stack>
              </Paper>
            );
          })}
        </Stack>
      </Paper>

      {/* Cascade audit line */}
      {audit && (
        <Typography variant="body2" color="text.secondary">
          {auditLine(audit)}
        </Typography>
      )}
    </Stack>
  );
}

/** The embedder's never-silent posture; not-provisioned states its reason. */
function EmbedderRow({ embedder }) {
  if (!embedder) {
    return (
      <Typography variant="body2" color="text.secondary">
        Embedder: the stage is not reporting an embedder posture.
      </Typography>
    );
  }
  const chip = {
    "not-provisioned": { severity: "neutral", label: "not provisioned" },
    native: { severity: "neutral", label: embedder.state },
    degraded: { severity: "error", label: embedder.state },
    failed: { severity: "error", label: embedder.state },
  }[embedder.state] ?? { severity: "muted", label: embedder.state ?? "unknown state" };
  return (
    <Stack direction="row" spacing={1} alignItems="center" useFlexGap sx={{ flexWrap: "wrap" }}>
      <Typography variant="body2">Embedder</Typography>
      <Chip size="small" variant={chip.severity === "neutral" ? "outlined" : "filled"} color={CHIP_COLOR[chip.severity]} label={chip.label} />
      {embedder.reason && <Typography variant="body2" color="text.secondary">{embedder.reason}</Typography>}
    </Stack>
  );
}

/** The rolling-cadence line: windows completed vs started, the last window
 * against the budget of record, and the overrun count when it isn't zero. */
function CadenceRow({ cadence }) {
  if (!cadence) return null;
  const last = typeof cadence.lastWindowMs === "number" ? `${cadence.lastWindowMs} ms` : "—";
  const budget = typeof cadence.budgetMs === "number" ? `${cadence.budgetMs} ms` : "—";
  return (
    <Stack direction="row" spacing={1} alignItems="center" useFlexGap sx={{ flexWrap: "wrap" }}>
      <Typography variant="body2">
        Windows completed {cadence.windowsCompleted} of {cadence.windowsStarted} started · last window {last} against a {budget} budget
      </Typography>
      {(cadence.budgetOverruns ?? 0) > 0 && <Chip size="small" color="warning" label={`${cadence.budgetOverruns} budget overrun(s)`} />}
    </Stack>
  );
}

/** One line, countable: the orphan posture is stated even at zero. */
function auditLine(audit) {
  const orphans = audit.orphanVectors === 0
    ? "no orphan vector payloads"
    : `${audit.orphanVectors} orphan vector payload(s) — the retention cascade needs a sweep`;
  const vectorless = audit.vectorlessRecords === 0 ? "" : `; ${audit.vectorlessRecords} text chunk(s) have no vector`;
  return `Cascade audit: ${audit.transcriptRecords} transcript record(s) over ${audit.textChunks} text chunk(s), ${audit.vectorPayloads} vector payload(s) — ${orphans}${vectorless}.`;
}
