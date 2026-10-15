// The member's notification control room (PORCH-060): the Notifications
// card in member settings. MUI primitives under the Porchlight theme; the
// state is hub-authoritative (the server's settings row, read back fresh
// after every save) rendered with optimistic updates and rolled back on
// failure; the capability truth table and the Enable flow ride the pure
// module (notifications.js); no badge machinery exists anywhere (push
// only, Brian Oct 10, 2026).
import React, { useEffect, useState } from "react";
import {
  Alert, Button, Card, CardContent, List, ListItem, ListItemText, Stack,
  Switch, Typography,
} from "@mui/material";
import IosShareOutlined from "@mui/icons-material/IosShareOutlined";
import { webkitClass } from "./install.js";
import {
  CAPABILITY_LINES,
  EVENT_ROWS,
  HANDOFF_LINE,
  OWNER_EVENT_KEYS,
  OWNER_EVENT_LABEL,
  muteRows,
  normalizeSettings,
  notificationCapability,
  notificationSection,
  reenableGuidance,
  receivesOwnerEvents,
  withEvent,
  withMaster,
  withMute,
  withOwnerEvents,
} from "./notifications.js";
import { viewerRole } from "./member-directory.js";

const cardSx = { border: "1px solid", borderColor: "divider", borderRadius: "14px", mb: 3 };

/** The device's own capability facts, read fresh when the card opens:
 * PushManager presence and existing permission read here; the home-screen
 * display mode arrives pre-computed from the app shell (data.standalone);
 * the WebKit engine fact is the engine token — never user-agent device
 * strings. No screen file branches on display mode (the mode-system
 * guardrail), so the display-mode fact is injected. */
function detectCapability(data) {
  return notificationCapability({
    pushCapable: typeof window.PushManager === "function",
    standalone: Boolean(data?.standalone),
    webkit: webkitClass(window.navigator.userAgent),
    permission: typeof window.Notification === "function" ? window.Notification.permission : null,
  });
}

