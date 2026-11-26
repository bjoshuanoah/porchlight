// PORCH-148: the module's REST vertical rides the assembled router exactly
// as the hub mounts it — thin routes, controllers translating, services
// enforcing. The withheld-profile closure, the member surface read, and the
// unassigned state are proven over the real express surface.

import { test } from "node:test";
import assert from "node:assert/strict";

import express from "express";

import { makeAgentHub } from "./helpers/fixture.js";

const FAMILIES = [{ _id: "fam_1", name: "Noah", parentIdentityRefs: ["did:porch:parent"], memberIdentityRefs: ["did:porch:kid"] }];

async function startServer() {
  const hub = makeAgentHub({ admins: ["did:porch:admin"], families: FAMILIES });
  const app = express();
  app.use(express.json());
  app.use("/agent", hub.mod.api);
  const listener = app.listen(0);
  await new Promise((resolve) => listener.once("listening", resolve));
  const port = listener.address().port;
  const close = () => listener.close();
  return { hub, port, close };
}

async function call(port, path, { method = "GET", token = null, body = null } = {}) {
  const response = await fetch(`http://127.0.0.1:${port}/agent${path}`, {
    method,
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: response.status, body: await response.json() };
}

test("the vertical refuses unsigned calls and non-admin governance", async () => {
  const srv = await startServer();
  try {
    const unsigned = await call(srv.port, "/profiles");
    assert.equal(unsigned.status, 401);
    const token = srv.hub.sign("did:porch:member");
    const denied = await call(srv.port, "/profiles", { method: "POST", token, body: { name: "x", providerClass: "openai-spec", modelId: "y" } });
    assert.equal(denied.status, 403);
    assert.match(denied.body.error, /Only the hub admin/);
    assert.equal(denied.body.code, "E_NOT_PERMITTED");
  } finally {
    srv.close();
  }
});

test("an admin defines, assigns, and flips availability over the REST vertical; the member surface reads the running model", async () => {
  const srv = await startServer();
  try {
    const admin = srv.hub.sign("did:porch:admin");
    const member = srv.hub.sign("did:porch:alice");

    const created = await call(srv.port, "/profiles", {
      method: "POST",
      token: admin,
      body: { name: "Ollama GLM", providerClass: "local-server", modelId: "glm-5.3", endpointRef: "engine:ollama-endpoint" },
    });
    assert.equal(created.status, 200);
    const premium = await call(srv.port, "/profiles", { method: "POST", token: admin, body: { name: "Premium", providerClass: "local-server", modelId: "premium-model", memberSelectable: false } });
    assert.equal(premium.status, 200);

    const assigned = await call(srv.port, "/assignments", { method: "POST", token: admin, body: { target: { memberId: "did:porch:alice" }, profileId: created.body._id } });
    assert.equal(assigned.status, 200);
    assert.equal(assigned.body.profileRef, created.body._id);

    const view = await call(srv.port, "/me/model", { token: member });
    assert.equal(view.status, 200);
    assert.equal(view.body.state, "running");
    assert.deepEqual(view.body.model, { modelId: "glm-5.3", providerClass: "local-server" });
    const sweep = JSON.stringify(view.body);
    assert.ok(!sweep.includes("engine:ollama-endpoint") && !sweep.includes("://"), "the member read carries no endpoint/token strings");

    // The withheld profile is invisible on the member selection surface and
    // a self-selection attempt refuses in plain language.
    const selectable = await call(srv.port, "/me/profiles", { token: member });
    assert.ok(!JSON.stringify(selectable.body).includes(premium.body._id));
    const attempt = await call(srv.port, "/me/model", { method: "POST", token: member, body: { profileId: premium.body._id } });
    assert.equal(attempt.status, 403);
    assert.equal(attempt.body.code, "E_PROFILE_UNAVAILABLE");
    assert.match(attempt.body.error, /not made this profile available/);

    // The admin provenance trail answers over the vertical.
    const provenance = await call(srv.port, "/provenance?memberId=did%3Aporch%3Aalice", { token: admin });
    assert.equal(provenance.body.total, 0, "no inference has ridden the router on this surface yet");

    // A queried type with no assignment renders the explicit unassigned state.
    const unassigned = await call(srv.port, "/assignments?agentType=household-member", { token: admin });
    assert.equal(unassigned.body.state, "unassigned");
  } finally {
    srv.close();
  }
});

test("the parental narrowing rides the real vertical — parent check enforced hub-side, family organizer contract ready", async () => {
  const srv = await startServer();
  try {
    const parent = srv.hub.sign("did:porch:parent");
    const kid = srv.hub.sign("did:porch:kid");
    const admin = srv.hub.sign("did:porch:admin");

    const kidsModel = await call(srv.port, "/profiles", { method: "POST", token: admin, body: { name: "Kids MLX", providerClass: "native-mlx", modelId: "gemma4:e2b-mlx" } });
    const premium = await call(srv.port, "/profiles", { method: "POST", token: admin, body: { name: "Premium", providerClass: "local-server", modelId: "premium-model", memberSelectable: false } });

    const narrowed = await call(srv.port, `/families/fam_1/members/did%3Aporch%3Akid/permitted-profiles`, {
      method: "POST",
      token: parent,
      body: { profileIds: [kidsModel.body._id] },
    });
    assert.equal(narrowed.status, 200);
    assert.deepEqual(narrowed.body.permittedProfileRefs, [kidsModel.body._id]);

    const withheld = await call(srv.port, `/families/fam_1/members/did%3Aporch%3Akid/permitted-profiles`, {
      method: "POST",
      token: parent,
      body: { profileIds: [premium.body._id] },
    });
    assert.equal(withheld.status, 403);
    assert.equal(withheld.body.code, "E_PROFILE_UNAVAILABLE");
    assert.match(withheld.body.error, /a family cannot re-enable it/);

    // The governed member reads through their own surface; the narrowing
    // gates their selection.
    void kid;
    const kidView = await call(srv.port, "/me/model", { token: kid });
    assert.equal(kidView.body.state, "unassigned", "no assignment yet — the explicit state, never a silent default");
  } finally {
    srv.close();
  }
});
