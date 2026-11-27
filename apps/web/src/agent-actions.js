// PORCH-150: the Agent tab's wire half — one `request(connection, "agent/…")`
// per action over the family model-profile surfaces. The agent module rides
// the hub's SAME identity perimeter as the family organizer: every call uses
// the SAME open identity's own session token (the home-actions
// identityConnection pattern — never the home module's device signing), the
// hub verifies each session and refuses anything beyond it with plain
// language the screens render verbatim. All screen-testable logic lives in
// agent-model.js. No parallel enforcement, ever: every write rides
// PORCH-148's one assignment path.

import { request } from "./api.js";

const enc = encodeURIComponent;

function identityConnection(active) {
  if (!active?.url || !active.identityToken || !active.identity?.id) {
    throw new Error("Open your connected identity on this device first.");
  }
  return { ...active, token: active.identityToken };
}

export function createAgentActions({ active } = {}) {
  const connection = () => identityConnection(active);

  return {
    // The member-facing surface of record: which model is running (per the
    // never-silent law) and the profiles a member may select — withheld
    // profiles render nowhere by the hub's own projection.
    loadMyModel: () => request(connection(), "agent/me/model"),
    loadSelectableProfiles: () => request(connection(), "agent/me/profiles"),
    chooseModel: (profileId) => request(connection(), "agent/me/model", {
      method: "POST", body: JSON.stringify({ profileId }),
    }),

    // The hub-admin surface: profile definitions with provider class and
    // model named; the availability flip (memberSelectable); assignments to
    // an agent type or member with the explicit unassigned state; revocation.
    loadAdminProfiles: () => request(connection(), "agent/profiles"),
    defineProfile: (profile) => request(connection(), "agent/profiles", {
      method: "POST",
      body: JSON.stringify({
        name: profile?.name ?? "",
        providerClass: profile?.providerClass ?? "",
        modelId: profile?.modelId ?? "",
        endpointRef: (profile?.endpointRef ?? "") || null,
        memberSelectable: profile?.memberSelectable !== false,
      }),
    }),
    setProfileAvailability: (profileId, memberSelectable) =>
      request(connection(), `agent/profiles/${enc(profileId)}/availability`, {
        method: "PUT", body: JSON.stringify({ memberSelectable: Boolean(memberSelectable) }),
      }),
    loadAssignments: ({ agentType } = {}) =>
      request(connection(), `agent/assignments${agentType ? `?agentType=${enc(agentType)}` : ""}`),
    assignProfile: (target, profileId) => request(connection(), "agent/assignments", {
      method: "POST", body: JSON.stringify({ target, profileId }),
    }),
    revokeAssignment: (assignmentId) =>
      request(connection(), `agent/assignments/${enc(assignmentId)}`, { method: "DELETE" }),

    // The family organizer's narrowing surface — the ONE parental write
    // (rendered by FamilyCard in home.jsx via these same actions; no parental
    // profile control exists anywhere else).
    loadNarrowing: (familyId, memberId) =>
      request(connection(), `agent/families/${enc(familyId)}/members/${enc(memberId)}/permitted-profiles`),
    setNarrowing: (familyId, memberId, profileIds) =>
      request(connection(), `agent/families/${enc(familyId)}/members/${enc(memberId)}/permitted-profiles`, {
        method: "POST", body: JSON.stringify({ profileIds: Array.isArray(profileIds) ? profileIds : [] }),
      }),
  };
}
