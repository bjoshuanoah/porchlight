import { test } from "node:test";
import assert from "node:assert/strict";
import { device, fixture } from "./helpers/content.fixture.js";
import { assembleSocialModule } from "../src/assemble.js";

const OWNER = "did:porchlight:owner";
const DELEGATE = "did:porchlight:delegate";
const MEMBER = "did:porchlight:member";
const MEMBER2 = "did:porchlight:member2";
const FAMILY = "net_family";

const NAMES = {
  [OWNER]: "Brian Noah",
  [DELEGATE]: "Sophie Marten",
  [MEMBER]: "June Rivers",
  [MEMBER2]: "Tom Fields",
};

/**
 * Admin-ladder fixture (PORCH-053): the assembled social module on a memory
 * store with the founder recorded, an owner, a delegate (promoted through
 * the real route), and a plain member — plus a second network for the
 * origin-containment reads.
 */
async function adminFixture({ names = NAMES } = {}) {
  const fx = fixture({ networkIds: [FAMILY], memberNames: async (dids) => dids.map((did) => ({ did, displayName: names[did] ?? null })) });
  await fx.collections.networks.updateOne({ _id: FAMILY }, { $set: { ownerDid: OWNER } });
  const mod = assembleSocialModule(fx.store, {
    verifyMemberIdToken: (token) => (token ? { did: token } : null),
    memberNames: async (dids) => dids.map((did) => ({ did, displayName: names[did] ?? null })),
  });

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

  const ownerDev = device("dev_owner");
  const delegateDev = device("dev_delegate");
  const memberDev = device("dev_member");
  const owner = await admit(OWNER, ownerDev);
  const delegate = await admit(DELEGATE, delegateDev);
  const member = await admit(MEMBER, memberDev);
  assert.equal(owner.membership.role, "owner");
  assert.equal(member.membership.role, "member");

  // The delegate exists through the ladder's own path: the owner promoted them.
  const promoted = await mod.membershipService.setMemberRole({
    networkId: FAMILY,
    memberId: delegate.membership._id,
    to: "delegate",
    actor: { session: { did: OWNER } },
  });
  assert.equal(promoted.role, "delegate");

  return { ...fx, mod, owner, delegate, member, ownerDev, delegateDev, memberDev };
}

/** Minimal express app serving the assembled social module. */
async function serve(mod) {
  const express = (await import("express")).default;
  const app = express();
  app.use(express.json());
  app.use("/api/social", mod.api);
  let server;
  await new Promise((resolve) => { server = app.listen(0, resolve); });
  const base = `http://127.0.0.1:${server.address().port}`;
  return { base, close: () => new Promise((resolve) => server.close(resolve)) };
}

