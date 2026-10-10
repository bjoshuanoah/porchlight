import React, { useEffect, useRef, useState } from 'react';
import {
  Alert, Avatar, Box, Button, Card, CardContent, Collapse, Dialog, DialogActions,
  DialogContent, DialogTitle, Divider, List, ListItem, ListItemAvatar, ListItemText,
  Paper, Stack, Tab, Tabs, TextField, ToggleButton, ToggleButtonGroup, Typography,
} from '@mui/material';
import { hubOrigin, joinLinkMismatch, parseDeviceGrant, parseJoinCode, readJoinQuery, splitJoinLink, verifyFailure } from './frontdoor.js';
import { joinNameErrors, resumedDetail, setupStage } from './setup-state.js';
import { copyLink, directoryRows, inviteDialogCopy, inviteRows, viewerIsOwner, viewerRole, roleLabel } from './member-directory.js';
import { updateCardModel } from './update.js';
import { consoleTabs } from './console-tabs.js';
import { formatStorage, formatStorageMb, ceilingMbToGb, ceilingGbToMb } from './storage-format.js';
import { Lockup, LampMark } from './brand.jsx';
import { cssVars } from './theme.js';

/** Removal capability on the ladder (PORCH-053): the owner removes anyone
 * (the final-owner invariant guards the last one); a delegate removes
 * plain members — removing an owner is an owner action. */
function canRemoveMember(viewer, target) {
  if (viewer === 'owner') return true;
  if (viewer === 'delegate') return target !== 'owner';
  return false;
}

