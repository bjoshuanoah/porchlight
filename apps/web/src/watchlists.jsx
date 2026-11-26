// PORCH-142: the Watchlists surface — trainable object classes, taught from a
// handful of example photos and owned by the household. A class lists its
// example thumbnails (bounded), its tracking scope, and its expected-accuracy
// answer; its verbs are "Retrain with more examples", a detections review
// under the same uncertainty law as People & Things, and "Delete class"
// (confirm-then-refetch: the example photos and the recorded detections purge
// with the class). A flagged camera event feeds its detection back through
// the home tab's flag hook, so a correction needs no manual photo hunt. Every
// mutation is owner-only hub-side; refusals render their plain-language
// message, verbatim.
//
// Pure logic and copy ride watchlists-model.js; the wire rides
// watchlists-actions.js through the shared actions object next to the home
// actions; the uncertainty labeler and the JPEG frame picker are People &
// Things' own helpers, reused — never restated.
import React, { useEffect, useMemo, useState } from "react";
import {
  Alert, Box, Button, Chip, Dialog, DialogActions, DialogContent, DialogTitle,
  Paper, Stack, TextField, Typography,
} from "@mui/material";
import AddOutlined from "@mui/icons-material/AddOutlined";
import DeleteOutlined from "@mui/icons-material/DeleteOutlined";
import RefreshOutlined from "@mui/icons-material/RefreshOutlined";
import VisibilityOutlined from "@mui/icons-material/VisibilityOutlined";
import VisibilityOffOutlined from "@mui/icons-material/VisibilityOffOutlined";
import {
  ACCURACY_NOTE, CREATE_TITLE, HEADING, TEACHING_COPY,
  accuracyStatement, detectionCopy, detectionsForClass, examplesCopy,
  purgeReceipt, scopeHint, scopeLabel, thumbnailsOf, validateClassDraft,
} from "./watchlists-model.js";
import { confidencePercent, decisionLabelOf, frameFromDataUrl } from "./people-model.js";

const messageOf = (error) => error?.message || "That did not work. Please try again.";

const ownerOf = (home) => home?.access?.role === "owner" || home?.role === "owner";

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

/** One class's bounded detections read, loaded on open. */
function DetectionsPanel({ cls, homeId, actions }) {
  const [answer, setAnswer] = useState(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let stale = false;
    setLoading(true);
    void (async () => {
      try {
        const rows = await actions.loadWatchlistDetections(cls._id, homeId);
        if (!stale) {
          setAnswer(rows ?? null);
          setError("");
        }
      } catch (failure) {
        if (!stale) setError(messageOf(failure));
      } finally {
        if (!stale) setLoading(false);
      }
    })();
    return () => { stale = true; };
  }, [cls?._id, homeId]); // eslint-disable-line react-hooks/exhaustive-deps — one load per open

  const names = useMemo(() => ({ [cls?._id]: cls?.label }), [cls?._id, cls?.label]);
  const rows = detectionsForClass(answer);

  return (
    <Stack>
      {loading && <EmptyLine>Reading this class's recorded detections…</EmptyLine>}
      {!loading && error && <Alert severity="warning">{error}</Alert>}
      {!loading && !error && rows.length === 0 && (
        <EmptyLine>No recorded detections for this class yet — trained classes log them as cameras see them.</EmptyLine>
      )}
      {!loading && !error && rows.map((row) => (
        <DetectionRow key={row?._id ?? row?.at} names={names} classId={cls?._id} row={row} />
      ))}
    </Stack>
  );
}

/** One detection row: when and where, the row's label under the uncertainty
 * law (an unasserted match renders "looks like", never a bare name), and the
 * confidence percent shown beside asserted rows. Exported for the test sweep. */
export function DetectionRow({ names, classId, row }) {
  const label = decisionLabelOf(names, {
    entryId: row?.classId ?? classId,
    decision: row?.decision,
    confidence: row?.confidence,
  });
  const percent = row?.decision === "asserted" ? confidencePercent(row?.confidence) : null;
  return (
    <Stack direction="row" spacing={1} alignItems="center" sx={{ flexWrap: "wrap", useFlexGap: true, py: 0.75 }}>
      <Typography variant="body2" sx={{ color: "text.secondary" }}>{detectionCopy(row)}</Typography>
      {label && (
        <Stack direction="row" spacing={1} alignItems="center">
          {percent != null && <Chip size="small" label={`${percent}%`} />}
          <Chip size="small" label={label} />
        </Stack>
      )}
    </Stack>
  );
}

/** One trained-class row: bounded example thumbnails, label, scope chip with
 * its plain-language hint, the expected-accuracy statement, and the row's
 * verbs. Exported for the test sweep. */
