// src/overwatch.jsx
import React, { useEffect, useMemo, useRef, useState } from "react";
import { useTheme } from "@mui/material/styles";
import {
  Alert,
  Box,
  Button,
  Chip,
  IconButton,
  Paper,
  Select,
  Slider,
  Stack,
  MenuItem,
  TextField,
  Tooltip,
  Typography
} from "@mui/material";
import AddOutlined from "@mui/icons-material/AddOutlined";
import DeleteOutlined from "@mui/icons-material/DeleteOutlined";
import FlagOutlined from "@mui/icons-material/FlagOutlined";
import RemoveOutlined from "@mui/icons-material/RemoveOutlined";

// src/time.js
function dateOf(value) {
  if (!value || Number.isNaN(new Date(value).valueOf())) return "";
  return new Intl.DateTimeFormat(void 0, { dateStyle: "medium" }).format(new Date(value));
}
function relativeTime(value, now = Date.now()) {
  if (!value) return "";
  const then = new Date(value).valueOf();
  if (Number.isNaN(then)) return "";
  const seconds = Math.round((now - then) / 1e3);
  if (seconds < 60) return "now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days < 7) return `${days}d ago`;
  return dateOf(value);
}

// src/overwatch-model.js
var VIEWBOX_MARGIN = 12;
var finite = (value) => typeof value === "number" && Number.isFinite(value);
var asPoint = (point) => Array.isArray(point) && finite(point[0]) && finite(point[1]) ? [point[0], point[1]] : null;
function polygonIsValid(polygon) {
  return Array.isArray(polygon) && polygon.map(asPoint).filter(Boolean).length >= 3;
}
var pointsOf = (zones) => (Array.isArray(zones) ? zones : []).flatMap((zone) => Array.isArray(zone?.polygon) ? zone.polygon.map(asPoint) : []).filter(Boolean);
function boundsOf(zones, margin = VIEWBOX_MARGIN) {
  const points = pointsOf(zones);
  if (!points.length) return null;
  const xs = points.map((point) => point[0]);
  const ys = points.map((point) => point[1]);
  const pad = finite(margin) && margin >= 0 ? margin : VIEWBOX_MARGIN;
  return {
    minX: Math.min(...xs) - pad,
    minY: Math.min(...ys) - pad,
    maxX: Math.max(...xs) + pad,
    maxY: Math.max(...ys) + pad
  };
}
function viewBoxOf(bounds) {
  if (!bounds) return null;
  const width = bounds.maxX - bounds.minX;
  const height = bounds.maxY - bounds.minY;
  if (!(width > 0) || !(height > 0)) return null;
  return `${bounds.minX} ${bounds.minY} ${width} ${height}`;
}
function zoneViewBox(zones, margin) {
  return viewBoxOf(boundsOf(zones, margin));
}
function polygonToSvgPoints(polygon) {
  if (!Array.isArray(polygon)) return "";
  return polygon.map(asPoint).filter(Boolean).map((point) => `${point[0]},${point[1]}`).join(" ");
}
function pointFromClick(point, rect, viewBox) {
  if (!point || !rect || !rect.width || !rect.height) return null;
  const parts = String(viewBox ?? "").trim().split(/\s+/).map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isFinite(part)) || parts[2] <= 0 || parts[3] <= 0) return null;
  const [minX, minY, width, height] = parts;
  return [
    minX + (point.clientX - rect.left) / rect.width * width,
    minY + (point.clientY - rect.top) / rect.height * height
  ];
}
var distanceOf = (a, b) => Math.hypot(b[0] - a[0], b[1] - a[1]);
function closeToleranceFor(span, percent = 2.5) {
  const value = finite(span) && span > 0 ? span : 0;
  return value * (finite(percent) && percent > 0 ? percent : 2.5) / 100;
}
function extendZoneDraft(draft, point, closeTolerance, closed = false) {
  const asCurrent = Array.isArray(draft) ? draft.map(asPoint).filter(Boolean) : null;
  if (closed) return { draft: asCurrent, closed: true };
  const asNext = asPoint(point);
  if (!asNext) return { draft: asCurrent, closed: false };
  if (!asCurrent || asCurrent.length === 0) return { draft: [asNext], closed: false };
  if (asCurrent.length >= 3 && distanceOf(asNext, asCurrent[0]) <= (finite(closeTolerance) && closeTolerance > 0 ? closeTolerance : 0)) {
    return { draft: asCurrent, closed: true };
  }
  return { draft: [...asCurrent, asNext], closed: false };
}
function moveZoneVertex(polygon, index, point) {
  const asNext = asPoint(point);
  if (!Array.isArray(polygon) || index == null || index < 0 || index >= polygon.length || !asNext) {
    return Array.isArray(polygon) ? [...polygon] : [];
  }
  return polygon.map((vertex, at) => at === index ? asNext : vertex);
}
function zonesTouch(zoneA, zoneB, epsilon = 0.5) {
  const bounds = (zone) => {
    const points = Array.isArray(zone?.polygon) ? zone.polygon.map(asPoint).filter(Boolean) : [];
    if (!points.length) return null;
    return {
      minX: Math.min(...points.map((p) => p[0])),
      minY: Math.min(...points.map((p) => p[1])),
      maxX: Math.max(...points.map((p) => p[0])),
      maxY: Math.max(...points.map((p) => p[1]))
    };
  };
  const a = bounds(zoneA);
  const b = bounds(zoneB);
  if (!a || !b || !finite(epsilon) || epsilon < 0) return false;
  return a.minX - epsilon <= b.maxX && b.minX - epsilon <= a.maxX && a.minY - epsilon <= b.maxY && b.minY - epsilon <= a.maxY;
}
function travelTimeKey(cameraIdA, cameraIdB) {
  const a = String(cameraIdA ?? "");
  const b = String(cameraIdB ?? "");
  return a <= b ? `${a}|${b}` : `${b}|${a}`;
}
var DEFAULT_HANDOFF_MINUTES = 10;
function travelTimeUpdate(key, minutes) {
  const value = Math.max(0, Math.round(Number(minutes)));
  const bound = Number.isFinite(value) ? value : DEFAULT_HANDOFF_MINUTES;
  return { key: String(key ?? ""), min: bound, max: bound };
}
var DIAL_MIN_FPS = 1;
function dialCap(capFps) {
  const value = Number(capFps);
  if (!Number.isFinite(value)) return DIAL_MIN_FPS;
  return Math.max(DIAL_MIN_FPS, Math.floor(value));
}
function dialRange(capFps) {
  return { min: DIAL_MIN_FPS, max: dialCap(capFps) };
}
function clampFrameRate(value, capFps) {
  const cap = dialCap(capFps);
  const requested = Math.round(Number(value));
  if (!Number.isFinite(requested)) return DIAL_MIN_FPS;
  return Math.min(cap, Math.max(DIAL_MIN_FPS, requested));
}
function dialStep(value, direction, capFps) {
  const delta = direction === "down" ? -1 : 1;
  return clampFrameRate(Number(value) + delta, capFps);
}
function dialCopy(capFps) {
  const cap = dialCap(capFps);
  return `Frame rate of the live overview, 1 to ${cap} per second \u2014 the hub caps this dial at ${cap}. Changes are audited.`;
}
var FOLLOWABLE_CLASSES = ["person", "vehicle"];
function isFollowable(cls) {
  return FOLLOWABLE_CLASSES.includes(cls);
}
var CLASS_LABELS = { person: "Person", vehicle: "Vehicle", package: "Package", animal: "Animal" };
function entityClassLabel(cls) {
  return CLASS_LABELS[cls] ?? null;
}
var STATE_LABELS = { arrival: "Arrived", movement: "Moving", stationary: "Stationary", departure: "Departing" };
function trackedStateLabel(state) {
  return STATE_LABELS[state] ?? null;
}
var FOLLOW_BUTTON_LABEL = "Follow";
var UNFOLLOW_BUTTON_LABEL = "Stop following";
function followButtonLabel(followed) {
  return followed ? UNFOLLOW_BUTTON_LABEL : FOLLOW_BUTTON_LABEL;
}
var FLAG_BUTTON_LABEL = "Keep separate";
var FLAG_PENDING_LABEL = "Pick the other one";
function trackedCamerasCopy(cameraIds) {
  const ids = Array.isArray(cameraIds) ? cameraIds.filter(Boolean) : [];
  if (!ids.length) return "Not seen by a camera yet.";
  return ids.length === 1 ? `Seen by ${ids[0]}.` : `Seen by ${ids.join(", ")}.`;
}
var entityIdOf = (entity) => typeof entity === "string" ? entity : entity?.entityId;
var entityClsOf = (entity) => typeof entity === "object" && entity !== null ? entity.cls : void 0;
function visitEntityIds(entities) {
  return (Array.isArray(entities) ? entities : []).map(entityIdOf).filter(Boolean);
}
function visitWhoCopy(entities) {
  const rows = Array.isArray(entities) ? entities : [];
  const labels = rows.map(entityClsOf).map(entityClassLabel).filter(Boolean);
  if (labels.length) return labels.join(", ");
  const count = visitEntityIds(rows).length;
  if (!count) return "No tracked objects.";
  return count === 1 ? "1 tracked object" : `${count} tracked objects`;
}
function visitWhereCopy(cameras) {
  const ids = (Array.isArray(cameras) ? cameras : []).flatMap(
    (camera) => typeof camera === "string" ? [camera] : camera?.cameraId ? [camera.cameraId] : []
  );
  if (!ids.length) return "Unknown cameras.";
  return ids.length === 1 ? `Camera ${ids[0]}.` : `Cameras ${ids.join(", ")}.`;
}
var sameDay = (a, b) => new Date(a).getFullYear() === new Date(b).getFullYear() && new Date(a).getMonth() === new Date(b).getMonth() && new Date(a).getDate() === new Date(b).getDate();
var timeOf = (value) => {
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) return "";
  return new Intl.DateTimeFormat(void 0, { hour: "numeric", minute: "2-digit" }).format(date);
};
function spanCopy(from, to) {
  const start = timeOf(from);
  const end = timeOf(to);
  if (!start && !end) return "";
  const dated = !Number.isNaN(new Date(from).valueOf()) && !Number.isNaN(new Date(to).valueOf()) && !sameDay(from, to) && Boolean(start) && Boolean(end);
  if (dated) return `${datePrefix(from)}${start} \u2013 ${end}`;
  return start && end ? `${start} \u2013 ${end}` : start || end || "";
}
function datePrefix(value) {
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) return "";
  return `${new Intl.DateTimeFormat(void 0, { month: "short", day: "numeric" }).format(date)} `;
}
var GAP_LABELS = { "camera-outage": "Camera outage", outage: "Camera outage", camera_outage: "Camera outage" };
function gapReasonLabel(reason) {
  if (!reason) return "Gap in coverage";
  return GAP_LABELS[reason] ?? String(reason).replace(/[-_]+/g, " ").replace(/^./, (c) => c.toUpperCase());
}
function gapGroupCopy(group) {
  const reason = gapReasonLabel(group?.reason);
  const span = spanCopy(group?.from, group?.to);
  return span ? `${reason} \u2014 ${span}` : reason;
}
function groupTimelineEntries(entries) {
  const groups = [];
  for (const entry of Array.isArray(entries) ? entries : []) {
    const row = entry ?? {};
    const last = groups[groups.length - 1];
    const same = last && last.kind === row.kind && (last.cameraId ?? null) === (row.cameraId ?? null) && (last.state ?? null) === (row.state ?? null) && (last.reason ?? null) === (row.reason ?? null);
    if (same) {
      last.count += 1;
      if (row.path) last.paths.push(row.path);
      if (row.state) last.states.push(row.state);
      if (row.from != null) last.from = last.from == null || row.from < last.from ? row.from : last.from;
      if (row.to != null) last.to = last.to == null || row.to > last.to ? row.to : last.to;
      continue;
    }
    groups.push({
      kind: row.kind,
      cameraId: row.cameraId ?? null,
      state: row.state ?? null,
      reason: row.reason ?? null,
      path: row.path ?? null,
      from: row.from ?? null,
      to: row.to ?? null,
      count: 1,
      states: [row.state].filter(Boolean),
      paths: [row.path].filter(Boolean)
    });
  }
  return groups;
}
function clipGroupCopy(group) {
  const span = spanCopy(group?.from, group?.to);
  const where = group?.cameraId ? `Camera ${group.cameraId}` : "Camera unknown.";
  const count = group?.count ?? 1;
  const howMany = count === 1 ? "1 clip" : `${count} clips`;
  return span ? `${howMany} \xB7 ${where} \u2014 ${span}` : `${howMany} \xB7 ${where}.`;
}
function stateGroupCopy(group) {
  return trackedStateLabel(group?.state) ?? "Unknown";
}
function streamClipCopy(clip) {
  return clipGroupCopy({ ...clip, count: 1 });
}
function timelineGroupCopy(group) {
  if (group?.kind === "gap") return gapGroupCopy(group);
  if (group?.kind === "clip") return clipGroupCopy(group);
  if (group?.kind === "state") return stateGroupCopy(group);
  return "Unrecognized entry.";
}
var AUDIT_LABELS = {
  "zone.authored": "Zone drawn",
  "zone.deleted": "Zone deleted",
  "adjacency.authored": "Camera adjacency set",
  "travel-time.authored": "Travel time set",
  "dial": "Overview dial changed",
  "follow": "Follow set",
  "unfollow": "Follow ended",
  "association.flag": "Association flagged",
  "tracked": "Tracked object",
  "visits": "Visit recorded"
};
function auditLabel(type) {
  return AUDIT_LABELS[type] ?? String(type || "Event").replace(/[._-]+/g, " ").replace(/^./, (c) => c.toUpperCase());
}
function trackedSeenCopy(lastSeenAt) {
  return lastSeenAt ? `Last seen ${relativeTime(lastSeenAt)}.` : "Not seen recently.";
}
var UNCOVERED_LABEL = "Uncovered";
function adjacencyPairCopy(pair) {
  const ids = Array.isArray(pair) ? pair.filter(Boolean) : [];
  return ids.length === 2 ? `${ids[0]} \u2194 ${ids[1]}` : null;
}

