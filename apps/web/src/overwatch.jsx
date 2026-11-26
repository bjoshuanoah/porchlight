// PORCH-140: the family Overwatch surface — one screen, one hub's watched
// ground. (a) The property map: authored zone polygons drawn over the map's
// own space (the viewBox IS the map bounds expanded by a margin — uncovered
// cameras are listed as uncovered, never given an inferred zone), the console
// ZoneEditor's click-to-add-vertex grammar carried into map coordinates, and
// camera adjacency + travel-time declaration for pairs whose zones touch.
// (b) Tracked objects with live state, follow/unfollow for people and
// vehicles only, and the followed entity's stream. (c) Visits with their
// ordered timelines — gap entries render as explained gaps ("Camera outage"
// plus the span), never as fabricated content. (d) The overview dial inside
// its cap. (e) The two-entity association flag ("keep separate"). Pure logic
// and copy ride overwatch-model.js; the wire rides overwatch-actions.js
// through the shared actions object. Every Overwatch route is owner-only
// hub-side — a refusal renders its plain-language message, verbatim.
import React, { useEffect, useMemo, useRef, useState } from "react";
import { useTheme } from "@mui/material/styles";
import {
  Alert, Box, Button, Chip, IconButton, Paper, Select, Slider, Stack,
  MenuItem, TextField, Tooltip, Typography,
} from "@mui/material";
import AddOutlined from "@mui/icons-material/AddOutlined";
import DeleteOutlined from "@mui/icons-material/DeleteOutlined";
import FlagOutlined from "@mui/icons-material/FlagOutlined";
import RemoveOutlined from "@mui/icons-material/RemoveOutlined";
import { relativeTime } from "./time.js";
import {
  adjacencyPairCopy, auditLabel, clampFrameRate, clipGroupCopy, closeToleranceFor,
  DEFAULT_HANDOFF_MINUTES, dialCopy, dialRange, dialStep, entityClassLabel,
  extendZoneDraft, FLAG_BUTTON_LABEL, FLAG_PENDING_LABEL, followButtonLabel, gapGroupCopy,
  groupTimelineEntries, isFollowable, moveZoneVertex, pointFromClick, polygonIsValid,
  polygonToSvgPoints, streamClipCopy, timelineGroupCopy, trackedCamerasCopy, trackedSeenCopy,
  trackedStateLabel, travelTimeKey, travelTimeUpdate, UNCOVERED_LABEL, visitWhoCopy,
  visitWhereCopy, zoneViewBox, zonesTouch,
} from "./overwatch-model.js";

const messageOf = (error) => error?.message || "That did not work. Please try again.";

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

/** One zone polygon (or in-progress draft) drawn on the map: every finite
 * vertex renders, an empty input contributes nothing. Colors ride the mode's
 * theme palette (PORCH-042: no literal color in a screen file). */
function ZoneShape({ polygon, variant = "zone" }) {
  const theme = useTheme();
  const stroke = variant === "draft" ? theme.palette.info.main : theme.palette.success.main;
  return (
    <polygon
      points={polygonToSvgPoints(polygon)}
      fill={stroke}
      fillOpacity={variant === "draft" ? 0.22 : 0.3}
      stroke={stroke}
      strokeWidth={variant === "draft" ? 2.5 : 1.5}
      strokeDasharray={variant === "draft" ? "6 4" : undefined}
      vectorEffect="non-scaling-stroke"
    />
  );
}

/** (a) The uncovered cameras' honest list: chips that jump into authoring,
 * plus the plain-language sentence — never a rendered inferred zone.
 * Exported for the test sweep. */
export function UncoveredList({ cameras, zoneOfCamera, onPick }) {
  const uncovered = (Array.isArray(cameras) ? cameras : []).filter((camera) => camera?.cameraId && !zoneOfCamera(camera.cameraId));
  if (!uncovered.length) return null;
  return (
    <>
      <Stack direction="row" spacing={1} sx={{ flexWrap: "wrap", useFlexGap: true, mt: 1.5 }}>
        {uncovered.map((camera) => (
          <Chip
            key={camera.cameraId}
            size="small"
            variant="outlined"
            onClick={onPick ? () => onPick(camera.cameraId) : undefined}
            label={`${camera.cameraId} · ${UNCOVERED_LABEL}`}
          />
        ))}
      </Stack>
      <Typography variant="body2" sx={{ color: "text.secondary", mt: 1 }}>
        {uncovered.map((camera) => camera.cameraId).join(", ")} {uncovered.length === 1 ? "is" : "are"} uncovered — no zone is inferred.
      </Typography>
    </>
  );
}

