// PORCH-137: the Porchlight Home tab. One screen, one hub's homes — the
// home switcher swaps EVERYTHING below it (areas, devices, scenes,
// automations, recent activity); rooms and outdoor areas group separately;
// device controls render the hub's confirmed last-known state only (the
// anti-optimism rule is home-model.js's `renderedControlValue` — a tap never
// flips a switch visually; loading/confirmed/failed are three distinct
// states); recent activity walks the audit window with Load more. Pure
// logic and copy ride home-model.js; the wire rides home-actions.js through
// the shared actions object.
import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  Alert, Box, Button, Checkbox, Chip, CircularProgress, Dialog, DialogActions, DialogContent,
  DialogTitle, Divider, FormControl, FormControlLabel, IconButton, InputLabel, MenuItem, Paper,
  Select, Stack, Switch, TextField, Tooltip, Typography,
} from "@mui/material";
import AddOutlined from "@mui/icons-material/AddOutlined";
import CheckCircleOutlined from "@mui/icons-material/CheckCircleOutlined";
import PlayArrowOutlined from "@mui/icons-material/PlayArrowOutlined";
import RefreshOutlined from "@mui/icons-material/RefreshOutlined";
import { dateOf, relativeTime } from "./time.js";
import {
  alertCopy, eventEvidence, feedPlayState, gapCopy, healthNotes,
  inlineAspectRatio, mediaUrl, viewerAspectRatio,
} from "./camera-model.js";
import {
  automationTriggerLabel, commandReasonOf, commandStatusOf, groupDevicesByArea,
  grantStatusLabel, isVisitorAccess, nextCommandState, readActiveHomeId,
  renderedControlValue, summarizeScopes, writeActiveHomeId,
} from "./home-model.js";
// PORCH-141: recognized identities decorate the camera-activity events — the
// by-reference annotation join is people-model.js's of record.
import { annotationsForEvent, annotationLines, namesByEntryId } from "./people-model.js";

const messageOf = (error) => error?.message || "That did not work. Please try again.";

function originOf(serverUrl) {
  try {
    return serverUrl ? new URL(serverUrl).origin : null;
  } catch {
    return null;
  }
}

// Per-capability controls: a device carrying switch/light renders on/off.
const CONTROL_CAPABILITIES = ["switch", "light"];
const hasControl = (device) => device.capabilities.some((capability) => CONTROL_CAPABILITIES.includes(capability));
const controllableOf = (devices) => devices.filter(hasControl);

const COMMAND_LABELS = { turnOn: "Turn on", turnOff: "Turn off" };
const commandLabel = (command) => COMMAND_LABELS[command] ?? command;

const EVENT_CLASSES = ["vehicle", "person", "animal", "button", "door"];

// Membership is the first access class of record (PORCH-138); the home row
// and the detail both carry it — read through the access block, falling back
// to the PORCH-137 role field both keep.
const ownerOf = (home) => home?.access?.role === "owner" || home?.role === "owner";

const AUDIT_LABELS = {
  "home.created": "Home created",
  "home.renamed": "Home renamed",
  "area.created": "Area added",
  "area.renamed": "Area renamed",
  "device.registered": "Device added",
  "device.updated": "Device updated",
  "device.read": "Device status read",
  "device.command": "Device command",
  "scene.created": "Scene created",
  "scene.run": "Scene run",
  "automation.created": "Automation created",
  "automation.updated": "Automation updated",
  // PORCH-138 access events
  "grant": "Visit granted",
  "family-distribute": "Family share set",
  "revoke": "Visit ended",
};
const auditLabel = (type) => AUDIT_LABELS[type] ?? String(type || "Event").replace(/[._-]+/g, " ").replace(/^./, (c) => c.toUpperCase());

const AUDIT_LIMIT = 10;
const CONFIRMED_HOLD_MS = 2200;

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

/** One action-row editor shared by the scene and automation dialogs: a
 * device pick plus what that device should do, one row per step. */
function ActionRows({ devices, rows, setRows }) {
  const setRow = (index, patch) =>
    setRows(rows.map((row, at) => (at === index ? { ...row, ...patch } : row)));
  return (
    <Stack spacing={1.5}>
      {rows.length === 0 && <EmptyLine>No actions picked yet — add one below.</EmptyLine>}
      {rows.map((row, index) => (
        <Stack key={index} direction={{ xs: "column", sm: "row" }} spacing={1.5} alignItems={{ sm: "center" }}>
          <Select
            size="small"
            value={row.deviceId}
            displayEmpty
            onChange={(event) => setRow(index, { deviceId: event.target.value, command: "turnOn" })}
            sx={{ minWidth: { xs: "100%", sm: 200 } }}
          >
            <MenuItem value="" disabled><em>Pick a device</em></MenuItem>
            {devices.map((device) => (
              <MenuItem key={device._id} value={device._id}>{device.name}</MenuItem>
            ))}
          </Select>
          <Select
            size="small"
            value={row.command}
            displayEmpty
            onChange={(event) => setRow(index, { command: event.target.value })}
            sx={{ minWidth: { xs: "100%", sm: 160 } }}
          >
            <MenuItem value="" disabled><em>What it does</em></MenuItem>
            <MenuItem value="turnOn">Turn on</MenuItem>
            <MenuItem value="turnOff">Turn off</MenuItem>
          </Select>
          <Button size="small" onClick={() => setRows(rows.filter((_row, at) => at !== index))}>Remove</Button>
        </Stack>
      ))}
      <Box>
        <Button
          size="small"
          startIcon={<AddOutlined />}
          disabled={!devices.length}
          onClick={() => setRows([...rows, { deviceId: "", command: "" }])}
        >
          Add action
        </Button>
      </Box>
    </Stack>
  );
}

/** One device card: identity chips, the hub's confirmed last-known state and
 * its read time, the stale label with its reason, and the on/off controls
 * bound to the command machine. */
function DeviceRow({ view, command, onCommand, onRefresh }) {
  const loading = command.status === "loading";
  const confirmed = command.status === "confirmed";
  const failed = command.status === "failed";
  // The rendered on/off value: the device row's confirmed last-known state,
  // NEVER the clicked intent (the model refuses to consult it, so an
  // optimistic flip is impossible by construction).
  const rendered = renderedControlValue(view.raw, command.pendingCommand);
  const controls = view.capabilities.some((capability) => CONTROL_CAPABILITIES.includes(capability));
  return (
    <Paper
      elevation={0}
      sx={{
        p: 2, borderRadius: 3, bgcolor: "var(--porch-surface)",
        border: "1px solid",
        borderColor: failed || view.stale ? "error.main" : "var(--porch-border)",
      }}
    >
      <Stack direction="row" alignItems="flex-start" justifyContent="space-between" spacing={1}>
        <Box sx={{ minWidth: 0 }}>
          <Typography variant="subtitle1" sx={{ fontWeight: 600 }}>{view.name}</Typography>
          <Stack direction="row" spacing={0.75} sx={{ mt: 0.75, flexWrap: "wrap", rowGap: 0.75 }}>
            {view.capabilities.map((capability) => (
              <Chip key={capability} label={capability} size="small" variant="outlined" sx={{ height: 22, fontSize: 12 }} />
            ))}
            {!view.capabilities.length && (
              <Chip label="No capabilities" size="small" variant="outlined" sx={{ height: 22, fontSize: 12, color: "text.muted" }} />
            )}
          </Stack>
        </Box>
        <Tooltip title="Read this device's current status">
          <IconButton size="small" onClick={onRefresh} aria-label={`Refresh ${view.name}`}>
            <RefreshOutlined fontSize="small" />
          </IconButton>
        </Tooltip>
      </Stack>
      <Typography variant="body2" sx={{ mt: 1.5, color: view.stateText === "Unknown" ? "text.muted" : "text.primary" }}>
        {view.stateText === "Unknown"
          ? "No status yet — refresh to ask the device."
          : `${view.stateText} · read ${view.asOf || dateOf(view.stateConfirmedAt) || "recently"}`}
      </Typography>
      {view.stale && (
        <Typography variant="body2" sx={{ mt: 0.5, color: "error.main" }}>
          {view.staleLabel}
        </Typography>
      )}
      {failed && (
        <Typography variant="body2" sx={{ mt: 0.5, color: "error.main" }}>
          {command.reason || "The device did not respond."}
        </Typography>
      )}
      {(controls || loading || confirmed) && (
        <Stack direction="row" spacing={1.5} alignItems="center" sx={{ mt: 1.5, flexWrap: "wrap", rowGap: 1 }}>
          {controls && (
            <>
              <Button size="small" variant={rendered === true ? "contained" : "outlined"} disabled={loading} onClick={() => onCommand("turnOn")}>
                Turn on
              </Button>
              <Button size="small" variant={rendered === false ? "contained" : "outlined"} disabled={loading} onClick={() => onCommand("turnOff")}>
                Turn off
              </Button>
            </>
          )}
          {loading && (
            <Stack direction="row" spacing={1} alignItems="center" sx={{ color: "text.secondary" }}>
              <CircularProgress size={16} color="inherit" />
              <Typography variant="body2" sx={{ color: "text.secondary" }}>Sending to the device…</Typography>
            </Stack>
          )}
          {confirmed && (
            <Stack direction="row" spacing={0.75} alignItems="center">
              <CheckCircleOutlined fontSize="small" sx={{ color: "var(--porch-vote-up)" }} />
              <Typography variant="body2" sx={{ color: "var(--porch-vote-up)" }}>Done</Typography>
            </Stack>
          )}
        </Stack>
      )}
    </Paper>
  );
}

function AreaSection({ groups, empty, renderCard }) {
  return (
    <Box>
      {groups.length === 0 && <EmptyLine>{empty}</EmptyLine>}
      {groups.map(({ area, devices }) => (
        <Box key={area._id ?? area.name} sx={{ mb: 2.5 }}>
          <Typography variant="subtitle2" sx={{ color: "text.secondary", mb: 1 }}>
            {area.name}
          </Typography>
          {devices.length === 0
            ? <EmptyLine>No devices here yet.</EmptyLine>
            : (
              <Box sx={{ display: "grid", gap: 1.5, gridTemplateColumns: { xs: "1fr", sm: "repeat(auto-fill, minmax(300px, 1fr))" } }}>
                {devices.map((view) => renderCard(view))}
              </Box>
            )}
        </Box>
      ))}
    </Box>
  );
}

// --- access (PORCH-138) -----------------------------------------------------

/** One checkbox row per surface of the home in the grant dialog: tick a
 * resource, then say how far the verbs go — see only, or see and control. */