// src/people-model.js
function confidencePercent(confidence) {
  const value = Number(confidence);
  if (typeof confidence !== "number" || !Number.isFinite(value) || value < 0 || value > 1) return null;
  return Math.round(value * 100);
}
function decisionLabel(name, decision, confidence) {
  if (typeof name !== "string" || name.trim() === "") return null;
  if (decision === "asserted") return name;
  const percent = confidencePercent(confidence);
  return `looks like ${name}${percent == null ? "" : ` (${percent}%)`}`;
}
function namesByEntryId(entries) {
  const names = {};
  for (const entry of Array.isArray(entries) ? entries : []) {
    if (entry?._id && typeof entry.name === "string" && entry.name.trim() !== "") {
      names[entry._id] = entry.name;
    }
  }
  return names;
}
function nameOf(names, row) {
  const byId = names ?? {};
  const name = row?.entryId ? byId[row.entryId] : null;
  return typeof name === "string" && name.trim() !== "" ? name : null;
}
function decisionLabelOf(names, row) {
  return decisionLabel(nameOf(names, row), row?.decision, row?.confidence);
}
var nonEmpty = (value) => typeof value === "string" && value.trim() !== "";
var unique = (values) => [...new Set((Array.isArray(values) ? values : []).filter(nonEmpty))];
function cameraIdSet(values) {
  return new Set(unique(values));
}
function joinedByCameraTrack(annotation, cameraIds, trackIds) {
  if (!nonEmpty(annotation?.cameraId) || !nonEmpty(annotation?.trackId)) return false;
  return cameraIdSet(cameraIds).has(annotation.cameraId) && new Set(unique(trackIds)).has(annotation.trackId);
}
function annotationsForEntity(annotations, entity) {
  return (Array.isArray(annotations) ? annotations : []).filter((annotation) => {
    if (!annotation) return false;
    if (annotation.targetKind === "entity") return annotation.targetId != null && annotation.targetId === entity?.entityId;
    return joinedByCameraTrack(annotation, [entity?.cameraId, ...entity?.cameraIds ?? []], [entity?.trackId]);
  });
}
function annotationsForVisit(annotations, visit) {
  const cameraIds = [...visit?.cameras ?? []];
  const trackIds = (Array.isArray(visit?.entities) ? visit.entities : []).map((entity) => entity?.trackId);
  return (Array.isArray(annotations) ? annotations : []).filter((annotation) => {
    if (!annotation) return false;
    if (annotation.targetKind === "visit") return annotation.targetId != null && annotation.targetId === visit?.visitId;
    return joinedByCameraTrack(annotation, cameraIds, trackIds);
  });
}
function annotationsForTrackRow(annotations, row) {
  if (!nonEmpty(row?.trackId)) return [];
  return (Array.isArray(annotations) ? annotations : []).filter((annotation) => annotation?.trackId === row.trackId && (row?.cameraId == null || !nonEmpty(annotation?.cameraId) || annotation.cameraId === row.cameraId));
}
function annotationLines(names, rows) {
  const lines = (Array.isArray(rows) ? rows : []).map((row) => decisionLabelOf(names, row)).filter((line) => line != null);
  return [...new Set(lines)].length > 0 ? [...new Set(lines)] : null;
}