/** (a) Zone authoring controls: pick a camera, then Save/Discard/Delete ride
 * the screen's wire callbacks — the editing math itself lives in
 * overwatch-model.js. */
function ZoneEditorControls({ cameras, cameraId, zone, draft, closed, onPick, onReset, onSave, onDelete, saving }) {
  const camera = cameras.find((candidate) => candidate?.cameraId === cameraId);
  return (
    <Paper variant="outlined" sx={{ p: 2, mt: 1.5 }}>
      <Stack direction="row" spacing={1.5} alignItems="center" sx={{ flexWrap: "wrap", useFlexGap: true }}>
        <Select size="small" displayEmpty value={cameraId} onChange={(event) => onPick(event.target.value)} sx={{ minWidth: 220 }}>
          <MenuItem value="" disabled><em>Pick a camera</em></MenuItem>
          {cameras.filter((camera_) => camera_?.cameraId).map((camera_) => (
            <MenuItem key={camera_.cameraId} value={camera_.cameraId}>{camera_.cameraId}</MenuItem>
          ))}
        </Select>
        <Button variant="contained" disabled={!draft || draft.length < 3 || saving} onClick={onSave}>
          Save zone
        </Button>
        <Button disabled={!draft} onClick={onReset}>Discard</Button>
        <Button color="error" startIcon={<DeleteOutlined />} disabled={!zone} onClick={onDelete}>
          Delete zone
        </Button>
        <Chip
          size="small"
          variant="outlined"
          label={
            draft && closed
              ? `Draft complete: ${draft.length} vertices — Save to keep or Discard`
              : draft
                ? `Drawing: ${draft.length} vertices — click the first vertex to finish, or Save`
                : zone
                  ? "Edit by drawing a new zone over this camera's"
                  : "Click the map to start a polygon"
          }
        />
      </Stack>
      {camera?.uncovered && (
        <Typography variant="body2" color="text.secondary" sx={{ mt: 1 }}>
          {camera.cameraId} covers no ground yet — no zone is inferred for it until you draw one.
        </Typography>
      )}
    </Paper>
  );
}

/** (a) Adjacency + travel-time declaration: pairs whose zones touch carry a
 * seeded 10-minute handoff — the cameras' handoff minutes are this pair's
 * travel time of record. */