export function ClassRow({ cls, homeId, actions, ownerHere, detectionsOpen, onToggleDetections, onRetrain, onDelete }) {
  const scope = scopeLabel(cls?.trackingScope);
  const hint = scopeHint(cls?.trackingScope);
  const accuracy = accuracyStatement(cls);
  const thumbnails = thumbnailsOf(cls);
  return (
    <Paper variant="outlined" sx={{ p: 2, mb: 1.5 }}>
      <Stack direction="row" alignItems="center" justifyContent="space-between" spacing={1.5} sx={{ flexWrap: "wrap", useFlexGap: true }}>
        <Stack direction="row" spacing={1.5} alignItems="center" sx={{ minWidth: 0 }}>
          {thumbnails.length > 0 && (
            <Stack direction="row" spacing={0.5}>
              {thumbnails.map((image, index) => (
                <Box
                  key={index}
                  component="img"
                  src={image}
                  alt={`Example photo for ${cls?.label ?? "this class"}`}
                  sx={{ width: 56, height: 56, objectFit: "cover", borderRadius: 2 }}
                />
              ))}
            </Stack>
          )}
          <Stack sx={{ minWidth: 0 }}>
            <Stack direction="row" spacing={1} alignItems="center">
              <Typography variant="subtitle2" sx={{ fontWeight: 600 }}>{cls?.label}</Typography>
              {scope && <Chip size="small" label={scope} color={cls?.trackingScope === "tracked" ? "success" : "default"} />}
            </Stack>
            <Typography variant="body2" sx={{ color: "text.secondary", mt: 0.5 }}>{examplesCopy(cls)}</Typography>
          </Stack>
        </Stack>
        <Stack direction="row" spacing={1} alignItems="center">
          <Button
            size="small"
            startIcon={detectionsOpen ? <VisibilityOffOutlined /> : <VisibilityOutlined />}
            onClick={() => onToggleDetections(cls)}
          >
            {detectionsOpen ? "Hide detections" : "View detections"}
          </Button>
          {ownerHere && (
            <Button size="small" startIcon={<RefreshOutlined />} onClick={() => onRetrain(cls)}>
              Retrain with more examples
            </Button>
          )}
          {ownerHere && (
            <Button size="small" startIcon={<DeleteOutlined />} color="error" onClick={() => onDelete(cls)}>
              Delete class
            </Button>
          )}
        </Stack>
      </Stack>
      {hint && <Typography variant="body2" sx={{ color: "text.secondary", mt: 1 }}>{hint}</Typography>}
      {accuracy && <Typography variant="body2" sx={{ color: "text.secondary", mt: 0.5 }}>{accuracy}</Typography>}
      {detectionsOpen && (
        <Stack sx={{ mt: 1, borderTop: "1px solid", borderColor: "divider", pt: 1 }}>
          <DetectionsPanel cls={cls} homeId={homeId} actions={actions} />
        </Stack>
      )}
    </Paper>
  );
}

/** The class create panel: the name field, the example upload, the "Train on
 * this device" verb, and the honesty surface — the few-shot bound copy rides
 * BEFORE any training happens, and the train answer's expected accuracy
 * renders after. Exported for the test sweep. */
export function CreatePanel({ ownerHere, busy, error, draftCopy, onTrain }) {
  const [label, setLabel] = useState("");
  const [frames, setFrames] = useState([]);
  const [formError, setFormError] = useState("");

  const reset = () => {
    setLabel("");
    setFrames([]);
    setFormError("");
  };

  const pickExamples = (files) => {
    const list = Array.from(files ?? []).slice(0, 3);
    const picked = [];
    let pending = list.length;
    let refused = false;
    for (const file of list) {
      const reader = new FileReader();
      reader.onload = () => {
        const frame = frameFromDataUrl(String(reader.result ?? ""));
        if (frame) picked.push(frame);
        else refused = true;
        pending -= 1;
        if (pending === 0) {
          setFrames(picked.slice(0, 3));
          setFormError(refused && picked.length === 0 ? "Use a JPEG photo." : "");
        }
      };
      reader.readAsDataURL(file);
    }
  };

  const submit = () => {
    const draft = { label, frames };
    const refusal = validateClassDraft(draft);
    if (refusal) {
      setFormError(refusal);
      return;
    }
    setFormError("");
    onTrain(draft, reset);
  };

  return (
    <Paper variant="outlined" sx={{ p: 2, mt: 2 }}>
      <Typography variant="subtitle2" sx={{ fontWeight: 600 }}>{CREATE_TITLE}</Typography>
      <Stack spacing={1.5} sx={{ mt: 1.5 }}>
        {(error || formError) && <Alert severity="warning">{error || formError}</Alert>}
        {draftCopy && <Alert severity="info" icon={false}>{draftCopy}</Alert>}
        <Stack direction="row" spacing={1.5} sx={{ flexWrap: "wrap", useFlexGap: true }}>
          <TextField
            size="small"
            label="What should the hub learn to name?"
            value={label}
            onChange={(event) => setLabel(event.target.value)}
            sx={{ minWidth: 260, flexGrow: 1 }}
          />
          <Button variant="outlined" component="label" startIcon={<AddOutlined />}>
            {frames.length > 0 ? `${frames.length} example photo${frames.length === 1 ? "" : "s"} attached` : "Add example photos"}
            <input type="file" accept="image/jpeg" hidden multiple onChange={(event) => pickExamples(event.target.files)} />
          </Button>
        </Stack>
        <Button variant="contained" disabled={!ownerHere || busy} onClick={submit}>
          Train on this device
        </Button>
        <Typography variant="body2" sx={{ color: "text.secondary" }}>{TEACHING_COPY}</Typography>
      </Stack>
    </Paper>
  );
}