function ScopePickRows({ title, noneText, rows, picks, setPicks }) {
  const setPick = (resourceRef, picked) =>
    setPicks((current) => {
      const next = { ...current };
      if (picked) next[resourceRef] = "view";
      else delete next[resourceRef];
      return next;
    });
  return (
    <Box sx={{ mt: 1.5 }}>
      <Typography variant="subtitle2">{title}</Typography>
      {rows.length === 0 ? (
        <Typography variant="body2" sx={{ color: "text.muted", py: 0.5 }}>{noneText}</Typography>
      ) : (
        <Stack spacing={0.5} sx={{ mt: 0.5 }}>
          {rows.map((row) => (
            <Stack key={row._id} direction="row" spacing={1.5} alignItems="center" sx={{ flexWrap: "wrap", rowGap: 0.5 }}>
              <FormControlLabel
                control={<Checkbox checked={Boolean(picks[row._id])} onChange={(event) => setPick(row._id, event.target.checked)} />}
                label={row.name}
                sx={{ "& .MuiTypography-body1": { fontSize: 14 } }}
              />
              {Boolean(picks[row._id]) && (
                <Select size="small" value={picks[row._id]} sx={{ minWidth: 170 }} aria-label={`How much for ${row.name}`}
                  onChange={(event) => setPicks((current) => ({ ...current, [row._id]: event.target.value }))}
                >
                  <MenuItem value="view">Can see</MenuItem>
                  <MenuItem value="both">Can see and control</MenuItem>
                </Select>
              )}
            </Stack>
          ))}
        </Stack>
      )}
    </Box>
  );
}

/** The visit card on the owner's Access surface: who, what reach, until when,
 * and the state chip. A family visit also carries the acting parent's
 * per-member distribution editor — the server refuses any hand-out that
 * escapes the envelope, and its refusal renders inline, verbatim. */
function GrantRow({
  grant, devices, areas, scenes, myDid, families,
  onRevoke, onDistribute, busy, distributionError,
}) {
  const summary = summarizeScopes(grant.scopes, devices, areas, scenes).join(" · ") || "Nothing named.";
  const status = grantStatusLabel(grant, null);
  const family = families.find((row) => row._id === grant.familyRef) ?? null;
  const isParent = Boolean(family?.parentIdentityRefs?.includes(myDid));
  const distribution = grant.parentDistributions ?? [];
  const ended = status !== "Live";

  return (
    <Paper elevation={0} sx={{ p: 2, mb: 1.25, borderRadius: 3, bgcolor: "var(--porch-surface)", border: "1px solid", borderColor: "var(--porch-border)" }}>
      <Stack direction={{ xs: "column", sm: "row" }} alignItems={{ xs: "flex-start", sm: "center" }} justifyContent="space-between" spacing={1}>
        <Box sx={{ minWidth: 0 }}>
          <Stack direction="row" spacing={1} alignItems="center" sx={{ flexWrap: "wrap", rowGap: 0.75 }}>
            <Typography variant="subtitle1" sx={{ fontWeight: 600 }}>
              {grant.createdFor || (grant.familyRef ? "A family visit" : "A visit")}
            </Typography>
            <Chip
              label={grant.familyRef ? "Family visit" : "Visit"}
              size="small"
              variant="outlined"
              sx={{ height: 22, fontSize: 12 }}
            />
            <Chip
              label={status}
              size="small"
              sx={{
                height: 22, fontSize: 12,
                color: status === "Revoked" ? "error.main" : status === "Expired" ? "text.secondary" : "var(--porch-vote-up)",
                borderColor: "currentColor",
              }}
            />
          </Stack>
          <Typography variant="body2" sx={{ color: "text.secondary", mt: 0.5 }}>
            This visit reaches: {summary}
          </Typography>
          <Typography variant="body2" sx={{ color: "text.muted", mt: 0.25 }}>
            {grant.revokedAt
              ? `The visit ended early ${relativeTime(grant.revokedAt)}.`
              : status === "Expired"
                ? "The visit's checkout has passed."
                : `Runs until ${dateOf(grant.expiresAt)} (${relativeTime(grant.expiresAt)}).`}
          </Typography>
        </Box>
        <Button size="small" color="error" disabled={busy || ended} onClick={() => onRevoke(grant)}>
          End the visit
        </Button>
      </Stack>

      {grant.familyRef && isParent && !ended && (
        <DistributionEditor grant={grant} family={family} devices={devices} areas={areas} scenes={scenes} myDid={myDid}
          busy={busy} error={distributionError} onDistribute={onDistribute} />
      )}
      {grant.familyRef && isParent && ended && distribution.length > 0 && (
        <Typography variant="body2" sx={{ color: "text.muted", mt: 1 }}>
          Handed out during the visit: {distribution.map((row) => `${row.memberIdentityRef} (${summarizeScopes(row.scopes, devices, areas, scenes).join(", ")})`).join(" · ")}
        </Typography>
      )}
    </Paper>
  );
}

/** One family visit's per-member distribution editor: pick a member of the
 * family, tick what part of the visit envelope they reach (the options ARE
 * the envelope — nothing outside it can be offered), save it. Existing shares
 * arrive pre-ticked for their member. */
