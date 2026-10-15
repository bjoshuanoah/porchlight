import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { ThemeProvider } from "@mui/material/styles";
import { AppBar, Alert, BottomNavigation, BottomNavigationAction, Button, Container, CssBaseline, Dialog, DialogActions, DialogContent, DialogTitle, IconButton, Paper, Snackbar, Stack, Toolbar, Typography } from "@mui/material";
import HomeOutlined from "@mui/icons-material/HomeOutlined";
import GroupsOutlined from "@mui/icons-material/GroupsOutlined";
import AddOutlined from "@mui/icons-material/AddOutlined";
import PersonOutline from "@mui/icons-material/PersonOutline";
import { themeFor, tokenStyles, lightTokens, darkTokens } from "./theme.js";
import { readStoredMode, writeStoredMode, resolveMode } from "./mode.js";
// PORCH-055: the signed-out marker and boot routing for the device front state.
import { bootRoute, readSignedOut, markSignedOut, clearSignedOut } from "./front-state.js";
import { fullName } from "./setup-state.js";
import { request, loadFeeds, setUnauthorizedHandler, connectionForPostOrigin, markUnreachable } from "./api.js";
import { cachedTimeline, hiddenPosts, hidePost, connectionsStorageKey, readConnections, readLocal, saveConnections, saveTimeline, unhidePost, writeLocal } from "./store.js";
import { createCustody } from "./session-sync.js";
import { reCredentialPlanes, mergeSessionAdoptions } from "./session-credentials.js";
import { createDeviceRegistration, openDeviceSession, getDeviceKey, getDeviceJwk, signDeviceMessage, signDevicePayload } from "./device.js";
import { sha256Hex } from "./device-crypto.js";
import { resolveStoredNames } from "./name-heal.js";
import { publishPost, publishReply, publishReaction, unpublishReaction, publishVote, uploadOriginals, exportOriginals, mentionCandidates as fetchMentionCandidates, resolvePreview } from "./member-actions.js";
import { firstUrlIn } from "./link-preview.js";
import { waitUntilHubHealthy } from "./update.js";
import { applyEvent, readEventCursor, saveEventCursor, catchUpSince } from "./live.js";
import { openEventStream } from "./realtime.js";
import { applyFeedCompensation, captureFeedAnchor, createScrollMemory } from "./scroll.js";
import { registerMediaTransport, syncMediaTransport, workerRegistration } from "./media-transport.js";
import { Timeline, Groups, PostDetail, Compose, Albums, Uploads, Search } from "./social.jsx";
import { Join, Settings, Pair, DeviceLink, WhoIsHere, OwnerConsole, Members, Setup, UserSwitcher, hasLocalPin, AUDIT_PAGE } from "./identity.jsx";
import { Lockup } from "./brand.jsx";
// PORCH-051: the Add to Home Screen machinery — the decision logic module
// and its two surfaces (the Android custom CTA, the iOS guided card).
import { consumeInstallPrompt, installSuppressed, isStandaloneLaunch, surfaceInstallKind, webkitClass } from "./install.js";
import { InstallCta } from "./install.jsx";
// PORCH-060: the notification settings card rides the Profile settings
// shell; the push subscription flow (explicit Enable tap → VAPID-scoped
// subscribe → hub-side registration) rides the pure module's injected flow.
import { enablePush } from "./notifications.js";

// PORCH-042: both modes' custom properties land in one static <style> block
// before the first render — component CSS resolves from the token layer with
// no screen-level mode branch, and a mode switch needs no CSS rewrite.
document.head.appendChild(Object.assign(document.createElement("style"), { textContent: tokenStyles() }));

const origin = window.location.origin;
const stored = window.localStorage;
// Cross-tab token custody (PORCH-028): renewals publish through localStorage
// and 401s adopt the published set instead of racing a superseded token.
const custody = createCustody({ storage: stored, origin });
setUnauthorizedHandler(({ connection, error }) => custody.recover({ connection, error }));
// Token sets younger than half the renewal window live well inside the
// 10-minute access TTL, so no tab needs to supersede a sibling's fresh
// publication.
const renewFreshMs = 6 * 60 * 1000;
const initialConnections = readConnections(stored, origin);
// PORCH-074: the installed-app fact the boot route reads. The display-mode
// listener keeps the live state fresh for the install and notification
// surfaces; the boot route only ever needs the launch-time fact, resolved
// the same capability-first way (no user-agent sniffing).
const standaloneBoot = isStandaloneLaunch({
  navigatorStandalone: window.navigator.standalone,
  standaloneQuery: window.matchMedia("(display-mode: standalone)").matches,
});
const localIdentities = [...new Set(initialConnections.map((item) => item.identity?.id).filter(Boolean))];
const primary = ["/timeline", "/groups", "/compose", "/settings"];
const labels = ["Timeline", "Groups", "Compose", "Settings"];
const icons = [<HomeOutlined />, <GroupsOutlined />, <AddOutlined />, <PersonOutline />];

