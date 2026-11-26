// PORCH-141: the People & Things surface — the household's own face/plate
// registry, built locally, owned by the household. At the head rides the
// recognition switch of record (the biometric opt-in law's household-visible
// control): off means the registry and its history keep rendering while
// recognition stops upstream entirely — no descriptor computations, no new
// recognition runs — and toggling back on resumes without re-enrollment. The
// Faces and Vehicles sections carry add/rename/delete (deletion is
// confirm-then-refetch: descriptors, plate reads, sightings, and the identity
// annotations purge with the entry), sighting review with open evidence (the
// camera-model eventEvidence + mediaUrl join), and the export — the registry
// leaves the hub only through the household's own explicit act. Every
// mutation is owner-only hub-side; refusals render their plain-language
// message, verbatim.
//
// Pure logic and copy ride people-model.js; the wire rides people-actions.js
// through the shared actions object next to the home actions.
import React, { useEffect, useMemo, useState } from "react";
import {
  Alert, Box, Button, Chip, Dialog, DialogActions, DialogContent, DialogTitle,
  FormControl, InputLabel, MenuItem, Paper, Select, Stack,
  Switch, TextField, Typography,
} from "@mui/material";
import AddOutlined from "@mui/icons-material/AddOutlined";
import DeleteOutlined from "@mui/icons-material/DeleteOutlined";
import DownloadOutlined from "@mui/icons-material/DownloadOutlined";
import EditOutlined from "@mui/icons-material/EditOutlined";
import {
  ACCOUNTABILITY_PREFIX, EVIDENCE_UNOPENABLE_COPY, ENROLL_FOR_OPTIONS,
  FACES_TITLE, HEADING, OFF_POSTURE_COPY, SWITCH_LABEL, SWITCH_VIEWER_COPY, VEHICLES_TITLE,
  decisionLabel, enrolledForCopy, entriesOf, entrySubtitle, evidenceWindow,
  frameFromDataUrl, metricsCopy, sightingCopy, sightingCountCopy, sightingHasEvidence,
  sightedEvent, settingsPosture, validateEnrollDraft, purgeCopy,
} from "./people-model.js";
import { downloadBlob } from "./share-matrix.js";
import { eventEvidence, gapCopy, mediaUrl } from "./camera-model.js";

const messageOf = (error) => error?.message || "That did not work. Please try again.";

const ownerOf = (home) => home?.access?.role === "owner" || home?.role === "owner";

const originOf = (serverUrl) => {
  try {
    return serverUrl ? new URL(serverUrl).origin : null;
  } catch {
    return null;
  }
};

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

/** The switch of record at the People & Things head. Off renders the
 * posture banner; the toggle itself is the owner's control. Exported for
 * the test sweep. */
export function RecognitionSwitch({ settings, ownerHere, busy, error, onToggle }) {
  const posture = settingsPosture(settings);
  return (
    <Box sx={{ mt: 2 }}>
      <Paper variant="outlined" sx={{ p: 2 }}>
        <Stack direction="row" alignItems="center" justifyContent="space-between" spacing={1.5} sx={{ flexWrap: "wrap", useFlexGap: true }}>
          <Stack sx={{ minWidth: 0 }}>
            <Stack direction="row" spacing={1} alignItems="center">
              <Typography variant="subtitle2" sx={{ fontWeight: 600 }}>{SWITCH_LABEL}</Typography>
              <Chip size="small" label={posture.on ? "On" : "Off"} color={posture.on ? "success" : "default"} />
            </Stack>
            <Typography variant="body2" sx={{ color: "text.secondary", mt: 0.5 }}>
              {ownerHere
                ? "Off means recognition stops upstream entirely — nothing computes, no annotations appear — while the registry and its history keep rendering. Turning it back on resumes without re-enrollment."
                : SWITCH_VIEWER_COPY}
            </Typography>
          </Stack>
          <Switch
            checked={posture.on}
            disabled={!ownerHere || busy}
            inputProps={{ "aria-label": SWITCH_LABEL }}
            onChange={(event) => onToggle(event.target.checked)}
          />
        </Stack>
        {error && <Alert severity="warning" sx={{ mt: 1.5 }}>{error}</Alert>}
      </Paper>
      {!posture.on && (
        <Alert severity="info" sx={{ mt: 1.5 }} icon={false}>{OFF_POSTURE_COPY}</Alert>
      )}
      <Typography variant="body2" sx={{ color: "text.secondary", mt: 1.5 }}>{posture.copy}</Typography>
    </Box>
  );
}

