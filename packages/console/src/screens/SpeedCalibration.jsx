// Speed calibration (PORCH-135 ac-3): click the calibration line's two
// endpoints on the snapshot, enter the real-world line length in meters,
// then test with a sample track. The result is always an estimate — it is
// labeled "Estimate" with a quality chip carrying the grade and the
// pixels-per-meter the estimate rests on.
import React, { useEffect, useState } from "react";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Chip from "@mui/material/Chip";
import Paper from "@mui/material/Paper";
import Stack from "@mui/material/Stack";
import TextField from "@mui/material/TextField";
import Typography from "@mui/material/Typography";

const SAMPLE_TRACK = JSON.stringify(
  [
    { t: 0, px: 25, py: 50 },
    { t: 0.5, px: 40, py: 50 },
    { t: 1, px: 55, py: 50 },
    { t: 1.5, px: 70, py: 50 },
  ],
  null,
  2,
);

const QUALITY_COLOR = { good: "success", fair: "warning", poor: "error" };

export default function SpeedCalibration({ camera, api }) {
  const [speed, setSpeed] = useState(null);
  const [line, setLine] = useState(null); // { p1, p2 } in percent
  const [meters, setMeters] = useState("");
  const [area, setArea] = useState(null);
  const [nextEndpoint, setNextEndpoint] = useState(1); // 1 → p1 next, 2 → p2 next
  const [trackText, setTrackText] = useState(SAMPLE_TRACK);
  const [result, setResult] = useState(null);
  const [error, setError] = useState("");
  const [snapshotKey, setSnapshotKey] = useState(0);
  const [hadStored, setHadStored] = useState(false);

  useEffect(() => {
    if (!camera) {
      setSpeed(null);
      setLine(null);
      setArea(null);
      return undefined;
    }
    let cancelled = false;
    api
      .getSpeed(camera.id)
      .then((stored) => {
        if (cancelled || !stored) return;
        setSpeed(stored);
        setHadStored(Boolean(stored.line || stored.area));
        setLine(stored.line ?? null);
        setArea(stored.area ?? null);
        setMeters(stored.meters != null ? String(stored.meters) : "");
        setNextEndpoint(1);
        setError("");
      })
      .catch((failure) => {
        if (!cancelled) setError(failure.message);
      });
    return () => {
      cancelled = true;
    };
  }, [api, camera?.id]); // eslint-disable-line react-hooks/exhaustive-deps -- camera id is the trigger

  if (!camera) {
    return <Typography color="text.secondary">Select a camera to calibrate speed.</Typography>;
  }

  function clickSurface(point) {
    setLine((current) => {
      const next = { ...(current ?? { p1: null, p2: null }) };
      if (nextEndpoint === 1) {
        next.p1 = point;
        setNextEndpoint(2);
      } else {
        next.p2 = point;
        setNextEndpoint(1);
      }
      return next;
    });
  }

  async function saveCalibration() {
    try {
      // A first-time calibration starts enabled; omit area when none is set
      // (the server treats it as optional upsert fields).
      const payload = {
        enabled: hadStored ? (speed?.enabled ?? true) : true,
        line,
        meters: Number(meters),
      };
      const storedArea = speed?.area ?? area;
      if (storedArea != null) payload.area = storedArea;
      const stored = await api.putSpeed(camera.id, payload);
      setSpeed(stored ?? payload);
      setHadStored(true);
      setError("");
    } catch (failure) {
      setError(failure.message);
    }
  }

  async function runTest() {
    let track;
    try {
      track = JSON.parse(trackText);
    } catch {
      setError("The sample track is not valid JSON — expected rows like {\"t\": 1, \"px\": 40, \"py\": 50}.");
      return;
    }
    try {
      setResult(await api.testSpeed(camera.id, track));
      setError("");
    } catch (failure) {
      setResult(null);
      setError(failure.message);
    }
  }

  const points = [
    ...(area ?? []).map((point) => ({ point, role: "area" })),
    ...(line?.p1 ? [{ point: line.p1, role: "line" }] : []),
    ...(line?.p2 ? [{ point: line.p2, role: "line" }] : []),
  ];

  return (
    <Stack spacing={2}>
      <Typography variant="body1">
        Set the calibration line over a known distance on the ground, enter its real-world length in meters, and test
        with a sample track. Every speed result is an estimate.
      </Typography>
      {error && <Typography color="error">{error}</Typography>}

      <Paper variant="outlined" sx={{ p: 2, display: "flex", flexWrap: "wrap", gap: 2, alignItems: "center" }}>
        <Chip
          size="small"
          label={nextEndpoint === 1 ? "Click the snapshot: first line endpoint" : "Click the snapshot: second line endpoint"}
        />
        {line?.p1 && (
          <Chip size="small" variant="outlined" label={`p1 ${line.p1.map((v) => v.toFixed(1)).join(", ")}`} onDelete={() => setLine({ ...line, p1: null })} />
        )}
        {line?.p2 && (
          <Chip size="small" variant="outlined" label={`p2 ${line.p2.map((v) => v.toFixed(1)).join(", ")}`} onDelete={() => setLine({ ...line, p2: null })} />
        )}
        <TextField size="small" label="Line length (meters)" type="number" inputProps={{ min: 0, step: "0.1" }} value={meters} onChange={(event) => setMeters(event.target.value)} sx={{ width: 180 }} />
        <Button
          variant="contained"
          disabled={!line?.p1 || !line?.p2 || !(Number(meters) > 0)}
          onClick={saveCalibration}
        >
          Save calibration
        </Button>
        <Button size="small" onClick={() => setSnapshotKey((key) => key + 1)}>
          Refresh snapshot
        </Button>
      </Paper>

      <Box
        sx={{ position: "relative", width: "fit-content", maxWidth: "100%", lineHeight: 0 }}
        onClick={(event) => {
          const rect = event.currentTarget.getBoundingClientRect();
          clickSurface([
            Math.min(100, Math.max(0, (100 * (event.clientX - rect.left)) / rect.width)),
            Math.min(100, Math.max(0, (100 * (event.clientY - rect.top)) / rect.height)),
          ]);
        }}
      >
        <img
          key={snapshotKey}
          src={api.cameraSnapshotUrl(camera.id, camera.width)}
          alt={`${camera.name || camera.id} snapshot`}
          draggable={false}
          style={{ display: "block", maxWidth: "100%", width: 720, cursor: "crosshair" }}
        />
        <Box
          component="svg"
          viewBox="0 0 100 100"
          preserveAspectRatio="none"
          sx={{ position: "absolute", inset: 0, width: "100%", height: "100%", pointerEvents: "none" }}
        >
          {area?.length >= 3 && (
            <polygon
              points={area.map((point) => point.join(",")).join(" ")}
              fill="rgba(21,101,192,0.18)"
              stroke="#1565C0"
              strokeWidth={1.5}
              vectorEffect="non-scaling-stroke"
            />
          )}
          {line?.p1 && line?.p2 && (
            <line
              x1={line.p1[0]}
              y1={line.p1[1]}
              x2={line.p2[0]}
              y2={line.p2[1]}
              stroke="#1565C0"
              strokeWidth={3}
              vectorEffect="non-scaling-stroke"
            />
          )}
          {points.map(({ point, role }, index) => (
            <circle
              key={`${role}-${index}`}
              cx={point[0]}
              cy={point[1]}
              r={2}
              fill="#1565C0"
              stroke="#fff"
              strokeWidth={0.5}
              vectorEffect="non-scaling-stroke"
            />
          ))}
        </Box>
      </Box>

      <Paper variant="outlined" sx={{ p: 2, display: "flex", flexWrap: "wrap", gap: 2 }}>
        <TextField
          label="Sample track — rows of { t: seconds, px & py: percent frame coords }"
          multiline
          rows={6}
          value={trackText}
          onChange={(event) => setTrackText(event.target.value)}
          sx={{ flex: 1, minWidth: 320, fontFamily: "monospace" }}
        />
        <Stack spacing={2} sx={{ minWidth: 260 }}>
          <Button variant="contained" onClick={runTest} disabled={!trackText.trim()}>
            Run test
          </Button>
          {result && (
            <Stack spacing={1}>
              <Stack direction="row" spacing={1} alignItems="center">
                <Chip color={QUALITY_COLOR[result.quality?.grade] ?? "default"} label={`Estimate · ${result.quality?.grade ?? "?"}`} />
                <Typography variant="body2">
                  {result.quality?.pxPerMeter != null ? `${Number(result.quality.pxPerMeter).toFixed(1)} px per meter` : ""}
                </Typography>
              </Stack>
              <Typography variant="body2">
                Estimated speed: {result.speedMps != null ? `${Number(result.speedMps).toFixed(2)} m/s` : "unavailable"}
              </Typography>
            </Stack>
          )}
          <Typography variant="body2" color="text.secondary">
            The estimate reads the track in percent frame coords, converts the traveled distance to pixels at the
            stream resolution, divides by the calibration line&apos;s pixels-per-meter, and divides by elapsed time.
          </Typography>
        </Stack>
      </Paper>
    </Stack>
  );
}
