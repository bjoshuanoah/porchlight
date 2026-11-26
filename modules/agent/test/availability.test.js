// PORCH-148 ac-3: withheld-profile full closure (Brian's availability
// ruling): a member's request or self-assignment is refused with plain
// language; member-facing surfaces list/select it nowhere; admin assignment
// of the same profile still runs (provenance confirms); a parental enable
// attempt is refused fail closed; every flip audited.

import { test } from "node:test";
import assert from "node:assert/strict";

import { makeAgentHub } from "./helpers/fixture.js";

const FAMILIES = [{ _id: "fam_1", name: "Noah", parentIdentityRefs: ["did:porch:parent"], memberIdentityRefs: ["did:porch:kid"] }];

async function setup() {
  const hub = makeAgentHub({ admins: ["did:porch:admin"], families: FAMILIES });
  const mod = hub.mod;
  const admin = "did:porch:admin";
  const premium = await mod.profileService.define({
    actorDid: admin,
    isAdmin: true,
    name: "Premium",
    providerClass: "local-server",
    modelId: "premium-model",
    memberSelectable: false,
  });
  const kids = await mod.profileService.define({
    actorDid: admin,
    isAdmin: true,
    name: "Kids model",
    providerClass: "native-mlx",
    modelId: "gemma4:e2b-mlx",
  });
  return { hub, mod, admin, premium, kids };
}

test("the member-facing selection surface never lists the withheld profile — its existence never leaks", async () => {
  const { mod, premium, kids } = await setup();
  const selectable = await mod.profileService.memberList();
  const serialized = JSON.stringify(selectable);
  assert.ok(!serialized.includes(premium._id), "the withheld profile's id appears nowhere");
  assert.ok(!serialized.includes("Premium"), "the withheld profile's name appears nowhere");
  assert.deepEqual(
    selectable.map((p) => p.profileId).sort(),
    [kids._id].sort(),
  );
  // The admin list still sees it — the gate is member-facing only.
  const adminRows = await mod.profileService.adminList();
  assert.ok(adminRows.some((p) => p._id === premium._id));
});

test("a member's self-assignment attempt is refused with plain language, survives every retry, and lands an audit row", async () => {
  const { mod, premium } = await setup();
  const attempt = () => mod.assignmentService.selfAssign({ actorDid: "did:porch:kid", profileId: premium._id });
  await assert.rejects(attempt, (error) => {
    assert.equal(error.code, "E_PROFILE_UNAVAILABLE");
    assert.match(error.message, /The hub admin has not made this profile available to members\./);
    return true;
  });
  // The withholding survives EVERY member-side attempt.
  await assert.rejects(attempt, /not made this profile available/);
  await assert.rejects(attempt, /not made this profile available/);
  const trail = await mod.auditService.list({ limit: 50 });
  const refusals = trail.rows.filter((r) => r.type === "profile-self-assign-refused" && r.outcome === "denied" && r.detail.profileId === premium._id);
  assert.equal(refusals.length, 3, "each attempt is audited");
  // Nothing landed: no assignment row for the member.
  const assignments = await mod.assignmentService.list({});
  assert.deepEqual(assignments.rows.filter((r) => r.target?.memberId === "did:porch:kid"), []);
});

test("admin assignment of the same withheld profile still runs — provenance confirms", async () => {
  const { mod, premium, admin } = await setup();
  const row = await mod.assignmentService.assign({ actorDid: admin, isAdmin: true, target: { memberId: "did:porch:kid" }, profileId: premium._id });
  assert.equal(row.profileRef, premium._id);

  const inference = mod.createProfileInference({
    providers: { "local-server": { name: "premium-provider", providerClass: "local-server", complete: async () => ({ text: "premium answer" }) } },
  });
  const response = await inference.complete({ memberId: "did:porch:kid", messages: [], tools: [] });
  assert.equal(response.profileId, premium._id);
  const provenance = await mod.provenanceService.forMember({ memberId: "did:porch:kid" });
  assert.equal(provenance.rows[0].profileRef, premium._id);
  assert.equal(provenance.rows[0].modelId, "premium-model");
});

