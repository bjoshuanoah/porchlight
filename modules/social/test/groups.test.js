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

test("ac-1: the groups index and detail render for members; a private group hides from non-members", async () => {
  const fx = await memberFixture();
  const { base, close } = await serve(fx.mod);
  const ownerAuth = { "content-type": "application/json", authorization: `Bearer ${fx.tokens.owner}` };
  const devonAuth = { authorization: `Bearer ${fx.tokens.devon}` };
  try {
    const created = await fetch(`${base}/console/groups`, {
      method: "POST",
      headers: ownerAuth,
      body: JSON.stringify({ name: "Picnic", members: [DEVON] }),
    });
    assert.equal(created.status, 201);
    const groupId = (await created.json()).group._id;

    // PORCH-068 ac-2: the group is private by default — a member who holds
    // no group membership never sees it on the index.
    const cassList = await fetch(`${base}/groups`, { headers: { authorization: `Bearer ${fx.tokens.cass}` } });
    assert.equal(cassList.status, 200);
    assert.deepEqual((await cassList.json()).groups.map((row) => row.name), []);

    // ...and the private group's detail (the Members view's read) and
    // timeline are refused unknown-shaped, as if it did not exist.
    const CassAuth = { authorization: `Bearer ${fx.tokens.cass}` };
    const hidden = await fetch(`${base}/groups/${groupId}`, { headers: CassAuth });
    assert.equal(hidden.status, 404);
    assert.equal((await hidden.json()).code, "E_GROUP_UNKNOWN");
    const hiddenTimeline = await fetch(`${base}/timeline/groups/${groupId}`, { headers: CassAuth });
    assert.equal(hiddenTimeline.status, 404);

    // A group member reads the index and opens the detail (the Members view).
    const list = await fetch(`${base}/groups`, { headers: devonAuth });
    assert.equal(list.status, 200);
    const groups = (await list.json()).groups;
    assert.deepEqual(groups.map((row) => row.name), ["Picnic"]);
    assert.equal(groups[0].networkId, FAMILY);

    const detail = await fetch(`${base}/groups/${groupId}`, { headers: devonAuth });
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
    const timeline = await fetch(`${base}/timeline/groups/${groupId}`, { headers: devonAuth });
    assert.equal(timeline.status, 200);
    assert.equal((await timeline.json()).group.name, "Picnic");

    // A member who belongs flips it public; then every member sees it on
    // the index and opens the detail (PORCH-068 ac-1 change + ac-3).
    const flip = await fetch(`${base}/groups/${groupId}/visibility`, {
      method: "POST",
      headers: { "content-type": "application/json", ...ownerAuth },
      body: JSON.stringify({ visibility: "public" }),
    });
    assert.equal(flip.status, 200);
    assert.equal((await flip.json()).group.visibility, "public");
    const cassAfter = await fetch(`${base}/groups/${groupId}`, { headers: CassAuth });
    assert.equal(cassAfter.status, 200);
    assert.equal((await cassAfter.json()).group.members.length, 2);

    // A plain member who manages nothing cannot flip it.
    const strangerFlip = await fetch(`${base}/groups/${groupId}/visibility`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${fx.tokens.devon}` },
      body: JSON.stringify({ visibility: "private" }),
    });
    assert.equal(strangerFlip.status, 403);
    assert.equal((await strangerFlip.json()).code, "E_GROUP_NOT_CREATOR");
    // ...and an invalid visibility never stores.
    const invalidFlip = await fetch(`${base}/groups/${groupId}/visibility`, {
      method: "POST",
      headers: { "content-type": "application/json", ...ownerAuth },
      body: JSON.stringify({ visibility: "secret" }),
    });
    assert.equal(invalidFlip.status, 400);
    assert.equal((await invalidFlip.json()).code, "E_GROUP_VISIBILITY_INVALID");

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

/* ---- ac-1 (PORCH-068): private default, public opt-in, legacy resolution -- */

test("ac-1: new groups default private, public needs the pick, legacy rows resolve private", async () => {
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
    assert.equal(group.visibility, "private", "a new group defaults private");

    // An explicit public pick stores public.
    const opened = await fetch(`${base}/groups`, {
      method: "POST",
      headers: cassAuth,
      body: JSON.stringify({ name: "Harbor", visibility: "public" }),
    });
    assert.equal((await opened.json()).group.visibility, "public");

    // An unknown pick is refused.
    const bad = await fetch(`${base}/groups`, {
      method: "POST",
      headers: cassAuth,
      body: JSON.stringify({ name: "Nah", visibility: "secret" }),
    });
    assert.equal(bad.status, 400);
    assert.equal((await bad.json()).code, "E_GROUP_VISIBILITY_INVALID");

    // Groups before this change carry no visibility field and resolve
    // private — Brian's sister's group class.
    const legacy = {
      _id: "grp_legacy", networkId: FAMILY, name: "Sister's group",
      createdBy: DEVON, members: [DEVON], createdAt: new Date().toISOString(),
    };
    await fx.collections.groups.insertOne(legacy);
    // The old row resolves private: the member inside it (Devon) still
    // sees it on their index; the member outside it (Pip) does not.
    const devonRows = (await (await fetch(`${base}/groups`, { headers: { authorization: `Bearer ${fx.tokens.devon}` } })).json()).groups.map((row) => row.name).sort();
    assert.deepEqual(devonRows, ["Harbor", "Sister's group"], "a member of the legacy group still sees it");
    const pipRows = (await (await fetch(`${base}/groups`, { headers: { authorization: `Bearer ${fx.tokens.pip}` } })).json()).groups.map((row) => row.name);
    assert.deepEqual(pipRows, ["Harbor"], "the legacy private group hides from a non-member");
    // The legacy group's member list renders only for its members.
    const nonMember = await fetch(`${base}/groups/grp_legacy`, { headers: { authorization: `Bearer ${fx.tokens.pip}` } });
    assert.equal(nonMember.status, 404);
  } finally {
    close();
  }
});

/* ---- ac-2 (PORCH-068): private-group posts hide from non-members ---------- */

test("ac-2: a private-group post never renders for a non-member on any surface", async () => {
  const fx = await memberFixture();
  const { close } = await serve(fx.mod);
  try {
    const group = await fx.groups.create({ networkId: FAMILY, name: "Picnic", members: [CASS], createdBy: CASS });
    await fx.collections.groups.updateOne({ _id: group._id }, { $set: { members: [CASS] } });
    const secret = await mkPost(fx, fx.tokens.cass, fx.devs.cass, { type: "text", body: "hidden from pip", caption: "secret picnic", groupId: group._id });
    const plain = await mkPost(fx, fx.tokens.cass, fx.devs.cass, { type: "text", body: "plain post" });

    // A group member sees both posts on the main feed, and the private
    // post's group timeline (the standing group-post rule keeps).
    const memberFeed = (await fx.mod.feedService.timeline({ accessToken: fx.tokens.cass })).posts.map((post) => post._id).sort();
    assert.deepEqual(memberFeed, [plain._id, secret._id].sort());
    const groupTimeline = (await fx.mod.feedService.groupTimeline({ accessToken: fx.tokens.cass, groupId: group._id })).posts;
    assert.deepEqual(groupTimeline.map((post) => post._id), [secret._id]);

    // A non-member sees only the plain post everywhere: main feed, ranked,
    // search (matching the private post's caption), and the legacy list read.
    const feed = (await fx.mod.feedService.timeline({ accessToken: fx.tokens.pip })).posts.map((post) => post._id);
    assert.deepEqual(feed, [plain._id]);
    const ranked = (await fx.mod.feedService.ranked({ accessToken: fx.tokens.pip })).posts.map((post) => post._id);
    assert.deepEqual(ranked, [plain._id]);
    const results = (await fx.mod.feedService.search({ accessToken: fx.tokens.pip, query: "secret picnic" })).posts.map((post) => post._id);
    assert.deepEqual(results, []);
    const listed = (await fx.mod.postService.list({ accessToken: fx.tokens.pip })).posts.map((post) => post._id);
    assert.deepEqual(listed, [plain._id]);

    // The private post's detail reads as not-found for the non-member.
    await assert.rejects(
      () => fx.mod.postService.get({ accessToken: fx.tokens.pip, postId: secret._id }),
      (error) => error.code === "E_POST_NOT_FOUND",
    );

    // Its conversation refuses the non-member plain-language on reads too.
    await assert.rejects(
      () => fx.mod.interactionService.commentThread({ accessToken: fx.tokens.pip, postId: secret._id }),
      (error) => error.code === "E_GROUP_NOT_MEMBER",
    );
    await assert.rejects(
      () => fx.mod.interactionService.reactionsFor({ accessToken: fx.tokens.pip, postId: secret._id }),
      (error) => error.code === "E_GROUP_NOT_MEMBER",
    );

    // Albums skip the private post entirely: a non-member's album list
    // never counts it, even when a member keyed it into an album.
    const payload = { kind: "album.add", networkId: FAMILY, postId: secret._id, album: "Boat trip" };
    await fx.mod.albumService.addItem({ accessToken: fx.tokens.cass, name: "Boat trip", postId: secret._id, signature: fx.devs.cass.signPayload(payload) });
    const albums = (await fx.mod.albumService.list({ accessToken: fx.tokens.pip })).albums;
    assert.deepEqual(albums, [], "the album renders nothing for the non-member");
  } finally {
    close();
  }
});

/* ---- ac-3 (PORCH-068): public groups viewable by the whole network --------- */

test("ac-3: a public group and its posts render for the whole network; non-member writes still refuse", async () => {
  const fx = await memberFixture();
  const { base, close } = await serve(fx.mod);
  try {
    const group = await fx.groups.create({ networkId: FAMILY, name: "Harbor", members: [CASS], createdBy: CASS, visibility: "public" });
    const groupId = group._id;
    const harbor = await mkPost(fx, fx.tokens.cass, fx.devs.cass, { type: "text", body: "dock party", groupId });

    // Every member sees the group on the index and opens detail + timeline.
    const list = (await (await fetch(`${base}/groups`, { headers: { authorization: `Bearer ${fx.tokens.pip}` } })).json()).groups.map((row) => row._id);
    assert.deepEqual(list, [groupId]);
    const detail = await fetch(`${base}/groups/${groupId}`, { headers: { authorization: `Bearer ${fx.tokens.pip}` } });
    assert.equal(detail.status, 200);
    const timeline = await fetch(`${base}/timeline/groups/${groupId}`, { headers: { authorization: `Bearer ${fx.tokens.pip}` } });
    assert.equal(timeline.status, 200);
    assert.deepEqual((await timeline.json()).posts.map((post) => post._id), [harbor._id]);

    // The post rides the whole network's main feed and ranked path exactly
    // as today (with its group chip for every viewer).
    void groupId;
    const pipFeed = (await fx.mod.feedService.timeline({ accessToken: fx.tokens.pip })).posts;
    assert.ok(pipFeed.some((post) => post._id === harbor._id));
    assert.equal(pipFeed.find((post) => post._id === harbor._id).groupName, "Harbor");
    const pipRanked = (await fx.mod.feedService.ranked({ accessToken: fx.tokens.pip })).posts;
    assert.ok(pipRanked.some((post) => post._id === harbor._id));

    // Public conversation reads stay open to any network member.
    const comments = await fx.mod.interactionService.commentThread({ accessToken: fx.tokens.pip, postId: harbor._id });
    assert.deepEqual(comments.comments, []);

    // Trailing spec point ([Assumed], open pending Brian): viewing is the
    // ruling for non-members — posting rights into a public group stay
    // governed by the shipped membership gate, which refuses the non-member
    // with plain language and zero documents.
    const payload = { type: "text", body: "nope", groupId };
    await assert.rejects(
      () => fx.mod.postService.create({ accessToken: fx.tokens.pip, payload, signature: fx.devs.pip.signPayload(payload) }),
      (error) => error.code === "E_GROUP_NOT_MEMBER",
    );
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

    // The private group is on the index only for its members (PORCH-068):
    // the creator sees it; a member outside the group does not.
    const ownIndex = await fetch(`${base}/groups`, { headers: { authorization: `Bearer ${fx.tokens.cass}` } });
    assert.deepEqual((await ownIndex.json()).groups.map((row) => row._id), [group._id]);
    const otherIndex = await fetch(`${base}/groups`, { headers: { authorization: `Bearer ${fx.tokens.pip}` } });
    assert.deepEqual((await otherIndex.json()).groups.map((row) => row._id), []);

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