import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { ThemeProvider } from "@mui/material/styles";
import { AppBar, Alert, BottomNavigation, BottomNavigationAction, Button, Container, CssBaseline, Dialog, DialogActions, DialogContent, DialogTitle, IconButton, Paper, Snackbar, Stack, Toolbar, Typography } from "@mui/material";
import HomeOutlined from "@mui/icons-material/HomeOutlined";
import GroupsOutlined from "@mui/icons-material/GroupsOutlined";
import AddOutlined from "@mui/icons-material/AddOutlined";
import PersonOutline from "@mui/icons-material/PersonOutline";
import SearchOutlined from "@mui/icons-material/SearchOutlined";
import { themeFor, tokenStyles, lightTokens, darkTokens } from "./theme.js";
import { readStoredMode, writeStoredMode, resolveMode } from "./mode.js";
// PORCH-055: the signed-out marker and boot routing for the device front state.
import { bootRoute, readSignedOut, markSignedOut, clearSignedOut } from "./front-state.js";
import { fullName } from "./setup-state.js";
import { request, loadFeeds, setUnauthorizedHandler, connectionForPostOrigin } from "./api.js";
import { cachedTimeline, hiddenPosts, hidePost, connectionsStorageKey, readConnections, readLocal, saveConnections, saveTimeline, unhidePost, writeLocal } from "./store.js";
import { createCustody } from "./session-sync.js";
import { reCredentialPlanes } from "./session-credentials.js";
import { createDeviceRegistration, openDeviceSession, getDeviceKey, getDeviceJwk, signDeviceMessage } from "./device.js";
import { resolveStoredNames } from "./name-heal.js";
import { publishPost, publishReply, publishReaction, unpublishReaction, publishVote, uploadOriginals, exportOriginals, mentionCandidates as fetchMentionCandidates, resolvePreview } from "./member-actions.js";
import { firstUrlIn } from "./link-preview.js";
import { waitUntilHubHealthy } from "./update.js";
import { arrivalPollMs } from "./live.js";
import { applyFeedCompensation, captureFeedAnchor, createScrollMemory } from "./scroll.js";
import { registerMediaTransport, syncMediaTransport } from "./media-transport.js";
import { Timeline, Groups, PostDetail, Compose, Albums, Uploads, Search } from "./social.jsx";
import { Join, Profile, Pair, DeviceLink, WhoIsHere, OwnerConsole, Members, Setup, hasLocalPin, AUDIT_PAGE } from "./identity.jsx";
import { Lockup } from "./brand.jsx";
// PORCH-051: the Add to Home Screen machinery — the decision logic module
// and its two surfaces (the Android custom CTA, the iOS guided card).
import { consumeInstallPrompt, installSuppressed, isStandaloneLaunch, surfaceInstallKind, webkitClass } from "./install.js";
import { InstallCta } from "./install.jsx";

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
const localIdentities = [...new Set(initialConnections.map((item) => item.identity?.id).filter(Boolean))];
const primary = ["/timeline", "/groups", "/compose", "/profile"];
const labels = ["Timeline", "Groups", "Compose", "Profile"];
const icons = [<HomeOutlined />, <GroupsOutlined />, <AddOutlined />, <PersonOutline />];

