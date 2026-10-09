// Console update surface (PORCH-040): the owner console's update action and
// the ops-token path both ride the ONE shared update service injected by
// apps/server. Perimeter: owner Bearer session or the machine-local ops
// token — nothing else; the surface is 501 when the deployment wires no
// update service.
import { test } from "node:test";
import assert from "node:assert/strict";
import { device, fixture } from "./helpers/content.fixture.js";
import { assembleSocialModule } from "../src/assemble.js";

const OWNER = "did:porchlight:owner";
const MEMBER = "did:porchlight:member";
const FAMILY = "net_family";
const OPS_TOKEN = "ops-token-for-the-hubs-own-cli-040";

/** Counting fake of the shared update service injected as a hub-global. */
function fakeUpdate({ status = { current: "1.0.0", latest: "2.0.0", updateAvailable: true }, apply = null } = {}) {
  const calls = { status: 0, apply: 0 };
  return {
    calls,
    system: {
      release: { service: "porchlight-server", version: "1.0.0" },
      launch: async () => ({ resumable: false, lastError: null, steps: {}, diagnostics: [] }),
      update: {
        verifyToken: (token) => token === OPS_TOKEN,
        status: async () => {
          calls.status += 1;
          return status;
        },
        apply: async () => {
          calls.apply += 1;
          return apply ?? { status: "applied", release: { from: "1.0.0", to: "2.0.0" } };
        },
      },
    },
  };
}

async function surfaceFixture(options = {}) {
  const update = fakeUpdate(options);
  const fx = fixture({ networkIds: [FAMILY] });
  await fx.collections.networks.updateOne({ _id: FAMILY }, { $set: { ownerDid: OWNER } });
  const mod = assembleSocialModule(fx.store, {
    verifyMemberIdToken: (token) => (token ? { did: token } : null),
    system: update.system,
  });
  const ownerDev = device("dev_owner");
  const memberDev = device("dev_member");
  const admit = async (did, dev) => {
    const invite = await mod.inviteService.issue({ networkId: FAMILY, role: "member" });
    return mod.membershipService.admit({
      code: invite.token,
      identityAccessToken: did,
      deviceId: dev.deviceId,
      devicePublicKeyJwk: dev.publicKeyJwk,
      signature: dev.sign(`porchlight-join:${invite.token}`),
    });
  };
  const owner = await admit(OWNER, ownerDev);
  const member = await admit(MEMBER, memberDev);
  return { update, ...fx, mod, owner, member };
}

async function serve(mod) {
  const express = (await import("express")).default;
  const app = express();
  app.use(express.json());
  app.use("/api/social", mod.api);
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  const base = `http://127.0.0.1:${server.address().port}/api/social`;
  return { base, close: () => server.close() };
}

test("ac-1: the console sees the current release, the newer release, and updates only on the owner's action", async () => {
  const fx = await surfaceFixture();
  const { base, close } = await serve(fx.mod);
  try {
    const response = await fetch(`${base}/console/update`, {
      headers: { authorization: `Bearer ${fx.owner.accessToken}` },
    });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.deepEqual(body.release, { current: "1.0.0", latest: "2.0.0", updateAvailable: true });
    assert.equal(fx.update.calls.status, 1); // resolved for THIS owner view, not on a timer
  } finally {
    close();
  }
});

test("ac-1: the single apply action rides the shared service and reports the applied release", async () => {
  const fx = await surfaceFixture();
  const { base, close } = await serve(fx.mod);
  try {
    const response = await fetch(`${base}/console/update`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${fx.owner.accessToken}` },
      body: JSON.stringify({}),
    });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.deepEqual(body, { status: "applied", release: { from: "1.0.0", to: "2.0.0" } });
    assert.equal(fx.update.calls.apply, 1);
  } finally {
    close();
  }
});

test("ac-1: an already-latest apply reports the version only — the apply path is not re-run", async () => {
  const fx = await surfaceFixture({
    status: { current: "2.0.0", latest: "2.0.0", updateAvailable: false },
    apply: { status: "latest", release: { current: "2.0.0", latest: "2.0.0" } },
  });
  const { base, close } = await serve(fx.mod);
  try {
    const response = await fetch(`${base}/console/update`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${fx.owner.accessToken}` },
      body: JSON.stringify({}),
    });
    assert.equal(response.status, 200);
    assert.deepEqual((await response.json()).release, { current: "2.0.0", latest: "2.0.0" });
  } finally {
    close();
  }
});