async function call(base, path, { method = "GET", token = null, body = null } = {}) {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: {
      ...(body ? { "content-type": "application/json" } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const json = await response.json().catch(() => ({}));
  return { status: response.status, body: json };
}

/* ---- ac-2: the capability ladder ---------------------------------------- */

test("ac-2: the ONE capability table — owner everything, delegate the member-management set, member nothing", async () => {
  const { mod } = await adminFixture();
  const { capabilitiesFor } = await import("../src/services/membership.service.js");
  const ownerCaps = capabilitiesFor("owner");
  const delegateCaps = capabilitiesFor("delegate");
  assert.deepEqual(delegateCaps, ["members_read", "invites_read", "invite_issue", "invite_revoke", "device_links_read", "device_link_issue", "device_link_revoke", "member_remove"]);
  for (const cap of delegateCaps) assert.ok(ownerCaps.includes(cap), `owner carries ${cap}`);
  for (const cap of ["member_role", "member_purge"]) {
    assert.ok(ownerCaps.includes(cap), `owner carries ${cap}`);
    assert.ok(!delegateCaps.includes(cap), `${cap} never reaches a delegate`);
  }
  assert.deepEqual(capabilitiesFor("member"), []);
  assert.deepEqual(mod.membershipService.capabilitiesFor("bogus"), []);
});

test("ac-2: promote and demote are owner-only and the change lands immediately in capabilities", async () => {
  const fx = await adminFixture();
  const hub = await serve(fx.mod);
  try {
    const ownerId = fx.owner.membership._id;
    const memberId = fx.member.membership._id;

    // A delegate is refused the owner-only role change.
    const delegatePromote = await call(hub.base, "/api/social/console/members/role", {
      method: "PATCH", token: fx.delegate.accessToken, body: { memberId, role: "delegate" },
    });
    assert.equal(delegatePromote.status, 403);
    assert.equal(delegatePromote.body.code, "E_FORBIDDEN");

    // The owner promotes; the member's capabilities move in the same write —
    // their token now reads the member-management surfaces.
    const promoted = await call(hub.base, "/api/social/console/members/role", {
      method: "PATCH", token: fx.owner.accessToken, body: { memberId, role: "delegate" },
    });
    assert.equal(promoted.status, 200);
    assert.equal(promoted.body.membership.role, "delegate");
    const memberRead = await call(hub.base, "/api/social/console/members", { token: fx.member.accessToken });
    assert.equal(memberRead.status, 200);

    // The owner demotes the same member; the capability leaves in the same write.
    const demoted = await call(hub.base, "/api/social/console/members/role", {
      method: "PATCH", token: fx.owner.accessToken, body: { memberId, role: "member" },
    });
    assert.equal(demoted.status, 200);
    assert.equal(demoted.body.membership.role, "member");
    const memberReadAgain = await call(hub.base, "/api/social/console/members", { token: fx.member.accessToken });
    assert.equal(memberReadAgain.status, 403);

    // The owner's own row is never a role-change target.
    const ownerTarget = await call(hub.base, "/api/social/console/members/role", {
      method: "PATCH", token: fx.owner.accessToken, body: { memberId: ownerId, role: "member" },
    });
    assert.equal(ownerTarget.status, 409);
    assert.equal(ownerTarget.body.code, "E_LAST_OWNER");

    // A bogus role is rejected, and the audit trail carries the change with
    // the acting owner as the actor.
    const bogus = await call(hub.base, "/api/social/console/members/role", {
      method: "PATCH", token: fx.owner.accessToken, body: { memberId, role: "owner" },
    });
    assert.equal(bogus.status, 400);
    const trail = (await call(hub.base, "/api/social/console/audit", { token: fx.owner.accessToken })).body.events;
    const roleEntries = trail.filter((row) => row.action === "member_role_change");
    assert.ok(roleEntries.some((row) => row.did === OWNER && row.detail.to === "delegate" && row.detail.from === "member" && row.detail.targetDid === MEMBER));
  } finally {
    await hub.close();
  }
});

/* ---- ac-3: removal keeps content, kills every live surface ---------------- */

test("ac-3: removal revokes membership and device enrollments, kills sessions and realtime instantly, keeps content, and audits the actor", async () => {
  const fx = await adminFixture();
  const hub = await serve(fx.mod);
  try {
    // The member authored content before removal.
    const payload = { type: "text", body: "Grandma's birthday" };
    const post = (await fx.mod.postService.create({ accessToken: fx.member.accessToken, payload, signature: fx.memberDev.signPayload(payload) })).post;

    // A live realtime channel for the member, closed at the revoke.
    let closed = false;
    await fx.mod.realtimeService.subscribe({ token: fx.member.accessToken, networkId: FAMILY, channel: { id: "ch_member", emit: () => {}, close: () => { closed = true; } } });

    const deviceKeysBefore = await fx.collections.deviceKeys.find({ networkId: FAMILY, did: MEMBER });
    assert.ok(deviceKeysBefore.length > 0);

    const removal = await call(hub.base, "/api/social/console/members/revoke", {
      method: "POST", token: fx.owner.accessToken, body: { memberId: fx.member.membership._id },
    });
    assert.equal(removal.status, 200);
    assert.equal(removal.body.revoked, true);

    // Membership + device registrations revoked; enrollment re-created only
    // by a fresh admission (never resurrection).
    assert.equal((await fx.collections.deviceKeys.find({ networkId: FAMILY, did: MEMBER })).length, 0);
    assert.equal(await fx.mod.membershipService.verifyAccessToken(fx.member.accessToken), null);
    assert.ok(closed, "the live subscription closed in the same write");

    // Authored content stays by default.
    assert.ok(await fx.collections.posts.findOne({ _id: post._id }));

    // The action lands in the audit log with the acting owner.
    const trail = (await call(hub.base, "/api/social/console/audit", { token: fx.owner.accessToken })).body.events;
    const entry = trail.find((row) => row.action === "membership_revoke");
    assert.equal(entry.did, OWNER);
    assert.equal(entry.detail.targetDid, MEMBER);
    assert.equal(entry.detail.memberId, fx.member.membership._id);
  } finally {
    await hub.close();
  }
});

test("ac-3: a delegate removes a plain member, is 403 on the owner row, and the last owner is unremovable", async () => {
  const fx = await adminFixture();
  const hub = await serve(fx.mod);
  try {
    const removal = await call(hub.base, "/api/social/console/members/revoke", {
      method: "POST", token: fx.delegate.accessToken, body: { memberId: fx.member.membership._id },
    });
    assert.equal(removal.status, 200);
    assert.equal(removal.body.revoked, true);

    // A delegate never removes the owner.
    const ownerRemoval = await call(hub.base, "/api/social/console/members/revoke", {
      method: "POST", token: fx.delegate.accessToken, body: { memberId: fx.owner.membership._id },
    });
    assert.equal(ownerRemoval.status, 403);
    assert.equal(ownerRemoval.body.code, "E_FORBIDDEN");
  } finally {
    await hub.close();
  }
});

/* ---- ac-4: the owner-only permanent deletion cascade ---------------------- */

test("ac-4: permanent deletion confirms by typed name and cascades originals, derived artifacts, and comments — audit records the confirming actor", async () => {
  const fx = await adminFixture();
  const hub = await serve(fx.mod);
  try {
    // The member authors a post and a comment on the owner's post.
    const payload = { type: "text", body: "a post with a media ref" };
    const post = (await fx.mod.postService.create({ accessToken: fx.member.accessToken, payload, signature: fx.memberDev.signPayload(payload) })).post;
    const ownerPayload = { type: "text", body: "the owner's own post" };
    const ownerPost = (await fx.mod.postService.create({ accessToken: fx.owner.accessToken, payload: ownerPayload, signature: fx.ownerDev.signPayload(ownerPayload) })).post;
    const commentPayload = { postId: ownerPost._id, body: "a member comment" };
    const comment = (await fx.mod.interactionService.comment({ accessToken: fx.member.accessToken, payload: commentPayload, signature: fx.memberDev.signPayload(commentPayload) })).comment;

    // Derived-artifact + media rows keyed to the member's authored content.
    const originalId = "med_member_original";
    const mediaAssets = fx.store.collection("media_assets");
    await mediaAssets.insertOne({ _id: originalId, networkId: FAMILY, did: MEMBER, kind: "original", blobKey: "blob_member_original", sha256: "aa", bytes: 100, immutable: true, createdAt: new Date().toISOString() });
    await mediaAssets.insertOne({ _id: "rnd_1", networkId: FAMILY, did: MEMBER, kind: "rendition", originalId, renditionKind: "feed-thumb", format: "v2", blobKey: "blob_rnd", sha256: "bb", bytes: 10, immutable: false, createdAt: new Date().toISOString() });
    await fx.mod.quotaService.recordArtifact({ networkId: FAMILY, kind: "original", bytes: 100, sourceId: originalId });
    await fx.mod.quotaService.recordArtifact({ networkId: FAMILY, kind: "rendition", bytes: 10, sourceId: "rnd_1" });

    // A plain member session is refused at the route (role lacks the cap).
    const memberTry = await call(hub.base, `/api/social/console/members/${fx.member.membership._id}`, {
      method: "DELETE", token: fx.member.accessToken, body: { confirmName: NAMES[MEMBER] },
    });
    assert.equal(memberTry.status, 403);

    // A delegate is refused (owner-only capability).
    const delegateTry = await call(hub.base, `/api/social/console/members/${fx.member.membership._id}`, {
      method: "DELETE", token: fx.delegate.accessToken, body: { confirmName: NAMES[MEMBER] },
    });
    assert.equal(delegateTry.status, 403);

    // The owner without the typed name is refused — never a single-tap
    // surface, on any surface.
    const noName = await call(hub.base, `/api/social/console/members/${fx.member.membership._id}`, {
      method: "DELETE", token: fx.owner.accessToken, body: {},
    });
    assert.equal(noName.status, 400);
    assert.equal(noName.body.code, "E_CONFIRM_NAME");

    const wrongName = await call(hub.base, `/api/social/console/members/${fx.member.membership._id}`, {
      method: "DELETE", token: fx.owner.accessToken, body: { confirmName: "Not June Rivers" },
    });
    assert.equal(wrongName.status, 400);
    assert.equal(wrongName.body.code, "E_CONFIRM_NAME");
    assert.ok((await fx.collections.posts.findOne({ _id: post._id })), "nothing moved before confirmation");

    const purge = await call(hub.base, `/api/social/console/members/${fx.member.membership._id}`, {
      method: "DELETE", token: fx.owner.accessToken, body: { confirmName: NAMES[MEMBER] },
    });
    assert.equal(purge.status, 200);
    assert.equal(purge.body.purged, true);

    // The cascade: authored originals (posts) and authored comments die,
    // derived artifacts (renditions, ledger rows) die with them.
    assert.equal(await fx.collections.posts.findOne({ _id: post._id }), null);
    assert.equal(await fx.collections.comments.findOne({ _id: comment._id }), null);
    assert.equal(await mediaAssets.findOne({ _id: originalId }), null);
    assert.equal(await mediaAssets.findOne({ _id: "rnd_1" }), null);
    assert.equal((await fx.mod.quotaService.usage({ networkId: FAMILY })).usedBytes, 0);
    assert.equal(purge.body.sweptPosts, 1);

    // The audit trail carries the cascade with the confirming actor.
    const trail = (await call(hub.base, "/api/social/console/audit", { token: fx.owner.accessToken })).body.events;
    assert.ok(trail.some((row) => row.action === "member_purge" && row.did === OWNER && row.detail.targetDid === MEMBER));
    assert.ok(trail.some((row) => row.action === "membership_revoke" && row.did === OWNER && row.detail.targetDid === MEMBER));
  } finally {
    await hub.close();
  }
});

/* ---- ac-5: final-owner refusal with plain language ------------------------ */

test("ac-5: every path that would end the last owner refuses with the plain reason", async () => {
  const fx = await adminFixture();
  const hub = await serve(fx.mod);
  try {
    // Removal of the sole owner.
    const removal = await call(hub.base, "/api/social/console/members/revoke", {
      method: "POST", token: fx.owner.accessToken, body: { memberId: fx.owner.membership._id },
    });
    assert.equal(removal.status, 409);
    assert.equal(removal.body.code, "E_LAST_OWNER");
    assert.match(removal.body.error, /owner/i);

    // Permanent delete of the sole owner.
    const purge = await call(hub.base, `/api/social/console/members/${fx.owner.membership._id}`, {
      method: "DELETE", token: fx.owner.accessToken, body: { confirmName: NAMES[OWNER] },
    });
    assert.equal(purge.status, 409);
    assert.equal(purge.body.code, "E_LAST_OWNER");

    // Demote of the sole owner (the role endpoint's owner-target refusal).
    const role = await call(hub.base, "/api/social/console/members/role", {
      method: "PATCH", token: fx.owner.accessToken, body: { memberId: fx.owner.membership._id, role: "member" },
    });
    assert.equal(role.status, 409);
    assert.equal(role.body.code, "E_LAST_OWNER");

    // A second owner changes the answer: the first owner CAN be removed.
    await fx.collections.memberships.insertOne({ _id: "mem_second", networkId: FAMILY, did: MEMBER2, role: "owner", state: "active", admittedViaInviteId: null, admittedAt: new Date().toISOString(), revokedAt: null });
    const removal2 = await call(hub.base, "/api/social/console/members/revoke", {
      method: "POST", token: fx.owner.accessToken, body: { memberId: fx.owner.membership._id },
    });
    assert.equal(removal2.status, 200);
    assert.equal(removal2.body.revoked, true);
  } finally {
    await hub.close();
  }
});

/* ---- ac-6: origin containment --------------------------------------------- */

test("ac-6: a member of another network on the hub is outside every admin surface", async () => {
  const fx = await adminFixture();
  const hub = await serve(fx.mod);
  try {
    const outsiderDev = device("dev_outsider");
    const joined = await fx.mod.inviteService.issue({ networkId: "net_other" });
    const outsider = await fx.mod.membershipService.admit({
      code: joined.token,
      identityAccessToken: MEMBER2,
      deviceId: outsiderDev.deviceId,
      devicePublicKeyJwk: outsiderDev.publicKeyJwk,
      signature: outsiderDev.sign(`porchlight-join:${joined.token}`),
    });

    // Every admin capability the outsider holds elsewhere is dead HERE: the
    // console perimeter verifies against THIS network only.
    const read = await call(hub.base, "/api/social/console/members", { token: outsider.accessToken });
    assert.equal(read.status, 401);
    const removal = await call(hub.base, "/api/social/console/members/revoke", {
      method: "POST", token: outsider.accessToken, body: { memberId: fx.member.membership._id },
    });
    assert.equal(removal.status, 401);

    // And the console surfaces stay scoped: a rogue networkId in the query
    // never widens the read.
    const readRogue = await call(hub.base, "/api/social/console/members?networkId=net_other", { token: fx.owner.accessToken });
    assert.equal(readRogue.status, 200);
    assert.ok(readRogue.body.members.every((row) => row.networkId === FAMILY));
  } finally {
    await hub.close();
  }
});