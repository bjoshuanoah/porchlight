// PORCH-148 ac-1: the schemas of record — InferenceProfile + ProfileAssignment,
// one schema note per element of TS 2 (6b073359549901c58e054c1b) verbatim.

import { test } from "node:test";
import assert from "node:assert/strict";

import { agentModels } from "../src/models.js";
import { makeAgentHub } from "./helpers/fixture.js";

test("the InferenceProfile schema carries TS 2's schema of record", () => {
  const schema = agentModels.inferenceProfile;
  assert.deepEqual(schema.required, ["_id", "name", "providerClass", "modelId", "memberSelectable", "createdAt"]);
  const classes = schema.properties.providerClass.enum;
  assert.deepEqual(
    classes,
    ["native-mlx", "openai-spec", "local-server"],
    "providerClass: native-mlx|openai-spec|local-server (one of the engine's compute classes per PORCH-I-009 TS 1)",
  );
  assert.deepEqual(schema.properties.endpointRef.type, ["string", "null"], "endpointRef optional; native classes use the platform's own runtime");
  assert.equal(schema.properties.memberSelectable.type, "boolean", "memberSelectable: true|false (the availability gate; admin-flippable, audited)");
  assert.deepEqual(schema.properties.safetyFields.type, "object", "safetyFields (build-defined)");
});

test("the ProfileAssignment schema carries TS 2's schema of record", () => {
  const schema = agentModels.profileAssignment;
  assert.deepEqual(schema.required, ["_id", "target", "profileRef", "assignedBy", "assignedAt"]);
  assert.deepEqual(Object.keys(schema.properties.target.properties), ["agentType", "memberId"], "target: {agentType | memberId}");
  assert.equal(schema.properties.profileRef.type, "string", "profileRef rides the profile");
  assert.equal(schema.properties.assignedBy.type, "string");
  assert.equal(schema.properties.assignedAt.type, "string");
});

test("defined profiles live with provider class and model named; the write path enforces the schema", async () => {
  const { mod, sign: _sign, events: _events } = makeAgentHub({ admins: ["did:porch:admin"] });

  const glm = await mod.profileService.define({
    actorDid: "did:porch:admin",
    isAdmin: true,
    name: "Ollama GLM",
    providerClass: "local-server",
    modelId: "glm-5.3",
    endpointRef: "engine:ollama-endpoint",
  });
  assert.equal(glm.providerClass, "local-server");
  assert.equal(glm.modelId, "glm-5.3");
  assert.equal(glm.memberSelectable, true, "memberSelectable defaults true");
  assert.deepEqual(glm.safetyFields, {});

  const native = await mod.profileService.define({
    actorDid: "did:porch:admin",
    isAdmin: true,
    name: "Native MLX kids",
    providerClass: "native-mlx",
    modelId: "gemma4:e2b-mlx",
  });
  assert.equal(native.endpointRef, null, "native classes use the platform's own runtime — no endpoint ref");

  const premium = await mod.profileService.define({
    actorDid: "did:porch:admin",
    isAdmin: true,
    name: "Premium",
    providerClass: "local-server",
    modelId: "premium-model",
    memberSelectable: false,
  });
  assert.equal(premium.memberSelectable, false);

  await assert.rejects(
    () => mod.profileService.define({ actorDid: "did:porch:admin", isAdmin: true, name: "bad", providerClass: "bogus-class", modelId: "x" }),
    /provider class must be one of native-mlx, openai-spec, local-server/,
  );
  await assert.rejects(
    () =>
      mod.profileService.define({
        actorDid: "did:porch:admin",
        isAdmin: true,
        name: "leaky",
        providerClass: "openai-spec",
        modelId: "gpt-6",
        endpointRef: "https://api.example.com/v1",
      }),
    /never an address/,
    "endpointRef is a reference into the server's secrets handling, never an address",
  );
  await assert.rejects(
    () =>
      mod.profileService.define({
        actorDid: "did:porch:admin",
        isAdmin: true,
        name: "native-leak",
        providerClass: "native-mlx",
        modelId: "x",
        endpointRef: "engine:something",
      }),
    /no endpoint ref/,
  );
  await assert.rejects(
    () => mod.profileService.define({ actorDid: "did:porch:member", isAdmin: false, name: "nope", providerClass: "local-server", modelId: "x" }),
    (error) => error.code === "E_NOT_PERMITTED",
    "only the hub admin defines profiles",
  );
});