// src/overwatch.jsx
import { Fragment, jsx, jsxs } from "react/jsx-runtime";
var messageOf = (error) => error?.message || "That did not work. Please try again.";
function SectionHeader({ title, action }) {
  return /* @__PURE__ */ jsxs(Stack, { direction: "row", alignItems: "center", justifyContent: "space-between", sx: { mt: 4, mb: 1.5 }, children: [
    /* @__PURE__ */ jsx(Typography, { variant: "h6", children: title }),
    action
  ] });
}
function EmptyLine({ children }) {
  return /* @__PURE__ */ jsx(Typography, { variant: "body2", sx: { color: "text.secondary", py: 0.75 }, children });
}
function ZoneShape({ polygon, variant = "zone" }) {
  const theme = useTheme();
  const stroke = variant === "draft" ? theme.palette.info.main : theme.palette.success.main;
  return /* @__PURE__ */ jsx(
    "polygon",
    {
      points: polygonToSvgPoints(polygon),
      fill: stroke,
      fillOpacity: variant === "draft" ? 0.22 : 0.3,
      stroke,
      strokeWidth: variant === "draft" ? 2.5 : 1.5,
      strokeDasharray: variant === "draft" ? "6 4" : void 0,
      vectorEffect: "non-scaling-stroke"
    }
  );
}
function UncoveredList({ cameras, zoneOfCamera, onPick }) {
  const uncovered = (Array.isArray(cameras) ? cameras : []).filter((camera) => camera?.cameraId && !zoneOfCamera(camera.cameraId));
  if (!uncovered.length) return null;
  return /* @__PURE__ */ jsxs(Fragment, { children: [
    /* @__PURE__ */ jsx(Stack, { direction: "row", spacing: 1, sx: { flexWrap: "wrap", useFlexGap: true, mt: 1.5 }, children: uncovered.map((camera) => /* @__PURE__ */ jsx(
      Chip,
      {
        size: "small",
        variant: "outlined",
        onClick: onPick ? () => onPick(camera.cameraId) : void 0,
        label: `${camera.cameraId} \xB7 ${UNCOVERED_LABEL}`
      },
      camera.cameraId
    )) }),
    /* @__PURE__ */ jsxs(Typography, { variant: "body2", sx: { color: "text.secondary", mt: 1 }, children: [
      uncovered.map((camera) => camera.cameraId).join(", "),
      " ",
      uncovered.length === 1 ? "is" : "are",
      " uncovered \u2014 no zone is inferred."
    ] })
  ] });
}
function ZoneEditorControls({ cameras, cameraId, zone, draft, closed, onPick, onReset, onSave, onDelete, saving }) {
  const camera = cameras.find((candidate) => candidate?.cameraId === cameraId);
  return /* @__PURE__ */ jsxs(Paper, { variant: "outlined", sx: { p: 2, mt: 1.5 }, children: [
    /* @__PURE__ */ jsxs(Stack, { direction: "row", spacing: 1.5, alignItems: "center", sx: { flexWrap: "wrap", useFlexGap: true }, children: [
      /* @__PURE__ */ jsxs(Select, { size: "small", displayEmpty: true, value: cameraId, onChange: (event) => onPick(event.target.value), sx: { minWidth: 220 }, children: [
        /* @__PURE__ */ jsx(MenuItem, { value: "", disabled: true, children: /* @__PURE__ */ jsx("em", { children: "Pick a camera" }) }),
        cameras.filter((camera_) => camera_?.cameraId).map((camera_) => /* @__PURE__ */ jsx(MenuItem, { value: camera_.cameraId, children: camera_.cameraId }, camera_.cameraId))
      ] }),
      /* @__PURE__ */ jsx(Button, { variant: "contained", disabled: !draft || draft.length < 3 || saving, onClick: onSave, children: "Save zone" }),
      /* @__PURE__ */ jsx(Button, { disabled: !draft, onClick: onReset, children: "Discard" }),
      /* @__PURE__ */ jsx(Button, { color: "error", startIcon: /* @__PURE__ */ jsx(DeleteOutlined, {}), disabled: !zone, onClick: onDelete, children: "Delete zone" }),
      /* @__PURE__ */ jsx(
        Chip,
        {
          size: "small",
          variant: "outlined",
          label: draft && closed ? `Draft complete: ${draft.length} vertices \u2014 Save to keep or Discard` : draft ? `Drawing: ${draft.length} vertices \u2014 click the first vertex to finish, or Save` : zone ? "Edit by drawing a new zone over this camera's" : "Click the map to start a polygon"
        }
      )
    ] }),
    camera?.uncovered && /* @__PURE__ */ jsxs(Typography, { variant: "body2", color: "text.secondary", sx: { mt: 1 }, children: [
      camera.cameraId,
      " covers no ground yet \u2014 no zone is inferred for it until you draw one."
    ] })
  ] });
}
function AdjacencyPanel({ state, suggestions, onSave, onError }) {
  const adjacency = Array.isArray(state?.adjacency) ? state.adjacency : [];
  const travelTime = state?.travelTime ?? {};
  const cameras = (state?.cameras ?? []).flatMap((camera) => camera?.cameraId ? [camera.cameraId] : []);
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
        [travelTimeUpdate(travelTimeKey(a, b), minutes)]
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
  const cameraPicker = (value, setValue, label) => /* @__PURE__ */ jsxs(Select, { size: "small", displayEmpty: true, value, onChange: (event) => setValue(event.target.value), sx: { minWidth: 160 }, children: [
    /* @__PURE__ */ jsx(MenuItem, { value: "", disabled: true, children: /* @__PURE__ */ jsx("em", { children: label }) }),
    cameras.map((cameraId) => /* @__PURE__ */ jsx(MenuItem, { value: cameraId, children: cameraId }, cameraId))
  ] });
  return /* @__PURE__ */ jsxs(Stack, { spacing: 1.5, children: [
    suggestions.map(([a, b]) => /* @__PURE__ */ jsxs(Stack, { direction: "row", spacing: 1, alignItems: "center", sx: { flexWrap: "wrap", useFlexGap: true }, children: [
      /* @__PURE__ */ jsx(
        Chip,
        {
          size: "small",
          variant: "outlined",
          onClick: () => {
            setPairA(a);
            setPairB(b);
          },
          label: adjacencyPairCopy([a, b])
        }
      ),
      /* @__PURE__ */ jsx(Typography, { variant: "body2", sx: { color: "text.secondary" }, children: "Zones touch." }),
      /* @__PURE__ */ jsx(Button, { size: "small", disabled: busy || alreadyDeclared(a, b), onClick: () => declare(a, b), children: alreadyDeclared(a, b) ? "Declared" : `Set ${minutes} min handoff` })
    ] }, `${a}|${b}`)),
    /* @__PURE__ */ jsxs(Stack, { direction: "row", spacing: 1.5, alignItems: "center", sx: { flexWrap: "wrap", useFlexGap: true }, children: [
      cameraPicker(pairA, setPairA, "Camera"),
      cameraPicker(pairB, setPairB, "Camera"),
      /* @__PURE__ */ jsx(
        TextField,
        {
          size: "small",
          type: "number",
          label: "Handoff minutes",
          value: minutes,
          onChange: (event) => setMinutes(event.target.value),
          sx: { width: 160 },
          inputProps: { min: 0, step: 1 }
        }
      ),
      /* @__PURE__ */ jsx(Button, { variant: "contained", disabled: busy || !pairA || !pairB || pairA === pairB, onClick: () => declare(pairA, pairB), children: "Set handoff time" })
    ] }),
    adjacency.map((pair, index) => {
      const copy = adjacencyPairCopy(Array.isArray(pair) ? pair : []);
      if (!copy) return null;
      const [a, b] = pair;
      const time = travelTime[travelTimeKey(a, b)] ?? {};
      return /* @__PURE__ */ jsxs(Typography, { variant: "body2", sx: { color: "text.secondary" }, children: [
        copy,
        " \u2014 ",
        time?.min ?? DEFAULT_HANDOFF_MINUTES,
        time?.max != null && time.max !== time.min ? ` to ${time.max}` : "",
        " minute handoff."
      ] }, index);
    }),
    adjacency.length === 0 && /* @__PURE__ */ jsx(EmptyLine, { children: "No camera pairs declared yet. Pairs whose zones touch are suggested here; Overwatch walks each handoff in the declared minutes." })
  ] });
}
function DialControl({ dial, onSave, onError }) {
  const capFps = dial?.capFps;
  if (capFps == null) {
    return /* @__PURE__ */ jsx(EmptyLine, { children: "The hub has not published a frame-rate cap yet." });
  }
  return /* @__PURE__ */ jsx(DialLive, { capFps, initial: clampFrameRate(dial?.frameRate, capFps), onSave, onError });
}
function DialLive({ capFps, initial, onSave, onError }) {
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
      setNote(answer?.clamped ? `The hub clamped the setting to ${served} frame(s) per second.` : "The overview now serves this frame rate. The change is audited.");
    } catch (failure) {
      onError(messageOf(failure));
    } finally {
      setBusy(false);
    }
  };
  return /* @__PURE__ */ jsxs(Stack, { spacing: 1.5, children: [
    /* @__PURE__ */ jsx(Typography, { variant: "body2", sx: { color: "text.secondary" }, children: dialCopy(capFps) }),
    /* @__PURE__ */ jsxs(Stack, { direction: "row", spacing: 1.5, alignItems: "center", sx: { flexWrap: "wrap", useFlexGap: true }, children: [
      /* @__PURE__ */ jsx(Tooltip, { title: `At least ${min} frame per second`, children: /* @__PURE__ */ jsx("span", { children: /* @__PURE__ */ jsx(IconButton, { size: "small", "aria-label": "Lower frame rate", disabled: busy || value <= min, onClick: () => setValue(dialStep(value, "down", capFps)), children: /* @__PURE__ */ jsx(RemoveOutlined, { fontSize: "small" }) }) }) }),
      /* @__PURE__ */ jsx(
        Slider,
        {
          sx: { width: { xs: "100%", sm: 320 }, maxWidth: 320 },
          min,
          max,
          step: 1,
          value,
          "aria-label": "Overview frame rate",
          marks: [
            { value: min, label: `${min}` },
            { value: max, label: `${max}` }
          ],
          onChange: (_event, next) => setValue(Array.isArray(next) ? next[next.length - 1] : next)
        }
      ),
      /* @__PURE__ */ jsx(Tooltip, { title: `At most ${max} frames per second (the cap)`, children: /* @__PURE__ */ jsx("span", { children: /* @__PURE__ */ jsx(IconButton, { size: "small", "aria-label": "Raise frame rate", disabled: busy || value >= max, onClick: () => setValue(dialStep(value, "up", capFps)), children: /* @__PURE__ */ jsx(AddOutlined, { fontSize: "small" }) }) }) }),
      /* @__PURE__ */ jsxs(Typography, { variant: "body2", sx: { minWidth: 90 }, children: [
        value,
        " / ",
        max,
        " fps"
      ] }),
      /* @__PURE__ */ jsx(Button, { variant: "contained", disabled: busy || value === initial, onClick: () => commit(value), children: "Set frame rate" })
    ] }),
    note && /* @__PURE__ */ jsx(Typography, { variant: "body2", sx: { color: "text.secondary" }, children: note })
  ] });
}
function OverwatchMap({ zones, viewBox, draft, cameraId, onCanvasPoint, onDraftVertexMove }) {
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
  return /* @__PURE__ */ jsxs(
    Box,
    {
      component: "svg",
      "data-testid": "overwatch-map",
      viewBox: viewBox ?? "0 0 4 3",
      ref: mapRef,
      onClick: cameraId && viewBox && !dragIndex.current ? (event) => {
        const point = mapPoint(event);
        if (point) onCanvasPoint(point);
      } : void 0,
      onPointerMove: (event) => {
        if (dragIndex.current == null || !viewBox) return;
        const point = mapPoint(event);
        if (point) onDraftVertexMove(point, dragIndex.current);
      },
      onPointerUp: endDrag,
      sx: {
        width: "100%",
        maxWidth: 720,
        display: "block",
        aspectRatio: viewBox ? `${String(viewBox).split(" ")[2]} / ${String(viewBox).split(" ")[3]}` : "4 / 3",
        bgcolor: "var(--porch-surface)",
        border: "1px solid",
        borderColor: "divider",
        borderRadius: 1,
        lineHeight: 0,
        cursor: cameraId && viewBox ? "crosshair" : "default"
      },
      children: [
        zones.map((zone, index) => /* @__PURE__ */ jsx(ZoneShape, { polygon: zone.polygon }, zone.cameraId ?? index)),
        draft && /* @__PURE__ */ jsx(ZoneShape, { polygon: draft, variant: "draft" }),
        draft && cameraId && /* @__PURE__ */ jsx(DraftVertices, { draft, onGrab: beginDrag })
      ]
    }
  );
}
function DraftVertices({ draft, onGrab }) {
  const theme = useTheme();
  return /* @__PURE__ */ jsx("g", { children: (Array.isArray(draft) ? draft : []).map((vertex, index) => Number.isFinite(vertex?.[0]) && Number.isFinite(vertex?.[1]) ? /* @__PURE__ */ jsx(
    "circle",
    {
      cx: vertex[0],
      cy: vertex[1],
      r: 2,
      fill: theme.palette.info.main,
      stroke: theme.palette.common.white,
      strokeWidth: 0.75,
      vectorEffect: "non-scaling-stroke",
      style: { cursor: "grab" },
      onPointerDown: onGrab(index)
    },
    index
  ) : null) });
}
function TrackedList({ entities, recognitions, onFollowToggle, flagFrom, onFlag }) {
  const rows = Array.isArray(entities) ? entities : [];
  if (rows.length === 0) {
    return /* @__PURE__ */ jsx(EmptyLine, { children: "Nothing is moving in view right now." });
  }
  return /* @__PURE__ */ jsx(Stack, { spacing: 1.5, children: rows.map((entity) => /* @__PURE__ */ jsx(TrackedRow, { entity, recognitions, onFollowToggle, flagFrom, onFlag }, entity?.entityId)) });
}
function TrackedRow({ entity, recognitions, onFollowToggle, flagFrom, onFlag }) {
  const label = entityClassLabel(entity?.cls) ?? "Object";
  const followable = isFollowable(entity?.cls);
  const stateLabel = trackedStateLabel(entity?.entityState);
  const untrackedClass = entity?.cls && !entityClassLabel(entity.cls);
  const identities = recognitions?.names && recognitions?.annotations ? annotationLines(recognitions.names, annotationsForEntity(recognitions.annotations, entity)) ?? [] : [];
  return /* @__PURE__ */ jsx(Paper, { variant: "outlined", sx: { p: 2 }, children: /* @__PURE__ */ jsxs(Stack, { direction: "row", alignItems: "center", justifyContent: "space-between", spacing: 1.5, sx: { flexWrap: "wrap", useFlexGap: true }, children: [
    /* @__PURE__ */ jsxs(Stack, { sx: { minWidth: 0 }, children: [
      /* @__PURE__ */ jsxs(Stack, { direction: "row", spacing: 1, alignItems: "center", children: [
        /* @__PURE__ */ jsx(Typography, { variant: "subtitle2", sx: { fontWeight: 600 }, children: label }),
        entity?.followed && /* @__PURE__ */ jsx(Chip, { size: "small", label: "Following", color: "primary" })
      ] }),
      /* @__PURE__ */ jsxs(Typography, { variant: "body2", sx: { color: "text.secondary", mt: 0.5 }, children: [
        stateLabel ?? "State unknown",
        " \xB7 ",
        trackedCamerasCopy(entity?.cameraIds),
        " ",
        trackedSeenCopy(entity?.lastSeenAt),
        untrackedClass ? ` \xB7 class "${entity.cls}"` : ""
      ] }),
      identities.length > 0 && /* @__PURE__ */ jsx(Stack, { direction: "row", spacing: 0.5, sx: { mt: 0.5, flexWrap: "wrap", rowGap: 0.5 }, children: identities.map((line, noteIndex) => /* @__PURE__ */ jsx(Chip, { size: "small", label: line }, noteIndex)) })
    ] }),
    /* @__PURE__ */ jsxs(Stack, { direction: "row", spacing: 1, alignItems: "center", children: [
      followable && /* @__PURE__ */ jsx(Button, { size: "small", variant: entity?.followed ? "outlined" : "contained", onClick: () => onFollowToggle(entity), children: followButtonLabel(entity?.followed) }),
      /* @__PURE__ */ jsx(Button, { size: "small", startIcon: /* @__PURE__ */ jsx(FlagOutlined, {}), color: flagFrom ? "warning" : "inherit", onClick: () => onFlag(entity), children: flagFrom === entity?.entityId ? FLAG_PENDING_LABEL : FLAG_BUTTON_LABEL })
    ] })
  ] }) });
}
function FollowedStream({ stream }) {
  if (!stream) return null;
  const stateLabel = trackedStateLabel(stream.state) ?? "State unknown";
  const clips = Array.isArray(stream.clips) ? stream.clips : [];
  return /* @__PURE__ */ jsxs(Paper, { variant: "outlined", sx: { p: 2 }, children: [
    /* @__PURE__ */ jsxs(Typography, { variant: "subtitle2", sx: { fontWeight: 600 }, children: [
      entityClassLabel(stream.cls) ?? "Tracked object",
      " now: ",
      stateLabel
    ] }),
    clips.length === 0 ? /* @__PURE__ */ jsx(EmptyLine, { children: "No recorded clips for this watch yet." }) : /* @__PURE__ */ jsx(Stack, { spacing: 0.75, sx: { mt: 1 }, children: clips.map((clip, index) => /* @__PURE__ */ jsx(Typography, { variant: "body2", sx: { color: "text.secondary" }, children: streamClipCopy(clip) }, index)) })
  ] });
}
function VisitTimeline({ entries, annotations, names }) {
  const groups = groupTimelineEntries(entries);
  const rowIdentity = (group) => names && annotations ? annotationLines(names, annotationsForTrackRow(annotations, group)) ?? [] : [];
  return /* @__PURE__ */ jsx(Stack, { spacing: 0.75, sx: { mt: 1 }, children: groups.map((group, index) => {
    const identities = rowIdentity(group);
    return /* @__PURE__ */ jsxs(Stack, { spacing: 0.25, children: [
      group.kind === "gap" ? (
        // The explained gap: the reason of record plus its span, visibly set
        // apart — nothing inside a gap is ever fabricated coverage.
        /* @__PURE__ */ jsxs(Stack, { direction: "row", spacing: 1, alignItems: "flex-start", sx: { bgcolor: "warning.main", opacity: 0.92, borderRadius: 1, p: 1 }, children: [
          /* @__PURE__ */ jsx(Typography, { variant: "body2", sx: { fontWeight: 600, whiteSpace: "nowrap", color: "warning.contrastText" }, children: "Gap" }),
          /* @__PURE__ */ jsx(Typography, { variant: "body2", sx: { color: "warning.contrastText" }, children: gapGroupCopy(group) })
        ] })
      ) : /* @__PURE__ */ jsx(Typography, { variant: "body2", sx: { pl: 1, fontWeight: group.kind !== "clip" ? 600 : void 0 }, children: group.kind !== "clip" ? timelineGroupCopy(group) : clipGroupCopy(group) }),
      identities.length > 0 && /* @__PURE__ */ jsx(Stack, { direction: "row", spacing: 0.5, sx: { pl: 1, flexWrap: "wrap", rowGap: 0.5 }, children: identities.map((line, noteIndex) => /* @__PURE__ */ jsx(Chip, { size: "small", label: line }, noteIndex)) })
    ] }, index);
  }) });
}
function VisitRow({ visit, onOpen, timeline, recognitions }) {
  const identities = recognitions?.names && recognitions?.annotations ? annotationLines(recognitions.names, annotationsForVisit(recognitions.annotations, visit)) ?? [] : [];
  return /* @__PURE__ */ jsxs(Paper, { variant: "outlined", sx: { p: 2 }, children: [
    /* @__PURE__ */ jsxs(Stack, { direction: "row", alignItems: "center", justifyContent: "space-between", spacing: 1.5, sx: { flexWrap: "wrap", useFlexGap: true }, children: [
      /* @__PURE__ */ jsxs(Stack, { sx: { minWidth: 0 }, children: [
        /* @__PURE__ */ jsx(Typography, { variant: "subtitle2", sx: { fontWeight: 600 }, children: visitWhoCopy(visit?.entities) }),
        /* @__PURE__ */ jsxs(Typography, { variant: "body2", sx: { color: "text.secondary", mt: 0.5 }, children: [
          visitWhereCopy(visit?.cameras),
          visit?.from && visit?.to ? ` \xB7 ${visit.from} \u2013 ${visit.to}` : ""
        ] }),
        identities.length > 0 && /* @__PURE__ */ jsx(Stack, { direction: "row", spacing: 0.5, sx: { mt: 0.5, flexWrap: "wrap", rowGap: 0.5 }, children: identities.map((line, noteIndex) => /* @__PURE__ */ jsx(Chip, { size: "small", label: line }, noteIndex)) })
      ] }),
      /* @__PURE__ */ jsx(Button, { size: "small", onClick: () => onOpen(visit), children: timeline ? "Hide timeline" : "Open timeline" })
    ] }),
    timeline && /* @__PURE__ */ jsx(
      VisitTimeline,
      {
        entries: timeline,
        annotations: recognitions?.annotations,
        names: recognitions?.names
      }
    )
  ] });
}
function Overwatch({ actions }) {
  const [state, setState] = useState(null);
  const [tracked, setTracked] = useState([]);
  const [visits, setVisits] = useState([]);
  const [audit, setAudit] = useState([]);
  const [error, setError] = useState("");
  const [cameraId, setCameraId] = useState("");
  const [draft, setDraft] = useState(null);
  const [closed, setDraftClosed] = useState(false);
  const [editorSaving, setEditorSaving] = useState(false);
  const [editorError, setEditorError] = useState("");
  const editorReset = () => {
    setDraft(null);
    setDraftClosed(false);
  };
  const [adjacencyError, setAdjacencyError] = useState("");
  const [dialError, setDialError] = useState("");
  const [trackedError, setTrackedError] = useState("");
  const [visitsError, setVisitsError] = useState("");
  const [flagFrom, setFlagFrom] = useState(null);
  const [streams, setStreams] = useState({});
  const [timelines, setTimelines] = useState({});
  const [recognitions, setRecognitions] = useState({ names: {}, annotations: [] });
  useEffect(() => {
    if (typeof actions.loadAnnotations !== "function" || typeof actions.loadHomes !== "function") return void 0;
    let stale = false;
    void (async () => {
      try {
        const homes = await actions.loadHomes();
        const homeId = (Array.isArray(homes?.homes) ? homes.homes : [])[0]?._id;
        if (!homeId || stale) return;
        const [notes, registry] = await Promise.all([actions.loadAnnotations(homeId), actions.loadEntries(homeId)]);
        if (!stale) setRecognitions({ names: namesByEntryId(registry?.entries), annotations: notes?.annotations ?? [] });
      } catch {
        if (!stale) setRecognitions({ names: {}, annotations: [] });
      }
    })();
    return () => {
      stale = true;
    };
  }, []);
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
      setAudit([]);
    }
  };
  useEffect(() => {
    void reload();
  }, []);
  const followedKey = tracked.filter((entity) => entity?.followed && entity?.entityId).map((entity) => entity.entityId).join("|");
  useEffect(() => {
    let stale = false;
    for (const entityId of followedKey ? followedKey.split("|") : []) {
      actions.loadEntityStream(entityId).then((stream) => {
        if (!stale) setStreams((current) => ({ ...current, [entityId]: stream ?? null }));
      }).catch(() => {
        if (!stale) setStreams((current) => ({ ...current, [entityId]: null }));
      });
    }
    return () => {
      stale = true;
    };
  }, [followedKey]);
  const zones = Array.isArray(state?.zones) ? state.zones : [];
  const viewBox = zoneViewBox(zones);
  const zoneByCamera = useMemo(
    () => new Map(zones.filter((zone) => zone?.cameraId).map((zone) => [zone.cameraId, zone])),
    [state]
    // eslint-disable-line react-hooks/exhaustive-deps — the map follows the state's zones
  );
  const cameras = Array.isArray(state?.cameras) ? state.cameras : [];
  const zoneOfCamera = (id) => zoneByCamera.get(id) ?? null;
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
  }, [state]);
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
  return /* @__PURE__ */ jsxs(Box, { sx: { maxWidth: 760, mx: "auto", px: { xs: 2, sm: 3 }, py: { xs: 2, sm: 3 }, pb: 12 }, children: [
    /* @__PURE__ */ jsx(Typography, { variant: "h4", sx: { mb: 0.5 }, children: "Overwatch" }),
    /* @__PURE__ */ jsx(Typography, { variant: "body2", sx: { color: "text.secondary" }, children: "Your cameras' shared ground, what moves across it, and how the view follows. Owner's surface \u2014 changes are audited." }),
    error && /* @__PURE__ */ jsx(Alert, { severity: "warning", sx: { mt: 2 }, children: error }),
    /* @__PURE__ */ jsx(SectionHeader, { title: "Property map" }),
    /* @__PURE__ */ jsx(
      OverwatchMap,
      {
        zones,
        viewBox,
        draft,
        cameraId,
        onCanvasPoint,
        onDraftVertexMove
      }
    ),
    /* @__PURE__ */ jsx(
      ZoneEditorControls,
      {
        cameras,
        cameraId,
        zone: zoneOfCamera(cameraId),
        draft,
        closed,
        saving: editorSaving,
        onPick: (next) => {
          setCameraId(next);
          editorReset();
        },
        onReset: editorReset,
        onSave: saveZone,
        onDelete: deleteZone
      }
    ),
    editorError && /* @__PURE__ */ jsx(Alert, { severity: "warning", sx: { mt: 1.5 }, children: editorError }),
    /* @__PURE__ */ jsx(UncoveredList, { cameras, zoneOfCamera, onPick: (next) => {
      setCameraId(next);
      editorReset();
    } }),
    /* @__PURE__ */ jsx(SectionHeader, { title: "Adjacency and travel time" }),
    /* @__PURE__ */ jsx(AdjacencyPanel, { state, suggestions, onSave: declared, onError: setAdjacencyError }),
    adjacencyError && /* @__PURE__ */ jsx(Alert, { severity: "warning", sx: { mt: 1.5 }, children: adjacencyError }),
    /* @__PURE__ */ jsx(SectionHeader, { title: "Dial" }),
    /* @__PURE__ */ jsx(DialControl, { dial: state?.dial, onSave: (frameRate) => actions.saveDial(frameRate), onError: setDialError }),
    dialError && /* @__PURE__ */ jsx(Alert, { severity: "warning", sx: { mt: 1.5 }, children: dialError }),
    /* @__PURE__ */ jsx(SectionHeader, { title: "Tracked now" }),
    trackedError && /* @__PURE__ */ jsx(Alert, { severity: "warning", sx: { mb: 1.5 }, children: trackedError }),
    /* @__PURE__ */ jsx(TrackedList, { entities: tracked, recognitions, onFollowToggle: followToggle, flagFrom, onFlag: flag }),
    flagFrom && /* @__PURE__ */ jsxs(Alert, { severity: "info", sx: { mt: 1.5 }, children: [
      FLAG_PENDING_LABEL,
      " \u2014 tap ",
      FLAG_BUTTON_LABEL.toLowerCase(),
      " on the second object to flag the association."
    ] }),
    followedList.length > 0 && /* @__PURE__ */ jsxs(Fragment, { children: [
      /* @__PURE__ */ jsx(SectionHeader, { title: "Followed" }),
      /* @__PURE__ */ jsx(Stack, { spacing: 1.5, children: followedList.map((entity) => /* @__PURE__ */ jsx(FollowedStream, { stream: streams[entity.entityId] }, entity.entityId)) })
    ] }),
    /* @__PURE__ */ jsx(SectionHeader, { title: "Visits" }),
    visitsError && /* @__PURE__ */ jsx(Alert, { severity: "warning", sx: { mb: 1.5 }, children: visitsError }),
    visits.length === 0 && /* @__PURE__ */ jsx(EmptyLine, { children: "No visits recorded in the window yet." }),
    /* @__PURE__ */ jsx(Stack, { spacing: 1.5, children: visits.map((visit) => /* @__PURE__ */ jsx(VisitRow, { visit, timeline: timelines[visit?.visitId], recognitions, onOpen: openVisit }, visit?.visitId)) }),
    /* @__PURE__ */ jsx(SectionHeader, { title: "Recent activity" }),
    audit.length === 0 && /* @__PURE__ */ jsx(EmptyLine, { children: "No Overwatch activity recorded yet." }),
    audit.map((row, index) => /* @__PURE__ */ jsxs(Typography, { variant: "body2", sx: { color: "text.secondary", py: 0.75 }, children: [
      auditLabel(row?.type),
      row?.at ? ` \xB7 ${relativeTime(row.at)}` : ""
    ] }, row?._id ?? index))
  ] });
}
export {
  DialLive,
  FollowedStream,
  Overwatch,
  OverwatchMap,
  TrackedList,
  UncoveredList,
  VisitTimeline
};
