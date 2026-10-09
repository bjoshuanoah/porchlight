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
import { request, loadFeeds } from "./api.js";
import { cachedTimeline, hiddenPosts, hidePost, readConnections, readLocal, saveConnections, saveTimeline, unhidePost, writeLocal } from "./store.js";
import { createDeviceRegistration, openDeviceSession } from "./device.js";
import { publishPost, publishReply, publishReaction, publishVote, uploadOriginals, exportOriginals } from "./member-actions.js";
import { Timeline, Groups, PostDetail, Compose, Albums, Uploads, Search } from "./social.jsx";
import { Join, Profile, Pair, DeviceLink, WhoIsHere, OwnerConsole, hasLocalPin } from "./identity.jsx";

const origin = window.location.origin;
const stored = window.localStorage;
const initialConnections = readConnections(stored, origin);
const localIdentities = [...new Set(initialConnections.map((item) => item.identity?.id).filter(Boolean))];
const primary = ["/timeline", "/groups", "/compose", "/profile"];
const labels = ["Timeline", "Groups", "Compose", "Profile"];
const icons = [<HomeOutlined />, <GroupsOutlined />, <AddOutlined />, <PersonOutline />];

function routeOf() { return window.location.pathname === "/" ? (localIdentities.length > 1 || initialConnections.some(hasLocalPin) ? "/who-is-here" : localIdentities.length ? "/timeline" : "/join") : window.location.pathname; }
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
  const [owner, setOwner] = useState({ members: [], invites: [], devices: [], settings: {}, audit: [], disk: null, availability: {} });
  const [network, setNetwork] = useState(null);
  const [newDevices, setNewDevices] = useState([]);
  const active = identity ? connections.find((item) => item.identity?.id === identity.id) : null;
  const identityConnections = identity ? connections.filter((item) => item.identity?.id === identity.id && item.token) : [];
  const lastRenewed = useRef(new Map());
  const signedOut = useRef(false);
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
    request({ url: origin }, "social/network").then((result) => setNetwork(result.network || null)).catch(() => {});
  }, []);
  const renew = useCallback(async () => {
    if (!active?.identity?.id) return;
    const next = { ...active };
    try {
      const identitySession = await openDeviceSession(next, { did: next.identity.id, deviceId: next.deviceId }, request);
      next.identityToken = identitySession.accessToken;
      next.identityRefreshToken = identitySession.refreshToken;
      if (next.membershipRefreshToken) {
        const membership = await request({ url: next.url }, "social/session/refresh", {
          method: "POST", body: JSON.stringify({ refreshToken: next.membershipRefreshToken }),
        });
        next.token = membership.accessToken;
      }
      const revised = connections.map((item) => item === active ? next : item);
      saveConnections(stored, origin, revised);
      setConnections(revised);
    } catch {
      setOffline(true);
    }
  }, [active, connections]);
  useEffect(() => {
    if (!active?.identity?.id) return undefined;
    const key = `${active.url}:${active.identity.id}`;
    if (Date.now() - (lastRenewed.current.get(key) || 0) > 8 * 60 * 1000) {
      lastRenewed.current.set(key, Date.now());
      void renew();
    }
    const timer = setInterval(() => void renew(), 8 * 60 * 1000);
    const visible = () => { if (document.visibilityState === "visible") void renew(); };
    document.addEventListener("visibilitychange", visible);
    return () => { clearInterval(timer); document.removeEventListener("visibilitychange", visible); };
  }, [active, renew]);

  const reload = useCallback(async () => {
    if (!active) return;
    const result = identityConnections.length ? await loadFeeds(identityConnections) : { posts: [], ranked: [], failures: [] };
    setOffline(result.failures.length > 0);
    if (!result.failures.length) {
      setPosts(result.posts);
      saveTimeline(stored, `${origin}:${active.identity?.id}`, result.posts);
    } else setNotice("Your family server is unreachable. Showing saved moments where available.");
    setRanked(result.ranked);
    const [groupResult, memberResult, inviteResult, limitResult, diskResult, auditResult, deviceResult] = await Promise.allSettled([
      request(active, "social/console/groups"), request(active, "social/console/members"),
      request(active, "social/console/invites"), request(active, "social/console/limits"),
      request(active, "social/console/disk"), request(active, "social/console/audit"),
      request({ ...active, token: active.identityToken }, "identity/devices"),
    ]);
    const value = (result, fallback) => result.status === "fulfilled" ? result.value : fallback;
    setGroups(value(groupResult, {}).groups || []);
    setOwner({
      members: value(memberResult, {}).members || [], invites: value(inviteResult, {}).invites || [],
      settings: value(limitResult, {}), disk: value(diskResult, null),
      audit: value(auditResult, {}).events || [], devices: value(deviceResult, {}).registrations || [],
      availability: {
        groups: groupResult.status === "fulfilled", members: memberResult.status === "fulfilled",
        invites: inviteResult.status === "fulfilled", settings: limitResult.status === "fulfilled",
        disk: diskResult.status === "fulfilled", audit: auditResult.status === "fulfilled",
        devices: deviceResult.status === "fulfilled",
      },
    });
    if (deviceResult.status === "fulfilled") observeDevices(deviceResult.value.registrations || [], active);
  }, [active, connections, observeDevices]);
  useEffect(() => { void reload(); }, [reload]);
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
    const next = {
      url: origin, name: active?.name || "Your family",
      identity: { id: registration.did, name: registration.label || "Family member" },
      identityToken: session.accessToken, identityRefreshToken: session.refreshToken,
      deviceId: registration.deviceId, token: null,
    };
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
  const unsupported = () => { throw new Error("Your family server does not offer this action yet. No change was made."); };
  const connectionForPost = (post) =>
    identityConnections.find((item) => new URL(item.url).origin === post?.origin) || active;
  const actions = useMemo(() => ({
    isHidden: (post) => hidden.has(`${post.origin || origin}:${post._id || post.id}`),
    hide: (post) => setHidden(hidePost(stored, `${origin}:${identity?.id}`, `${post.origin || origin}:${post._id || post.id}`)),
    hiddenItems: () => [...hidden],
    showPost: (key) => setHidden(unhidePost(stored, `${origin}:${identity?.id}`, key)),
    loadReactions: async (post) => {
      const result = await request(connectionForPost(post), `social/posts/${encodeURIComponent(post._id || post.id)}/reactions`);
      // Only the emoji values render: who reacted never leaves this surface.
      return [...new Set((result.reactions || []).map((row) => row.emoji).filter(Boolean))];
    },
    getMedia: async (mediaId, kind = "feed-thumb", postOrigin = active?.url) => {
      const connection = identityConnections.find((item) => new URL(item.url).origin === postOrigin);
      if (!connection?.token) throw new Error("Connect to that family server to see this moment.");
      const path = kind === "original" ? `media/${encodeURIComponent(mediaId)}/original` : `media/${encodeURIComponent(mediaId)}/renditions/${encodeURIComponent(kind)}`;
      const response = await fetch(new URL(`/api/social/${path}`, connection.url), { headers: { authorization: `Bearer ${connection.token}` } });
      if (!response.ok) throw new Error(`This moment could not be loaded (${response.status}).`);
      return response.blob();
    },
    join: async ({ url, code }) => {
      const hub = new URL(url);
      const response = await request({ url: hub.origin }, `social/join/verify?code=${encodeURIComponent(code)}`);
      if (!response.valid) {
        const error = new Error("This invite cannot be used.");
        error.code = response.code;
        throw error;
      }
      // The public join endpoint verifies an invite but requires an existing
      // identity session to admit it. Verification cannot create membership.
      const error = new Error(`The invite for ${response.network?.name || "this family"} is valid, but this hub cannot finish membership on a new device yet.`);
      error.code = "E_ADMISSION_UNAVAILABLE";
      throw error;
    },
    switchIdentity: async (id) => {
      const next = connections.find((item) => item.identity?.id === id);
      if (!next) throw new Error("This person is not connected on this device.");
      const session = await openDeviceSession(next, { did: id, deviceId: next.deviceId }, request);
      const updated = connections.map((item) => item === next ? { ...item, identityToken: session.accessToken, identityRefreshToken: session.refreshToken } : item);
      saveConnections(stored, origin, updated);
      setConnections(updated);
      setIdentity(next.identity);
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
    updateSettings: async (settings) => { const result = await request(active, "social/console/limits", { method: "PUT", body: JSON.stringify(settings) }); await reload(); return result; },
    revokeMember: async (member) => {
      const result = await request(active, "social/console/members/revoke", {
        method: "POST", body: JSON.stringify({ memberId: member._id || member.id }),
      });
      await reload();
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
    sendDeviceLink: unsupported,
    vote: async (post, value) => { const result = await publishVote(connectionForPost(post), post, value); await reload(); return result; },
    react: async (post, emoji) => { const result = await publishReaction(connectionForPost(post), post, emoji); await reload(); return result; },
    submitPost: async (payload) => { const result = await publishPost(active, payload); await reload(); return result; },
    submitReply: async (post, body, parentId, mentions = []) => { const result = await publishReply(connectionForPost(post), post, body, parentId, mentions); await reload(); return result; },
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
    loadGroup: (id) => request(active, `social/timeline/groups/${encodeURIComponent(id)}`),
    search: (query) => request(active, `social/search?q=${encodeURIComponent(query)}`),
  }), [hidden, connections, active, identity, navigate, reload, posts]);

  const data = {
    posts, ranked, groups, albums: [], connections, network: { name: active?.name || network?.name || null, id: active?.networkId || network?._id },
    identity, members: owner.members, devices: owner.devices, settings: owner.settings,
    invites: owner.invites, audit: owner.audit, disk: owner.disk, availability: owner.availability,
    server: { name: active?.name || "Your family's Porchlight", url: active?.url || origin }, offline,
  };
  const props = { data, actions, navigate };
  const sharedDevice = new Set(connections.map((item) => item.identity?.id).filter(Boolean)).size > 1;
  const chooseIdentity = (sharedDevice || connections.some(hasLocalPin)) && !identity;
  const frontDoor = route === "/join" || route.startsWith("/join/") || route === "/pair" || route === "/device-link" || route === "/who-is-here" || chooseIdentity || !connections.length;
  useEffect(() => {
    // Signed-out-but-registered device: a fresh app open re-credentials
    // silently into the timeline (no wall). An explicit sign-out keeps the
    // turn closed until the next visit.
    if (signedOut.current || identity || frontDoor) return;
    const solo = connections.length === 1 && connections[0]?.identity?.id && !connections.some(hasLocalPin);
    if (!solo) return;
    actions.switchIdentity(connections[0].identity.id).catch(() => setOffline(true));
  }, [identity, connections, frontDoor, actions.switchIdentity]);
  let page;
  if (chooseIdentity && !["/join", "/pair", "/device-link"].includes(route)) page = <WhoIsHere {...props} />;
  else
  if (route === "/join" || route.startsWith("/join/")) page = <Join {...props} />;
  else if (route === "/pair") page = <Pair {...props} />;
  else if (route === "/device-link") page = <DeviceLink {...props} />;
  else if (route === "/who-is-here") page = <WhoIsHere {...props} />;
  else if (route === "/profile") page = <Profile {...props} />;
  else if (route === "/groups" || route.startsWith("/groups/")) page = <Groups {...props} id={route.split("/")[2]} />;
  else if (route.startsWith("/posts/")) page = <PostDetail {...props} id={route.split("/")[2]} />;
  else if (route === "/albums" || route.startsWith("/albums/")) page = <Albums {...props} id={route.split("/")[2]} />;
  else if (route === "/search") page = <Search {...props} />;
  else if (route === "/owner") page = <OwnerConsole {...props} />;
  else if (!connections.length) page = <Join {...props} />;
  else page = <Timeline {...props} />;

  return <ThemeProvider theme={theme}><CssBaseline />
    {!frontDoor && <AppBar position="sticky" color="inherit" elevation={0} sx={{ borderBottom: "1px solid", borderColor: "divider", backdropFilter: "blur(12px)", background: "rgba(255,255,255,.96)" }}>
      <Toolbar sx={{ minHeight: { xs: 56, lg: 64 }, maxWidth: 1180, width: "100%", mx: "auto", px: { xs: 2, lg: 4 } }}>
        <Typography variant="h6" onClick={() => navigate("/timeline")} sx={{ fontWeight: 700, color: "primary.main", cursor: "pointer", flex: { xs: 1, lg: 0 }, minWidth: { lg: 180 } }}>☀ Porchlight</Typography>
        <Stack direction="row" spacing={3} alignItems="center" sx={{ display: { xs: "none", lg: "flex" }, flex: 1, justifyContent: "center" }}>
          {primary.map((path, index) => index === 2
            ? <IconButton key={path} aria-label="Compose" onClick={() => setComposeOpen(true)} sx={{ bgcolor: "secondary.main", "&:hover": { bgcolor: "secondary.dark" } }}><AddOutlined /></IconButton>
            : <Button key={path} onClick={() => navigate(path)} sx={{ color: route.startsWith(path) ? "primary.main" : "text.secondary" }}>{labels[index]}</Button>)}
        </Stack>
        <IconButton aria-label="Search family moments" onClick={() => navigate("/search")}><SearchOutlined /></IconButton>
      </Toolbar>
    </AppBar>}
    <Container maxWidth={false} sx={{ maxWidth: 1180, px: { xs: 2, lg: 4 }, pt: 4, pb: frontDoor ? 4 : { xs: 13, lg: 6 } }}>
      {offline && <Alert severity="warning" sx={{ mb: 2 }}>A family server is unreachable. Saved moments may be out of date.</Alert>}
      {sharedDevice && !frontDoor && <Button size="small" onClick={() => navigate("/who-is-here")}>Switch person</Button>}
      {page}
    </Container>
    {!frontDoor && <Paper elevation={0} sx={{ display: { xs: "block", lg: "none" }, position: "fixed", left: 0, bottom: 0, right: 0, zIndex: 10, borderTop: "1px solid", borderColor: "divider", pb: "env(safe-area-inset-bottom)" }}>
      <BottomNavigation showLabels value={primary.findIndex((path) => route.startsWith(path))} onChange={(_event, value) => value === 2 ? setComposeOpen(true) : navigate(primary[value])} sx={{ minHeight: 68 }}>
        {primary.map((path, index) => <BottomNavigationAction key={path} label={labels[index]} icon={icons[index]} sx={index === 2 ? { "& .MuiSvgIcon-root": { bgcolor: "secondary.main", width: 52, height: 52, p: 1.5, borderRadius: "50%", transform: "translateY(-8px)" } } : { minWidth: 44 }} />)}
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
