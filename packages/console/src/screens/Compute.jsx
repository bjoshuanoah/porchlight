// Compute (PORCH-152): the Models/Compute settings surface — per-stage
// provider plan of record (providerClass, model, endpointRef) with the
// admin/setup/built-in source layer shown for every stage, the live status
// each stage reports (never silent: reasons render verbatim), and a reset
// to the layered default. Polls the stages every 5 seconds so CPU
// fallbacks and degradations surface without a manual refresh. Loading is
// never an error, and the service's plain-language 422s surface verbatim.
import React, { useEffect, useState } from "react";
import Alert from "@mui/material/Alert";
import Button from "@mui/material/Button";
import Chip from "@mui/material/Chip";
import MenuItem from "@mui/material/MenuItem";
import Paper from "@mui/material/Paper";
import Stack from "@mui/material/Stack";
import TextField from "@mui/material/TextField";
import Typography from "@mui/material/Typography";

import { ENDPOINT_CLASSES, PROVIDER_CLASSES, stageLabel, statusChipFor, sourceLabel } from "../compute/model.js";

// Chip colors for the closed status states.
const CHIP_COLOR = {
  neutral: "default",
  warning: "warning",
  error: "error",
  muted: "default",
};

export default function Compute({ api }) {
  const [stages, setStages] = useState([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  // Draft plan per stage: stage → { providerClass, model, endpointRef }
  // (model/endpointRef are strings; an empty model means null — "model
  // provisioned by the product's own setup"). Kept separate from the
  // server list so a 5s poll never clobbers what the user is editing.
  const [drafts, setDrafts] = useState({});
  const [busyStage, setBusyStage] = useState("");
  const [notes, setNotes] = useState({}); // stage → { ok, text } — the server's own words until the next action

  useEffect(() => {
    let timer;
    refresh();
    timer = setInterval(refresh, 5000);
    return () => clearInterval(timer);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps -- load + poll on mount, cleaned up on unmount

  async function refresh() {
    try {
      const payload = await api.getComputeStages();
      const list = payload?.stages ?? [];
      setStages(list);
      setLoadError("");
      // Only seed drafts for stages the user hasn't touched yet.
      setDrafts((current) => {
        const next = { ...current };
        for (const detail of list) {
          if (!next[detail.stage]) next[detail.stage] = draftFrom(detail);
        }
        return next;
      });
      // First arrival clears the initial loading card; later polls keep it off.
      setLoading(false);
    } catch (failure) {
      // A poll that fails surfaces the service's words; loading is not failure.
      setLoading(false);
      setLoadError(failure.message);
    }
  }

  function draftFrom(detail) {
    const effective = detail?.effective ?? {};
    return {
      providerClass: effective.providerClass ?? PROVIDER_CLASSES[0],
      model: effective.model ?? "",
      endpointRef: effective.endpointRef ?? "",
    };
  }

  function setDraft(stage, field, value) {
    setDrafts((current) => ({ ...current, [stage]: { ...current[stage], [field]: value } }));
  }

  function planBody(stage) {
    const draft = drafts[stage];
    const body = { providerClass: draft.providerClass, model: draft.model.trim() || null };
    if (ENDPOINT_CLASSES.includes(draft.providerClass)) {
      body.endpointRef = draft.endpointRef.trim();
    }
    return body;
  }

  async function save(stage) {
    setBusyStage(stage);
    setNotes((current) => ({ ...current, [stage]: null }));
    try {
      const detail = await api.setComputeStage(stage, planBody(stage));
      applyDetail(detail);
      setNotes((current) => ({ ...current, [stage]: { ok: true, text: `${stageLabel(stage)} plan saved.` } }));
      setLoadError("");
      refresh();
    } catch (failure) {
      // The service's plain-language 422 verbatim — kept until the next action.
      setNotes((current) => ({ ...current, [stage]: { ok: false, text: failure.message } }));
    } finally {
      setBusyStage("");
    }
  }

  async function reset(stage) {
    setBusyStage(stage);
    setNotes((current) => ({ ...current, [stage]: null }));
    try {
      const detail = await api.resetComputeStage(stage);
      applyDetail(detail);
      setNotes((current) => ({ ...current, [stage]: { ok: true, text: `${stageLabel(stage)} reset to the default plan.` } }));
      setLoadError("");
      refresh();
    } catch (failure) {
      setNotes((current) => ({ ...current, [stage]: { ok: false, text: failure.message } }));
    } finally {
      setBusyStage("");
    }
  }

  function applyDetail(detail) {
    if (!detail?.stage) return;
    setStages((current) => current.map((entry) => (entry.stage === detail.stage ? detail : entry)));
    setDrafts((current) => ({ ...current, [detail.stage]: draftFrom(detail) }));
  }

  if (loading && stages.length === 0 && !loadError) {
    return <Typography color="text.secondary">Loading compute stages…</Typography>;
  }

  return (
    <Stack spacing={2}>
      {loadError && (
        <Stack direction="row" spacing={2} alignItems="center">
          <Typography color="error" sx={{ mr: "auto" }}>
            {loadError}
          </Typography>
          <Button variant="outlined" onClick={refresh}>
            Retry
          </Button>
        </Stack>
      )}

      <Stack direction="row" spacing={2} alignItems="center">
        <Typography variant="subtitle2" sx={{ mr: "auto" }}>
          Compute stages
        </Typography>
        <Button size="small" variant="outlined" onClick={refresh}>
          Refresh
        </Button>
      </Stack>

      {stages.map((detail) => (
        <StageCard
          key={detail.stage}
          detail={detail}
          draft={drafts[detail.stage]}
          busy={busyStage === detail.stage}
          note={notes[detail.stage]}
          onDraft={(field, value) => setDraft(detail.stage, field, value)}
          onSave={() => save(detail.stage)}
          onReset={() => reset(detail.stage)}
        />
      ))}
    </Stack>
  );
}

function StageCard({ detail, draft, busy, note, onDraft, onSave, onReset }) {
  const status = statusChipFor(detail?.status);
  const endpointClass = ENDPOINT_CLASSES.includes(draft.providerClass);

  return (
    <Paper variant="outlined" sx={{ p: 2 }}>
      <Stack spacing={1}>
        <Stack direction="row" spacing={1} alignItems="center" useFlexGap sx={{ flexWrap: "wrap" }}>
          <Typography variant="subtitle1" sx={{ mr: "auto" }}>
            {stageLabel(detail.stage)}
          </Typography>
          <Chip size="small" label={sourceLabel(detail.source)} variant="outlined" />
          <Chip size="small" color={CHIP_COLOR[status.severity]} variant={status.severity === "muted" ? "outlined" : "filled"} label={status.label} />
        </Stack>

        {status.reason && (
          <Typography variant="body2" color="text.secondary">
            {status.reason}
          </Typography>
        )}

        {(detail.layerIssues ?? []).map((issue, index) => (
          <Alert key={index} severity="warning">
            {issue}
          </Alert>
        ))}

        <Stack direction="row" spacing={2} useFlexGap sx={{ flexWrap: "wrap" }}>
          <TextField
            select
            size="small"
            label="Provider class"
            value={draft.providerClass}
            onChange={(event) => onDraft("providerClass", event.target.value)}
            sx={{ minWidth: 170 }}
          >
            {PROVIDER_CLASSES.map((providerClass) => (
              <MenuItem key={providerClass} value={providerClass}>
                {providerClass}
              </MenuItem>
            ))}
          </TextField>
          <TextField
            size="small"
            label="Model"
            value={draft.model}
            onChange={(event) => onDraft("model", event.target.value)}
            helperText="Empty uses the model provisioned by the product's own setup."
            sx={{ minWidth: 240, "& .MuiFormHelperText-root": { whiteSpace: "nowrap" } }}
          />
          <TextField
            size="small"
            label="Endpoint reference"
            value={draft.endpointRef}
            disabled={!endpointClass}
            onChange={(event) => onDraft("endpointRef", event.target.value)}
            helperText={endpointClass ? "Where this stage's endpoint is configured." : "Only endpoint classes take an endpoint reference."}
            sx={{ minWidth: 260, "& .MuiFormHelperText-root": { whiteSpace: "nowrap" } }}
          />
        </Stack>

        {note && (
          <Typography color={note.ok ? "text.secondary" : "error"}>
            {note.text}
          </Typography>
        )}

        <Stack direction="row" spacing={1} alignItems="center">
          <Button size="small" variant="contained" onClick={onSave} disabled={busy}>
            Save
          </Button>
          <Button size="small" variant="outlined" onClick={onReset} disabled={busy}>
            Reset to default
          </Button>
        </Stack>
      </Stack>
    </Paper>
  );
}
