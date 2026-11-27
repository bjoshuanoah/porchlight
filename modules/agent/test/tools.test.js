// PORCH-149: the agent tool registry — MCP-for-the-home tools riding the
// home module's actor seams through the injected surface, the delegation
// law enforced hub-side (composition seam 2 exactly), fail-closed refusals
// audited with agent attribution, and the underlying service never executed
// beyond the member's scopes.

import { test } from "node:test";
import assert from "node:assert/strict";

import { AgentRuntime, ToolRegistry, MapBackend } from "@porchlight/agent-runtime";

import { makeAgentHub } from "./helpers/fixture.js";
import { ToolDelegationService } from "../src/tools/delegation.service.js";
import { createHomeTools } from "../src/tools/home-tools.js";

const HOMES_MEMBER = [
  { homeId: "home_1", name: "Main house", accessClass: "owner-membership", scopes: null },
  { homeId: "home_2", name: "Visit grant", accessClass: "individual-grant", scopes: [] },
];

function surfaceDouble(overrides = {}) {
  const calls = [];
  const impl = {
    homes: async ({ did }) => (did === "did:porch:visitor" ? [HOMES_MEMBER[1]] : HOMES_MEMBER),
    status: async ({ homeId }) => ({ home: { _id: homeId } }),
    listDevices: async () => ({ devices: [{ _id: "dev_1", name: "Porch light" }] }),
    sendCommand: async () => ({ outcome: "confirmed" }),
    runScene: async () => ({ outcome: "confirmed", results: [] }),
    reviewEvents: async () => ({ events: [] }),
    ...overrides,
  };
  // Every method records its input, then delegates to the (overridable) impl.
  const surface = Object.fromEntries(Object.keys(impl).map((method) => [method, async (input) => {
    calls.push({ method, ...input });
    return impl[method](input);
  }]));
  return { surface, calls };
}

function setup({ surface } = {}) {
  const hub = makeAgentHub();
  const built = surfaceDouble();
  const delegation = new ToolDelegationService({
    surface: surface ?? built.surface,
    audit: hub.mod.auditService,
  });
  return { hub, delegation, calls: built.calls };
}

/** A scripted inference provider: answers with one tool call, then settles. */
function scriptedProvider(script) {
  const queue = [...script];
  return {
    name: "scripted",
    providerClass: "local-server",
    complete: async () => queue.shift() ?? { text: "settled", toolCalls: [] },
  };
}

test("the registry builds only over the full home tool surface — missing seams refuse fail closed", () => {
  const { hub } = setup();
  assert.throws(
    () => new ToolDelegationService({ surface: { homes: async () => [] }, audit: hub.mod.auditService }),
    /home tool surface is missing status, listDevices, sendCommand, runScene, reviewEvents/,
  );
});

test("the five MCP-for-the-home tools register against the runtime library's tool-execution seam", async () => {
  const { hub, delegation } = setup();
  // Composition seam 2 consumption: the registry IS the runtime library's
  // ToolRegistry, built by the hub-side enforcement layer, never re-implemented.
  assert.ok(delegation.registry instanceof ToolRegistry);
  const names = delegation.registry.list().map((t) => t.name);
  assert.deepEqual(names.sort(), [
    "home_device_command", "home_list_devices", "home_review_events", "home_run_scene", "home_status",
  ].sort());
  // The uiRoute of record is present for every tool (the no-hidden-API
  // contract — every tool resolves to a route the UI can also call).
  const tools = createHomeTools({ surface: surfaceDouble().surface });
  assert.equal(tools.length, 5);
  assert.deepEqual(tools.map((t) => t.uiRoute).sort(), [
    "GET /homes/:homeId", "GET /homes/:homeId/devices", "GET /homes/:homeId/events",
    "POST /devices/:deviceId/command", "POST /scenes/:sceneId/run",
  ].sort());
  assert.ok(hub.mod.auditService);
});

