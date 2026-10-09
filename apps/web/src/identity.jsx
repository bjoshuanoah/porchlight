import React, { useEffect, useState } from 'react';
import {
  Alert, Box, Button, Card, CardContent, Collapse, Dialog, DialogActions,
  DialogContent, DialogTitle, Divider, List, ListItem, ListItemText,
  Paper, Stack, TextField, Typography,
} from '@mui/material';
import { hubOrigin, parseDeviceGrant, parseJoinCode, splitJoinLink, verifyFailure } from './frontdoor.js';

const section = { mb: 3 };
const rows = { display: 'flex', flexWrap: 'wrap', gap: 1, alignItems: 'center' };
const pinPrefix = 'porchlight:local-pin:';

// Error codes, not server wording, determine member-facing copy.
function memberError(cause) {
  if (cause instanceof TypeError) return 'The family server could not be reached. Check its address and try again.';
  if (cause?.code === 'E_INVITE_NOT_FOUND') return 'That invitation code was not found. Check it and try again.';
  if (cause?.code === 'E_INVITE_REVOKED') return 'That invitation was withdrawn. Ask your family owner for a new link.';
  if (cause?.code === 'E_INVITE_EXHAUSTED') return 'That invitation was already used. Ask your family owner for another.';
  if (cause?.code === 'E_ADMISSION_UNAVAILABLE') return 'The invitation is valid, but this hub cannot connect a new member yet. Ask your family owner for help.';
  if (cause?.code === 'E_PAIRING_CODE_CONSUMED' || cause?.code === 'E_DEVICE_LINK_CONSUMED') return 'This code or link was already used. Ask for a new one.';
  if (cause?.code === 'E_PAIRING_CODE_EXPIRED' || cause?.code === 'E_DEVICE_LINK_EXPIRED') return 'This code or link has expired. Ask for a new one.';
  if (cause?.code === 'E_PAIRING_CODE_UNKNOWN' || cause?.code === 'E_DEVICE_LINK_UNKNOWN') return 'This code or link was not found. Check it and try again.';
  if (cause?.code === 'E_DEVICE_LINK_REVOKED') return 'This link was withdrawn. Ask your family owner for a new one.';
  if (cause?.code === 'E_SESSION_REQUIRED' || cause?.code === 'E_NO_REGISTRATION') return 'Open this identity on a connected device before continuing.';
  return 'The hub could not complete this action. Check with your family owner if it continues.';
}

function useOperation(actions) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  async function run(action, args = [], success) {
    setError('');
    setNotice('');
    if (typeof actions?.[action] !== 'function') {
      setError('This action is not available from this hub. No change was made.');
      return false;
    }
    setBusy(true);
    try {
      const result = await actions[action](...args);
      if (result === false) throw new Error('The hub could not complete this action.');
      if (success) setNotice(success);
      return result ?? true;
    } catch (cause) {
      setError(memberError(cause));
      return false;
    } finally {
      setBusy(false);
    }
  }
  return { busy, error, notice, run, setError, setNotice };
}

function Feedback({ operation }) {
  return <Stack spacing={1} sx={{ my: 2 }} aria-live="polite">
    {operation.error && <Alert severity="error">{operation.error}</Alert>}
    {operation.notice && <Alert severity="success">{operation.notice}</Alert>}
  </Stack>;
}

function Heading({ title, subtitle }) {
  return <Box sx={section}>
    <Typography variant="h4" component="h1" gutterBottom>{title}</Typography>
    {subtitle && <Typography color="text.secondary">{subtitle}</Typography>}
  </Box>;
}

function named(item) { return item?.name || item?.label || item?.displayName || 'Member'; }
function idOf(item) { return item?._id || item?.id || ''; }
function displayDate(value) {
  if (!value) return '';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '' : date.toLocaleString();
}
function available(data, field) { return data?.availability?.[field] !== false; }
function networkName(data) {
  return data?.settings?.network?.name || data?.connections?.find(item => item.identity?.id === data?.identity?.id)?.name || data?.network?.name || 'this network';
}

// Each browser registration has its own identity and device ID. A PIN is only a
// local screen barrier; it never leaves this browser or substitutes for hub access.
function localRegistration(data, identity) {
  return identity?.id && (data?.connections || []).find(connection => connection?.identity?.id === identity.id && connection.deviceId);
}
function pinStorageId(connection) {
  return `${pinPrefix}${new URL(connection.url).origin}:${connection.identity.id}:${connection.deviceId}`;
}
function storedPin(connection) {
  if (!connection) return null;
  try { return JSON.parse(localStorage.getItem(pinStorageId(connection)) || 'null'); }
  catch { return null; }
}
export function hasLocalPin(connection) { return Boolean(storedPin(connection)); }
async function pinDigest(pin, salt) {
  const bytes = new TextEncoder();
  const material = await crypto.subtle.importKey('raw', bytes.encode(pin), 'PBKDF2', false, ['deriveBits']);
  const digest = await crypto.subtle.deriveBits({ name: 'PBKDF2', salt: Uint8Array.from(salt), iterations: 120000, hash: 'SHA-256' }, material, 256);
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
}
function PinField({ label, value, onChange }) {
  return <TextField label={label} value={value} onChange={event => onChange(event.target.value.replace(/\D/g, '').slice(0, 6))}
    required type="text" inputProps={{ inputMode: 'numeric', minLength: 4, maxLength: 6 }} autoComplete="off" />;
}

// Front-door failure copy: the state name maps to a plain-language line the
// member can act on. Server-provided messages win when the hub sent one.
function verifyCopy(state, cause, hub) {
  if (cause?.body?.message && state === 'invalid') return cause.body.message;
  const lines = {
    invalid: 'That invitation code was not found. Check the hub address and the code, then try again.',
    revoked: 'That invitation was withdrawn. Ask your family owner for a new link.',
    used: 'That invitation was already used. Ask your family owner for a new one.',
    unreachable: `We couldn't reach ${hub || 'the family hub'}. Check the server URL, or try again once it is up.`,
    wrongUrl: 'That address is not a Porchlight hub. Check the server URL your family sent you.',
  };
  return lines[state] ?? 'Connect ran into trouble. Check the hub address and code, then try again.';
}