/** One sighting row: when, where, the sighting's own confidence under the
 * uncertainty law, and the evidence affordance. Exported for the test sweep. */
export function SightingRow({ entryName, sighting, evidence, onOpen }) {
  const label = decisionLabel(entryName, sighting?.decision, sighting?.confidence);
  const openable = sightingHasEvidence(sighting);
  return (
    <Stack spacing={0.5} sx={{ py: 0.75 }}>
      <Stack direction="row" spacing={1} alignItems="center" sx={{ flexWrap: "wrap", useFlexGap: true }}>
        <Typography variant="body2" sx={{ color: "text.secondary" }}>{sightingCopy(sighting)}</Typography>
        {label && <Chip size="small" label={label} />}
        {openable && (
          <Button size="small" onClick={() => onOpen(sighting)}>Open evidence</Button>
        )}
      </Stack>
      {evidence?.phase === "loading" && (
        <Typography variant="caption" sx={{ color: "text.secondary" }}>Opening that moment's footage…</Typography>
      )}
      {evidence?.phase === "still" && (
        <Box component="img" src={evidence.url} alt="Sighting evidence" sx={{ width: "100%", maxWidth: 420, borderRadius: 2 }} />
      )}
      {evidence?.phase === "gap" && (
        <Typography variant="caption" sx={{ display: "block", color: "text.secondary" }}>{evidence.copy}</Typography>
      )}
    </Stack>
  );
}

/** One registry entry row: name, kind/plate/enrolledFor meta, the sighting
 * review behind one expand, rename, and the confirm-then-refetch delete.
 * Exported for the test sweep. */
export function EntryRow({ entry, evidence, onRename, onDelete, onOpenEvidence, defaultOpen = false }) {
  const [open, setOpen] = useState(defaultOpen === true);
  const meta = enrolledForCopy(entry);
  return (
    <Paper variant="outlined" sx={{ p: 2, mb: 1.5 }}>
      <Stack direction="row" alignItems="center" justifyContent="space-between" spacing={1.5} sx={{ flexWrap: "wrap", useFlexGap: true }}>
        <Stack sx={{ minWidth: 0 }}>
          <Typography variant="subtitle2" sx={{ fontWeight: 600 }}>{entry?.name}</Typography>
          <Typography variant="body2" sx={{ color: "text.secondary", mt: 0.5 }}>
            {entrySubtitle(entry)} · {sightingCountCopy(entry)}
          </Typography>
        </Stack>
        <Stack direction="row" spacing={1} alignItems="center">
          <Button size="small" onClick={() => setOpen(!open)}>{open ? "Hide sightings" : "Review sightings"}</Button>
          <Button size="small" startIcon={<EditOutlined />} onClick={() => onRename(entry)}>Rename</Button>
          <Button size="small" startIcon={<DeleteOutlined />} color="error" onClick={() => onDelete(entry)}>Delete</Button>
        </Stack>
      </Stack>
      {meta && <Typography variant="body2" sx={{ mt: 1 }}>{meta}</Typography>}
      {open && (
        <Stack sx={{ mt: 1, borderTop: "1px solid", borderColor: "divider", pt: 1 }}>
          {(Array.isArray(entry?.sightings) ? entry.sightings : []).length === 0 && (
            <EmptyLine>No sightings recorded yet — recognition will annotate them here as they happen.</EmptyLine>
          )}
          {(Array.isArray(entry?.sightings) ? entry.sightings : []).map((sighting, index) => (
            <SightingRow
              key={index}
              entryName={entry?.name}
              sighting={sighting}
              evidence={evidence?.[`${entry?._id}:${rowKeyOf(sighting)}`]}
              onOpen={(sighting_) => onOpenEvidence(entry, sighting_)}
            />
          ))}
        </Stack>
      )}
    </Paper>
  );
}