const section = { mb: 3 };
const rows = { display: 'flex', flexWrap: 'wrap', gap: 1, alignItems: 'center' };
// Front-door panels (design tokens): surface on the warm page, warm border,
// 14px radius, sparse card shadow — the approved join/setup look, both modes.
const frontPanel = { // sx object
  border: `1px solid ${cssVars.border}`,
  borderRadius: '14px',
  boxShadow: cssVars.shadowCard,
  p: { xs: 2, sm: 3 },
};
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
  // PORCH-053: the server's admin refusals already speak family language —
  // the final-owner refusal and the typed-name confirmation must render the
  // server's own reason, never a generic stand-in.
  if (cause?.code === 'E_LAST_OWNER' || cause?.code === 'E_CONFIRM_NAME') return cause?.message || 'The hub could not complete this action.';
  if (cause?.code === 'E_FORBIDDEN' && cause?.status === 403 && typeof cause?.message === 'string' && cause.message.length > 0) return cause.message;
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
    <Typography variant="h1" component="h1" gutterBottom>{title}</Typography>
    {subtitle && <Typography variant="body1" color="text.secondary">{subtitle}</Typography>}
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
// URL-implied network (Brian, Oct 14, 2026): the hub being joined is the hub
// serving this page. When the invite rides the URL (path or query string),
// entry is skipped entirely — the code is verified automatically against the
// serving hub. Only a mismatch between the visited address and the hub the
// invite names falls back to explicit entry (the mismatch state).
export function Join({ data, actions, navigate }) {
  const visited = window.location.origin;
  const [url, setUrl] = useState(visited);
  const [code, setCode] = useState(() => parseJoinCode(window.location.pathname) || readJoinQuery(window.location.search));
  const [stage, setStage] = useState('fields'); // fields | confirm | naming | busy | done | mismatch
  const [network, setNetwork] = useState(null);
  // Required names (PORCH-024): the join screen captures first and last;
  // each empty field shows its own error at submit.
  const [names, setNames] = useState({ first: '', last: '' });
  const [nameErrors, setNameErrors] = useState({ first: '', last: '' });
  const [chosen, setChosen] = useState(null);
  const [mismatch, setMismatch] = useState(null);
  const operation = useOperation(actions);
  const arrived = useRef(false);

  const localAt = (originValue) => (data?.connections || []).filter((item) => {
    try { return new URL(item.url).origin === originValue && item.deviceId; }
    catch { return false; }
  });
  const local = localAt((() => { try { return hubOrigin(url); } catch { return ''; } })());
  const target = (() => {
    try { return hubOrigin(url); } catch { return ''; }
  })();
  const failure = (state, cause) => {
    setStage('fields');
    operation.setError(verifyCopy(state, cause, target));
  };
  /** Verify the invite against one hub; returns true only when safe to proceed. */
  async function verify(originValue, codeValue) {
    setStage('busy');
    operation.setError(''); operation.setNotice('');
    try {
      const result = await actions.verifyJoin({ url: originValue, code: codeValue.trim() });
      const found = joinLinkMismatch(result.joinUrl, originValue);
      setNetwork(result.network || null);
      if (found) { setMismatch(found); setStage('mismatch'); return false; }
      return true;
    } catch (cause) {
      failure(verifyFailure(cause), cause);
      return false;
    }
  }
  const proceedStage = () => setStage(localAt(visited).length ? 'confirm' : 'naming');
  useEffect(() => {
    // Landing with the invite embedded (path /join/<code> or ?invite=/<code>):
    // skip the entry step and verify against the hub serving the page — no
    // prompt for network URL or invite code (PORCH-023 ac-1).
    if (arrived.current) return;
    arrived.current = true;
    if (!code.trim()) return;
    void (async () => {
      if (await verify(visited, code)) proceedStage();
    })();
    // Landing-only: manual entry resumes through connect(), never re-runs here.
  }, []);
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
    if (await verify(origin, code)) proceedStage();
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
        const first = names.first.trim();
        const last = names.last.trim();
        const errors = joinNameErrors(first, last);
        if (errors.first || errors.last) {
          setStage('naming');
          setNameErrors(errors);
          return;
        }
        await actions.joinNew({ url: origin, code: codeValue, firstName: first, lastName: last });
      }
      setStage('done');
    } catch (cause) {
      failure(verifyFailure(cause), cause);
    }
  }
  return <Box sx={{ maxWidth: 540, mx: 'auto' }}>
    <Box component="header" sx={{ mb: 3, textAlign: 'center' }}>
      <Lockup size={32} />
    </Box>
    <Heading title={stage === 'done' ? "You're home." : 'Join your family'}
      subtitle={stage === 'done' ? `Your place on ${network?.name || 'your family network'} is ready.`
        : stage === 'fields' || stage === 'mismatch' ? 'The network URL is the hub you are joining; the invite code is your proof of invitation.'
        : stage === 'busy' ? 'Checking the invitation with the hub…'
        : 'Connect once and this device stays yours.'} />
    {stage === 'done' ? <Paper elevation={0} sx={frontPanel}><Stack spacing={2}>
      <Typography>Your family can see you now. Nothing to import, nothing to set up twice.</Typography>
      <Button variant="contained" sx={{ height: 48 }} onClick={() => navigate?.('/timeline')}>Open Timeline</Button>
    </Stack></Paper>
    : stage === 'mismatch' ? <Paper elevation={0} sx={frontPanel}><Stack spacing={2}>
      <Alert severity="warning" icon={false}>
        This invitation was made for {mismatch.named}, but you are visiting {mismatch.visited}.
      </Alert>
      <Typography>One join link belongs to one address. Open the invitation's own address to continue, or enter the two details yourself.</Typography>
      <Button component="a" href={mismatch.joinUrl} variant="contained" sx={{ height: 48 }}>Open the invite's own address</Button>
      <Button variant="outlined" sx={{ height: 48 }} onClick={() => setStage('fields')}>Enter the two details yourself</Button>
    </Stack></Paper>
      : stage === 'confirm' || stage === 'naming' || stage === 'busy' ? <Paper elevation={0} sx={frontPanel}><Stack spacing={2}>
        <Alert severity="success" icon={false}>
          {stage === 'busy' ? 'Checking this hub…' : `You're joining ${network?.name || 'your family'}. Connect once and this device stays yours.`}
        </Alert>
        {stage === 'naming' && <>
          <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2}>
            <TextField label="First name" value={names.first} onChange={(event) => {
              setNames((current) => ({ ...current, first: event.target.value }));
              setNameErrors((current) => ({ ...current, first: '' }));
            }} required autoFocus fullWidth autoComplete="given-name" error={Boolean(nameErrors.first)} helperText={nameErrors.first} />
            <TextField label="Last name" value={names.last} onChange={(event) => {
              setNames((current) => ({ ...current, last: event.target.value }));
              setNameErrors((current) => ({ ...current, last: '' }));
            }} required fullWidth autoComplete="family-name" error={Boolean(nameErrors.last)} helperText={nameErrors.last} />
          </Stack>
          <Button variant="contained" fullWidth sx={{ height: 48 }} disabled={operation.busy} onClick={() => proceed(null)}>Join Porchlight</Button>
          {local.length > 0 && <Typography variant="body2" color="text.secondary">Someone is already connected on this device — pick them instead:</Typography>}
        </>}
        {stage !== 'naming' && local.map((item) => (
          <Button key={`${item.url}:${item.identity?.id}`} variant={chosen?.identity?.id === item.identity?.id ? 'contained' : 'outlined'}
            disabled={operation.busy} onClick={() => setChosen(item)}>
            Continue as {item.identity?.name || 'a family member'}
          </Button>
        ))}
        {stage === 'confirm' && <Button variant="contained" fullWidth sx={{ height: 48 }} disabled={operation.busy} onClick={() => proceed(chosen || local[0])}>
          {local.length ? 'Connect' : 'Next'}
        </Button>}
        <Feedback operation={operation} />
      </Stack></Paper>
        : <Paper elevation={0} sx={frontPanel}><form onSubmit={connect}><Stack spacing={2}>
          <TextField label="Network URL" type="url" value={url} onChange={(event) => setUrl(event.target.value)} required fullWidth
            helperText="The hub you are joining — your family's Porchlight lives at this address." autoComplete="url" />
          <TextField label="Invite code" value={code} onChange={(event) => setCode(event.target.value)} required fullWidth
            helperText="Proof of invitation: the code from the join link your family's owner sent." autoComplete="off" />
          <Feedback operation={operation} />
          <Button type="submit" variant="contained" fullWidth sx={{ height: 48 }} disabled={operation.busy}>Connect</Button>
        </Stack></form></Paper>}
    {stage !== 'done' && <Stack direction="row" spacing={1} sx={{ mt: 2, flexWrap: 'wrap' }}>
      <Button onClick={() => navigate?.('/pair')}>Connect with a code from another device</Button>
      <Button onClick={() => navigate?.('/device-link')}>Use a device link</Button>
    </Stack>}
  </Box>;
}

const setupSteps = ["network", "account"]; // exactly two prompts (PORCH-020)

function StepCircle({ number, state }) {
  const sx = state === 'complete'
    ? { bgcolor: "primary.main", color: cssVars.textInverse }
    : state === 'current' ? { bgcolor: "secondary.main", color: cssVars.amberInk } : { bgcolor: cssVars.subtle, color: "text.secondary" };
  return <Box sx={{ width: 24, height: 24, borderRadius: "50%", display: "grid", placeItems: "center", fontSize: 13, flexShrink: 0, ...sx }}>
    {state === 'complete' ? "✓" : number}
  </Box>;
}

