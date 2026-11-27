// Status (PORCH-130): the system's health rows in plain language — the
// engine itself, the recorder + stream services from the engine seam, and
// the engine's storage state. Every row earns its words: a row is either
// loading ("checking…"), carrying the server's own detail, or saying
// outright that the endpoint could not be reached. Nothing is silent.
import React, { useEffect, useCallback, useState } from "react";
import Button from "@mui/material/Button";
import Chip from "@mui/material/Chip";
import Paper from "@mui/material/Paper";
import Stack from "@mui/material/Stack";
import Typography from "@mui/material/Typography";

// The row's severity: healthy states stay green, known reduced states warn,
// and anything unrecognized counts as down — an unknown state never gets
// to wear the healthy badge.
const SEVERITY = (state) => {
  if (["ok", "healthy", "running", "connected", "primary", "available"].includes(state)) return "success";
  if (["degraded", "degraded-write", "failover", "fallback", "restarting"].includes(state)) return "warning";
  return "error";
};

const BADGE = (state) => {
  if (SEVERITY(state) === "success") return "In working order";
  if (SEVERITY(state) === "warning") return "Degraded";
  return "Unavailable";
};

function StateRow({ label, loading, state, detail }) {
  return (
    <Stack direction="row" spacing={2} sx={{ alignItems: "baseline", flexWrap: "wrap", gap: 1 }}>
      <Typography variant="subtitle2" sx={{ minWidth: 150 }}>
        {label}
      </Typography>
      {loading ? (
        <Typography color="text.secondary" variant="body2">
          Checking…
        </Typography>
      ) : (
        <Chip size="small" color={SEVERITY(state)} label={BADGE(state)} />
      )}
      {detail && !loading && (
        <Typography variant="body2" color="text.secondary" sx={{ mr: "auto" }}>
          {detail}
        </Typography>
      )}
    </Stack>
  );
}

export default function Status({ api }) {
  const [health, setHealth] = useState(null); // { state, detail } — or { failed: true, message }
  const [services, setServices] = useState(null); // array of { label, state, detail } — or failed
  const [storage, setStorage] = useState(null);

  const refresh = useCallback(async () => {
    setHealth(null);
    setServices(null);
    setStorage(null);
    try {
      const doc = await api.getHealth();
      setHealth({ state: String(doc?.state ?? doc?.status ?? "ok"), detail: doc?.detail ?? doc?.reason ?? "" });
    } catch (failure) {
      setHealth({ failed: true, message: failure.message });
    }
    try {
      const doc = await api.getService();
      const rows = Array.isArray(doc?.services) && doc.services.length > 0
        ? doc.services
        : [{ label: "Services", state: doc?.state ?? "unknown", detail: doc?.detail ?? "" }];
      setServices(rows.map((row) => ({ label: row?.name || row?.id || "Service", state: String(row?.state ?? "unknown"), detail: row?.detail ?? "" })));
    } catch (failure) {
      setServices({ failed: true, message: failure.message });
    }
    try {
      const doc = await api.getSystemStorage();
      setStorage({ state: String(doc?.state ?? "unknown"), detail: doc?.detail ?? doc?.reason ?? "" });
    } catch (failure) {
      setStorage({ failed: true, message: failure.message });
    }
  }, [api]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const rowState = (entry) => (entry?.failed ? "unreachable" : entry?.state ?? "unknown");
  const rowDetail = (entry) => (entry?.failed ? entry.message : entry?.detail ?? "");

  return (
    <Stack spacing={2}>
      <Paper variant="outlined" sx={{ p: 2 }}>
        <Stack direction="row" spacing={2} sx={{ alignItems: "center", mb: 1.5 }}>
          <Typography variant="subtitle1" sx={{ mr: "auto" }}>
            Status
          </Typography>
          <Button size="small" variant="outlined" onClick={refresh}>
            Refresh
          </Button>
        </Stack>
        <Stack spacing={1.5}>
          <StateRow
            label="Engine"
            loading={!health}
            state={rowState(health)}
            detail={rowDetail(health)}
          />
          {Array.isArray(services)
            ? services.map((row, index) => (
                <StateRow key={index} label={row.label} loading={false} state={row.state} detail={row.detail} />
              ))
            : <StateRow label="Services" loading={!services} state={rowState(services)} detail={rowDetail(services)} />}
          <StateRow
            label="Storage"
            loading={!storage}
            state={rowState(storage)}
            detail={rowDetail(storage)}
          />
        </Stack>
      </Paper>
    </Stack>
  );
}
