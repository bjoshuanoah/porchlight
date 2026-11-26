// PORCH-148 ac-4: live-apply + audit — a profile swap (admin) or a parental
// narrowing change applies to the LIVE session: the next inference rides the
// new profile (provenance lines confirm), no agent restart happens, and the
// write lands an audit row.

import { test } from "node:test";
import assert from "node:assert/strict";

import { AgentRuntime } from "@porchlight/agent-runtime";

import { makeAgentHub } from "./helpers/fixture.js";

async function setup() {
  const hub = makeAgentHub({ admins: ["did:porch:admin"] });
  const { mod, events } = hub;
  const admin = "did:porch:admin";
  const glm = await mod.profileService.define({
    actorDid: admin,
    isAdmin: true,
    name: "Ollama GLM",
    providerClass: "local-server",
    modelId: "glm-5.3",
  });
  const kids = await mod.profileService.define({
    actorDid: admin,
    isAdmin: true,
    name: "Kids MLX",
    providerClass: "native-mlx",
    modelId: "gemma4:e2b-mlx",
  });
  // The profile-routed inference rides composition seam 1 — the runtime is
  // constructed ONCE, with the router as its inference seam.
  const runtime = new AgentRuntime({
    inference: mod.createProfileInference({
      providers: {
        "local-server": { name: "ollama", providerClass: "local-server", complete: async ({ modelId }) => ({ text: `answered by ${modelId}` }) },
        "native-mlx": { name: "mlx", providerClass: "native-mlx", complete: async ({ modelId }) => ({ text: `answered ${modelId}` }) },
        "openai-spec": { name: "spec", providerClass: "openai-spec", complete: async ({ modelId }) => ({ text: `spec ${modelId}` }) },
      },
      log: (memberId, line) => runtime.logLine(memberId, line),
    }),
  });
  return { mod, runtime, admin, glm, kids, events };
}

test("an admin's profile swap applies to the running session on the next inference — no restart, provenance confirms", async () => {
  const { mod, runtime, admin, glm, kids, events } = await setup();
  await mod.assignmentService.assign({ actorDid: admin, isAdmin: true, target: { memberId: "did:porch:alice" }, profileId: kids._id });

  const entity = runtime.agentFor("did:porch:alice"); // one entity per member, created before the swap
  const before = await entity.runTurn({ text: "hello" });
  assert.equal(before.provenance.providerClass, "native-mlx");
  assert.equal(before.provenance.modelId, "gemma4:e2b-mlx");
  assert.ok(runtime.logsForMember("did:porch:alice").some((l) => l.line.includes(`profile Kids MLX`) && l.line.includes(kids._id)), "the first ride's provenance log names profile identity");

  // THE SWAP: same entity, same runtime session — no restart anywhere.
  const swap = await mod.assignmentService.assign({ actorDid: admin, isAdmin: true, target: { memberId: "did:porch:alice" }, profileId: glm._id });
  assert.ok(swap._id);
  assert.ok(events.some((e) => e.type === "profile-changed" && e.memberId === "did:porch:alice"), "the swap publishes on the change seam");

  const after = await entity.runTurn({ text: "hello again" });
  assert.equal(after.provenance.providerClass, "local-server", "the next inference rides the new profile");
  assert.equal(after.provenance.modelId, "glm-5.3");
  assert.equal(after.provenance.provider, "porchlight-profile-router");
  assert.ok(runtime.logsForMember("did:porch:alice").some((l) => l.line.includes("profile Ollama GLM")));

  // Provenance of record confirms both rides, in order.
  const trail = await mod.provenanceService.forMember({ memberId: "did:porch:alice" });
  const refs = trail.rows.map((r) => r.profileRef).reverse();
  assert.deepEqual(refs, [kids._id, glm._id]);

  // The write lands an audit row (who, what, when).
  const auditTrail = await mod.auditService.list({ limit: 50 });
  const swapRow = auditTrail.rows.find((r) => r.type === "profile-assigned" && r.detail.profileId === glm._id);
  assert.equal(swapRow.actorIdentityRef, admin);
  assert.deepEqual(swapRow.detail.target, { memberId: "did:porch:alice" });
  assert.ok(runtime.refusals().length === 0);
});

test("a profile swap mid-session keeps the entity (memoized state intact) and the audit trail carries the swap", async () => {
  const { mod, runtime, admin, glm, kids } = await setup();
  await mod.assignmentService.assign({ actorDid: admin, isAdmin: true, target: { memberId: "did:porch:alice" }, profileId: kids._id });
  const entity1 = runtime.agentFor("did:porch:alice");
  await entity1.runTurn({ text: "hey" });
  await mod.assignmentService.assign({ actorDid: admin, isAdmin: true, target: { memberId: "did:porch:alice" }, profileId: glm._id });
  const entity2 = runtime.agentFor("did:porch:alice");
  assert.strictEqual(entity1, entity2, "the same agent entity serves through the swap — no agent restart");
  const memory = await entity2.memory.all();
  assert.ok(memory.length >= 2, "the member's memory stream carried through (no state rebuild)");
  const auditTrail = await mod.auditService.list({});
  const swaps = auditTrail.rows.filter((r) => r.type === "profile-assigned" && r.detail.target?.memberId === "did:porch:alice" && r.detail.source === "admin");
  assert.equal(swaps.length, 2);
  assert.ok(swaps.every((r) => r.actorIdentityRef === admin), "the swap rows carry who");
});

test("a parental narrowing change applies live: a refused profile resolves blocked on the very next inference", async () => {
  const hub = makeAgentHub({
    admins: ["did:porch:admin"],
    families: [{ _id: "fam_1", name: "Noah", parentIdentityRefs: ["did:porch:parent"], memberIdentityRefs: ["did:porch:kid"] }],
  });
  const { mod } = hub;
  const admin = "did:porch:admin";
  const kids = await mod.profileService.define({ actorDid: admin, isAdmin: true, name: "Kids", providerClass: "native-mlx", modelId: "gemma4:e2b-mlx" });
  const other = await mod.profileService.define({ actorDid: admin, isAdmin: true, name: "Other", providerClass: "local-server", modelId: "glm-5.3" });
  await mod.assignmentService.assign({ actorDid: admin, isAdmin: true, target: { memberId: "did:porch:kid" }, profileId: kids._id });

  const inference = mod.createProfileInference({ providers: {} });

  // Parent narrows the member to {kids}: the member-specific assignment (kids)
  // is inside the permitted set → it resolves and rides until the machinery
  // names the missing provider implementation (never a silent default).
  await mod.assignmentService.parentalSet({ actorDid: "did:porch:parent", familyId: "fam_1", memberId: "did:porch:kid", profileIds: [kids._id] });
  await assert.rejects(
    () => inference.complete({ memberId: "did:porch:kid", messages: [], tools: [] }),
    (error) => {
      assert.equal(error.code, "E_PROVIDER_UNCONFIGURED");
      return true;
    },
  );

  // Parent narrows to the OTHER profile: the member-specific assignment is
  // outside the permitted set → the next inference names the blocked state.
  await mod.assignmentService.parentalSet({ actorDid: "did:porch:parent", familyId: "fam_1", memberId: "did:porch:kid", profileIds: [other._id] });
  await assert.rejects(
    () => inference.complete({ memberId: "did:porch:kid", messages: [], tools: [] }),
    (error) => {
      assert.equal(error.code, "E_PARENTAL_BLOCKED");
      assert.match(error.message, /family settings do not include/);
      return true;
    },
  );
});