// The member's front door: exactly two fields, one connect action, then the
// visible verification steps. The hub checks in plain sight: invitation,
// device, membership. No signup form, no vendor surface anywhere.
export function Join({ data, actions, navigate }) {
  const [url, setUrl] = useState(data?.connections?.[0]?.url || window.location.origin);
  const [code, setCode] = useState(() => parseJoinCode(window.location.pathname));
  const [stage, setStage] = useState('fields'); // fields | confirm | naming | busy | done
  const [network, setNetwork] = useState(null);
  const [name, setName] = useState('');
  const [chosen, setChosen] = useState(null);
  const operation = useOperation(actions);

  const local = (data?.connections || []).filter((item) => {
    try { return new URL(item.url).origin === hubOrigin(url) && item.deviceId; }
    catch { return false; }
  });
  const target = (() => {
    try { return hubOrigin(url); } catch { return ''; }
  })();
  const failure = (state, cause) => {
    setStage('fields');
    operation.setError(verifyCopy(state, cause, target));
  };
  async function connect(event) {
    event.preventDefault();
    operation.setError(''); operation.setNotice('');
    if (!code.trim()) {
      // A full join link pasted into the URL field fills both fields.
      const split = splitJoinLink(url);
      if (split) { setUrl(split.url); setCode(split.code); }
    }
    let origin;
    try { origin = hubOrigin(url); }
    catch { failure('wrongUrl', null); return; }
    setStage('busy');
    try {
      const result = await actions.verifyJoin({ url: origin, code: code.trim() });
      setNetwork(result.network || null);
      setStage('confirm');
    } catch (cause) {
      failure(verifyFailure(cause), cause);
    }
  }
  async function proceed(existing) {
    const origin = target;
    const codeValue = code.trim();
    setStage('busy');
    operation.setError(''); operation.setNotice('');
    try {
      if (existing) {
        await actions.joinDevice({ url: origin, code: codeValue, did: existing.identity.id, deviceId: existing.deviceId, label: existing.name });
      } else {
        if (!name.trim()) { setStage('naming'); operation.setError('Your family needs something to call you. Add a name here.'); return; }
        await actions.joinNew({ url: origin, code: codeValue, displayName: name.trim() });
      }
      setStage('done');
    } catch (cause) {
      failure(verifyFailure(cause), cause);
    }
  }
  return <Box sx={{ maxWidth: 540, mx: 'auto' }}>
    <Heading title={stage === 'done' ? "You're home." : 'Join your family'}
      subtitle={stage === 'done' ? `Your place on ${network?.name || 'your family network'} is ready.` :
        `The network address and the invitation ${network ? '' : 'code'}${network ? ' were checked' : ''} — connect to your family's Porchlight.`} />
    {stage === 'done' ? <Paper sx={{ p: 3 }}><Stack spacing={2}>
      <Typography>Your family can see you now. Nothing to import, nothing to set up twice.</Typography>
      <Button variant="contained" onClick={() => navigate?.('/timeline')}>Open Timeline</Button>
    </Stack></Paper>
      : stage === 'confirm' || stage === 'naming' || stage === 'busy' ? <Paper sx={{ p: 3 }}><Stack spacing={2}>
        <Alert severity="success" icon={false}>
          {stage === 'busy' ? 'Checking this hub…' : `You're joining ${network?.name || 'your family'}. Connect once and this device stays yours.`}
        </Alert>
        {stage === 'naming' && <>
          <TextField label="What should your family call you?" value={name} onChange={(event) => setName(event.target.value)} autoFocus fullWidth />
          <Button variant="contained" fullWidth disabled={operation.busy} onClick={() => proceed(null)}>Join Porchlight</Button>
          {local.length > 0 && <Typography variant="body2" color="text.secondary">Someone is already connected on this device — pick them instead:</Typography>}
        </>}
        {stage !== 'naming' && local.map((item) => (
          <Button key={`${item.url}:${item.identity?.id}`} variant={chosen?.identity?.id === item.identity?.id ? 'contained' : 'outlined'}
            disabled={operation.busy} onClick={() => setChosen(item)}>
            Continue as {item.identity?.name || 'a family member'}
          </Button>
        ))}
        {stage === 'confirm' && <Button variant="contained" fullWidth disabled={operation.busy} onClick={() => proceed(chosen || local[0])}>
          {local.length ? 'Connect' : 'Next'}
        </Button>}
        <Feedback operation={operation} />
      </Stack></Paper>
        : <Paper sx={{ p: { xs: 2, sm: 3 } }}><form onSubmit={connect}><Stack spacing={2}>
          <TextField label="Server URL" type="url" value={url} onChange={(event) => setUrl(event.target.value)} required fullWidth
            helperText="The address where your family's Porchlight runs." autoComplete="url" />
          <TextField label="Invite code" value={code} onChange={(event) => setCode(event.target.value)} required fullWidth
            helperText="The code in the link your family's owner sent you." autoComplete="off" />
          <Feedback operation={operation} />
          <Button type="submit" variant="contained" disabled={operation.busy}>Connect</Button>
        </Stack></form></Paper>}
    {stage !== 'done' && <Stack direction="row" spacing={1} sx={{ mt: 2, flexWrap: 'wrap' }}>
      <Button onClick={() => navigate?.('/pair')}>Connect with a code from another device</Button>
      <Button onClick={() => navigate?.('/device-link')}>Use a device link</Button>
    </Stack>}
  </Box>;
}

const setupSteps = ["account", "network", "invite", "quota"];

function StepCircle({ number, state }) {
  const sx = state === 'complete'
    ? { bgcolor: "primary.main", color: "#fff" }
    : state === 'current' ? { bgcolor: "secondary.main", color: "#fff" } : { bgcolor: "grey.300", color: "text.secondary" };
  return <Box sx={{ width: 24, height: 24, borderRadius: "50%", display: "grid", placeItems: "center", fontSize: 13, flexShrink: 0, ...sx }}>
    {state === 'complete' ? "✓" : number}
  </Box>;
}

function downscalePhoto(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error);
    reader.onload = () => {
      const image = new Image();
      image.onerror = () => reject(new Error("This photo could not be opened."));
      image.onload = () => {
        const scale = Math.min(1, 256 / Math.max(image.width, image.height));
        const canvas = document.createElement("canvas");
        canvas.width = Math.max(1, Math.round(image.width * scale));
        canvas.height = Math.max(1, Math.round(image.height * scale));
        canvas.getContext("2d").drawImage(image, 0, 0, canvas.width, canvas.height);
        resolve(canvas.toDataURL("image/jpeg", 0.85));
      };
      image.src = String(reader.result);
    };
    reader.readAsDataURL(file);
  });
}

/**
 * Owner bootstrap (PORCH-010): create the first account or adopt an identity
 * from an existing hub — the choice appears once, plainly, and is never
 * forced; then hub setup over the tunnel: network, join links, quotas.
 * Every step rides the hub's public setup ledger, so a closed browser
 * resumes exactly where setup paused — never a silent half-configured hub.
 */
