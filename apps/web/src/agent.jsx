// PORCH-150: the Agent tab — the model-profile surfaces riding PORCH-148's
// one machinery. The member card is the member-facing surface of record the
// PRD names: which model is running and its provider CLASS (never an
// endpoint, never a token — the hub's own member projection refuses them by
// construction), rendered by the never-silent law with every earned state
// (degraded, unassigned, parental-blocked) named in plain language. The
// admin sections are the hub-admin's profile definitions and assignments:
// the create form captures name, provider class, model, and — where the
// class uses one — an endpoint REFERENCE that is explicitly not an address
// (endpointRefs/keys ride the server's existing secrets handling; nothing is
// invented here), a type/member assignment editor that renders the explicit
// unassigned state for a queried agent type, and the availability flip whose
// withholding is audited hub-side. Enforcement is never duplicated here:
// every write rides the agent module's own assignment/definition paths, and
// a non-admin's refusal renders verbatim.
//
// The parent-facing narrowing control does NOT live on this tab — it renders
// exactly inside the family organizer (home.jsx FamilyCard, PRD 2's F9
// resolution), using these same agent actions; no parental profile control
// exists anywhere else.
//
// Pure logic and copy ride agent-model.js; the wire rides agent-actions.js.
import React, { useEffect, useState } from "react";
import {
  Alert, Box, Button, Dialog, DialogActions, DialogContent, DialogTitle,
  FormControl, FormControlLabel, IconButton, InputLabel, MenuItem, Paper,
  Select, Stack, Switch, TextField, Typography,
} from "@mui/material";
import AddOutlined from "@mui/icons-material/AddOutlined";
import RefreshOutlined from "@mui/icons-material/RefreshOutlined";
import {
  PROVIDER_CLASSES, assignmentPayload, assignmentTargetLabel,
  memberStateCopy, profileFormReady, providerClassLabel,
} from "./agent-model.js";

const messageOf = (error) => error?.message || "That did not work. Please try again.";

function SectionHeader({ title, action }) {
  return (
    <Box sx={{ display: "flex", alignItems: "center", justifyContent: "space-between", mb: 1.5 }}>
      <Typography variant="h6">{title}</Typography>
      {action}
    </Box>
  );
}

function EmptyLine({ children }) {
  return <Typography variant="body2" sx={{ color: "text.muted" }}>{children}</Typography>;
}

const surface = { p: 2, mb: 1.5, borderRadius: 3, bgcolor: "var(--porch-surface)", border: "1px solid", borderColor: "var(--porch-border)" };

/** One selectable-profile row in the member card: name, model, class, and
 * the self-selection action that rides the ONE assignment path. */
function SelectableProfileRow({ profile, busy, onChoose }) {
  return (
    <Stack direction={{ xs: "column", sm: "row" }} spacing={{ xs: 0.5, sm: 1.5 }} sx={{ py: 0.75, borderBottom: "1px solid", borderColor: "var(--porch-border)" }} alignItems={{ sm: "center" }}>
      <Typography variant="body2" sx={{ fontWeight: 600, minWidth: { sm: 160 } }}>{profile.name}</Typography>
      <Typography variant="body2" sx={{ color: "text.secondary", flex: 1 }}>
        {profile.modelId} · {providerClassLabel(profile.providerClass)}
      </Typography>
      <Button size="small" variant="outlined" disabled={busy} onClick={() => onChoose(profile.profileId)}>
        Use this model
      </Button>
    </Stack>
  );
}

/** The member-facing card of record: the running model + provider class, the
 * earned state named (never silent), and the member-selectable list. */
export function MyAgentCard({ model, profiles, busy, error, chooseError, onChoose, onRefresh }) {
  const copy = memberStateCopy(model);
  return (
    <Paper elevation={0} sx={surface}>
      <Stack direction="row" spacing={1} alignItems="center" sx={{ mb: 1 }}>
        <Typography variant="subtitle1" sx={{ fontWeight: 600, flex: 1 }}>
          {model?.model ? "Your agent's running model" : "Your agent"}
        </Typography>
        <IconButton size="small" onClick={onRefresh} aria-label="Refresh agent model"><RefreshOutlined /></IconButton>
      </Stack>
      {error && <Alert severity="warning" sx={{ mb: 1.5 }}>{error}</Alert>}
      <Alert severity={copy.tone} sx={{ mb: 1.5 }}>
        <Typography variant="body2" sx={{ fontWeight: 600 }}>{copy.line}</Typography>
        {copy.reason && <Typography variant="body2">{copy.reason}</Typography>}
      </Alert>
      <Typography variant="body2" sx={{ color: "text.secondary", mb: 1 }}>
        Models your family's hub lets you use — choosing one applies to your agent's next turn.
      </Typography>
      {Array.isArray(profiles) && profiles.length === 0 && (
        <EmptyLine>No model profiles have been made available to members yet.</EmptyLine>
      )}
      {(profiles ?? []).map((profile) => (
        <SelectableProfileRow key={profile.profileId} profile={profile} busy={busy} onChoose={onChoose} />
      ))}
      {chooseError && <Alert severity="warning" sx={{ mt: 1.5 }}>{chooseError}</Alert>}
    </Paper>
  );
}

