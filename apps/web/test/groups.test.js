// Group management view helpers (PORCH-030, Oct 14 2026 follow-up): the
// Groups page's create / Members view / add-members mappings, deterministic
// without a DOM.
import { test } from "node:test";
import assert from "node:assert/strict";
import { groupRows, groupMemberRows, canManageGroup, addableCandidates } from "../src/groups.js";

const NET = "net_family";
const identity = (id, name) => ({ id, name });

test("groupRows: only the member's own origin renders, named first, then by id", () => {
  const groups = [
    { _id: "grp_b", networkId: NET, name: "Zucchini club", members: [] },
    { _id: "grp_a", networkId: NET, name: "Boat Club", members: [] },
    { _id: "grp_x", networkId: "net_other", name: "Foreign", members: [] },
  ];
  const rows = groupRows(groups, NET);
  assert.deepEqual(rows.map((group) => group._id), ["grp_a", "grp_b"]);
  // No bound network known (an older hub read, say): nothing is dropped.
  assert.equal(groupRows(groups, null).length, 3);
  // Roster-less garbage never becomes a card.
  assert.equal(groupRows([null, {}, null, ...groups], NET).length, 2);
});

test("groupMemberRows: the roster renders the hub's read-time names, ids only as fallback", () => {
  const group = {
    members: ["did:owner", "did:cass", "did:ghost"],
    names: { "did:owner": "Brian Rivers", "did:cass": null },
  };
  assert.deepEqual(groupMemberRows(group), [
    { did: "did:owner", name: "Brian Rivers" },
    { did: "did:cass", name: null },
    { did: "did:ghost", name: null },
  ]);
  // Unresolved dids — a group made before the name surface — never render
  // an invented name.
  assert.deepEqual(groupMemberRows({ members: ["did:owner"] }), [{ did: "did:owner", name: null }]);
});

test("canManageGroup: the creator manages their group; the owner too; others do not", () => {
  const group = { createdBy: "did:cass", members: ["did:cass"] };
  const cass = { identity: identity("did:cass") };
  assert.equal(canManageGroup(group, cass), true, "creator manages the group they made");
  assert.equal(canManageGroup(group, { identity: identity("did:devon") }), false, "a member who is neither creator nor owner does not");
  assert.equal(canManageGroup(group, {}), false);
  assert.equal(canManageGroup(null, cass), false);
  // The network owner retains the authority; the roster the SPA holds for
  // an owner is the console list with roles.
  const ownerRoster = { members: [{ did: "did:owner", role: "owner" }] };
  const owner = { identity: identity("did:owner") };
  assert.equal(canManageGroup({ createdBy: "did:cass" }, { ...owner, ...ownerRoster }), true);
  // A plain member with no owner row does not ride the owner gate.
  assert.equal(canManageGroup({ createdBy: "did:cass" }, { identity: identity("did:devon"), members: [{ did: "did:devon", role: "member" }] }), false);
});

test("addableCandidates: origin candidates minus the group's existing membership", () => {
  const group = { members: ["did:cass", "did:devon"], names: {} };
  const candidates = [
    { did: "did:pip", name: "Pip Larkin", role: "member" },
    { did: "did:devon", name: "Devon Mills", role: "member" },
    { did: "did:new", name: null, role: "member" },
  ];
  assert.deepEqual(addableCandidates(candidates, group), [
    { did: "did:pip", name: "Pip Larkin", role: "member" },
    { did: "did:new", name: null, role: "member" },
  ]);
  // Everyone already in the group means the picker says so, not an empty list crash.
  assert.deepEqual(addableCandidates([{ did: "did:cass" }], group), []);
});