test("ac-2: the hub's own CLI reaches the same surface with the machine-local ops token", async () => {
  const fx = await surfaceFixture();
  const { base, close } = await serve(fx.mod);
  try {
    const check = await fetch(`${base}/console/update`, { headers: { "x-porchlight-ops-token": OPS_TOKEN } });
    assert.equal(check.status, 200);
    assert.equal((await check.json()).release.updateAvailable, true);
    const apply = await fetch(`${base}/console/update`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-porchlight-ops-token": OPS_TOKEN },
      body: JSON.stringify({}),
    });
    assert.equal(apply.status, 200);
    assert.equal((await apply.json()).status, "applied");
  } finally {
    close();
  }
});

test("ac-2: a wrong ops token gets the same perimeter answer as any stranger", async () => {
  const fx = await surfaceFixture();
  const { base, close } = await serve(fx.mod);
  try {
    const stranger = await fetch(`${base}/console/update`, { headers: { "x-porchlight-ops-token": "not-the-token" } });
    assert.equal(stranger.status, 401);
    assert.equal((await stranger.json()).code, "E_SESSION_REQUIRED");
  } finally {
    close();
  }
});

test("ac-3: a failed apply names its state for the owner — the surface carries it verbatim", async () => {
  const fx = await surfaceFixture({ apply: { status: "failed", error: "the update to v2.0.0 could not be installed (npm EACCES). npm leaves the previous release in place on a failed install — the hub keeps serving v1.0.0 and was not restarted.", release: { current: "1.0.0" } } });
  const { base, close } = await serve(fx.mod);
  try {
    const response = await fetch(`${base}/console/update`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${fx.owner.accessToken}` },
      body: JSON.stringify({}),
    });
    assert.equal(response.status, 502);
    const body = await response.json();
    assert.equal(body.status, "failed");
    assert.match(body.error, /npm leaves the previous release in place/);
    assert.match(body.error, /hub keeps serving v1\.0\.0/);
  } finally {
    close();
  }
});

test("the update surface is perimeter-gated like every console surface", async () => {
  const fx = await surfaceFixture();
  const { base, close } = await serve(fx.mod);
  try {
    const anon = await fetch(`${base}/console/update`);
    assert.equal(anon.status, 401);
    assert.equal((await anon.json()).code, "E_SESSION_REQUIRED");
    const member = await fetch(`${base}/console/update`, {
      headers: { authorization: `Bearer ${fx.member.accessToken}` },
    });
    assert.equal(member.status, 403);
    assert.equal((await member.json()).code, "E_FORBIDDEN");
  } finally {
    close();
  }
});

test("a deployment without the update service wired reports 501, plainly", async () => {
  const fx = fixture({ networkIds: [FAMILY] });
  await fx.collections.networks.updateOne({ _id: FAMILY }, { $set: { ownerDid: OWNER } });
  const mod = assembleSocialModule(fx.store, {
    verifyMemberIdToken: (token) => (token ? { did: token } : null),
    system: { release: { service: "porchlight-server", version: "1.0.0" }, launch: async () => ({}) },
  });
  const ownerDev = device("dev_owner");
  const invite = await mod.inviteService.issue({ networkId: FAMILY, role: "member" });
  const owner = await mod.membershipService.admit({
    code: invite.token,
    identityAccessToken: OWNER,
    deviceId: ownerDev.deviceId,
    devicePublicKeyJwk: ownerDev.publicKeyJwk,
    signature: ownerDev.sign(`porchlight-join:${invite.token}`),
  });
  const { base, close } = await serve(mod);
  try {
    for (const init of [{}, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }]) {
      const response = await fetch(`${base}/console/update`, {
        ...init,
        headers: { ...(init.headers ?? {}), authorization: `Bearer ${owner.accessToken}` },
      });
      assert.equal(response.status, 501);
      assert.match((await response.json()).error, /update surface is not wired into this deployment/);
    }
  } finally {
    close();
  }
});