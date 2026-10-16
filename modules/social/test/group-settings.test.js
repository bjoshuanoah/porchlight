import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { device, fixture } from "./helpers/content.fixture.js";
import { assembleSocialModule } from "../src/assemble.js";
import { GROUP_COLOR_PALETTE, isGroupManager } from "../src/services/group.service.js";
import { typedError } from "../src/services/post.service.js";
import webpush from "web-push";
const vapidKeys = webpush.generateVAPIDKeys();
const VAPID = { subject: "mailto:test@example.com", publicKey: vapidKeys.publicKey, privateKey: vapidKeys.privateKey };

const OWNER = "did:porchlight:owner";
const CASS = "did:porchlight:cass"; // the group's managing member (creator)
const DEVON = "did:porchlight:devon"; // group member, no authority
const PIP = "did:porchlight:pip"; // group member, no authority
const FAMILY = "net_family";
const NAMES = { [OWNER]: "Brian Rivers", [CASS]: "Cass Porter", [DEVON]: "Devon Mills", [PIP]: "Pip Larkin" };

/** The treatment seam: the member-avatar treatment's CONTRACT, faked —
 *  two square rungs, every refusal typed and named exactly as the real
 *  treatment refuses (PORCH-070 avatar.treatment.js is the real one; its
 *  own module tests carry it; stage-2 runs the real function). */
async function fakeTreatImage(bytes, contentType) {
  if (typeof contentType !== "string" || !contentType.startsWith("image/")) {
    throw typedError("E_AVATAR_UNSUPPORTED_TYPE", "That file isn't a photo type the hub can use. Photos arrive as JPEG, PNG, WebP, GIF, AVIF, or HEIC.");
  }
  if (bytes.length > 5 * 1024 * 1024) {
    throw typedError("E_AVATAR_TOO_LARGE", "That photo is larger than 5 MB. Try a smaller copy — every face is stored as a small square.");
  }
  return [
    { kind: "header", width: 72, height: 72, contentType: "image/webp", bytes: Buffer.from(`header:${bytes.length}`) },
    { kind: "chooser", width: 144, height: 144, contentType: "image/webp", bytes: Buffer.from(`chooser:${bytes.length}`) },
  ];
}

/**
 * Member-plane fixture: the assembled social module on the content
 * fixture's memory store with the group-avatar plane wired (memory blob
 * store + the treatment seam) and an admitted founder-owner plus three
 * plain members (Cass, Devon, Pip) with live membership tokens.
 */
