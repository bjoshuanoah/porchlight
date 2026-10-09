import { test } from "node:test";
import assert from "node:assert/strict";
import { device, fixture } from "./helpers/content.fixture.js";
import { assembleSocialModule } from "../src/assemble.js";

const OWNER = "did:porchlight:owner";
const MEMBER = "did:porchlight:member";
const FAMILY = "net_family";

/**
 * Owner-perimeter fixture: the assembled social module on a memory store,
 * with the founder identity recorded on the network row (owner-root rule)
 * and an admitted owner + admitted non-owner member.
 */
async function perimeterFixture() {
  const fx = fixture({ networkIds: [FAMILY] });
  await fx.collections.networks.updateOne({ _id: FAMILY }, { $set: { ownerDid: OWNER } });
  const mod = assembleSocialModule(fx.store, {
    verifyMemberIdToken: (token) => (token ? { did: token } : null),
  });
  const ownerDev = device("dev_owner");
  const memberDev = device("dev_member");

  const admit = async (did, dev, role = "member") => {
    const invite = await mod.inviteService.issue({ networkId: FAMILY, role });
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
  assert.equal(owner.membership.role, "owner"); // founder rule in force
  assert.equal(member.membership.role, "member");

  return { ...fx, mod, owner, member, ownerDev, memberDev };
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

/* ---- anon → 401 ---------------------------------------------------------- */

test("console guard: an anonymous request is 401 on every console surface", async () => {
  const fx = await perimeterFixture();
  const { base, close } = await serve(fx.mod);
  const surfaces = [
    ["get", "/console/invites"],
    ["get", "/console/members"],
    ["get", "/console/limits"],
    ["get", "/console/audit"],
    ["get", "/console/ranking"],
    ["get", "/console/groups"],
    ["get", "/console/disk"],
    ["put", "/console/limits"],
    ["post", "/console/invites"],
    ["post", "/console/retention/sweep"],
  ];
  try {
    for (const [method, path] of surfaces) {
      const response = await fetch(`${base}${path}`, { method });
      assert.equal(response.status, 401, `${method.toUpperCase()} ${path}`);
      const body = await response.json();
      assert.equal(body.code, "E_SESSION_REQUIRED", `${method.toUpperCase()} ${path}`);
      assert.ok(body.error, `${path} carries member-language text`);
    }
  } finally {
    close();
  }
});

/* ---- member session → 403 ------------------------------------------------ */

test("console guard: an admitted non-owner session is 403 with owner-only language", async () => {
  const fx = await perimeterFixture();
  const { base, close } = await serve(fx.mod);
  try {
    const getResponse = await fetch(`${base}/console/invites`, {
      headers: { authorization: `Bearer ${fx.member.accessToken}` },
    });
    assert.equal(getResponse.status, 403);
    const getBody = await getResponse.json();
    assert.equal(getBody.code, "E_FORBIDDEN");
    assert.equal(getBody.error, "The owner console belongs to the network owner.");

    // A member token cannot write the network's limits either — and its
    // token is useless on the console even when valid on its own surface.
    const putResponse = await fetch(`${base}/console/limits`, {
      method: "PUT",
      headers: { "content-type": "application/json", authorization: `Bearer ${fx.member.accessToken}` },
      body: JSON.stringify({ storageCeilingMb: 512 }),
    });
    assert.equal(putResponse.status, 403);
    assert.equal((await putResponse.json()).code, "E_FORBIDDEN");
  } finally {
    close();
  }
});

/* ---- owner session (founder-owned) → 200 --------------------------------- */

test("console guard: the founder-owner passes a representative console set", async () => {
  const fx = await perimeterFixture();
  const { base, close } = await serve(fx.mod);
  const auth = { authorization: `Bearer ${fx.owner.accessToken}` };
  try {
    const invitesResponse = await fetch(`${base}/console/invites`, { headers: auth });
    assert.equal(invitesResponse.status, 200);
    assert.ok(Array.isArray((await invitesResponse.json()).invites));

    const membersResponse = await fetch(`${base}/console/members`, { headers: auth });
    assert.equal(membersResponse.status, 200);
    const members = (await membersResponse.json()).members;
    assert.ok(members.some((m) => m.did === OWNER && m.role === "owner"));

    const limitsResponse = await fetch(`${base}/console/limits`, {
      method: "PUT",
      headers: { "content-type": "application/json", ...auth },
      body: JSON.stringify({ storageCeilingMb: 512, retentionDays: 30 }),
    });
    assert.equal(limitsResponse.status, 200);
    assert.equal((await limitsResponse.json()).quota.storageCeilingMb, 512);

    const auditResponse = await fetch(`${base}/console/audit`, { headers: auth });
    assert.equal(auditResponse.status, 200);
    assert.ok(Array.isArray((await auditResponse.json()).events));
  } finally {
    close();
  }
});

/* ---- export guard: single enforcement path (ExportService) --------------- */

test("export guard: the export service is the only perimeter; anonymous export is 401", async () => {
  const fx = await perimeterFixture();
  const { base, close } = await serve(fx.mod);
  try {
    const anonResponse = await fetch(`${base}/media/export`);
    assert.equal(anonResponse.status, 401);
    assert.equal((await anonResponse.json()).code, "E_MUST_SIGN_IN");

    // A signed owner request streams the ZIP named for the network.
    const signature = fx.ownerDev.signPayload({ scope: "export", networkId: FAMILY });
    const response = await fetch(`${base}/media/export?signature=${encodeURIComponent(signature)}`, {
      headers: { authorization: `Bearer ${fx.owner.accessToken}` },
    });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("content-type"), "application/zip");
    assert.ok(
      response.headers.get("content-disposition").includes(`porchlight-export-${FAMILY}`),
      "attachment name carries the network id",
    );
    assert.ok((await response.arrayBuffer()).byteLength > 0);
  } finally {
    close();
  }
});