/** Human progress only (PORCH-020): two named steps, never a state dump. */
function SetupProgress({ stageIndex }) {
  return <Box sx={{ display: "flex", gap: 2, mb: 3, flexWrap: "wrap" }}>
    {setupSteps.map((step, index) => {
      const state = index < stageIndex ? 'complete' : index === stageIndex ? 'current' : 'future';
      return <Box key={step} sx={{ display: "flex", alignItems: "center", gap: 1 }}>
        <StepCircle number={index + 1} state={state} />
        <Typography variant="body2">{step === "network" ? "Name the network" : "Who you are"}</Typography>
      </Box>;
    })}
  </Box>;
}

function SetupShell({ children }) {
  // Owner bootstrap panel (tokens): centered 960px white panel, 18px radius,
  // warm border, sparse shadow; the optional photo slot rides the warm
  // gradient side panel (no external asset — the porch-lamp glow is CSS).
  return <Box sx={{ maxWidth: 960, mx: "auto" }}>
    <Paper elevation={0} sx={{ borderRadius: "18px", border: `1px solid ${cssVars.border}`, boxShadow: cssVars.shadowCard, overflow: "hidden" }}>
      <Box sx={{ display: "grid", gridTemplateColumns: { md: "58% 42%" } }}>
        <Box sx={{ p: { xs: 2.5, sm: 4, md: 5 } }}>
          <Heading title="Set up your porch" subtitle="Two quick questions and you are home: the network's name, and who you are. Everything else waits until you are inside." />
          {children}
        </Box>
        {/* Brand surface (PORCH-032): the lamp mark glows over the porch-side gradient. */}
        <Box aria-hidden="true" sx={{ display: { xs: "none", md: "flex" }, alignItems: "flex-end", justifyContent: "center", minHeight: 480, background: `radial-gradient(circle at 50% 115%, ${cssVars.lampGlowSoft}, transparent 60%), linear-gradient(180deg, ${cssVars.warm}, ${cssVars.amberSoft})` }}>
          <LampMark size={120} sx={{ mb: 6, filter: `drop-shadow(0 0 28px ${cssVars.lampGlow})` }} />
        </Box>
      </Box>
    </Paper>
  </Box>;
}

function NetworkNameStep({ name, onChange, onNext, busy }) {
  return <Box sx={section}>
    <SetupProgress stageIndex={0} />
    <Box component="form" onSubmit={onNext}><Stack spacing={2}>
      <Typography color="text.secondary">What is your family's Porchlight called? You can change it later in the owner console.</Typography>
      <TextField label="Network name" value={name} onChange={(event) => onChange(event.target.value)} required autoFocus fullWidth placeholder="The Noah Family" />
      <Button type="submit" variant="contained" sx={{ height: 48 }} disabled={busy}>Continue</Button>
    </Stack></Box>
  </Box>;
}

