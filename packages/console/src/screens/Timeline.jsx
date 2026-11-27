// Timeline screen (PORCH-130): browse recorded coverage by day and hour,
// play it continuously (clip chaining across hours within the day), seek
// on an hour scrubber with segment blocks and event markers, and see the
// event stream's own plain-language state. Every empty state is earned —
// loading never looks like a failure and a gap says what is missing.
import React, { useEffect, useMemo, useRef, useState } from "react";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Chip from "@mui/material/Chip";
import MenuItem from "@mui/material/MenuItem";
import Paper from "@mui/material/Paper";
import Stack from "@mui/material/Stack";
import TextField from "@mui/material/TextField";
import Tooltip from "@mui/material/Tooltip";
import Typography from "@mui/material/Typography";

import {
  dayDates,
  dayHours,
  eventMarkers,
  flattenSegments,
  formatClock,
  hourWindow,
  nextOf,
  offsetInSegment,
  segmentForAt,
} from "../timeline/model.js";

const ALL_CAMERAS = "all";
const EVENT_LIMIT = 200;

export default function Timeline({ api, cameras }) {
  const [cameraChoice, setCameraChoice] = useState(ALL_CAMERAS);
  const [daysByCamera, setDaysByCamera] = useState(null); // cameraId → days (null while loading)
  const [coverageError, setCoverageError] = useState("");
  const [date, setDate] = useState("");
  const [hour, setHour] = useState("");
  const [hourSegments, setHourSegments] = useState(null); // hour → { segments } (null while loading)
  const [segmentsError, setSegmentsError] = useState("");
  const [events, setEvents] = useState(null);
  const [bus, setBus] = useState(null); // { connected, url } | null
  const [eventsError, setEventsError] = useState("");
  const [src, setSrc] = useState("");
  const [current, setCurrentState] = useState(null); // the playing segment (render copy)
  const [mediaError, setMediaError] = useState("");
  const [note, setNote] = useState("");
  const [dragging, setDragging] = useState(false);

  const videoRef = useRef(null);
  const stripRef = useRef(null);
  const currentRef = useRef(null);
  const pendingRef = useRef(null); // offset to apply once the next clip's metadata arrives
  const draggingRef = useRef(false);

  const cameraName = (id) => cameras.find((camera) => camera.id === id)?.name || id;
  const camerasKey = cameras.map((camera) => camera.id).join("|");

  const coverageFor = (cameraId, day) =>
    dayHours((daysByCamera?.[cameraId] ?? []).find((row) => row.date === day));

  // In "All cameras" mode playback follows the first camera that has
  // something recorded that day; the rail below always shows every camera.
  const playbackCameraId =
    cameraChoice === ALL_CAMERAS
      ? cameras.find((camera) => coverageFor(camera.id, date)?.length)?.id ?? null
      : cameraChoice;

  const dates = useMemo(
    () => dayDates(Object.values(daysByCamera ?? {}).flat()),
    [daysByCamera],
  );
  const railHours = useMemo(() => {
    if (cameraChoice !== ALL_CAMERAS) return coverageFor(cameraChoice, date);
    const union = new Set();
    cameras.forEach((camera) => coverageFor(camera.id, date).forEach((h) => union.add(h)));
    return [...union].sort();
  }, [cameraChoice, date, cameras, daysByCamera]); // eslint-disable-line react-hooks/exhaustive-deps -- coverageFor derives from daysByCamera

  const view = hourWindow(date, hour);
  const daySegments = useMemo(
    () => flattenSegments(Object.values(hourSegments ?? {}).map((entry) => ({ segments: entry?.segments ?? [] }))),
    [hourSegments],
  );

  // --- coverage (days) ------------------------------------------------------

  useEffect(() => {
    let cancelled = false;
    setDaysByCamera(null);
    setCoverageError("");
    setDate("");
    setHour("");
    async function loadFor(cameraId) {
      const payload = await api.listRecordingDays(cameraId);
      return payload?.days ?? [];
    }
    (async () => {
      try {
        if (cameraChoice === ALL_CAMERAS) {
          const entries = await Promise.all(cameras.map(async (camera) => [camera.id, await loadFor(camera.id)]));
          if (!cancelled) setDaysByCamera(Object.fromEntries(entries));
        } else {
          const list = await loadFor(cameraChoice);
          if (!cancelled) setDaysByCamera({ [cameraChoice]: list });
        }
      } catch (failure) {
        if (!cancelled) setCoverageError(failure.message);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [api, cameraChoice, camerasKey]); // eslint-disable-line react-hooks/exhaustive-deps -- camerasKey stands in for the list identity

  // Newest day wins the default selection; a stale day resets the hour.
  useEffect(() => {
    if (dates.length === 0 || dates.includes(date)) return;
    setDate(dates[dates.length - 1]);
  }, [dates, date]);

  // Newest hour with recordings for the playable camera wins the default.
  useEffect(() => {
    if (!playbackCameraId || !date) return;
    const hours = coverageFor(playbackCameraId, date);
    if (hours.length > 0 && !hours.includes(hour)) setHour(hours[hours.length - 1]);
  }, [playbackCameraId, date, hour, daysByCamera]); // eslint-disable-line react-hooks/exhaustive-deps -- coverageFor derives from daysByCamera

  // --- the day's segments (for chaining + seeking) --------------------------

  useEffect(() => {
    if (!playbackCameraId || !date) {
      setHourSegments(null);
      return undefined;
    }
    let cancelled = false;
    setHourSegments(null);
    setSegmentsError("");
    const hours = coverageFor(playbackCameraId, date);
    Promise.all(
      hours.map(async (h) => [h, await api.listHourSegments({ cameraId: playbackCameraId, date, hour: h })]),
    )
      .then((entries) => {
        if (!cancelled) setHourSegments(Object.fromEntries(entries));
      })
      .catch((failure) => {
        if (!cancelled) setSegmentsError(failure.message);
      });
    return () => {
      cancelled = true;
    };
  }, [api, playbackCameraId, date, daysByCamera]); // eslint-disable-line react-hooks/exhaustive-deps -- coverageFor derives from daysByCamera

  // --- events for the visible hour -----------------------------------------

  useEffect(() => {
    if (!view) {
      setEvents(null);
      setBus(null);
      setEventsError("");
      return undefined;
    }
    let cancelled = false;
    setEvents(null);
    setEventsError("");
    api
      .listEvents({
        cameraId: cameraChoice === ALL_CAMERAS ? undefined : cameraChoice,
        from: view.start,
        to: view.end,
        limit: EVENT_LIMIT,
      })
      .then((payload) => {
        if (!cancelled) {
          setEvents(payload?.events ?? []);
          setBus(payload?.bus ?? null);
        }
      })
      .catch((failure) => {
        if (!cancelled) setEventsError(failure.message);
      });
    return () => {
      cancelled = true;
    };
  }, [api, cameraChoice, date, hour]); // eslint-disable-line react-hooks/exhaustive-deps -- view derives from date/hour

  // --- playback: load, chain, seek -----------------------------------------

  function loadSegment(segment, offset) {
    currentRef.current = segment;
    setCurrentState(segment);
    pendingRef.current = offset;
    setMediaError("");
    setSrc(api.mediaUrl(segment.path));
  }

  function onEnded() {
    const next = nextOf(daySegments, currentRef.current);
    if (next) {
      setNote("");
      loadSegment(next, 0);
      return;
    }
    setNote(`That is the end of the recordings for ${date}${playbackCameraId ? ` on ${cameraName(playbackCameraId)}` : ""}.`);
  }

  function onLoadedMetadata() {
    const element = videoRef.current;
    if (!element) return;
    if (pendingRef.current != null) {
      element.currentTime = pendingRef.current;
      pendingRef.current = null;
      element.play?.().catch(() => {}); // autoplay refusal is fine — the controls stay
    }
  }

  function atFromPointer(event) {
    const element = stripRef.current;
    if (!element || !view) return null;
    const rect = element.getBoundingClientRect();
    const ratio = Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width));
    return view.start + ratio * 3600;
  }

  function seekToAt(at) {
    if (at == null) return;
    const segment = segmentForAt(daySegments, at);
    if (!segment) {
      setNote(`Nothing recorded at ${formatClock(at - view.start)} on ${playbackCameraId ? cameraName(playbackCameraId) : "this camera"}.`);
      return;
    }
    setNote("");
    if (currentRef.current?.ref === segment.ref) {
      pendingRef.current = null;
      if (videoRef.current) videoRef.current.currentTime = offsetInSegment(segment, at);
    } else {
      loadSegment(segment, offsetInSegment(segment, at));
    }
  }

  function onStripPointerDown(event) {
    if (!view) return;
    event.currentTarget.setPointerCapture?.(event.pointerId);
    draggingRef.current = true;
    setDragging(true);
    seekToAt(atFromPointer(event));
  }

  function onStripPointerMove(event) {
    if (!draggingRef.current) return;
    seekToAt(atFromPointer(event));
  }

  function endDrag() {
    draggingRef.current = false;
    setDragging(false);
  }

  const markers = useMemo(() => {
    if (!view) return [];
    return eventMarkers(events ?? []).filter((marker) => marker.t >= view.start && marker.t < view.end);
  }, [events, view]);

  const blocks = useMemo(() => {
    if (!view) return [];
    return daySegments
      .filter((segment) => segment.end > view.start && segment.start < view.end)
      .map((segment) => ({
        ref: segment.ref,
        left: ((Math.max(segment.start, view.start) - view.start) / 3600) * 100,
        width: ((Math.min(segment.end, view.end) - Math.max(segment.start, view.start)) / 3600) * 100,
      }));
  }, [daySegments, view]);

  const pickCameraHour = (cameraId, pickedHour) => {
    if (cameraChoice !== cameraId) setCameraChoice(cameraId);
    if (pickedHour !== hour) setHour(pickedHour);
  };

  // --- render ---------------------------------------------------------------

  if (cameras.length === 0) {
    return <Typography color="text.secondary">No cameras are set up yet. Add one under the Cameras tab to see its timeline.</Typography>;
  }

  const daysLoading = daysByCamera === null && !coverageError;

  return (
    <Stack spacing={2}>
      <Paper variant="outlined" sx={{ p: 2, display: "flex", flexWrap: "wrap", gap: 2, alignItems: "center" }}>
        <TextField
          select
          size="small"
          label="Playback"
          value={cameraChoice}
          onChange={(event) => {
            setCameraChoice(event.target.value);
            setNote("");
          }}
          sx={{ minWidth: 220 }}
        >
          <MenuItem value={ALL_CAMERAS}>All cameras</MenuItem>
          {cameras.map((camera) => (
            <MenuItem key={camera.id} value={camera.id}>
              {camera.name || camera.id}
            </MenuItem>
          ))}
        </TextField>
        <Typography color="text.secondary" variant="body2" sx={{ mr: "auto" }}>
          {playbackCameraId ? `Playing ${cameraName(playbackCameraId)}` : "Choose a camera with recordings."}
        </Typography>
      </Paper>

      {coverageError && (
        <Typography color="error">{coverageError}</Typography>
      )}
      {daysLoading && <Typography color="text.secondary">Loading recordings…</Typography>}
      {!coverageError && !daysLoading && dates.length === 0 && (
        <Typography color="text.secondary">No recordings yet. Once a camera starts recording, its days appear here.</Typography>
      )}

      {dates.length > 0 && (
        <Stack direction="row" spacing={1} sx={{ flexWrap: "wrap", gap: 1 }}>
          {dates.map((d) => (
            <Chip
              key={d}
              label={d}
              color={d === date ? "primary" : "default"}
              variant={d === date ? "filled" : "outlined"}
              onClick={() => setDate(d)}
            />
          ))}
        </Stack>
      )}

      {cameraChoice === ALL_CAMERAS && date && (
        <Paper variant="outlined" sx={{ p: 2 }}>
          <Typography variant="subtitle2" sx={{ mb: 1 }}>
            Coverage on {date}
          </Typography>
          <Stack spacing={1}>
            {cameras.map((camera) => {
              const hours = coverageFor(camera.id, date);
              return (
                <Stack key={camera.id} direction="row" spacing={1} sx={{ alignItems: "center", flexWrap: "wrap", gap: 1 }}>
                  <Typography variant="body2" sx={{ minWidth: 140 }}>
                    {camera.name || camera.id}
                  </Typography>
                  {hours.length === 0 ? (
                    <Typography variant="body2" color="text.secondary">
                      Nothing recorded that day.
                    </Typography>
                  ) : (
                    hours.map((h) => (
                      <Chip
                        key={h}
                        label={h}
                        size="small"
                        color={h === hour && playbackCameraId === camera.id ? "primary" : "default"}
                        variant={h === hour && playbackCameraId === camera.id ? "filled" : "outlined"}
                        onClick={() => pickCameraHour(camera.id, h)}
                      />
                    ))
                  )}
                </Stack>
              );
            })}
          </Stack>
        </Paper>
      )}

      {date && railHours.length > 0 && (
        <Stack direction="row" spacing={1} sx={{ flexWrap: "wrap", gap: 1, alignItems: "center" }}>
          <Typography variant="body2" color="text.secondary">
            Hour:
          </Typography>
          {railHours.map((h) => (
            <Chip
              key={h}
              label={h}
              color={h === hour ? "primary" : "default"}
              variant={h === hour ? "filled" : "outlined"}
              onClick={() => setHour(h)}
            />
          ))}
        </Stack>
      )}

      {date && hour && (
        <Paper variant="outlined" sx={{ p: 2 }}>
          <Stack spacing={1.5}>
            <Typography variant="body2" color="text.secondary">
              {date} {hour}:00 — click or drag on the strip to seek; marks are moments the engine flagged.
            </Typography>
            <Box
              ref={stripRef}
              role="slider"
              aria-label="Hour timeline"
              aria-valuemin={0}
              aria-valuemax={3600}
              tabIndex={0}
              sx={{
                position: "relative",
                height: 48,
                borderRadius: 1,
                bgcolor: "action.hover",
                cursor: view ? "pointer" : "default",
                touchAction: "none",
              }}
              onPointerDown={onStripPointerDown}
              onPointerMove={onStripPointerMove}
              onPointerUp={endDrag}
              onPointerCancel={endDrag}
            >
              {blocks.map((block) => (
                <Box
                  key={block.ref}
                  sx={{
                    position: "absolute",
                    top: 6,
                    height: 36,
                    left: `${block.left}%`,
                    width: `${block.width}%`,
                    minWidth: 2,
                    borderRadius: 0.5,
                    bgcolor: "primary.light",
                  }}
                />
              ))}
              {markers.map((marker) => (
                <Tooltip key={`${marker.t}|${marker.cls}|${marker.source}|${marker.camera ?? ""}`} title={`${marker.cls} at ${formatClock(marker.t - view.start)}${marker.camera ? ` — ${cameraName(marker.camera)}` : ""}${marker.source === "audio" ? " (audio)" : ""}`}>
                  <Box
                    sx={{
                      position: "absolute",
                      top: 4,
                      height: 12,
                      width: marker.source === "audio" ? 10 : 4,
                      borderRadius: marker.source === "audio" ? "50%" : 0.5,
                      left: `calc(${((marker.t - view.start) / 3600) * 100}% - 2px)`,
                      bgcolor: marker.source === "audio" ? "secondary.main" : "warning.main",
                      cursor: "pointer",
                    }}
                    onClick={(event) => {
                      event.stopPropagation();
                      seekToAt(marker.t);
                    }}
                  />
                </Tooltip>
              ))}
            </Box>
            {bus ? (
              <Typography variant="body2" color={bus.connected ? "text.secondary" : "text.secondary"}>
                {bus.connected ? "Live events are connected and updating as they happen." : "Live events are not connected right now — marks above are from the last fetch."}
              </Typography>
            ) : (
              <Typography variant="body2" color="text.secondary">
                Loading events…
              </Typography>
            )}
            {eventsError && <Typography variant="body2" color="error">{eventsError}</Typography>}
            {note && (
              <Typography variant="body2" color="text.secondary">
                {note}
              </Typography>
            )}
            {segmentsError && <Typography variant="body2" color="error">{segmentsError}</Typography>}
          </Stack>
        </Paper>
      )}

      {date && railHours.length > 0 && hourSegments === null && (
        <Typography color="text.secondary">Loading that hour…</Typography>
      )}
      {date && hour && hourSegments !== null && daySegments.filter((segment) => view && segment.start < view.end && segment.end > view.start).length === 0 && (
        <Typography color="text.secondary">Nothing recorded that hour.</Typography>
      )}

      {current && (
        <Paper variant="outlined" sx={{ p: 2 }}>
          <Stack spacing={1}>
            <video
              ref={videoRef}
              controls
              playsInline
              src={src}
              onEnded={onEnded}
              onError={() => setMediaError("That clip could not load — the recordings may be unreachable right now. Try another moment or refresh.")}
              onLoadedMetadata={onLoadedMetadata}
              style={{ width: "100%", bgcolor: "#000" }}
            />
            <Typography variant="body2" color="text.secondary">
              {current.start === current.end
                ? "An empty clip — nothing plays."
                : `${date} ${formatClock(current.start)} — ${formatClock(current.end)} UTC on ${playbackCameraId ? cameraName(playbackCameraId) : "this camera"}. Clips continue automatically into the next recorded one.`}
            </Typography>
            {mediaError && <Typography variant="body2" color="error">{mediaError}</Typography>}
          </Stack>
        </Paper>
      )}
    </Stack>
  );
}
