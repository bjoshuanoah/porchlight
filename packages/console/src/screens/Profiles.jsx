// Profiles (PORCH-135 ac-4 + ac-5): list, create, and edit profiles; the
// six whitelisted knobs render from the knob field model; schedule windows
// and camera scope are editable; activation is the manual profile switch.
// Below the profiles, the per-camera layer inspector (Base / Active
// profile / Effective & source) is built by the pure layers.js model.
import React, { useEffect, useState } from "react";
import Button from "@mui/material/Button";
import Chip from "@mui/material/Chip";
import Checkbox from "@mui/material/Checkbox";
import FormControlLabel from "@mui/material/FormControlLabel";
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
import ToggleButton from "@mui/material/ToggleButton";
import ToggleButtonGroup from "@mui/material/ToggleButtonGroup";
import Typography from "@mui/material/Typography";

import { buildKnobPatch, KNOB_FIELDS, KNOB_DEFAULTS } from "../profiles/knobs.js";
import { buildLayerTable } from "../profiles/layers.js";

const DAY_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function emptyProfile() {
  return { name: "", scope: "global", cameraId: "", knobs: {}, schedule: [] };
}

export default function Profiles({ camera, cameras, api }) {
  const [profiles, setProfiles] = useState([]);
  const [active, setActive] = useState(null);
  const [knobsPayload, setKnobsPayload] = useState(null);
  const [selected, setSelected] = useState(null); // draft being edited
  const [selectedId, setSelectedId] = useState(null);
  const [error, setError] = useState("");
  const [status, setStatus] = useState("");

  const cameraId = camera?.id ?? "";

  useEffect(() => {
    let cancelled = false;
    Promise.all([api.listProfiles(), api.getActive()])
      .then(([profileList, activeProfile]) => {
        if (cancelled) return;
        setProfiles(profileList ?? []);
        setActive(activeProfile ?? { profileId: null, source: null });
        setError("");
      })
      .catch((failure) => !cancelled && setError(failure.message));
    return () => {
      cancelled = true;
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps -- initial load

  useEffect(() => {
    if (!cameraId) {
      setKnobsPayload(null);
      return undefined;
    }
    let cancelled = false;
    api
      .getKnobs(cameraId)
      .then((payload) => !cancelled && setKnobsPayload(payload))
      .catch((failure) => !cancelled && setError(failure.message));
    return () => {
      cancelled = true;
    };
  }, [api, cameraId]); // eslint-disable-line react-hooks/exhaustive-deps -- camera id is the trigger

  async function refreshAll() {
    try {
      const [profileList, activeProfile, knobPayload] = await Promise.all([
        api.listProfiles(),
        api.getActive(),
        cameraId ? api.getKnobs(cameraId) : Promise.resolve(null),
      ]);
      setProfiles(profileList ?? []);
      setActive(activeProfile ?? { profileId: null, source: null });
      setKnobsPayload(knobPayload);
      setError("");
    } catch (failure) {
      setError(failure.message);
    }
  }

  function editProfile(profile) {
    setSelected({
      name: profile.name,
      scope: profile.scope,
      cameraId: profile.cameraId ?? "",
      knobs: { ...(profile.knobs ?? {}) },
      schedule: (profile.schedule ?? []).map((window) => ({ ...window })),
    });
    setSelectedId(profile.id);
  }

  async function saveProfile() {
    const body = {
      name: selected.name.trim(),
      scope: selected.scope,
      knobs: buildKnobPatch(selected.knobs),
    };
    if (selected.scope === "camera") body.cameraId = selected.cameraId;
    if (selected.schedule.length > 0) body.schedule = selected.schedule;
    try {
      await (selectedId ? api.updateProfile(selectedId, body) : api.createProfile(body));
      setSelected(null);
      setSelectedId(null);
      setStatus("Profile saved.");
      await refreshAll();
    } catch (failure) {
      setError(failure.message);
    }
  }

  async function activate(profile) {
    try {
      const changed = await api.activateProfile(profile.id);
      setStatus(changed?.activeProfileId === profile.id ? `Switched to "${profile.name}" (manual).` : "");
      await refreshAll();
    } catch (failure) {
      setError(failure.message);
    }
  }

  async function remove(profile) {
    try {
      await api.deleteProfile(profile.id);
      setStatus("Profile deleted.");
      await refreshAll();
    } catch (failure) {
      setError(failure.message);
    }
  }

  function setKnob(knob, value) {
    setSelected((current) => ({ ...current, knobs: { ...current.knobs, [knob]: value } }));
  }

  function setKnobInList(knob, option, present) {
    setSelected((current) => {
      const currentList = Array.isArray(current.knobs[knob]) ? current.knobs[knob] : [];
      const nextList = present ? [...new Set([...currentList, option])] : currentList.filter((item) => item !== option);
      return { ...current, knobs: { ...current.knobs, [knob]: nextList } };
    });
  }

  const rows = buildLayerTable({
    cameraId: cameraId || "",
    knobs: knobsPayload ?? undefined,
    profiles,
    active,
  });

  return (
    <Stack spacing={2}>
      {error && <Typography color="error">{error}</Typography>}
      {status && !error && <Typography color="text.secondary">{status}</Typography>}

      <Paper variant="outlined" sx={{ p: 2, display: "flex", flexWrap: "wrap", gap: 2, alignItems: "center" }}>
        <Typography variant="subtitle2" sx={{ mr: "auto" }}>
          Profiles ({profiles.length})
        </Typography>
        <Button
          variant="contained"
          startIcon={<AddIcon />}
          onClick={() => {
            setSelectedId(null);
            setSelected(emptyProfile());
          }}
        >
          New profile
        </Button>
      </Paper>

      {profiles.map((profile) => {
        const isActive = active?.profileId === profile.id;
        return (
          <Paper key={profile.id} variant="outlined" sx={{ p: 2 }}>
            <Stack direction="row" spacing={2} alignItems="center" sx={{ flexWrap: "wrap" }}>
              <Chip size="small" color={isActive ? "primary" : "default"} label={isActive ? "Active" : "Inactive"} />
              <Typography sx={{ fontWeight: 600 }}>{profile.name}</Typography>
              <Typography variant="body2" color="text.secondary">
                {profile.scope === "camera" ? `Camera: ${profile.cameraId}` : "Global"}
              </Typography>
              <Stack direction="row" spacing={1} sx={{ ml: "auto" }}>
                <Button size="small" onClick={() => editProfile(profile)}>
                  Edit
                </Button>
                <Button size="small" variant="outlined" onClick={() => activate(profile)} disabled={isActive}>
                  Activate
                </Button>
                <IconButton size="small" aria-label={`Delete ${profile.name}`} onClick={() => remove(profile)}>
                  <DeleteIcon fontSize="small" />
                </IconButton>
              </Stack>
            </Stack>
            <Stack direction="row" spacing={1} sx={{ flexWrap: "wrap", mt: 1 }}>
              {Object.entries(profile.knobs ?? {})
                .filter(([knob]) => KNOB_FIELDS.some((field) => field.knob === knob))
                .map(([knob, value]) => (
                  <Chip key={knob} size="small" variant="outlined" label={`${knob}: ${Array.isArray(value) ? value.join(", ") : String(value)}`} />
                ))}
              {(profile.schedule ?? []).map((timeWindow, index) => (
                <Chip
                  key={index}
                  size="small"
                  variant="outlined"
                  label={`/schedule ${timeWindow.start}–${timeWindow.end}${timeWindow.days ? ` (days ${timeWindow.days.join(",")})` : ""}`}
                />
              ))}
            </Stack>
          </Paper>
        );
      })}

      {selected && (
        <Paper variant="outlined" sx={{ p: 2 }}>
          <Typography variant="subtitle2">{selectedId ? "Edit profile" : "New profile"}</Typography>
          <Stack spacing={2} sx={{ mt: 1 }}>
            <Stack direction="row" spacing={2} sx={{ flexWrap: "wrap" }}>
              <TextField
                label="Profile name"
                size="small"
                value={selected.name}
                onChange={(event) => setSelected({ ...selected, name: event.target.value })}
                sx={{ minWidth: 220 }}
              />
              <TextField
                select
                label="Scope"
                size="small"
                value={selected.scope}
                onChange={(event) => setSelected({ ...selected, scope: event.target.value })}
                sx={{ minWidth: 140 }}
              >
                <MenuItem value="global">Global</MenuItem>
                <MenuItem value="camera">Camera</MenuItem>
              </TextField>
              {selected.scope === "camera" && (
                <TextField
                  select
                  label="Camera"
                  size="small"
                  value={selected.cameraId}
                  onChange={(event) => setSelected({ ...selected, cameraId: event.target.value })}
                  sx={{ minWidth: 200 }}
                >
                  {cameras.map((candidate) => (
                    <MenuItem key={candidate.id} value={candidate.id}>
                      {candidate.name || candidate.id}
                    </MenuItem>
                  ))}
                  {camera && !cameras.some((candidate) => candidate.id === camera.id) && (
                    <MenuItem value={camera.id}>{camera.name || camera.id}</MenuItem>
                  )}
                </TextField>
              )}
            </Stack>

            <Stack spacing={2}>
              {KNOB_FIELDS.map((field) => {
                // Chip lists start empty when the profile does not set the
                // knob; selects and toggles fall back to the knob default.
                const value = selected.knobs[field.knob]
                  ?? (field.kind === "chips" ? [] : KNOB_DEFAULTS[field.knob]);
                if (field.kind === "select") {
                  return (
                    <TextField
                      key={field.knob}
                      select
                      size="small"
                      label={field.label}
                      value={value}
                      onChange={(event) => setKnob(field.knob, event.target.value)}
                      sx={{ minWidth: 220, alignSelf: "flex-start" }}
                    >
                      {field.options.map((option) => (
                        <MenuItem key={option} value={option}>
                          {option}
                        </MenuItem>
                      ))}
                    </TextField>
                  );
                }
                if (field.kind === "toggle") {
                  return (
                    <FormControlLabel
                      key={field.knob}
                      control={<Checkbox checked={Boolean(value)} onChange={(event) => setKnob(field.knob, event.target.checked)} />}
                      label={field.label}
                      sx={{ alignSelf: "flex-start" }}
                    />
                  );
                }
                return (
                  <Stack key={field.knob} spacing={0.5} sx={{ alignSelf: "flex-start" }}>
                    <Typography variant="body2">{field.label}</Typography>
                    <ToggleButtonGroup size="small">
                      {field.options.map((option) => (
                        <ToggleButton
                          key={option}
                          value={option}
                          selected={Array.isArray(value) && value.includes(option)}
                          onClick={() => setKnobInList(field.knob, option, !(Array.isArray(value) && value.includes(option)))}
                        >
                          {option}
                        </ToggleButton>
                      ))}
                    </ToggleButtonGroup>
                  </Stack>
                );
              })}
            </Stack>

            <Stack spacing={1}>
              <Typography variant="body2">Schedule windows</Typography>
              {selected.schedule.map((timeWindow, index) => (
                <Stack key={index} direction="row" spacing={1} alignItems="center" sx={{ flexWrap: "wrap" }}>
                  <TextField
                    size="small"
                    label="Start (HH:MM)"
                    value={timeWindow.start ?? ""}
                    onChange={(event) =>
                      setSelected((current) => ({
                        ...current,
                        schedule: current.schedule.map((entry, i) => (i === index ? { ...entry, start: event.target.value } : entry)),
                      }))
                    }
                    sx={{ width: 150 }}
                  />
                  <TextField
                    size="small"
                    label="End (HH:MM)"
                    value={timeWindow.end ?? ""}
                    onChange={(event) =>
                      setSelected((current) => ({
                        ...current,
                        schedule: current.schedule.map((entry, i) => (i === index ? { ...entry, end: event.target.value } : entry)),
                      }))
                    }
                    sx={{ width: 150 }}
                  />
                  <ToggleButtonGroup size="small">
                    {DAY_LABELS.map((day, dayIndex) => (
                      <ToggleButton
                        key={day}
                        value={day}
                        selected={(timeWindow.days ?? []).includes(dayIndex)}
                        onClick={() =>
                          setSelected((current) => {
                            const days = (timeWindow.days ?? []).includes(dayIndex)
                              ? (timeWindow.days ?? []).filter((entry) => entry !== dayIndex)
                              : [...(timeWindow.days ?? []), dayIndex].sort((a, b) => a - b);
                            return {
                              ...current,
                              schedule: current.schedule.map((entry, i) => (i === index ? { ...entry, days } : entry)),
                            };
                          })
                        }
                      >
                        {day}
                      </ToggleButton>
                    ))}
                  </ToggleButtonGroup>
                  <IconButton
                    size="small"
                    aria-label="Remove schedule window"
                    onClick={() => setSelected((current) => ({ ...current, schedule: current.schedule.filter((_, i) => i !== index) }))}
                  >
                    <DeleteIcon fontSize="small" />
                  </IconButton>
                </Stack>
              ))}
              <Button
                size="small"
                startIcon={<AddIcon />}
                onClick={() => setSelected((current) => ({ ...current, schedule: [...current.schedule, { start: "", end: "", days: [] }] }))}
              >
                Add window
              </Button>
            </Stack>

            <Stack direction="row" spacing={2}>
              <Button variant="contained" onClick={saveProfile} disabled={!selected.name.trim()}>
                Save profile
              </Button>
              <Button onClick={() => { setSelected(null); setSelectedId(null); }}>Cancel</Button>
            </Stack>
          </Stack>
        </Paper>
      )}

      <Paper variant="outlined" sx={{ p: 2 }}>
        <Typography variant="subtitle2">
          Layer inspector — {camera ? `${camera.name || camera.id}` : "select a camera"}
        </Typography>
        <Typography variant="body2" color="text.secondary" sx={{ mb: 1 }}>
          Effective = base → active profile → resolved, per knob. A camera-scoped profile covers only its camera.
        </Typography>
        <TableContainer>
          <Table size="small">
            <TableHead>
              <TableRow>
                <TableCell>Knob</TableCell>
                <TableCell>Base</TableCell>
                <TableCell>Active profile</TableCell>
                <TableCell>Effective &amp; source</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {rows.map((row) => {
                const field = KNOB_FIELDS.find((candidate) => candidate.knob === row.knob);
                return (
                  <TableRow key={row.knob}>
                    <TableCell>{field?.label ?? row.knob}</TableCell>
                    <TableCell>{renderValue(row.base.value, row.base.set)}</TableCell>
                    <TableCell>
                      {row.profile.set
                        ? `${renderValue(row.profile.value)} · ${row.profile.name ?? ""}${row.profile.applied ? "" : " (not applied to this camera — camera scope)"}`
                        : "—"}
                    </TableCell>
                    <TableCell>
                      {renderValue(row.effective)}{" "}
                      <Typography component="span" variant="caption" color="text.secondary">
                        (source: {row.source}{row.profileId ? ` · ${row.profileId}` : ""})
                      </Typography>
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </TableContainer>
      </Paper>
    </Stack>
  );
}

function renderValue(value, set = true) {
  if (!set || value === undefined) return "unset";
  if (Array.isArray(value)) return value.join(", ") || "(none)";
  if (typeof value === "boolean") return value ? "on" : "off";
  return String(value);
}