function AccountStep({ stageIndex, network, fields, onField, errors, photo, onPhoto, onSubmit, busy, existing }) {
  return <Box sx={section}>
    <SetupProgress stageIndex={stageIndex} />
    <Box component="form" onSubmit={onSubmit}><Stack spacing={2}>
      <Typography color="text.secondary">
        {existing
          ? `Your place already exists on this hub. Now it joins ${network}.`
          : `Say who you are on ${network}. First and last names, and — only if you like — a photo.`}
      </Typography>
      <Stack direction={{ xs: "column", sm: "row" }} spacing={2}>
        <TextField label="First name" value={fields.first} onChange={(event) => onField("first", event.target.value)} required autoFocus fullWidth autoComplete="given-name" error={Boolean(errors?.first)} helperText={errors?.first} />
        <TextField label="Last name" value={fields.last} onChange={(event) => onField("last", event.target.value)} required fullWidth autoComplete="family-name" error={Boolean(errors?.last)} helperText={errors?.last} />
      </Stack>
      <Button variant="text" component="label" sx={{ alignSelf: "flex-start" }}>{photo ? "Photo chosen — change it" : "Add a photo (optional)"}
        <input type="file" accept="image/*" hidden onChange={onPhoto} />
      </Button>
      <Button type="submit" variant="contained" sx={{ height: 48 }} disabled={busy}>{existing ? "Open the network" : "Finish setup"}</Button>
    </Stack></Box>
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
 * Owner bootstrap (PORCH-020): a two-prompt wizard — the network's name,
 * then who you are (first and last names plus an optional photo) — and the
 * bound owner lands straight in the network's timeline. Invites and network
 * settings never appear here: joining others and tuning the network are
 * owner-console actions taken from inside. Every step rides the hub's
 * public setup ledger, so a closed browser resumes exactly where setup
 * paused — never a silent half-configured hub.
 */
export function Setup({ data, actions, navigate }) {
  const operation = useOperation(actions);
  const [account, setAccount] = useState(null);
  const [stage, setStage] = useState('network');
  const [networkName, setNetworkName] = useState('');
  const [fields, setFields] = useState({ first: '', last: '' });
  const [fieldErrors, setFieldErrors] = useState({ first: '', last: '' });
  const [photo, setPhoto] = useState('');
  const network = networkName;

  // A ledger that already finished both steps never shows a screen: the
  // owner lands directly in the network (or, with no identity open on this
  // device, on the front door the app already routes to).
  useEffect(() => {
    void (async () => {
      try {
        const hubState = await actions.setupState();
        setAccount(await actions.accountState());
        const initial = setupStage(hubState);
        setStage(initial === "landed" ? "done" : initial);
        if (initial === "landed") { navigate?.("/timeline"); return; }
        if (hubState?.lastError) operation.setError(resumedDetail(hubState.lastError));
      } catch {
        setStage("network");
        operation.setError("The hub could not be reached just now. It may still be starting — try again in a moment.");
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Who the network will belong to: an owner identity this device or the
  // hub already holds (resumed setup), else the account created on finish.
  const ownerDid = data?.identity?.id || account?.account?.did || null;
  const existingOwner = Boolean(ownerDid || account?.exists);

  async function continueNetwork(event) {
    event.preventDefault();
    if (!networkName.trim()) { operation.setError("Every network needs a name — even just your family's."); return; }
    if (existingOwner) {
      // Resumed setup: the who-you-are step is already done; creating the
      // network binds the existing owner, then the owner lands directly.
      if (await operation.run("startNetwork", [{ name: networkName.trim(), ownerDid }])) navigate?.("/timeline");
      return;
    }
    operation.setError("");
    setStage("account");
  }

  async function finishSetup(event) {
    event.preventDefault();
    const errors = joinNameErrors(fields.first, fields.last);
    if (errors.first || errors.last) { setFieldErrors(errors); return; }
    setFieldErrors({ first: '', last: '' });
    const owner = await operation.run("createOwnerAccount", [{
      firstName: fields.first.trim(), lastName: fields.last.trim(), avatar: photo || undefined,
    }]);
    if (!owner) return;
    const founded = await operation.run("startNetwork", [{ name: networkName.trim(), ownerDid: owner.registration.did }]);
    if (!founded) return;
    // Landing: the bound owner goes into the network, never a detached
    // administration state.
    navigate?.("/timeline");
  }

  return <SetupShell>
    {stage === "network" && <Box>
      <Feedback operation={operation} />
      <NetworkNameStep name={networkName} onChange={setNetworkName} onNext={continueNetwork} busy={operation.busy} />
      {account?.exists && <Typography variant="body2" color="text.secondary" sx={{ mt: 2 }}>An account exists on this hub already. Continuing keeps it untouched.</Typography>}
    </Box>}
    {stage === "account" && <Box>
      <Feedback operation={operation} />
      <AccountStep stageIndex={1} network={networkName || "your network"}
        fields={fields} onField={(field, value) => setFields((current) => ({ ...current, [field]: value }))}
        errors={fieldErrors}
        photo={photo} onPhoto={(event) => {
          const file = event.target.files?.[0];
          if (!file) return;
          downscalePhoto(file).then((dataUrl) => { setPhoto(dataUrl); operation.setError(""); }).catch(() => operation.setError("This photo could not be read. Try another one."));
        }}
        onSubmit={finishSetup}
        busy={operation.busy} />
    </Box>}
  </SetupShell>;
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

export function Profile({ data, actions, navigate, mode }) {
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
  // PORCH-029 discoverability: the member directory is an owner surface, and
  // the only identity list the SPA can consult is the console members
  // response (owner-only at the hub) — the viewer seeing themselves as the
  // owner there is the owner. Non-owners keep riding the origin-membership
  // surfaces already specced (mention resolution, group members). The owner
  // console navigation entry (PORCH-040 user-testing follow-up) rides the
  // same gate: owners reach the console from Profile, non-owners see neither
  // button.
  const isOwner = viewerIsOwner(data);
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
      <Box sx={{ ...rows, mt: 2 }}><Button onClick={() => navigate?.('/who-is-here')}>Who is here?</Button><Button onClick={() => setMembershipOpen(value => !value)} aria-expanded={membershipOpen}>Memberships</Button>{isOwner && <Button onClick={() => navigate?.('/members')}>Members</Button>}{isOwner && <Button onClick={() => navigate?.('/owner')}>Owner console</Button>}{typeof actions?.signOut === 'function' && <Button variant="text" disabled={operation.busy} onClick={() => actions.signOut()}>Sign out</Button>}</Box>
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
    {/* PORCH-042 appearance setting: Light / Dark / System, System the
        default. The choice is device-level (client-local per origin, carried
        by no server write) — the wording says so plainly. */}
    {typeof actions?.chooseMode === 'function' && typeof mode === 'string' && <Card sx={section}><CardContent><Typography variant="h6">Appearance</Typography>
      <Typography color="text.secondary">Light, dark, or follow this device. The choice stays on this device for everyone using it.</Typography>
      <ToggleButtonGroup exclusive size="small" aria-label="Display mode" value={mode} onChange={(event, next) => next && actions.chooseMode(next)} sx={{ mt: 2 }}>
        <ToggleButton value="light" aria-label="Light mode">Light</ToggleButton>
        <ToggleButton value="dark" aria-label="Dark mode">Dark</ToggleButton>
        <ToggleButton value="system" aria-label="Follow this device's theme">System</ToggleButton>
      </ToggleButtonGroup>
    </CardContent></Card>}
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

export const AUDIT_PAGE = 50;

/**
 * Recent activity (PORCH-058 ac-3): the console's audit log renders newest
 * first, with forward/back paging controls riding the hub's paginated read
 * — later pages load without reloading the console. The boot-loaded page is
 * page one; paging re-fetches through `actions.loadAuditPage(offset)` on the
 * same console surface.
 */
function RecentActivity({ audit, actions }) {
  // `paged` holds the fetched page once the owner turns past page one;
  // while it stays null the card renders the boot-loaded first page.
  const [paged, setPaged] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const entries = paged && Array.isArray(paged.events) ? paged.events : audit;
  const offset = paged?.offset ?? 0;
  const more = paged ? Boolean(paged.hasMore) : typeof actions?.loadAuditPage === 'function';

  async function page(next) {
    if (busy || typeof actions?.loadAuditPage !== 'function' || next < 0) return;
    setBusy(true);
    setError('');
    try {
      const result = await actions.loadAuditPage(next);
      if (Array.isArray(result?.events)) {
        setPaged({ events: result.events, offset: result.offset ?? next, hasMore: Boolean(result.hasMore) });
      }
    } catch (cause) {
      setError(cause?.body?.error || cause?.message || 'The activity page is not available right now.');
    } finally {
      setBusy(false);
    }
  }

  return <Card><CardContent><Typography variant="h6" gutterBottom>Recent activity</Typography>
    {entries === null ? <Typography color="text.secondary">Activity status is not available from this hub.</Typography>
      : entries.length ? <>
        <List dense>{entries.map((entry, index) => <ListItem key={idOf(entry) || index} divider><ListItemText primary={entry.action || 'Activity'} secondary={[entry.did, displayDate(entry.createdAt)].filter(Boolean).join(' · ')} /></ListItem>)}</List>
        {typeof actions?.loadAuditPage === 'function' && <Box sx={{ display: 'flex', gap: 1, justifyContent: 'flex-end', alignItems: 'center', mt: 1 }}>
          {error && <Typography variant="body2" color="error">{error}</Typography>}
          <Button size="small" disabled={busy || offset <= 0} onClick={() => void page(offset - AUDIT_PAGE)}>Newer</Button>
          <Button size="small" disabled={busy || more === false} onClick={() => void page(offset + AUDIT_PAGE)}>Older</Button>
        </Box>}
      </>
      : <Typography color="text.secondary">No activity is recorded here yet.</Typography>}
  </CardContent></Card>;
}

export function OwnerConsole({ data, actions, navigate }) {
  const operation = useOperation(actions);
  const [issued, setIssued] = useState('');
  const [removing, setRemoving] = useState(null);
  const [purging, setPurging] = useState(null);
  const [purgeName, setPurgeName] = useState('');
  const [linking, setLinking] = useState(null);
  const [issuedDeviceLink, setIssuedDeviceLink] = useState('');
  const [draftLimits, setLimits] = useState(null);
  const [inviteOpen, setInviteOpen] = useState(false);
  const [updating, setUpdating] = useState(false);
  const [updateFeedback, setUpdateFeedback] = useState(null);
  // PORCH-057: the console's areas render as distinct tabs (the model of
  // record lives in console-tabs.js). Panels stay mounted while hidden, so
  // the drafts (limits, media root) survive tab switches.
  const [tab, setTab] = useState('invitations');
  const [draftRoot, setDraftRoot] = useState(null);
  const members = available(data, 'members') ? data?.members || [] : null;
  const invites = available(data, 'invites') ? data?.invites || [] : null;
  const disk = available(data, 'disk') ? data?.disk : null;
  const settings = available(data, 'settings') ? data?.settings : null;
  const availability = data?.availability || {};
  // PORCH-056: the wire carries the ceiling in MB, the console shows and
  // edits GB — the draft state holds the human figure, the save converts.
  const limits = draftLimits || {
    storageCeilingGb: ceilingMbToGb(settings?.quota?.storageCeilingMb),
    retentionDays: settings?.quota?.retentionDays ?? '',
  };
  // The one owner action (PORCH-040): apply through the hub's shared update
  // service. The server speaks its own plain language on failure (the prior
  // release keeps serving, nothing half-changed), so its message surfaces
  // verbatim instead of the generic member fallback.
  async function applyNewRelease() {
    setUpdating(true);
    setUpdateFeedback(null);
    operation.setError('');
    operation.setNotice('');
    try {
      const result = await actions.applyUpdate();
      setUpdateFeedback(result?.status === 'latest'
        ? { severity: 'info', message: 'This is already the latest release — nothing changed.' }
        : { severity: 'success', message: 'Update applied — the hub restarted and serves the new release at the same address.' });
    } catch (cause) {
      operation.setError(cause?.body?.error || memberError(cause));
    } finally {
      setUpdating(false);
    }
  }
  async function makeJoinLink() {
    const result = await operation.run('issueInvite');
    if (!result) return;
    const link = invitationUrl(result.invite, data);
    if (!link) { operation.setError('The hub returned no shareable invitation.'); return; }
    setIssued(link);
  }
  async function saveLimits(event) {
    event.preventDefault();
    if (await operation.run('updateSettings', [{
      storageCeilingMb: ceilingGbToMb(limits.storageCeilingGb),
      retentionDays: limits.retentionDays === '' ? null : Number(limits.retentionDays),
    }], 'Storage settings saved.')) setLimits(null);
  }
  // Media-root edit (PORCH-054 / PORCH-057): a failing path is refused with
  // the check's reason, surfaced verbatim — no generic stand-in, never a move
  // of existing media.
  async function saveMediaRoot(event) {
    event.preventDefault();
    const root = (draftRoot ?? '').trim();
    if (!root) return;
    operation.setError('');
    operation.setNotice('');
    try {
      await actions.editMediaRoot(root);
      setDraftRoot(null);
      operation.setNotice('Media root saved. Existing media never moved — move the archive and repoint, in that order.');
    } catch (cause) {
      operation.setError(cause?.body?.error || memberError(cause));
    }
  }
  return <Box sx={{ maxWidth: 950, mx: 'auto' }}>
    <Heading title="Owner console" subtitle={`Invitations, members, and trust status for ${networkName(data)}.`} />
    <Feedback operation={operation} />
    <Box sx={{ display: 'flex', justifyContent: 'flex-end', mb: 1 }}>
      <Button onClick={() => navigate?.('/profile')}>Back to profile</Button>
    </Box>
    {/* PORCH-057: the one stacked scroll became distinct tabs. Scrollable
        variant keeps the bar usable on narrow mobile web (the bar scrolls,
        the page never does); panels stay mounted while hidden. */}
    <Tabs value={tab} onChange={(event, value) => setTab(value)} variant="scrollable" scrollButtons={false} aria-label="Owner console sections" sx={{ borderBottom: 1, borderColor: 'divider', mb: 3 }}>
      {consoleTabs.map(({ id, label }) => <Tab key={id} value={id} label={label} id={`owner-tab-${id}`} aria-controls={`owner-tabpanel-${id}`} />)}
    </Tabs>
    <div role="tabpanel" id="owner-tabpanel-invitations" aria-labelledby="owner-tab-invitations" hidden={tab !== 'invitations'}>
    <Card sx={section}><CardContent><Typography variant="h6" gutterBottom>Invitations</Typography>
      <Button variant="contained" disabled={operation.busy || typeof actions?.issueInvite !== 'function'} onClick={() => setInviteOpen(true)}>Make a join link</Button>
      {issued && <Alert severity="info" sx={{ mt: 2 }}>Share this invitation: {issued}</Alert>}
      {invites === null ? <Typography color="text.secondary" sx={{ mt: 2 }}>Invitation status is not available from this hub.</Typography>
        : invites.length ? <List dense>{invites.map(item => <ListItem key={idOf(item)} divider sx={{ gap: 1, flexWrap: 'wrap' }}>
          <ListItemText primary={invitationUrl(item, data) || 'Invitation'} secondary={`Status: ${item.status || 'Unavailable'}`} />
          {item.status === 'unused' && typeof actions?.revokeInvite === 'function' && <Button color="error" size="small" disabled={operation.busy} onClick={() => operation.run('revokeInvite', [idOf(item)], 'Invitation revoked.')}>Revoke</Button>}
        </ListItem>)}</List> : <Typography color="text.secondary" sx={{ mt: 2 }}>No invitations have been issued.</Typography>}
    </CardContent></Card>
    </div>
    <div role="tabpanel" id="owner-tabpanel-members" aria-labelledby="owner-tab-members" hidden={tab !== 'members'}>
    <Card sx={section}><CardContent><Typography variant="h6" gutterBottom>Members</Typography>
      {members === null ? <Typography color="text.secondary">Member status is not available from this hub.</Typography>
        : members.length ? <List dense>{members.map(person => {
          const activeDevices = (data.allDevices || []).filter(device => device.did === person.did && device.status === 'active').length;
          return <ListItem key={idOf(person)} divider sx={{ gap: 1, flexWrap: 'wrap' }}>
            <ListItemText primary={person.name || person.did || 'Member'} secondary={[roleLabel(person.role), person.state, `${activeDevices} device${activeDevices === 1 ? '' : 's'}`, person.admittedAt && `Joined ${displayDate(person.admittedAt)}`, person.revokedAt && `Removed ${displayDate(person.revokedAt)}`].filter(Boolean).join(' · ')} />
            {person.state === 'active' && typeof actions?.sendDeviceLink === 'function' && <Button size="small" disabled={operation.busy} onClick={() => setLinking(person)}>Send device link</Button>}
            {/* Role ladder (PORCH-053): promote/demote is owner-only; the
                row renders the action the viewing member's own capability
                grants and never for the owner row itself. */}
            {person.state === 'active' && !person.isSelf && person.role !== 'owner' && viewerRole(data) === 'owner' && typeof actions?.setMemberRole === 'function' && <Button size="small" disabled={operation.busy} onClick={() => void operation.run('setMemberRole', [person, person.role === 'delegate' ? 'member' : 'delegate'], person.role === 'delegate' ? 'Returned to member.' : 'Delegate added.')}>{person.role === 'delegate' ? 'Return to member' : 'Make delegate'}</Button>}
            {person.state === 'active' && person.did !== data?.identity?.id && canRemoveMember(viewerRole(data), person.role) && typeof actions?.revokeMember === 'function' && <Button color="error" size="small" onClick={() => setRemoving(person)}>Remove access</Button>}
            {person.state !== 'revoked' && viewerRole(data) === 'owner' && person.did !== data?.identity?.id && typeof actions?.purgeMember === 'function' && <Button color="error" size="small" onClick={() => { setPurgeName(''); setPurging(person); }}>Delete member and posts…</Button>}
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
    </div>
    <div role="tabpanel" id="owner-tabpanel-storage" aria-labelledby="owner-tab-storage" hidden={tab !== 'storage'}>
    <Card sx={section}><CardContent><Typography variant="h6" gutterBottom>Space and limits</Typography>
      {disk?.available === true ? <Alert severity={disk.uploadsHalted ? 'error' : disk.warning ? 'warning' : 'success'} sx={{ mb: 2 }}>
        {disk.uploadsHalted ? 'New uploads are paused by the disk guard. Existing content is still available.' : disk.warning ? 'Disk space is getting low. Uploads are still available.' : 'Disk space is within the hub thresholds.'}
        {' '}Free: {formatStorage(disk.freeBytes) ?? 'unavailable'} of {formatStorage(disk.totalBytes) ?? 'unavailable'}.
      </Alert> : <Alert severity="info" sx={{ mb: 2 }}>Live disk status is not available from this hub.</Alert>}
      {settings ? <><Typography>Stored media: {formatStorage(settings.usedBytes) ?? 'Unavailable'}.</Typography>
        <Typography color="text.secondary">Storage ceiling: {settings.quota?.storageCeilingMb == null ? 'Unset' : formatStorageMb(settings.quota.storageCeilingMb) ?? 'Unset'} · Retention: {settings.quota?.retentionDays == null ? 'Unset' : `${settings.quota.retentionDays} days`}</Typography>
        <Box component="form" onSubmit={saveLimits} sx={{ ...rows, mt: 2 }}>
          <TextField size="small" label="Storage ceiling (GB)" type="number" inputProps={{ min: 0.1, step: 0.1 }} value={limits.storageCeilingGb} onChange={event => setLimits(value => ({ ...(value || limits), storageCeilingGb: event.target.value }))} />
          <TextField size="small" label="Retention (days)" type="number" inputProps={{ min: 1, step: 1 }} value={limits.retentionDays} onChange={event => setLimits(value => ({ ...(value || limits), retentionDays: event.target.value }))} />
          <Button type="submit" variant="contained" disabled={operation.busy || typeof actions?.updateSettings !== 'function'}>Save limits</Button>
        </Box></> : <Typography color="text.secondary">Storage settings are not available from this hub.</Typography>}
      <Box sx={{ mt: 2 }}><Button disabled={!data?.identity || !data?.connections?.some(item => item.identity?.id === data.identity.id && item.token) || operation.busy || typeof actions?.exportData !== 'function'} onClick={() => operation.run('exportData', [], 'Archive download started.')}>Download archive</Button></Box>
      <Typography variant="body2" color="text.secondary" sx={{ mt: 1 }}>The archive includes your authored posts, comments, reactions, and original media. Backup status is not exposed by this hub.</Typography>
    </CardContent></Card>
    {/* Media-root setting (PORCH-054's hub surface, rendered by PORCH-057):
        current root with its readiness state, and the edit whose refused
        path names its check; the no-migration sentence rides the hub's note
        verbatim. */}
    <Card sx={section}><CardContent><Typography variant="h6" gutterBottom>Media storage</Typography>
      {(availability?.mediaRoot === false || data?.mediaRoot == null) ? <Typography color="text.secondary">Media-root status is not available from this hub.</Typography>
        : <>
          <Typography sx={{ wordBreak: 'break-all' }}>Media root: {data.mediaRoot.root == null ? "The hub's default location" : data.mediaRoot.root}</Typography>
          <Typography color="text.secondary">{data.mediaRoot.state === 'ready' ? 'The volume is ready; media is stored there.' : `The volume is not ready${data.mediaRoot.check ? ` — check: ${data.mediaRoot.check}` : ''}${data.mediaRoot.reason ? `: ${data.mediaRoot.reason}` : '.'}`}</Typography>
          <Typography variant="body2" color="text.secondary" sx={{ mt: 1 }}>{data.mediaRoot.note}</Typography>
          <Box component="form" onSubmit={saveMediaRoot} sx={{ ...rows, mt: 2 }}>
            <TextField size="small" label="Media root path" autoComplete="off" sx={{ minWidth: 260, '& input': { wordBreak: 'break-all' } }} value={draftRoot ?? ''} onChange={event => setDraftRoot(event.target.value)} />
            <Button type="submit" variant="contained" disabled={operation.busy || typeof actions?.editMediaRoot !== 'function'}>Save media root</Button>
          </Box>
        </>}
    </CardContent></Card>
    </div>
    <div role="tabpanel" id="owner-tabpanel-updates" aria-labelledby="owner-tab-updates" hidden={tab !== 'updates'}>
    <Card sx={section}><CardContent><Typography variant="h6" gutterBottom>Updates</Typography>
      <Typography variant="body2" color="text.secondary" sx={{ mb: 1 }}>Updates are owner-initiated only — this hub never fetches, downloads, or applies a release on its own.</Typography>
      {!available(data, 'update') || !data.update ? <Typography color="text.secondary">Release status is not available from this hub.</Typography>
        : (() => {
          const card = updateCardModel(data.update);
          return <>
            {card.lines.map((line, index) => <Typography key={index}>{line}</Typography>)}
            {card.note && <Typography color="text.secondary" sx={{ mt: 1 }}>{card.note}</Typography>}
            {card.state === 'newer' && <Box sx={{ mt: 2 }}>
              <Button variant="contained" disabled={updating || typeof actions?.applyUpdate !== 'function'} onClick={applyNewRelease}>Update now</Button>
              <Typography variant="body2" color="text.secondary" sx={{ mt: 1 }}>One owner action: the hub installs the release through npm and restarts itself, serving at the same address.</Typography>
            </Box>}
          </>;
        })()}
      {updateFeedback && <Alert severity={updateFeedback.severity} sx={{ mt: 2 }}>{updateFeedback.message}</Alert>}
    </CardContent></Card>
    </div>
    <div role="tabpanel" id="owner-tabpanel-activity" aria-labelledby="owner-tab-activity" hidden={tab !== 'activity'}>
    <RecentActivity audit={available(data, 'audit') ? data?.audit || [] : null} actions={actions} />
    </div>
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
    {/* Permanent deletion (PORCH-053 ac-4): owner-only, the consequence
        named in plain family language, and the typed member name as the
        second factor — the button stays dead until the name matches. */}
    <Dialog open={Boolean(purging)} onClose={() => { setPurging(null); setPurgeName(''); }} fullWidth maxWidth="xs">
      <DialogTitle>Delete {purging?.name || 'this member'} and their posts?</DialogTitle>
      <DialogContent>
        <Typography>This cannot be undone. Everything {purging?.name || 'this member'} put on {networkName(data)} is deleted for good — their posts, their photos and videos, and every comment they wrote, on every post in the network. Their membership and their devices are removed too.</Typography>
        <Typography sx={{ mt: 1 }}>Type their name to confirm: {purging?.name || purging?.did || ''}</Typography>
        <TextField size="small" fullWidth sx={{ mt: 2 }} autoComplete="off" label="Member's name" value={purgeName} onChange={event => setPurgeName(event.target.value)} />
        <Feedback operation={operation} />
      </DialogContent>
      <DialogActions>
        <Button onClick={() => { setPurging(null); setPurgeName(''); }}>Keep member</Button>
        <Button color="error" variant="contained" disabled={operation.busy || !purging || purgeName.trim().toLowerCase() !== String(purging.name || purging.did || '').trim().toLowerCase()} onClick={async () => {
          if (await operation.run('purgeMember', [purging, purgeName], 'Member and posts deleted.')) { setPurging(null); setPurgeName(''); }
        }}>Delete for good</Button>
      </DialogActions>
    </Dialog>
    <Dialog open={inviteOpen} onClose={() => { setInviteOpen(false); setIssued(''); }} fullWidth maxWidth="xs">
      <DialogTitle>Make a join link</DialogTitle>
      <DialogContent>{!issued ? <Typography>
          One link, one new member of {networkName(data)}. You send it to the family member joining — it is never for you: you became a member when you created the network. Anyone holding the link becomes a member; you can withdraw it at any time.
      </Typography>
      : <>
          <Typography gutterBottom>Send this link to the family member joining {networkName(data)}:</Typography>
          <Typography sx={{ wordBreak: 'break-all' }}>{issued}</Typography>
      </>}</DialogContent>
      <DialogActions>
        <Button onClick={() => { setInviteOpen(false); setIssued(''); }}>{issued ? 'Done' : 'Cancel'}</Button>
        {!issued && <Button variant="contained" disabled={operation.busy} onClick={makeJoinLink}>Make the link</Button>}
      </DialogActions>
    </Dialog>
  </Box>;
}

// PORCH-029: the member directory and invite management, a first-class
// surface inside the network — reachable from Profile (the bottom-tab /
// top-nav destination), so the owner never needs a console URL. The
// directory renders every current member with name, role, and join status;
// invite issuance rides the join-link lifecycle the console already owns
// (unused / used / revoked, single use, instant revocation).
export function Members({ data, actions, navigate }) {
  const operation = useOperation(actions);
  const [inviteOpen, setInviteOpen] = useState(false);
  const [issued, setIssued] = useState('');
  const members = available(data, 'members') ? data?.members || [] : null;
  const invites = available(data, 'invites') ? data?.invites || [] : null;
  const directory = members === null ? null : directoryRows(members, data?.identity?.id);
  const links = invites === null ? null : inviteRows(invites, data?.server?.url);
  async function makeJoinLink() {
    const result = await operation.run('issueInvite');
    if (!result) return;
    const link = invitationUrl(result.invite, data);
    if (!link) { operation.setError('The hub returned no shareable invitation.'); return; }
    setIssued(link);
  }
  async function copy(text) {
    const ok = await copyLink(text);
    if (ok) operation.setNotice('Link copied.');
    else operation.setError('The link could not be copied automatically. Select it here and copy it yourself.');
    return ok;
  }
  return <Box>
    <Heading title="Members" subtitle={`Everyone who belongs to ${networkName(data)}.`} />
    <Card sx={section}><CardContent>
      <Typography variant="h6" gutterBottom>The family</Typography>
      {directory === null ? <Typography color="text.secondary">The member directory is not available from this hub.</Typography>
        : directory.length === 0 ? <Typography color="text.secondary">No members to show yet. Invite a family member below.</Typography>
          : <List dense>{directory.map(person => <ListItem key={person.id} divider sx={{ minHeight: 56 }}>
            <ListItemAvatar><Avatar sx={{ width: 36, height: 36 }}>{person.name.charAt(0).toUpperCase()}</Avatar></ListItemAvatar>
            <ListItemText primary={person.isSelf ? `${person.name} (you)` : person.name}
              secondary={[person.role, person.status, person.joined && `Joined ${displayDate(person.joined)}`].filter(Boolean).join(' · ')} />
          </ListItem>)}</List>}
    </CardContent></Card>
    <Card sx={section}><CardContent>
      <Typography variant="h6" gutterBottom>Invitations</Typography>
      <Typography color="text.secondary" sx={{ mb: 2 }}>A join link works once and only for the family member you send it to. Withdraw any link that has not been opened yet.</Typography>
      <Stack sx={rows}>
        {links === null ? <Typography color="text.secondary">Invitation status is not available from this hub.</Typography>
          : <Button variant="contained" disabled={operation.busy || typeof actions?.issueInvite !== 'function'} onClick={() => { setIssued(''); setInviteOpen(true); }}>Invite a family member</Button>}
      </Stack>
      <Feedback operation={operation} />
      {links !== null && links.length ? <List dense sx={{ mt: 2 }}>{links.map(item => <ListItem key={item.id} divider sx={{ gap: 1, flexWrap: 'wrap' }}>
        <ListItemText primary={item.url || 'Invitation'} sx={{ wordBreak: 'break-all' }} secondary={`Status: ${item.status}`} />
        {item.url && <Button size="small" disabled={operation.busy} onClick={() => copy(item.url)}>Copy</Button>}
        {item.status === 'unused' && typeof actions?.revokeInvite === 'function' && <Button color="error" size="small" disabled={operation.busy} onClick={() => operation.run('revokeInvite', [item.id], 'Invitation withdrawn.')}>Revoke</Button>}
      </ListItem>)}</List>
        : links !== null && <Typography color="text.secondary" sx={{ mt: 2 }}>No invitations have been issued yet.</Typography>}
    </CardContent></Card>
    <Dialog open={inviteOpen} onClose={() => { setInviteOpen(false); setIssued(''); }} fullWidth maxWidth="xs">
      <DialogTitle>Make a join link</DialogTitle>
      <DialogContent>{!issued ? <Typography>{inviteDialogCopy(networkName(data))}</Typography>
        : <>
          <Typography gutterBottom>Send this link to the family member joining {networkName(data)}:</Typography>
          <Typography sx={{ wordBreak: 'break-all' }}>{issued}</Typography>
        </>}</DialogContent>
      <DialogActions>
        <Button onClick={() => copy(issued)} disabled={!issued}>Copy</Button>
        <Button onClick={() => { setInviteOpen(false); setIssued(''); }}>{issued ? 'Done' : 'Cancel'}</Button>
        {!issued && <Button variant="contained" disabled={operation.busy} onClick={makeJoinLink}>Make the link</Button>}
      </DialogActions>
    </Dialog>
    <Box sx={{ mt: 3 }}><Button onClick={() => navigate?.('/profile')}>Back to profile</Button></Box>
  </Box>;
}