/** The retrain dialog: more example frames for the pool; the held-out replay
 * answers again and the refreshed expected accuracy renders after. */
function RetrainDialog({ cls, open, busy, error, onClose, onSubmit }) {
  const [frames, setFrames] = useState([]);
  const [formError, setFormError] = useState("");

  const pickExamples = (files) => {
    const list = Array.from(files ?? []).slice(0, 3);
    const picked = [];
    let pending = list.length;
    let refused = false;
    for (const file of list) {
      const reader = new FileReader();
      reader.onload = () => {
        const frame = frameFromDataUrl(String(reader.result ?? ""));
        if (frame) picked.push(frame);
        else refused = true;
        pending -= 1;
        if (pending === 0) {
          setFrames(picked.slice(0, 3));
          setFormError(refused && picked.length === 0 ? "Use a JPEG photo." : "");
        }
      };
      reader.readAsDataURL(file);
    }
  };

  const submit = () => {
    if (!Array.isArray(frames) || frames.length === 0) {
      setFormError("Add at least one photo showing the thing to learn.");
      return;
    }
    setFormError("");
    onSubmit(cls, frames);
  };

  return (
    <Dialog open={open} onClose={() => { setFrames([]); setFormError(""); onClose(); }} maxWidth="sm" fullWidth>
      <DialogTitle>Retrain {cls?.label} with more examples</DialogTitle>
      <DialogContent>
        <Stack spacing={1.5} sx={{ mt: 1 }}>
          {(error || formError) && <Alert severity="warning">{error || formError}</Alert>}
          <Alert severity="info" icon={false}>{ACCURACY_NOTE}</Alert>
          <Button variant="outlined" component="label" startIcon={<AddOutlined />}>
            {frames.length > 0 ? `${frames.length} example photo${frames.length === 1 ? "" : "s"} attached` : "Add example photos"}
            <input type="file" accept="image/jpeg" hidden multiple onChange={(event) => pickExamples(event.target.files)} />
          </Button>
          <Typography variant="body2" sx={{ color: "text.secondary" }}>
            More examples grow the pool; the hub replays what it kept aside and answers with the fresh expected accuracy.
          </Typography>
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={() => { setFrames([]); setFormError(""); onClose(); }}>Cancel</Button>
        <Button variant="contained" disabled={busy} onClick={submit}>Retrain class</Button>
      </DialogActions>
    </Dialog>
  );
}

/** The delete confirmation: names the purge before it happens, and refetch
 * is the only path back. */
function DeleteDialog({ cls, open, busy, error, receipt, onClose, onSubmit }) {
  return (
    <Dialog open={open} onClose={onClose} maxWidth="sm" fullWidth>
      <DialogTitle>Delete {cls?.label}?</DialogTitle>
      <DialogContent>
        <Stack spacing={1.5} sx={{ mt: 1 }}>
          {error && <Alert severity="warning">{error}</Alert>}
          {receipt && <Alert severity="info" icon={false}>{receipt}</Alert>}
          <Typography variant="body2" sx={{ color: "text.secondary" }}>
            Deleting purges this class's example photos and its recorded detections — the hub stops naming this
            class, and nothing trained on it answers afterward. This cannot be undone.
          </Typography>
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>Keep class</Button>
        <Button variant="contained" color="error" disabled={busy} onClick={() => onSubmit(cls)}>Delete and purge</Button>
      </DialogActions>
    </Dialog>
  );
}

