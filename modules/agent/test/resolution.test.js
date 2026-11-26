// PORCH-148 ac-2: the resolution chain of record — admin availability gate,
// then parental narrowing, then type/member assignment, enforced in ONE
// resolution function with no parallel path.

import { test } from "node:test";
import assert from "node:assert/strict";

import { makeAgentHub } from "./helpers/fixture.js";

const FAMILIES = [{ _id: "fam_1", name: "Noah", parentIdentityRefs: ["did:porch:parent"], memberIdentityRefs: ["did:porch:kid"] }];

async function setup({ withheld = false } = {}) {
  const { mod, sign: _sign } = makeAgentHub({ admins: ["did:porch:admin"], families: FAMILIES });
  const admin = "did:porch:admin";
  const profile = await mod.profileService.define({
    actorDid: admin,
    isAdmin: true,
    name: withheld ? "Premium" : "Kids model",
    providerClass: "local-server",
    modelId: withheld ? "premium-model" : "glm-5.3",
    memberSelectable: !withheld,
  });
  return { mod, admin, profile };
}

test("member-specific assignment wins for that member; the type default applies to other members", async () => {
  const { mod, admin, profile } = await setup();
  const alt = await mod.profileService.define({ actorDid: admin, isAdmin: true, name: "Type default", providerClass: "openai-spec", modelId: "glm-5.3:cloud" });
  await mod.assignmentService.assign({ actorDid: admin, isAdmin: true, target: { agentType: "household-member" }, profileId: alt._id });
  await mod.assignmentService.assign({ actorDid: admin, isAdmin: true, target: { memberId: "did:porch:alice" }, profileId: profile._id });

  const alice = await mod.resolutionService.resolve({ memberId: "did:porch:alice", agentType: "household-member" });
  assert.equal(alice.state, "resolved");
  assert.equal(alice.profile._id, profile._id, "member-specific wins");
  assert.equal(alice.source, "member");

  const bob = await mod.resolutionService.resolve({ memberId: "did:porch:bob", agentType: "household-member" });
  assert.equal(bob.state, "resolved");
  assert.equal(bob.profile._id, alt._id, "the type default applies to members without their own assignment");
  assert.equal(bob.source, "type");
});

test("an agent type with no assignment resolves the explicit UNASSIGNED state — never a silent default model", async () => {
  const { mod } = await setup();
  const resolved = await mod.resolutionService.resolve({ memberId: "did:porch:alice", agentType: "household-member" });
  assert.equal(resolved.state, "unassigned");
  assert.match(resolved.reason, /No model profile is assigned/);
  const listing = await mod.assignmentService.list({ agentType: "household-member" });
  assert.equal(listing.state, "unassigned");
  assert.match(listing.detail, /No profile is assigned to this agent type/);
});

test("the chain's order: a withheld profile rides ONLY an admin-sourced assignment — the gate is never on the admin's own assignment power", async () => {
  const { mod, admin, profile } = await setup({ withheld: true });
  const none = await mod.resolutionService.resolve({ memberId: "did:porch:kid", agentType: "household-member" });
  assert.equal(none.state, "unassigned", "nothing to resolve before any gate applies");

  await mod.assignmentService.assign({ actorDid: admin, isAdmin: true, target: { memberId: "did:porch:kid" }, profileId: profile._id });
  const adminSourced = await mod.resolutionService.resolve({ memberId: "did:porch:kid", agentType: "household-member" });
  assert.equal(adminSourced.state, "resolved");
  assert.equal(adminSourced.adminSourced, true);
  assert.equal(adminSourced.profile._id, profile._id, "admin assignment of the withheld profile still runs");
});

test("the chain's order: within the available set the parental narrowing outranks the assignment — a narrowed member runs only parent-permitted profiles", async () => {
  const { mod, admin, profile } = await setup();
  const other = await mod.profileService.define({ actorDid: admin, isAdmin: true, name: "Type default", providerClass: "openai-spec", modelId: "glm-5.3:cloud" });
  await mod.assignmentService.assign({ actorDid: admin, isAdmin: true, target: { agentType: "household-member" }, profileId: other._id });

  const before = await mod.resolutionService.resolve({ memberId: "did:porch:kid", agentType: "household-member" });
  assert.equal(before.state, "resolved", "no narrowing: the type default applies");

  // The parent narrows their member to {profile} — the type default is then
  // outside the permitted set.
  await mod.assignmentService.parentalSet({
    actorDid: "did:porch:parent",
    familyId: "fam_1",
    memberId: "did:porch:kid",
    profileIds: [profile._id],
  });
  const kid = await mod.resolutionService.resolve({ memberId: "did:porch:kid", agentType: "household-member" });
  assert.equal(kid.state, "parental-blocked");
  assert.match(kid.reason, /family settings do not include/);

  // Members outside that family are unaffected.
  const stranger = await mod.resolutionService.resolve({ memberId: "did:porch:bob", agentType: "household-member" });
  assert.equal(stranger.state, "resolved");
  assert.equal(stranger.profile._id, other._id);
});

test("the ONE resolution function: every inference and the member surface read compose the same chain — no parallel path", async () => {
  const { mod, admin, profile } = await setup();
  const alt = await mod.profileService.define({ actorDid: admin, isAdmin: true, name: "Alt", providerClass: "openai-spec", modelId: "glm-5.3:cloud" });
  await mod.assignmentService.assign({ actorDid: admin, isAdmin: true, target: { agentType: "household-member" }, profileId: alt._id });
  await mod.assignmentService.assign({ actorDid: admin, isAdmin: true, target: { memberId: "did:porch:alice" }, profileId: profile._id });

  let resolveCalls = 0;
  const original = mod.resolutionService.resolve.bind(mod.resolutionService);
  mod.resolutionService.resolve = async (input) => {
    resolveCalls++;
    return original(input);
  };

  const inference = mod.createProfileInference({
    providers: {
      "local-server": { name: "ollama", providerClass: "local-server", complete: async () => ({ text: "x" }) },
      "openai-spec": { name: "spec", providerClass: "openai-spec", complete: async () => ({ text: "y" }) },
      "native-mlx": { name: "mlx", providerClass: "native-mlx", complete: async () => ({ text: "z" }) },
    },
  });
  await inference.complete({ memberId: "did:porch:alice", messages: [], tools: [] });
  const afterInference = resolveCalls;
  assert.ok(afterInference >= 1, "inference rode resolve()");

  const view = await mod.resolutionService.memberModelView({
    memberId: "did:porch:alice",
    agentType: "household-member",
    provenance: mod.provenanceService,
  });
  assert.equal(view.state, "running");
  assert.deepEqual(view.model, { modelId: "glm-5.3", providerClass: "local-server" });
  assert.ok(resolveCalls > afterInference, "the member surface read resolved through the same resolve() the inference rode");
});