function AdjacencyPanel({ state, suggestions, onSave, onError }) {
  const adjacency = Array.isArray(state?.adjacency) ? state.adjacency : [];
  const travelTime = state?.travelTime ?? {};
  const cameras = (state?.cameras ?? []).flatMap((camera) => (camera?.cameraId ? [camera.cameraId] : []));
  const [pairA, setPairA] = useState("");
  const [pairB, setPairB] = useState("");
  const [minutes, setMinutes] = useState(DEFAULT_HANDOFF_MINUTES);
  const [busy, setBusy] = useState(false);

  const alreadyDeclared = (a, b) => adjacency.some((pair) => Array.isArray(pair) && pair.includes(a) && pair.includes(b));

  const declare = async (a, b) => {
    if (!a || !b || a === b) return;
    setBusy(true);
    try {
      await onSave(
        alreadyDeclared(a, b) ? adjacency : [...adjacency, [a, b]],
        [travelTimeUpdate(travelTimeKey(a, b), minutes)],
      );
      setPairA("");
      setPairB("");
      setMinutes(DEFAULT_HANDOFF_MINUTES);
    } catch (failure) {
      onError(messageOf(failure));
    } finally {
      setBusy(false);
    }
  };

  const cameraPicker = (value, setValue, label) => (
    <Select size="small" displayEmpty value={value} onChange={(event) => setValue(event.target.value)} sx={{ minWidth: 160 }}>
      <MenuItem value="" disabled><em>{label}</em></MenuItem>
      {cameras.map((cameraId) => <MenuItem key={cameraId} value={cameraId}>{cameraId}</MenuItem>)}
    </Select>
  );

  return (
    <Stack spacing={1.5}>
      {suggestions.map(([a, b]) => (
        <Stack key={`${a}|${b}`} direction="row" spacing={1} alignItems="center" sx={{ flexWrap: "wrap", useFlexGap: true }}>
          <Chip
            size="small"
            variant="outlined"
            onClick={() => { setPairA(a); setPairB(b); }}
            label={adjacencyPairCopy([a, b])}
          />
          <Typography variant="body2" sx={{ color: "text.secondary" }}>Zones touch.</Typography>
          <Button size="small" disabled={busy || alreadyDeclared(a, b)} onClick={() => declare(a, b)}>
            {alreadyDeclared(a, b) ? "Declared" : `Set ${minutes} min handoff`}
          </Button>
        </Stack>
      ))}
      <Stack direction="row" spacing={1.5} alignItems="center" sx={{ flexWrap: "wrap", useFlexGap: true }}>
        {cameraPicker(pairA, setPairA, "Camera")}
        {cameraPicker(pairB, setPairB, "Camera")}
        <TextField
          size="small"
          type="number"
          label="Handoff minutes"
          value={minutes}
          onChange={(event) => setMinutes(event.target.value)}
          sx={{ width: 160 }}
          inputProps={{ min: 0, step: 1 }}
        />
        <Button variant="contained" disabled={busy || !pairA || !pairB || pairA === pairB} onClick={() => declare(pairA, pairB)}>
          Set handoff time
        </Button>
      </Stack>
      {adjacency.map((pair, index) => {
        const copy = adjacencyPairCopy(Array.isArray(pair) ? pair : []);
        if (!copy) return null;
        const [a, b] = pair;
        const time = travelTime[travelTimeKey(a, b)] ?? {};
        return (
          <Typography key={index} variant="body2" sx={{ color: "text.secondary" }}>
            {copy} — {time?.min ?? DEFAULT_HANDOFF_MINUTES}
            {time?.max != null && time.max !== time.min ? ` to ${time.max}` : ""} minute handoff.
          </Typography>
        );
      })}
      {adjacency.length === 0 && (
        <EmptyLine>
          No camera pairs declared yet. Pairs whose zones touch are suggested here; Overwatch walks each handoff in the declared minutes.
        </EmptyLine>
      )}
    </Stack>
  );
}

/** (d) The overview dial: slider plus stepper inside [1, capFps], the cap
 * stated, changes audited. The server's { frameRate, clamped } answer is the
 * value the control finally holds — the response is real, never a flip. */
function DialControl({ dial, onSave, onError }) {
  const capFps = dial?.capFps;
  if (capFps == null) {
    return <EmptyLine>The hub has not published a frame-rate cap yet.</EmptyLine>;
  }
  return <DialLive capFps={capFps} initial={clampFrameRate(dial?.frameRate, capFps)} onSave={onSave} onError={onError} />;
}

