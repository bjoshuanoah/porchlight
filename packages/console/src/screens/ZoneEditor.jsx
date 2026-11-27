// Camera editor (PORCH-135 ac-1): draws zone and mask polygons over the
// camera snapshot. Coordinates are kept in percent frame units end to end —
// the snapshot is only where the percents get picked, so a saved polygon
// covers the same fraction of the frame at any stream resolution.
import React, { useCallback, useEffect, useRef, useState } from "react";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Chip from "@mui/material/Chip";
import DeleteIcon from "@mui/icons-material/Delete";
import FormControlLabel from "@mui/material/FormControlLabel";
import IconButton from "@mui/material/IconButton";
import List from "@mui/material/List";
import ListItem from "@mui/material/ListItem";
import ListItemText from "@mui/material/ListItemText";
import Paper from "@mui/material/Paper";
import Stack from "@mui/material/Stack";
import Switch from "@mui/material/Switch";
import TextField from "@mui/material/TextField";
import ToggleButton from "@mui/material/ToggleButton";
import ToggleButtonGroup from "@mui/material/ToggleButtonGroup";
import Typography from "@mui/material/Typography";

import { clampPercent, dragVertex, pointDistance } from "../editor/geometry.js";

const STROKE = { zone: "#2E7D32", mask: "#C62828" };
const FILL = { zone: "rgba(46,125,50,0.30)", mask: "rgba(198,40,40,0.25)" };
// Clicking within this percent distance of the first vertex closes the polygon.
const CLOSE_TOLERANCE_PERCENT = 2.5;

function percentFromEvent(event, element) {
  const rect = element.getBoundingClientRect();
  return [
    clampPercent((100 * (event.clientX - rect.left)) / rect.width),
    clampPercent((100 * (event.clientY - rect.top)) / rect.height),
  ];
}

