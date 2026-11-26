// PORCH-148 ac-5: never-silent degradation — when the assigned profile's
// provider cannot answer, the state is NAMED: the failure is recorded on the
// provenance trail, the session and admin surfaces carry it, and no model
// fallback happens beyond an explicitly configured, rendered fallback
// (safetyFields.fallbackProfileRef).

import { test } from "node:test";
import assert from "node:assert/strict";

import { AgentRuntime } from "@porchlight/agent-runtime";

import { makeAgentHub } from "./helpers/fixture.js";

async function setup({ fallback = false } = {}) {
  const hub = makeAgentHub({ admins: ["did:porch:admin"] });
  const { mod } = hub;
  const admin = "did:porch:admin";
  const primary = await mod.profileService.define({
    actorDid: admin,
    isAdmin: true,
    name: "Primary GLM",
    providerClass: "local-server",
    modelId: "glm-5.3",
  });
  let fallbackProfile = null;
  if (fallback) {
    fallbackProfile = await mod.profileService.define({
      actorDid: admin,
      isAdmin: true,
      name: "Kids MLX",
      providerClass: "native-mlx",
      modelId: "gemma4:e2b-mlx",
    });
    await mod.profileService.profiles.updateOne({ _id: primary._id }, { $set: { safetyFields: { fallbackProfileRef: fallbackProfile._id } } });
  }
  const runtime = new AgentRuntime({
    inference: mod.createProfileInference({
      providers: {
        "local-server": { name: "ollama", providerClass: "local-server", complete: async () => { throw new Error("connection refused"); } },
        "native-mlx": { name: "mlx", providerClass: "native-mlx", complete: async ({ modelId }) => ({ text: `answered ${modelId}` }) },
        "openai-spec": { name: "spec", providerClass: "openai-spec", complete: async ({ modelId }) => ({ text: `answered ${modelId}` }) },
      },
      log: (memberId, line) => runtime.logLine(memberId, line),
    }),
  });
  await mod.assignmentService.assign({ actorDid: admin, isAdmin: true, target: { agentType: "household-member" }, profileId: primary._id });
  return { mod, runtime, admin, primary, fallbackProfile };
}

test("a provider that cannot answer names the degraded state on the session and admin surfaces — no silent fallback", async () => {
  const { mod, runtime, primary } = await setup();
  const entity = runtime.agentFor("did:porch:alice");
  await assert.rejects(
    () => entity.runTurn({ text: "hello" }),
    (error) => {
      assert.equal(error.code, "E_PROVIDER_DEGRADED");
      assert.match(error.message, /provider \(local-server model glm-5\.3\) could not answer: connection refused/);
      return true;
    },
  );
  // The degradation is recorded (admin mirror: the provenance trail).
  const trail = await mod.provenanceService.forMember({ memberId: "did:porch:alice" });
  assert.equal(trail.total, 1);
  assert.equal(trail.rows[0].degraded.reason.includes("connection refused"), true);
  assert.equal(trail.rows[0].modelId, null, "no model answer is claimed");

  // The session surface names the degraded state explicitly.
  const view = await mod.resolutionService.memberModelView({ memberId: "did:porch:alice", agentType: "household-member", provenance: mod.provenanceService });
  assert.equal(view.state, "degraded");
  assert.match(view.reason, /could not answer/);
  assert.equal(view.fallback, null, "no fallback is claimed where none is configured");
  // The resolution of record never silently switched models.
  const resolved = await mod.resolutionService.resolve({ memberId: "did:porch:alice", agentType: "household-member" });
  assert.equal(resolved.profile._id, primary._id);
  assert.equal(view.model.providerClass, "local-server");
});

test("no provider implementation configured for the resolved class names its own explicit state", async () => {
  const hub = makeAgentHub({ admins: ["did:porch:admin"] });
  const { mod } = hub;
  const admin = "did:porch:admin";
  const profile = await mod.profileService.define({ actorDid: admin, isAdmin: true, name: "Premium", providerClass: "openai-spec", modelId: "gpt-6" });
  await mod.assignmentService.assign({ actorDid: admin, isAdmin: true, target: { memberId: "did:porch:alice" }, profileId: profile._id });
  const inference = mod.createProfileInference({ providers: { "local-server": { name: "ollama", providerClass: "local-server", complete: async () => ({ text: "x" }) } } });
  await assert.rejects(
    () => inference.complete({ memberId: "did:porch:alice", messages: [], tools: [] }),
    (error) => {
      assert.equal(error.code, "E_PROVIDER_UNCONFIGURED");
      assert.match(error.message, /No provider implementation is configured for this profile's class \(openai-spec\)/);
      return true;
    },
  );
  const trail = await mod.provenanceService.forMember({ memberId: "did:porch:alice" });
  assert.match(trail.rows[0].degraded.reason, /openai-spec/);
});

test("an explicitly configured, rendered fallback rides when the primary is down — provenance marks it as a fallback, never silent", async () => {
  const { mod, runtime, primary } = await setup({ fallback: true });
  const entity = runtime.agentFor("did:porch:alice");
  const result = await entity.runTurn({ text: "hello" });
  assert.equal(result.provenance.providerClass, "native-mlx", "the fallback's class answered");
  assert.match(result.text, /gemma4:e2b-mlx/);
  const logs = runtime.logsForMember("did:porch:alice").map((l) => l.line);
  assert.ok(logs.some((l) => l.includes("fallback profile Kids MLX") && l.includes("primary provider down, fallback explicitly configured")), "the fallback ride is rendered as a fallback in the agent's own log");

  const trail = await mod.provenanceService.forMember({ memberId: "did:porch:alice" });
  const fallbackRows = trail.rows.filter((r) => r.fallback);
  assert.equal(fallbackRows.length, 1, "the fallback ride is provenance-marked");
  assert.equal(fallbackRows[0].fallback.profileId !== primary._id, true);

  // The member surface names the degraded primary state AND the explicit
  // fallback — nothing renders as a silent model switch.
  const view = await mod.resolutionService.memberModelView({ memberId: "did:porch:alice", agentType: "household-member", provenance: mod.provenanceService });
  assert.equal(view.state, "degraded");
  assert.match(view.reason, /Running the explicitly configured fallback \(Kids MLX\)/);
  assert.equal(view.fallback.profileName, "Kids MLX");
});

test("a failed or self-referential fallback preference never silently degrades the answer", async () => {
  const { mod, runtime } = await setup({ fallback: true });
  // Point the fallback at a profile that does not exist → no fallback ride.
  const resolved = await mod.resolutionService.resolve({ memberId: "did:porch:alice", agentType: "household-member" });
  await mod.profileService.profiles.updateOne({ _id: resolved.profile._id }, { $set: { safetyFields: { fallbackProfileRef: "iprofile_missing" } } });
  await assert.rejects(
    () => runtime.agentFor("did:porch:alice").runTurn({ text: "hi" }),
    (error) => {
      assert.equal(error.code, "E_PROVIDER_DEGRADED");
      assert.match(error.message, /configured fallback profile does not exist/);
      return true;
    },
  );
  const trail = await mod.provenanceService.forMember({ memberId: "did:porch:alice" });
  assert.ok(trail.rows.every((r) => r.fallback === null), "nothing rode a fallback");
});