export function NotificationSettings({ data, actions }) {
  const identity = data?.identity;
  const role = viewerRole(data);
  // The open identity's networks (ac-5): the screen shows and edits the
  // open identity's settings only; WhoIsHere governs who is speaking.
  const identityConnections = (data?.connections || []).filter(
    (connection) => connection?.identity?.id === identity?.id && connection.networkId,
  );
  const mutes = muteRows(identityConnections);
  const capability = detectCapability(data);
  // Server state (never presented as anything but what the hub returned);
  // the optimistic draft replaces it in place and rolls back on failure.
  const [settings, setSettings] = useState(null);
  const [loadError, setLoadError] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  // This device's channel state: checking / on / off. `denied` carries the
  // browser permission verdict the toggle mirrors (ac-3).
  const [deviceOn, setDeviceOn] = useState(false);
  const [denied, setDenied] = useState(false);
  // The iOS-not-installed handoff (ac-4) rides the install flow's own
  // dismissal suppression — the established window, the established key.
  const [handoffHidden, setHandoffHidden] = useState(
    () => (typeof actions?.notificationsHandoffDismissed === "function" ? actions.notificationsHandoffDismissed() : false),
  );

  const loadable = typeof actions?.loadNotificationSettings === "function" && typeof actions?.saveNotificationSettings === "function";
  useEffect(() => {
    if (!loadable || !identity?.id) return undefined;
    let stale = false;
    setError("");
    setLoadError("");
    void (async () => {
      try {
        const result = await actions.loadNotificationSettings();
        if (!stale) setSettings(normalizeSettings(result?.settings ?? null));
      } catch {
        if (!stale) setLoadError("The hub could not load your notification settings. Try again later.");
      }
    })();
    return () => { stale = true; };
  }, [loadable, identity?.id]);

  useEffect(() => {
    // The real permission is the source of truth (ac-3): with it ALREADY
    // granted AND the open identity's persisted row enabled, this silent
    // re-registration never prompts and renews the subscription hub-side
    // (PORCH-059 replace contract) — the opt-in contract rides the
    // persisted row (PORCH-063): the quiet re-subscribe runs ONLY for
    // enabled identities, and an off-state identity holds no subscription.
    // A promptable (default) permission or an off row stays silent here:
    // the browser prompt fires only from the explicit off-to-on tap below
    // — never at page load and never on navigation.
    if (!capability.canPush || typeof actions?.enableNotifications !== "function") {
      setDeviceOn(false);
      return undefined;
    }
    if (capability.permission === "denied") { setDenied(true); setDeviceOn(false); return undefined; }
    if (capability.permission !== "granted") { setDeviceOn(false); return undefined; }
    if (settings?.enabled !== true) { setDeviceOn(false); return undefined; }
    let stale = false;
    void (async () => {
      try {
        await actions.enableNotifications();
        if (!stale) { setDeviceOn(true); setDenied(false); }
      } catch {
        if (!stale) setDeviceOn(false);
      }
    })();
    return () => { stale = true; };
  }, [capability.state, capability.permission, settings?.enabled]);

  /** Optimistic write with rollback (ac-2): the next settings object takes
   * the screen immediately, the hub-side write lands through the open
   * identity's authenticated session, the authoritative server row is
   * rendered back on success, and a failure restores the previous
   * server-backed values verbatim with the failure named. No local-only
   * state ever pretends to be delivered state. */
  async function saveOptimistic(next) {
    const previous = settings;
    setSettings(next);
    setBusy(true);
    try {
      const result = await actions.saveNotificationSettings(next);
      const row = normalizeSettings(result?.settings ?? next);
      setSettings(row);
      return row;
    } catch (cause) {
      setSettings(previous ?? normalizeSettings(null));
      setError(cause?.message ? `The hub could not save this change: ${cause.message}` : "The hub could not save this change. It is back the way it was.");
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function toggleMaster(checked) {
    setError("");
    const previousSettings = settings ?? normalizeSettings(null);
    if (!checked) {
      // The off path is a plain settings write — no permission call ever
      // runs on the way off: the hub expires this identity's stored
      // subscriptions at the same write (an off-state identity holds no
      // subscription anywhere), and the section collapses (ac-3).
      setDeviceOn(false);
      await saveOptimistic(withMaster(previousSettings, false));
      return;
    }
    if (deviceOn) {
      // Already live on this device: a plain settings write.
      await saveOptimistic(withMaster(previousSettings, true));
      return;
    }
    // The walked enable flow (ac-2): the off-to-on tap IS the only prompt
    // path. The hub's registration gate accepts only enabled identities,
    // so the off-to-on write persists enabled=true through the settings
    // route FIRST, then this same tap runs the prompt — pushManager
    // .subscribe fires from here and nowhere else, never at load and
    // never on navigation.
    setBusy(true);
    try {
      const saved = await actions.saveNotificationSettings(withMaster(previousSettings, true));
      const persisted = normalizeSettings(saved?.settings ?? null);
      setSettings(persisted);
      if (!persisted.enabled) throw new Error("The hub could not turn notifications on.");
      await actions.enableNotifications();
      setDeviceOn(true);
      setDenied(false);
      // The authoritative row is the hub's state after the walked flow.
      const settled = await actions.loadNotificationSettings();
      setSettings(normalizeSettings(settled?.settings ?? persisted));
    } catch (cause) {
      // The walked flow never leaves an enabled row behind a failed
      // prompt: the revert write restores enabled=false through the
      // route — which also expires any subscription the enable attempt
      // registered — and enabled stays false on denial.
      setSettings(previousSettings);
      setDeviceOn(false);
      try {
        await actions.saveNotificationSettings(withMaster(previousSettings, false));
      } catch {
        // The local rollback stands; the next authoritative load corrects.
      }
      const refused = cause && cause.name === "NotAllowedError";
      if (refused) setDenied(true);
      setError(refused ? reenableGuidance(capability.webkit) : (cause?.message || "The hub could not complete this action."));
    } finally {
      setBusy(false);
    }
  }

  async function toggleEvent(key, checked) {
    if (!settings) return;
    setError("");
    await saveOptimistic(withEvent(settings, key, checked));
  }
  async function toggleOwnerEvents(checked) {
    if (!settings) return;
    setError("");
    await saveOptimistic(withOwnerEvents(settings, checked));
  }
  /** The mute row toggle convention (PORCH-087): switch ON = receiving, so
   * the checked state carries the receiving meaning and the mute flag is
   * its inverse — checked off writes the mute, checked on removes it. The
   * persisted mute flag itself is untouched (the hub-side semantics carry). */
  async function toggleMute(networkId, receiving) {
    if (!settings) return;
    setError("");
    await saveOptimistic(withMute(settings, networkId, !receiving));
  }

  // Control availability (ac-4): the toggles work only where push can
  // actually arrive; every other state names its reason instead of
  // rendering a switch that pretends.
  const canEdit = capability.canPush && !denied;
  const disabled = !canEdit || busy;
  // The section state machine (PORCH-063 ac-3): expanded only with the
  // master switch on AND this device's permission granted; every other
  // pairing collapses to the master row plus its one-line explainer —
  // zero per-event toggles, zero mute rows.
  const expanded = notificationSection({ enabled: Boolean(settings?.enabled), granted: deviceOn }) === "expanded";
  const switchValue = settings ? Boolean(settings.enabled) : false;
  // The toggle mirrors the real permission (ac-3): the switch reads on
  // only while this device's channel is live; denied or undetermined
  // permission renders off — never a dead switch pretending.
  const masterShown = !denied && deviceOn && switchValue;
  const stateLine = CAPABILITY_LINES[capability.state] || "";
  const statusLine = !capability.canPush
    ? stateLine
    : denied
      ? reenableGuidance(capability.webkit)
      : deviceOn
        ? "On for this device. The hub sends family moments to this device."
        : "Turn on to receive family moments on this device.";
  const rowLabel = "Device notifications";

  return <Card sx={cardSx} data-testid="notification-settings">
    <CardContent>
      <Typography variant="h6" gutterBottom>Notifications</Typography>
      <Typography variant="body2" color="text.secondary">
        {`Choose which family moments reach ${identity?.name || "you"} on this device. These choices belong to this person, on the hub.`}
      </Typography>
      {loadError && <Alert severity="info" sx={{ mt: 2 }}>{loadError}</Alert>}
      {settings && <List disablePadding sx={{ mt: 1 }}>
        <ListItem divider secondaryAction={
          <Switch checked={masterShown} disabled={!canEdit || busy} slotProps={{ input: { "aria-label": rowLabel } }}
            onChange={(event) => void toggleMaster(event.target.checked)} />
        }>
          <ListItemText primary={rowLabel} primaryTypographyProps={{ fontWeight: 600 }} secondary={statusLine} />
        </ListItem>
        {expanded && EVENT_ROWS.map(({ key, label }) => <ListItem key={key} divider secondaryAction={
          <Switch checked={Boolean(settings.events?.[key])} disabled={disabled} slotProps={{ input: { "aria-label": label } }}
            onChange={(event) => void toggleEvent(key, event.target.checked)} />
        }><ListItemText primary={label} secondary={key === "groupPost" ? "Posts in your groups also reach you as notifications." : null} /></ListItem>)}
        {expanded && receivesOwnerEvents(role) && <ListItem divider secondaryAction={
          <Switch checked={OWNER_EVENT_KEYS.every((key) => Boolean(settings.events?.[key]))} disabled={disabled}
            slotProps={{ input: { "aria-label": OWNER_EVENT_LABEL } }}
            onChange={(event) => void toggleOwnerEvents(event.target.checked)} />
        }><ListItemText primary={OWNER_EVENT_LABEL} secondary="New members and new device connections for this network." /></ListItem>}
        {expanded && mutes.map((row) => <ListItem key={row.networkId} divider secondaryAction={
          // The toggled value is the receiving state (PORCH-087): ON renders
          // with the receiving line, OFF with the quiet line — never a state
          // opposite its switch position.
          <Switch checked={!settings.mutes?.includes(row.networkId)} disabled={disabled}
            slotProps={{ input: { "aria-label": `${row.name} notifications` } }}
            onChange={(event) => void toggleMute(row.networkId, event.target.checked)} />
        }><ListItemText primary={row.name} secondary={settings.mutes?.includes(row.networkId) ? "Quiet: this network's notifications are paused." : "This network's moments reach you as usual."} /></ListItem>)}
      </List>}
      {capability.state === "ios-not-installed" && !handoffHidden && (
        <Alert severity="info" sx={{ mt: 2 }} icon={<IosShareOutlined sx={{ color: "var(--porch-amber)" }} />}
          action={typeof actions?.dismissNotificationsHandoff === "function"
            ? <Button color="inherit" size="small" onClick={() => { actions.dismissNotificationsHandoff(); setHandoffHidden(true); }}>Not now</Button>
            : undefined}
          data-testid="install-handoff">
          <Typography variant="body2">{HANDOFF_LINE}</Typography>
        </Alert>
      )}
      {error && <Alert severity="error" sx={{ mt: 2 }}>{error}</Alert>}
    </CardContent>
  </Card>;
}