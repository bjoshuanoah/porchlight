// One connection's two credential planes re-credentialed in a fixed order
// (PORCH-050): the identity plane mints fresh at every renewal (the device
// key signs a new session, superseding the prior one by design, PORCH-028);
// the membership plane first rides the cheap refresh-token rotation, and
// when refresh cannot serve — a dead refresh-token row, a superseded or
// expired session — the fresh identity token re-credentials the membership
// plane through social/session/restore (PORCH-048: restore is every member
// device's re-credential, not only the founder's).
//
// Before the restore fallback existed, a membership refresh that died for
// good left `token` expired forever: every recovery retried only refresh,
// kept unstamping `renewedAt` (each pass re-minting and superseding the
// identity session), and the app cycled through full feed reloads, devices
// polls and rendition 401s at a seconds cadence — the reported desktop
// 401/reload loop.
export async function reCredentialPlanes(connection, request, { openDeviceSession }) {
  const next = { ...connection, identity: { ...connection.identity } };
  const identitySession = await openDeviceSession(next, { did: next.identity.id, deviceId: next.deviceId }, request);
  next.identityToken = identitySession.accessToken;
  next.identityRefreshToken = identitySession.refreshToken;

  let membershipFailed = false;
  const membershipRefreshToken = next.refreshToken ?? next.membershipRefreshToken;
  if (membershipRefreshToken) {
    try {
      const membership = await request({ url: next.url }, "social/session/refresh", {
        method: "POST", body: JSON.stringify({ refreshToken: membershipRefreshToken }),
      });
      next.token = membership.accessToken;
      next.refreshToken = membership.refreshToken ?? next.refreshToken;
    } catch {
      membershipFailed = true;
    }
  }

  if ((membershipFailed || !next.token) && next.deviceId) {
    try {
      const restored = await request({ url: next.url }, "social/session/restore", {
        method: "POST", body: JSON.stringify({ identityAccessToken: next.identityToken, deviceId: next.deviceId }),
      });
      const first = restored?.sessions?.[0];
      if (first) {
        next.token = first.accessToken;
        next.refreshToken = first.refreshToken;
        next.networkId = first.networkId;
        membershipFailed = false;
        // PORCH-034 second round: the name rides every restore, so a
        // re-credential heals device-local naming to the hub-resolved
        // family-facing name.
        if (first.name) next.identity = { ...next.identity, name: first.name };
      }
    } catch { /* membershipFailed stands: the surfaces name the dead session */ }
  }
  return { connection: next, membershipFailed };
}