// Add a camera (PORCH-130): the compact registration section that tops the
// Cameras tab — probe the stream, then hand it to the engine to register
// and start serving. Refusals surface verbatim as data.
function AddCamera({ api, onAdded }) {
  const [name, setName] = useState("");
  const [streamUrl, setStreamUrl] = useState("");
  const [probe, setProbe] = useState(null); // { ok, text }
  const [addNote, setAddNote] = useState(null); // { ok, text }
  const [busy, setBusy] = useState(false);

  async function validate() {
    if (!streamUrl.trim()) {
      setProbe({ ok: false, text: "Enter the camera's stream URL to probe." });
      return;
    }
    setBusy(true);
    setProbe(null);
    try {
      const result = await api.validateCameraUrl(streamUrl.trim());
      if (result?.ok === false || result?.ok === undefined) {
        setProbe({ ok: false, text: result?.reason ?? "The stream did not answer." });
      } else {
        const dims = result.aspect?.width && result.aspect?.height ? ` at ${result.aspect.width}×${result.aspect.height}` : "";
        setProbe({ ok: true, text: `The stream answers${dims}${result.audio ? ", with audio" : ""}.` });
      }
    } catch (failure) {
      setProbe({ ok: false, text: failure.message });
    } finally {
      setBusy(false);
    }
  }

  async function add() {
    setBusy(true);
    setAddNote(null);
    try {
      const body = { url: streamUrl.trim() };
      const trimmed = name.trim();
      if (trimmed) body.name = trimmed;
      const result = await api.registerCamera(body);
      const ok = result?.ok !== false;
      setAddNote(ok
        ? { ok: true, text: `${trimmed || result?.cameraId || "The new camera"} was added and is starting to record and stream.` }
        : { ok: false, text: result?.reason ?? "The camera could not be added." });
      if (ok) {
        setStreamUrl("");
        setName("");
        setProbe(null);
        await onAdded?.();
      }
    } catch (failure) {
      setAddNote({ ok: false, text: failure.message });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Paper variant="outlined" sx={{ p: 2 }}>
      <Stack spacing={2}>
        <Typography variant="subtitle2">Add a camera</Typography>
        <Stack direction="row" spacing={2} sx={{ flexWrap: "wrap", gap: 2 }}>
          <TextField
            size="small"
            label="Name (optional)"
            value={name}
            onChange={(event) => setName(event.target.value)}
            sx={{ minWidth: 180 }}
          />
          <TextField
            size="small"
            label="Stream URL"
            value={streamUrl}
            onChange={(event) => setStreamUrl(event.target.value)}
            placeholder="rtsp://example.local/camera1"
            sx={{ minWidth: 320, flex: 1 }}
          />
        </Stack>
        {probe?.text && (
          <Typography variant="body2" color={probe.ok ? "text.secondary" : "error"}>
            {probe.text}
          </Typography>
        )}
        {addNote?.text && (
          <Typography variant="body2" color={addNote.ok ? "text.secondary" : "error"}>
            {addNote.text}
          </Typography>
        )}
        <Stack direction="row" spacing={1}>
          <Button variant="outlined" onClick={validate} disabled={busy}>
            Validate
          </Button>
          <Button variant="contained" onClick={add} disabled={busy || !streamUrl.trim() || probe?.ok !== true}>
            Add camera
          </Button>
        </Stack>
      </Stack>
    </Paper>
  );
}

// The camera editor proper (PORCH-135): zone + mask editing, unchanged.
export default function ZoneEditor({ camera, api, onCamerasChanged }) {
  return (
    <Stack spacing={2}>
      <AddCamera api={api} onAdded={onCamerasChanged} />
      {camera ? (
        <ZonePanels camera={camera} api={api} />
      ) : (
        <Typography color="text.secondary">Select a camera to edit its zones and masks.</Typography>
      )}
    </Stack>
  );
}

function ZonePanels({ camera, api }) {
  const [kind, setKind] = useState("zone");
  const [zones, setZones] = useState([]);
  const [masks, setMasks] = useState([]);
  const [draft, setDraft] = useState(null); // percent polygon being drawn
  const [closed, setClosed] = useState(false); // draft finished via first-vertex click
  const [name, setName] = useState("");
  const [error, setError] = useState("");
  const [drag, setDrag] = useState(null); // { saved: boolean, kind, id?, index }
  const [snapshotKey, setSnapshotKey] = useState(0);
  const surfaceRef = useRef(null);

  const refresh = useCallback(async () => {
    if (!camera) return;
    try {
      const [zoneList, maskList] = await Promise.all([api.listZones(camera.id), api.listMasks(camera.id)]);
      setZones(zoneList ?? []);
      setMasks(maskList ?? []);
      setError("");
    } catch (failure) {
      setError(failure.message);
    }
  }, [api, camera]);

  const cameraId = camera?.id ?? null;
  useEffect(() => {
    setDraft(null);
    setClosed(false);
    setName("");
    setDrag(null);
    refresh();
  }, [cameraId]); // eslint-disable-line react-hooks/exhaustive-deps -- refresh is stable per camera

  if (!camera) return null;

  function startOrExtend(point) {
    if (drag || closed) return;
    if (!draft) {
      setDraft([point]);
      return;
    }
    if (draft.length >= 3 && pointDistance(point, draft[0]) <= CLOSE_TOLERANCE_PERCENT) {
      // Clicking the first vertex finishes the draft: the polygon is complete
      // and further canvas clicks add nothing until Save or Discard.
      setClosed(true);
      return;
    }
    setDraft([...draft, point]);
  }

  async function save() {
    if (!draft || draft.length < 3) return;
    const create = kind === "zone" ? api.createZone : api.createMask;
    try {
      await create(camera.id, { name: name.trim(), polygon: draft, enabled: true });
      setDraft(null);
      setClosed(false);
      setName("");
      setError("");
      await refresh();
    } catch (failure) {
      setError(failure.message);
    }
  }

  async function setEnabled(row, kindOfRow, enabled) {
    const update = kindOfRow === "zone" ? api.updateZone : api.updateMask;
    try {
      await update(row.id, { enabled });
      await refresh();
    } catch (failure) {
      setError(failure.message);
    }
  }

  async function remove(row, kindOfRow) {
    const deleteDefinition = kindOfRow === "zone" ? api.deleteZone : api.deleteMask;
    try {
      await deleteDefinition(row.id);
      await refresh();
    } catch (failure) {
      setError(failure.message);
    }
  }

  function beginDrag(event, target) {
    event.preventDefault();
    event.stopPropagation();
    event.currentTarget.setPointerCapture?.(event.pointerId);
    setDrag(target);
  }

  function moveDrag(event) {
    if (!drag || !surfaceRef.current) return;
    const point = percentFromEvent(event, surfaceRef.current);
    if (!drag.saved) {
      setDraft((current) => (current ? dragVertex(current, drag.index, point) : current));
      return;
    }
    const setter = drag.kind === "zone" ? setZones : setMasks;
    setter((current) =>
      current.map((row) => (row.id === drag.id ? { ...row, polygon: dragVertex(row.polygon, drag.index, point) } : row)),
    );
  }

  async function endDrag() {
    const finished = drag;
    setDrag(null);
    if (!finished?.saved) return;
    const update = finished.kind === "zone" ? api.updateZone : api.updateMask;
    const rows = finished.kind === "zone" ? zones : masks;
    const row = rows.find((candidate) => candidate.id === finished.id);
    if (!row) return;
    try {
      await update(row.id, { polygon: row.polygon });
      await refresh();
    } catch (failure) {
      setError(failure.message);
    }
  }

  function renderPolygon(polygon, kindOfPolygon, { drawing, saved }) {
    return (
      <g>
        {polygon.length >= 3 && (
          <polygon
            points={polygon.map((point) => point.join(",")).join(" ")}
            fill={FILL[kindOfPolygon]}
            stroke={STROKE[kindOfPolygon]}
            strokeWidth={drawing ? 3 : 1.5}
            strokeDasharray={drawing ? "6 4" : undefined}
            vectorEffect="non-scaling-stroke"
          />
        )}
        {polygon.map((point, index) => (
          <circle
            key={index}
            cx={point[0]}
            cy={point[1]}
            r={2}
            fill={STROKE[kindOfPolygon]}
            stroke="#fff"
            strokeWidth={0.5}
            vectorEffect="non-scaling-stroke"
            style={{ cursor: drawing || saved ? "grab" : undefined }}
            onPointerDown={
              drawing || saved
                ? (event) => beginDrag(event, saved ? { saved: true, kind: kindOfPolygon, id: saved, index } : { saved: false, kind: kindOfPolygon, index })
                : undefined
            }
          />
        ))}
      </g>
    );
  }

  return (
    <Stack spacing={2}>
      <Paper variant="outlined" sx={{ p: 2, display: "flex", flexWrap: "wrap", gap: 2, alignItems: "center" }}>
        <ToggleButtonGroup exclusive size="small" value={kind} onChange={(event, next) => next && setKind(next)}>
          <ToggleButton value="zone" sx={{ color: STROKE.zone }}>
            Zone
          </ToggleButton>
          <ToggleButton value="mask" sx={{ color: STROKE.mask }}>
            Mask
          </ToggleButton>
        </ToggleButtonGroup>
        <TextField
          size="small"
          label={`${kind === "zone" ? "Zone" : "Mask"} name`}
          value={name}
          onChange={(event) => setName(event.target.value)}
          sx={{ minWidth: 220 }}
        />
        <Button variant="contained" disabled={!draft || draft.length < 3} onClick={save}>
          Save {kind}
        </Button>
        <Button
          disabled={!draft}
          onClick={() => {
            setDraft(null);
            setClosed(false);
          }}
        >
          Discard
        </Button>
        <Chip
          size="small"
          variant="outlined"
          label={
            draft && closed
              ? `Draft complete: ${draft.length} vertices — Save to keep or Discard`
              : draft
                ? `Drawing: ${draft.length} vertices — click the first vertex to finish, or Save`
                : "Click the snapshot to start a polygon"
          }
        />
        <Button size="small" onClick={() => setSnapshotKey((key) => key + 1)}>
          Refresh snapshot
        </Button>
      </Paper>

      {error && <Typography color="error">{error}</Typography>}

      <Box
        ref={surfaceRef}
        sx={{ position: "relative", width: "fit-content", maxWidth: "100%", lineHeight: 0 }}
        onPointerMove={moveDrag}
        onPointerUp={endDrag}
      >
        <img
          key={snapshotKey}
          src={api.cameraSnapshotUrl(camera.id, camera.width)}
          alt={`${camera.name || camera.id} snapshot`}
          draggable={false}
          style={{ display: "block", maxWidth: "100%", width: 720 }}
        />
        <Box
          component="svg"
          viewBox="0 0 100 100"
          preserveAspectRatio="none"
          sx={{
            position: "absolute",
            inset: 0,
            width: "100%",
            height: "100%",
            cursor: drag ? "grabbing" : "crosshair",
          }}
          onClick={(event) => {
            if (!surfaceRef.current) return;
            startOrExtend(percentFromEvent(event, surfaceRef.current));
          }}
        >
          {zones
            .filter((row) => Array.isArray(row.polygon))
            .map((row) => (
              <g key={row.id}>{renderPolygon(row.polygon, "zone", { saved: row.id })}</g>
            ))}
          {masks
            .filter((row) => Array.isArray(row.polygon))
            .map((row) => (
              <g key={row.id}>{renderPolygon(row.polygon, "mask", { saved: row.id })}</g>
            ))}
          {draft && renderPolygon(draft, kind, { drawing: true })}
        </Box>
      </Box>

      <Typography variant="body2" color="text.secondary">
        Coordinates are stored as percent of the frame (100 × px ÷ width), so a polygon covers the same fraction of
        the picture at any stream resolution. Drag any vertex to adjust it.
      </Typography>

      <Stack direction="row" spacing={2} sx={{ flexWrap: "wrap" }}>
        <DefinitionList
          title="Zones"
          rows={zones}
          color={STROKE.zone}
          onToggle={(row, enabled) => setEnabled(row, "zone", enabled)}
          onDelete={(row) => remove(row, "zone")}
        />
        <DefinitionList
          title="Masks"
          rows={masks}
          color={STROKE.mask}
          onToggle={(row, enabled) => setEnabled(row, "mask", enabled)}
          onDelete={(row) => remove(row, "mask")}
        />
      </Stack>
    </Stack>
  );
}

function DefinitionList({ title, rows, color, onToggle, onDelete }) {
  return (
    <Paper variant="outlined" sx={{ p: 1.5, minWidth: 280, flex: 1 }}>
      <Typography variant="subtitle2" sx={{ color }}>
        {title} ({rows.length})
      </Typography>
      <List dense disablePadding>
        {rows.length === 0 && (
          <ListItem disableGutters>
            <ListItemText secondary="None yet — draw one above." />
          </ListItem>
        )}
        {rows.map((row) => (
          <ListItem
            key={row.id}
            disableGutters
            secondaryAction={
              <IconButton edge="end" size="small" aria-label={`Delete ${row.name || row.id}`} onClick={() => onDelete(row)}>
                <DeleteIcon fontSize="small" />
              </IconButton>
            }
          >
            <FormControlLabel
              control={
                <Switch
                  size="small"
                  checked={Boolean(row.enabled)}
                  onChange={(event) => onToggle(row, event.target.checked)}
                />
              }
              label={row.name || row.id}
            />
          </ListItem>
        ))}
      </List>
    </Paper>
  );
}
