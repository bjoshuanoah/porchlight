import { test } from "node:test";
import assert from "node:assert/strict";
import { device, fixture } from "./helpers/content.fixture.js";
import { assembleSocialModule } from "../src/assemble.js";

const OWNER = "did:porchlight:owner";
const MEMBER = "did:porchlight:member";
const FAMILY = "net_family";

/**
 * Perimeter fixture with the hub-global release/launch surface injected
 * (apps/server does this in production): release identity is a static
 * read and the launch ledger mirrors the bootstrap diagnostics — entries
 * name the failing check (PORCH-016: the failing check is named in hub
 * diagnostics).
 */
async function systemFixture() {
  const fx = fixture({ networkIds: [FAMILY] });
  await fx.collections.networks.updateOne({ _id: FAMILY }, { $set: { ownerDid: OWNER } });
  const mod = assembleSocialModule(fx.store, {
    verifyMemberIdToken: (token) => (token ? { did: token } : null),
    system: {
      release: { service: "porchlight-server", version: "1.2.3-test" },
      launch: async () => ({
        resumable: false,
        lastError: "post-start feed smoke check failed after restart",
        steps: { account: { status: "complete" }, network: { status: "failed" } },
        diagnostics: [
          { at: "2026-10-09T12:00:00Z", source: "post-start-feed-smoke", message: "post-start feed smoke check failed after restart" },
        ],
      }),
    },
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

  return { ...fx, mod, owner, member };
}

/** Serve the assembled router and return the base URL + a closer. */
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

test("ac-4: the console shows the running release and version, owner-only", async () => {
  const fx = await systemFixture();
  const { base, close } = await serve(fx.mod);
  try {
    const response = await fetch(`${base}/console/system`, {
      headers: { authorization: `Bearer ${fx.owner.accessToken}` },
    });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.deepEqual(Object.keys(body), ["release", "launch"]);
    assert.equal(body.release.service, "porchlight-server");
    assert.equal(body.release.version, "1.2.3-test");
  } finally {
    close();
  }
});

test("ac-4: launch diagnostics name the failed-start check (PORCH-016 consistent)", async () => {
  const fx = await systemFixture();
  const { base, close } = await serve(fx.mod);
  try {
    const response = await fetch(`${base}/console/system`, {
      headers: { authorization: `Bearer ${fx.owner.accessToken}` },
    });
    const body = await response.json();
    const entry = body.launch.diagnostics[0];
    assert.equal(entry.source, "post-start-feed-smoke"); // the failed check, by name
    assert.match(entry.message, /feed smoke check failed after restart/);
    assert.equal(body.launch.lastError, entry.message);
  } finally {
    close();
  }
});

test("ac-4: the release surface is perimeter-gated like every console surface", async () => {
  const fx = await systemFixture();
  const { base, close } = await serve(fx.mod);
  try {
    const anon = await fetch(`${base}/console/system`);
    assert.equal(anon.status, 401);
    assert.equal((await anon.json()).code, "E_SESSION_REQUIRED");
    const member = await fetch(`${base}/console/system`, {
      headers: { authorization: `Bearer ${fx.member.accessToken}` },
    });
    assert.equal(member.status, 403);
    assert.equal((await member.json()).code, "E_FORBIDDEN");
  } finally {
    close();
  }
});

test("ac-4: an unwired system surface is a loud 501, never a fake read", async () => {
  const fx = fixture({ networkIds: [FAMILY] });
  await fx.collections.networks.updateOne({ _id: FAMILY }, { $set: { ownerDid: OWNER } });
  const mod = assembleSocialModule(fx.store, {
    verifyMemberIdToken: (token) => (token ? { did: token } : null),
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
    const response = await fetch(`${base}/console/system`, {
      headers: { authorization: `Bearer ${owner.accessToken}` },
    });
    assert.equal(response.status, 501);
    const body = await response.json();
    assert.equal(body.code, undefined);
    assert.match(body.error, /not wired/);
  } finally {
    close();
  }
});