// The screen. Every read is the screen's own mount work — Watchlists never
// gates on the social bootstrap, matching the People & Things discipline.
export function Watchlists({ data, actions }) {
  const [homeId, setHomeId] = useState(null);
  const [ownerHere, setOwnerHere] = useState(false);
  const [hasHome, setHasHome] = useState(true);
  const [classes, setClasses] = useState([]);
  const [error, setError] = useState("");
  const [createBusy, setCreateBusy] = useState(false);
  const [createError, setCreateError] = useState("");
  const [trainReceipt, setTrainReceipt] = useState("");
  const [retraining, setRetraining] = useState(null);
  const [retrainBusy, setRetrainBusy] = useState(false);
  const [retrainError, setRetrainError] = useState("");
  const [deleting, setDeleting] = useState(null);
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [deleteError, setDeleteError] = useState("");
  const [deleteReceipt, setDeleteReceipt] = useState("");
  const [openDetections, setOpenDetections] = useState({});

  /** After every write, the hub answers again — refetch is the state of
   * record, never an optimistic flip. */
  const reloadClasses = async (id = homeId) => {
    if (!id) return;
    try {
      const answer = await actions.loadWatchlists(id);
      setClasses(Array.isArray(answer?.classes) ? answer.classes : []);
      setError("");
    } catch (failure) {
      setError(messageOf(failure));
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
        await reloadClasses(first._id);
      } catch (failure) {
        if (!stale) setError(messageOf(failure));
      }
    })();
    return () => { stale = true; };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps — one mount pass, like People & Things

  const train = async (draft, done) => {
    setCreateBusy(true);
    setCreateError("");
    setTrainReceipt("");
    try {
      const answer = await actions.createWatchlistClass({ homeId, label: draft.label, frames: draft.frames });
      if (typeof done === "function") done();
      setTrainReceipt(
        `${answer?.class?.label ?? "The new class"} is trained. ${accuracyStatement(answer?.class ?? answer) ?? ACCURACY_NOTE}`,
      );
      await reloadClasses();
    } catch (failure) {
      // The plane's plain-language refusals render verbatim — the non-owner
      // 403 is the error the same Alert renders.
      setCreateError(messageOf(failure));
    } finally {
      setCreateBusy(false);
    }
  };

  const retrain = async (cls, frames) => {
    setRetrainBusy(true);
    setRetrainError("");
    try {
      await actions.retrainWatchlistClass({ classId: cls._id, homeId, frames });
      setRetraining(null);
      await reloadClasses();
    } catch (failure) {
      setRetrainError(messageOf(failure));
    } finally {
      setRetrainBusy(false);
    }
  };

  const confirmDelete = async (cls) => {
    setDeleteBusy(true);
    setDeleteError("");
    try {
      const answer = await actions.deleteWatchlistClass(cls._id, homeId);
      setDeleting(null);
      setOpenDetections((current) => ({ ...current, [cls._id]: false }));
      setDeleteReceipt(purgeReceipt(answer));
      await reloadClasses();
    } catch (failure) {
      setDeleteError(messageOf(failure));
    } finally {
      setDeleteBusy(false);
    }
  };

  return (
    <Box sx={{ maxWidth: 760, mx: "auto", px: { xs: 2, sm: 3 }, py: { xs: 2, sm: 3 }, pb: 12 }}>
      <Typography variant="h4" sx={{ mb: 0.5 }}>{HEADING}</Typography>
      <Typography variant="body2" sx={{ color: "text.secondary" }}>
        Train the hub to name the things your cameras see, from a handful of example photos. Classes below their
        calibrated threshold render "looks like" — never a bare name — and a flagged event feeds its own detection back.
      </Typography>

      {error && <Alert severity="warning" sx={{ mt: 2 }}>{error}</Alert>}
      {!hasHome && <Alert severity="info" sx={{ mt: 2 }}>No home is open on this device yet — connect to your family's hub first.</Alert>}

      <CreatePanel
        ownerHere={ownerHere}
        busy={createBusy}
        error={createError}
        draftCopy={trainReceipt}
        onTrain={train}
      />

      <SectionHeader title="Trained classes" />
      {classes.length === 0 && <EmptyLine>Nothing trained yet — teach the hub with a handful of example photos above.</EmptyLine>}
      {classes.map((cls) => (
        <ClassRow
          key={cls?._id}
          cls={cls}
          homeId={homeId}
          actions={actions}
          ownerHere={ownerHere}
          detectionsOpen={openDetections[cls?._id] === true}
          onToggleDetections={(candidate) => setOpenDetections((current) => ({ ...current, [candidate?._id]: !current[candidate?._id] }))}
          onRetrain={(candidate) => { setRetrainError(""); setRetraining(candidate); }}
          onDelete={(candidate) => { setDeleteReceipt(""); setDeleting(candidate); }}
        />
      ))}

      {retraining && (
        <RetrainDialog
          cls={retraining}
          open
          busy={retrainBusy}
          error={retrainError}
          onClose={() => { setRetraining(null); setRetrainError(""); }}
          onSubmit={retrain}
        />
      )}
      {deleting && (
        <DeleteDialog
          cls={deleting}
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