function routeOf() {
  // PORCH-055: the zero-open-sessions front state rides the client-local
  // signed-out marker; grant consumption (a join link on the chooser)
  // wins over the front state and routes into its flow immediately.
  return bootRoute({
    pathname: window.location.pathname,
    search: window.location.search,
    connections: initialConnections,
    signedOut: readSignedOut(stored, origin),
    pinned: initialConnections.some(hasLocalPin),
  });
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
  const [ranked, setRanked] = useState([]);
  const [hidden, setHidden] = useState(() => localIdentities.length === 1 ? hiddenPosts(stored, `${origin}:${localIdentities[0]}`) : new Set());
  const [offline, setOffline] = useState(false);
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
  const [newDevices, setNewDevices] = useState([]);
  const active = identity ? connections.find((item) => item.identity?.id === identity.id) : null;
  const activeIdentityId = active?.identity?.id ?? null;
  const identityConnections = identity ? connections.filter((item) => item.identity?.id === identity.id && item.token) : [];
  const renewRef = useRef(null);
  const signedOut = useRef(false);
  useEffect(() => {
    custody.setRenew(({ did }) => renewRef.current?.({ did }));
    // Recovered tokens must land in React state immediately: the next 15s
    // poll presents the published token instead of 401ing into recovery
    // again (the wake-after-throttle case with no storage event received).
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
  const renew = useCallback(async ({ did = null } = {}) => {
    const live = readConnections(stored, origin);
    const target = live.find((item) => item.identity?.id === (did || identity?.id));
    if (!target?.deviceId || !target.identity?.id) return false;
    // Cross-tab freshness gate: another tab's renewal younger than half the
    // gate window keeps every presented token inside the 10-minute TTL, so
    // skip the supersession and let that tab's publication ride adoption.
    if (Date.now() - (target.renewedAt || 0) < renewFreshMs) return false;
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
      setPosts(result.posts);
      saveTimeline(stored, `${origin}:${identity?.id}`, result.posts);
    } else if (noticeText && unreachable) setNotice(noticeText);
    setRanked(result.ranked);
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
    const result = identityConnections.length ? await loadFeeds(identityConnections) : { posts: [], ranked: [], failures: [] };
    applyFeeds(result, { notice: "Your family server is unreachable. Showing saved moments where available." });
    const [groupResult, memberResult, inviteResult, limitResult, diskResult, auditResult, deviceResult, allDevicesResult, linksResult, updateResult, mediaRootResult] = await Promise.allSettled([
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
      availability: {
        groups: groupResult.status === "fulfilled", members: memberResult.status === "fulfilled",
        invites: inviteResult.status === "fulfilled", settings: limitResult.status === "fulfilled",
        disk: diskResult.status === "fulfilled", audit: auditResult.status === "fulfilled",
        devices: deviceResult.status === "fulfilled",
        allDevices: allDevicesResult.status === "fulfilled", deviceLinks: linksResult.status === "fulfilled",
        update: updateResult.status === "fulfilled", mediaRoot: mediaRootResult.status === "fulfilled",
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
  // Live arrival (PORCH-046 ac-1): new posts land without a manual refresh.
  // The hub carries no realtime event surface yet (the PORCH-047 companion),
  // so this is the REST-refresh degrade: a background full read at a fixed
  // cadence, only while the tab is visible and never on scroll, applied
  // through applyFeeds so arriving content reflects in place and the
  // reading place is compensated (no scroll-jack). Poll failures stay
  // quiet — the next tick and the offline surfaces name the connection.
  const arrivingRef = useRef(false);
  useEffect(() => {
    if (!identity?.id) return undefined;
    const arrived = async () => {
      if (document.hidden || document.visibilityState !== "visible" || arrivingRef.current) return;
      // PORCH-050: while a dead credential names its recovery route, the
      // arrival loop pauses — a poll that only re-renders the same 401s is
      // console spam, never progress. A renewal that re-credentials clears
      // the flag (renew/applyFeeds), and the loop resumes.
      if (membershipEndedRef.current) return;
      arrivingRef.current = true;
      try {
        const live = readConnections(stored, origin);
        const liveConnections = live.filter((item) => item.identity?.id === identity.id && item.token);
        if (liveConnections.length) {
          applyFeeds(await loadFeeds(liveConnections));
        }
      } catch { /* the next scheduled arrival rides again */ }
      finally { arrivingRef.current = false; }
    };
    const timer = setInterval(() => void arrived(), arrivalPollMs);
    const visible = () => { if (document.visibilityState === "visible") void arrived(); };
    document.addEventListener("visibilitychange", visible);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", visible);
    };
  }, [identity, applyFeeds]);
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
  useEffect(() => {
    if (!active?.identityToken) return undefined;
    const check = async () => {
      // PORCH-050: a revoked registration or genuinely dead identity session
      // cannot be fixed by polling — recovery runs through the owner-routed
      // device link. Pause the 15s poll in that state instead of writing the
      // same 401 into the console every tick; a successful renewal (fresh
      // mint) or an identity switch clears the flag and the poll resumes.
      if (identityEndedRef.current) return;
      try {
        const result = await request({ ...active, token: active.identityToken }, "identity/devices");
        observeDevices(result.registrations || [], active);
        setOwner((current) => ({ ...current, devices: result.registrations || [], availability: { ...current.availability, devices: true } }));
      } catch (error) {
        if (error?.status === 401) identityEndedRef.current = true;
        setOwner((current) => ({ ...current, availability: { ...current.availability, devices: false } }));
      }
    };
    const timer = setInterval(() => void check(), 15_000);
    return () => clearInterval(timer);
  }, [active, observeDevices]);

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
    setPosts(cachedTimeline(stored, `${origin}:${registration.did}`));
    setRanked([]);
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
    setPosts(cachedTimeline(stored, `${origin}:${did}`));
    setRanked([]);
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
      setPosts(cachedTimeline(stored, `${origin}:${id}`));
      setRanked([]);
      setHidden(hiddenPosts(stored, `${origin}:${id}`));
      navigate("/timeline");
    },
    // Explicit sign-out / Switch (PORCH-055): the turn closes here and the
    // next open renders the WhoIsHere front state, never a half-open app.
    signOut: () => {
      signedOut.current = true;
      markSignedOut(stored, origin);
      setIdentity(null);
      setPosts([]);
      setRanked([]);
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
          const restored = await request(hub, "social/session/restore", {
            method: "POST", body: JSON.stringify({ identityAccessToken: session.accessToken, deviceId: registration.deviceId }),
          });
          const first = restored?.sessions?.[0];
          if (first) {
            const revised = connections.map((item) => item === ownerConnection
              ? { ...item, identityToken: session.accessToken, identityRefreshToken: session.refreshToken, token: first.accessToken, refreshToken: first.refreshToken, networkId: first.networkId, name: result.network?.name || item.name }
              : item);
            saveConnections(stored, origin, revised);
            setConnections(revised);
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
    createGroup: async (name) => {
      const result = await request(active, "social/groups", { method: "POST", body: JSON.stringify({ name }) });
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
    groupMemberCandidates: (q = "") => fetchMentionCandidates(active, q),
    search: (query) => request(active, `social/search?q=${encodeURIComponent(query)}`),
    // Rendition transport readiness (PORCH-044): true once the auth-relaying
    // rendition worker is live — surfaces then load rendition URLs directly
    // (srcset/sizes, video poster/src) and the browser cache answers repeats.
    mediaTransport,
  }), [hidden, connections, active, identity, navigate, reload, posts, network, mediaTransport]);

  const data = {
    posts, ranked, groups, albums: [], connections, network: { name: active?.name || network?.name || null, id: active?.networkId || network?._id },
    identity, members: owner.members, devices: owner.devices, settings: owner.settings,
    invites: owner.invites, audit: owner.audit, disk: owner.disk, availability: owner.availability,
    allDevices: owner.allDevices, deviceLinks: owner.deviceLinks, update: owner.update,
    mediaRoot: owner.mediaRoot,
    server: { name: active?.name || "Your family's Porchlight", url: active?.url || origin }, offline, membershipEnded,
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
      const byId = new Map(updates.map((item) => [item.id, item.name]));
      const current = readConnections(stored, origin);
      const revised = current.map((item) => byId.has(item.identity?.id)
        ? { ...item, identity: { ...item.identity, name: byId.get(item.identity.id) } }
        : item);
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
  else if (route === "/profile") page = <Profile {...props} />;
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
        <IconButton aria-label="Search family moments" onClick={() => navigate("/search")}><SearchOutlined /></IconButton>
      </Toolbar>
    </AppBar>}
    <Container maxWidth={false} sx={{ maxWidth: 1180, px: { xs: 2, lg: 4 }, pt: 4, pb: frontDoor ? 4 : { xs: 13, lg: 6 } }}>
      {offline && <Alert severity="warning" sx={{ mb: 2 }}>A family server is unreachable. Saved moments may be out of date.</Alert>}
      {!offline && membershipEnded && <Alert severity="warning" sx={{ mb: 2 }} action={<Button color="inherit" size="small" onClick={() => navigate("/profile")}>Open Profile</Button>}>
        This device's connection ended. Saved moments remain on this device. Ask your family's owner for a device link — opening it here reconnects this device.
      </Alert>}
      {!frontDoor && networkLoaded && !network && identity && <Alert severity="info" sx={{ mb: 2 }} action={<Button color="inherit" size="small" onClick={() => navigate("/setup")}>Continue</Button>}>Porch setup is not finished on this hub yet.</Alert>}
      {sharedDevice && !frontDoor && <Button size="small" onClick={() => actions.signOut()}>Switch person</Button>}
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
          } catch { setNotice("The hub could not remove this device. Try again from Profile."); }
        }}>No, remove it</Button>
      </DialogActions>
    </Dialog>
    <InstallCta kind={installHidden ? null : installKind} onInstall={installNow} onDismiss={dismissInstall} />
    <Snackbar open={Boolean(notice)} autoHideDuration={8000} onClose={() => setNotice("")} message={notice} />
  </ThemeProvider>;
}

createRoot(document.getElementById("root")).render(<App />);
