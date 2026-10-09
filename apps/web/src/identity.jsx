import React, { useState } from 'react';
import {
  Alert, Box, Button, Card, CardContent, Collapse, Dialog, DialogActions,
  DialogContent, DialogTitle, Divider, List, ListItem, ListItemText,
  Paper, Stack, TextField, Typography,
} from '@mui/material';

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

export function Join({ data, actions, navigate }) {
  const [url, setUrl] = useState(data?.connections?.[0]?.url || window.location.origin);
  const [code, setCode] = useState(() => {
    try { return window.location.pathname.startsWith('/join/') ? decodeURIComponent(window.location.pathname.slice(6)) : ''; }
    catch { return ''; }
  });
  const operation = useOperation(actions);
  async function submit(event) {
    event.preventDefault();
    const result = await operation.run('join', [{ url: url.trim(), code: code.trim() }]);
    if (result?.connected === true) navigate?.('/timeline');
  }
  return <Box sx={{ maxWidth: 540, mx: 'auto' }}>
    <Heading title="Join a network" subtitle="Enter the network address and invitation code to connect. The hub will tell you if another step is needed." />
    <Paper sx={{ p: { xs: 2, sm: 3 } }}><form onSubmit={submit}><Stack spacing={2}>
      <TextField label="Network URL" type="url" value={url} onChange={event => setUrl(event.target.value)} required fullWidth autoComplete="url" />
      <TextField label="Invite code" value={code} onChange={event => setCode(event.target.value)} required fullWidth autoComplete="off" />
      <Feedback operation={operation} />
      <Button type="submit" variant="contained" disabled={operation.busy}>Connect</Button>
    </Stack></form></Paper>
  </Box>;
}

export function Pair({ data, actions, navigate }) {
  const [code, setCode] = useState('');
  const operation = useOperation(actions);
  async function submit(event) {
    event.preventDefault();
    const result = await operation.run('pair', [code.trim()]);
    if (result) navigate?.('/profile');
  }
  return <Box sx={{ maxWidth: 540, mx: 'auto' }}>
    <Heading title="Connect a new device" subtitle={`On a device already connected to ${networkName(data)}, open Profile and approve making a pairing code. Enter that code here.`} />
    <Paper sx={{ p: 3 }}><form onSubmit={submit}><Stack spacing={2}>
      <TextField label="Pairing code" value={code} onChange={event => setCode(event.target.value)} required autoComplete="off" fullWidth />
      <Typography variant="body2" color="text.secondary">When this code is used, the hub connects your identity on the new device immediately. Network membership may still need to be completed. Check the device list on the original device and remove anything unfamiliar; there is no separate approval after pairing.</Typography>
      <Feedback operation={operation} />
      <Button variant="contained" type="submit" disabled={operation.busy}>Connect this device</Button>
      <Button onClick={() => navigate?.('/device-link')}>Use a device link instead</Button>
    </Stack></form></Paper>
  </Box>;
}

export function DeviceLink({ data, actions, navigate }) {
  const [grant, setGrant] = useState('');
  const operation = useOperation(actions);
  async function submit(event) {
    event.preventDefault();
    const result = await operation.run('linkDevice', [grant.trim()]);
    if (result) navigate?.('/profile');
  }
  return <Box sx={{ maxWidth: 540, mx: 'auto' }}>
    <Heading title="Connect your device" subtitle={`Enter a device link for your existing identity on ${networkName(data)}. This does not create a new identity.`} />
    <Paper sx={{ p: 3 }}><form onSubmit={submit}><Stack spacing={2}>
      <TextField label="Device link" value={grant} onChange={event => setGrant(event.target.value)} required autoComplete="off" fullWidth />
      <Typography variant="body2" color="text.secondary">The hub connects your identity on this device as soon as a valid link is used. Network membership may still need to be completed. Separate approval on the original device is not available here.</Typography>
      <Feedback operation={operation} />
      <Button type="submit" variant="contained" disabled={operation.busy}>Connect this device</Button>
      <Button onClick={() => navigate?.('/pair')}>Use a pairing code instead</Button>
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
  const [draftLimits, setLimits] = useState(null);
  const members = available(data, 'members') ? data?.members || [] : null;
  const invites = available(data, 'invites') ? data?.invites || [] : null;
  const audit = available(data, 'audit') ? data?.audit || [] : null;
  const disk = available(data, 'disk') ? data?.disk : null;
  const settings = available(data, 'settings') ? data?.settings : null;
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
        : members.length ? <List dense>{members.map(person => <ListItem key={idOf(person)} divider sx={{ gap: 1, flexWrap: 'wrap' }}>
          <ListItemText primary={person.name || person.did || 'Member'} secondary={[person.role, person.state, person.admittedAt && `Joined ${displayDate(person.admittedAt)}`, person.revokedAt && `Removed ${displayDate(person.revokedAt)}`].filter(Boolean).join(' · ')} />
          {person.state === 'active' && person.did !== data?.identity?.id && typeof actions?.revokeMember === 'function' && <Button color="error" size="small" onClick={() => setRemoving(person)}>Remove access</Button>}
        </ListItem>)}</List> : <Typography color="text.secondary">No members to show.</Typography>}
    </CardContent></Card>
    <Card sx={section}><CardContent><Typography variant="h6" gutterBottom>Your devices</Typography>
      <Typography color="text.secondary" sx={{ mb: 1 }}>This list only shows registrations for your identity. This hub has no owner-wide device list or separate approval after a device connects.</Typography>
      <DeviceList devices={available(data, 'devices') ? data?.devices || [] : null} operation={operation} actions={actions} currentDeviceId={localRegistration(data, data?.identity)?.deviceId} />
      <Typography variant="body2" color="text.secondary" sx={{ mt: 2 }}>Making a device link for another member is not available from this hub. Members can approve a pairing code on an existing device.</Typography>
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
    <Dialog open={Boolean(removing)} onClose={() => setRemoving(null)} fullWidth maxWidth="xs"><DialogTitle>Remove member access?</DialogTitle>
      <DialogContent><Typography>This ends {removing?.did || 'this member'}'s membership on {networkName(data)}. It does not remove their identity or their posts.</Typography></DialogContent>
      <DialogActions><Button onClick={() => setRemoving(null)}>Keep member</Button><Button color="error" disabled={operation.busy} onClick={async () => {
        if (await operation.run('revokeMember', [removing], 'Membership removed.')) setRemoving(null);
      }}>Remove access</Button></DialogActions>
    </Dialog>
  </Box>;
}