/** One admin profile row: name, model, class, endpointRef reference (admin
 * projection only — the member-facing surfaces never receive this field),
 * and the availability flip whose withholding is the hub's audited ceiling. */
export function ProfileRow({ profile, busy, onAvailability }) {
  return (
    <Stack direction={{ xs: "column", sm: "row" }} spacing={{ xs: 0.5, sm: 1.5 }} sx={{ py: 0.75, borderBottom: "1px solid", borderColor: "var(--porch-border)" }} alignItems={{ sm: "center" }}>
      <Typography variant="body2" sx={{ fontWeight: 600, minWidth: { sm: 160 } }}>{profile.name}</Typography>
      <Typography variant="body2" sx={{ color: "text.secondary", flex: 1 }}>
        {profile.modelId} · {providerClassLabel(profile.providerClass)}
        {profile.endpointRef ? ` · secrets ref ${profile.endpointRef}` : ""}
      </Typography>
      <FormControlLabel
        control={<Switch size="small" checked={Boolean(profile.memberSelectable)} disabled={busy}
          onChange={(event) => onAvailability(profile, event.target.checked)} />}
        label={<Typography variant="body2" sx={{ color: "text.secondary" }}>
          {profile.memberSelectable ? "Members can use" : "Withheld from members"}
        </Typography>}
      />
    </Stack>
  );
}

/** The admin create form's dialog: name, provider class, model, and where the
 * class uses one, the endpoint REFERENCE field with its not-an-address copy.
 * Validation beyond required-field presence is the hub's law; a refused
 * write renders the hub's own plain language. */
