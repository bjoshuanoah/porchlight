import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { ThemeProvider } from "@mui/material/styles";
import { AppBar, Alert, BottomNavigation, BottomNavigationAction, Button, Container, CssBaseline, Dialog, DialogActions, DialogContent, DialogTitle, IconButton, Paper, Snackbar, Stack, Toolbar, Typography } from "@mui/material";
import HomeOutlined from "@mui/icons-material/HomeOutlined";
import GroupsOutlined from "@mui/icons-material/GroupsOutlined";
import AddOutlined from "@mui/icons-material/AddOutlined";
import PersonOutline from "@mui/icons-material/PersonOutline";
import SearchOutlined from "@mui/icons-material/SearchOutlined";
import { theme } from "./theme.js";
import { readJoinQuery } from "./frontdoor.js";
import { fullName } from "./setup-state.js";
import { request, loadFeeds, setUnauthorizedHandler, connectionForPostOrigin } from "./api.js";
import { cachedTimeline, hiddenPosts, hidePost, connectionsStorageKey, readConnections, readLocal, saveConnections, saveTimeline, unhidePost, writeLocal } from "./store.js";
import { createCustody } from "./session-sync.js";
import { createDeviceRegistration, openDeviceSession, getDeviceKey, getDeviceJwk, signDeviceMessage } from "./device.js";
import { resolveStoredNames } from "./name-heal.js";
import { publishPost, publishReply, publishReaction, unpublishReaction, publishVote, uploadOriginals, exportOriginals, mentionCandidates as fetchMentionCandidates } from "./member-actions.js";
import { waitUntilHubHealthy } from "./update.js";
import { Timeline, Groups, PostDetail, Compose, Albums, Uploads, Search } from "./social.jsx";
import { Join, Profile, Pair, DeviceLink, WhoIsHere, OwnerConsole, Members, Setup, hasLocalPin } from "./identity.jsx";
import { Lockup } from "./brand.jsx";

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
  if (window.location.pathname !== "/") return window.location.pathname;
  // An invite riding the query string at the served root is the front door,
  // never the timeline: keep the search alive so Join reads it (PORCH-023).
  if (localIdentities.length === 0 && readJoinQuery(window.location.search)) return "/join";
  return localIdentities.length > 1 || initialConnections.some(hasLocalPin) ? "/who-is-here" : localIdentities.length ? "/timeline" : "/join";
}
function App() {
  const [route, setRoute] = useState(routeOf);
  const [connections, setConnections] = useState(initialConnections);
  const [posts, setPosts] = useState(() => localIdentities.length === 1 && !initialConnections.some(hasLocalPin) ? cachedTimeline(stored, `${origin}:${localIdentities[0]}`) : []);
  const [ranked, setRanked] = useState([]);
  const [hidden, setHidden] = useState(() => localIdentities.length === 1 ? hiddenPosts(stored, `${origin}:${localIdentities[0]}`) : new Set());
  const [offline, setOffline] = useState(false);
  const [notice, setNotice] = useState("");
  const [composeOpen, setComposeOpen] = useState(false);
  const [identity, setIdentity] = useState(() => localIdentities.length === 1 && !initialConnections.some(hasLocalPin) ? initialConnections[0].identity || null : null);
  const [groups, setGroups] = useState([]);
  const [owner, setOwner] = useState({ members: [], invites: [], devices: [], allDevices: null, deviceLinks: null, settings: {}, audit: [], disk: null, update: null, availability: {} });
  const [network, setNetwork] = useState(null);
  const [networkLoaded, setNetworkLoaded] = useState(false);
  const [newDevices, setNewDevices] = useState([]);
  const active = identity ? connections.find((item) => item.identity?.id === identity.id) : null;
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

  const navigate = useCallback((path) => {
    const next = path.startsWith("/") ? path : `/${path}`;
    if (next === "/compose") { setComposeOpen(true); return; }
    window.history.pushState({}, "", next);
    setRoute(next);
    window.scrollTo(0, 0);
  }, []);
  useEffect(() => { const pop = () => setRoute(routeOf()); window.addEventListener("popstate", pop); return () => window.removeEventListener("popstate", pop); }, []);
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
    let membershipFailed = false;
    try {
      const identitySession = await openDeviceSession(next, { did: next.identity.id, deviceId: next.deviceId }, request);
      next.identityToken = identitySession.accessToken;
      next.identityRefreshToken = identitySession.refreshToken;
      const membershipRefreshToken = next.refreshToken ?? next.membershipRefreshToken;
      if (membershipRefreshToken) {
        try {
          const membership = await request({ url: next.url }, "social/session/refresh", {
            method: "POST", body: JSON.stringify({ refreshToken: membershipRefreshToken }),
          });
          next.token = membership.accessToken;
          next.refreshToken = membership.refreshToken ?? next.refreshToken;
        } catch {
          // Membership refresh failed; the identity tokens are still live, so
          // publish them but leave renewedAt unstamped so the next renewal can
          // re-credential the membership plane too.
          membershipFailed = true;
        }
      }
      // Founder binding rides restore (PORCH-018): a connection without a
      // membership token yet — a fresh owner connection, or any hub where
      // the owner was bootstrapped before binding existed — re-credentials
      // silently with the device key and comes back holding network tokens.
      if (!next.token && next.deviceId) {
        try {
          const restored = await request({ url: next.url }, "social/session/restore", {
            method: "POST", body: JSON.stringify({ identityAccessToken: next.identityToken, deviceId: next.deviceId }),
          });
          const first = restored?.sessions?.[0];
          if (first) {
            next.token = first.accessToken;
            next.refreshToken = first.refreshToken;
            next.networkId = first.networkId;
            // PORCH-034 second round: the name rides every restore, so a
            // renewed founder connection heals device-local naming too.
            if (first.name) next.identity.name = first.name;
          }
        } catch { /* no membership row yet: the plain notice below names it */ }
      }
      next.renewedAt = membershipFailed ? undefined : Date.now();
      const revised = live.map((item) => item.identity?.id === target.identity.id ? next : item);
      saveConnections(stored, origin, revised);
      setConnections(revised);
      return true;
    } catch {
      setOffline(true);
      return false;
    }
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
  const reload = useCallback(async () => {
    if (!identity?.id) return;
    const live = readConnections(stored, origin);
    const liveActive = live.find((item) => item.identity?.id === identity.id) || null;
    if (!liveActive) return;
    const identityConnections = live.filter((item) => item.identity?.id === identity.id && item.token);
    const result = identityConnections.length ? await loadFeeds(identityConnections) : { posts: [], ranked: [], failures: [] };
    setOffline(result.failures.length > 0);
    if (!result.failures.length) {
      setPosts(result.posts);
      saveTimeline(stored, `${origin}:${identity.id}`, result.posts);
    } else setNotice("Your family server is unreachable. Showing saved moments where available.");
    setRanked(result.ranked);
    const [groupResult, memberResult, inviteResult, limitResult, diskResult, auditResult, deviceResult, allDevicesResult, linksResult, updateResult] = await Promise.allSettled([
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
      availability: {
        groups: groupResult.status === "fulfilled", members: memberResult.status === "fulfilled",
        invites: inviteResult.status === "fulfilled", settings: limitResult.status === "fulfilled",
        disk: diskResult.status === "fulfilled", audit: auditResult.status === "fulfilled",
        devices: deviceResult.status === "fulfilled",
        allDevices: allDevicesResult.status === "fulfilled", deviceLinks: linksResult.status === "fulfilled",
        update: updateResult.status === "fulfilled",
      },
    });
    if (deviceResult.status === "fulfilled") observeDevices(deviceResult.value.registrations || [], liveActive);
  }, [identity, observeDevices]);
  useEffect(() => {
    // First load waits for the silent renewal: an expired access token must
    // re-credential BEFORE reads, or the page would render failure states.
    void (async () => {
      if (active?.identity?.id && !signedOut.current) {
        try { await custody.renew(); } catch { /* renew sets offline state itself */ }
      }
      await reload();
    })();
  }, [reload, active, renew]);
  useEffect(() => {
    const online = () => void reload();
    window.addEventListener("online", online);
    return () => window.removeEventListener("online", online);
  }, [reload]);
  useEffect(() => {
    if (!active?.identityToken) return undefined;
    const check = async () => {
      try {
        const result = await request({ ...active, token: active.identityToken }, "identity/devices");
        observeDevices(result.registrations || [], active);
        setOwner((current) => ({ ...current, devices: result.registrations || [], availability: { ...current.availability, devices: true } }));
      } catch { setOwner((current) => ({ ...current, availability: { ...current.availability, devices: false } })); }
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
    setIdentity(next.identity);
    setPosts(cachedTimeline(stored, `${origin}:${did}`));
    setRanked([]);
    setHidden(hiddenPosts(stored, `${origin}:${did}`));
    return admitted;
  };
  const unsupported = () => { throw new Error("Your family server does not offer this action yet. No change was made."); };
  // Card- and detail-level writes resolve the post's own origin connection
  // through the shared resolver (PORCH-038 ac-4); card and detail ride one
  // routing rule, so a card write lands in the same conversation detail loads.
  const connectionForPost = (post) => connectionForPostOrigin(post, identityConnections, active);
  const actions = useMemo(() => ({
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
    getMedia: async (mediaId, kind = "feed-thumb", postOrigin = active?.url) => {
      const connection = identityConnections.find((item) => new URL(item.url).origin === postOrigin);
      if (!connection?.token) throw new Error("Connect to that family server to see this moment.");
      const path = kind === "original" ? `media/${encodeURIComponent(mediaId)}/original` : `media/${encodeURIComponent(mediaId)}/renditions/${encodeURIComponent(kind)}`;
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
    signOut: () => { signedOut.current = true; setIdentity(null); setPosts([]); setRanked([]); navigate(connections.length > 1 ? "/who-is-here" : "/timeline"); },
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
    revokeMember: async (member) => {
      const result = await request(active, "social/console/members/revoke", {
        method: "POST", body: JSON.stringify({ memberId: member._id || member.id }),
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
    react: async (post, emoji) => { const result = await publishReaction(connectionForPost(post), post, emoji); await reload(); return result; },
    unreact: async (post, emoji) => { const result = await unpublishReaction(connectionForPost(post), post, emoji); await reload(); return result; },
    submitPost: async (payload) => { const result = await publishPost(active, payload); await reload(); return result; },
    submitReply: async (post, body, parentId, mentions = []) => { const result = await publishReply(connectionForPost(post), post, body, parentId, mentions); await reload(); return result; },
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
  }), [hidden, connections, active, identity, navigate, reload, posts, network]);

  const data = {
    posts, ranked, groups, albums: [], connections, network: { name: active?.name || network?.name || null, id: active?.networkId || network?._id },
    identity, members: owner.members, devices: owner.devices, settings: owner.settings,
    invites: owner.invites, audit: owner.audit, disk: owner.disk, availability: owner.availability,
    allDevices: owner.allDevices, deviceLinks: owner.deviceLinks, update: owner.update,
    server: { name: active?.name || "Your family's Porchlight", url: active?.url || origin }, offline,
  };
  const props = { data, actions, navigate };
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
    // Signed-out-but-registered device: a fresh app open re-credentials
    // silently into the timeline (no wall). An explicit sign-out keeps the
    // turn closed until the next visit.
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

  return <ThemeProvider theme={theme}><CssBaseline />
    {!frontDoor && <AppBar position="sticky" color="inherit" elevation={0} sx={{ borderBottom: "1px solid", borderColor: "divider", backdropFilter: "blur(12px)", background: "rgba(255,255,255,.96)" }}>
      <Toolbar sx={{ minHeight: { xs: 56, lg: 64 }, maxWidth: 1180, width: "100%", mx: "auto", px: { xs: 2, lg: 4 } }}>
        {/* Brand lockup (PORCH-032): the new lamp mark plus the navy wordmark. */}
        <Lockup onClick={() => navigate("/timeline")} size={30} sx={{ cursor: "pointer", flex: { xs: 1, lg: 0 }, minWidth: { lg: 180 } }} />
        <Stack direction="row" spacing={3} alignItems="center" sx={{ display: { xs: "none", lg: "flex" }, flex: 1, justifyContent: "center" }}>
          {primary.map((path, index) => index === 2
            ? <IconButton key={path} aria-label="Compose" onClick={() => setComposeOpen(true)} sx={{ bgcolor: "secondary.main", boxShadow: "0 6px 18px rgba(216,138,36,.28)", "&:hover": { bgcolor: "secondary.dark" } }}><AddOutlined /></IconButton>
            : <Button key={path} onClick={() => navigate(path)} sx={{ color: route.startsWith(path) ? "primary.main" : "text.secondary" }}>{labels[index]}</Button>)}
        </Stack>
        <IconButton aria-label="Search family moments" onClick={() => navigate("/search")}><SearchOutlined /></IconButton>
      </Toolbar>
    </AppBar>}
    <Container maxWidth={false} sx={{ maxWidth: 1180, px: { xs: 2, lg: 4 }, pt: 4, pb: frontDoor ? 4 : { xs: 13, lg: 6 } }}>
      {offline && <Alert severity="warning" sx={{ mb: 2 }}>A family server is unreachable. Saved moments may be out of date.</Alert>}
      {!frontDoor && networkLoaded && !network && identity && <Alert severity="info" sx={{ mb: 2 }} action={<Button color="inherit" size="small" onClick={() => navigate("/setup")}>Continue</Button>}>Porch setup is not finished on this hub yet.</Alert>}
      {sharedDevice && !frontDoor && <Button size="small" onClick={() => navigate("/who-is-here")}>Switch person</Button>}
      {page}
    </Container>
    {!frontDoor && <Paper elevation={0} sx={{ display: { xs: "block", lg: "none" }, position: "fixed", left: 0, bottom: 0, right: 0, zIndex: 10, borderTop: "1px solid", borderColor: "divider", pb: "env(safe-area-inset-bottom)" }}>
      <BottomNavigation showLabels value={primary.findIndex((path) => route.startsWith(path))} onChange={(_event, value) => value === 2 ? setComposeOpen(true) : navigate(primary[value])} sx={{ minHeight: 68 }}>
        {primary.map((path, index) => <BottomNavigationAction key={path} label={labels[index]} icon={icons[index]}
          sx={{ ...(index === 2
            ? { "& .MuiSvgIcon-root": { bgcolor: "secondary.main", color: "primary.main", width: 52, height: 52, p: 1.5, borderRadius: "50%", transform: "translateY(-8px)", boxShadow: "0 6px 18px rgba(216,138,36,.28)" } }
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
    <Snackbar open={Boolean(notice)} autoHideDuration={8000} onClose={() => setNotice("")} message={notice} />
  </ThemeProvider>;
}

createRoot(document.getElementById("root")).render(<App />);