/** The sighting state key rides both when and where — one row's evidence. */
function rowKeyOf(sighting) {
  return `${sighting?.at ?? ""}:${sighting?.cameraId ?? ""}`;
}

/** The enrollment dialog: a face needs a JPEG photo (descriptors compute
 * locally); a vehicle carries a plate text and/or a photo; a visit
 * enrollment requires the enrolling member's accountability note. Exported
 * for the test sweep. */
export function EnrollDialog({ kind, open, busy, error, onClose, onSubmit }) {
  const [name, setName] = useState("");
  const [plateText, setPlateText] = useState("");
  const [enrolledFor, setEnrolledFor] = useState("household");
  const [accountabilityNote, setNote] = useState("");
  const [frames, setFrames] = useState([]);
  const [formError, setFormError] = useState("");

  const reset = () => {
    setName("");
    setPlateText("");
    setEnrolledFor("household");
    setNote("");
    setFrames([]);
    setFormError("");
  };

  const pickPhoto = (files) => {
    const list = Array.from(files ?? []).slice(0, 3);
    const frames = [];
    let pending = list.length;
    let refused = false;
    for (const file of list) {
      const reader = new FileReader();
      reader.onload = () => {
        const frame = frameFromDataUrl(String(reader.result ?? ""));
        if (frame) frames.push(frame);
        else refused = true;
        pending -= 1;
        if (pending === 0) {
          setFrames(frames.slice(0, 3));
          setFormError(refused && frames.length === 0 ? "Use a JPEG photo." : "");
        }
      };
      reader.readAsDataURL(file);
    }
  };

  const submit = () => {
    const draft = { kind, name, frames, plateText, enrolledFor, accountabilityNote };
    const refusal = validateEnrollDraft(draft);
    if (refusal) {
      setFormError(refusal);
      return;
    }
    setFormError("");
    onSubmit(draft);
  };

  return (
    <Dialog open={open} onClose={() => { reset(); onClose(); }} maxWidth="sm" fullWidth>
      <DialogTitle>{kind === "face" ? `Add a face to ${FACES_TITLE}` : `Add a vehicle to ${VEHICLES_TITLE}`}</DialogTitle>
      <DialogContent>
        <Stack spacing={1.5} sx={{ mt: 1 }}>
          {(error || formError) && <Alert severity="warning">{error || formError}</Alert>}
          <TextField size="small" label="Name" value={name} onChange={(event) => setName(event.target.value)} />
          {kind === "face" && (
            <Button variant="outlined" component="label" startIcon={<AddOutlined />}>
              {frames.length > 0 ? `${frames.length} photo frame${frames.length === 1 ? "" : "s"} attached` : "Add a JPEG photo of the face"}
              <input type="file" accept="image/jpeg" hidden multiple onChange={(event) => pickPhoto(event.target.files)} />
            </Button>
          )}
          {kind === "vehicle" && (
            <>
              <TextField size="small" label="Plate text" value={plateText} onChange={(event) => setPlateText(event.target.value)} helperText="Optional — leave the plate empty and add a photo instead." />
              <Button variant="outlined" component="label" startIcon={<AddOutlined />}>
                {frames.length > 0 ? `${frames.length} photo frame${frames.length === 1 ? "" : "s"} attached` : "Add a JPEG photo"}
                <input type="file" accept="image/jpeg" hidden multiple onChange={(event) => pickPhoto(event.target.files)} />
              </Button>
            </>
          )}
          <FormControl size="small" fullWidth>
            <InputLabel>Enrolled for</InputLabel>
            <Select value={enrolledFor} label="Enrolled for" onChange={(event) => setEnrolledFor(event.target.value)}>
              {ENROLL_FOR_OPTIONS.map((option) => (
                <MenuItem key={option.value} value={option.value}>{option.label}</MenuItem>
              ))}
            </Select>
          </FormControl>
          {enrolledFor === "visit" && (
            <TextField
              size="small"
              label="Accountability note"
              value={accountabilityNote}
              onChange={(event) => setNote(event.target.value)}
              helperText={`Required for a visit enrollment — you, the enrolling member, own the consent responsibility. ${ACCOUNTABILITY_PREFIX} records it with the entry.`}
            />
          )}
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={() => { reset(); onClose(); }}>Cancel</Button>
        <Button variant="contained" disabled={busy} onClick={submit}>Add entry</Button>
      </DialogActions>
    </Dialog>
  );
}