export function Setup({ data, actions, navigate }) {
  const operation = useOperation(actions);
  const [steps, setSteps] = useState(null);
  const [account, setAccount] = useState(null);
  const [stage, setStage] = useState('choice');
  const [name, setName] = useState('');
  const [photo, setPhoto] = useState('');
  const [adoptUrl, setAdoptUrl] = useState('');
  const [adoptId, setAdoptId] = useState('');
  const [networkName, setNetworkName] = useState('');
  const [ownerLink, setOwnerLink] = useState('');
  const [familyLinks, setFamilyLinks] = useState([]);
  const [quota, setQuota] = useState({ storageCeilingMb: '', retentionDays: '' });
  const [joinedOwnNetwork, setJoinedOwnNetwork] = useState(Boolean(data?.connections?.some((item) => item.identity?.id && item.token)));
  const adoptedNote = account?.account?.kind === "adopted";

  async function refreshStates() {
    const [hubState, hubAccount] = await Promise.all([actions.setupState(), actions.accountState()]);
    setSteps(hubState?.steps || {});
    setAccount(hubAccount);
    return hubState;
  }
  const stageOf = (hubState) => {
    const done = (step) => hubState?.steps?.[step]?.status === "complete";
    if (done("quota")) return "done";
    if (done("invite")) return "invites";
    if (done("network")) return "invites";
    if (done("account")) return "network";
    return "choice";
  };
  useEffect(() => {
    void (async () => {
      try {
        const hubState = await actions.setupState();
        setSteps(hubState?.steps || {});
        setAccount(await actions.accountState());
        setStage(stageOf(hubState));
        if (hubState?.lastError) operation.setError(`Setup paused here earlier: ${hubState.lastError}. Continue below — nothing was lost.`);
      } catch {
        setSteps({}); setStage("choice");
        operation.setError("The hub could not be reached just now. It may still be starting — try again in a moment.");
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function createAccount(event) {
    event.preventDefault();
    if (!name.trim()) { operation.setError("Add a name before continuing."); return; }
    const result = await operation.run("createOwnerAccount", [{ displayName: name.trim(), avatar: photo || undefined }]);
    if (!result) return;
    await refreshStates();
    setStage("network");
  }
  async function adoptAccount(event) {
    event.preventDefault();
    if (!adoptUrl.trim() || !adoptId.trim()) { operation.setError("Add the other hub's address and your member id there."); return; }
    const result = await operation.run("adoptOwnerIdentity", [{ sourceHubUrl: adoptUrl.trim(), memberId: adoptId.trim() }]);
    if (!result) return;
    await refreshStates();
    setStage("network");
  }
  async function createNetwork(event) {
    event.preventDefault();
    if (!networkName.trim()) { operation.setError("Name your network before continuing."); return; }
    const ownerDid = data?.identity?.id || account?.account?.did;
    const result = await operation.run("startNetwork", [{ name: networkName.trim(), ownerDid }]);
    if (!result) return;
    await refreshStates();
    setStage("invites");
  }
  async function makeOwnerInvite() {
    const result = await operation.run("issueBootstrapInvite");
    if (!result?.invite) return;
    const link = invitationUrl(result.invite, data) || result.joinUrl || "";
    const code = link.split("/join/")[1] || result.invite.token;
    if (data?.identity?.id && (data?.connections || []).some((item) => item.identity?.id === data.identity.id && item.deviceId)) {
      const ownerConnection = data.connections.find((item) => item.identity?.id === data.identity.id);
      const admitted = await operation.run("joinDevice", [{ url: ownerConnection.url, code, did: data.identity.id, deviceId: ownerConnection.deviceId, name: data.identity.name }]);
      if (!admitted) { setOwnerLink(link); return; }
      setJoinedOwnNetwork(true);
    } else setOwnerLink(link);
    await refreshStates();
  }
  async function inviteFamily() {
    const result = await operation.run("issueInvite");
    if (!result) return;
    const link = invitationUrl(result.invite, data);
    if (!link) { operation.setError("The hub returned no shareable invitation."); return; }
    setFamilyLinks((rows) => [...rows, link]);
    await refreshStates();
  }
  async function saveQuota(event) {
    event.preventDefault();
    const payload = {
      storageCeilingMb: quota.storageCeilingMb === "" ? null : Number(quota.storageCeilingMb),
      retentionDays: quota.retentionDays === "" ? null : Number(quota.retentionDays),
    };
    if (payload.storageCeilingMb !== null && (!Number.isFinite(payload.storageCeilingMb) || payload.storageCeilingMb <= 0)) {
      operation.setError("Storage ceiling is a number of megabytes, or empty for none."); return;
    }
    if (await operation.run("setBootstrapQuotas", [payload], "Hub space settings saved.")) {
      setStage("done");
    }
  }

  const stepState = (step) => steps?.[step]?.status === "complete" ? "complete"
    : (stage === 'choice' && step === "account") || (stage === "network" && step === "network") || (stage === "invites" && step === "invite") || (stage === "quotas" && step === "quota") ? "current" : "future";
  return <Box sx={{ maxWidth: 720, mx: 'auto' }}>
    <Heading title="Set up your porch" subtitle="Your family's Porchlight lives on this hub. Finish the short setup once — every step is saved as you go, and you can come back to it." />
    <Card sx={section}><CardContent>
      <Box sx={{ display: "flex", gap: 2, mb: 3, flexWrap: "wrap" }}>
        {setupSteps.map((step, index) => <Box key={step} sx={{ display: "flex", alignItems: "center", gap: 1 }}>
          <StepCircle number={index + 1} state={stepState(step)} />
          <Typography variant="body2">{step === "account" ? "First account" : step === "network" ? "The family network" : step === "invite" ? "Join links" : "Space limits"}</Typography>
        </Box>)}
      </Box>
      <Feedback operation={operation} />
      {stage === "choice" && <>
        <Typography gutterBottom>Do you already keep a Porchlight hub elsewhere?</Typography>
        <Stack spacing={1} sx={{ mb: 3 }}>
          <Button variant="outlined" onClick={() => setStage("create")}>No — create the first account here</Button>
          <Button variant="text" onClick={() => setStage("adopt")}>Yes — adopt the identity from my other hub</Button>
        </Stack>
        {account?.exists && <Typography variant="body2" color="text.secondary">An account exists on this hub already. Continuing below keeps it untouched.</Typography>}
      </>}
      {stage === "create" && <Box component="form" onSubmit={createAccount}><Stack spacing={2}>
        <Typography color="text.secondary">Only a name and, if you like, a photo. Nothing else is asked and nothing leaves this hub.</Typography>
        <TextField label="What should your family call you?" value={name} onChange={(event) => setName(event.target.value)} required autoFocus fullWidth />
        <Button variant="text" component="label" sx={{ alignSelf: "flex-start" }}>{photo ? "Photo chosen — change it" : "Add a photo (optional)"}
          <input type="file" accept="image/*" hidden onChange={(event) => {
            const file = event.target.files?.[0];
            if (!file) return;
            downscalePhoto(file).then((dataUrl) => { setPhoto(dataUrl); operation.setError(""); }).catch(() => operation.setError("This photo could not be read. Try another one."));
          }} />
        </Button>
        <Button type="submit" variant="contained" disabled={operation.busy}>Create account</Button>
      </Stack></Box>}
      {stage === "adopt" && <Box component="form" onSubmit={adoptAccount}><Stack spacing={2}>
        <Typography color="text.secondary">Your identity stays home on your other hub — this hub only points at it. Both hubs run your family networks side by side.</Typography>
        <TextField label="Your other hub's address" value={adoptUrl} onChange={(event) => setAdoptUrl(event.target.value)} placeholder="https://porchlight.home" required fullWidth autoComplete="url" />
        <TextField label="Your member id on that hub" value={adoptId} onChange={(event) => setAdoptId(event.target.value)} required fullWidth autoComplete="off"
          helperText="Shown on your profile screen there." />
        <Button type="submit" variant="contained" disabled={operation.busy}>Adopt this identity</Button>
      </Stack></Box>}
      {stage === "network" && <Box component="form" onSubmit={createNetwork}><Stack spacing={2}>
        <Typography color="text.secondary">{adoptedNote ? "Adoption saved. Now name the family network this hub will host." : "Name the family network this hub will host."}</Typography>
        <TextField label="Network name" value={networkName} onChange={(event) => setNetworkName(event.target.value)} required autoFocus fullWidth placeholder="The Noah Family" />
        <Button type="submit" variant="contained" disabled={operation.busy}>Create network</Button>
      </Stack></Box>}
      {stage === "invites" && <Stack spacing={2}>
        {!joinedOwnNetwork && <>
          <Typography color="text.secondary">First, this hub connects you — the owner — to your own network. It makes the first join link for you.</Typography>
          <Button variant="contained" disabled={operation.busy} onClick={() => void makeOwnerInvite()}>Make the first join link</Button>
          {ownerLink && <Alert severity="info">Use this link on the device where you created your account: {ownerLink}</Alert>}
        </>}
        {joinedOwnNetwork && <>
          <Typography color="text.secondary">Now one join link for each family member. Anyone with the link becomes a member; you can withdraw any link the moment you want.</Typography>
          <Button variant="contained" disabled={operation.busy} onClick={() => void inviteFamily()}>Make a family join link</Button>
          {familyLinks.length > 0 && <List dense>{familyLinks.map((link, index) => <ListItem key={link} divider><ListItemText primary={link} secondary={`Link ${index + 1} — share it with your family`} /></ListItem>)}</List>}
          <Button variant="text" onClick={() => setStage("quotas")}>Continue to space limits</Button>
        </>}
        {!joinedOwnNetwork && <Typography variant="body2" color="text.secondary">If your account was created on another device of yours, open this link there — or pair this device from that one — and come back to finish.</Typography>}
      </Stack>}
      {stage === "quotas" && <Box component="form" onSubmit={saveQuota}><Stack spacing={2}>
        <Typography color="text.secondary">Quantity-only guardrails for your hub: how much space the family may use and how long moments stay. Empty means no limit for now.</Typography>
        <Stack direction={{ xs: "column", sm: "row" }} spacing={2}>
          <TextField label="Storage ceiling (MB)" type="number" inputProps={{ min: 1, step: 1 }} value={quota.storageCeilingMb} onChange={(event) => setQuota((value) => ({ ...value, storageCeilingMb: event.target.value }))} fullWidth />
          <TextField label="Moments kept for (days)" type="number" inputProps={{ min: 1, step: 1 }} value={quota.retentionDays} onChange={(event) => setQuota((value) => ({ ...value, retentionDays: event.target.value }))} fullWidth />
        </Stack>
        <Stack direction="row" spacing={2}>
          <Button type="submit" variant="contained" disabled={operation.busy}>Save and finish</Button>
          <Button onClick={() => setStage("done")} disabled={operation.busy}>Skip for now</Button>
        </Stack>
      </Stack></Box>}
      {stage === "done" && <Stack spacing={2}>
        <Typography>Your porch is ready and welcome.</Typography>
        <Button variant="contained" onClick={() => navigate?.("/timeline")}>Open the Timeline</Button>
        <Button variant="text" onClick={() => navigate?.('/owner')}>Open the owner console</Button>
      </Stack>}
    </CardContent></Card>
  </Box>;
}

export function Pair({ data, actions, navigate }) {
  const [code, setCode] = useState('');
  const operation = useOperation(actions);
  async function submit(event) {
    event.preventDefault();
    const result = await operation.run('pair', [code.trim()], 'This device is now yours.');
    if (result) navigate?.('/timeline');
  }
  return <Box sx={{ maxWidth: 540, mx: 'auto' }}>
    <Heading title="Add this device" subtitle={`You're already part of ${networkName(data)}. Enter the code shown on your other device once, and this device joins your place.`} />
    <Paper sx={{ p: 3 }}><form onSubmit={submit}><Stack spacing={2}>
      <TextField label="Pairing code" value={code} onChange={event => setCode(event.target.value)} required autoComplete="off" fullWidth />
      <Typography variant="body2" color="text.secondary">The code works once and for ten minutes. If anything unexpected connects, your other device shows it right away so it can be removed in one tap.</Typography>
      <Feedback operation={operation} />
      <Button variant="contained" type="submit" disabled={operation.busy}>Connect this device</Button>
      <Button onClick={() => navigate?.('/device-link')}>Use a device link instead</Button>
    </Stack></form></Paper>
  </Box>;
}

export function DeviceLink({ data, actions, navigate }) {
  const [grant, setGrant] = useState(() => parseDeviceGrant(window.location.pathname));
  const operation = useOperation(actions);
  const network = networkName(data);
  async function submit(event) {
    event.preventDefault();
    const result = await operation.run('linkDevice', [grant.trim()], 'This device is now yours.');
    if (result) navigate?.('/timeline');
  }
  return <Box sx={{ maxWidth: 540, mx: 'auto' }}>
    <Heading title="Welcome back" subtitle={`Welcome back. This link adds this device to your place in ${network}. Your moments, groups, and profile arrive untouched — nothing to bring over.`} />
    <Paper sx={{ p: 3 }}><form onSubmit={submit}><Stack spacing={2}>
      {grant && <Alert severity="info" icon={false}>Your family owner sent this link. It works once, for the person it was made for.</Alert>}
      <TextField label="Device link" value={grant} onChange={event => setGrant(event.target.value)} required autoComplete="off" fullWidth
        helperText="The long code inside the link your family owner sent." />
      <Typography variant="body2" color="text.secondary">Connect once and this device stays yours. If the link stops working, ask your family owner for a fresh one.</Typography>
      <Feedback operation={operation} />
      <Button type="submit" variant="contained" disabled={operation.busy}>Add this device</Button>
      <Button onClick={() => navigate?.('/pair')}>Use a code from a signed-in device instead</Button>
    </Stack></form></Paper>
  </Box>;
}

function DeviceList({ devices, operation, actions, currentDeviceId }) {
  const [removing, setRemoving] = useState(null);
  return <>
    {devices === null ? <Typography color="text.secondary">Device status is not available from this hub.</Typography>
      : devices.length === 0 ? <Typography color="text.secondary">No registered devices to show.</Typography>
        : <List disablePadding>{devices.map(device => {
          const id = idOf(device);
          const revoked = device.status === 'revoked';
          return <ListItem key={id} divider disableGutters sx={{ gap: 1, flexWrap: 'wrap' }}>
            <ListItemText primary={named(device)} secondary={[
              device.deviceId === currentDeviceId && 'This device', revoked ? 'Revoked' : device.status === 'active' ? 'Active' : 'Status unavailable',
              device.createdBy && `Connected by ${device.createdBy}`, device.createdAt && `Connected ${displayDate(device.createdAt)}`,
              device.revokedAt && `Removed ${displayDate(device.revokedAt)}`,
            ].filter(Boolean).join(' · ')} />
            {!revoked && typeof actions?.removeDevice === 'function' && <Button size="small" color="error" disabled={!id || operation.busy} onClick={() => setRemoving(device)}>Remove</Button>}
          </ListItem>;
        })}</List>}
    <Dialog open={Boolean(removing)} onClose={() => setRemoving(null)} fullWidth maxWidth="xs">
      <DialogTitle>Remove this device?</DialogTitle>
      <DialogContent><Typography>{named(removing)} will no longer be connected. Its existing posts and identity stay in place.</Typography>{removing?.deviceId === currentDeviceId && <Typography sx={{ display: 'block', mt: 1 }}>You are using this device right now. Removing it means a fresh device link or pairing code is needed before Porchlight opens here again.</Typography>}</DialogContent>
      <DialogActions><Button onClick={() => setRemoving(null)}>Keep device</Button><Button color="error" disabled={operation.busy} onClick={async () => {
        if (await operation.run('removeDevice', [idOf(removing)], 'Device removed.')) setRemoving(null);
      }}>Remove device</Button></DialogActions>
    </Dialog>
  </>;
}

export function Profile({ data, actions, navigate }) {
  const operation = useOperation(actions);
  const [pairing, setPairing] = useState(null);
  const [pairOpen, setPairOpen] = useState(false);
  const [membershipOpen, setMembershipOpen] = useState(false);
  const [pinOpen, setPinOpen] = useState(false);
  const [pin, setPin] = useState('');
  const [repeat, setRepeat] = useState('');
  const [, setPinRevision] = useState(0);
  const [hiddenList, setHiddenList] = useState(() => (typeof actions?.hiddenItems === 'function' ? actions.hiddenItems() : []));
  const identity = data?.identity;
  const connection = localRegistration(data, identity);
  const hasPin = hasLocalPin(connection);
  const memberships = identity?.memberships || data?.memberships || [];
  async function makeCode() {
    const result = await operation.run('createPairingCode');
    if (!result) return;
    if (!result.code) { operation.setError('The hub returned no pairing code.'); return; }
    setPairing({ code: result.code, expiresAt: result.expiresAt });
    setPairOpen(false);
  }
  async function savePin(event) {
    event.preventDefault();
    if (!connection) { operation.setError('This identity is not registered on this device.'); return; }
    if (!/^\d{4,6}$/.test(pin)) { operation.setError('Use 4 to 6 digits.'); return; }
    if (pin !== repeat) { operation.setError('The two entries do not match. Try again.'); return; }
    try {
      const salt = Array.from(crypto.getRandomValues(new Uint8Array(16)));
      localStorage.setItem(pinStorageId(connection), JSON.stringify({ salt, digest: await pinDigest(pin, salt) }));
      setPin(''); setRepeat(''); setPinOpen(false); setPinRevision(value => value + 1);
      operation.setError(''); operation.setNotice('Local PIN is on for this identity on this device.');
    } catch { operation.setError('This browser could not save the local PIN. No change was made.'); }
  }
  function removePin() {
    try {
      localStorage.removeItem(pinStorageId(connection));
      setPinRevision(value => value + 1);
      operation.setNotice('Local PIN is off on this device.'); operation.setError('');
    } catch { operation.setError('This browser could not remove the local PIN.'); }
  }
  return <Box sx={{ maxWidth: 800, mx: 'auto' }}>
    <Heading title="Profile" subtitle={`Your place on ${networkName(data)} and the devices you use.`} />
    <Card sx={section}><CardContent><Typography variant="h5">{named(identity)}</Typography>
      <Typography color="text.secondary">{data?.server?.url || networkName(data)}</Typography>
      <Box sx={{ ...rows, mt: 2 }}><Button onClick={() => navigate?.('/who-is-here')}>Who is here?</Button><Button onClick={() => setMembershipOpen(value => !value)} aria-expanded={membershipOpen}>Memberships</Button>{typeof actions?.signOut === 'function' && <Button variant="text" disabled={operation.busy} onClick={() => actions.signOut()}>Sign out</Button>}</Box>
      <Typography variant="body2" color="text.secondary" sx={{ mt: 1 }}>Signing out ends this device's open turn. The device stays connected and opens straight into your timeline on your next visit.</Typography>
      <Collapse in={membershipOpen}><Divider sx={{ my: 2 }} /><Typography variant="h6">Your memberships</Typography>
        {memberships.length ? <List dense>{memberships.map((entry, index) => <ListItem key={idOf(entry) || index}><ListItemText primary={named(entry)} secondary={entry.role || entry.server} /></ListItem>)}</List> : <Typography color="text.secondary">No additional memberships are available here.</Typography>}
      </Collapse>
    </CardContent></Card>
    <Card sx={section}><CardContent><Typography variant="h6" gutterBottom>Devices</Typography>
      <DeviceList devices={available(data, 'devices') ? data?.devices || [] : null} operation={operation} actions={actions} currentDeviceId={connection?.deviceId} />
      <Typography variant="body2" color="text.secondary" sx={{ mt: 1 }}>New connections become active when their code is used. This hub does not offer a separate confirmation step on the original device. Check this list and remove unfamiliar devices.</Typography>
      <Box sx={{ ...rows, mt: 2 }}><Button variant="contained" disabled={!connection || operation.busy || typeof actions?.createPairingCode !== 'function'} onClick={() => setPairOpen(true)}>Make pairing code</Button><Button onClick={() => navigate?.('/pair')}>Connect another device</Button></Box>
      {pairing && <Alert severity="info" sx={{ mt: 2 }}><Typography fontWeight="bold">Pairing code: {pairing.code}</Typography><Typography variant="body2">Enter this once on your new device{pairing.expiresAt ? ` before ${displayDate(pairing.expiresAt)}` : ''}.</Typography></Alert>}
    </CardContent></Card>
    <Card sx={section}><CardContent><Typography variant="h6">Local PIN</Typography>
      <Typography color="text.secondary">Optional on this device, for this identity only. It does not change access on the hub. If you do not use one, opening your identity takes one tap.</Typography>
      {connection ? <Box sx={{ ...rows, mt: 2 }}>{hasPin
        ? <><Typography variant="body2">On for this device.</Typography><Button onClick={removePin}>Turn off local PIN</Button><Button onClick={() => setPinOpen(true)}>Change local PIN</Button></>
        : <><Typography variant="body2">Off on this device.</Typography><Button onClick={() => setPinOpen(true)}>Turn on local PIN</Button></>}</Box>
        : <Typography color="text.secondary" sx={{ mt: 2 }}>Open an identity registered on this device before setting a local PIN.</Typography>}
    </CardContent></Card>
    <Card sx={section}><CardContent><Typography variant="h6">Hidden items</Typography>
      <Typography color="text.secondary" sx={{ mt: 1 }}>Posts you hide stay hidden for you on this device, in the timeline and the highlighted section. Showing one here brings it back for you only; your family was never affected.</Typography>
      {hiddenList.length ? <List dense>{hiddenList.map((item) => <ListItem key={item} divider sx={{ gap: 1, flexWrap: 'wrap' }} secondaryAction={typeof actions?.showPost === 'function'
        ? <Button size="small" disabled={operation.busy} onClick={() => { actions.showPost(item); setHiddenList(actions.hiddenItems()); }}>Show again</Button>
        : undefined}><ListItemText primary={item.replace(/^https?:\/\//, '')} secondary="Hidden on this device" /></ListItem>)}</List>
        : <Typography color="text.secondary" sx={{ mt: 1 }}>Nothing is hidden on this device.</Typography>}
    </CardContent></Card>
    <Feedback operation={operation} />
    <Button onClick={() => navigate?.('/who-is-here')}>Choose another person</Button>
    <Dialog open={pairOpen} onClose={() => setPairOpen(false)} fullWidth maxWidth="xs">
      <DialogTitle>Allow another device?</DialogTitle>
      <DialogContent><Typography>Only make a pairing code on this original device if you are connecting another device for {named(identity)} on {networkName(data)}. The code can be used once. The hub connects the new device when it is entered, without a second approval here.</Typography></DialogContent>
      <DialogActions><Button onClick={() => setPairOpen(false)}>Cancel</Button><Button variant="contained" disabled={operation.busy} onClick={makeCode}>Yes, make code</Button></DialogActions>
    </Dialog>
    <Dialog open={pinOpen} onClose={() => { setPinOpen(false); setPin(''); setRepeat(''); }} fullWidth maxWidth="xs">
      <DialogTitle>{hasPin ? 'Change local PIN' : 'Turn on local PIN'}</DialogTitle>
      <Box component="form" onSubmit={savePin}><DialogContent><Stack spacing={2}>
        <Typography>Enter 4 to 6 digits twice. The PIN stays on this device.</Typography>
        <PinField label="Local PIN" value={pin} onChange={setPin} />
        <PinField label="Repeat local PIN" value={repeat} onChange={setRepeat} />
      </Stack></DialogContent><DialogActions><Button onClick={() => { setPinOpen(false); setPin(''); setRepeat(''); }}>Cancel</Button><Button type="submit" variant="contained">Save on this device</Button></DialogActions></Box>
    </Dialog>
  </Box>;
}

export function WhoIsHere({ data, actions, navigate }) {
  const members = (data?.connections || []).filter(connection => connection?.identity?.id && connection.deviceId);
  const [selected, setSelected] = useState(null);
  const [pin, setPin] = useState('');
  const operation = useOperation(actions);
  const connection = members.find(item => item.identity.id === selected);
  const hasPin = Boolean(connection && storedPin(connection));
  async function openIdentity() {
    const result = await operation.run('switchIdentity', [selected]);
    if (result) { setPin(''); navigate?.('/timeline'); }
  }
  async function submitPin(event) {
    event.preventDefault();
    const record = storedPin(connection);
    if (!record || !Array.isArray(record.salt) || !record.digest) { operation.setError('The local PIN is not available for this identity.'); return; }
    try {
      if (await pinDigest(pin, record.salt) !== record.digest) {
        setPin(''); operation.setError('That PIN does not match. Try again, or ask the member to change it from their Profile.'); return;
      }
      await openIdentity();
    } catch { operation.setError('This browser cannot check the local PIN right now.'); }
  }
  return <Box sx={{ maxWidth: 700, mx: 'auto' }}>
    <Heading title="Who is here?" subtitle="Choose an identity already connected on this device. A local PIN is optional; without one, open with one tap." />
    <Paper sx={{ p: 2, mb: 3 }}><List disablePadding>{members.map(item => <ListItem key={`${item.url}:${item.identity.id}:${item.deviceId}`} disableGutters divider sx={{ gap: 1 }}>
      <ListItemText primary={named(item.identity)} secondary={[item.name || item.url, item.identity.id === data?.identity?.id && 'Currently here'].filter(Boolean).join(' · ')} />
      <Button onClick={() => { setSelected(item.identity.id); setPin(''); operation.setError(''); }}>Choose</Button>
    </ListItem>)}</List>{members.length === 0 && <Typography color="text.secondary">No identities are connected on this device yet.</Typography>}</Paper>
    {connection && <Paper sx={{ p: 3 }}><Typography variant="h6" gutterBottom>{named(connection.identity)}</Typography>
      <Feedback operation={operation} />
      {hasPin ? <form onSubmit={submitPin}><Stack spacing={2}>
        <PinField label="Local PIN" value={pin} onChange={setPin} />
        <Button variant="contained" type="submit" disabled={operation.busy}>Continue as {named(connection.identity)}</Button>
      </Stack></form> : <Button variant="contained" disabled={operation.busy} onClick={openIdentity}>Continue as {named(connection.identity)}</Button>}
    </Paper>}
    <Button sx={{ mt: 2 }} onClick={() => navigate?.('/join')}>Join another network</Button>
  </Box>;
}

function invitationUrl(invite, data) {
  if (!invite?.joinUrl) return '';
  try { return new URL(invite.joinUrl, data?.server?.url || window.location.origin).href; }
  catch { return invite.joinUrl; }
}

export function OwnerConsole({ data, actions, navigate }) {
  const operation = useOperation(actions);
  const [issued, setIssued] = useState('');
  const [removing, setRemoving] = useState(null);
  const [linking, setLinking] = useState(null);
  const [issuedDeviceLink, setIssuedDeviceLink] = useState('');
  const [draftLimits, setLimits] = useState(null);
  const members = available(data, 'members') ? data?.members || [] : null;
  const invites = available(data, 'invites') ? data?.invites || [] : null;
  const audit = available(data, 'audit') ? data?.audit || [] : null;
  const disk = available(data, 'disk') ? data?.disk : null;
  const settings = available(data, 'settings') ? data?.settings : null;
  const availability = data?.availability || {};
  const limits = draftLimits || {
    storageCeilingMb: settings?.quota?.storageCeilingMb ?? '',
    retentionDays: settings?.quota?.retentionDays ?? '',
  };
  async function invite() {
    const result = await operation.run('issueInvite');
    if (!result) return;
    const link = invitationUrl(result.invite, data);
    if (!link) { operation.setError('The hub returned no shareable invitation.'); return; }
    setIssued(link);
  }
  async function saveLimits(event) {
    event.preventDefault();
    if (await operation.run('updateSettings', [{
      storageCeilingMb: limits.storageCeilingMb === '' ? null : Number(limits.storageCeilingMb),
      retentionDays: limits.retentionDays === '' ? null : Number(limits.retentionDays),
    }], 'Storage settings saved.')) setLimits(null);
  }
  return <Box sx={{ maxWidth: 950, mx: 'auto' }}>
    <Heading title="Owner console" subtitle={`Invitations, members, and trust status for ${networkName(data)}.`} />
    <Feedback operation={operation} />
    <Card sx={section}><CardContent><Typography variant="h6" gutterBottom>Invitations</Typography>
      <Button variant="contained" disabled={operation.busy || typeof actions?.issueInvite !== 'function'} onClick={invite}>Make invitation</Button>
      {issued && <Alert severity="info" sx={{ mt: 2 }}>Share this invitation: {issued}</Alert>}
      {invites === null ? <Typography color="text.secondary" sx={{ mt: 2 }}>Invitation status is not available from this hub.</Typography>
        : invites.length ? <List dense>{invites.map(item => <ListItem key={idOf(item)} divider sx={{ gap: 1, flexWrap: 'wrap' }}>
          <ListItemText primary={invitationUrl(item, data) || 'Invitation'} secondary={`Status: ${item.status || 'Unavailable'}`} />
          {item.status === 'unused' && typeof actions?.revokeInvite === 'function' && <Button color="error" size="small" disabled={operation.busy} onClick={() => operation.run('revokeInvite', [idOf(item)], 'Invitation revoked.')}>Revoke</Button>}
        </ListItem>)}</List> : <Typography color="text.secondary" sx={{ mt: 2 }}>No invitations have been issued.</Typography>}
    </CardContent></Card>
    <Card sx={section}><CardContent><Typography variant="h6" gutterBottom>Members</Typography>
      {members === null ? <Typography color="text.secondary">Member status is not available from this hub.</Typography>
        : members.length ? <List dense>{members.map(person => {
          const activeDevices = (data.allDevices || []).filter(device => device.did === person.did && device.status === 'active').length;
          return <ListItem key={idOf(person)} divider sx={{ gap: 1, flexWrap: 'wrap' }}>
            <ListItemText primary={person.name || person.did || 'Member'} secondary={[person.role, person.state, `${activeDevices} device${activeDevices === 1 ? '' : 's'}`, person.admittedAt && `Joined ${displayDate(person.admittedAt)}`, person.revokedAt && `Removed ${displayDate(person.revokedAt)}`].filter(Boolean).join(' · ')} />
            {person.state === 'active' && typeof actions?.sendDeviceLink === 'function' && <Button size="small" disabled={operation.busy} onClick={() => setLinking(person)}>Send device link</Button>}
            {person.state === 'active' && person.did !== data?.identity?.id && typeof actions?.revokeMember === 'function' && <Button color="error" size="small" onClick={() => setRemoving(person)}>Remove access</Button>}
          </ListItem>;
        })}</List> : <Typography color="text.secondary">No members to show.</Typography>}
    </CardContent></Card>
    <Card sx={section}><CardContent><Typography variant="h6" gutterBottom>Your devices</Typography>
      <Typography color="text.secondary" sx={{ mb: 1 }}>This list only shows registrations for your identity. Member devices live just below.</Typography>
      <DeviceList devices={available(data, 'devices') ? data?.devices || [] : null} operation={operation} actions={actions} currentDeviceId={localRegistration(data, data?.identity)?.deviceId} />
    </CardContent></Card>
    <Card sx={section}><CardContent><Typography variant="h6" gutterBottom>Member devices</Typography>
      {availability?.allDevices === false || !Array.isArray(data?.allDevices) ? <Typography color="text.secondary">The member device list is not available from this hub.</Typography>
        : data.allDevices.length === 0 ? <Typography color="text.secondary">No member devices are registered here yet.</Typography>
          : <List dense>{data.allDevices.map(device => {
            const member = members?.find(entry => entry.did === device.did);
            const revoked = device.status === 'revoked';
            return <ListItem key={idOf(device)} divider sx={{ gap: 1, flexWrap: 'wrap' }}>
              <ListItemText primary={named(device)} secondary={[
                member ? member.name || member.did : device.did, revoked ? 'Removed' : device.status === 'active' ? 'Connected' : 'Status unavailable',
                device.createdAt && `Added ${displayDate(device.createdAt)}`,
              ].filter(Boolean).join(' · ')} />
              {!revoked && typeof actions?.revokeAnyDevice === 'function' && <Button color="error" size="small" disabled={operation.busy} onClick={() => void operation.run('revokeAnyDevice', [idOf(device)], 'Device removed.')}>Remove</Button>}
            </ListItem>;
          })}</List>}
    </CardContent></Card>
    <Card sx={section}><CardContent><Typography variant="h6" gutterBottom>Device links sent</Typography>
      <Typography color="text.secondary" sx={{ mb: 1 }}>Device links work once, for the member they were made for. They die the moment they are revoked or used.</Typography>
      {availability?.deviceLinks === false || !Array.isArray(data?.deviceLinks) ? <Typography color="text.secondary">Device-link status is not available from this hub.</Typography>
        : data.deviceLinks.length === 0 ? <Typography color="text.secondary">No device links have been sent yet.</Typography>
          : <List dense>{data.deviceLinks.map(row => <ListItem key={idOf(row)} divider sx={{ gap: 1, flexWrap: 'wrap' }}>
            <ListItemText primary={`Link for ${members?.find(entry => entry.did === row.did)?.name || row.did}`} secondary={`Status: ${row.status || 'Unavailable'} · Made ${displayDate(row.createdAt)} · Stops working ${displayDate(row.expiresAt)}`} />
            {row.status === 'unused' && typeof actions?.revokeDeviceGrant === 'function' && <Button color="error" size="small" disabled={operation.busy} onClick={() => void operation.run('revokeDeviceGrant', [idOf(row)], 'Device link withdrawn.')}>Withdraw</Button>}
          </ListItem>)}</List>}
    </CardContent></Card>
    <Card sx={section}><CardContent><Typography variant="h6" gutterBottom>Space and limits</Typography>
      {disk?.available === true ? <Alert severity={disk.uploadsHalted ? 'error' : disk.warning ? 'warning' : 'success'} sx={{ mb: 2 }}>
        {disk.uploadsHalted ? 'New uploads are paused by the disk guard. Existing content is still available.' : disk.warning ? 'Disk space is getting low. Uploads are still available.' : 'Disk space is within the hub thresholds.'}
        {' '}Free: {disk.freeBytes?.toLocaleString()} bytes of {disk.totalBytes?.toLocaleString()} bytes.
      </Alert> : <Alert severity="info" sx={{ mb: 2 }}>Live disk status is not available from this hub.</Alert>}
      {settings ? <><Typography>Stored media: {settings.usedBytes?.toLocaleString() ?? 'Unavailable'} bytes.</Typography>
        <Typography color="text.secondary">Storage ceiling: {settings.quota?.storageCeilingMb == null ? 'Unset' : `${settings.quota.storageCeilingMb} MB`} · Retention: {settings.quota?.retentionDays == null ? 'Unset' : `${settings.quota.retentionDays} days`}</Typography>
        <Box component="form" onSubmit={saveLimits} sx={{ ...rows, mt: 2 }}>
          <TextField size="small" label="Storage ceiling (MB)" type="number" inputProps={{ min: 1, step: 1 }} value={limits.storageCeilingMb} onChange={event => setLimits(value => ({ ...(value || limits), storageCeilingMb: event.target.value }))} />
          <TextField size="small" label="Retention (days)" type="number" inputProps={{ min: 1, step: 1 }} value={limits.retentionDays} onChange={event => setLimits(value => ({ ...(value || limits), retentionDays: event.target.value }))} />
          <Button type="submit" variant="contained" disabled={operation.busy || typeof actions?.updateSettings !== 'function'}>Save limits</Button>
        </Box></> : <Typography color="text.secondary">Storage settings are not available from this hub.</Typography>}
      <Box sx={{ mt: 2 }}><Button disabled={!data?.identity || !data?.connections?.some(item => item.identity?.id === data.identity.id && item.token) || operation.busy || typeof actions?.exportData !== 'function'} onClick={() => operation.run('exportData', [], 'Archive download started.')}>Download archive</Button></Box>
      <Typography variant="body2" color="text.secondary" sx={{ mt: 1 }}>The archive includes your authored posts, comments, reactions, and original media. Backup status is not exposed by this hub.</Typography>
    </CardContent></Card>
    <Card><CardContent><Typography variant="h6" gutterBottom>Recent activity</Typography>
      {audit === null ? <Typography color="text.secondary">Activity status is not available from this hub.</Typography>
        : audit.length ? <List dense>{audit.map((entry, index) => <ListItem key={idOf(entry) || index} divider><ListItemText primary={entry.action || 'Activity'} secondary={[entry.did, displayDate(entry.createdAt)].filter(Boolean).join(' · ')} /></ListItem>)}</List>
          : <Typography color="text.secondary">No activity is recorded here yet.</Typography>}
      <Button onClick={() => navigate?.('/profile')}>Back to profile</Button>
    </CardContent></Card>
    <Dialog open={Boolean(linking)} onClose={() => { setLinking(null); setIssuedDeviceLink(''); }} fullWidth maxWidth="xs">
      <DialogTitle>Send a device link to {linking?.name || 'this member'}?</DialogTitle>
      <DialogContent><Typography>The link works once, for 24 hours, and only for this member's place on {networkName(data)} — it never creates a new identity. Share it in a family chat like any other link.</Typography>
        {issuedDeviceLink && <Alert severity="info" sx={{ mt: 2 }}><Typography>Send this link:</Typography><Typography sx={{ wordBreak: 'break-all' }}>{issuedDeviceLink}</Typography></Alert>}
      </DialogContent>
      <DialogActions>
        <Button onClick={() => { setLinking(null); setIssuedDeviceLink(''); }}>Close</Button>
        {!issuedDeviceLink && <Button variant="contained" disabled={operation.busy || !linking?.did} onClick={async () => {
          const result = await operation.run('sendDeviceLink', [linking.did]);
          if (result?.linkUrl) setIssuedDeviceLink(result.linkUrl);
        }}>Make the link</Button>}
      </DialogActions>
    </Dialog>
    <Dialog open={Boolean(removing)} onClose={() => setRemoving(null)} fullWidth maxWidth="xs"><DialogTitle>Remove member access?</DialogTitle>
      <DialogContent><Typography>This ends {removing?.did || 'this member'}'s membership on {networkName(data)}. It does not remove their identity or their posts.</Typography></DialogContent>
      <DialogActions><Button onClick={() => setRemoving(null)}>Keep member</Button><Button color="error" disabled={operation.busy} onClick={async () => {
        if (await operation.run('revokeMember', [removing], 'Membership removed.')) setRemoving(null);
      }}>Remove access</Button></DialogActions>
    </Dialog>
  </Box>;
}