function routeOf() {
  const next = bootRoute({
    pathname: window.location.pathname,
    search: window.location.search,
    connections: initialConnections,
    signedOut: readSignedOut(stored, origin),
    pinned: initialConnections.some(hasLocalPin),
    standalone: standaloneBoot,
  });
  // PORCH-076: the Settings rename sweep — a /profile deep link lands on the
  // renamed destination; the label and route of record is Settings.
  return next === "/profile" ? "/settings" : next;
}
function App() {
  const [route, setRoute] = useState(routeOf);
  // PORCH-042: mode is a device-level display setting held in this origin's
  // browser-local storage (never a server write); System follows the device's
  // prefers-color-scheme live, so the resolved mode re-renders in place —
  // the switch is one paint frame, never a reload.
  const [modePref, setModePref] = useState(() => readStoredMode(stored));
  const [systemDark, setSystemDark] = useState(() => window.matchMedia("(prefers-color-scheme: dark)").matches);
  const displayMode = resolveMode(modePref, systemDark);
  const muiTheme = themeFor(displayMode);
  useEffect(() => {
    const query = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = (event) => setSystemDark(event.matches);
    query.addEventListener("change", onChange);
    return () => query.removeEventListener("change", onChange);
  }, []);
  useEffect(() => {
    // Sync the pre-paint state (html[data-theme], the pre-paint background,
    // theme-color meta) with the running app after every resolved change.
    const page = displayMode === "dark" ? darkTokens.page : lightTokens.page;
    document.documentElement.dataset.theme = displayMode;
    document.documentElement.style.backgroundColor = page;
    document.querySelector('meta[name="theme-color"]')?.setAttribute("content", page);
  }, [displayMode]);
  const [connections, setConnections] = useState(initialConnections);
  const [posts, setPosts] = useState(() => localIdentities.length === 1 && !initialConnections.some(hasLocalPin) ? cachedTimeline(stored, `${origin}:${localIdentities[0]}`) : []);
  // The river's live mirror (PORCH-081): socket arrivals merge against this
  // ref so an event never re-renders a view it does not touch — a no-op
  // arrival (media.attached, a deduped replay) touches no state at all.
  const postsRef = useRef(posts);
  const [hidden, setHidden] = useState(() => localIdentities.length === 1 ? hiddenPosts(stored, `${origin}:${localIdentities[0]}`) : new Set());
  const [offline, setOffline] = useState(false);
  // PORCH-081 ac-4: a catch-up replay older than the hub's retained window
  // reads `stale` server-side; the REST catch-up note is a rendered state,
  // never a silent skip — and never a returning poll cycle.
  const [behind, setBehind] = useState(false);
  // PORCH-050 ac-4: a genuinely dead credential (401 after recovery tried) is
  // NOT an unreachable hub — it names its own state and recovery route
  // instead of masquerading as an outage while the polls keep failing.
  const [membershipEnded, setMembershipEnded] = useState(false);
  const membershipEndedRef = useRef(false);
  const identityEndedRef = useRef(false);
  const [notice, setNotice] = useState("");
  const [composeOpen, setComposeOpen] = useState(false);
  // PORCH-051: the Add to Home Screen machinery. The captured
  // beforeinstallprompt is stored, never discarded; the dismissal window and
  // the standalone launch check ride this origin's browser-local storage
  // and display-mode capability — never a server write.
  const [installPrompt, setInstallPrompt] = useState(null);
  const [installDismissedAt, setInstallDismissedAt] = useState(() => readLocal(stored, origin, "install-dismissed-at", 0));
  const [standaloneLaunch, setStandaloneLaunch] = useState(() => isStandaloneLaunch({
    navigatorStandalone: window.navigator.standalone,
    standaloneQuery: window.matchMedia("(display-mode: standalone)").matches,
  }));
  const [identity, setIdentity] = useState(() => localIdentities.length === 1 && !initialConnections.some(hasLocalPin) ? initialConnections[0].identity || null : null);
  const [groups, setGroups] = useState([]);
  const [owner, setOwner] = useState({ members: [], invites: [], devices: [], allDevices: null, deviceLinks: null, settings: {}, audit: [], disk: null, update: null, mediaRoot: null, availability: {} });
  const [network, setNetwork] = useState(null);
  const [networkLoaded, setNetworkLoaded] = useState(false);
  // PORCH-070: the open identity's own account read (avatar rungs, legacy
  // profile photo). Held in React state so a commit or clear repaints the
  // face everywhere without a re-login; surfaces read it beside the other
  // own-account fields.
  const [identityAccount, setIdentityAccount] = useState(null);
  const [newDevices, setNewDevices] = useState([]);
  const active = identity ? connections.find((item) => item.identity?.id === identity.id) : null;
  const activeIdentityId = active?.identity?.id ?? null;
  const identityConnections = identity ? connections.filter((item) => item.identity?.id === identity.id && item.token) : [];
  const renewRef = useRef(null);
  const signedOut = useRef(false);
  useEffect(() => {
    custody.setRenew((args) => renewRef.current?.(args));
    // Recovered tokens must land in React state immediately: the next read
    // or socket handshake (tokens ride the realtime auth callback, read at
    // every handshake) presents the published one instead of 401ing into
    // recovery again (the wake-after-throttle case, no storage event).
    custody.setOnAdopt((live) => {
      if (!signedOut.current) setConnections(live);
    });
    return () => {
      custody.setRenew(null);
      custody.setOnAdopt(null);
    };
  }, []);
  useEffect(() => {
    const onStorage = (event) => {
      custody.notify(event);
      if (event.key !== connectionsStorageKey(origin)) return;
      // A sibling tab's renewal published here: adopt its token set in one
      // cycle, before any of our requests can present the superseded one.
      if (!signedOut.current) setConnections(readConnections(stored, origin));
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);
  const observeDevices = useCallback((rows, current) => {
    if (!current?.identity?.id) return;
    const field = `seen-devices:${current.identity.id}`;
    const previous = readLocal(stored, origin, field, null);
    const ids = rows.map((row) => row._id).filter(Boolean);
    if (previous) {
      const additions = rows.filter((row) => row.status === "active" && row.deviceId !== current.deviceId && !previous.includes(row._id));
      if (additions.length) setNewDevices((pending) => [...pending, ...additions.filter((row) => !pending.some((item) => item._id === row._id))]);
    }
    writeLocal(stored, origin, field, [...new Set([...(previous || []), ...ids])]);
  }, []);

  // Feed context preservation (PORCH-046 ac-3): leaving a route notes the
  // reading offset; returning to it — through navigation, Back, or the
  // conversation dismiss-and-return path — recalls the exact position.
  const scrollMemoryRef = useRef(createScrollMemory());
  const restoreScroll = useCallback((targetRoute) => {
    const saved = scrollMemoryRef.current.recall(targetRoute);
    if (saved !== null) {
      // Two frames: the first commit mounts the new surface; the second
      // scrolls once the feed's layout-reserved height exists again.
      requestAnimationFrame(() => requestAnimationFrame(() => window.scrollTo(0, saved)));
    } else window.scrollTo(0, 0);
  }, []);
  const navigate = useCallback((path) => {
    const next = path.startsWith("/") ? path : `/${path}`;
    if (next === "/compose") { setComposeOpen(true); return; }
    if (window.location.pathname !== next) scrollMemoryRef.current.note(window.location.pathname, window.scrollY);
    window.history.pushState({}, "", next);
    setRoute(next);
    restoreScroll(next);
  }, [restoreScroll]);
  useEffect(() => {
    const pop = () => {
      const next = routeOf();
      setRoute(next);
      restoreScroll(window.location.pathname);
    };
    window.addEventListener("popstate", pop);
    return () => window.removeEventListener("popstate", pop);
  }, [restoreScroll]);
  useEffect(() => {
    request({ url: origin }, "social/network").then((result) => setNetwork(result.network || null)).catch(() => {}).finally(() => setNetworkLoaded(true));
  }, []);
  // Silent renewal (PORCH-028): reads live storage, never a stale state
  // snapshot, and serializes through the per-origin renewal slot inside
  // custody.renew so two tabs can never race supersessions past each other.
  const renew = useCallback(async ({ did = null, force = false } = {}) => {
    const live = readConnections(stored, origin);
    const target = live.find((item) => item.identity?.id === (did || identity?.id));
    if (!target?.deviceId || !target.identity?.id) return false;
    // Cross-tab freshness gate: another tab's renewal younger than half the
    // gate window keeps every presented token inside the 10-minute TTL, so
    // skip the supersession and let that tab's publication ride adoption.
    // The gate guards only the tab-initiated renewal's TTL speculation
    // (interval, visibility wake). Recovery carries at-rest 401 evidence the
    // speculation cannot hold: its adopt pass already found no sibling
    // publication, so a presented-and-rejected stored token re-credentials
    // immediately — waiting out the gate was PORCH-061's dead social plane
    // (a superseded identity token unrecoverable for six minutes).
    if (!force && Date.now() - (target.renewedAt || 0) < renewFreshMs) return false;
    const next = { ...target };
    // PORCH-050: refresh first, restore on failure — a dead membership
    // credential re-credentials with the freshly minted identity token
    // instead of leaving `token` expired (and every recovery pass unstamping
    // renewedAt while the feed, devices poll, and renditions 401 in a loop).
    let membershipFailed = false;
    try {
      const { connection: reCredentialed, membershipFailed: failed } = await reCredentialPlanes(next, request, { openDeviceSession });
      Object.assign(next, reCredentialed);
      membershipFailed = failed;
    } catch {
      setOffline(true);
      return false;
    }
    next.renewedAt = membershipFailed ? undefined : Date.now();
    const revised = live.map((item) => item.identity?.id === target.identity.id ? next : item);
    saveConnections(stored, origin, revised);
    setConnections(revised);
    if (!membershipFailed) { setMembershipEnded(false); membershipEndedRef.current = false; identityEndedRef.current = false; }
    return true;
  }, [identity]);
  useEffect(() => { renewRef.current = renew; }, [renew]);
  useEffect(() => {
    if (!active?.identity?.id) return undefined;
    const timer = setInterval(() => void custody.renew(), 8 * 60 * 1000);
    const visible = () => { if (document.visibilityState === "visible") void custody.renew(); };
    document.addEventListener("visibilitychange", visible);
    return () => { clearInterval(timer); document.removeEventListener("visibilitychange", visible); };
  }, [active]);

  // Reads never ride a stale connections closure: renewal saves new tokens to
  // browser storage BEFORE state settles, so reads take the storage copy —
  // always exactly what the vault last issued.
  // Live arrival application (PORCH-046 ac-1): every feed apply — initial
  // load, member-write reconcile, or arrival refresh — captures the reading
  // anchor before the replace and compensates scrollTop exactly once after
  // the merge paints, so arriving content never repositions the reader.
  const applyFeeds = useCallback((result, { notice: noticeText } = {}) => {
    const before = captureFeedAnchor();
    // PORCH-050: a 401 that survives custody recovery is a genuinely dead
    // credential — its own honest state, never an "unreachable" claim. A
    // non-401 failure (fetch throw: hub unreachable, TLS, DNS) stays offline.
    const deadSession = result.failures.some((failure) => failure.status === 401);
    const unreachable = result.failures.some((failure) => failure.status !== 401);
    setOffline(unreachable);
    setMembershipEnded(deadSession);
    membershipEndedRef.current = deadSession;
    if (!result.failures.length) {
      // The one river replace (PORCH-081): full reads and hydrates ride
      // replacePosts so the live mirror (postsRef) never diverges from
      // state; socket arrivals merge against the mirror between reads.
      postsRef.current = result.posts;
      setPosts(result.posts);
      setBehind(false);
      saveTimeline(stored, `${origin}:${identity?.id}`, result.posts);
    } else if (noticeText && unreachable) setNotice(noticeText);
    if (before) {
      requestAnimationFrame(() => {
        applyFeedCompensation(before, captureFeedAnchor());
      });
    }
  }, [identity]);
  const reload = useCallback(async () => {
    if (!identity?.id) return;
    const live = readConnections(stored, origin);
    const liveActive = live.find((item) => item.identity?.id === identity.id) || null;
    if (!liveActive) return;
    const identityConnections = live.filter((item) => item.identity?.id === identity.id && item.token);
    const result = identityConnections.length ? await loadFeeds(identityConnections) : { posts: [], failures: [] };
    applyFeeds(result, { notice: "Your family server is unreachable. Showing saved moments where available." });
    const [groupResult, memberResult, inviteResult, limitResult, diskResult, auditResult, deviceResult, allDevicesResult, linksResult, updateResult, mediaRootResult, reauthResult] = await Promise.allSettled([
      // Member-plane groups (PORCH-030): the Groups page reads the group
      // containers the member's own token can read — creation is open to
      // every member, so an owner-gated console read would leave every
      // plain member an empty Groups page.
      request(liveActive, "social/groups"), request(liveActive, "social/console/members"),
      request(liveActive, "social/console/invites"), request(liveActive, "social/console/limits"),
      request(liveActive, "social/console/disk"), request(liveActive, "social/console/audit"),
      request({ ...liveActive, token: liveActive.identityToken }, "identity/devices"),
      request(liveActive, "social/console/devices"),
      request(liveActive, "social/console/device-links"),
      // Owner-initiated release check (PORCH-040): the registry is consulted
      // server-side ONLY because the owner opened the console's update card.
      request(liveActive, "social/console/update"),
      // Media-root setting (PORCH-054): the read behind the Storage tab's
      // media-root card (PORCH-057); the hub endpoint is unchanged, a
      // non-owner's 403 degrades to the availability flag like every other
      // console read.
      request(liveActive, "social/console/media-root"),
      // Address change (PORCH-066): the panel reads the same status surface
      // the CLI's reauth command reads (serving origin, last re-point);
      // owner-session guard server-side, availability flag on the client.
      request(liveActive, "reauth/status"),
    ]);
    const value = (result, fallback) => result.status === "fulfilled" ? result.value : fallback;
    setGroups(value(groupResult, {}).groups || []);
    setOwner({
      members: value(memberResult, {}).members || [], invites: value(inviteResult, {}).invites || [],
      settings: value(limitResult, {}), disk: value(diskResult, null),
      audit: value(auditResult, {}).events || [], devices: value(deviceResult, {}).registrations || [],
      allDevices: value(allDevicesResult, {}).devices || null,
      deviceLinks: value(linksResult, {}).deviceLinks || null,
      update: value(updateResult, null)?.release || null,
      mediaRoot: value(mediaRootResult, null),
      reauth: value(reauthResult, null),
      availability: {
        groups: groupResult.status === "fulfilled", members: memberResult.status === "fulfilled",
        invites: inviteResult.status === "fulfilled", settings: limitResult.status === "fulfilled",
        disk: diskResult.status === "fulfilled", audit: auditResult.status === "fulfilled",
        devices: deviceResult.status === "fulfilled",
        allDevices: allDevicesResult.status === "fulfilled", deviceLinks: linksResult.status === "fulfilled",
        update: updateResult.status === "fulfilled", mediaRoot: mediaRootResult.status === "fulfilled",
        reauth: reauthResult.status === "fulfilled",
      },
    });
    if (deviceResult.status === "fulfilled") observeDevices(deviceResult.value.registrations || [], liveActive);
  }, [identity, observeDevices, applyFeeds]);
  useEffect(() => {
    // First load waits for the silent renewal: an expired access token must
    // re-credential BEFORE reads, or the page would render failure states.
    // PORCH-050 ac-3: this effect keys on the active identity's ID, not the
    // connections object — a token renewal adopts fresh credentials in state
    // without re-running a full feed reload, so a renewal cannot cadence the
    // timeline into a loading loop.
    void (async () => {
      if (active?.identity?.id && !signedOut.current) {
        try { await custody.renew(); } catch { /* renew sets offline state itself */ }
      }
      await reload();
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reload, activeIdentityId, renew]);
  useEffect(() => {
    const online = () => void reload();
    window.addEventListener("online", online);
    return () => window.removeEventListener("online", online);
  }, [reload]);
  // Live consumption (PORCH-081 ac-1): the socket feed replaces the deleted
  // fixed-interval degrade cadence. One app-scope subscription per live
  // origin connection of the open identity — websocket-only transport with
  // backoff reconnection, the current credential read at every handshake.
  // Arrivals merge in place through the cached river (postsRef); the
  // reading anchor compensates once post-paint (PORCH-046). Every
  // successful (re)connect resolves the stored per-origin cursor's delta
  // against the catch-up endpoint (ac-4) — no polling cycle exists on this
  // path, and a no-op arrival re-renders nothing (ac-2).
  const mergeArrival = useCallback((envelope, connection) => {
    if (membershipEndedRef.current) return;
    let eventUrl = null;
    try { eventUrl = new URL(connection.url).origin; } catch { return; }
    const context = { origin: eventUrl, network: connection.name || eventUrl, log: console };
    const before = captureFeedAnchor();
    const merged = applyEvent(postsRef.current, envelope, context);
    if (merged === postsRef.current) return;
    postsRef.current = merged;
    setPosts(merged);
    if (identity?.id) saveTimeline(stored, `${origin}:${identity.id}`, merged);
    if (before) requestAnimationFrame(() => applyFeedCompensation(before, captureFeedAnchor()));
  }, [identity]);
  // Reconnect delta resolve (PORCH-081 ac-4): GET /api/social/events?since=
  // with the stored per-origin cursor; the replayed envelopes apply through
  // the same idempotent in-place merge, the returned cursor is stored, and
  // a beyond-the-window replay renders the REST catch-up note (behind).
  const catchUpOrigin = useCallback(async (eventUrl, identityId) => {
    const live = readConnections(stored, origin);
    const connection = live.find((item) => item.identity?.id === identityId
      && new URL(item.url).origin === eventUrl && item.token);
    if (!connection) return;
    const before = captureFeedAnchor();
    let changed = false;
    try {
      const result = await catchUpSince(request, connection, readEventCursor(stored, origin));
      for (const envelope of result.events) {
        const merged = applyEvent(postsRef.current, envelope, {
          origin: eventUrl, network: connection.name || eventUrl, log: console,
        });
        if (merged !== postsRef.current) {
          postsRef.current = merged;
          changed = true;
        }
      }
      if (changed) {
        setPosts(postsRef.current);
        saveTimeline(stored, `${origin}:${identityId}`, postsRef.current);
      }
      saveEventCursor(stored, origin, result.cursor);
      setBehind(result.stale);
      setOffline(false);
    } catch {
      // Named outage class: the delta could not be resolved; the alert
      // surfaces stay visible until a successful (re)connect resolves it.
      setOffline(true);
    }
    if (before) requestAnimationFrame(() => applyFeedCompensation(before, captureFeedAnchor()));
  }, []);
  const liveSig = identityConnections
    .map((connection) => `${new URL(connection.url).origin}#${connection.networkId ?? ""}`)
    .join("|");
  useEffect(() => {
    if (!identity?.id || membershipEnded || signedOut.current) return undefined;
    const handles = identityConnections.map((connection) => {
      const eventUrl = new URL(connection.url).origin;
      return openEventStream({
        url: eventUrl,
        identityId: identity.id,
        // The credential is read at every (re)handshake, never a closure:
        // a renewed token presents itself, a dead one is refused upstream.
        getAuth: () => {
          const live = readConnections(stored, origin);
          const match = live.find((item) => item.identity?.id === identity.id
            && new URL(item.url).origin === eventUrl && item.token);
          return match ? { networkId: match.networkId ?? null, token: match.token } : null;
        },
        onEvent: (envelope) => mergeArrival(envelope, connection),
        onState: ({ connected }) => {
          // The connection fact renders visibly (ac-4): a realtime outage
          // shows the outage state and serves the cached river; a dead
          // credential keeps its own honest state instead of masquerading
          // as an outage (PORCH-050). Recovering: the catch-up resolve.
          if (!connected) {
            if (!membershipEndedRef.current) setOffline(true);
            return;
          }
          setOffline(false);
          // Every successful (re)connect re-resolves the stored cursor's
          // delta (the first connect replays the bounded window once).
          void catchUpOrigin(eventUrl, identity.id);
        },
      });
    });
    return () => handles.forEach((handle) => handle.close());
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the subscriptions ride the identity's live connections, not the snapshot objects
  }, [identity?.id, liveSig, membershipEnded, mergeArrival, catchUpOrigin]);
  // Media transport (PORCH-044): the rendition worker registers once at
  // boot; member surfaces render rendition URLs directly (srcset/sizes,
  // video poster/src) once it is live, and fall back to the authorized-
  // fetch blob loader where a worker can't register (insecure origins).
  const [mediaTransport, setMediaTransport] = useState(false);
  useEffect(() => {
    // PORCH-051: Android/Chrome — prevent the default install banner and
    // store the deferred prompt so the custom CTA can fire it (once); the
    // surfaces retire when the app installs (appinstalled or the
    // display-mode standalone check — an installed surface is never
    // asked again). No second service worker is involved anywhere: the
    // single registration stays in media-transport.js.
    const onPrompt = (event) => { event.preventDefault(); setInstallPrompt(event); };
    const onInstalled = () => { setInstallPrompt(null); setStandaloneLaunch(true); };
    window.addEventListener("beforeinstallprompt", onPrompt);
    window.addEventListener("appinstalled", onInstalled);
    const modeQuery = window.matchMedia("(display-mode: standalone)");
    const onMode = (event) => setStandaloneLaunch(event.matches || Boolean(window.navigator.standalone));
    modeQuery.addEventListener("change", onMode);
    return () => {
      window.removeEventListener("beforeinstallprompt", onPrompt);
      window.removeEventListener("appinstalled", onInstalled);
      modeQuery.removeEventListener("change", onMode);
    };
  }, []);
  useEffect(() => {
    void registerMediaTransport().then((ready) => setMediaTransport(ready));
  }, []);
  // The token set rides every renewal: relay it to the rendition worker so
  // its authenticated cache never presents a superseded token (a stale
  // token just 401s into the next relay, the rendition set is untouched).
  const mediaTokenSignature = identityConnections.map((c) => `${new URL(c.url).origin}:${c.token}`).join("|");
  useEffect(() => {
    syncMediaTransport(Object.fromEntries(identityConnections.map((c) => [new URL(c.url).origin, c.token])));
  }, [mediaTokenSignature]);
  // Devices load on demand (PORCH-081 ac-1): when the identity opens or its
  // credential re-credentials after a renewal or a membership write — never
  // a timed refetch of device state (the V1 event vocabulary is
  // content-only; no identity event stream exists for this surface).
  const checkDevices = useCallback(async () => {
    if (!active?.identityToken || !active?.identity?.id) return;
    // PORCH-050: a revoked registration or genuinely dead identity session
    // cannot be fixed by a re-read — recovery runs through the owner-routed
    // device link. A dead credential names its state instead of writing the
    // same 401 every tick; a successful renewal (fresh mint) or an identity
    // switch clears the flag and the next on-demand load resumes.
    if (identityEndedRef.current) return;
    try {
      const result = await request({ ...active, token: active.identityToken }, "identity/devices");
      observeDevices(result.registrations || [], active);
      setOwner((current) => ({ ...current, devices: result.registrations || [], availability: { ...current.availability, devices: true } }));
    } catch (error) {
      if (error?.status === 401) identityEndedRef.current = true;
      setOwner((current) => ({ ...current, availability: { ...current.availability, devices: false } }));
    }
  }, [active, observeDevices]);
  useEffect(() => {
    void checkDevices();
  }, [checkDevices]);
  // PORCH-070: the open identity's own account read feeds the Profile photo
  // block (hub rungs or the legacy profile photo). It rides the identity
  // plane's own credential and keys on the active identity — renewals and
  // switches re-read it; commits and clears repaint it directly above.
  useEffect(() => {
    if (!(active?.identityToken && active?.identity?.id)) { setIdentityAccount(null); return undefined; }
    let alive = true;
    void (async () => {
      try {
        const account = await actions.readAccount();
        if (alive) setIdentityAccount(account ?? null);
      } catch {
        if (alive) setIdentityAccount(null);
      }
    })();
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the read rides the active identity's credential, not the actions memo
  }, [activeIdentityId, active?.identityToken]);

  const bindDevice = async (route, grant) => {
    const hub = { url: origin };
    const registration = await createDeviceRegistration(origin, (device) =>
      request(hub, route, {
        method: "POST",
        body: JSON.stringify(route === "identity/pair" ? { code: grant, device } : { token: grant, device }),
      }));
    const session = await openDeviceSession(hub, registration, request);
    // PORCH-034 follow-up: the device label ("Browser") describes the
    // hardware only — the person's name arrives from the hub with the
    // restored membership, and the device-local identity never masquerades
    // as its device.
    const next = {
      url: origin, name: network?.name || "Your family",
      identity: { id: registration.did, name: "Family member" },
      identityToken: session.accessToken, identityRefreshToken: session.refreshToken,
      deviceId: registration.deviceId, token: null, refreshToken: null, networkId: null,
      renewedAt: Date.now(),
    };
    // Membership sessions ride LIVE rows only (never admission): a re-bound
    // device restores its network tokens silently so the timeline lands
    // with content intact.
    try {
      const restored = await request(hub, "social/session/restore", {
        method: "POST",
        body: JSON.stringify({ identityAccessToken: session.accessToken, deviceId: registration.deviceId }),
      });
      const first = restored?.sessions?.[0];
      if (first) {
        next.token = first.accessToken;
        next.refreshToken = first.refreshToken;
        next.networkId = first.networkId;
        if (first.name) next.identity.name = first.name;
      }
    } catch { /* no membership row yet: the plain notice below names it */ }
    const revised = connections.filter((item) => item.identity?.id !== registration.did).concat(next);
    saveConnections(stored, origin, revised);
    setConnections(revised);
    if (readSignedOut(stored, origin)) {
      // PORCH-055 ac-4: grant consumption wins over the chooser state but
      // never opens the identity turn — the refreshed registration joins
      // the face row and the device returns to the front state.
      navigate("/who-is-here");
      return registration;
    }
    setIdentity(next.identity);
    postsRef.current = cachedTimeline(stored, `${origin}:${registration.did}`);
    setPosts(postsRef.current);
    setHidden(hiddenPosts(stored, `${origin}:${registration.did}`));
    navigate("/timeline");
    if (!next.token) setNotice("This device is connected. Ask your family's owner to finish membership on this hub before moments appear.");
    return registration;
  };
  const finishJoin = async ({ url, code, did, deviceId, identityName }) => {
    const hub = { url };
    const session = await openDeviceSession(hub, { did, deviceId }, request);
    const jwk = await getDeviceJwk(url, did, deviceId);
    if (!jwk) throw new Error("This device cannot finish connecting. Ask for a fresh device link.");
    const privateKey = await getDeviceKey(url, did, deviceId);
    const signature = await signDeviceMessage(privateKey, `porchlight-join:${code}`);
    const admitted = await request(hub, "social/join/admit", {
      method: "POST",
      body: JSON.stringify({ code, identityAccessToken: session.accessToken, deviceId, devicePublicKeyJwk: jwk, signature }),
    });
    const next = {
      url, name: network?.name || "Your family",
      identity: { id: did, name: admitted.name || identityName || "Family member" },
      identityToken: session.accessToken, identityRefreshToken: session.refreshToken,
      deviceId, token: admitted.accessToken, refreshToken: admitted.refreshToken, networkId: admitted.networkId,
      renewedAt: Date.now(),
    };
    const revised = connections.filter((item) => item.identity?.id !== did).concat(next);
    saveConnections(stored, origin, revised);
    setConnections(revised);
    if (readSignedOut(stored, origin)) {
      // PORCH-055 ac-4: joining from the front state closes on the chooser —
      // the new face joins the row, no identity turn opens. Join's done
      // stage routes back through data.frontState.
      return admitted;
    }
    setIdentity(next.identity);
    postsRef.current = cachedTimeline(stored, `${origin}:${did}`);
    setPosts(postsRef.current);
    setHidden(hiddenPosts(stored, `${origin}:${did}`));
    return admitted;
  };
  const unsupported = () => { throw new Error("Your family server does not offer this action yet. No change was made."); };
  // PORCH-042: the Profile appearance control writes the device-level mode
  // choice client-side only; removing the override stores nothing.
  const chooseMode = (next) => {
    writeStoredMode(stored, next);
    setModePref(readStoredMode(stored));
  };
  // Card- and detail-level writes resolve the post's own origin connection
  // through the shared resolver (PORCH-038 ac-4); card and detail ride one
  // routing rule, so a card write lands in the same conversation detail loads.
  // Reaction and reply writes are optimistic in the surfaces (PORCH-046
  // ac-2): the card reflects immediately and rolls back on failure, so no
  // full feed reload rides a card interaction. A vote still reconciles —
  // prominence order is the server's own computation.
  const connectionForPost = (post) => connectionForPostOrigin(post, identityConnections, active);
  const actions = useMemo(() => ({
    chooseMode,
    isHidden: (post) => hidden.has(`${post.origin || origin}:${post._id || post.id}`),
    hide: (post) => setHidden(hidePost(stored, `${origin}:${identity?.id}`, `${post.origin || origin}:${post._id || post.id}`)),
    hiddenItems: () => [...hidden],
    showPost: (key) => setHidden(unhidePost(stored, `${origin}:${identity?.id}`, key)),
    loadReactions: async (post) => {
      const result = await request(connectionForPost(post), `social/posts/${encodeURIComponent(post._id || post.id)}/reactions`);
      // The client renders only emoji values. Per-member reaction rows do
      // cross the wire (memberDid per row); memberDid is used exclusively to
      // mark the member's own reaction for the warm highlight — never
      // rendered as a who-reacted inspection surface (PORCH-036).
      return (result.reactions || []).filter((row) => row.emoji);
    },
    getMedia: async (mediaId, kind = "feed-thumb", postOrigin = active?.url, version = null) => {
      const connection = identityConnections.find((item) => new URL(item.url).origin === postOrigin);
      if (!connection?.token) throw new Error("Connect to that family server to see this moment.");
      // Rendition requests carry the content address (PORCH-044 ac-3): the
      // `v` sha256 pins the immutable pixels; the browser cache answers
      // repeats without touching the network.
      const path = kind === "original"
        ? `media/${encodeURIComponent(mediaId)}/original`
        : `media/${encodeURIComponent(mediaId)}/renditions/${encodeURIComponent(kind)}${version ? `?v=${encodeURIComponent(version)}` : ""}`;
      const response = await fetch(new URL(`/api/social/${path}`, connection.url), { headers: { authorization: `Bearer ${connection.token}` } });
      if (!response.ok) throw new Error(`This moment could not be loaded (${response.status}).`);
      return response.blob();
    },
    // The front door: verification first (plain states), then either the
    // invited member's identity birth or a connect for an identity already
    // registered on this device. Membership rides social/join/admit with the
    // device signature — verification alone never grants anything.
    // Required names (PORCH-024): first and last ride every creation; the
    // display name is composed from them.
    joinNew: async ({ url, code, firstName, lastName }) => {
      const hub = { url };
      const registration = await createDeviceRegistration(url, (device) =>
        request(hub, "bootstrap/join-member", { method: "POST", body: JSON.stringify({ code, firstName, lastName, device }) }));
      const session = await openDeviceSession(hub, registration, request);
      return finishJoin({ url, code, did: registration.did, deviceId: registration.deviceId, identityName: fullName(firstName, lastName) });
    },
    joinDevice: async ({ url, code, did, deviceId, name }) => {
      return finishJoin({ url, code, did, deviceId, identityName: name });
    },
    verifyJoin: async ({ url, code }) => {
      const response = await request({ url }, `social/join/verify?code=${encodeURIComponent(code)}`);
      if (!("valid" in response)) {
        const error = new Error("This hub does not offer the Porchlight front door.");
        error.code = "E_NOT_PORCHLIGHT";
        throw error;
      }
      if (!response.valid) {
        const error = new Error(response.message || "This invitation cannot be used.");
        error.code = response.code;
        throw error;
      }
      return response;
    },
    switchIdentity: async (id) => {
      const next = connections.find((item) => item.identity?.id === id);
      if (!next) throw new Error("This person is not connected on this device.");
      const session = await openDeviceSession(next, { did: id, deviceId: next.deviceId }, request);
      // The turn is open again: the forever-logged-in silent reopen resumes.
      signedOut.current = false;
      clearSignedOut(stored, origin);
      identityEndedRef.current = false;
      // PORCH-034 follow-up: the hub resolves the member's family-facing
      // name at re-credential, healing any device-local stale naming.
      let hubName = null;
      let hubTokens = null;
      try {
        const restored = await request({ url: next.url, token: session.accessToken }, "social/session/restore", {
          method: "POST",
          body: JSON.stringify({ identityAccessToken: session.accessToken, deviceId: next.deviceId }),
        });
        hubName = restored?.sessions?.[0]?.name || null;
        hubTokens = restored?.sessions?.[0] ?? null;
      } catch { /* membership state unchanged on this device */ }
      const updated = connections.map((item) => item === next ? {
        ...item,
        identity: hubName ? { ...item.identity, name: hubName } : item.identity,
        identityToken: session.accessToken, identityRefreshToken: session.refreshToken, renewedAt: Date.now(),
        ...(hubTokens ? { token: hubTokens.accessToken, refreshToken: hubTokens.refreshToken, networkId: hubTokens.networkId } : {}),
      } : item);
      saveConnections(stored, origin, updated);
      setConnections(updated);
      setIdentity(updated.find((item) => item.identity?.id === id)?.identity ?? next.identity);
      postsRef.current = cachedTimeline(stored, `${origin}:${id}`);
      setPosts(postsRef.current);
      setHidden(hiddenPosts(stored, `${origin}:${id}`));
      navigate("/timeline");
    },
    // Explicit sign-out / Switch (PORCH-055): the turn closes here and the
    // next open renders the WhoIsHere front state, never a half-open app.
    signOut: () => {
      signedOut.current = true;
      markSignedOut(stored, origin);
      setIdentity(null);
      postsRef.current = [];
      setPosts([]);
      setHidden(new Set());
      navigate("/who-is-here");
    },
    createPairingCode: async () => {
      if (!active?.identityToken || !identity?.id) throw new Error("Open your connected identity on this device first.");
      return request({ ...active, token: active.identityToken }, "identity/pairing-code", { method: "POST", body: JSON.stringify({ did: identity.id }) });
    },
    removeDevice: async (registrationId) => {
      if (!active?.identityToken) throw new Error("Open your connected identity on this device first.");
      await request({ ...active, token: active.identityToken }, "identity/devices/revoke", { method: "POST", body: JSON.stringify({ registrationId }) });
      setOwner((current) => ({ ...current, devices: current.devices.filter((row) => (row._id || row.id) !== registrationId) }));
      await reload();
    },
    // PORCH-070 identity-plane avatar actions. All ride the open
    // connection's identity token — session-bound to the opened identity,
    // never the membership plane — and surface the hub's plain refusals
    // verbatim. The ingest carries raw image bytes with the declaration in
    // headers (device-signed); commit and clear are JSON device-signed
    // writes on the same route.
    readAccount: async (connection = active) => {
      const conn = connection || active;
      if (!conn?.identityToken) throw new Error("Open your connected identity on this device first.");
      return request({ ...conn, token: conn.identityToken }, "identity/accounts/me");
    },
    loadAvatarRendition: async ({ did, kind, version = null, pendingToken = null, connection = null } = {}) => {
      const conn = connection || active;
      const token = conn?.identityToken;
      if (!did || !kind || !token) throw new Error("Open your connected identity on this device first.");
      const target = new URL(`/api/identity/avatars/${encodeURIComponent(did)}/renditions/${encodeURIComponent(kind)}`, conn.url);
      target.searchParams.set("v", version ?? "");
      if (pendingToken) target.searchParams.set("pending", pendingToken);
      // Pending previews are fetched once, authorized and never cached —
      // committed rungs ride the content address, so the browser's own
      // cache answers repeats.
      let response;
      try {
        response = await fetch(target, { headers: { authorization: `Bearer ${token}` }, cache: pendingToken ? "no-store" : "default" });
      } catch (cause) {
        throw markUnreachable(cause);
      }
      if (!response.ok) {
        const refused = await response.json().catch(() => ({}));
        const error = new Error(refused.error || `The family server returned ${response.status}.`);
        error.code = refused.code;
        error.status = response.status;
        error.body = refused;
        throw error;
      }
      return response.blob();
    },
    uploadAvatar: async (file) => {
      if (!active?.identityToken || !active.identity?.id || !active.deviceId) throw new Error("Open your connected identity on this device first.");
      if (!file) throw new Error("Choose a photo to set.");
      const bytes = new Uint8Array(await file.arrayBuffer());
      if (!bytes.byteLength) {
        const empty = new Error("That file is empty. Choose an image.");
        empty.code = "E_AVATAR_UNDECODABLE";
        throw empty;
      }
      const contentType = file.type || "application/octet-stream";
      const payload = { scope: "identity-avatar", action: "ingest", size: bytes.byteLength, sha256: await sha256Hex(bytes), contentType };
      const signature = await signDevicePayload(new URL(active.url).origin, active.identity.id, active.deviceId, payload);
      let response;
      try {
        response = await fetch(new URL("/api/identity/accounts/me/avatar", active.url), {
          method: "POST",
          headers: {
            "content-type": contentType,
            authorization: `Bearer ${active.identityToken}`,
            "x-porchlight-avatar-payload": JSON.stringify(payload),
            "x-porchlight-signature": signature,
          },
          body: bytes,
        });
      } catch (cause) {
        throw markUnreachable(cause);
      }
      const result = await response.json().catch(() => ({}));
      if (!response.ok) {
        const error = new Error(result.error || `The family server returned ${response.status}.`);
        error.code = result.code;
        error.status = response.status;
        error.body = result;
        throw error;
      }
      return result;
    },
    commitAvatar: async (token) => {
      if (!active?.identityToken || !active.identity?.id || !active.deviceId) throw new Error("Open your connected identity on this device first.");
      const payload = { scope: "identity-avatar", action: "commit", token };
      const signature = await signDevicePayload(new URL(active.url).origin, active.identity.id, active.deviceId, payload);
      const result = await request({ ...active, token: active.identityToken }, "identity/accounts/me/avatar", {
        method: "POST", body: JSON.stringify({ payload, signature }),
      });
      // The face updates in state on the spot: the Profile shows the new
      // photo without a re-login and every surface renders it on the next
      // feed read.
      if (result) setIdentityAccount((current) => ({ ...(current ?? {}), ...result }));
      return result;
    },
    clearAvatar: async () => {
      if (!active?.identityToken || !active.identity?.id || !active.deviceId) throw new Error("Open your connected identity on this device first.");
      const payload = { scope: "identity-avatar", action: "clear" };
      const signature = await signDevicePayload(new URL(active.url).origin, active.identity.id, active.deviceId, payload);
      const result = await request({ ...active, token: active.identityToken }, "identity/accounts/me/avatar", {
        method: "POST", body: JSON.stringify({ payload, signature }),
      });
      // The cleared face disappears from state immediately; the legacy
      // profile photo (if the hub kept serving it) takes over again.
      if (result) setIdentityAccount((current) => ({ ...(current ?? {}), ...(result ?? {}) }));
      return result ?? { avatar: null };
    },
    issueInvite: async () => { const result = await request(active, "social/console/invites", { method: "POST", body: JSON.stringify({ role: "member", maxUses: 1 }) }); await reload(); return result; },
    // Paginated activity read (PORCH-058 ac-3): a newer/older page turn
    // fetches directly from the paginated endpoint — no console reload.
    loadAuditPage: (offset = 0) => request(active, `social/console/audit?limit=${AUDIT_PAGE}&offset=${offset}`),
    revokeInvite: async (id) => { const result = await request(active, "social/console/invites/revoke", { method: "POST", body: JSON.stringify({ inviteId: id }) }); await reload(); return result; },
    // Shared update path (PORCH-040): the apply POST returns once npm has
    // installed the release and the hub is restarting; after the restarted
    // release answers, the console refresh shows the new version at the
    // same address.
    applyUpdate: async () => {
      const result = await request(active, "social/console/update", { method: "POST", body: JSON.stringify({}) });
      if (result?.status === "applied") await waitUntilHubHealthy(active?.url || origin);
      await reload();
      return result;
    },
    updateSettings: async (settings) => { const result = await request(active, "social/console/limits", { method: "PUT", body: JSON.stringify(settings) }); await reload(); return result; },
    // Media-root edit (PORCH-054's hub surface, rendered by PORCH-057's Storage
    // tab): a failing path is refused with the check's named reason and the
    // surface carries it verbatim; media never moves on its own.
    editMediaRoot: async (root) => { const result = await request(active, "social/console/media-root", { method: "PUT", body: JSON.stringify({ root }) }); await reload(); return result; },
    // Register the new domain (PORCH-066): the address action rides the
    // owner's live session (the same class as Send device link). The server
    // verifies, re-points, and mints the self-grant; the caller follows the
    // returned redirectUrl. No reload here: success leaves this origin, and
    // every refusal leaves zero mutation.
    changeAddress: (host) => request(active, "social/console/address", { method: "POST", body: JSON.stringify({ host }) }),
    revokeMember: async (member) => {
      const result = await request(active, "social/console/members/revoke", {
        method: "POST", body: JSON.stringify({ memberId: member._id || member.id }),
      });
      await reload();
      return result;
    },
    // Role ladder (PORCH-053): promote/demote member↔delegate, owner-only
    // at the hub; the server's plain-language refusals surface verbatim.
    setMemberRole: async (member, role) => {
      const result = await request(active, "social/console/members/role", {
        method: "PATCH", body: JSON.stringify({ memberId: member._id || member.id, role }),
      });
      await reload();
      return result;
    },
    // The destructive path (PORCH-053): permanent deletion behind the typed
    // member-name confirmation; the confirmation rides the DELETE body.
    purgeMember: async (member, confirmName) => {
      const result = await request(active, `social/console/members/${encodeURIComponent(member._id || member.id)}`, {
        method: "DELETE", body: JSON.stringify({ confirmName }),
      });
      await reload();
      return result;
    },
    // Owner-routed device continuity (PORCH-010): mint the one-time,
    // identity-scoped device link for a member, list grant states, revoke.
    sendDeviceLink: async (did) => {
      const result = await request(active, "social/console/device-links", {
        method: "POST", body: JSON.stringify({ did }),
      });
      await reload();
      return result;
    },
    listDeviceLinks: () => request(active, "social/console/device-links"),
    revokeDeviceGrant: async (grantId) => {
      const result = await request(active, "social/console/device-links/revoke", {
        method: "POST", body: JSON.stringify({ grantId }),
      });
      await reload();
      return result;
    },
    revokeAnyDevice: async (registrationId) => {
      const result = await request(active, "social/console/devices/revoke", {
        method: "POST", body: JSON.stringify({ registrationId }),
      });
      await reload();
      return result;
    },
    // Owner bootstrap drives the hub's public setup ledger; every step is
    // re-readable, so a closed browser resumes exactly where setup paused.
    setupState: () => request({ url: origin }, "bootstrap/state"),
    accountState: () => request({ url: origin }, "identity/account").catch(() => null),
    createOwnerAccount: async ({ firstName, lastName, avatar }) => {
      const hub = { url: origin };
      const registration = await createDeviceRegistration(origin, (device) =>
        request(hub, "identity/bootstrap/account", { method: "POST", body: JSON.stringify({ firstName, lastName, device }) }));
      const session = await openDeviceSession(hub, registration, request);
      const next = {
        url: origin, name: "Your family",
        identity: { id: registration.did, name: fullName(firstName, lastName) },
        identityToken: session.accessToken, identityRefreshToken: session.refreshToken,
        deviceId: registration.deviceId, token: null, refreshToken: null, networkId: null,
      };
      // Required names persist as first/last fields on the account row at
      // creation (PORCH-024); the display name is composed from them. The
      // photo is optional and misses nothing if the profile write fails.
      if (avatar) {
        try {
          await request({ url: origin, token: session.accessToken }, "identity/account/profile", {
            method: "POST", body: JSON.stringify({ did: registration.did, profile: { avatar } }),
          });
        } catch { /* the photo is optional; the account itself is complete */ }
      }
      const revised = connections.filter((item) => item.identity?.id !== registration.did).concat(next);
      saveConnections(stored, origin, revised);
      setConnections(revised);
      setIdentity(next.identity);
      return { registration, session };
    },
    startNetwork: async ({ name, ownerDid }) => {
      const hub = { url: origin };
      const result = await request(hub, "social/bootstrap/network", {
        method: "POST", body: JSON.stringify({ name, ownerDid }),
      });
      setNetwork(result.network || null);
      // Founder binding (PORCH-018): network creation binds the owner's
      // membership server-side (role: owner, no invite consumed); this
      // device re-credentials silently right after so the owner lands in
      // setup already holding network tokens — no manual binding step.
      const ownerConnection = connections.find((item) => item.identity?.id === ownerDid);
      if (ownerDid && ownerConnection?.deviceId) {
        try {
          const registration = { did: ownerDid, deviceId: ownerConnection.deviceId };
          const session = await openDeviceSession(hub, registration, request);
          // PORCH-061: every mint supersedes the stored identity token by
          // design (PORCH-028). Persist the fresh identity session BEFORE the
          // restore attempt: a refused restore (the founder row not yet
          // visible, E_NOT_A_MEMBER) must never leave the landed connection
          // presenting the token this re-credential just superseded.
          const withIdentity = mergeSessionAdoptions(connections, [{
            id: ownerDid,
            identityToken: session.accessToken,
            identityRefreshToken: session.refreshToken,
          }]);
          saveConnections(stored, origin, withIdentity);
          setConnections(withIdentity);
          let landed = withIdentity;
          try {
            const restored = await request(hub, "social/session/restore", {
              method: "POST", body: JSON.stringify({ identityAccessToken: session.accessToken, deviceId: registration.deviceId }),
            });
            const first = restored?.sessions?.[0];
            if (first) {
              landed = mergeSessionAdoptions(landed, [{
                id: ownerDid,
                token: first.accessToken, refreshToken: first.refreshToken, networkId: first.networkId,
              }]).map((item) => item.identity?.id === ownerDid
                ? { ...item, name: result.network?.name || item.name }
                : item);
              saveConnections(stored, origin, landed);
              setConnections(landed);
            }
          } catch { /* PORCH-061: the identity plane stays live; binding stays server-side and the next silent re-credential binds */ }
          // PORCH-061: a refused (or memberless) restore right after the
          // founder write was the dead landing itself — the freshly minted
          // identity session persisted above, but every member surface rode
          // a connection with token:null until the custody interval happened
          // to re-credential. One spaced forced re-credential retries the
          // binding through the shared renewal slot — gate bypassed (a
          // connection without a membership token has nothing for the gate
          // to protect), no sign-out cycle, no custody-window wait.
          if (!landed.find((item) => item.identity?.id === ownerDid)?.token) {
            try {
              await new Promise((resolve) => setTimeout(resolve, 1500));
              await custody.renew({ did: ownerDid, force: true });
            } catch { /* the surfaces name the refused binding */ }
          }
        } catch { /* binding stays server-side; the next silent re-credential binds */ }
      }
      return result;
    },
    exportData: async () => {
      const blob = await exportOriginals(active);
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = "porchlight-archive.zip";
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
      return blob;
    },
    pair: (code) => bindDevice("identity/pair", code),
    linkDevice: (grant) => bindDevice("identity/device-link/consume", grant),
    // No server-side origin confirmation event exists yet. Never dismiss by pretending.
    confirmDevice: unsupported,
    vote: async (post, value) => { const result = await publishVote(connectionForPost(post), post, value); await reload(); return result; },
    react: async (post, emoji) => publishReaction(connectionForPost(post), post, emoji),
    unreact: async (post, emoji) => unpublishReaction(connectionForPost(post), post, emoji),
    submitPost: async (payload) => { const result = await publishPost(active, payload); await reload(); return result; },
    submitReply: async (post, body, parentId, mentions = []) => {
      // Link previews (PORCH-052): a reply body carrying a URL resolves at
      // submit time, hub-side and device-signed; a failed or degraded
      // resolution never blocks the reply (the URL rides the text plainly).
      let previewId = null;
      const url = firstUrlIn(body);
      if (url) {
        try {
          const resolved = await resolvePreview(connectionForPost(post), url);
          previewId = resolved?.preview?.id ?? null;
        } catch { previewId = null; }
      }
      return publishReply(connectionForPost(post), post, body, parentId, mentions, previewId);
    },
    resolvePreview: (url) => resolvePreview(active, url),
    // Mention roster (PORCH-037): same-origin members by name, fetched at
    // the post's own origin so candidates never ride another connection.
    mentionCandidates: (post, q = "") => fetchMentionCandidates(connectionForPost(post), q),
    upload: (files) => uploadOriginals(active, files),
    loadPost: async (id) => {
      const cached = posts.find((item) => (item._id || item.id) === id);
      const candidates = cached ? [connectionForPost(cached)] : identityConnections;
      if (!candidates.length) throw new Error("Connect to your family server to see this conversation.");
      return Promise.any(candidates.map(async (connection) => {
        const result = await request(connection, `social/posts/${encodeURIComponent(id)}`);
        return { ...result, post: { ...result.post, origin: new URL(connection.url).origin, network: connection.name } };
      }));
    },
    loadComments: (post) => request(connectionForPost(post), `social/posts/${encodeURIComponent(post._id || post.id)}/comments`),
    // Group management (PORCH-030, Oct 14 follow-up): the Members view reads
    // group detail (roster + read-time names via /social/groups/:id) and its
    // timeline from the origin-scoped group feed; creation and member adds
    // ride the member plane — no elevation, the creator manages their group.
    loadGroup: async (id) => {
      const [detail, timeline] = await Promise.all([
        request(active, `social/groups/${encodeURIComponent(id)}`),
        request(active, `social/timeline/groups/${encodeURIComponent(id)}`),
      ]);
      const origin = active?.url ? new URL(active.url).origin : undefined;
      const annotate = (post) => origin ? { ...post, origin } : post;
      return { group: { ...detail.group, ...timeline.group }, posts: (timeline.posts ?? []).map(annotate) };
    },
    createGroup: async (name, visibility) => {
      const result = await request(active, "social/groups", { method: "POST", body: JSON.stringify({ name, visibility }) });
      await reload();
      return result;
    },
    addGroupMembers: async (groupId, dids) => {
      const result = await request(active, `social/groups/${encodeURIComponent(groupId)}/members`, {
        method: "POST", body: JSON.stringify({ dids }),
      });
      await reload();
      return result;
    },
    // Visibility change (PORCH-068 ac-1): the managing member flips a group
    // between private (invite-only) and public (the network views it).
    updateGroupVisibility: async (groupId, visibility) => {
      const result = await request(active, `social/groups/${encodeURIComponent(groupId)}/visibility`, {
        method: "POST", body: JSON.stringify({ visibility }),
      });
      await reload();
      return result;
    },
    // Membership lifecycle (PORCH-068, Brian's Oct 14 rulings): self-serve
    // join rides the member's own act on a public group (no authorization
    // step; delivery turns on immediately); removal and unblock are the
    // managing member's acts at the group's Members view.
    joinGroup: async (groupId) => {
      const result = await request(active, `social/groups/${encodeURIComponent(groupId)}/join`, {
        method: "POST", body: JSON.stringify({}),
      });
      await reload();
      return result;
    },
    removeGroupMember: async (groupId, did) => {
      const result = await request(active, `social/groups/${encodeURIComponent(groupId)}/members/remove`, {
        method: "POST", body: JSON.stringify({ did }),
      });
      await reload();
      return result;
    },
    unblockGroupMember: async (groupId, did) => {
      const result = await request(active, `social/groups/${encodeURIComponent(groupId)}/unblock`, {
        method: "POST", body: JSON.stringify({ did }),
      });
      await reload();
      return result;
    },
    groupMemberCandidates: (q = "") => fetchMentionCandidates(active, q),
    search: (query) => request(active, `social/search?q=${encodeURIComponent(query)}`),
    // Notification settings (PORCH-060): the open identity's membership
    // token authorizes the reads and writes; the hub stores the settings
    // per identity and enforces them at send time (PORCH-059).
    loadNotificationSettings: () => request(active, "social/push/settings"),
    saveNotificationSettings: (settings) => request(active, "social/push/settings", {
      method: "PUT", body: JSON.stringify({ enabled: settings.enabled, events: settings.events, mutes: settings.mutes }),
    }),
    // The Enable flow (PORCH-060 ac-3): the browser prompt can fire ONLY
    // here, from the explicit tap — pushManager.subscribe is the prompt;
    // nothing calls Notification.requestPermission at load or on
    // navigation. The hub's VAPID public key scopes the subscription, and
    // the descriptor registers hub-side under the open identity's session
    // (the worker is the one already-registered rendition worker).
    enableNotifications: async () => {
      if (typeof window.PushManager !== "function") throw new Error("This browser cannot receive notifications.");
      const registration = workerRegistration() || (navigator.serviceWorker ? await navigator.serviceWorker.getRegistration("/") : null);
      if (!registration) throw new Error("Porchlight's notification channel is still starting up. Try again in a moment.");
      const vapid = await request(active, "social/push/vapid");
      if (!vapid?.available || !vapid?.publicKey) throw new Error("The hub is not sending notifications yet. Try again later.");
      return enablePush({
        pushManager: registration.pushManager,
        vapidPublicKey: vapid.publicKey,
        register: (descriptor) => request(active, "social/push/subscriptions", { method: "POST", body: JSON.stringify(descriptor) }),
      });
    },
    // The iOS-not-installed handoff dismissal (ac-4) rides the install
    // flow's established suppression window — same key, same period.
    notificationsHandoffDismissed: () => installSuppressed(readLocal(stored, origin, "install-dismissed-at", 0)),
    dismissNotificationsHandoff: () => {
      const dismissedAt = Date.now();
      writeLocal(stored, origin, "install-dismissed-at", dismissedAt);
      setInstallDismissedAt(dismissedAt);
    },
    // Rendition transport readiness (PORCH-044): true once the auth-relaying
    // rendition worker is live — surfaces then load rendition URLs directly
    // (srcset/sizes, video poster/src) and the browser cache answers repeats.
    mediaTransport,
    // PORCH-081 ac-4: the catch-up note's resolve — one member-initiated
    // refresh when the replay window was exceeded, never a poll cycle.
    refreshFeeds: () => reload(),
  }), [hidden, connections, active, identity, navigate, reload, posts, network, mediaTransport]);

  const data = {
    posts, groups, albums: [], connections, network: { name: active?.name || network?.name || null, id: active?.networkId || network?._id },
    identity, members: owner.members, devices: owner.devices, settings: owner.settings,
    // PORCH-070: the open identity's own account read (avatar rungs + the
    // legacy profile photo) rides beside the other own-account fields.
    identityAccount,
    invites: owner.invites, audit: owner.audit, disk: owner.disk, availability: owner.availability,
    allDevices: owner.allDevices, deviceLinks: owner.deviceLinks, update: owner.update,
    mediaRoot: owner.mediaRoot,
    reauth: owner.reauth,
    server: { name: active?.name || "Your family's Porchlight", url: active?.url || origin }, offline, membershipEnded,
    // PORCH-081 ac-4: the REST catch-up note's state — a replay older than
    // the hub's retained event window. Rendered, never silent; resolving
    // rides the next catch-up or the member's own refresh action.
    behind,
    // PORCH-060: the home-screen display-mode fact (capability-first
    // detection for the notification settings states; screen files never
    // matchMedia — the mode-branch guardrail carries).
    standalone: standaloneLaunch,
    // PORCH-055: the grant screens route consumption back to the front
    // state while this device is signed out — never into a half-open app.
    frontState: readSignedOut(stored, origin),
  };
  // The Profile appearance control is bound to the stored *preference*
  // (modePref), never the resolved mode: choosing System must stick as the
  // selected choice even when the resolved mode is identical to the override
  // it just cleared; the resolved mode drives the theme, not the control.
  const props = { data, actions, navigate, mode: modePref };
  const sharedDevice = new Set(connections.map((item) => item.identity?.id).filter(Boolean)).size > 1;
  const setupRoute = route === "/setup";
  const deviceLinkRoute = route === "/device-link" || route.startsWith("/device-link/");
  const chooseIdentity = (sharedDevice || connections.some(hasLocalPin)) && !identity;
  const frontDoor = setupRoute || route === "/join" || route.startsWith("/join/") || route === "/pair" || deviceLinkRoute || route === "/who-is-here" || chooseIdentity || !connections.length;
  useEffect(() => {
    // PORCH-060 tap-through: the service worker's notificationclick focuses
    // the existing client and hands it the payload's post reference; the
    // app navigates to the origin-contained post detail under the identity
    // already open on this device. No open identity: nothing navigates —
    // the device's standard open flow (front state) governs who is
    // speaking, exactly as any other open does.
    if (!navigator.serviceWorker) return undefined;
    const onWorkerMessage = (event) => {
      const postId = event?.data?.type === "porchlight-open-post" ? event.data.postId : null;
      if (postId && identity) navigate(`/posts/${encodeURIComponent(String(postId))}`);
    };
    navigator.serviceWorker.addEventListener("message", onWorkerMessage);
    return () => navigator.serviceWorker.removeEventListener("message", onWorkerMessage);
  }, [identity, navigate]);
  useEffect(() => {
    // PORCH-034 second round, once per app open: every device-connected
    // identity re-credentials quietly and its stored name heals to the
    // hub-resolved family-facing name — no rebind, no manual step, shared
    // devices included (the WhoIsHere chooser reads these rows). Rows that
    // fail stay untouched and heal on the next open.
    if (initialConnections.length === 0) return undefined;
    let stale = false;
    void (async () => {
      const live = readConnections(stored, origin);
      const updates = await resolveStoredNames(live, { openDeviceSession, request });
      if (stale || !updates.length) return;
      // PORCH-061: the sweep adopts what it mints — the healed name AND the
      // freshly minted identity session (plus the restored membership tokens
      // when the hub answered), merged through the shared adoption merge.
      const current = readConnections(stored, origin);
      const revised = mergeSessionAdoptions(current, updates);
      saveConnections(stored, origin, revised);
      setConnections(revised);
    })();
    return () => { stale = true; };
  }, []);
  useEffect(() => {
    // PORCH-055: a signed-out device is marked client-locally; its fresh
    // open rides the WhoIsHere front state (routeOf) and the turn only
    // reopens through an explicit face tap. The forever-logged-in device
    // (no open session, no marker) re-credentials silently into the
    // timeline when the sole registration is unpinned.
    if (signedOut.current || identity || frontDoor) return;
    const solo = connections.length === 1 && connections[0]?.identity?.id && !connections.some(hasLocalPin);
    if (!solo) return;
    actions.switchIdentity(connections[0].identity.id).catch(() => setOffline(true));
  }, [identity, connections, frontDoor, actions.switchIdentity]);
  useEffect(() => {
    // A hub with no identity at all is mid-bootstrap or fresh: its visitors
    // land on the owner setup, never a bare join form.
    if (!frontDoor || setupRoute || route.startsWith("/join/") || route === "/pair" || deviceLinkRoute) return;
    let stale = false;
    void (async () => {
      try {
        const account = await request({ url: origin }, "identity/account").catch(() => null);
        if (!stale && account && account.exists === false) navigate("/setup");
      } catch { /* hub unreachable: the join screen stays */ }
    })();
    return () => { stale = true; };
  }, [frontDoor, route, setupRoute, deviceLinkRoute, navigate]);
  let page;
  if (chooseIdentity && !["/join", "/pair", "/device-link", "/setup"].includes(route) && !route.startsWith("/join/") && !deviceLinkRoute) page = <WhoIsHere {...props} />;
  else
  if (setupRoute) page = <Setup {...props} />;
  else if (route === "/join" || route.startsWith("/join/")) page = <Join {...props} />;
  else if (route === "/pair") page = <Pair {...props} />;
  else if (deviceLinkRoute) page = <DeviceLink {...props} />;
  else if (route === "/who-is-here") page = <WhoIsHere {...props} />;
  else if (route === "/settings") page = <Settings {...props} />;
  else if (route === "/groups" || route.startsWith("/groups/")) page = <Groups {...props} id={route.split("/")[2]} />;
  else if (route.startsWith("/posts/")) page = <PostDetail {...props} id={route.split("/")[2]} />;
  else if (route === "/albums" || route.startsWith("/albums/")) page = <Albums {...props} id={route.split("/")[2]} />;
  else if (route === "/search") page = <Search {...props} />;
  else if (route === "/owner") page = <OwnerConsole {...props} />;
  else if (route === "/members") page = <Members {...props} />;
  else if (!connections.length) page = <Join {...props} />;
  else page = <Timeline {...props} />;
  // PORCH-051: which install surface this device earns — capability checks
  // only (standalone outranks everything; a captured prompt marks the
  // Android/Chrome class; otherwise touch-capable WebKit is the iOS class,
  // iPadOS included, since it presents as desktop Mac). A dismissal inside
  // the suppression window hides both surfaces.
  const installKind = surfaceInstallKind({
    standalone: standaloneLaunch,
    canPrompt: Boolean(installPrompt),
    touchCapable: window.navigator.maxTouchPoints > 0,
    webkit: webkitClass(window.navigator.userAgent),
  });
  const installHidden = installSuppressed(installDismissedAt);
  const dismissInstall = () => {
    const dismissedAt = Date.now();
    writeLocal(stored, origin, "install-dismissed-at", dismissedAt);
    setInstallDismissedAt(dismissedAt);
  };
  const installNow = () => {
    void consumeInstallPrompt(installPrompt).then((choice) => {
      // The deferred prompt is consumed exactly once; the CTA retires
      // either way, and only the dismissed outcome enters the suppression
      // window (accepting installs — appinstalled retires the surfaces).
      setInstallPrompt(null);
      if (!choice || choice.outcome !== "accepted") dismissInstall();
    });
  };

  return <ThemeProvider theme={muiTheme}><CssBaseline />
    {!frontDoor && <AppBar position="sticky" color="inherit" elevation={0} sx={{ borderBottom: "1px solid", borderColor: "divider", backdropFilter: "blur(12px)", background: `var(--porch-appbar-bg)` }}>
      <Toolbar sx={{ minHeight: { xs: 56, lg: 64 }, maxWidth: 1180, width: "100%", mx: "auto", px: { xs: 2, lg: 4 }, pt: "env(safe-area-inset-top)" }}>
        {/* Brand lockup (PORCH-032): the new lamp mark plus the navy wordmark. */}
        <Lockup onClick={() => navigate("/timeline")} size={30} sx={{ cursor: "pointer", flex: { xs: 1, lg: 0 }, minWidth: { lg: 180 } }} />
        <Stack direction="row" spacing={3} alignItems="center" sx={{ display: { xs: "none", lg: "flex" }, flex: 1, justifyContent: "center" }}>
          {primary.map((path, index) => index === 2
            ? <IconButton key={path} aria-label="Compose" onClick={() => setComposeOpen(true)} sx={{ bgcolor: "secondary.main", color: "var(--porch-amber-ink)", boxShadow: "var(--porch-shadow-compose)", "&:hover": { bgcolor: "secondary.dark" } }}><AddOutlined /></IconButton>
            : <Button key={path} onClick={() => navigate(path)} sx={{ color: route.startsWith(path) ? "primary.main" : "text.secondary" }}>{labels[index]}</Button>)}
        </Stack>
        {/* PORCH-076: the header user switcher rides the shell header's top
            right on every breakpoint — the one page control added to the
            trimmed headers. The component renders nothing without an opened
            identity, so the front states carry no switcher anywhere. */}
        <UserSwitcher {...props} />
      </Toolbar>
    </AppBar>}
    <Container maxWidth={false} sx={{ maxWidth: 1180, px: { xs: 2, lg: 4 }, pt: 4, pb: frontDoor ? 4 : { xs: 13, lg: 6 } }}>
      {offline && <Alert severity="warning" sx={{ mb: 2 }}>A family server is unreachable. Saved moments may be out of date.</Alert>}
      {!offline && membershipEnded && <Alert severity="warning" sx={{ mb: 2 }} action={<Button color="inherit" size="small" onClick={() => navigate("/settings")}>Open Settings</Button>}>
        This device's connection ended. Saved moments remain on this device. Ask your family's owner for a device link — opening it here reconnects this device.
      </Alert>}
      {!frontDoor && networkLoaded && !network && identity && <Alert severity="info" sx={{ mb: 2 }} action={<Button color="inherit" size="small" onClick={() => navigate("/setup")}>Continue</Button>}>Porch setup is not finished on this hub yet.</Alert>}
      {page}
    </Container>
    {!frontDoor && <Paper elevation={0} sx={{ display: { xs: "block", lg: "none" }, position: "fixed", left: 0, bottom: 0, right: 0, zIndex: 10, borderTop: "1px solid", borderColor: "divider", pb: "env(safe-area-inset-bottom)" }}>
      <BottomNavigation showLabels value={primary.findIndex((path) => route.startsWith(path))} onChange={(_event, value) => value === 2 ? setComposeOpen(true) : navigate(primary[value])} sx={{ minHeight: 68 }}>
        {primary.map((path, index) => <BottomNavigationAction key={path} label={labels[index]} icon={icons[index]}
          sx={{ ...(index === 2
            ? { "& .MuiSvgIcon-root": { bgcolor: "secondary.main", color: "var(--porch-amber-ink)", width: 52, height: 52, p: 1.5, borderRadius: "50%", transform: "translateY(-8px)", boxShadow: "var(--porch-shadow-compose)" } }
            : { minWidth: 44 }), ...(route.startsWith(path) ? { "&::before": { content: '""', position: "absolute", top: 6, left: "50%", transform: "translateX(-50%)", width: 24, height: 2, borderRadius: 1, bgcolor: "secondary.main" } } : {}) }} />)}
      </BottomNavigation>
    </Paper>}
    <Compose open={composeOpen} onClose={() => setComposeOpen(false)} {...props} />
    <Dialog open={newDevices.length > 0 && newDevices[0]?.did === identity?.id} onClose={() => setNewDevices((pending) => pending.slice(1))}>
      <DialogTitle>A new device was just connected</DialogTitle>
      <DialogContent><Typography>{newDevices[0]?.label || "A device"} was connected to your place in this family. If you do not recognize it, remove it now.</Typography></DialogContent>
      <DialogActions>
        <Button onClick={() => setNewDevices((pending) => pending.slice(1))}>This was me</Button>
        <Button color="error" onClick={async () => {
          try {
            await actions.removeDevice(newDevices[0]._id);
            setNewDevices((pending) => pending.slice(1));
          } catch { setNotice("The hub could not remove this device. Try again from Settings."); }
        }}>No, remove it</Button>
      </DialogActions>
    </Dialog>
    <InstallCta kind={installHidden ? null : installKind} onInstall={installNow} onDismiss={dismissInstall} />
    <Snackbar open={Boolean(notice)} autoHideDuration={8000} onClose={() => setNotice("")} message={notice} />
  </ThemeProvider>;
}

createRoot(document.getElementById("root")).render(<App />);