/** The rename dialog: a vehicle may also correct its plate text. */
function RenameDialog({ entry, open, busy, error, onClose, onSubmit }) {
  const [name, setName] = useState(entry?.name ?? "");
  const [plateText, setPlateText] = useState(entry?.plateText ?? "");
  return (
    <Dialog open={open} onClose={onClose} maxWidth="sm" fullWidth>
      <DialogTitle>Rename {entry?.name}</DialogTitle>
      <DialogContent>
        <Stack spacing={1.5} sx={{ mt: 1 }}>
          {error && <Alert severity="warning">{error}</Alert>}
          <TextField size="small" label="Name" value={name} onChange={(event) => setName(event.target.value)} />
          {entry?.kind === "vehicle" && (
            <TextField size="small" label="Plate text" value={plateText} onChange={(event) => setPlateText(event.target.value)} />
          )}
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>Cancel</Button>
        <Button variant="contained" disabled={busy} onClick={() => onSubmit(entry, { name, plateText })}>Save</Button>
      </DialogActions>
    </Dialog>
  );
}

/** The delete confirmation: names the purge before it happens, and refetch
 * is the only path back. */
function DeleteDialog({ entry, open, busy, error, receipt, onClose, onSubmit }) {
  return (
    <Dialog open={open} onClose={onClose} maxWidth="sm" fullWidth>
      <DialogTitle>Delete {entry?.name}?</DialogTitle>
      <DialogContent>
        <Stack spacing={1.5} sx={{ mt: 1 }}>
          {error && <Alert severity="warning">{error}</Alert>}
          {receipt && <Alert severity="info" icon={false}>{receipt}</Alert>}
          <Typography variant="body2" sx={{ color: "text.secondary" }}>
            Deleting purges this entry's descriptors, plate reads, and sighting history, and removes the identity
            annotations from past events — the events keep their factual content. This cannot be undone.
          </Typography>
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>Keep entry</Button>
        <Button variant="contained" color="error" disabled={busy} onClick={() => onSubmit(entry)}>Delete and purge</Button>
      </DialogActions>
    </Dialog>
  );
}