function DistributionEditor({ grant, family, devices, areas, scenes, myDid, busy, error, onDistribute }) {
  const members = Array.isArray(family?.memberIdentityRefs) ? family.memberIdentityRefs : [];
  const options = grant.scopes.map((scope) => ({ scope, key: `${scope.resourceType}:${scope.resourceRef}` }));
  const labels = summarizeScopes(grant.scopes, devices, areas, scenes);
  const distributionOf = (did) => {
    const row = (grant.parentDistributions ?? []).find((entry) => entry.memberIdentityRef === did);
    return new Set((row?.scopes ?? []).map((scope) => `${scope.resourceType}:${scope.resourceRef}`));
  };

  const [memberDid, setMemberDid] = useState(members[0] ?? "");
  const [picked, setPicked] = useState(() => distributionOf(members[0] ?? ""));
  // Switching the member swaps the draft to that member's own share — one
  // editor always edits exactly one member's hand-out.
  const changeMember = (did) => {
    setMemberDid(did);
    setPicked(distributionOf(did));
  };
  const toggle = (key) =>
    setPicked((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  return (
    <Box sx={{ mt: 2, pt: 2, borderTop: "1px solid", borderColor: "var(--porch-border)" }}>
      <Typography variant="subtitle2">What this family's members reach in the visit</Typography>
      <Typography variant="body2" sx={{ color: "text.muted", mt: 0.5 }}>
        You parent this family — hand each of its members their own share of the host's envelope, never more than it holds.
      </Typography>
      <Stack direction={{ xs: "column", sm: "row" }} spacing={1.5} sx={{ mt: 1 }} alignItems={{ sm: "center" }}>
        <FormControl size="small" sx={{ minWidth: { xs: "100%", sm: 220 } }}>
          <InputLabel>Family member</InputLabel>
          <Select value={memberDid} label="Family member" onChange={(event) => changeMember(event.target.value)}>
            {members.length === 0 && <MenuItem value=""><em>No members yet</em></MenuItem>}
            {members.map((did) => (
              <MenuItem key={did} value={did}>{did === myDid ? "You" : did}</MenuItem>
            ))}
          </Select>
        </FormControl>
        <Button
          size="small"
          variant="contained"
          disabled={busy || !memberDid || picked.size === 0}
          onClick={() =>
            onDistribute({
              memberDid,
              scopes: options.filter((option) => picked.has(option.key)).map((option) => ({
                resourceType: option.scope.resourceType,
                resourceRef: option.scope.resourceRef,
                verbs: [...(option.scope.verbs ?? [])],
              })),
            })}
        >
          {busy ? <CircularProgress size={16} /> : "Save their share"}
        </Button>
        {memberDid && picked.size === 0 && (
          <Typography variant="body2" sx={{ color: "text.muted" }}>Tick at least one thing — a member reaches nothing until a share is saved.</Typography>
        )}
      </Stack>
      <Stack spacing={0.5} sx={{ mt: 1 }}>
        {options.map((option, index) => (
          <FormControlLabel
            key={option.key}
            control={<Checkbox checked={picked.has(option.key)} onChange={() => toggle(option.key)} size="small" />}
            label={labels[index]}
            sx={{ "& .MuiTypography-body1": { fontSize: 14 } }}
          />
        ))}
      </Stack>
      {Boolean(error) && <Alert severity="warning" sx={{ mt: 1.5 }}>{error}</Alert>}
    </Box>
  );
}

/** One family card in the organizer: who governs, who is governed, and the
 * parent-only controls to grow or trim the family. Refusals render inline. */
function FamilyCard({ family, myDid, mutate }) {
  const [draftDid, setDraftDid] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const parents = family.parentIdentityRefs ?? [];
  const members = (family.memberIdentityRefs ?? []).filter((did) => !parents.includes(did));
  const isParent = parents.includes(myDid);

  const run = (kind, did) => {
    setBusy(true);
    setError("");
    mutate(kind, family._id, did)
      .catch((failure) => setError(failure?.message || "That did not work. Please try again."))
      .finally(() => setBusy(false));
  };

  const chip = (did, role) => (
    <Chip
      key={`${role}-${did}`}
      size="small"
      variant="outlined"
      label={`${role} · ${did === myDid ? "You" : did}`}
      sx={{ height: 24, fontSize: 12, maxWidth: 280 }}
      onDelete={isParent ? () => run(role === "parent" ? "removeParent" : "removeMember", did) : undefined}
    />
  );

  return (
    <Paper elevation={0} sx={{ p: 2, mb: 1.25, borderRadius: 3, bgcolor: "var(--porch-surface)", border: "1px solid", borderColor: "var(--porch-border)" }}>
      <Typography variant="subtitle1" sx={{ fontWeight: 600 }}>{family.name || "Unnamed family"}</Typography>
      <Stack direction="row" spacing={0.75} sx={{ mt: 1, flexWrap: "wrap", rowGap: 0.75 }}>
        {parents.map((did) => chip(did, "parent"))}
        {members.map((did) => chip(did, "member"))}
        {(parents.length + members.length) === 0 && (
          <Typography variant="body2" sx={{ color: "text.muted" }}>No members yet — the creator is always the first parent.</Typography>
        )}
      </Stack>
      {isParent && (
        <Stack direction={{ xs: "column", sm: "row" }} spacing={1.5} sx={{ mt: 1.5 }} alignItems={{ sm: "center" }}>
          <TextField
            size="small" label="Add by Porchlight DID" fullWidth placeholder="did:porchlight:…"
            value={draftDid} onChange={(event) => setDraftDid(event.target.value)}
          />
          <Button size="small" variant="outlined" disabled={busy || !draftDid.trim()} onClick={() => run("addMember", draftDid.trim())}>Add member</Button>
          <Button size="small" disabled={busy || !draftDid.trim()} onClick={() => run("addParent", draftDid.trim())}>Make parent</Button>
        </Stack>
      )}
      {Boolean(error) && <Alert severity="warning" sx={{ mt: 1.5 }}>{error}</Alert>}
    </Paper>
  );
}

// --- dialogs ----------------------------------------------------------------

function HomeDialogs({
  dialog, busy, dialogError, closeDialog,
  home, areas, controllableDevices, devices, scenes, families,
  onCreateHome, onRenameHome, onAddArea, onAddDevice, onAddScene, onAddAutomation,
  onCreateGrant, onCreateFamily,
}) {
  const [name, setName] = useState("");
  const [kind, setKind] = useState("room");
  const [areaId, setAreaId] = useState("");
  const [capabilities, setCapabilities] = useState([]);
  const [extraCapabilities, setExtraCapabilities] = useState("");
  const [adapterName, setAdapterName] = useState("");
  const [adapterBinding, setAdapterBinding] = useState("");
  const [actionRows, setActionRows] = useState([{ deviceId: "", command: "" }]);
  const [eventClass, setEventClass] = useState("vehicle");
  const [afterDark, setAfterDark] = useState(false);
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");

  // PORCH-138 drafts: the visit grant (person or family, scope picks,
  // checkout) and the family organizer's create form.
  const [visitKind, setVisitKind] = useState("person");
  const [granteeDid, setGranteeDid] = useState("");
  const [visitFamilyId, setVisitFamilyId] = useState("");
  const [devicePicks, setDevicePicks] = useState({});
  const [scenePicks, setScenePicks] = useState({});
  const [areaPicks, setAreaPicks] = useState({});
  const [checkout, setCheckout] = useState("");
  const [parentsText, setParentsText] = useState("");
  const [membersText, setMembersText] = useState("");

  useEffect(() => {
    // Each open starts from the dialog's own resting draft.
    setName("");
    setKind("room");
    setAreaId("");
    if (controllableDevices.length) {
      setActionRows([{ deviceId: controllableDevices[0]._id, command: "turnOn" }]);
    } else {
      setActionRows([{ deviceId: "", command: "" }]);
    }
    setEventClass("vehicle");
    setAfterDark(false);
    setFrom("");
    setTo("");
    setVisitKind("person");
    setGranteeDid("");
    setVisitFamilyId("");
    setDevicePicks({});
    setScenePicks({});
    setAreaPicks({});
    setCheckout("");
    setParentsText("");
    setMembersText("");
  }, [dialog]); // eslint-disable-line react-hooks/exhaustive-deps

  const didsOf = (text) => text.split(",").map((did) => did.trim()).filter(Boolean);
  const pickedScopes = (picks, rows, resourceType) =>
    rows.filter((row) => picks[row._id]).map((row) => ({
      resourceType,
      resourceRef: row._id,
      verbs: picks[row._id] === "both" ? ["view", "control"] : ["view"],
    }));
  const grantScopeCount =
    pickedScopes(devicePicks, devices ?? [], "device").length
    + pickedScopes(scenePicks, scenes ?? [], "scene").length
    + pickedScopes(areaPicks, areas ?? [], "area").length;
  const grantTargetReady =
    (visitKind === "person" ? granteeDid.trim().length > 0 : Boolean(visitFamilyId)) && checkout.length > 0;

  const errorLine = dialogError && <Alert severity="warning" sx={{ mt: 2 }}>{dialogError}</Alert>;
  const open = (key) => dialog === key;

  return (
    <>
      {/* Create home */}
      <Dialog open={open("create-home")} onClose={closeDialog} fullWidth maxWidth="xs">
        <DialogTitle>Create a home</DialogTitle>
        <DialogContent>
          <TextField autoFocus margin="dense" label="Home name" fullWidth value={name} onChange={(event) => setName(event.target.value)} />
          {errorLine}
        </DialogContent>
        <DialogActions>
          <Button onClick={closeDialog}>Cancel</Button>
          <Button variant="contained" disabled={busy || !name.trim()} onClick={() => onCreateHome({ name })}>
            {busy ? <CircularProgress size={18} /> : "Create"}
          </Button>
        </DialogActions>
      </Dialog>

      {/* Rename home (owner only — the button that opens it is owner-gated) */}
      <Dialog open={open("rename-home")} onClose={closeDialog} fullWidth maxWidth="xs">
        <DialogTitle>Rename {home?.name || "this home"}</DialogTitle>
        <DialogContent>
          <TextField autoFocus margin="dense" label="New name" fullWidth value={name} onChange={(event) => setName(event.target.value)} />
          {errorLine}
        </DialogContent>
        <DialogActions>
          <Button onClick={closeDialog}>Cancel</Button>
          <Button variant="contained" disabled={busy || !name.trim()} onClick={() => onRenameHome({ name })}>
            {busy ? <CircularProgress size={18} /> : "Rename"}
          </Button>
        </DialogActions>
      </Dialog>

      {/* Add area */}
      <Dialog open={open("add-area")} onClose={closeDialog} fullWidth maxWidth="xs">
        <DialogTitle>Add an area</DialogTitle>
        <DialogContent>
          <TextField autoFocus margin="dense" label="Area name" fullWidth value={name} onChange={(event) => setName(event.target.value)} />
          <FormControl fullWidth margin="dense">
            <InputLabel>Kind</InputLabel>
            <Select value={kind} label="Kind" onChange={(event) => setKind(event.target.value)}>
              <MenuItem value="room">Room</MenuItem>
              <MenuItem value="outdoor">Outdoor area</MenuItem>
            </Select>
          </FormControl>
          {errorLine}
        </DialogContent>
        <DialogActions>
          <Button onClick={closeDialog}>Cancel</Button>
          <Button variant="contained" disabled={busy || !name.trim()} onClick={() => onAddArea({ name, kind })}>
            {busy ? <CircularProgress size={18} /> : "Add area"}
          </Button>
        </DialogActions>
      </Dialog>

      {/* Register device */}
      <Dialog open={open("add-device")} onClose={closeDialog} fullWidth maxWidth="xs">
        <DialogTitle>Register a device</DialogTitle>
        <DialogContent>
          <TextField autoFocus margin="dense" label="Device name" fullWidth value={name} onChange={(event) => setName(event.target.value)} />
          <FormControl fullWidth margin="dense">
            <InputLabel>Area</InputLabel>
            <Select value={areaId} label="Area" onChange={(event) => setAreaId(event.target.value)}>
              {areas.map((area) => <MenuItem key={area._id} value={area._id}>{area.name}</MenuItem>)}
            </Select>
          </FormControl>
          <FormControlLabel
            control={<Checkbox checked={capabilities.includes("switch")} onChange={(event) => setCapabilities((current) => (event.target.checked ? [...current, "switch"] : current.filter((item) => item !== "switch")))} />}
            label="Can switch on and off"
          />
          <FormControlLabel
            control={<Checkbox checked={capabilities.includes("light")} onChange={(event) => setCapabilities((current) => (event.target.checked ? [...current, "light"] : current.filter((item) => item !== "light")))} />}
            label="Is a light"
          />
          <TextField
            margin="dense" label="Other capabilities (comma-separated)" fullWidth value={extraCapabilities}
            onChange={(event) => setExtraCapabilities(event.target.value)} placeholder="motion, temperature"
          />
          <TextField margin="dense" label="Adapter" fullWidth value={adapterName} onChange={(event) => setAdapterName(event.target.value)} placeholder="hue" />
          <TextField margin="dense" label="Adapter binding" fullWidth value={adapterBinding} onChange={(event) => setAdapterBinding(event.target.value)} placeholder="living-lamp-1" />
          {errorLine}
        </DialogContent>
        <DialogActions>
          <Button onClick={closeDialog}>Cancel</Button>
          <Button
            variant="contained"
            disabled={busy || !name.trim() || !areaId || !adapterName.trim()}
            onClick={() => onAddDevice({
              name,
              areaId,
              capabilities: [...capabilities, ...extraCapabilities.split(",").map((item) => item.trim()).filter(Boolean)],
              adapter: { name: adapterName.trim(), binding: adapterBinding.trim() },
            })}
          >
            {busy ? <CircularProgress size={18} /> : "Register"}
          </Button>
        </DialogActions>
      </Dialog>

      {/* New scene */}
      <Dialog open={open("add-scene")} onClose={closeDialog} fullWidth maxWidth="sm">
        <DialogTitle>New scene</DialogTitle>
        <DialogContent>
          <TextField autoFocus margin="dense" label="Scene name" fullWidth value={name} onChange={(event) => setName(event.target.value)} />
          <Box sx={{ mt: 2 }}>
            <ActionRows devices={controllableDevices} rows={actionRows} setRows={setActionRows} />
          </Box>
          {errorLine}
        </DialogContent>
        <DialogActions>
          <Button onClick={closeDialog}>Cancel</Button>
          <Button
            variant="contained"
            disabled={busy || !name.trim() || !actionRows.some((row) => row.deviceId && row.command)}
            onClick={() => onAddScene({ name, rows: actionRows })}
          >
            {busy ? <CircularProgress size={18} /> : "Save scene"}
          </Button>
        </DialogActions>
      </Dialog>

      {/* New automation */}
      <Dialog open={open("add-automation")} onClose={closeDialog} fullWidth maxWidth="sm">
        <DialogTitle>New automation</DialogTitle>
        <DialogContent>
          <TextField autoFocus margin="dense" label="Automation name" fullWidth value={name} onChange={(event) => setName(event.target.value)} />
          <FormControl fullWidth margin="dense">
            <InputLabel>When this happens</InputLabel>
            <Select value={eventClass} label="When this happens" onChange={(event) => setEventClass(event.target.value)}>
              {EVENT_CLASSES.map((value) => <MenuItem key={value} value={value}>{EVENT_CLASS_LABELS[value]}</MenuItem>)}
            </Select>
          </FormControl>
          <FormControl fullWidth margin="dense">
            <InputLabel>In an area (optional)</InputLabel>
            <Select value={areaId} label="In an area (optional)" onChange={(event) => setAreaId(event.target.value)}>
              <MenuItem value=""><em>Anywhere</em></MenuItem>
              {areas.map((area) => <MenuItem key={area._id} value={area._id}>{area.name}</MenuItem>)}
            </Select>
          </FormControl>
          <FormControlLabel
            control={<Checkbox checked={afterDark} onChange={(event) => setAfterDark(event.target.checked)} />}
            label="Only after dark"
          />
          {!afterDark && (
            <Stack direction="row" spacing={1.5} sx={{ mt: 0.5 }}>
              <TextField label="From (optional)" type="time" fullWidth value={from} onChange={(event) => setFrom(event.target.value)} />
              <TextField label="Until (optional)" type="time" fullWidth value={to} onChange={(event) => setTo(event.target.value)} />
            </Stack>
          )}
          <Box sx={{ mt: 2 }}>
            <Typography variant="subtitle2" sx={{ mb: 1 }}>What it does</Typography>
            <ActionRows devices={controllableDevices} rows={actionRows} setRows={setActionRows} />
          </Box>
          {errorLine}
        </DialogContent>
        <DialogActions>
          <Button onClick={closeDialog}>Cancel</Button>
          <Button
            variant="contained"
            disabled={busy || !name.trim() || !actionRows.some((row) => row.deviceId && row.command)}
            onClick={() => onAddAutomation({ name, eventClass, areaId, afterDark, from, to, rows: actionRows })}
          >
            {busy ? <CircularProgress size={18} /> : "Save automation"}
          </Button>
        </DialogActions>
      </Dialog>

      {/* Grant a visit (owner only — the button that opens it is owner-gated).
          The checkout is required; the scope picks carry what the visit may reach. */}
      <Dialog open={open("add-grant")} onClose={closeDialog} fullWidth maxWidth="sm">
        <DialogTitle>Grant a visit</DialogTitle>
        <DialogContent>
          <FormControl fullWidth margin="dense">
            <InputLabel>For whom</InputLabel>
            <Select value={visitKind} label="For whom" onChange={(event) => setVisitKind(event.target.value)}>
              <MenuItem value="person">One person</MenuItem>
              <MenuItem value="family">One family</MenuItem>
            </Select>
          </FormControl>
          {visitKind === "person" ? (
            <TextField
              autoFocus margin="dense" label="Porchlight DID" fullWidth value={granteeDid}
              onChange={(event) => setGranteeDid(event.target.value)} placeholder="did:porchlight:…"
              helperText="Grants ride the Porchlight identity a person already has."
            />
          ) : (
            <>
              <FormControl fullWidth margin="dense">
                <InputLabel>Family</InputLabel>
                <Select value={visitFamilyId} label="Family" onChange={(event) => setVisitFamilyId(event.target.value)}>
                  {(families ?? []).map((family) => (
                    <MenuItem key={family._id} value={family._id}>{family.name}</MenuItem>
                  ))}
                </Select>
              </FormControl>
              {(families ?? []).length === 0 && (
                <Typography variant="body2" sx={{ color: "text.muted" }}>
                  No families yet — create one in the family organizer below, then grant its visit here.
                </Typography>
              )}
            </>
          )}
          <ScopePickRows title="Devices" noneText="No devices yet." rows={devices ?? []} picks={devicePicks} setPicks={setDevicePicks} />
          <ScopePickRows title="Scenes" noneText="No scenes yet." rows={scenes ?? []} picks={scenePicks} setPicks={setScenePicks} />
          <ScopePickRows title="Areas" noneText="No areas yet." rows={areas ?? []} picks={areaPicks} setPicks={setAreaPicks} />
          <TextField
            margin="dense" label="Checkout" type="datetime-local" fullWidth value={checkout}
            onChange={(event) => setCheckout(event.target.value)}
            helperText="The visit ends at this moment — everything it reaches stops working then."
            InputLabelProps={{ shrink: true }}
          />
          {errorLine}
        </DialogContent>
        <DialogActions>
          <Button onClick={closeDialog}>Cancel</Button>
          <Button
            variant="contained"
            disabled={busy || !grantTargetReady || grantScopeCount === 0}
            onClick={() => onCreateGrant({
              granteeDid: visitKind === "person" ? granteeDid.trim() : undefined,
              familyId: visitKind === "family" ? visitFamilyId : undefined,
              scopes: [
                ...pickedScopes(devicePicks, devices ?? [], "device"),
                ...pickedScopes(scenePicks, scenes ?? [], "scene"),
                ...pickedScopes(areaPicks, areas ?? [], "area"),
              ],
              expiresAt: checkout ? new Date(checkout).toISOString() : null,
            })}
          >
            {busy ? <CircularProgress size={18} /> : "Grant the visit"}
          </Button>
        </DialogActions>
      </Dialog>

      {/* Create a family in the organizer — session-bound, no device signing. */}
      <Dialog open={open("create-family")} onClose={closeDialog} fullWidth maxWidth="xs">
        <DialogTitle>Create a family</DialogTitle>
        <DialogContent>
          <TextField autoFocus margin="dense" label="Family name" fullWidth value={name} onChange={(event) => setName(event.target.value)} />
          <TextField
            margin="dense" label="Parents (DIDs, comma-separated)" fullWidth value={parentsText}
            onChange={(event) => setParentsText(event.target.value)}
            placeholder="did:porchlight:…, did:porchlight:…"
            helperText="You are the first parent of record — list any others."
          />
          <TextField
            margin="dense" label="Members (DIDs, comma-separated)" fullWidth value={membersText}
            onChange={(event) => setMembersText(event.target.value)}
            placeholder="did:porchlight:…"
          />
          {errorLine}
        </DialogContent>
        <DialogActions>
          <Button onClick={closeDialog}>Cancel</Button>
          <Button
            variant="contained"
            disabled={busy || !name.trim()}
            onClick={() => onCreateFamily({ name, parents: didsOf(parentsText), members: didsOf(membersText) })}
          >
            {busy ? <CircularProgress size={18} /> : "Create family"}
          </Button>
        </DialogActions>
      </Dialog>
    </>
  );
}

const EVENT_CLASS_LABELS = { vehicle: "A vehicle", person: "A person", animal: "An animal", button: "A button press", door: "A door" };

/** The Home tab's whole surface, for any signed-in connection — the module
 * never gates on social bootstrap; homes and the active home ride this
 * screen's own fetch state plus the origin-scoped active-home memory. */
// PORCH-139 (below): the cameras surface's dialogs and the surface itself.
// Pure logic and copy ride camera-model.js; the wire rides home-actions.js
// through the shared actions object.

const CAMERAS_LIMIT = 20;

function FeedTile({ feed, origin, token, homeId, onOpen, audioOn, toggleAudio }) {
  const playState = feedPlayState(feed);
  const sx = { aspectRatio: inlineAspectRatio(feed), width: "100%", bgcolor: "var(--porch-subtle)" };
  return (
    <Paper elevation={0} sx={{ p: 1, borderRadius: 3, border: "1px solid", borderColor: "var(--porch-border)" }}>
      <Stack direction="row" alignItems="center" justifyContent="space-between" sx={{ mb: 0.5 }}>
        <Typography variant="body2" sx={{ fontWeight: 600 }}>{feed.name || "Camera"}</Typography>
        {playState.kind === "live" && (
          <Stack direction="row" spacing={0.5} alignItems="center">
            <IconButton size="small" onClick={() => toggleAudio(feed._id)} aria-label={audioOn ? "Mute feed" : "Unmute feed"}>
              {audioOn ? "🔊" : "🔇"}
            </IconButton>
            <IconButton size="small" onClick={() => onOpen(feed)} aria-label="Open full-screen viewer">⤢</IconButton>
          </Stack>
        )}
      </Stack>
      {playState.kind === "live" ? (
        <Box
          component="video"
          src={mediaUrl({ origin, homeId, cameraId: feed._id, path: feed.live?.path, token })}
          autoPlay
          loop
          playsInline
          muted={!audioOn}
          sx={sx}
          onClick={() => onOpen(feed)}
        />
      ) : (
        <Box sx={{ ...sx, display: "grid", placeItems: "center", textAlign: "center", p: 2 }}>
          <Typography variant="body2" sx={{ color: "text.secondary" }}>{playState.copy}</Typography>
        </Box>
      )}
      {playState.kind === "live" && playState.note && (
        <Typography variant="caption" sx={{ display: "block", mt: 0.5, color: "text.secondary" }}>{playState.note}</Typography>
      )}
      <Typography variant="caption" sx={{ display: "block", color: "text.secondary" }}>
        {healthNotes(feed).find((row) => row.plane === "detection" && row.state === "unhealthy")?.note ?? ""}
      </Typography>
    </Paper>
  );
}

function CameraViewer({ feed, origin, token, homeId, onClose }) {
  const sx = {
    aspectRatio: viewerAspectRatio(feed),
    maxWidth: "100%",
    maxHeight: { xs: "70vh", md: "80vh" },
    width: "100%",
    bgcolor: "black",
    borderRadius: 2,
  };
  return (
    <Dialog open onClose={onClose} maxWidth="lg">
      <DialogTitle>{feed.name || "Camera"}</DialogTitle>
      <DialogContent>
        <Box
          component="video"
          src={mediaUrl({ origin, homeId, cameraId: feed._id, path: feed.live?.path, token })}
          autoPlay
          loop
          playsInline
          controls
          sx={sx}
        />
      </DialogContent>
    </Dialog>
  );
}

function CameraAccessPanel({ home, actions, origin, ownerHere }) {
  const [rows, setRows] = useState([]);
  const [did, setDid] = useState("");
  const [error, setError] = useState("");
  const load = async () => {
    try {
      const result = await actions.loadCameraAccess(home._id);
      setRows(Array.isArray(result?.access) ? result.access : []);
    } catch (failure) {
      setRows([]);
      setError(messageOf(failure));
    }
  };
  useEffect(() => {
    if (ownerHere) load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [home._id, ownerHere]);
  if (!ownerHere) return null;
  const grant = async () => {
    setError("");
    try {
      await actions.grantCameraAccess({ homeId: home._id, did });
      setDid("");
      await load();
    } catch (failure) {
      setError(messageOf(failure));
    }
  };
  const revoke = async (accessId) => {
    setError("");
    try {
      await actions.revokeCameraAccess(accessId);
      await load();
    } catch (failure) {
      setError(messageOf(failure));
    }
  };
  return (
    <Box sx={{ mt: 2 }}>
      <Typography variant="body2" sx={{ fontWeight: 600 }}>Camera access — separate from visit grants</Typography>
      <Typography variant="caption" sx={{ color: "text.secondary" }}>
        Home members reach cameras only with this authorization; visit grants never carry cameras.
      </Typography>
      {error && <Alert severity="warning" sx={{ mt: 1 }}>{error}</Alert>}
      {rows.map((row) => (
        <Stack key={row._id} direction="row" spacing={1} alignItems="center" sx={{ mt: 0.75 }}>
          <Chip size="small" label={row.revokedAt ? `Ended · ${row.did.slice(-8)}` : row.did.slice(0, 20) + (row.did.length > 20 ? "…" : "")} />
          {!row.revokedAt && <Button size="small" onClick={() => revoke(row._id)}>End camera access</Button>}
        </Stack>
      ))}
      <Stack direction="row" spacing={1} alignItems="center" sx={{ mt: 1 }}>
        <TextField size="small" label="Member identity (DID)" value={did} onChange={(e) => setDid(e.target.value)} sx={{ minWidth: 260 }} />
        <Button size="small" variant="contained" startIcon={<AddOutlined />} onClick={grant}>Camera access</Button>
      </Stack>
    </Box>
  );
}

function CamerasSurface({ home, areas, actions, ownerHere, origin }) {
  const [cameras, setCameras] = useState([]);
  const [token, setToken] = useState(null);
  const [error, setError] = useState("");
  const [events, setEvents] = useState([]);
  const [eventsError, setEventsError] = useState("");
  const [viewer, setViewer] = useState(null);
  const [audio, setAudio] = useState({});
  const [addOpen, setAddOpen] = useState(false);
  const [draft, setDraft] = useState({ name: "", areaId: "", rtsp: "" });
  const [addError, setAddError] = useState("");
  const [seekCameraId, setSeekCameraId] = useState("");
  const [seekAt, setSeekAt] = useState("");
  const [seekResult, setSeekResult] = useState(null);
  // PORCH-141: the recognition annotation join — names by entry id plus the
  // annotation rows themselves. Absent plane or switch off: the decoration
  // degrades quietly to nothing while the events' factual copy stands.
  const [recognitions, setRecognitions] = useState({ names: {}, annotations: [] });

  const homeId = home?._id;
  const reload = async () => {
    if (!homeId) return;
    setError("");
    try {
      const session = await actions.openViewSession(homeId);
      setToken(session?.token ?? null);
      setCameras(Array.isArray(session?.cameras) ? session.cameras : []);
    } catch (failure) {
      setToken(null);
      setCameras([]);
      setError(messageOf(failure));
    }
    try {
      const result = await actions.loadCameraEvents(homeId, { limit: CAMERAS_LIMIT });
      setEvents(Array.isArray(result?.events) ? result.events : []);
      setEventsError("");
    } catch (failure) {
      setEvents([]);
      setEventsError(messageOf(failure));
    }
    // Reading is not recognition (ac-6): the annotation join works while the
    // switch is off, and a plane-less older hub leaves it empty.
    try {
      const [notes, registry] = await Promise.all([actions.loadAnnotations(homeId), actions.loadEntries(homeId)]);
      setRecognitions({ names: namesByEntryId(registry?.entries), annotations: notes?.annotations ?? [] });
    } catch {
      setRecognitions({ names: {}, annotations: [] });
    }
  };

  useEffect(() => {
    setCameras([]);
    setEvents([]);
    setToken(null);
    setSeekResult(null);
    reload();
    return () => {};
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [homeId]);

  const toggleAudio = (cameraId) => setAudio((current) => ({ ...current, [cameraId]: !current[cameraId] }));

  const addCamera = async () => {
    setAddError("");
    try {
      await actions.addCamera({ homeId, ...draft, areaId: draft.areaId || null });
      setAddOpen(false);
      setDraft({ name: "", areaId: "", rtsp: "" });
      await reload();
    } catch (failure) {
      setAddError(messageOf(failure));
    }
  };

  const setRecording = async (feed, enabled) => {
    try {
      await actions.setCameraRecording(feed._id, enabled);
      await reload();
    } catch (failure) {
      setError(messageOf(failure));
    }
  };

  const bulkRecording = async (enabled) => {
    try {
      await actions.bulkCameraRecording({ homeId, enabled });
      await reload();
    } catch (failure) {
      setError(messageOf(failure));
    }
  };

  const seek = async () => {
    setSeekResult(null);
    try {
      if (!seekCameraId || !seekAt) return;
      const at = new Date(seekAt).toISOString();
      const answer = await actions.seekCamera(homeId, { cameraId: seekCameraId, at });
      if (answer?.gap) {
        setSeekResult({ gap: true, copy: gapCopy(answer.gap) });
      } else if (answer?.evidence?.path) {
        setSeekResult({ gap: false, url: mediaUrl({ origin, homeId, cameraId: seekCameraId, path: answer.evidence.path, token }) });
      }
    } catch (failure) {
      setSeekResult({ gap: true, copy: messageOf(failure) });
    }
  };

  const flagEvent = async (event) => {
    try {
      const answer = await actions.flagCameraEvent(event._id);
      setEvents((current) => current.map((row) => (row._id === answer?.event?._id ? answer.event : row)));
    } catch (failure) {
      setEventsError(messageOf(failure));
    }
  };

  const anyCameras = cameras.length > 0;

  return (
    <>
      <SectionHeader
        title="Cameras"
        action={(
          ownerHere && (
            <Button size="small" startIcon={<AddOutlined />} onClick={() => setAddOpen(true)}>
              Add camera
            </Button>
          )
        )}
      />
      {error && <Alert severity="warning">{error}</Alert>}
      {ownerHere && anyCameras && (
        <Stack direction="row" spacing={1} sx={{ mb: 1 }}>
          <Button size="small" onClick={() => bulkRecording(true)}>All recording on</Button>
          <Button size="small" onClick={() => bulkRecording(false)}>All recording off</Button>
        </Stack>
      )}
      {anyCameras && (
        <Box sx={{ display: "grid", gap: 1.5, gridTemplateColumns: { xs: "1fr", sm: "repeat(2, 1fr)" } }}>
          {cameras.map((feed) => (
            <FeedTile
              key={feed._id} feed={feed} origin={origin} token={token} homeId={homeId}
              onOpen={setViewer} audioOn={audio[feed._id] === true} toggleAudio={toggleAudio}
            />
          ))}
        </Box>
      )}
      {!anyCameras && !error && (
        <Typography variant="body2" sx={{ color: "text.secondary" }}>
          No cameras yet — the owner adds and validates one through the engine.
        </Typography>
      )}
      {ownerHere && anyCameras && (
        <Box sx={{ mt: 1 }}>
          {cameras.map((feed) => (
            <Stack key={feed._id} direction="row" spacing={1} alignItems="center" sx={{ mt: 0.5 }}>
              <Typography variant="caption" sx={{ minWidth: 120 }}>{feed.name || "Camera"}</Typography>
              <Switch
                size="small"
                checked={feed.recordingEnabled === true}
                onChange={(e) => setRecording(feed, e.target.checked)}
                inputProps={{ "aria-label": `Recording for ${feed.name}` }}
              />
              <Typography variant="caption" sx={{ color: "text.secondary" }}>recording {feed.recordingEnabled ? "on" : "off"}</Typography>
            </Stack>
          ))}
        </Box>
      )}

      {/* Owner's camera-authorization panel — the separate grant scope class. */}
      <CameraAccessPanel home={home} actions={actions} origin={origin} ownerHere={ownerHere} />

      {/* Playback: seek to a known time on any recorded camera. */}
      {anyCameras && (
        <Box sx={{ mt: 3 }}>
          <Typography variant="h6">Playback</Typography>
          <Stack direction={{ xs: "column", sm: "row" }} spacing={1} alignItems={{ sm: "center" }} sx={{ mt: 1 }}>
            <TextField
              select size="small" label="Camera" value={seekCameraId}
              onChange={(e) => setSeekCameraId(e.target.value)} sx={{ minWidth: 200 }}
            >
              {cameras.map((feed) => <MenuItem key={feed._id} value={feed._id}>{feed.name || "Camera"}</MenuItem>)}
            </TextField>
            <TextField
              size="small" type="datetime-local" label="Watch at" value={seekAt}
              onChange={(e) => setSeekAt(e.target.value)} slotProps={{ htmlInput: { step: 60 } }} sx={{ minWidth: 220 }}
            />
            <Button variant="contained" startIcon={<PlayArrowOutlined />} onClick={seek}>Watch</Button>
          </Stack>
          {seekResult?.gap && <Alert severity="info" sx={{ mt: 1.5 }}>{seekResult.copy}</Alert>}
          {seekResult?.url && (
            <Box component="video" src={seekResult.url} controls autoPlay sx={{ mt: 1.5, width: "100%", borderRadius: 2, bgcolor: "black" }} />
          )}
        </Box>
      )}

      {/* Camera activity: the event/alert surface — factual copy, conditional
          interpretive copy, evidence or the explained gap, and the flag. */}
      {anyCameras && (
        <Box sx={{ mt: 3 }}>
          <SectionHeader title="Camera activity" />
          {eventsError && <Alert severity="warning">{eventsError}</Alert>}
          {events.length === 0 && !eventsError && (
            <Typography variant="body2" sx={{ color: "text.secondary" }}>No camera activity yet.</Typography>
          )}
          {events.map((event) => {
            const copy = alertCopy(event);
            const evidence = eventEvidence(event);
            const thumbUrl = evidence.path && evidence.cameraId
              ? mediaUrl({ origin, homeId, cameraId: evidence.cameraId, path: evidence.path, token })
              : null;
            // PORCH-141: the annotated identities — the name plainly for an
            // asserted match, "looks like name (pct%)" otherwise. Unknown
            // sightings have no annotation rows at all.
            const identities = annotationLines(recognitions.names, annotationsForEvent(recognitions.annotations, event)) ?? [];
            return (
              <Paper key={event._id} elevation={0} sx={{ p: 2, mb: 1, borderRadius: 3, border: "1px solid", borderColor: "var(--porch-border)" }}>
                <Stack direction="row" alignItems="flex-start" justifyContent="space-between" spacing={1}>
                  <Box>
                    <Typography variant="body1">{copy.factual}</Typography>
                    {identities.length > 0 && (
                      <Stack direction="row" spacing={0.5} sx={{ mt: 0.5, flexWrap: "wrap", rowGap: 0.5 }}>
                        {identities.map((line, noteIndex) => (
                          <Chip key={noteIndex} size="small" label={line} />
                        ))}
                      </Stack>
                    )}
                    {copy.interpretive && (
                      <Typography variant="body2" sx={{ mt: 0.5, color: "text.secondary" }}>
                        <Chip size="small" label={copy.conditional} sx={{ mr: 0.5 }} />
                        {copy.interpretive}
                      </Typography>
                    )}
                    <Stack direction="row" spacing={0.5} sx={{ mt: 1, flexWrap: "wrap", rowGap: 0.5 }}>
                      <Chip size="small" variant="outlined" label={relativeTime(String(event.startedAt ?? ""))} />
                      {(event.observations ?? []).slice(0, 3).map((obs, index) => (
                        <Chip key={index} size="small" label={`${obs.label} @ ${obs.cameraName ?? "camera"}`} />
                      ))}
                    </Stack>
                  </Box>
                  {!event.flag && <Button size="small" onClick={() => flagEvent(event)}>Not right</Button>}
                  {event.flag && <Chip size="small" label="Flagged" />}
                </Stack>
                {thumbUrl ? (
                  <Box component="img" src={thumbUrl} alt="Event evidence" sx={{ mt: 1, width: "100%", borderRadius: 2 }} />
                ) : (
                  evidence.kind === "gap" && (
                    <Typography variant="caption" sx={{ display: "block", mt: 1, color: "text.secondary" }}>{evidence.copy}</Typography>
                  )
                )}
              </Paper>
            );
          })}
        </Box>
      )}

      {/* Add-camera dialog: the engine validates the RTSP (onboarding). */}
      <Dialog open={addOpen} onClose={() => setAddOpen(false)} maxWidth="sm" fullWidth>
        <DialogTitle>Add a camera</DialogTitle>
        <DialogContent>
          <Stack spacing={1.5} sx={{ mt: 1 }}>
            {addError && <Alert severity="warning">{addError}</Alert>}
            <TextField size="small" label="Name" value={draft.name} onChange={(e) => setDraft((c) => ({ ...c, name: e.target.value }))} />
            <FormControl size="small" fullWidth>
              <InputLabel>Covering area</InputLabel>
              <Select
                value={draft.areaId}
                label="Covering area"
                onChange={(e) => setDraft((c) => ({ ...c, areaId: e.target.value }))}
              >
                <MenuItem value=""><em>None</em></MenuItem>
                {areas.map((area) => <MenuItem key={area._id} value={area._id}>{area.name}</MenuItem>)}
              </Select>
            </FormControl>
            <TextField
              size="small" label="Camera URL (RTSP)" value={draft.rtsp}
              onChange={(e) => setDraft((c) => ({ ...c, rtsp: e.target.value }))}
              helperText="The camera engine validates this before the camera joins the home."
            />
          </Stack>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setAddOpen(false)}>Cancel</Button>
          <Button variant="contained" onClick={addCamera} disabled={busyCameras(draft)}>Add camera</Button>
        </DialogActions>
      </Dialog>

      {viewer && (
        <CameraViewer feed={viewer} origin={origin} token={token} homeId={homeId} onClose={() => setViewer(null)} />
      )}
    </>
  );
}

function busyCameras(draft) {
  return !String(draft?.name ?? "").trim() || !String(draft?.rtsp ?? "").trim();
}

export function HomeDashboard({ data, actions }) {
  const origin = originOf(data?.server?.url) || (typeof window !== "undefined" ? window.location.origin : null);
  const storage = typeof window !== "undefined" ? window.localStorage : null;

  const [homes, setHomes] = useState([]);
  const [homesError, setHomesError] = useState("");
  const [homesLoading, setHomesLoading] = useState(true);

  // The active home and everything the switcher swaps in one place.
  const [home, setHome] = useState(null);
  const [areas, setAreas] = useState([]);
  const [devices, setDevices] = useState([]);
  const [scenes, setScenes] = useState([]);
  const [automations, setAutomations] = useState([]);
  const [homeLoading, setHomeLoading] = useState(false);
  const [homeError, setHomeError] = useState("");

  // Per-device command lifecycles (device id → state entry).
  const [commandStates, setCommandStates] = useState({});
  const timers = useRef(new Map());

  const [sceneResults, setSceneResults] = useState({});
  const [audit, setAudit] = useState({ events: [], hasMore: false, offset: 0 });
  const [auditError, setAuditError] = useState("");
  const [auditLoading, setAuditLoading] = useState(false);

  const [dialog, setDialog] = useState(null);
  const [busy, setBusy] = useState(false);
  const [dialogError, setDialogError] = useState("");
  const [snack, setSnack] = useState("");

  // PORCH-138 Access surface: the owner's grants, the organizer's families,
  // the revoke-confirm flow, and the inline distribution refusal.
  const [grants, setGrants] = useState([]);
  const [grantsError, setGrantsError] = useState("");
  const [grantsLoading, setGrantsLoading] = useState(false);
  const [families, setFamilies] = useState([]);
  const [familiesError, setFamiliesError] = useState("");
  const [revoking, setRevoking] = useState(null);
  const [revokeError, setRevokeError] = useState("");
  const [distributionError, setDistributionError] = useState("");

  const applyDetail = (detail) => {
    setHome(detail?.home ?? null);
    setAreas(Array.isArray(detail?.areas) ? detail.areas : []);
    setDevices(Array.isArray(detail?.devices) ? detail.devices : []);
    setScenes(Array.isArray(detail?.scenes) ? detail.scenes : []);
    setAutomations(Array.isArray(detail?.automations) ? detail.automations : []);
    setCommandStates({}); // the switcher swaps everything, command states included
    setSceneResults({});
  };

  const loadHome = async (homeId) => {
    setHomeError("");
    setHomeLoading(true);
    try {
      const detail = await actions.loadHome(homeId);
      applyDetail(detail);
      setAudit({ events: [], hasMore: false, offset: 0 });
      if (ownerOf(detail?.home)) loadGrants(homeId); // owner-only, and the server refuses anyone else anyway
      if (!isVisitorAccess(detail?.home?.access)) loadAudit(homeId, 0); // the hub refuses a visitor's audit read
    } catch (error) {
      setHomeError(messageOf(error));
    } finally {
      setHomeLoading(false);
    }
  };

  // The owner's Access surface of record — reset with everything else when
  // the home swaps.
  const loadGrants = async (homeId) => {
    setGrantsError("");
    setGrantsLoading(true);
    try {
      const result = await actions.loadGrants(homeId);
      setGrants(Array.isArray(result?.grants) ? result.grants : []);
    } catch (error) {
      setGrants([]);
      setGrantsError(messageOf(error));
    } finally {
      setGrantsLoading(false);
    }
  };

  // The family organizer works for any signed-in member, independent of which
  // home is in view.
  const loadFamilies = async () => {
    setFamiliesError("");
    try {
      const result = await actions.loadFamilies();
      setFamilies(Array.isArray(result?.families) ? result.families : []);
    } catch (error) {
      setFamiliesError(messageOf(error));
    }
  };

  // One organizer mutation, then the family rows reload — they are the
  // organizer's own state of record.
  const mutateFamily = async (kind, familyId, did) => {
    const route = {
      addMember: (id, target) => actions.addFamilyMember(id, target),
      removeMember: (id, target) => actions.removeFamilyMember(id, target),
      addParent: (id, target) => actions.addFamilyParent(id, target),
      removeParent: (id, target) => actions.removeFamilyParent(id, target),
    }[kind];
    const result = await route(familyId, did);
    await loadFamilies();
    return result;
  };

  const loadAudit = async (homeId, offset) => {
    setAuditError("");
    setAuditLoading(true);
    try {
      const result = await actions.loadAudit(homeId, { limit: AUDIT_LIMIT, offset });
      const events = Array.isArray(result?.events) ? result.events : [];
      setAudit((current) => ({
        events: offset > 0 ? [...(current.events ?? []), ...events] : events,
        hasMore: result?.hasMore === true,
        offset: (offset ?? 0) + events.length,
      }));
    } catch (error) {
      setAuditError(messageOf(error));
    } finally {
      setAuditLoading(false);
    }
  };

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setHomesError("");
      setHomesLoading(true);
      try {
        const result = await actions.loadHomes();
        if (cancelled) return;
        const rows = Array.isArray(result?.homes) ? result.homes : [];
        setHomes(rows);
        if (rows.length) {
          // The active home persists per hub origin; fall back to the first.
          const stored = readActiveHomeId(storage, origin);
          const target = rows.find((row) => row._id === stored) ?? rows[0];
          writeActiveHomeId(storage, origin, target._id);
          const detail = await actions.loadHome(target._id);
          if (cancelled) return;
          applyDetail(detail);
          if (!isVisitorAccess(detail?.home?.access)) loadAudit(target._id, 0);
          if (ownerOf(detail?.home)) loadGrants(target._id);
        }
      } catch (error) {
        if (!cancelled) setHomesError(messageOf(error));
      } finally {
        if (!cancelled) setHomesLoading(false);
      }
    })();
    loadFamilies(); // the organizer belongs to the signed-in identity, not to any home
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => () => {
    for (const timer of timers.current.values()) clearTimeout(timer);
    timers.current.clear();
  }, []);

  const switchHome = async (homeId) => {
    if (!homeId || homeId === home?._id) return;
    writeActiveHomeId(storage, origin, homeId);
    await loadHome(homeId);
  };

  const ownerHere = ownerOf(home);
  const visitorAccess = isVisitorAccess(home?.access);
  const myDid = data?.identity?.id ?? "";
  const grouped = useMemo(() => groupDevicesByArea(devices, areas), [devices, areas]);

  const runCommand = async (view, command) => {
    const deviceId = view.id;
    setCommandStates((current) => ({ ...current, [deviceId]: nextCommandState(current[deviceId], "start") }));
    try {
      const result = await actions.sendDeviceCommand(deviceId, command);
      // Confirmed ONLY from the server's own response; the returned device
      // row replaces the old one, and the rendered switch moves now — from
      // the confirmed row's lastKnownState, never from the tap.
      const row = result?.device;
      if (row?._id) setDevices((current) => current.map((item) => (item._id === row._id ? row : item)));
      setCommandStates((current) => ({ ...current, [deviceId]: nextCommandState(current[deviceId], "confirmed") }));
      timers.current.set(deviceId, setTimeout(() => {
        setCommandStates((current) => ({ ...current, [deviceId]: nextCommandState(current[deviceId], "clear") }));
        timers.current.delete(deviceId);
      }, CONFIRMED_HOLD_MS));
    } catch (failure) {
      const unreachable = failure?.code === "E_DEVICE_UNREACHABLE";
      const denied = failure?.code === "E_NOT_PERMITTED";
      const reason = unreachable
        ? `${view.name} did not respond just now. Its status may be out of date.`
        : messageOf(failure);
      setCommandStates((current) => ({ ...current, [deviceId]: nextCommandState(current[deviceId], "failed", reason) }));
      if (denied || unreachable) {
        const row = failure?.body?.device;
        if (row?._id) setDevices((current) => current.map((item) => (item._id === row._id ? row : item)));
      }
    }
  };

  const refreshDevice = async (view) => {
    try {
      const result = await actions.refreshDeviceState(home?._id, view.id);
      const row = result?.device;
      if (row?._id) setDevices((current) => current.map((item) => (item._id === row._id ? row : item)));
    } catch (error) {
      setSnack(messageOf(error));
    }
  };

  const runScene = async (scene) => {
    try {
      const result = await actions.runScene(scene._id);
      await loadHome(home._id); // the run moves devices; reload the confirmed rows
      // The outcome chips land AFTER the reload (the reload resets scene
      // results with everything else) so they survive to be read.
      setSceneResults((current) => ({
        ...current,
        [scene._id]: Array.isArray(result?.results) ? result.results : [],
      }));
    } catch (error) {
      setSnack(messageOf(error));
    }
  };

  const toggleAutomation = async (automation) => {
    try {
      const result = await actions.updateAutomation(automation._id, { enabled: !automation.enabled });
      const row = result?.automation;
      if (row?._id) setAutomations((current) => current.map((item) => (item._id === row._id ? row : item)));
    } catch (error) {
      setSnack(messageOf(error));
    }
  };

  // --- Access (PORCH-138) ----------------------------------------------------

  const submitCreateGrant = submitWith(async (draft) => {
    await actions.createGrant({ homeId: home._id, ...draft });
    await loadGrants(home._id); // the new visit lands on the surface of record
  });

  const submitCreateFamily = submitWith(async ({ name: name_, parents, members }) => {
    await actions.createFamily({ name: name_, parentIdentityRefs: parents, memberIdentityRefs: members });
    await loadFamilies();
  });

  // The confirm-reject flow mirrors the app's other destructive dialogs: the
  // consequence named plainly, reject keeps things as they are, confirm runs.
  const confirmRevoke = async () => {
    if (!revoking) return;
    setBusy(true);
    setRevokeError("");
    try {
      await actions.revokeGrant({ grantId: revoking._id });
      setRevoking(null);
      const result = await actions.loadGrants(home._id);
      setGrants(Array.isArray(result?.grants) ? result.grants : []);
      loadAudit(home._id, 0); // the revocation rides the audit window too
    } catch (error) {
      setRevokeError(messageOf(error));
    } finally {
      setBusy(false);
    }
  };

  // A family's acting parent saves one member's share. The typed refusal —
  // E_ENVELOPE_EXCEEDED among them — renders inline in the editor, verbatim.
  const distribute = (grant) => ({ memberDid, scopes }) => {
    setDistributionError("");
    return actions.distributeGrant({ grantId: grant._id, memberIdentityRef: memberDid, scopes })
      .then((result) => {
        const row = result?.grant;
        if (row?._id) setGrants((current) => current.map((item) => (item._id === row._id ? row : item)));
      })
      .catch((failure) => setDistributionError(failure?.message || "That did not work. Please try again."));
  };

  const openDialog = (name_) => {
    setDialogError("");
    setDialog(name_);
  };

  const closeDialog = () => {
    setDialog(null);
    setDialogError("");
    setBusy(false);
  };

  const reportDialogError = (error) => {
    setDialogError(messageOf(error));
    setBusy(false);
  };

  const submitWith = (action) => async (draft) => {
    setBusy(true);
    setDialogError("");
    try {
      await action(draft);
      closeDialog();
    } catch (error) {
      reportDialogError(error);
    }
  };

  const submitCreateHome = submitWith(async ({ name: name_ }) => {
    await actions.createHome(name_);
    const result = await actions.loadHomes();
    const rows = Array.isArray(result?.homes) ? result.homes : [];
    setHomes(rows);
    const created = rows.find((row) => row.name === (name_ ?? "").trim()) ?? rows[rows.length - 1];
    if (created) {
      writeActiveHomeId(storage, origin, created._id);
      await loadHome(created._id);
    }
  });

  const submitRenameHome = submitWith(async ({ name: name_ }) => {
    const result = await actions.renameHome(home._id, name_);
    const row = result?.home;
    if (row?._id) {
      setHome((current) => ({ ...current, ...row }));
      setHomes((current) => current.map((item) => (item._id === row._id ? { ...item, name: row.name } : item)));
    } else {
      await loadHome(home._id);
    }
  });

  const submitAddArea = submitWith(async (draft) => {
    await actions.createArea(home._id, { name: draft.name, kind: draft.kind });
    await loadHome(home._id);
  });

  const submitAddDevice = submitWith(async (draft) => {
    await actions.registerDevice(home._id, draft);
    await loadHome(home._id);
  });

  const submitAddScene = submitWith(async ({ name: name_, rows }) => {
    await actions.createScene(home._id, { name: name_, actions: rows.filter((row) => row.deviceId && row.command) });
    await loadHome(home._id);
  });

  const submitAddAutomation = submitWith(async ({ name: name_, eventClass, areaId, afterDark, from, to, rows }) => {
    const timeWindow = afterDark
      ? { afterDark: true }
      : (from || to
        ? { ...(from ? { from } : {}), ...(to ? { to } : {}) }
        : undefined);
    const trigger = { eventClass, ...(areaId ? { areaId } : {}), ...(timeWindow ? { timeWindow } : {}) };
    await actions.createAutomation(home._id, {
      name: name_,
      trigger,
      actions: rows.filter((row) => row.deviceId && row.command),
      enabled: true,
    });
    await loadHome(home._id);
  });

  const controllableDevices = controllableOf(devices);
  const deviceName = (deviceId) => devices.find((device) => device._id === deviceId)?.name;
  const actorName = (event) => (event?.actorIdentityRef && event.actorIdentityRef === data?.identity?.id ? "You" : "A family member");
  const commandEntry = (deviceId) => ({
    status: commandStatusOf(commandStates, deviceId),
    reason: commandReasonOf(commandStates, deviceId),
  });

  const renderCard = (view) => (
    <DeviceRow
      key={view.id}
      view={view}
      command={commandEntry(view.id)}
      onCommand={(command) => runCommand(view, command)}
      onRefresh={() => refreshDevice(view)}
    />
  );

  // --- render ----------------------------------------------------------------
  if (homesLoading && !homes.length) {
    return (
      <Stack direction="row" spacing={2} alignItems="center" justifyContent="center" sx={{ py: 6 }}>
        <CircularProgress size={22} />
        <Typography color="text.secondary">Opening your homes…</Typography>
      </Stack>
    );
  }

  if (homesError && !homes.length) {
    return <Alert severity="warning" sx={{ mt: 2 }}>{homesError}</Alert>;
  }

  if (!homes.length) {
    return (
      <Box sx={{ py: 8, textAlign: "center" }}>
        <Typography variant="h5" sx={{ mb: 1 }}>Your family's homes</Typography>
        <Typography color="text.secondary" sx={{ mb: 3 }}>
          No homes yet — create your first home.
        </Typography>
        <Button variant="contained" startIcon={<AddOutlined />} onClick={() => openDialog("create-home")}>
          Create a home
        </Button>
        <HomeDialogs
          dialog={dialog} busy={busy} dialogError={dialogError} closeDialog={closeDialog}
          homes={homes} areas={[]} controllableDevices={[]}
          onCreateHome={submitCreateHome}
        />
      </Box>
    );
  }

  const anyDevices = devices.length > 0;

  return (
    <Box sx={{ pb: 4 }}>
      {/* Home switcher bar: switching swaps every section below. */}
      <Stack direction="row" spacing={1} alignItems="center" sx={{ flexWrap: "wrap", rowGap: 1 }}>
        {homes.map((item) => (
          <Chip
            key={item._id}
            label={item.name}
            onClick={() => switchHome(item._id)}
            color={item._id === home?._id ? "primary" : "default"}
            variant={item._id === home?._id ? "filled" : "outlined"}
          />
        ))}
        <Chip label="New home" onClick={() => openDialog("create-home")} sx={{ borderStyle: "dashed" }} />
      </Stack>

      <Stack direction="row" alignItems="center" spacing={1.5} sx={{ mt: 1.5 }}>
        <Typography variant="h4">{home?.name || "Your home"}</Typography>
        {ownerHere && <Button size="small" onClick={() => openDialog("rename-home")}>Rename</Button>}
      </Stack>
      {home && (
        <Typography variant="body2" sx={{ color: "text.secondary", mt: 0.5 }}>
          {ownerHere
            ? "You look after this home."
            : visitorAccess
            ? "You hold a visit here, granted for now — everything below was shared with you."
            : "You belong to this home."}
        </Typography>
      )}
      {home && visitorAccess && (
        <Chip
          label="Visiting — the controls granted for this visit"
          variant="outlined"
          size="small"
          sx={{ mt: 1 }}
        />
      )}
      {homeError && <Alert severity="warning" sx={{ mt: 2 }}>{homeError}</Alert>}
      {homeLoading && (
        <Stack direction="row" spacing={1.5} alignItems="center" sx={{ mt: 2 }}>
          <CircularProgress size={18} />
          <Typography variant="body2" sx={{ color: "text.secondary" }}>Loading this home…</Typography>
        </Stack>
      )}

      {/* Rooms */}
      <SectionHeader
        title="Rooms"
        action={(
          !visitorAccess && (
            <Button size="small" startIcon={<AddOutlined />} onClick={() => openDialog("add-area")}>
              Add area
            </Button>
          )
        )}
      />
      <AreaSection groups={grouped.rooms} empty="No rooms yet — add an area to place devices in." renderCard={renderCard} />

      {/* Outdoor areas always render as their own section, never mixed in. */}
      <SectionHeader title="Outdoor areas" />
      <AreaSection groups={grouped.outdoor} empty="No outdoor areas yet." renderCard={renderCard} />

      {/* Cameras (PORCH-139): the family surface rides the engine bridge —
          live grid with per-feed audio, playback with explained gaps, and
          the event/alert surface. Owner controls are in the owner's panel. */}
      {home && !visitorAccess && (
        <CamerasSurface home={home} areas={areas} actions={actions} ownerHere={ownerHere} origin={origin} />
      )}

      <Box sx={{ mt: 2 }}>
        {!visitorAccess && (
          <Button
            size="small"
            startIcon={<AddOutlined />}
            onClick={() => openDialog("add-device")}
            disabled={!areas.length}
          >
            {anyDevices ? "Register another device" : "Register your first device"}
          </Button>
        )}
      </Box>
      <Divider sx={{ mt: 4 }} />

      {/* Scenes */}
      <SectionHeader
        title="Scenes"
        action={(
          !visitorAccess && (
            <Button
              size="small"
              startIcon={<AddOutlined />}
              onClick={() => openDialog("add-scene")}
              disabled={!controllableDevices.length}
            >
              New scene
            </Button>
          )
        )}
      />
      {scenes.length === 0 && <EmptyLine>No scenes yet — group a few device actions into one tap.</EmptyLine>}
      {scenes.map((scene) => (
        <Paper key={scene._id} elevation={0} sx={{ p: 2, mb: 1.25, borderRadius: 3, border: "1px solid", borderColor: "var(--porch-border)", bgcolor: "var(--porch-surface)" }}>
          <Stack direction="row" alignItems="center" justifyContent="space-between">
            <Typography variant="subtitle1" sx={{ fontWeight: 600 }}>{scene.name}</Typography>
            <Button size="small" startIcon={<PlayArrowOutlined />} onClick={() => runScene(scene)}>Run</Button>
          </Stack>
          <Typography variant="body2" sx={{ color: "text.secondary", mt: 0.5 }}>
            {(scene.actions ?? []).map((action) => `${deviceName(action.deviceId) ?? "A device"} — ${commandLabel(action.command)}`).join(" · ") || "No actions in this scene yet."}
          </Typography>
          {sceneResults[scene._id] && (
            <Stack direction="row" spacing={1} sx={{ mt: 1.5, flexWrap: "wrap", rowGap: 1 }}>
              {sceneResults[scene._id].length === 0
                ? <Typography variant="body2" sx={{ color: "text.secondary" }}>Nothing to run.</Typography>
                : sceneResults[scene._id].map((result, index) => (
                  <Chip
                    key={index}
                    size="small"
                    variant="outlined"
                    icon={result.outcome === "confirmed" ? <CheckCircleOutlined sx={{ color: "var(--porch-vote-up)" }} /> : undefined}
                    label={result.outcome === "confirmed"
                      ? `${deviceName(result.deviceId) ?? "A device"}: ${commandLabel(result.command).toLowerCase()} — done`
                      : `${deviceName(result.deviceId) ?? "A device"}: ${result.reason || "did not respond"}`}
                    sx={result.outcome === "confirmed" ? {} : { color: "error.main", borderColor: "error.main" }}
                  />
                ))}
            </Stack>
          )}
        </Paper>
      ))}
      <Divider sx={{ mt: 4 }} />

      {/* Automations */}
      <SectionHeader
        title="Automations"
        action={(
          !visitorAccess && (
            <Button
              size="small"
              startIcon={<AddOutlined />}
              onClick={() => openDialog("add-automation")}
              disabled={!controllableDevices.length}
            >
              New automation
            </Button>
          )
        )}
      />
      {automations.length === 0 && <EmptyLine>No automations yet — let the house act on its own.</EmptyLine>}
      {automations.map((automation) => (
        <Paper key={automation._id} elevation={0} sx={{ p: 2, mb: 1.25, borderRadius: 3, border: "1px solid", borderColor: "var(--porch-border)", bgcolor: "var(--porch-surface)" }}>
          <Stack direction="row" alignItems="center" justifyContent="space-between">
            <Typography variant="subtitle1" sx={{ fontWeight: 600 }}>{automation.name}</Typography>
            {!visitorAccess && (
              <FormControlLabel
                control={<Switch checked={automation.enabled === true} onChange={() => toggleAutomation(automation)} />}
                label={automation.enabled === true ? "On" : "Off"}
                labelPlacement="start"
              />
            )}
          </Stack>
          <Typography variant="body2" sx={{ color: "text.secondary", mt: 0.5 }}>
            {automationTriggerLabel(automation.trigger, areas)}
          </Typography>
          <Typography variant="body2" sx={{ color: "text.secondary", mt: 0.25 }}>
            {(automation.actions ?? []).map((action) => `${deviceName(action.deviceId) ?? "A device"} — ${commandLabel(action.command)}`).join(" · ") || "No actions in this automation yet."}
          </Typography>
          <Typography variant="body2" sx={{ color: "text.muted", mt: 0.5 }}>
            {automation.lastFiredAt ? `Last fired ${relativeTime(automation.lastFiredAt)}.` : "It has not fired yet."}
          </Typography>
        </Paper>
      ))}
      <Divider sx={{ mt: 4 }} />

      {/* Access (PORCH-138): the owner's grant surface of record. A visitor
          never sees this — they hold the visit, they don't grant it. */}
      {ownerHere && (
        <>
          <SectionHeader
            title="Access"
            action={(
              <Button size="small" startIcon={<AddOutlined />} onClick={() => openDialog("add-grant")}>
                Grant a visit
              </Button>
            )}
          />
          <Typography variant="body2" sx={{ color: "text.secondary", mb: 1.5 }}>
            Share what the house can do — to one person or one family — only until the checkout you set. A family visit's parents hand each of their members what part of that envelope they reach.
          </Typography>
          {grantsError && <Alert severity="warning" sx={{ mb: 1.5 }}>{grantsError}</Alert>}
          {grantsLoading && (
            <Typography variant="body2" sx={{ color: "text.secondary" }}>Loading visits…</Typography>
          )}
          {!grantsLoading && grants.length === 0 && !grantsError && (
            <EmptyLine>No visits granted yet — grant one to let someone in for a while.</EmptyLine>
          )}
          {grants.map((grant) => (
            <GrantRow
              key={grant._id}
              grant={grant}
              devices={devices}
              areas={areas}
              scenes={scenes}
              myDid={myDid}
              families={families}
              busy={busy}
              onRevoke={setRevoking}
              onDistribute={distribute(grant)}
              distributionError={distributionError}
            />
          ))}
          <Divider sx={{ mt: 4 }} />
        </>
      )}

      {/* Family organizer (PORCH-138): rides the identity plane, not any one
          home — any signed-in member may start a family; parents govern it. */}
      <SectionHeader
        title="Family organizer"
        action={(
          <Button size="small" startIcon={<AddOutlined />} onClick={() => openDialog("create-family")}>
            New family
          </Button>
        )}
      />
      <Typography variant="body2" sx={{ color: "text.secondary", mb: 1.5 }}>
        Families ride the identity this device already holds. A host's family grant gives its parents an envelope to hand out to their members — the organizer keeps the roles straight.
      </Typography>
      {familiesError && <Alert severity="warning" sx={{ mb: 1.5 }}>{familiesError}</Alert>}
      {!familiesError && families.length === 0 && <EmptyLine>No families yet — start one so a visit can be granted to it.</EmptyLine>}
      {families.map((family) => (
        <FamilyCard key={family._id} family={family} myDid={myDid} mutate={mutateFamily} />
      ))}
      <Divider sx={{ mt: 4 }} />

      {/* Recent activity (audit): a member's window. A visitor's read is
          refused hub-side (E_NOT_PERMITTED), so the whole section stays in
          the members' half of the screen. */}
      {!visitorAccess && (
        <>
          <SectionHeader title="Recent activity" />
          {auditError && <Alert severity="warning" sx={{ mb: 1.5 }}>{auditError}</Alert>}
          {!auditError && (audit.events ?? []).length === 0 && (
            <EmptyLine>{auditLoading ? "Loading recent activity…" : "Nothing has happened in this home yet."}</EmptyLine>
          )}
          {(audit.events ?? []).map((event) => (
        <Stack
          key={event._id}
          direction={{ xs: "column", sm: "row" }}
          spacing={{ xs: 0.25, sm: 1.5 }}
          sx={{ py: 0.75, borderBottom: "1px solid", borderColor: "var(--porch-border)" }}
        >
          <Typography variant="body2" sx={{ fontWeight: 600, minWidth: { sm: 150 }, maxWidth: { sm: 280 } }}>
            {auditLabel(event.type)}
          </Typography>
          <Typography variant="body2" sx={{ color: "text.secondary", flex: 1 }}>
            {actorName(event)}
            {event.deviceId && deviceName(event.deviceId) ? ` · ${deviceName(event.deviceId)}` : ""}
            {event.outcome && event.outcome !== "confirmed" ? ` · ${event.outcome === "failed" ? "it did not go through" : event.outcome}` : ""}
          </Typography>
          <Typography variant="body2" sx={{ color: "text.muted" }} title={dateOf(event.at)}>
            {relativeTime(event.at)}
          </Typography>
        </Stack>
      ))}
      {audit.hasMore && !auditLoading && (
        <Box sx={{ mt: 1.5 }}>
          <Button size="small" onClick={() => loadAudit(home._id, audit.offset)}>Load more</Button>
        </Box>
      )}
        </>
      )}

      <HomeDialogs
        dialog={dialog} busy={busy} dialogError={dialogError} closeDialog={closeDialog}
        home={home} homes={homes} areas={areas} controllableDevices={controllableDevices}
        devices={devices} scenes={scenes} families={families}
        onCreateHome={submitCreateHome}
        onRenameHome={submitRenameHome}
        onAddArea={submitAddArea}
        onAddDevice={submitAddDevice}
        onAddScene={submitAddScene}
        onAddAutomation={submitAddAutomation}
        onCreateGrant={submitCreateGrant}
        onCreateFamily={submitCreateFamily}
      />

      {/* Grant revocation: the app's confirm-reject shape — the consequence
          named in plain language, "keep" rejects, the error-colored button
          confirms, and a refusal renders inside the dialog. */}
      <Dialog open={Boolean(revoking)} onClose={() => { setRevoking(null); setRevokeError(""); }} fullWidth maxWidth="xs">
        <DialogTitle>End this visit early?</DialogTitle>
        <DialogContent>
          <Typography>
            Revoking takes everything {revoking?.createdFor || "this visit"} can reach away the moment you confirm — even if the visit hasn't reached its checkout yet.
          </Typography>
          {revokeError && <Alert severity="warning" sx={{ mt: 2 }}>{revokeError}</Alert>}
        </DialogContent>
        <DialogActions>
          <Button onClick={() => { setRevoking(null); setRevokeError(""); }}>Keep the visit</Button>
          <Button color="error" variant="contained" disabled={busy} onClick={confirmRevoke}>
            {busy ? <CircularProgress size={18} /> : "Revoke the visit"}
          </Button>
        </DialogActions>
      </Dialog>

      {snack && (
        <Alert severity="warning" onClose={() => setSnack("")} sx={{ position: "fixed", bottom: 96, left: 24, zIndex: 30, maxWidth: 420 }}>
          {snack}
        </Alert>
      )}
    </Box>
  );
}

export default HomeDashboard;
