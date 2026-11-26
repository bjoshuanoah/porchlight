// PORCH-137: the Home tab's wire half — one `request(connection, "home/…")`
// per action, signed writes riding the device signing (the same
// member-actions shape: Ed25519 base64url over the canonical payload, the
// body `{ payload, signature }`, the did/deviceId from the open connection
// row). All screen-testable logic lives in home-model.js.

import { request } from "./api.js";
import { signDevicePayload } from "./device.js";

const enc = encodeURIComponent;

function requireConnection(active) {
  if (!active?.url || !active.token || !active.identity?.id || !active.deviceId) {
    throw new Error("Connect this device to your family's hub to manage your home.");
  }
  return active;
}

export function createHomeActions(active, { navigate: _navigate } = {}) {
  // The Home tab does not route on its own (switching homes swaps the view
  // in place); navigate is accepted for action-factory parity and left
  // unused deliberately.
  const sign = async (payload) => {
    const connection = requireConnection(active);
    return signDevicePayload(new URL(connection.url).origin, connection.identity.id, connection.deviceId, payload);
  };

  async function signed(path, payload, method = "POST") {
    const connection = requireConnection(active);
    const signature = await sign(payload);
    return request(connection, path, { method, body: JSON.stringify({ payload, signature }) });
  }

  // The identity plane (family organizer) rides the SAME open identity's
  // own session token — the established pattern for identity/… writes in
  // this app (device.js, main.jsx) — never the home module's device signing.
  function identityConnection() {
    if (!active?.url || !active.identityToken || !active.identity?.id) {
      throw new Error("Open your connected identity on this device first.");
    }
    return { ...active, token: active.identityToken };
  }

  function jsonPost(path, body) {
    return request(identityConnection(), path, { method: "POST", body: JSON.stringify(body) });
  }

  return {
    loadHomes: () => request(requireConnection(active), "home/homes"),

    createHome: (name) => signed("home/homes", { name: String(name ?? "").trim() }),

    renameHome: (homeId, name) => signed(
      `home/homes/${enc(homeId)}`,
      { name: String(name ?? "").trim() },
      "PUT",
    ),

    loadHome: (homeId) => request(requireConnection(active), `home/homes/${enc(homeId)}`),

    createArea: (homeId, { name, kind, order } = {}) => signed(
      `home/homes/${enc(homeId)}/areas`,
      order == null ? { name, kind } : { name, kind, order },
    ),

    renameArea: (areaId, patch = {}) => signed(`home/areas/${enc(areaId)}`, patch, "PUT"),

    registerDevice: (homeId, { name, areaId, capabilities, adapter } = {}) => signed(
      `home/homes/${enc(homeId)}/devices`,
      { name, areaId, capabilities: Array.isArray(capabilities) ? capabilities : [], adapter },
    ),

    updateDevice: (deviceId, patch = {}) => signed(`home/devices/${enc(deviceId)}`, patch, "PUT"),

    refreshDeviceState: (homeId, deviceId) => request(
      requireConnection(active),
      `home/homes/${enc(homeId)}/devices/${enc(deviceId)}/state`,
    ),

    // The contract answers 200 confirmed / 502 E_DEVICE_UNREACHABLE (the
    // throw carries the device row on `body`) / 403 E_NOT_PERMITTED. The
    // screen classifies on `failure.code` — the machine never flips to
    // confirmed from anything but this resolved response.
    sendDeviceCommand: (deviceId, command) => signed(`home/devices/${enc(deviceId)}/command`, { command }),

    runScene: (sceneId) => request(requireConnection(active), `home/scenes/${enc(sceneId)}/run`, { method: "POST" }),

    createScene: (homeId, { name, actions } = {}) => signed(
      `home/homes/${enc(homeId)}/scenes`,
      { name, actions: Array.isArray(actions) ? actions : [] },
    ),

    createAutomation: (homeId, { name, trigger, actions, enabled } = {}) => signed(
      `home/homes/${enc(homeId)}/automations`,
      {
        name,
        trigger,
        actions: Array.isArray(actions) ? actions : [],
        ...(enabled === undefined ? {} : { enabled: enabled === true }),
      },
    ),

    updateAutomation: (automationId, patch = {}) => signed(`home/automations/${enc(automationId)}`, patch, "PUT"),

    loadAudit: (homeId, { limit, offset } = {}) => {
      const params = new URLSearchParams();
      if (limit != null) params.set("limit", String(limit));
      if (offset != null) params.set("offset", String(offset));
      const suffix = params.toString() ? `?${params.toString()}` : "";
      return request(requireConnection(active), `home/homes/${enc(homeId)}/audit${suffix}`);
    },

    // Grants (PORCH-138): the owner's Access surface of record, the signed
    // visit write, the early revoke, and the acting parent's envelope
    // distribution. Exactly one of granteeDid / familyId names the visit.
    loadGrants: (homeId) => request(requireConnection(active), `home/homes/${enc(homeId)}/grants`),

    createGrant: ({ homeId, granteeDid, familyId, scopes, expiresAt } = {}) => signed(
      `home/homes/${enc(homeId)}/grants`,
      {
        ...(familyId ? { familyId: String(familyId) } : { granteeDid: String(granteeDid ?? "") }),
        scopes: Array.isArray(scopes) ? scopes : [],
        expiresAt,
      },
    ),

    revokeGrant: ({ grantId } = {}) => signed(`home/grants/${enc(grantId)}/revoke`, {}),

    distributeGrant: ({ grantId, memberIdentityRef, scopes } = {}) => signed(
      `home/grants/${enc(grantId)}/distributions`,
      {
        memberIdentityRef: String(memberIdentityRef ?? ""),
        scopes: Array.isArray(scopes) ? scopes : [],
      },
    ),

    // Families (PORCH-138): the session-bound organizer surface — identity-plane
    // JSON writes, deliberately NOT device-signed.
    loadFamilies: () => request(identityConnection(), "identity/families"),

    createFamily: ({ name, parentIdentityRefs, memberIdentityRefs } = {}) => jsonPost("identity/families", {
      name: String(name ?? "").trim(),
      ...(Array.isArray(parentIdentityRefs)
        ? { parentIdentityRefs: parentIdentityRefs.map((did) => String(did).trim()).filter(Boolean) }
        : {}),
      ...(Array.isArray(memberIdentityRefs)
        ? { memberIdentityRefs: memberIdentityRefs.map((did) => String(did).trim()).filter(Boolean) }
        : {}),
    }),

    addFamilyMember: (familyId, did) => jsonPost(`identity/families/${enc(familyId)}/members`, { did: String(did ?? "").trim() }),

    removeFamilyMember: (familyId, did) => jsonPost(`identity/families/${enc(familyId)}/members/remove`, { did: String(did ?? "").trim() }),

    addFamilyParent: (familyId, did) => jsonPost(`identity/families/${enc(familyId)}/parents`, { did: String(did ?? "").trim() }),

    removeFamilyParent: (familyId, did) => jsonPost(`identity/families/${enc(familyId)}/parents/remove`, { did: String(did ?? "").trim() }),
  };
}