// The screen. Every read is the screen's own mount work — People & Things
// never gates on the social bootstrap, matching the Home tab's discipline.
export function People({ data, actions }) {
  const origin = originOf(data?.server?.url) || (typeof window !== "undefined" ? window.location.origin : null);

  const [homeId, setHomeId] = useState(null);
  const [ownerHere, setOwnerHere] = useState(false);
  const [hasHome, setHasHome] = useState(true);
  const [settings, setSettings] = useState(null);
  const [entries, setEntries] = useState([]);
  const [metrics, setMetrics] = useState(null);
  const [error, setError] = useState("");
  const [switchBusy, setSwitchBusy] = useState(false);
  const [switchError, setSwitchError] = useState("");
  const [enrollKind, setEnrollKind] = useState(null);
  const [enrollBusy, setEnrollBusy] = useState(false);
  const [enrollError, setEnrollError] = useState("");
  const [renaming, setRenaming] = useState(null);
  const [renameBusy, setRenameBusy] = useState(false);
  const [renameError, setRenameError] = useState("");
  const [deleting, setDeleting] = useState(null);
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [deleteError, setDeleteError] = useState("");
  const [deleteReceipt, setDeleteReceipt] = useState("");
  const [viewToken, setViewToken] = useState(null);
  const [evidence, setEvidence] = useState({});

  /** After every write, the hub answers again — refetch is the state of
   * record, never an optimistic flip. */
  const reloadRegistry = async (id = homeId) => {
    if (!id) return;
    try {
      const [registry, counts] = await Promise.all([actions.loadEntries(id), actions.loadMetrics(id)]);
      setEntries(Array.isArray(registry?.entries) ? registry.entries : []);
      setMetrics(counts?.metrics ?? null);
      setError("");
    } catch (failure) {
      setError(messageOf(failure));
    }
  };

  const reloadSettings = async (id = homeId) => {
    if (!id) return;
    try {
      const answer = await actions.loadRecognitionSettings(id);
      setSettings(answer?.settings ?? null);
    } catch (failure) {
      setSwitchError(messageOf(failure));
    }
  };

  useEffect(() => {
    let stale = false;
    void (async () => {
      setError("");
      try {
        const homes = await actions.loadHomes();
        const first = Array.isArray(homes?.homes) ? homes.homes[0] : null;
        if (!first?._id) {
          if (!stale) setHasHome(false);
          return;
        }
        const detail = await actions.loadHome(first._id);
        if (stale) return;
        setHomeId(first._id);
        setOwnerHere(ownerOf(detail?.home));
        setHasHome(true);
        await Promise.all([
          reloadSettings(first._id),
          reloadRegistry(first._id),
        ]);
      } catch (failure) {
        if (!stale) setError(messageOf(failure));
      }
    })();
    return () => { stale = true; };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps — one mount pass, like the Home tab

  const toggleRecognition = async (next) => {
    setSwitchBusy(true);
    setSwitchError("");
    try {
      await actions.saveRecognitionSettings(homeId, next);
      await reloadSettings();
    } catch (failure) {
      setSwitchError(messageOf(failure));
    } finally {
      setSwitchBusy(false);
    }
  };

  const enroll = async (draft) => {
    setEnrollBusy(true);
    setEnrollError("");
    try {
      await actions.enrollEntry({ homeId, ...draft });
      setEnrollKind(null);
      await reloadRegistry();
    } catch (failure) {
      // The plane's plain-language refusals render verbatim — the switch-off
      // 409 points at the People & Things head by name.
      setEnrollError(messageOf(failure));
    } finally {
      setEnrollBusy(false);
    }
  };

  const rename = async (entry, patch) => {
    setRenameBusy(true);
    setRenameError("");
    try {
      await actions.renameEntry(entry._id, homeId, patch);
      setRenaming(null);
      await reloadRegistry();
    } catch (failure) {
      setRenameError(messageOf(failure));
    } finally {
      setRenameBusy(false);
    }
  };

  const confirmDelete = async (entry) => {
    setDeleteBusy(true);
    setDeleteError("");
    try {
      const answer = await actions.deleteEntry(entry._id, homeId);
      setDeleting(null);
      setDeleteReceipt(purgeCopy(answer));
      await reloadRegistry();
    } catch (failure) {
      setDeleteError(messageOf(failure));
    } finally {
      setDeleteBusy(false);
    }
  };

  const openEvidence = async (entry, sighting) => {
    const key = `${entry?._id}:${rowKeyOf(sighting)}`;
    if (!sightingHasEvidence(sighting)) {
      setEvidence((current) => ({ ...current, [key]: { phase: "gap", copy: EVIDENCE_UNOPENABLE_COPY } }));
      return;
    }
    setEvidence((current) => ({ ...current, [key]: { phase: "loading" } }));
    try {
      const window_ = evidenceWindow(sighting.at);
      if (!window_) throw new Error("That sighting's moment can't be read.");
      let token = viewToken;
      if (!token) {
        const session = await actions.openViewSession(homeId);
        token = session?.token ?? null;
        if (token) setViewToken(token);
      }
      const timeline = await actions.loadTimeline(homeId, { from: window_.from, to: window_.to, cameraId: sighting.cameraId });
      const event = sightedEvent(timeline?.events, sighting);
      const ref = eventEvidence(event);
      if (ref.kind === "gap" || !ref.cameraId || !ref.path) {
        setEvidence((current) => ({ ...current, [key]: { phase: "gap", copy: ref.copy ?? gapCopy("unavailable") } }));
        return;
      }
      const url = mediaUrl({ origin, homeId, cameraId: ref.cameraId, path: ref.path, token });
      setEvidence((current) => ({ ...current, [key]: url
        ? { phase: "still", url }
        : { phase: "gap", copy: gapCopy("unavailable") } }));
    } catch (failure) {
      setEvidence((current) => ({ ...current, [key]: { phase: "gap", copy: messageOf(failure) } }));
    }
  };

  const exportRegistry = async () => {
    setDeleteError("");
    try {
      const bundle = await actions.exportRegistry(homeId);
      downloadBlob(
        new Blob([JSON.stringify(bundle, null, 2)], { type: "application/json" }),
        `porchlight-registry-${homeId}.json`,
      );
    } catch (failure) {
      setError(messageOf(failure));
    }
  };

  const faces = useMemo(() => entriesOf(entries, "face"), [entries]);
  const vehicles = useMemo(() => entriesOf(entries, "vehicle"), [entries]);

  return (
    <Box sx={{ maxWidth: 760, mx: "auto", px: { xs: 2, sm: 3 }, py: { xs: 2, sm: 3 }, pb: 12 }}>
      <Typography variant="h4" sx={{ mb: 0.5 }}>{HEADING}</Typography>
      <Typography variant="body2" sx={{ color: "text.secondary" }}>
        The household's known faces and vehicles, built locally on the hub and owned by you. Recognized identities
        annotate events and visits with the confidence shown; uncertain matches say "looks like", never a bare name.
      </Typography>

      {error && <Alert severity="warning" sx={{ mt: 2 }}>{error}</Alert>}
      {!hasHome && <Alert severity="info" sx={{ mt: 2 }}>No home is open on this device yet — connect to your family's hub first.</Alert>}

      <RecognitionSwitch settings={settings} ownerHere={ownerHere} busy={switchBusy} error={switchError} onToggle={toggleRecognition} />

      {metrics && (
        <Typography variant="body2" sx={{ color: "text.secondary", mt: 1.5 }}>
          Zero-computation audit — {metricsCopy(metrics)}
        </Typography>
      )}

      <SectionHeader
        title={FACES_TITLE}
        action={ownerHere && (
          <Button size="small" startIcon={<AddOutlined />} onClick={() => { setEnrollError(""); setEnrollKind("face"); }}>
            Add a face
          </Button>
        )}
      />
      {faces.length === 0 && <EmptyLine>No faces enrolled yet.</EmptyLine>}
      {faces.map((entry) => (
        <EntryRow
          key={entry?._id}
          entry={entry}
          evidence={evidence}
          onRename={setRenaming}
          onDelete={(candidate) => { setDeleteReceipt(""); setDeleting(candidate); }}
          onOpenEvidence={openEvidence}
        />
      ))}

      <SectionHeader
        title={VEHICLES_TITLE}
        action={ownerHere && (
          <Button size="small" startIcon={<AddOutlined />} onClick={() => { setEnrollError(""); setEnrollKind("vehicle"); }}>
            Add a vehicle
          </Button>
        )}
      />
      {vehicles.length === 0 && <EmptyLine>No vehicles enrolled yet.</EmptyLine>}
      {vehicles.map((entry) => (
        <EntryRow
          key={entry?._id}
          entry={entry}
          evidence={evidence}
          onRename={setRenaming}
          onDelete={(candidate) => { setDeleteReceipt(""); setDeleting(candidate); }}
          onOpenEvidence={openEvidence}
        />
      ))}

      {ownerHere && (
        <SectionHeader
          title="Your data"
          action={(
            <Button size="small" startIcon={<DownloadOutlined />} onClick={exportRegistry}>
              Export registry
            </Button>
          )}
        />
      )}
      {ownerHere && (
        <EmptyLine>
          Export writes the whole registry — entries, descriptors, plate reads, sightings — to one file you download.
          The registry never leaves the hub any other way.
        </EmptyLine>
      )}

      <EnrollDialog
        kind={enrollKind}
        open={enrollKind != null}
        busy={enrollBusy}
        error={enrollError}
        onClose={() => { setEnrollKind(null); setEnrollError(""); }}
        onSubmit={enroll}
      />
      {renaming && (
        <RenameDialog
          entry={renaming}
          open
          busy={renameBusy}
          error={renameError}
          onClose={() => { setRenaming(null); setRenameError(""); }}
          onSubmit={rename}
        />
      )}
      {deleting && (
        <DeleteDialog
          entry={deleting}
          open
          busy={deleteBusy}
          error={deleteError}
          receipt={deleteReceipt}
          onClose={() => { setDeleting(null); setDeleteError(""); }}
          onSubmit={confirmDelete}
        />
      )}
    </Box>
  );
}