export function CreateProfileDialog({ open, busy, error, onClose, onSubmit }) {
  const empty = { name: "", providerClass: "local-server", modelId: "", endpointRef: "", memberSelectable: true };
  const [draft, setDraft] = useState(empty);
  useEffect(() => { if (open) setDraft(empty); }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  const native = draft.providerClass === "native-mlx";
  const submit = (event) => {
    event.preventDefault();
    onSubmit(draft).then((ok) => { if (ok) onClose(); });
  };

  return (
    <Dialog open={open} onClose={onClose} fullWidth maxWidth="sm">
      <DialogTitle>Define a model profile</DialogTitle>
      <Box component="form" onSubmit={submit}>
        <DialogContent>
          <Stack spacing={2}>
            <TextField size="small" label="Profile name" value={draft.name}
              onChange={(event) => setDraft((value) => ({ ...value, name: event.target.value }))} />
            <FormControl size="small" fullWidth>
              <InputLabel id="agent-profile-class-label">Provider class</InputLabel>
              <Select labelId="agent-profile-class-label" label="Provider class" value={draft.providerClass}
                onChange={(event) => setDraft((value) => ({ ...value, providerClass: event.target.value }))}>
                {PROVIDER_CLASSES.map((cls) => (
                  <MenuItem key={cls} value={cls}>{providerClassLabel(cls)}</MenuItem>
                ))}
              </Select>
            </FormControl>
            <TextField size="small" label="Model" placeholder="e.g. glm-5.3 or gemma4:e2b-mlx" value={draft.modelId}
              onChange={(event) => setDraft((value) => ({ ...value, modelId: event.target.value }))} />
            {!native && (
              <TextField size="small" label="Endpoint reference (secrets)" value={draft.endpointRef}
                helperText="A reference into the hub's existing secrets handling — never an address. Native classes use this hub's own runtime and carry none."
                onChange={(event) => setDraft((value) => ({ ...value, endpointRef: event.target.value }))} />
            )}
            <FormControlLabel
              control={<Switch checked={Boolean(draft.memberSelectable)}
                onChange={(event) => setDraft((value) => ({ ...value, memberSelectable: event.target.checked }))} />}
              label={<Typography variant="body2">Available to members — members can select this profile for their own agents (the flip is audited).</Typography>}
            />
          </Stack>
        </DialogContent>
        <DialogActions>
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="contained" disabled={busy || !profileFormReady(draft)}>Define profile</Button>
        </DialogActions>
        {error && <Alert severity="warning" sx={{ m: 2, mt: 0 }}>{error}</Alert>}
      </Box>
    </Dialog>
  );
}

/** The hub-admin profiles card: every defined profile (including withheld
 * ones — availability is the admin's ruling to make, not hide) and the
 * define action. A non-admin's read refuses hub-side; the refusal renders. */
export function ProfilesAdmin({ profiles, error, busy, onAvailability, onOpenCreate }) {
  return (
    <Paper elevation={0} sx={surface}>
      <SectionHeader title="Model profiles" action={(
        <Button size="small" startIcon={<AddOutlined />} onClick={onOpenCreate}>Define a profile</Button>
      )} />
      <Typography variant="body2" sx={{ color: "text.secondary", mb: 1 }}>
        Each profile names where an agent thinks — model and provider class. Endpoint references resolve in the hub's existing secrets handling; members never see addresses or keys.
      </Typography>
      {error && <Alert severity="warning" sx={{ mb: 1.5 }}>{error}</Alert>}
      {!error && Array.isArray(profiles) && profiles.length === 0 && (
        <EmptyLine>No profiles defined yet — define one to assign it to an agent type or member.</EmptyLine>
      )}
      {(profiles ?? []).map((profile) => (
        <ProfileRow key={profile._id} profile={profile} busy={busy} onAvailability={onAvailability} />
      ))}
    </Paper>
  );
}

/** One assignment row: target, profile, who/when, and the revoke act that
 * renders the target explicitly unassigned again. */
export function AssignmentRow({ row, busy, onRevoke }) {
  return (
    <Stack direction={{ xs: "column", sm: "row" }} spacing={{ xs: 0.5, sm: 1.5 }} sx={{ py: 0.75, borderBottom: "1px solid", borderColor: "var(--porch-border)" }} alignItems={{ sm: "center" }}>
      <Typography variant="body2" sx={{ fontWeight: 600, minWidth: { sm: 200 } }}>{assignmentTargetLabel(row.target)}</Typography>
      <Typography variant="body2" sx={{ color: "text.secondary", flex: 1 }}>
        {row.profile?.name ? `${row.profile.name} · ${row.profile.modelId} · ${providerClassLabel(row.profile.providerClass)}` : "The assigned profile no longer exists"}
        {` · assigned ${row.assignedAt}`}
      </Typography>
      <Button size="small" color="error" disabled={busy} onClick={() => onRevoke(row)}>Revoke</Button>
    </Stack>
  );
}

/** The explicit unassigned state (ac-3): a queried agent type with no
 * assignment renders the hub's own detail — never a silent default model. */
export function TypeAssignmentState({ typeState, error }) {
  const unassigned = typeState?.state === "unassigned";
  return (
    <Paper elevation={0} sx={surface}>
      <SectionHeader title="Household-member agent type" />
      <Typography variant="body2" sx={{ color: "text.secondary", mb: 1 }}>
        The type's default profile answers for members without their own assignment.
      </Typography>
      {error && <Alert severity="warning" sx={{ mb: 1.5 }}>{error}</Alert>}
      {!error && unassigned && (
        <Alert severity="info">
          <Typography variant="body2" sx={{ fontWeight: 600 }}>Unassigned</Typography>
          <Typography variant="body2">{typeState.detail}</Typography>
        </Alert>
      )}
      {!error && typeState?.state === "assigned" && (
        <Stack direction={{ xs: "column", sm: "row" }} spacing={{ xs: 0.5, sm: 1.5 }} sx={{ py: 0.75, borderBottom: "1px solid", borderColor: "var(--porch-border)" }} alignItems={{ sm: "center" }}>
          <Typography variant="body2" sx={{ fontWeight: 600, minWidth: { sm: 200 } }}>Agent type · {typeState.agentType}</Typography>
          <Typography variant="body2" sx={{ color: "text.secondary", flex: 1 }}>
            {typeState.profile ? `${typeState.profile.name} · ${typeState.profile.modelId}` : "The assigned profile no longer exists"}
          </Typography>
        </Stack>
      )}
      {!error && typeState == null && <EmptyLine>Reading the agent type's assignment…</EmptyLine>}
    </Paper>
  );
}

/** The assign form: exactly one target — the household-member agent type or a
 * member by DID — and the profile to ride. The hub refuses anything else. */
export function AssignForm({ profiles, busy, error, onAssign }) {
  const empty = { kind: "agentType", memberId: "", profileId: "" };
  const [draft, setDraft] = useState(empty);
  const ready = Boolean(draft.profileId) && (draft.kind === "agentType" || draft.memberId.trim().length > 0);
  const submit = async (event) => {
    event.preventDefault();
    const target = draft.kind === "agentType" ? { agentType: "household-member" } : { memberId: draft.memberId.trim() };
    const ok = await onAssign(target, draft.profileId);
    if (ok) setDraft(empty);
  };
  return (
    <Paper elevation={0} sx={surface}>
      <SectionHeader title="Assign a profile" />
      <Box component="form" onSubmit={submit}>
        <Stack direction={{ xs: "column", sm: "row" }} spacing={1.5} sx={{ alignItems: { sm: "center" } }}>
          <Select size="small" value={draft.kind} sx={{ minWidth: 170 }}
            onChange={(event) => setDraft((value) => ({ ...value, kind: event.target.value }))}
            aria-label="Assignment target class">
            <MenuItem value="agentType">The household-member agent type</MenuItem>
            <MenuItem value="memberId">One member (by DID)</MenuItem>
          </Select>
          {draft.kind === "memberId" && (
            <TextField size="small" label="Member DID" placeholder="did:porchlight:…" value={draft.memberId}
              onChange={(event) => setDraft((value) => ({ ...value, memberId: event.target.value }))} />
          )}
          <Select size="small" value={draft.profileId} sx={{ minWidth: 220 }} displayEmpty
            onChange={(event) => setDraft((value) => ({ ...value, profileId: event.target.value }))}
            aria-label="Profile to assign">
            <MenuItem value="" disabled><Typography variant="body2">Profile to assign</Typography></MenuItem>
            {(profiles ?? []).map((profile) => (
              <MenuItem key={profile._id} value={profile._id}>
                {profile.name} · {profile.modelId}
                {!profile.memberSelectable ? " (withheld from members)" : ""}
              </MenuItem>
            ))}
          </Select>
          <Button type="submit" variant="contained" disabled={busy || !ready}>Assign</Button>
        </Stack>
        <Typography variant="body2" sx={{ color: "text.secondary", mt: 1 }}>
          A member-specific assignment wins over the type default. Withheld profiles still run here — the admin's own assignment power is never gated on member availability.
        </Typography>
        {error && <Alert severity="warning" sx={{ mt: 1.5 }}>{error}</Alert>}
      </Box>
    </Paper>
  );
}

/** The whole Agent tab: the member card first (every signed-in member),
 * then the admin surfaces — whose reads refuse non-admins hub-side, with the
 * plain-language refusal rendered inline. */
export function Agent({ actions }) {
  const [model, setModel] = useState(null);
  const [profiles, setProfiles] = useState(null);
  const [adminProfiles, setAdminProfiles] = useState(null);
  const [adminError, setAdminError] = useState("");
  const [assignments, setAssignments] = useState(null);
  const [typeState, setTypeState] = useState(null);
  const [assignmentsError, setAssignmentsError] = useState("");
  const [memberError, setMemberError] = useState("");
  const [chooseBusy, setChooseBusy] = useState(false);
  const [chooseError, setChooseError] = useState("");
  const [createOpen, setCreateOpen] = useState(false);
  const [createError, setCreateError] = useState("");
  const [adminBusy, setAdminBusy] = useState(false);
  const [assignError, setAssignError] = useState("");

  const reloadMember = async () => {
    setMemberError("");
    try {
      setModel(await actions.loadMyModel());
    } catch (failure) {
      setModel(null);
      setMemberError(messageOf(failure));
    }
  };

  useEffect(() => {
    let stale = false;
    void (async () => {
      setMemberError("");
      try {
        const [mine, selectable] = await Promise.all([actions.loadMyModel(), actions.loadSelectableProfiles()]);
        if (stale) return;
        setModel(mine);
        setProfiles(Array.isArray(selectable?.profiles) ? selectable.profiles : []);
      } catch (failure) {
        if (!stale) {
          setMemberError(messageOf(failure));
          setProfiles(null);
        }
      }
      setAdminError("");
      try {
        const listed = await actions.loadAdminProfiles();
        if (stale) return;
        setAdminProfiles(Array.isArray(listed?.profiles) ? listed.profiles : []);
      } catch (failure) {
        if (!stale) {
          setAdminProfiles(null);
          setAdminError(messageOf(failure));
        }
      }
      setAssignmentsError("");
      try {
        const [all, typed] = await Promise.all([actions.loadAssignments(), actions.loadAssignments({ agentType: "household-member" })]);
        if (stale) return;
        setAssignments(Array.isArray(all?.rows) ? all.rows : []);
        setTypeState(typed ?? null);
      } catch (failure) {
        if (!stale) {
          setAssignments(null);
          setTypeState(null);
          setAssignmentsError(messageOf(failure));
        }
      }
    })();
    return () => { stale = true; };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps — one mount pass

  const choose = async (profileId) => {
    setChooseBusy(true);
    setChooseError("");
    try {
      await actions.chooseModel(profileId);
      await reloadMember();
      return true;
    } catch (failure) {
      setChooseError(messageOf(failure));
      return false;
    } finally {
      setChooseBusy(false);
    }
  };

  const reloadAdmin = async () => {
    setAdminBusy(true);
    try {
      const listed = await actions.loadAdminProfiles();
      setAdminProfiles(Array.isArray(listed?.profiles) ? listed.profiles : []);
      const [all, typed] = await Promise.all([actions.loadAssignments(), actions.loadAssignments({ agentType: "household-member" })]);
      setAssignments(Array.isArray(all?.rows) ? all.rows : []);
      setTypeState(typed ?? null);
    } catch (failure) {
      setAdminError(messageOf(failure));
    } finally {
      setAdminBusy(false);
    }
  };

  const define = async (draft) => {
    setCreateError("");
    setAdminBusy(true);
    try {
      await actions.defineProfile(draft);
      await reloadAdmin();
      return true;
    } catch (failure) {
      setCreateError(messageOf(failure));
      return false;
    } finally {
      setAdminBusy(false);
    }
  };

  const flipAvailability = async (profile, memberSelectable) => {
    setAdminBusy(true);
    try {
      await actions.setProfileAvailability(profile._id, memberSelectable);
      await reloadAdmin();
    } catch (failure) {
      setAdminError(messageOf(failure));
    } finally {
      setAdminBusy(false);
    }
  };

  const assign = async (target, profileId) => {
    setAssignError("");
    setAdminBusy(true);
    try {
      await actions.assignProfile(assignmentPayload(target, profileId).target, profileId);
      await reloadAdmin();
      return true;
    } catch (failure) {
      setAssignError(messageOf(failure));
      return false;
    } finally {
      setAdminBusy(false);
    }
  };

  const revoke = async (row) => {
    setAdminBusy(true);
    try {
      await actions.revokeAssignment(row._id);
      await reloadAdmin();
    } catch (failure) {
      setAdminError(messageOf(failure));
    } finally {
      setAdminBusy(false);
    }
  };

  return (
    <Box sx={{ pb: 4 }}>
      <Typography variant="body2" sx={{ color: "text.secondary", mb: 1.5 }}>
        Model profiles decide where your household's agents think. The hub admin defines them and keeps them available or withheld; parents narrow what their members' agents may use, inside the family organizer.
      </Typography>
      <MyAgentCard
        model={model}
        profiles={profiles ?? []}
        busy={chooseBusy}
        error={memberError}
        chooseError={chooseError}
        onChoose={choose}
        onRefresh={reloadMember}
      />
      <ProfilesAdmin
        profiles={adminProfiles ?? []}
        error={adminError}
        busy={adminBusy}
        onAvailability={flipAvailability}
        onOpenCreate={() => { setCreateError(""); setCreateOpen(true); }}
      />
      <TypeAssignmentState typeState={typeState} error={assignmentsError} />
      <AssignForm profiles={adminProfiles ?? []} busy={adminBusy} error={assignError} onAssign={assign} />
      <Paper elevation={0} sx={surface}>
        <SectionHeader title="Current assignments" />
        {!assignmentsError && Array.isArray(assignments) && assignments.length === 0 && (
          <EmptyLine>Nothing assigned yet — the household-member agent type above names the unassigned state.</EmptyLine>
        )}
        {(assignments ?? []).map((row) => (
          <AssignmentRow key={row._id} row={row} busy={adminBusy} onRevoke={revoke} />
        ))}
      </Paper>
      <CreateProfileDialog
        open={createOpen}
        busy={adminBusy}
        error={createError}
        onClose={() => setCreateOpen(false)}
        onSubmit={define}
      />
    </Box>
  );
}

export default Agent;