test("a parental attempt to enable the withheld profile is refused fail closed with plain language — nothing lands, and the refusal is audited", async () => {
  const { mod, premium, kids } = await setup();
  await assert.rejects(
    () =>
      mod.assignmentService.parentalSet({
        actorDid: "did:porch:parent",
        familyId: "fam_1",
        memberId: "did:porch:kid",
        profileIds: [kids._id, premium._id],
      }),
    (error) => {
      assert.equal(error.code, "E_PROFILE_UNAVAILABLE");
      assert.match(error.message, /withheld "Premium" from member availability — a family cannot re-enable it\./);
      return true;
    },
  );
  // Fail closed: NOTHING landed — not even the permitted valid profile.
  const narrowing = await mod.assignmentService.narrowingFor("did:porch:kid");
  assert.equal(narrowing, null);
  const trail = await mod.auditService.list({ limit: 50 });
  assert.ok(trail.rows.some((r) => r.type === "parental-narrowing-refused" && r.outcome === "denied" && r.detail.reasons?.[0] === "Premium is withheld by the hub admin"));
});

test("a parent who is not a parent of the member's family cannot narrow; a valid narrowing write is audited and published", async () => {
  const { mod, kids } = await setup();
  await assert.rejects(
    () => mod.assignmentService.parentalSet({ actorDid: "did:porch:stranger", familyId: "fam_1", memberId: "did:porch:kid", profileIds: [kids._id] }),
    /Only a parent of this family/,
  );
  await assert.rejects(
    () => mod.assignmentService.parentalSet({ actorDid: "did:porch:parent", familyId: "fam_wrong", memberId: "did:porch:kid", profileIds: [kids._id] }),
    /Only a parent of this family/,
  );
  const set = await mod.assignmentService.parentalSet({
    actorDid: "did:porch:parent",
    familyId: "fam_1",
    memberId: "did:porch:kid",
    profileIds: [kids._id],
  });
  assert.deepEqual(set.permittedProfileRefs, [kids._id]);
  const trail = await mod.auditService.list({ limit: 50 });
  assert.ok(trail.rows.some((r) => r.type === "parental-narrowing" && r.actorIdentityRef === "did:porch:parent" && r.outcome === "recorded"));
});

test("the admin availability flip lands its own audited row (who, from, to)", async () => {
  const { hub, mod, kids, premium, admin } = await setup();
  const flipped = await mod.profileService.updateAvailability({ actorDid: admin, isAdmin: true, profileId: kids._id, memberSelectable: false });
  assert.equal(flipped.memberSelectable, false);
  const trail = await mod.auditService.list({ limit: 50 });
  const flip = trail.rows.find((r) => r.type === "profile-availability" && r.detail.profileId === kids._id);
  assert.equal(flip.actorIdentityRef, admin);
  assert.equal(flip.detail.from, true);
  assert.equal(flip.detail.to, false);
  // A member no longer lists the now-withheld profile either (the gate IS the
  // schema field — never a parallel control).
  const selectable = JSON.stringify(await mod.profileService.memberList());
  assert.ok(!selectable.includes(kids._id) && !selectable.includes(premium._id));
  await assert.rejects(
    () => mod.profileService.updateAvailability({ actorDid: "did:porch:member", isAdmin: false, profileId: kids._id, memberSelectable: true }),
    /Only the hub admin/,
  );
  // The flip publishes for live-apply.
  assert.ok(hub.events.some((e) => e.type === "profile-changed" && e.profileId === kids._id));
});

test("members elsewhere in the family are unaffected by another family's narrowing", async () => {
  const { mod, kids } = await setup();
  await mod.assignmentService.assign({ actorDid: "did:porch:admin", isAdmin: true, target: { memberId: "did:porch:bob" }, profileId: kids._id });
  await mod.assignmentService.parentalSet({ actorDid: "did:porch:parent", familyId: "fam_1", memberId: "did:porch:kid", profileIds: [kids._id] });
  const bob = await mod.resolutionService.resolve({ memberId: "did:porch:bob", agentType: "household-member" });
  assert.equal(bob.state, "resolved", "a narrowing documents only its member");
});
