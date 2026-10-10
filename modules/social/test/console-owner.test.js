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
async function perimeterFixture(options = {}) {
  const fx = fixture({ networkIds: [FAMILY] });
  await fx.collections.networks.updateOne({ _id: FAMILY }, { $set: { ownerDid: OWNER } });
  const mod = assembleSocialModule(fx.store, {
    verifyMemberIdToken: (token) => (token ? { did: token } : null),
    ...options,
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
    // PORCH-053: the guard is the capability ladder now — a plain member is
    // 403 on the delegate ladder's surfaces with the family-language copy.
    assert.equal(getBody.error, "Invitations belong to the network's owner and delegates.");

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

/* ---- PORCH-058: newest-first, paginated audit read ------------------------ */

test("console audit read: newest-first with bounded pages over ?limit= and ?offset=", async () => {
  const fx = await perimeterFixture();
  const { base, close } = await serve(fx.mod);
  const auth = { authorization: `Bearer ${fx.owner.accessToken}` };
  try {
    // Nine recorded events, future-dated so they sort above the admission
    // logins the fixture already wrote; the endpoint must reverse them.
    const created = [];
    for (let i = 0; i < 9; i++) {
      const event = await fx.mod.auditService.record({
        networkId: FAMILY,
        did: i % 2 ? MEMBER : OWNER,
        action: `event_${i}`,
        detail: { sequence: i },
      });
      await fx.mod.auditService.auditEvents.updateOne({ _id: event._id }, { $set: {
        createdAt: new Date(Date.parse("9999-12-31T00:00:00Z") + i * 60_000).toISOString(),
      } });
      created.push(event);
    }
    await fx.mod.auditService.record({ networkId: "net_somewhere_else", action: "not_this_network" });
    const expectedIds = created.map((event) => event._id).reverse();

    const full = await (await fetch(`${base}/console/audit?limit=200`, { headers: auth })).json();
    assert.deepEqual(full.events.slice(0, 9).map((event) => event._id), expectedIds);
    assert.equal(full.hasMore, false);
    assert.equal(full.total, full.events.length); // the read is a page, not the unbounded set

    // Sliding windows page the same newest-first order.
    const first = await (await fetch(`${base}/console/audit?limit=4&offset=0`, { headers: auth })).json();
    assert.deepEqual(first.events.map((event) => event._id), full.events.slice(0, 4).map((event) => event._id));
    assert.equal(first.total, full.total);
    assert.equal(first.limit, 4);
    assert.equal(first.offset, 0);
    assert.equal(first.hasMore, true);

    const second = await (await fetch(`${base}/console/audit?limit=4&offset=4`, { headers: auth })).json();
    assert.deepEqual(second.events.map((event) => event._id), full.events.slice(4, 8).map((event) => event._id));
    assert.equal(second.hasMore, true);

    const tail = await (await fetch(`${base}/console/audit?limit=4&offset=${full.total - 4}`, { headers: auth })).json();
    assert.deepEqual(tail.events.map((event) => event._id), full.events.slice(full.total - 4).map((event) => event._id));
    assert.equal(tail.hasMore, false);

    // Prior events preserved verbatim: every stored field reaches the page.
    const spot = (await (await fetch(`${base}/console/audit?limit=1&offset=2`, { headers: auth })).json()).events[0];
    const original = created[6];
    assert.equal(spot._id, original._id);
    assert.deepEqual(spot.detail, original.detail);
    assert.equal(spot.createdAt, new Date(Date.parse("9999-12-31T00:00:00Z") + 6 * 60_000).toISOString());
  } finally {
    close();
  }
});

/* ---- console-issued join links name their hub (PORCH-023) ---------------- */

test("console-issued join links record the hub they were made for (PORCH-023 ac-2)", async () => {
  const fx = await perimeterFixture({ hubUrl: () => "https://home-1234.porchlight.example" });
  const { base, close } = await serve(fx.mod);
  const auth = { "content-type": "application/json", authorization: `Bearer ${fx.owner.accessToken}` };
  try {
    const issue = await fetch(`${base}/console/invites`, { method: "POST", headers: auth, body: JSON.stringify({ role: "member", maxUses: 1 }) });
    assert.equal(issue.status, 201);
    const link = (await issue.json()).invite.joinUrl;
    assert.ok(String(link).startsWith("https://home-1234.porchlight.example/join/"));

    // The verified answer hands the member front door the named hub.
    const token = String(link).split("/join/")[1];
    const verification = await fetch(`${base}/join/verify?code=${encodeURIComponent(token)}`);
    assert.equal(verification.status, 200);
    assert.equal((await verification.json()).joinUrl, link);
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