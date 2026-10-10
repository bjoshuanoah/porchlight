import { test } from "node:test";
import assert from "node:assert/strict";
import { device, fixture } from "./helpers/content.fixture.js";
import { assembleSocialModule } from "../src/assemble.js";

const OWNER = "did:porchlight:owner";
const CASS = "did:porchlight:cass"; // plain member — the group creator
const DEVON = "did:porchlight:devon"; // plain member — added to the group
const PIP = "did:porchlight:pip"; // plain member — stays out of the group
const FAMILY = "net_family";
const OTHER = "net_other";

/**
 * Member-plane fixture: the assembled social module on the content fixture's
 * memory store, with an admitted founder-owner and three admitted plain
 * members (Cass, Devon, Pip) plus live membership tokens.
 */
async function memberFixture() {
  const NAMES = {
    [OWNER]: "Brian Rivers",
    [CASS]: "Cass Porter",
    [DEVON]: "Devon Mills",
    [PIP]: "Pip Larkin",
  };
  const fx = fixture({
    networkIds: [FAMILY, OTHER],
    memberNames: (dids) => dids.map((did) => ({ did, displayName: NAMES[did] ?? null })),
  });
  await fx.collections.networks.updateOne({ _id: FAMILY }, { $set: { ownerDid: OWNER } });
  const mod = assembleSocialModule(fx.store, {
    verifyMemberIdToken: (token) => (token ? { did: token } : null),
    memberNames: (dids) => dids.map((did) => ({ did, displayName: NAMES[did] ?? null })),
  });
  const devs = {
    owner: device("dev_owner"),
    cass: device("dev_cass"),
    devon: device("dev_devon"),
    pip: device("dev_pip"),
  };
  const admit = async (did, memberDevice, network = FAMILY) => {
    const invite = await mod.inviteService.issue({ networkId: network });
    return mod.membershipService.admit({
      code: invite.token,
      identityAccessToken: did,
      deviceId: memberDevice.deviceId,
      devicePublicKeyJwk: memberDevice.publicKeyJwk,
      signature: memberDevice.sign(`porchlight-join:${invite.token}`),
    });
  };
  const owner = await admit(OWNER, devs.owner);
  const cass = await admit(CASS, devs.cass);
  const devon = await admit(DEVON, devs.devon);
  const pip = await admit(PIP, devs.pip);
  assert.equal(owner.membership.role, "owner"); // founder rule in force
  assert.equal(cass.membership.role, "member");
  assert.equal(devon.membership.role, "member");
  return { ...fx, mod, devs, tokens: { owner: owner.accessToken, cass: cass.accessToken, devon: devon.accessToken, pip: pip.accessToken } };
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

async function mkPost(fx, token, memberDevice, payload) {
  return (await fx.posts.create({ accessToken: token, payload, signature: memberDevice.signPayload(payload) })).post;
}

/* ---- ac-1: member-visible groups index and detail ------------------------ */

test("ac-1: the groups index and detail render for every member, scoped to their origin", async () => {
  const fx = await memberFixture();
  const { base, close } = await serve(fx.mod);
  const ownerAuth = { "content-type": "application/json", authorization: `Bearer ${fx.tokens.owner}` };
  try {
    const created = await fetch(`${base}/console/groups`, {
      method: "POST",
      headers: ownerAuth,
      body: JSON.stringify({ name: "Picnic", members: [DEVON] }),
    });
    assert.equal(created.status, 201);
    const groupId = (await created.json()).group._id;

    // A plain member (no owner elevation) reads the groups index.
    const list = await fetch(`${base}/groups`, { headers: { authorization: `Bearer ${fx.tokens.cass}` } });
    assert.equal(list.status, 200);
    const groups = (await list.json()).groups;
    assert.deepEqual(groups.map((row) => row.name), ["Picnic"]);
    assert.equal(groups[0].networkId, FAMILY);

    // ...and opens it to its group detail (the Members view reads this).
    const detail = await fetch(`${base}/groups/${groupId}`, { headers: { authorization: `Bearer ${fx.tokens.cass}` } });
    assert.equal(detail.status, 200);
    const group = (await detail.json()).group;
    assert.equal(group._id, groupId);
    // The creating owner counts among the members, then the listed member.
    assert.deepEqual(group.members, [OWNER, DEVON]);
    assert.equal(group.createdBy, OWNER);
    // The Members view renders family-facing names resolved at read time
    // (PORCH-034 attribution); unset names stay null, never ids-as-names.
    assert.deepEqual(group.names, { [OWNER]: "Brian Rivers", [DEVON]: "Devon Mills" });

    // ...and opens its group timeline (origin-filtered, member-scoped).
    const timeline = await fetch(`${base}/timeline/groups/${groupId}`, { headers: { authorization: `Bearer ${fx.tokens.cass}` } });
    assert.equal(timeline.status, 200);
    assert.equal((await timeline.json()).group.name, "Picnic");

    // Anonymous reads are 401; membership is the perimeter.
    const anon = await fetch(`${base}/groups`);
    assert.equal(anon.status, 401);
    assert.equal((await anon.json()).code, "E_MUST_SIGN_IN");

    // A different origin never sees another network's groups: Devon admits
    // to the other network; that token lists an empty index and gets 404
    // on the family group.
    const otherDev = device("dev_other");
    const otherInvite = await fx.mod.inviteService.issue({ networkId: OTHER, role: "member" });
    const admitted = await fx.mod.membershipService.admit({
      code: otherInvite.token,
      identityAccessToken: DEVON,
      deviceId: otherDev.deviceId,
      devicePublicKeyJwk: otherDev.publicKeyJwk,
      signature: otherDev.sign(`porchlight-join:${otherInvite.token}`),
    });
    assert.equal(admitted.membership.networkId, OTHER);
    const otherList = await fetch(`${base}/groups`, { headers: { authorization: `Bearer ${admitted.accessToken}` } });
    assert.deepEqual((await otherList.json()).groups, []);
    const foreign = await fetch(`${base}/groups/${groupId}`, { headers: { authorization: `Bearer ${admitted.accessToken}` } });
    assert.equal(foreign.status, 404);
    assert.equal((await foreign.json()).code, "E_GROUP_UNKNOWN");
  } finally {
    close();
  }
});

/* ---- ac-2: open group creation for every member -------------------------- */

test("ac-2: any member creates a group without elevation; the creator is recorded", async () => {
  const fx = await memberFixture();
  const { base, close } = await serve(fx.mod);
  const cassAuth = { "content-type": "application/json", authorization: `Bearer ${fx.tokens.cass}` };
  try {
    const created = await fetch(`${base}/groups`, {
      method: "POST",
      headers: cassAuth,
      body: JSON.stringify({ name: "Boat Club" }),
    });
    assert.equal(created.status, 201);
    const group = (await created.json()).group;
    assert.equal(group.name, "Boat Club");
    assert.equal(group.networkId, FAMILY);
    // The creating member is recorded as the group's creator...
    assert.equal(group.createdBy, CASS);
    // ...and counts among the group's members (else they could never post into their own group).
    assert.deepEqual(group.members, [CASS]);
    // Member actions are auditable: the creation names its actor.
    const auditRow = await fx.collections.auditEvents.findOne({ action: "group_create" });
    assert.equal(auditRow.did, CASS);
    assert.equal(auditRow.detail.groupId, group._id);

    // The group is on the member-visible index for the whole network.
    const list = await fetch(`${base}/groups`, { headers: { authorization: `Bearer ${fx.tokens.pip}` } });
    assert.deepEqual((await list.json()).groups.map((row) => row._id), [group._id]);

    // No elevation required: a fresh token with no owner role creates fine
    // (the owner-role guard would be 403 — creation is the member plane).
    const anon = await fetch(`${base}/groups`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "Nope" }) });
    assert.equal(anon.status, 401);

    // A group needs a name.
    const unnamed = await fetch(`${base}/groups`, { method: "POST", headers: cassAuth, body: JSON.stringify({ name: "   " }) });
    assert.equal(unnamed.status, 400);
    assert.equal((await unnamed.json()).code, "E_GROUP_NAME_REQUIRED");

    // The subset rule holds at member creation too: a non-member DID is refused.
    const stranger = await fetch(`${base}/groups`, {
      method: "POST",
      headers: cassAuth,
      body: JSON.stringify({ name: "Stowaways", members: ["did:porchlight:stranger"] }),
    });
    assert.equal(stranger.status, 403);
    assert.equal((await stranger.json()).code, "E_GROUP_NOT_MEMBER");
  } finally {
    close();
  }
});