/** (d) The live dial of record; exported for the test sweep. */
export function DialLive({ capFps, initial, onSave, onError }) {
  const { min, max } = dialRange(capFps);
  const [value, setValue] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState("");

  const commit = async (next) => {
    const settled = clampFrameRate(next, capFps);
    setBusy(true);
    try {
      const answer = await onSave(settled);
      const served = Number(answer?.frameRate);
      setValue(Number.isFinite(served) ? served : settled);
      setNote(answer?.clamped
        ? `The hub clamped the setting to ${served} frame(s) per second.`
        : "The overview now serves this frame rate. The change is audited.");
    } catch (failure) {
      onError(messageOf(failure));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Stack spacing={1.5}>
      <Typography variant="body2" sx={{ color: "text.secondary" }}>{dialCopy(capFps)}</Typography>
      <Stack direction="row" spacing={1.5} alignItems="center" sx={{ flexWrap: "wrap", useFlexGap: true }}>
        <Tooltip title={`At least ${min} frame per second`}>
          <span>
            <IconButton size="small" aria-label="Lower frame rate" disabled={busy || value <= min} onClick={() => setValue(dialStep(value, "down", capFps))}>
              <RemoveOutlined fontSize="small" />
            </IconButton>
          </span>
        </Tooltip>
        <Slider
          sx={{ width: { xs: "100%", sm: 320 }, maxWidth: 320 }}
          min={min}
          max={max}
          step={1}
          value={value}
          aria-label="Overview frame rate"
          marks={[
            { value: min, label: `${min}` },
            { value: max, label: `${max}` },
          ]}
          onChange={(_event, next) => setValue(Array.isArray(next) ? next[next.length - 1] : next)}
        />
        <Tooltip title={`At most ${max} frames per second (the cap)`}>
          <span>
            <IconButton size="small" aria-label="Raise frame rate" disabled={busy || value >= max} onClick={() => setValue(dialStep(value, "up", capFps))}>
              <AddOutlined fontSize="small" />
            </IconButton>
          </span>
        </Tooltip>
        <Typography variant="body2" sx={{ minWidth: 90 }}>{value} / {max} fps</Typography>
        <Button variant="contained" disabled={busy || value === initial} onClick={() => commit(value)}>Set frame rate</Button>
      </Stack>
      {note && <Typography variant="body2" sx={{ color: "text.secondary" }}>{note}</Typography>}
    </Stack>
  );
}

/** (a) The interactive map: the map's own bounds as the viewBox, one polygon
 * per authored zone, click-to-add-vertex for the draft, grab-a-vertex drag.
 * The projection lives in overwatch-model.js (pointFromClick); the component
 * only reads the rendered box and hands map-space points back. */
export function OverwatchMap({ zones, viewBox, draft, cameraId, onCanvasPoint, onDraftVertexMove }) {
  const mapRef = useRef(null);
  const dragIndex = useRef(null);
  const mapPoint = (event) => {
    const rect = mapRef.current?.getBoundingClientRect?.();
    return pointFromClick({ clientX: event.clientX, clientY: event.clientY }, rect, viewBox);
  };
  const beginDrag = (index) => (event) => {
    event.preventDefault();
    event.stopPropagation();
    dragIndex.current = index;
  };
  const endDrag = () => {
    dragIndex.current = null;
  };
  return (
    <Box
      component="svg"
      data-testid="overwatch-map"
      viewBox={viewBox ?? "0 0 4 3"}
      ref={mapRef}
      onClick={cameraId && viewBox && !dragIndex.current
        ? (event) => { const point = mapPoint(event); if (point) onCanvasPoint(point); }
        : undefined}
      onPointerMove={(event) => {
        if (dragIndex.current == null || !viewBox) return;
        const point = mapPoint(event);
        if (point) onDraftVertexMove(point, dragIndex.current);
      }}
      onPointerUp={endDrag}
      sx={{
        width: "100%", maxWidth: 720, display: "block",
        aspectRatio: viewBox ? `${String(viewBox).split(" ")[2]} / ${String(viewBox).split(" ")[3]}` : "4 / 3",
        bgcolor: "var(--porch-surface)", border: "1px solid", borderColor: "divider",
        borderRadius: 1, lineHeight: 0,
        cursor: cameraId && viewBox ? "crosshair" : "default",
      }}
    >
      {zones.map((zone, index) => <ZoneShape key={zone.cameraId ?? index} polygon={zone.polygon} />)}
      {draft && <ZoneShape polygon={draft} variant="draft" />}
      {draft && cameraId && <DraftVertices draft={draft} onGrab={beginDrag} />}
    </Box>
  );
}

/** The draft's drag handles — the vertex circles the pointer grabs. */
function DraftVertices({ draft, onGrab }) {
  const theme = useTheme();
  return (
    <g>
      {(Array.isArray(draft) ? draft : []).map((vertex, index) => (
        Number.isFinite(vertex?.[0]) && Number.isFinite(vertex?.[1]) ? (
          <circle
            key={index}
            cx={vertex[0]}
            cy={vertex[1]}
            r={2}
            fill={theme.palette.info.main}
            stroke={theme.palette.common.white}
            strokeWidth={0.75}
            vectorEffect="non-scaling-stroke"
            style={{ cursor: "grab" }}
            onPointerDown={onGrab(index)}
          />
        ) : null
      ))}
    </g>
  );
}

/** (b) The tracked list: live rows — one per entity. Exported for the test
 * sweep; the follow control rides only followable classes. */
export function TrackedList({ entities, onFollowToggle, flagFrom, onFlag }) {
  const rows = Array.isArray(entities) ? entities : [];
  if (rows.length === 0) {
    return <EmptyLine>Nothing is moving in view right now.</EmptyLine>;
  }
  return (
    <Stack spacing={1.5}>
      {rows.map((entity) => (
        <TrackedRow key={entity?.entityId} entity={entity} onFollowToggle={onFollowToggle} flagFrom={flagFrom} onFlag={onFlag} />
      ))}
    </Stack>
  );
}

/** (b) One tracked row: live state, cameras, the follow control for people
 * and vehicles only, and the keep-separate flag for two-entity associations. */
function TrackedRow({ entity, onFollowToggle, flagFrom, onFlag }) {
  const label = entityClassLabel(entity?.cls) ?? "Object";
  const followable = isFollowable(entity?.cls);
  const stateLabel = trackedStateLabel(entity?.entityState);
  const untrackedClass = entity?.cls && !entityClassLabel(entity.cls);
  return (
    <Paper variant="outlined" sx={{ p: 2 }}>
      <Stack direction="row" alignItems="center" justifyContent="space-between" spacing={1.5} sx={{ flexWrap: "wrap", useFlexGap: true }}>
        <Stack sx={{ minWidth: 0 }}>
          <Stack direction="row" spacing={1} alignItems="center">
            <Typography variant="subtitle2" sx={{ fontWeight: 600 }}>{label}</Typography>
            {entity?.followed && <Chip size="small" label="Following" color="primary" />}
          </Stack>
          <Typography variant="body2" sx={{ color: "text.secondary", mt: 0.5 }}>
            {stateLabel ?? "State unknown"} · {trackedCamerasCopy(entity?.cameraIds)} {trackedSeenCopy(entity?.lastSeenAt)}
            {untrackedClass ? ` · class "${entity.cls}"` : ""}
          </Typography>
        </Stack>
        <Stack direction="row" spacing={1} alignItems="center">
          {followable && (
            <Button size="small" variant={entity?.followed ? "outlined" : "contained"} onClick={() => onFollowToggle(entity)}>
              {followButtonLabel(entity?.followed)}
            </Button>
          )}
          <Button size="small" startIcon={<FlagOutlined />} color={flagFrom ? "warning" : "inherit"} onClick={() => onFlag(entity)}>
            {flagFrom === entity?.entityId ? FLAG_PENDING_LABEL : FLAG_BUTTON_LABEL}
          </Button>
        </Stack>
      </Stack>
    </Paper>
  );
}

/** (b) The followed entity's stream: current state plus the ordered clips.
 * Exported for the test sweep, like identity.jsx's surfaces of record. */
export function FollowedStream({ stream }) {
  if (!stream) return null;
  const stateLabel = trackedStateLabel(stream.state) ?? "State unknown";
  const clips = Array.isArray(stream.clips) ? stream.clips : [];
  return (
    <Paper variant="outlined" sx={{ p: 2 }}>
      <Typography variant="subtitle2" sx={{ fontWeight: 600 }}>
        {entityClassLabel(stream.cls) ?? "Tracked object"} now: {stateLabel}
      </Typography>
      {clips.length === 0 ? (
        <EmptyLine>No recorded clips for this watch yet.</EmptyLine>
      ) : (
        <Stack spacing={0.75} sx={{ mt: 1 }}>
          {clips.map((clip, index) => (
            <Typography key={index} variant="body2" sx={{ color: "text.secondary" }}>
              {streamClipCopy(clip)}
            </Typography>
          ))}
        </Stack>
      )}
    </Paper>
  );
}

/** (c) The visit timeline: ordered groups, states as the narrative line,
 * clips as the record, gaps rendered distinctly as explained gaps. Exported
 * for the test sweep, like identity.jsx's surfaces of record. */
export function VisitTimeline({ entries }) {
  const groups = groupTimelineEntries(entries);
  return (
    <Stack spacing={0.75} sx={{ mt: 1 }}>
      {groups.map((group, index) => (
        group.kind === "gap" ? (
          // The explained gap: the reason of record plus its span, visibly set
          // apart — nothing inside a gap is ever fabricated coverage.
          <Stack key={index} direction="row" spacing={1} alignItems="flex-start" sx={{ bgcolor: "warning.main", opacity: 0.92, borderRadius: 1, p: 1 }}>
            <Typography variant="body2" sx={{ fontWeight: 600, whiteSpace: "nowrap", color: "warning.contrastText" }}>Gap</Typography>
            <Typography variant="body2" sx={{ color: "warning.contrastText" }}>{gapGroupCopy(group)}</Typography>
          </Stack>
        ) : group.kind === "clip" ? (
          <Typography key={index} variant="body2" sx={{ pl: 1 }}>{clipGroupCopy(group)}</Typography>
        ) : (
          <Typography key={index} variant="body2" sx={{ pl: 1, fontWeight: 600 }}>{timelineGroupCopy(group)}</Typography>
        )
      ))}
    </Stack>
  );
}

function VisitRow({ visit, onOpen, timeline }) {
  return (
    <Paper variant="outlined" sx={{ p: 2 }}>
      <Stack direction="row" alignItems="center" justifyContent="space-between" spacing={1.5} sx={{ flexWrap: "wrap", useFlexGap: true }}>
        <Stack sx={{ minWidth: 0 }}>
          <Typography variant="subtitle2" sx={{ fontWeight: 600 }}>{visitWhoCopy(visit?.entities)}</Typography>
          <Typography variant="body2" sx={{ color: "text.secondary", mt: 0.5 }}>
            {visitWhereCopy(visit?.cameras)}{visit?.from && visit?.to ? ` · ${visit.from} – ${visit.to}` : ""}
          </Typography>
        </Stack>
        <Button size="small" onClick={() => onOpen(visit)}>{timeline ? "Hide timeline" : "Open timeline"}</Button>
      </Stack>
      {timeline && <VisitTimeline entries={timeline} />}
    </Paper>
  );
}

// The screen. Every read is the screen's own mount work — Overwatch never
// gates on the social bootstrap, matching the Home tab's discipline.
export function Overwatch({ actions }) {
  const [state, setState] = useState(null);
  const [tracked, setTracked] = useState([]);
  const [visits, setVisits] = useState([]);
  const [audit, setAudit] = useState([]);
  const [error, setError] = useState("");

  // Zone authoring: the picked camera, the in-progress draft, and the
  // editor's own refusal.
  const [cameraId, setCameraId] = useState("");
  const [draft, setDraft] = useState(null);
  const [closed, setDraftClosed] = useState(false);
  const [editorSaving, setEditorSaving] = useState(false);
  const [editorError, setEditorError] = useState("");
  const editorReset = () => { setDraft(null); setDraftClosed(false); };

  const [adjacencyError, setAdjacencyError] = useState("");
  const [dialError, setDialError] = useState("");
  const [trackedError, setTrackedError] = useState("");
  const [visitsError, setVisitsError] = useState("");
  const [flagFrom, setFlagFrom] = useState(null);
  const [streams, setStreams] = useState({});
  const [timelines, setTimelines] = useState({});

  const reload = async () => {
    setError("");
    try {
      const [overwatch, watched] = await Promise.all([actions.loadState(), actions.loadTracked()]);
      setState(overwatch ?? null);
      setTracked(Array.isArray(watched?.tracked) ? watched.tracked : []);
    } catch (failure) {
      setError(messageOf(failure));
    }
    try {
      const window_ = await actions.loadVisits({});
      setVisits(Array.isArray(window_?.visits) ? window_.visits : []);
      setVisitsError("");
    } catch (failure) {
      setVisitsError(messageOf(failure));
    }
    try {
      const trail = await actions.loadAudit({ limit: 10 });
      setAudit(Array.isArray(trail?.records) ? trail.records : Array.isArray(trail) ? trail : []);
    } catch (failure) {
      // The audit is a window, not the surface's spine — it degrades quietly
      // to the empty list while the sections above stay honest.
      setAudit([]);
    }
  };

  useEffect(() => {
    void reload();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps — one mount pass, like the Home tab

  // The followed entity's stream loads behind the follow flag of record —
  // one read per followed entity, never a poll.
  const followedKey = tracked
    .filter((entity) => entity?.followed && entity?.entityId)
    .map((entity) => entity.entityId)
    .join("|");
  useEffect(() => {
    let stale = false;
    for (const entityId of followedKey ? followedKey.split("|") : []) {
      actions.loadEntityStream(entityId)
        .then((stream) => { if (!stale) setStreams((current) => ({ ...current, [entityId]: stream ?? null })); })
        .catch(() => { if (!stale) setStreams((current) => ({ ...current, [entityId]: null })); });
    }
    return () => { stale = true; };
  }, [followedKey]); // eslint-disable-line react-hooks/exhaustive-deps — keyed by the followed set, not by the streams map

  const zones = Array.isArray(state?.zones) ? state.zones : [];
  const viewBox = zoneViewBox(zones);
  const zoneByCamera = useMemo(
    () => new Map(zones.filter((zone) => zone?.cameraId).map((zone) => [zone.cameraId, zone])),
    [state], // eslint-disable-line react-hooks/exhaustive-deps — the map follows the state's zones
  );
  const cameras = Array.isArray(state?.cameras) ? state.cameras : [];
  const zoneOfCamera = (id) => zoneByCamera.get(id) ?? null;

  // Adjacency suggestions: only pairs whose zones actually touch — the
  // touching math is model-owned and honest about what it can prove.
  const suggestions = useMemo(() => {
    const pairs = [];
    for (let a = 0; a < cameras.length; a++) {
      for (let b = a + 1; b < cameras.length; b++) {
        const zoneA = zoneOfCamera(cameras[a]?.cameraId);
        const zoneB = zoneOfCamera(cameras[b]?.cameraId);
        if (zoneA && zoneB && zonesTouch(zoneA, zoneB)) pairs.push([cameras[a].cameraId, cameras[b].cameraId]);
      }
    }
    return pairs;
  }, [state]); // eslint-disable-line react-hooks/exhaustive-deps

  // (a) The map's pointer contract: a canvas click hands a map-space point
  // to the ZoneEditor grammar; a dragged vertex replays into the draft.
  const onCanvasPoint = (point) => {
    const tolerance = closeToleranceFor(Number(String(viewBox).split(" ")[2]));
    const next = extendZoneDraft(draft, point, tolerance, closed);
    setDraft(next.draft);
    setDraftClosed(next.closed);
  };
  const onDraftVertexMove = (point, index) => setDraft((current) => moveZoneVertex(current, index, point));

  const saveZone = async () => {
    if (!cameraId || !polygonIsValid(draft)) return;
    setEditorSaving(true);
    try {
      await actions.saveZone(cameraId, draft);
      editorReset();
      setEditorError("");
      await reload();
    } catch (failure) {
      setEditorError(messageOf(failure));
    } finally {
      setEditorSaving(false);
    }
  };

  const deleteZone = async () => {
    if (!cameraId || !zoneOfCamera(cameraId)) return;
    setEditorSaving(true);
    try {
      await actions.deleteZone(cameraId);
      editorReset();
      setEditorError("");
      await reload();
    } catch (failure) {
      setEditorError(messageOf(failure));
    } finally {
      setEditorSaving(false);
    }
  };

  const followToggle = async (entity) => {
    const turn = entity.followed ? actions.unfollowEntity : actions.followEntity;
    try {
      await turn(entity.entityId);
      const watched = await actions.loadTracked();
      setTracked(Array.isArray(watched?.tracked) ? watched.tracked : []);
      if (entity.followed) {
        setStreams((current) => {
          const next = { ...current };
          delete next[entity.entityId];
          return next;
        });
      }
      setTrackedError("");
    } catch (failure) {
      setTrackedError(messageOf(failure));
    }
  };

  const flag = async (entity) => {
    if (!flagFrom) {
      setFlagFrom(entity.entityId);
      return;
    }
    if (flagFrom === entity.entityId) {
      setFlagFrom(null);
      return;
    }
    try {
      await actions.flagAssociation({ fromEntityId: flagFrom, toEntityId: entity.entityId });
      setFlagFrom(null);
      setTrackedError("");
    } catch (failure) {
      setTrackedError(messageOf(failure));
      setFlagFrom(null);
    }
  };

  const openVisit = async (visit) => {
    const visitId = visit?.visitId;
    if (!visitId) return;
    if (timelines[visitId]) {
      setTimelines((current) => {
        const next = { ...current };
        delete next[visitId];
        return next;
      });
      return;
    }
    try {
      const answer = await actions.loadVisitTimeline(visitId);
      setTimelines((current) => ({ ...current, [visitId]: Array.isArray(answer?.timeline) ? answer.timeline : [] }));
      setVisitsError("");
    } catch (failure) {
      setVisitsError(messageOf(failure));
    }
  };

  const declared = async (pairs, updates) => {
    await Promise.all([actions.saveAdjacency(pairs), actions.saveTravelTime(updates)]);
    const overwatch = await actions.loadState();
    setState(overwatch ?? null);
  };

  const followedList = tracked.filter((entity) => entity?.followed);

  return (
    <Box sx={{ maxWidth: 760, mx: "auto", px: { xs: 2, sm: 3 }, py: { xs: 2, sm: 3 }, pb: 12 }}>
      <Typography variant="h4" sx={{ mb: 0.5 }}>Overwatch</Typography>
      <Typography variant="body2" sx={{ color: "text.secondary" }}>
        Your cameras' shared ground, what moves across it, and how the view follows. Owner's surface — changes are audited.
      </Typography>

      {error && <Alert severity="warning" sx={{ mt: 2 }}>{error}</Alert>}

      <SectionHeader title="Property map" />
      <OverwatchMap
        zones={zones}
        viewBox={viewBox}
        draft={draft}
        cameraId={cameraId}
        onCanvasPoint={onCanvasPoint}
        onDraftVertexMove={onDraftVertexMove}
      />
      <ZoneEditorControls
        cameras={cameras}
        cameraId={cameraId}
        zone={zoneOfCamera(cameraId)}
        draft={draft}
        closed={closed}
        saving={editorSaving}
        onPick={(next) => { setCameraId(next); editorReset(); }}
        onReset={editorReset}
        onSave={saveZone}
        onDelete={deleteZone}
      />
      {editorError && <Alert severity="warning" sx={{ mt: 1.5 }}>{editorError}</Alert>}
      <UncoveredList cameras={cameras} zoneOfCamera={zoneOfCamera} onPick={(next) => { setCameraId(next); editorReset(); }} />

      <SectionHeader title="Adjacency and travel time" />
      <AdjacencyPanel state={state} suggestions={suggestions} onSave={declared} onError={setAdjacencyError} />
      {adjacencyError && <Alert severity="warning" sx={{ mt: 1.5 }}>{adjacencyError}</Alert>}

      <SectionHeader title="Dial" />
      <DialControl dial={state?.dial} onSave={(frameRate) => actions.saveDial(frameRate)} onError={setDialError} />
      {dialError && <Alert severity="warning" sx={{ mt: 1.5 }}>{dialError}</Alert>}

      <SectionHeader title="Tracked now" />
      {trackedError && <Alert severity="warning" sx={{ mb: 1.5 }}>{trackedError}</Alert>}
      <TrackedList entities={tracked} onFollowToggle={followToggle} flagFrom={flagFrom} onFlag={flag} />

      {flagFrom && (
        <Alert severity="info" sx={{ mt: 1.5 }}>
          {FLAG_PENDING_LABEL} — tap {FLAG_BUTTON_LABEL.toLowerCase()} on the second object to flag the association.
        </Alert>
      )}

      {followedList.length > 0 && (
        <>
          <SectionHeader title="Followed" />
          <Stack spacing={1.5}>
            {followedList.map((entity) => (
              <FollowedStream key={entity.entityId} stream={streams[entity.entityId]} />
            ))}
          </Stack>
        </>
      )}

      <SectionHeader title="Visits" />
      {visitsError && <Alert severity="warning" sx={{ mb: 1.5 }}>{visitsError}</Alert>}
      {visits.length === 0 && <EmptyLine>No visits recorded in the window yet.</EmptyLine>}
      <Stack spacing={1.5}>
        {visits.map((visit) => (
          <VisitRow key={visit?.visitId} visit={visit} timeline={timelines[visit?.visitId]} onOpen={openVisit} />
        ))}
      </Stack>

      <SectionHeader title="Recent activity" />
      {audit.length === 0 && <EmptyLine>No Overwatch activity recorded yet.</EmptyLine>}
      {audit.map((row, index) => (
        <Typography key={row?._id ?? index} variant="body2" sx={{ color: "text.secondary", py: 0.75 }}>
          {auditLabel(row?.type)}{row?.at ? ` · ${relativeTime(row.at)}` : ""}
        </Typography>
      ))}
    </Box>
  );
}
