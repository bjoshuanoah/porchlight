// PORCH-148 ac-6: provenance + member privacy sweep — every inference call
// records the resolved profile's identity (profile, model, timestamp) and
// the member-visible surfaces carry no endpoint/token strings (the sweep
// evidence of record).

import { test } from "node:test";
import assert from "node:assert/strict";

import { AgentRuntime } from "@porchlight/agent-runtime";

import { makeAgentHub } from "./helpers/fixture.js";

async function setup() {
  const hub = makeAgentHub({ admins: ["did:porch:admin"] });
  const { mod } = hub;
  const admin = "did:porch:admin";
  const profile = await mod.profileService.define({
    actorDid: admin,
    isAdmin: true,
    name: "Ollama GLM",
    providerClass: "local-server",
    modelId: "glm-5.3",
    endpointRef: "engine:ollama-endpoint",
  });
  const runtime = new AgentRuntime({
    inference: mod.createProfileInference({
      providers: {
        "local-server": { name: "ollama", providerClass: "local-server", complete: async ({ modelId }) => ({ text: `hi from ${modelId}` }) },
        "native-mlx": { name: "mlx", providerClass: "native-mlx", complete: async ({ modelId }) => ({ text: `hi from ${modelId}` }) },
      },
      log: (memberId, line) => runtime.logLine(memberId, line),
    }),
  });
  await mod.assignmentService.assign({ actorDid: admin, isAdmin: true, target: { memberId: "did:porch:alice" }, profileId: profile._id });
  return { mod, runtime, profile };
}

test("the provenance line carries profile identity, model, and timestamp — in the agent's OWN inference logs and the module's trail", async () => {
  const { mod, runtime, profile } = await setup();
  const result = await runtime.agentFor("did:porch:alice").runTurn({ text: "hello" });
  assert.match(result.provenance.at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);

  const logs = runtime.logsForMember("did:porch:alice").map((l) => l.line);
  const profileLine = logs.find((l) => l.includes("profile Ollama GLM"));
  assert.ok(profileLine, "the agent's existing inference log carries the profile identity");
  assert.ok(profileLine.includes(`(${profile.providerClass} model ${profile.modelId})`));
  assert.ok(profileLine.includes(profile._id));

  const trail = await mod.provenanceService.forMember({ memberId: "did:porch:alice" });
  assert.equal(trail.total, 1);
  const row = trail.rows[0];
  assert.equal(row.profileRef, profile._id);
  assert.equal(row.profileName, "Ollama GLM");
  assert.equal(row.providerClass, "local-server");
  assert.equal(row.modelId, "glm-5.3");
  assert.match(row.at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
});

test("the privacy sweep: no member-visible surface carries the endpoint ref, a token, or a URL — withheld profiles never leak", async () => {
  const { mod, runtime, profile } = await setup();
  const admin = "did:porch:admin";
  await mod.profileService.define({
    actorDid: admin,
    isAdmin: true,
    name: "Premium (member withheld)",
    providerClass: "local-server",
    modelId: "premium-model",
    endpointRef: "engine:premium-endpoint",
    memberSelectable: false,
  });
  await runtime.agentFor("did:porch:alice").runTurn({ text: "hello" });

  // 1. The member surface read: what runs + provider class only.
  const view = await mod.resolutionService.memberModelView({ memberId: "did:porch:alice", agentType: "household-member", provenance: mod.provenanceService });
  const sweepView = JSON.stringify(view);
  assert.ok(!sweepView.includes("engine:ollama-endpoint"), "the endpoint ref of the running profile never appears");
  assert.ok(!sweepView.includes("premium-endpoint"), "the withheld profile's endpoint never appears");
  assert.ok(!sweepView.includes("://"), "no URL rides a member surface");
  assert.deepEqual(view.model, { modelId: "glm-5.3", providerClass: "local-server" }, "member-visible: which model, and the provider CLASS");

  // 2. The member-side records: the profile-routed provenance trail is
  //    admin-visible (the member read above is the member surface); its rows
  //    carry no endpoints either (schema note of record).
  const trail = JSON.stringify(await mod.provenanceService.forMember({ memberId: "did:porch:alice" }));
  assert.ok(!trail.includes("engine:ollama-endpoint"));
  assert.ok(!trail.includes("://"));
  assert.ok(!trail.includes(profile.endpointRef));

  // 3. The member agent's own log lines (a session surface).
  const logs = JSON.stringify(runtime.logsForMember("did:porch:alice"));
  assert.ok(!logs.includes("engine:ollama-endpoint"));
  assert.ok(!logs.includes("://"));

  // 4. The selection surface: the withheld profile's existence never leaks.
  const selectable = JSON.stringify(await mod.profileService.memberList());
  assert.ok(!selectable.includes("Premium (member withheld)"));
  assert.ok(!selectable.includes("premium-endpoint"));
});