/* ---- ac-3: creator-managed group membership ------------------------------ */

test("ac-3: the creator adds members of the same network; authority and subset enforced", async () => {
  const fx = await memberFixture();
  const { base, close } = await serve(fx.mod);
  const cassAuth = { "content-type": "application/json", authorization: `Bearer ${fx.tokens.cass}` };
  try {
    const created = await fetch(`${base}/groups`, { method: "POST", headers: cassAuth, body: JSON.stringify({ name: "Boat Club" }) });
    const groupId = (await created.json()).group._id;

    // The creator adds a fellow network member (one DID).
    const add = await fetch(`${base}/groups/${groupId}/members`, {
      method: "POST",
      headers: cassAuth,
      body: JSON.stringify({ did: DEVON }),
    });
    assert.equal(add.status, 200);
    const added = (await add.json()).group;
    assert.deepEqual(added.members, [CASS, DEVON]);
    assert.deepEqual(added.names, { [CASS]: "Cass Porter", [DEVON]: "Devon Mills" });

    // Re-adding converges — membership stays a set.
    const again = await fetch(`${base}/groups/${groupId}/members`, {
      method: "POST",
      headers: cassAuth,
      body: JSON.stringify({ did: DEVON }),
    });
    assert.equal(again.status, 200);
    assert.deepEqual((await again.json()).group.members, [CASS, DEVON]);

    // A list body works too.
    const bulk = await fetch(`${base}/groups/${groupId}/members`, {
      method: "POST",
      headers: cassAuth,
      body: JSON.stringify({ dids: [PIP] }),
    });
    assert.equal(bulk.status, 200);
    assert.deepEqual((await bulk.json()).group.members, [CASS, DEVON, PIP]);

    // Only the creator (or the owner) manages membership: Devon, a plain
    // member who belongs to the group, still gets refused.
    const outsider = await fetch(`${base}/groups/${groupId}/members`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${fx.tokens.devon}` },
      body: JSON.stringify({ did: PIP }),
    });
    assert.equal(outsider.status, 403);
    assert.equal((await outsider.json()).code, "E_GROUP_NOT_CREATOR");

    // The subset rule: a DID that is not a member of the network cannot
    // enter the group.
    const stranger = await fetch(`${base}/groups/${groupId}/members`, {
      method: "POST",
      headers: cassAuth,
      body: JSON.stringify({ did: "did:porchlight:stranger" }),
    });
    assert.equal(stranger.status, 403);
    assert.equal((await stranger.json()).code, "E_GROUP_NOT_MEMBER");

    // The owner retains the same authority on their network.
    const ownerAdd = await fetch(`${base}/groups/${groupId}/members`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${fx.tokens.owner}` },
      body: JSON.stringify({ did: DEVON }),
    });
    assert.equal(ownerAdd.status, 200);

    // Origin containment: the family owner's token is scoped to the family
    // network and cannot touch another network's group.
    const otherGroup = await fx.groups.create({ networkId: OTHER, name: "Foreign", members: [] });
    const foreign = await fetch(`${base}/groups/${otherGroup._id}/members`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${fx.tokens.owner}` },
      body: JSON.stringify({ did: CASS }),
    });
    assert.equal(foreign.status, 404);
    assert.equal((await foreign.json()).code, "E_GROUP_UNKNOWN");

    // The Members view reads the updated roster from the group detail.
    const detail = await fetch(`${base}/groups/${groupId}`, { headers: { authorization: `Bearer ${fx.tokens.cass}` } });
    const readBack = (await detail.json()).group;
    assert.deepEqual(readBack.members, [CASS, DEVON, PIP]);
    assert.deepEqual(readBack.names, { [CASS]: "Cass Porter", [DEVON]: "Devon Mills", [PIP]: "Pip Larkin" });
  } finally {
    close();
  }
});

/* ---- ac-4: group posts ride the main timeline with the group chip -------- */

test("ac-4: group posts ride the main feed with their group chip", async () => {
  const fx = await memberFixture();
  const { base, close } = await serve(fx.mod);
  const cassAuth = { "content-type": "application/json", authorization: `Bearer ${fx.tokens.cass}` };
  try {
    const created = await fetch(`${base}/groups`, { method: "POST", headers: cassAuth, body: JSON.stringify({ name: "Boat Club" }) });
    const groupId = (await created.json()).group._id;

    // Cass adds Devon, then Devon lands a group post; Cass lands a plain
    // main-feed post.
    await fetch(`${base}/groups/${groupId}/members`, { method: "POST", headers: cassAuth, body: JSON.stringify({ did: DEVON }) });
    // Two creates can land in the same millisecond; backdate the group post
    // so the reverse-chron assert below is deterministic.
    const picnic = await mkPost(fx, fx.tokens.devon, fx.devs.devon, { type: "text", body: "picnic logistics", groupId });
    await fx.collections.posts.updateOne({ _id: picnic._id }, { $set: { createdAt: new Date(Date.now() - 10_000).toISOString() } });
    const plain = await mkPost(fx, fx.tokens.cass, fx.devs.cass, { type: "text", body: "regular post" });

    // Base timeline over HTTP: both posts render, newest first; the group
    // post carries its group chip (`groupName`), the plain post carries none.
    const response = await fetch(`${base}/timeline`, { headers: { authorization: `Bearer ${fx.tokens.cass}` } });
    assert.equal(response.status, 200);
    const posts = (await response.json()).posts;
    assert.deepEqual(posts.map((post) => post._id), [plain._id, picnic._id]);
    const chip = posts.find((post) => post._id === picnic._id);
    assert.equal(chip.groupId, groupId);
    assert.equal(chip.groupName, "Boat Club");
    assert.equal("groupName" in posts.find((post) => post._id === plain._id), false);
    // The chip is decoration only — vote privacy and rank inputs stay out of views.
    assert.equal("interactionCounters" in chip, false);

    // The ranked section rides the same path with the same chip.
    const ranked = (await fx.mod.feedService.ranked({ accessToken: fx.tokens.cass })).posts;
    assert.equal(ranked.find((post) => post._id === picnic._id).groupName, "Boat Club");

    // Group timeline is the origin-filtered query on the group.
    const groupTimeline = (await fx.mod.feedService.groupTimeline({ accessToken: fx.tokens.cass, groupId })).posts;
    assert.deepEqual(groupTimeline.map((post) => post._id), [picnic._id]);
  } finally {
    close();
  }
});