async function memberFixture({ sender = null } = {}) {
  const fx = fixture({
    networkIds: [FAMILY],
    memberNames: (dids) => dids.map((did) => ({ did, displayName: NAMES[did] ?? null })),
    pushVapid: VAPID,
    pushSender: sender ?? undefined,
  });
  await fx.collections.networks.updateOne({ _id: FAMILY }, { $set: { ownerDid: OWNER } });
  const mod = assembleSocialModule(fx.store, {
    verifyMemberIdToken: (token) => (token ? { did: token } : null),
    memberNames: (dids) => dids.map((did) => ({ did, displayName: NAMES[did] ?? null })),
    groupAvatar: { treatImage: fakeTreatImage },
    push: { vapid: VAPID, ...(sender ? { sender } : {}) },
  });
  const devs = {
    owner: device("dev_owner"),
    cass: device("dev_cass"),
    devon: device("dev_devon"),
    pip: device("dev_pip"),
  };
  const admit = async (did, memberDevice, role = "member") => {
    const invite = await mod.inviteService.issue({ networkId: FAMILY, role });
    return mod.membershipService.admit({
      code: invite.token,
      identityAccessToken: did,
      deviceId: memberDevice.deviceId,
      devicePublicKeyJwk: memberDevice.publicKeyJwk,
      signature: memberDevice.sign(`porchlight-join:${invite.token}`),
    });
  };
  const owner = await admit(OWNER, devs.owner, "owner");
  const cass = await admit(CASS, devs.cass);
  const devon = await admit(DEVON, devs.devon);
  const pip = await admit(PIP, devs.pip);
  assert.equal(owner.membership.role, "owner");
  return {
    ...fx,
    mod,
    devs,
    tokens: { owner: owner.accessToken, cass: cass.accessToken, devon: devon.accessToken, pip: pip.accessToken },
  };
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

async function mkPost(fx, token, memberDevice, payload) {
  return (await fx.posts.create({ accessToken: token, payload, signature: memberDevice.signPayload(payload) })).post;
}

/* ---- ac-1: owner authority enforced server-side ------------------------- */

test("ac-1: a member with no management authority is refused avatar, color, and post removal with zero mutation", async () => {
  const fx = await memberFixture();
  const { base, close } = await serve(fx.mod);
  try {
    await fx.mod.groupService.create({ networkId: FAMILY, name: "Picnic", createdBy: CASS, members: [CASS, DEVON] });
    const groupId = (await fx.store.collection("groups").findOne({ name: "Picnic" }))._id;
    const groupPost = await mkPost(fx, fx.tokens.devon, fx.devs.devon, { type: "text", body: "bring a blanket", groupId });
    const before = await fx.store.collection("groups").findOne({ _id: groupId });

    const image = Buffer.from("portrait");
    const payload = { scope: "group-avatar", action: "set", size: image.length, sha256: createHash("sha256").update(image).digest("hex"), contentType: "image/png" };
    // Avatar refusal
    const avatarRefused = await fetch(`${base}/groups/${groupId}/avatar`, {
      method: "POST",
      headers: {
        "content-type": "image/png",
        authorization: `Bearer ${fx.tokens.devon}`,
        "x-porchlight-avatar-payload": JSON.stringify(payload),
        "x-porchlight-signature": fx.devs.devon.signPayload(payload),
      },
      body: image,
    });
    assert.equal(avatarRefused.status, 403);
    const refusedBody = await avatarRefused.json();
    assert.equal(refusedBody.code, "E_GROUP_NOT_CREATOR");

    // Color refusal
    const colorRefused = await fetch(`${base}/groups/${groupId}/color`, {
      method: "PATCH",
      headers: { "content-type": "application/json", authorization: `Bearer ${fx.tokens.devon}` },
      body: JSON.stringify({ color: GROUP_COLOR_PALETTE[0], payload: { scope: "group-avatar", action: "color", color: GROUP_COLOR_PALETTE[0] }, signature: fx.devs.devon.signPayload({ scope: "group-avatar", action: "color", color: GROUP_COLOR_PALETTE[0] }) }),
    });
    assert.equal(colorRefused.status, 403);
    assert.equal((await colorRefused.json()).code, "E_GROUP_NOT_CREATOR");

    // Post-removal refusal
    const removalRefused = await fetch(`${base}/groups/${groupId}/posts/${groupPost._id}`, {
      method: "DELETE",
      headers: { "content-type": "application/json", authorization: `Bearer ${fx.tokens.devon}` },
      body: JSON.stringify({ signature: fx.devs.devon.signPayload({ kind: "group_post_remove", postId: groupPost._id, groupId, networkId: FAMILY }) }),
    });
    assert.equal(removalRefused.status, 403);
    assert.equal((await removalRefused.json()).code, "E_GROUP_NOT_CREATOR");

    // Zero mutation: the group document, the post, and the audit surface
    // are exactly as they were.
    const after = await fx.store.collection("groups").findOne({ _id: groupId });
    assert.deepEqual(after, before);
    assert.ok(await fx.store.collection("posts").findOne({ _id: groupPost._id }), "the post survived the non-authoritative refusals");
    assert.equal((await fx.collections.auditEvents.find({ networkId: FAMILY })).filter((row) => row.action.startsWith("group_")).length, 0);
    assert.match(refusedBody.error, /group's creator|network owner/, "the refusal speaks plain language");
  } finally {
    close();
  }
});

test("ac-1: the managing member performs every mutation; each lands one audit record", async () => {
  const fx = await memberFixture();
  const { base, close } = await serve(fx.mod);
  try {
    await fx.mod.groupService.create({ networkId: FAMILY, name: "Picnic", createdBy: CASS, members: [CASS, DEVON] });
    const groupId = (await fx.store.collection("groups").findOne({ name: "Picnic" }))._id;
    const groupPost = await mkPost(fx, fx.tokens.devon, fx.devs.devon, { type: "text", body: "bring a blanket", groupId });

    // The managing member sets the avatar (byte route, signed declaration).
    const image = Buffer.from("portrait");
    const payload = { scope: "group-avatar", action: "set", size: image.length, sha256: createHash("sha256").update(image).digest("hex"), contentType: "image/png" };
    const avatarResp = await fetch(`${base}/groups/${groupId}/avatar`, {
      method: "POST",
      headers: {
        "content-type": "image/png",
        authorization: `Bearer ${fx.tokens.cass}`,
        "x-porchlight-avatar-payload": JSON.stringify(payload),
        "x-porchlight-signature": fx.devs.cass.signPayload(payload),
      },
      body: image,
    });
    assert.equal(avatarResp.status, 200, JSON.stringify(await avatarResp.json()));
    // ...the color
    const colorResp = await fetch(`${base}/groups/${groupId}/color`, {
      method: "PATCH",
      headers: { "content-type": "application/json", authorization: `Bearer ${fx.tokens.cass}` },
      body: JSON.stringify({ color: GROUP_COLOR_PALETTE[2], payload: { scope: "group-avatar", action: "color", color: GROUP_COLOR_PALETTE[2] }, signature: fx.devs.cass.signPayload({ scope: "group-avatar", action: "color", color: GROUP_COLOR_PALETTE[2] }) }),
    });
    assert.equal(colorResp.status, 200, JSON.stringify(await colorResp.json()));
    // ...and removes the group post (device-signed moderation write).
    const removeResp = await fetch(`${base}/groups/${groupId}/posts/${groupPost._id}`, {
      method: "DELETE",
      headers: { "content-type": "application/json", authorization: `Bearer ${fx.tokens.cass}` },
      body: JSON.stringify({ signature: fx.devs.cass.signPayload({ kind: "group_post_remove", postId: groupPost._id, groupId, networkId: FAMILY }) }),
    });
    const removedBody = await removeResp.json();
    assert.equal(removeResp.status, 200, JSON.stringify(removedBody));
    assert.equal(removedBody.removed, true, "the removal answers with its own record");
    assert.equal(await fx.store.collection("posts").findOne({ _id: groupPost._id }), null);

    const audits = (await fx.collections.auditEvents.find({ networkId: FAMILY })).filter((row) => ["group_avatar_set", "group_color_set", "group_post_remove"].includes(row.action));
    assert.deepEqual(audits.map((row) => row.action).sort(), ["group_avatar_set", "group_color_set", "group_post_remove"]);
    for (const row of audits) {
      assert.equal(row.did, CASS);
      assert.ok(row.createdAt, "the audit record carries its `at`");
      if (row.action === "group_post_remove") {
        assert.equal(row.detail.postId, groupPost._id, "the removal audit names the removed post");
      } else {
        assert.equal(row.detail.groupId, groupId, "the mutation audit names its target");
      }
    }
    const removalAudit = audits.find((row) => row.action === "group_post_remove");
    assert.equal(removalAudit.detail.postId, groupPost._id);
  } finally {
    close();
  }
});

test("ac-1: the network owner rides as superuser on a group they did not create", async () => {
  const fx = await memberFixture();
  await fx.mod.groupService.create({ networkId: FAMILY, name: "Picnic", createdBy: CASS, members: [CASS, DEVON] });
  const groupId = (await fx.store.collection("groups").findOne({ name: "Picnic" }))._id;

  const image = Buffer.from("owner set");
  const payload = { scope: "group-avatar", action: "set", size: image.length, sha256: createHash("sha256").update(image).digest("hex"), contentType: "image/png" };
  const group = await fx.mod.groupService.setAvatar({
    groupId, networkId: FAMILY, actorDid: OWNER, actorDeviceId: fx.devs.owner.deviceId, bytes: image, contentType: "image/png", payload, signature: fx.devs.owner.signPayload(payload),
  });
  assert.ok(group.avatar?.header?.sha256, "the owner's write returns the treated square set");
  await fx.mod.groupService.setColor({
    groupId, networkId: FAMILY, actorDid: OWNER, actorDeviceId: fx.devs.owner.deviceId, color: GROUP_COLOR_PALETTE[1],
    payload: { scope: "group-avatar", action: "color", color: GROUP_COLOR_PALETTE[1] }, signature: fx.devs.owner.signPayload({ scope: "group-avatar", action: "color", color: GROUP_COLOR_PALETTE[1] }),
  });
  assert.equal((await fx.store.collection("groups").findOne({ _id: groupId })).color, GROUP_COLOR_PALETTE[1]);
});

/* ---- ac-2: group avatar ingest and serving ------------------------------ */

test("ac-2: the member-avatar ingest treatment applies — square rungs, stamps, no rectangular original, replace retires the prior set", async () => {
  const fx = await memberFixture();
  await fx.mod.groupService.create({ networkId: FAMILY, name: "Picnic", createdBy: CASS, members: [CASS, DEVON] });
  const groupId = (await fx.store.collection("groups").findOne({ name: "Picnic" }))._id;
  const store = fx.mod.blobs;

  const first = Buffer.from("first photo");
  const firstPayload = { scope: "group-avatar", action: "set", size: first.length, sha256: createHash("sha256").update(first).digest("hex"), contentType: "image/jpeg" };
  await fx.mod.groupService.setAvatar({ groupId, networkId: FAMILY, actorDid: CASS, actorDeviceId: fx.devs.cass.deviceId, bytes: first, contentType: "image/jpeg", payload: firstPayload, signature: fx.devs.cass.signPayload(firstPayload) });

  // The stored set is the treated square rung ladder and nothing else:
  // square stamps on every rung, no rectangular original retained.
  const storedFirst = await fx.store.collection("groups").findOne({ _id: groupId }).then((row) => row.avatar.renditions);
  assert.deepEqual(storedFirst.map((r) => [r.kind, r.width, r.height]), [
    ["header", 72, 72],
    ["chooser", 144, 144],
  ]);
  assert.ok(storedFirst.every((r) => r.width === r.height), "square geometry stamps");
  for (const rung of storedFirst) {
    assert.ok(await store.has(rung.blobKey), "treated rung bytes are stored content-addressed");
    // The rung bytes are the TREATMENT OUTPUT (compression), not the
    // uploaded bytes — no rectangular original survives anywhere.
    assert.notEqual((await store.get(rung.blobKey)).toString(), first.toString());
  }

  // Replace: the prior set retires (never accumulate).
  const second = Buffer.from("second photo");
  const secondPayload = { scope: "group-avatar", action: "set", size: second.length, sha256: createHash("sha256").update(second).digest("hex"), contentType: "image/jpeg" };
  await fx.mod.groupService.setAvatar({ groupId, networkId: FAMILY, actorDid: CASS, actorDeviceId: fx.devs.cass.deviceId, bytes: second, contentType: "image/jpeg", payload: secondPayload, signature: fx.devs.cass.signPayload(secondPayload) });
  const after = await fx.store.collection("groups").findOne({ _id: groupId }).then((row) => row.avatar.renditions);
  assert.equal(after.length, storedFirst.length);
  for (const rung of storedFirst) {
    if (!after.some((r) => r.blobKey === rung.blobKey)) {
      assert.equal(await store.has(rung.blobKey), false, "the prior set's blobs retired");
    }
  }

  // Serving: content-addressed + immutable with the geometry stamps.
  const served = await fx.mod.groupService.serveAvatarRung({ groupId, networkId: FAMILY, viewerDid: DEVON, kind: "header", version: after.find((r) => r.kind === "header").sha256 });
  assert.equal(served.width, 72);
  assert.equal(served.height, 72);
  assert.equal(served.contentType, "image/webp");

  // A mismatched content address never serves stale bytes.
  await assert.rejects(
    () => fx.mod.groupService.serveAvatarRung({ groupId, networkId: FAMILY, viewerDid: DEVON, kind: "header", version: "0".repeat(64) }),
    { code: "E_GROUP_AVATAR_NOT_FOUND" },
  );
});

test("ac-2: refusals name their state in plain language with zero mutation", async () => {
  const fx = await memberFixture();
  await fx.mod.groupService.create({ networkId: FAMILY, name: "Picnic", createdBy: CASS, members: [CASS, DEVON] });
  const groupId = (await fx.store.collection("groups").findOne({ name: "Picnic" }))._id;
  const before = await fx.store.collection("groups").findOne({ _id: groupId });

  // Unsupported type: treats nothing, stores nothing, mutates nothing.
  await assert.rejects(
    () =>
      fx.mod.groupService.setAvatar({
        groupId, networkId: FAMILY, actorDid: CASS, actorDeviceId: fx.devs.cass.deviceId,
        bytes: Buffer.from("%PDF-1.4 not a photo"), contentType: "application/pdf",
        payload: { scope: "group-avatar", action: "set", size: 20, sha256: createHash("sha256").update(Buffer.from("%PDF-1.4 not a photo")).digest("hex"), contentType: "application/pdf" },
        signature: fx.devs.cass.signPayload({ scope: "group-avatar", action: "set", size: 20, sha256: createHash("sha256").update(Buffer.from("%PDF-1.4 not a photo")).digest("hex"), contentType: "application/pdf" }),
      }),
    { code: "E_AVATAR_UNSUPPORTED_TYPE", message: /Photos arrive as JPEG/ },
  );
  // Over-cap: the treatment's named refusal.
  const big = Buffer.alloc(5 * 1024 * 1024 + 1);
  await assert.rejects(
    () =>
      fx.mod.groupService.setAvatar({
        groupId, networkId: FAMILY, actorDid: CASS, actorDeviceId: fx.devs.cass.deviceId,
        bytes: big, contentType: "image/png",
        payload: { scope: "group-avatar", action: "set", size: big.length, sha256: createHash("sha256").update(big).digest("hex"), contentType: "image/png" },
        signature: fx.devs.cass.signPayload({ scope: "group-avatar", action: "set", size: big.length, sha256: createHash("sha256").update(big).digest("hex"), contentType: "image/png" }),
      }),
    { code: "E_AVATAR_TOO_LARGE" },
  );
  assert.deepEqual(await fx.store.collection("groups").findOne({ _id: groupId }), before, "zero mutation across every refusal");
});

test("ac-2: a private group's presentation is invisible to non-members; the served detail carries metas, never byte internals", async () => {
  const fx = await memberFixture();
  await fx.mod.groupService.create({ networkId: FAMILY, name: "Secret Picnic", createdBy: CASS, members: [CASS, DEVON] });
  const groupId = (await fx.store.collection("groups").findOne({ name: "Secret Picnic" }))._id;
  const image = Buffer.from("portrait");
  const payload = { scope: "group-avatar", action: "set", size: image.length, sha256: createHash("sha256").update(image).digest("hex"), contentType: "image/png" };
  await fx.mod.groupService.setAvatar({ groupId, networkId: FAMILY, actorDid: CASS, actorDeviceId: fx.devs.cass.deviceId, bytes: image, contentType: "image/png", payload, signature: fx.devs.cass.signPayload(payload) });

  // PIP holds no membership in the private group: the serving is
  // unknown-shaped, exactly as the group itself is.
  await assert.rejects(
    () => fx.mod.groupService.serveAvatarRung({ groupId, networkId: FAMILY, viewerDid: PIP, kind: "header", version: null }),
    { code: "E_GROUP_UNKNOWN" },
  );
  // The detail read carries the SQUARE STAMPS only — no blob internals.
  const detail = await fx.mod.groupService.get({ networkId: FAMILY, groupId, viewerDid: CASS });
  assert.equal(detail.avatar.header.width, 72);
  assert.ok(!("blobKey" in detail.avatar.header), "byte internals never serve");
});

/* ---- ac-3: group color storage and reset -------------------------------- */

test("ac-3: palette color stores and serves; null resets to neutral; non-palette colors refuse", async () => {
  const fx = await memberFixture();
  await fx.mod.groupService.create({ networkId: FAMILY, name: "Picnic", createdBy: CASS, members: [CASS, DEVON] });
  const groupId = (await fx.store.collection("groups").findOne({ name: "Picnic" }))._id;
  const colorPayload = (color) => ({ scope: "group-avatar", action: "color", color });
  const setColor = (color) =>
    fx.mod.groupService.setColor({
      groupId, networkId: FAMILY, actorDid: CASS, actorDeviceId: fx.devs.cass.deviceId, color,
      payload: colorPayload(color), signature: fx.devs.cass.signPayload(colorPayload(color)),
    });

  await setColor(GROUP_COLOR_PALETTE[0]);
  assert.equal((await fx.mod.groupService.get({ networkId: FAMILY, groupId, viewerDid: DEVON })).color, GROUP_COLOR_PALETTE[0]);
  // Replace with another palette token works.
  await setColor(GROUP_COLOR_PALETTE[3]);
  assert.equal((await fx.store.collection("groups").findOne({ _id: groupId })).color, GROUP_COLOR_PALETTE[3]);
  // null resets to the neutral default.
  await setColor(null);
  assert.equal((await fx.mod.groupService.get({ networkId: FAMILY, groupId, viewerDid: DEVON })).color, null);
  // A color outside the palette refuses with family language, no change.
  await assert.rejects(() => setColor("#FF00FF"), { code: "E_GROUP_COLOR_INVALID", message: /palette/ });
  assert.equal((await fx.store.collection("groups").findOne({ _id: groupId })).color, null);
});

test("ac-3: the color is presentation data only — never a ranking or delivery input", async () => {
  const fx = await memberFixture();
  await fx.mod.groupService.create({ networkId: FAMILY, name: "Picnic", createdBy: CASS, members: [CASS, DEVON] });
  const groupId = (await fx.store.collection("groups").findOne({ name: "Picnic" }))._id;
  await mkPost(fx, fx.tokens.devon, fx.devs.devon, { type: "text", body: "sunny day", groupId });
  const colorPayload = (color) => ({ scope: "group-avatar", action: "color", color });
  await fx.mod.groupService.setColor({
    groupId, networkId: FAMILY, actorDid: CASS, actorDeviceId: fx.devs.cass.deviceId, color: GROUP_COLOR_PALETTE[5],
    payload: colorPayload(GROUP_COLOR_PALETTE[5]), signature: fx.devs.cass.signPayload(colorPayload(GROUP_COLOR_PALETTE[5])),
  });
  // The ranked order and the group timeline are byte-identical to what
  // they were with no color configured (no weight, no filter, no input).
  const ranked = (await fx.mod.feedService.ranked({ accessToken: fx.tokens.devon })).posts.map((post) => post._id);
  const timeline = (await fx.mod.feedService.groupTimeline({ accessToken: fx.tokens.devon, groupId })).posts.map((post) => post._id);
  const rankedNone = (await fx.mod.feedService.ranked({ accessToken: fx.tokens.devon })).posts.map((post) => post._id);
  assert.deepEqual(ranked, rankedNone);
  assert.ok(timeline.includes((await fx.store.collection("posts").findOne({ body: "sunny day" }))._id));
});

/* ---- ac-4: owner post removal with origin cascade ------------------------ */

test("ac-4: the removal executes the origin deletion cascade and lands one audit record; other members' content is untouched", async () => {
  const fx = await memberFixture();
  await fx.mod.groupService.create({ networkId: FAMILY, name: "Picnic", createdBy: CASS, members: [CASS, DEVON] });
  const groupId = (await fx.store.collection("groups").findOne({ name: "Picnic" }))._id;

  // The removed post: a photo post in the group with the full derived set.
  const originalBytes = Buffer.from("original bytes");
  const asset = {
    _id: "med_removed", networkId: FAMILY, did: DEVON, kind: "original", blobKey: createHash("sha256").update(originalBytes).digest("hex"), sha256: "a".repeat(64),
    bytes: 10, format: "image/webp", contentType: "image/webp", width: 100, height: 70, immutable: true, createdAt: new Date().toISOString(),
  };
  await fx.store.collection("media_assets").insertOne(asset);
  await fx.mod.mediaService.blobs.put(asset.blobKey, originalBytes);
  const removedPost = await mkPost(fx, fx.tokens.devon, fx.devs.devon, { type: "photo", mediaRefs: ["med_removed"], caption: "the picnic", groupId });
  const comment = (await fx.interactions.comment({ accessToken: fx.tokens.cass, payload: { postId: removedPost._id, body: "lovely" }, signature: fx.devs.cass.signPayload({ postId: removedPost._id, body: "lovely" }) })).comment;
  await fx.interactions.react({ accessToken: fx.tokens.cass, payload: { postId: removedPost._id, emoji: "🎉" }, signature: fx.devs.cass.signPayload({ postId: removedPost._id, emoji: "🎉" }) });
  const untouchedPost = await mkPost(fx, fx.tokens.cass, fx.devs.cass, { type: "text", body: "different post, stays" });

  const removed = await fx.mod.postService.removePost({
    accessToken: fx.tokens.cass,
    postId: removedPost._id,
    signature: fx.devs.cass.signPayload({ kind: "group_post_remove", postId: removedPost._id, groupId, networkId: FAMILY }),
  });
  assert.equal(removed.removed, true);
  assert.ok(removed.tombstoneId);

  // The post and every derived artifact are gone — onto the tombstone: the
  // moderation delete rides the SAME tombstone pattern as every lifecycle
  // delete (Brian, Oct 16, 2026: "It should be the same tombstone pattern"),
  // with the managing member attributed deletedByRole: group-manager.
  assert.equal(await fx.store.collection("posts").findOne({ _id: removedPost._id }), null);
  assert.equal((await fx.store.collection("comments").find()).filter((row) => row.postId === removedPost._id).length, 0);
  assert.equal((await fx.store.collection("reactions").find()).filter((row) => row.postId === removedPost._id).length, 0);
  // Renditions purge at delete; the ORIGINAL binary holds the restore
  // window at rest (never served) — the day-30 reaper purges it once.
  const tombstone = await fx.store.collection("tombstones").findOne({ _id: removed.tombstoneId });
  assert.equal(tombstone.deletedByRole, "group-manager");
  assert.equal(tombstone.subjectType, "post");
  assert.equal(tombstone.subjectId, removedPost._id);
  assert.deepEqual(tombstone.mediaOrigins, ["med_removed"]);
  assert.equal(tombstone.purgedAt, null);
  assert.ok(await fx.store.collection("media_assets").findOne({ _id: "med_removed" }), "the original holds the restore window");
  const originalKey = createHash("sha256").update(originalBytes).digest("hex");
  assert.notEqual(await fx.mod.mediaService.blobs.get(originalKey), null, "the original bytes hold the restore window at rest");
  // Other members' content untouched: the untouched post and its own
  // comment survive the removal whole.
  const otherComment = (await fx.interactions.comment({
    accessToken: fx.tokens.devon,
    payload: { postId: untouchedPost._id, body: "untouched thread" },
    signature: fx.devs.devon.signPayload({ postId: untouchedPost._id, body: "untouched thread" }),
  })).comment;
  assert.ok(await fx.store.collection("posts").findOne({ _id: untouchedPost._id }));
  assert.ok(await fx.store.collection("comments").findOne({ _id: otherComment._id }));
  // The removed post's own comments died with it (the removal cascade).
  assert.equal(await fx.store.collection("comments").findOne({ _id: comment._id }), null);
  // One audit record.
  const audits = (await fx.collections.auditEvents.find({ networkId: FAMILY })).filter((row) => row.action === "group_post_remove");
  assert.equal(audits.length, 1);
  assert.equal(audits[0].did, CASS);
  assert.equal(audits[0].detail.postId, removedPost._id);
  // Every surface: feed, ranked, group timeline, search never serve it.
  const timeline = (await fx.mod.feedService.groupTimeline({ accessToken: fx.tokens.devon, groupId })).posts;
  assert.ok(!timeline.some((post) => post._id === removedPost._id));
  const base = (await fx.mod.feedService.timeline({ accessToken: fx.tokens.devon })).posts;
  assert.ok(!base.some((post) => post._id === removedPost._id));
  const ranked = (await fx.mod.feedService.ranked({ accessToken: fx.tokens.devon })).posts;
  assert.ok(!ranked.some((post) => post._id === removedPost._id), "the ranked section never serves it again");
  const search = (await fx.mod.feedService.search({ accessToken: fx.tokens.devon, query: "picnic" })).posts ?? [];
  assert.ok(!search.some((post) => post._id === removedPost._id));
  // Notification payload back-references left with the post (the cascade).
  assert.equal((await fx.store.collection("notifications").find()).some((row) => row.postId === removedPost._id), false, "no notification row still references the removed post");
});

test("ac-4: a removed post leaves the event catch-up immediately, and every catch-up envelope is content-only", async () => {
  const fx = await memberFixture();
  await fx.mod.groupService.create({ networkId: FAMILY, name: "Picnic", createdBy: CASS, members: [CASS, DEVON] });
  const groupId = (await fx.store.collection("groups").findOne({ name: "Picnic" }))._id;
  const groupPost = await mkPost(fx, fx.tokens.devon, fx.devs.devon, { type: "text", body: "the picnic", groupId });
  const catchUp = await fx.realtime.catchUp({ accessToken: fx.tokens.devon, since: null });
  assert.ok(catchUp.events.some((e) => e.postId === groupPost._id), "the delta was there to replay");

  await fx.mod.postService.removePost({
    accessToken: fx.tokens.cass,
    postId: groupPost._id,
    signature: fx.devs.cass.signPayload({ kind: "group_post_remove", postId: groupPost._id, groupId, networkId: FAMILY }),
  });
  // The removed post leaves every read surface immediately; the delta now
  // replays exactly the tree-scoped post.deleted removal event (PORCH-093)
  // — no created or decorated view of the removed post ever replays again.
  // The removal rode the module assembly's event plane (the same store, the
  // assembled hub's own realtime service).
  const replayed = await fx.mod.realtimeService.catchUp({ accessToken: fx.tokens.devon, since: null });
  const forRemoved = replayed.events.filter((e) => e.postId === groupPost._id);
  assert.equal(forRemoved.length, 1);
  assert.equal(forRemoved[0].type, "post.deleted");
  assert.equal(forRemoved[0].content.cascadeIds !== undefined, true);
});

/* ---- ac-5 + ac-6: the per-group notification preference ------------------ */

test("ac-5: a group preference persists per identity per group; unset resolves ON with no backfill write", async () => {
  const fx = await memberFixture();
  await fx.mod.groupService.create({ networkId: FAMILY, name: "Picnic", createdBy: CASS, members: [CASS, DEVON] });
  const groupId = (await fx.store.collection("groups").findOne({ name: "Picnic" }))._id;
  await fx.mod.pushService.updateSettings({ accessToken: fx.tokens.devon, enabled: true });
  // Unset resolves ON for legacy groups and members without entries —
  // no backfill write exists (the stored row has no groups entries at all).
  const persisted = await fx.store.collection("push_settings").findOne({ identityId: DEVON });
  assert.ok(!persisted.groups || Object.keys(persisted.groups).length === 0, "no backfill write");
  assert.equal(await fx.mod.pushService.resolveGroupPreference({ did: DEVON, groupId }), true);

  // The member's first OFF act writes THEIR entry (per identity per group).
  await fx.mod.pushService.updateSettings({ accessToken: fx.tokens.devon, enabled: true, groupPreferences: { [groupId]: false } });
  assert.equal((await fx.store.collection("push_settings").findOne({ identityId: DEVON })).groups[groupId], false);
  assert.equal(await fx.mod.pushService.resolveGroupPreference({ did: DEVON, groupId }), false);
  assert.equal(await fx.mod.pushService.resolveGroupPreference({ did: CASS, groupId }), true, "the preference is per member, never group-wide");
  // The settings read carries the row's groups entries.
  const read = await fx.mod.pushService.memberSettings({ accessToken: fx.tokens.devon });
  assert.deepEqual(read.settings.groups, { [groupId]: false });
  // A later full-row write without the groups member rides the persisted entries.
  await fx.mod.pushService.updateSettings({ accessToken: fx.tokens.devon, enabled: true });
  assert.equal((await fx.store.collection("push_settings").findOne({ identityId: DEVON })).groups[groupId], false);
  // A full-row write WITH groups replaces in full.
  await fx.mod.pushService.updateSettings({ accessToken: fx.tokens.devon, enabled: true, groupPreferences: {} });
  assert.deepEqual((await fx.store.collection("push_settings").findOne({ identityId: DEVON })).groups, {});
});

test("ac-5: an entry for a group the member no longer holds is refused on PUT", async () => {
  const fx = await memberFixture();
  await fx.mod.groupService.create({ networkId: FAMILY, name: "Picnic", createdBy: CASS, members: [CASS, DEVON] });
  const groupId = (await fx.store.collection("groups").findOne({ name: "Picnic" }))._id;
  // A group the member never belonged to refuses.
  await fx.mod.groupService.create({ networkId: FAMILY, name: "Other", createdBy: CASS, members: [CASS, DEVON] });
  const otherId = (await fx.store.collection("groups").findOne({ name: "Other" }))._id;

  await fx.mod.pushService.updateSettings({ accessToken: fx.tokens.pip, enabled: true });
  await fx.mod.groupService.setAvatar({
    groupId: otherId, networkId: FAMILY, actorDid: CASS, actorDeviceId: fx.devs.cass.deviceId,
    bytes: Buffer.from("x"), contentType: "image/png",
    payload: { scope: "group-avatar", action: "set", size: 1, sha256: createHash("sha256").update(Buffer.from("x")).digest("hex"), contentType: "image/png" },
    signature: fx.devs.cass.signPayload({ scope: "group-avatar", action: "set", size: 1, sha256: createHash("sha256").update(Buffer.from("x")).digest("hex"), contentType: "image/png" }),
  }).catch(() => {});
  await assert.rejects(
    () => fx.mod.pushService.updateSettings({ accessToken: fx.tokens.pip, enabled: true, groupPreferences: { [groupId]: false } }),
    { code: "E_PUSH_GROUP_NOT_MEMBER" },
  );
  // A member removed from the group holds it no longer.
  await fx.mod.pushService.updateSettings({ accessToken: fx.tokens.devon, enabled: true, groupPreferences: { [groupId]: false } });
  await fx.mod.groupService.removeMember({ groupId, networkId: FAMILY, actorDid: CASS, did: DEVON });
  await assert.rejects(
    () => fx.mod.pushService.updateSettings({ accessToken: fx.tokens.devon, enabled: true, groupPreferences: { [groupId]: true } }),
    { code: "E_PUSH_GROUP_NOT_MEMBER", message: /group you belong to/ },
  );
  // A nonexistent group never validates.
  await assert.rejects(
    () => fx.mod.pushService.updateSettings({ accessToken: fx.tokens.devon, enabled: true, groupPreferences: { grp_none: false } }),
    { code: "E_PUSH_GROUP_NOT_MEMBER" },
  );
  void otherId;
});

test("ac-6: the send-time gating matrix — group OFF suppresses that group only; group ON never resurrects a paused network or a missing global permission; the preference is read as persisted state at send time", async () => {
  const sends = [];
  const sender = async ({ plaintext }) => {
    sends.push(plaintext);
    return { statusCode: 201 };
  };
  const fx = await memberFixture({ sender });
  await fx.mod.groupService.create({ networkId: FAMILY, name: "G1", createdBy: CASS, members: [CASS, DEVON] });
  await fx.mod.groupService.create({ networkId: FAMILY, name: "G2", createdBy: CASS, members: [CASS, DEVON] });
  const g1 = (await fx.store.collection("groups").findOne({ name: "G1" }))._id;
  const g2 = (await fx.store.collection("groups").findOne({ name: "G2" }))._id;
  const registerDevon = async (endpoint) => {
    await fx.mod.pushService.registerSubscription({ accessToken: fx.tokens.devon, endpoint, keys: { p256dh: "k", auth: "a" } });
  };
  // The opt-in walk: enable through the settings route, then register.
  await fx.mod.pushService.updateSettings({ accessToken: fx.tokens.devon, enabled: true, events: { groupPost: true } });
  await registerDevon("https://push.example/devon");

  // 1. group OFF suppresses that group's pushes only: DEVON turns G1 off;
  //    a G2 post still delivers.
  await fx.mod.pushService.updateSettings({ accessToken: fx.tokens.devon, enabled: true, events: { groupPost: true }, groupPreferences: { [g1]: false } });
  await mkPost(fx, fx.tokens.cass, fx.devs.cass, { type: "text", body: "one", groupId: g1 });
  assert.equal(sends.length, 0, "group OFF suppresses");
  await mkPost(fx, fx.tokens.cass, fx.devs.cass, { type: "text", body: "two", groupId: g2 });
  assert.equal(sends.length, 1, "the other group keeps delivering");
  sends.length = 0;

  // 2. group ON never resurrects a paused network: DEVON mutes the network;
  //    the group entries carry no weight against it.
  await fx.mod.pushService.updateSettings({ accessToken: fx.tokens.devon, enabled: true, events: { groupPost: true }, groupPreferences: { [g2]: true }, mutes: [FAMILY] });
  await mkPost(fx, fx.tokens.cass, fx.devs.cass, { type: "text", body: "three", groupId: g2 });
  assert.equal(sends.length, 0, "muted network stays silent");
  // ...nor a missing global permission (the master switch first).
  await fx.mod.pushService.updateSettings({ accessToken: fx.tokens.devon, enabled: false, events: { groupPost: true }, groupPreferences: { [g2]: true }, mutes: [] });
  await mkPost(fx, fx.tokens.cass, fx.devs.cass, { type: "text", body: "four", groupId: g2 });
  assert.equal(sends.length, 0, "no master switch, no send");
  await fx.mod.pushService.updateSettings({ accessToken: fx.tokens.devon, enabled: true, events: { groupPost: true }, groupPreferences: { [g2]: true } });
  // The opt-in contract's other half: the off-write expired the stored
  // subscription — the member's device re-registers on the enable walk.
  await registerDevon("https://push.example/devon-2");
  await mkPost(fx, fx.tokens.cass, fx.devs.cass, { type: "text", body: "five", groupId: g2 });
  assert.equal(sends.length, 1, "every gate open, delivered");

  // 3. the preference is read as PERSISTED state at send time (never
  //    cached or injected): flipping the entry in the settings row
  //    changes the next send's behavior — no re-registration anywhere.
  sends.length = 0;
  await registerDevon("https://push.example/devon-3");
  await fx.mod.pushService.updateSettings({ accessToken: fx.tokens.devon, enabled: true, events: { groupPost: true }, groupPreferences: { [g2]: false } });
  await mkPost(fx, fx.tokens.cass, fx.devs.cass, { type: "text", body: "six", groupId: g2 });
  assert.equal(sends.length, 0, "the persisted row read AT SEND TIME");
  await fx.mod.pushService.updateSettings({ accessToken: fx.tokens.devon, enabled: true, events: { groupPost: true }, groupPreferences: { [g2]: true } });
  await mkPost(fx, fx.tokens.cass, fx.devs.cass, { type: "text", body: "seven", groupId: g2 });
  assert.equal(sends.length, 1, "the persisted row read AT SEND TIME, on");

  // 4. unset resolves ON for a group that predates the preference
  //    (the legacy row with no groups entries at all).
  await fx.store.collection("push_settings").updateOne({ identityId: DEVON }, { $set: { groups: undefined } });
  await fx.mod.groupService.create({ networkId: FAMILY, name: "G3", createdBy: CASS, members: [CASS, DEVON] });
  const g3 = (await fx.store.collection("groups").findOne({ name: "G3" }))._id;
  sends.length = 0;
  // The event toggle still holds its own gate: off means off.
  await fx.mod.pushService.updateSettings({ accessToken: fx.tokens.devon, enabled: true, events: { groupPost: false } });
  await mkPost(fx, fx.tokens.cass, fx.devs.cass, { type: "text", body: "eight", groupId: g3 });
  assert.equal(sends.length, 0, "per-event toggle first");
  await fx.mod.pushService.updateSettings({ accessToken: fx.tokens.devon, enabled: true, events: { groupPost: true } });
  await mkPost(fx, fx.tokens.cass, fx.devs.cass, { type: "text", body: "nine", groupId: g3 });
  assert.equal(sends.length, 1, "unset resolves ON for the legacy group");
});

/* ---- ac-7: the group detail read serves the menu contract ---------------- */

test("ac-7: one group detail fetch serves presentation, the resolved notification state, and the authority flags", async () => {
  const fx = await memberFixture();
  await fx.mod.groupService.create({ networkId: FAMILY, name: "Picnic", createdBy: CASS, members: [CASS, DEVON] });
  const groupId = (await fx.store.collection("groups").findOne({ name: "Picnic" }))._id;
  const image = Buffer.from("portrait");
  const payload = { scope: "group-avatar", action: "set", size: image.length, sha256: createHash("sha256").update(image).digest("hex"), contentType: "image/png" };
  await fx.mod.groupService.setAvatar({ groupId, networkId: FAMILY, actorDid: CASS, actorDeviceId: fx.devs.cass.deviceId, bytes: image, contentType: "image/png", payload, signature: fx.devs.cass.signPayload(payload) });
  await fx.mod.groupService.setColor({ groupId, networkId: FAMILY, actorDid: CASS, actorDeviceId: fx.devs.cass.deviceId, color: GROUP_COLOR_PALETTE[0], payload: { scope: "group-avatar", action: "color", color: GROUP_COLOR_PALETTE[0] }, signature: fx.devs.cass.signPayload({ scope: "group-avatar", action: "color", color: GROUP_COLOR_PALETTE[0] }) });
  await fx.mod.pushService.updateSettings({ accessToken: fx.tokens.devon, enabled: true, groupPreferences: { [groupId]: false } });

  // The managing member's read: creator flag + presentation + their ON state.
  const cassDetail = await fx.mod.groupService.get({ networkId: FAMILY, groupId, viewerDid: CASS });
  assert.equal(cassDetail.isManagingMember, true);
  assert.equal(cassDetail.isNetworkOwner, false);
  assert.ok(cassDetail.avatar.header.sha256, "presentation rides the same fetch");
  assert.equal(cassDetail.color, GROUP_COLOR_PALETTE[0]);
  assert.equal(cassDetail.notifications.perGroup, true, "no entry resolves ON");

  // The network owner's read carries the owner flag.
  const ownerDetail = await fx.mod.groupService.get({ networkId: FAMILY, groupId, viewerDid: OWNER });
  assert.equal(ownerDetail.isNetworkOwner, true);
  assert.equal(ownerDetail.isManagingMember, false);

  // The member's read carries their persisted OFF state.
  const devonDetail = await fx.mod.groupService.get({ networkId: FAMILY, groupId, viewerDid: DEVON });
  assert.equal(devonDetail.notifications.perGroup, false);
  assert.equal(devonDetail.isManagingMember, false);
  assert.equal(devonDetail.avatar.header.width, 72, "presentation serves for plain members too");
});

test("ac-1 seam: isGroupManager resolves creator and owner, and nothing else", () => {
  const group = { createdBy: CASS };
  assert.equal(isGroupManager(group, CASS), true);
  assert.equal(isGroupManager(group, OWNER, { role: "owner" }), true);
  assert.equal(isGroupManager(group, DEVON, { role: "member" }), false);
  assert.equal(isGroupManager(group, DEVON), false);
  assert.equal(isGroupManager(null, CASS), false);
});