test("the authority resolver derives member scopes from the home authorization resolution", async () => {
  const { delegation, calls } = setup();
  const authority = await delegation.authorityFor("did:porch:member");
  assert.deepEqual(authority.memberId, "did:porch:member");
  assert.deepEqual(authority.scopes, ["home:home_1:owner-membership", "home:home_2:individual-grant"]);
  assert.deepEqual(calls[0], { method: "homes", did: "did:porch:member" });
  // A visiting member resolves their grant-derived block only.
  const visitor = await delegation.authorityFor("did:porch:visitor");
  assert.deepEqual(visitor.scopes, ["home:home_2:individual-grant"]);
});

test("a call beyond the member's scopes refuses fail closed, audited, and never executes the service", async () => {
  const { delegation, calls, hub } = setup();
  const authority = await delegation.authorityFor("did:porch:member");
  await assert.rejects(
    () => delegation.registry.execute("home_list_devices", { homeId: "home_9" }, authority),
    /no access for this member is on record there/,
  );
  assert.deepEqual(calls.filter((c) => c.method !== "homes"), [], "the underlying service never ran");
  const rows = await hub.mod.auditService.list({});
  const refusal = rows.rows.find((r) => r.type === "tool-refusal");
  assert.ok(refusal, "the refusal landed an agent audit row");
  assert.equal(refusal.actorIdentityRef, "did:porch:member");
  assert.equal(refusal.detail.via, "agent-tool");
  assert.equal(refusal.detail.tool, "home_list_devices");
  assert.equal(refusal.detail.homeId, "home_9");
  assert.equal(refusal.outcome, "refused");
  assert.match(refusal.detail.reason, /no access for this member/);
});

test("a service-level denial is audited with the agent attribution and never widened", async () => {
  const hub = makeAgentHub();
  const denial = surfaceDouble({
    sendCommand: async () => {
      throw Object.assign(new Error("That control isn't part of the access you were granted for this home."), { code: "E_NOT_PERMITTED" });
    },
  });
  const denialDelegation = new ToolDelegationService({ surface: denial.surface, audit: hub.mod.auditService });
  const authority = await denialDelegation.authorityFor("did:porch:visitor");
  await assert.rejects(
    () => denialDelegation.registry.execute("home_device_command", { deviceId: "dev_1", command: "on" }, authority),
    /part of the access you were granted/,
  );
  const rows = await hub.mod.auditService.list({});
  const refusal = rows.rows.find((r) => r.type === "tool-refusal");
  assert.ok(refusal, "the service denial landed a tool-refusal row");
  assert.equal(refusal.detail.via, "agent-tool");
  assert.equal(refusal.detail.tool, "home_device_command");
  assert.equal(refusal.detail.serviceDenial, "E_NOT_PERMITTED");
  assert.equal(denial.calls.find((c) => c.method === "sendCommand")?.did, "did:porch:visitor");
});

test("an allowed tool call executes the home seam with the acting member and agent attribution", async () => {
  const { delegation, calls } = setup();
  const authority = await delegation.authorityFor("did:porch:member");
  const command = await delegation.registry.execute(
    "home_device_command", { deviceId: "dev_1", command: "on", homeId: "home_1" }, authority,
  );
  assert.deepEqual(command, { outcome: "confirmed" });
  const sent = calls.find((c) => c.method === "sendCommand");
  assert.equal(sent.did, "did:porch:member");
  assert.equal(sent.detail.agentTool, "home_device_command");
  assert.equal(sent.command, "on");
  assert.deepEqual(calls.filter((c) => c.method !== "homes"), [sent], "exactly the underlying service ran");
});

test("the loop executes home tools under the resolved member authority — seam 2 end to end", async () => {
  const { delegation, calls } = setup();
  const runtime = new AgentRuntime({
    backend: new MapBackend(),
    inference: scriptedProvider([
      { text: "", toolCalls: [{ name: "home_list_devices", args: { homeId: "home_1" } }] },
      { text: "Porch light listed." },
    ]),
    tools: delegation.registry,
    authority: (memberId) => delegation.authorityFor(memberId),
  });
  const entity = runtime.agentFor("did:porch:member");
  const turn = await entity.runTurn({ text: "what devices do I have?" });
  assert.deepEqual(turn.toolsUsed, ["home_list_devices"]);
  assert.equal(turn.provenance.provider, "scripted");
  const listed = calls.find((c) => c.method === "listDevices");
  assert.equal(listed.did, "did:porch:member");
  assert.equal(listed.homeId, "home_1");
});
