import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import https from "node:https";
import {
  createDecipheriv,
  createECDH,
  createHmac,
  randomBytes,
} from "node:crypto";
import express from "express";
import webpush from "web-push";
import { assembleSocialModule } from "../src/assemble.js";
import { pushExcerpt, pushPlaintext, DEFAULT_EVENT_SWITCHES } from "../src/services/push.service.js";
import { fixture, device } from "./helpers/content.fixture.js";

const FAMILY = "net_family";
const OWNER = "did:porch:test-owner";
const ALICE = "did:porch:test-alice";
const BOB = "did:porch:test-bob";
const NAMES = { [OWNER]: "Brian Rivers", [ALICE]: "Alice Rivers", [BOB]: "Bob Mills" };

/** Collector sender: records every send attempt, answers per queue. */
function senderOf(...statusCodes) {
  const sends = [];
  const sender = async ({ subscription, plaintext }) => {
    const statusCode = sends.length < statusCodes.length ? statusCodes[sends.length] : statusCodes[statusCodes.length - 1];
    sends.push({ subscription, plaintext, statusCode });
    return { statusCode };
  };
  sender.sends = sends;
  return sender;
}

/**
 * Assembled social module over the shared fixture (the real membership
 * perimeter, real services) with an injected sender collector — the same
 * route → controller → service → model path the hub serves.
 */
async function pushFixture({ sender = null, log = null } = {}) {
  const fx = fixture({
    memberNames: (dids) => dids.map((did) => ({ did, displayName: NAMES[did] ?? null })),
  });
  await fx.collections.networks.updateOne({ _id: FAMILY }, { $set: { ownerDid: OWNER } });
  const vapidKeys = webpush.generateVAPIDKeys();
  const mod = assembleSocialModule(fx.store, {
    verifyMemberIdToken: (token) => (token ? { did: token } : null),
    memberNames: (dids) => dids.map((did) => ({ did, displayName: NAMES[did] ?? null })),
    log,
    push: {
      vapid: { subject: "mailto:test@example.com", publicKey: vapidKeys.publicKey, privateKey: vapidKeys.privateKey },
      sender,
    },
  });
  // Collections live on the shared fixture store (single source of truth —
  // the same rows the assembled module served read here for assertions).
  const subs = fx.store.collection("push_subscriptions");
  const settings = fx.store.collection("push_settings");
  const devs = { owner: device("dev_owner"), alice: device("dev_alice"), bob: device("dev_bob"), pip: device("dev_pip") };
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
  const alice = await admit(ALICE, devs.alice);
  const bob = await admit(BOB, devs.bob);
  assert.equal(owner.membership.role, "owner");
  assert.equal(alice.membership.role, "member");
  return { ...fx, mod, devs, vapidKeys, subs, settings, tokens: { owner: owner.accessToken, alice: alice.accessToken, bob: bob.accessToken, pip: null } };
}

async function mkPost(mod, token, memberDevice, payload) {
  return (await mod.postService.create({ accessToken: token, payload, signature: memberDevice.signPayload(payload) })).post;
}

async function subscribe(mod, token, endpoint, devLabel) {
  return mod.pushService.registerSubscription({ accessToken: token, endpoint, keys: { p256dh: `B_${devLabel}`, auth: `A_${devLabel}` } });
}

/** Serve the assembled router; return base URL + closer. */
async function serve(mod) {
  const app = express();
  app.use(express.json());
  app.use("/api/social", mod.api);
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  return { base: `http://127.0.0.1:${server.address().port}/api/social`, close: () => server.close() };
}

/* ---- ac-1: VAPID transport and identity-scoped subscriptions -------------- */

test("ac-1: registration persists an identity-scoped, per-device subscription record", async () => {
  const { mod, tokens, subs } = await pushFixture();
  const result = await mod.pushService.registerSubscription({
    accessToken: tokens.bob,
    endpoint: "https://push.example.com/endpoint-1",
    keys: { p256dh: "B_key1", auth: "B_auth1" },
  });
  assert.ok(result.subscription._id.startsWith("psb_"));
  const [stored] = await subs.find({});
  assert.equal(stored.identityId, BOB, "the subscription binds to the identity the session speaks for");
  assert.equal(stored.endpoint, "https://push.example.com/endpoint-1");
  assert.deepEqual(stored.keys, { p256dh: "B_key1", auth: "B_auth1" });
  assert.equal(stored.deviceId, "dev_bob", "per identity, per device — the session's device carries it");
  assert.ok(stored.createdAt && stored.lastSeen);
  assert.deepEqual(result.subscription, {
    _id: stored._id,
    identityId: BOB,
    endpoint: stored.endpoint,
    createdAt: stored.createdAt,
    lastSeen: stored.lastSeen,
  });
});

test("ac-1: re-registration replaces, never duplicates (same device, new endpoint)", async () => {
  const { mod, tokens, subs } = await pushFixture();
  await mod.pushService.registerSubscription({ accessToken: tokens.bob, endpoint: "https://push.example.com/old", keys: { p256dh: "B_k", auth: "B_a" } });
  const second = await mod.pushService.registerSubscription({ accessToken: tokens.bob, endpoint: "https://push.example.com/new", keys: { p256dh: "B_k2", auth: "B_a2" } });
  const stored = await subs.find({});
  assert.equal(stored.length, 1, "the device's re-registration supersedes its older endpoint");
  assert.equal(stored[0].endpoint, "https://push.example.com/new");
  assert.equal(stored[0].keys.p256dh, "B_k2");
  assert.ok(second.subscription.lastSeen >= stored[0].createdAt);
});

test("ac-1: re-registering the SAME endpoint on one identity stays one row with identity preserved", async () => {
  const { mod, tokens, subs } = await pushFixture();
  const first = await mod.pushService.registerSubscription({ accessToken: tokens.bob, endpoint: "https://push.example.com/e", keys: { p256dh: "B_k", auth: "B_a" } });
  await mod.pushService.registerSubscription({ accessToken: tokens.bob, endpoint: "https://push.example.com/e", keys: { p256dh: "B_k2", auth: "B_a2" } });
  const stored = await subs.find({});
  assert.equal(stored.length, 1);
  assert.equal(stored[0].createdAt, first.subscription.createdAt, "the identity's original registration time carries");
  assert.equal(stored[0].keys.p256dh, "B_k2", "fresh keys replace");
});

test("ac-1: a shared tablet endpoint re-bound to another member replaces the binding", async () => {
  const { mod, tokens, subs } = await pushFixture();
  await mod.pushService.registerSubscription({ accessToken: tokens.alice, endpoint: "https://push.example.com/tablet", keys: { p256dh: "B_k", auth: "B_a" } });
  await mod.pushService.registerSubscription({ accessToken: tokens.bob, endpoint: "https://push.example.com/tablet", keys: { p256dh: "B_k2", auth: "B_a2" } });
  const stored = await subs.find({});
  assert.equal(stored.length, 1, "one endpoint, one member — the browser's own re-registration");
  assert.equal(stored[0].identityId, BOB);
});

test("ac-1: the subscription routes register through the real express vertical", async () => {
  const { mod, tokens, subs } = await pushFixture();
  const { base, close } = await serve(mod);
  try {
    const registered = await fetch(`${base}/push/subscriptions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${tokens.bob}` },
      body: JSON.stringify({ endpoint: "https://push.example.com/http", keys: { p256dh: "B_route", auth: "A_route" } }),
    });
    assert.equal(registered.status, 200);
    const body = await registered.json();
    assert.equal(body.subscription.identityId, BOB);

    const removed = await fetch(`${base}/push/subscriptions`, {
      method: "DELETE",
      headers: { "content-type": "application/json", authorization: `Bearer ${tokens.bob}` },
      body: JSON.stringify({ endpoint: "https://push.example.com/http" }),
    });
    assert.equal(removed.status, 200);
    assert.deepEqual(await removed.json(), { removed: true });
    const stored = await subs.find({});
    assert.equal(stored.length, 0);

    const refused = await fetch(`${base}/push/subscriptions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ endpoint: "https://push.example.com/x", keys: { p256dh: "B", auth: "A" } }),
    });
    assert.equal(refused.status, 401, "registration is a member-token surface");
  } finally {
    close();
  }
});

/* ---- ac-2: send pipeline, hub-enforced settings, live membership ---------- */

test("ac-2: reply and mention triggers resolve through the hub-enforced settings and deliver", async () => {
  const sender = senderOf(201);
  const { mod, devs, tokens } = await pushFixture({ sender });
  await subscribe(mod, tokens.alice, "https://push.example.com/alice", "alice");
  const post = await mkPost(mod, tokens.alice, devs.alice, { type: "text", body: "Sunset at the lake" });
  await mod.interactionService.comment({
    accessToken: tokens.bob,
    payload: { postId: post._id, parentId: null, body: "Beautiful evening!", mentions: [ALICE] },
    signature: devs.bob.signPayload({ postId: post._id, parentId: null, body: "Beautiful evening!", mentions: [ALICE] }),
  });
  const aliceComment = await mod.interactionService.comment({
    accessToken: tokens.alice,
    payload: { postId: post._id, parentId: null, body: "Thanks!" },
    signature: devs.alice.signPayload({ postId: post._id, parentId: null, body: "Thanks!" }),
  });
  await mod.interactionService.comment({
    accessToken: tokens.bob,
    payload: { postId: post._id, parentId: aliceComment.comment._id, body: "Replying to Alice" },
    signature: devs.bob.signPayload({ postId: post._id, parentId: aliceComment.comment._id, body: "Replying to Alice" }),
  });
  const mention = sender.sends.find((s) => s.plaintext.type === "mention");
  const reply = sender.sends.find((s) => s.plaintext.type === "reply");
  assert.ok(mention, "mentions deliver");
  assert.ok(reply, "replies deliver");
  assert.equal(mention.subscription.identityId, ALICE);
  // Content-only plaintext: the full whitelist, nothing else.
  assert.deepEqual(mention.plaintext, {
    type: "mention",
    postId: post._id,
    commentId: mention.plaintext.commentId,
    authorName: "Bob Mills",
    networkName: "Family",
    excerpt: null,
  });
  assert.equal(reply.subscription.identityId, ALICE);
  assert.deepEqual(reply.plaintext, {
    type: "reply",
    postId: post._id,
    commentId: reply.plaintext.commentId,
    authorName: "Bob Mills",
    networkName: "Family",
    excerpt: "Replying to Alice",
  });
});

test("ac-2: reactions to your post deliver with the caption as the excerpt", async () => {
  const sender = senderOf(201);
  const { mod, devs, tokens } = await pushFixture({ sender });
  await subscribe(mod, tokens.alice, "https://push.example.com/alice", "alice");
  const post = await mkPost(mod, tokens.alice, devs.alice, { type: "text", body: "First dance" });
  await mod.interactionService.react({
    accessToken: tokens.bob,
    payload: { postId: post._id, emoji: "🎉" },
    signature: devs.bob.signPayload({ postId: post._id, emoji: "🎉" }),
  });
  assert.equal(sender.sends.length, 1);
  assert.deepEqual(sender.sends[0].plaintext, {
    type: "reaction",
    postId: post._id,
    commentId: null,
    authorName: "Bob Mills",
    networkName: "Family",
    excerpt: "First dance",
  });
  assert.equal(sender.sends[0].subscription.identityId, ALICE);
});

test("ac-2: without a live subscription there is no send attempt", async () => {
  const sender = senderOf(201);
  const { mod, devs, tokens } = await pushFixture({ sender });
  const post = await mkPost(mod, tokens.alice, devs.alice, { type: "text", body: "Sunday" });
  await mod.interactionService.react({ accessToken: tokens.bob, payload: { postId: post._id, emoji: "❤️" }, signature: devs.bob.signPayload({ postId: post._id, emoji: "❤️" }) });
  assert.equal(sender.sends.length, 0);
});

test("ac-2: the global switch and per-event toggles gate at send time — never cached", async () => {
  const sender = senderOf(201);
  const { mod, devs, tokens } = await pushFixture({ sender });
  await subscribe(mod, tokens.alice, "https://push.example.com/alice", "alice");
  const post = await mkPost(mod, tokens.alice, devs.alice, { type: "text", body: "Sunday" });
  const react = (emoji) =>
    mod.interactionService.react({
      accessToken: tokens.bob,
      payload: { postId: post._id, emoji },
      signature: devs.bob.signPayload({ postId: post._id, emoji }),
    });
  await mod.pushService.updateSettings({ accessToken: tokens.alice, enabled: false });
  await react("❤️");
  assert.equal(sender.sends.length, 0, "the hub-enforced switch stops the send");
  await mod.pushService.updateSettings({ accessToken: tokens.alice, enabled: true }); // decision re-read now
  await react("🎉");
  assert.equal(sender.sends.length, 1, "the pipeline reads settings at send time, never caches");
  await mod.pushService.updateSettings({ accessToken: tokens.alice, enabled: true, events: { reaction: false } });
  await react("🔥");
  assert.equal(sender.sends.length, 1, "the toggled-off event type produces no send attempt");
  await mod.pushService.updateSettings({ accessToken: tokens.alice, enabled: true, events: { reaction: true } });
  await mod.interactionService.comment({
    accessToken: tokens.bob,
    payload: { postId: post._id, parentId: null, body: "Hello" },
    signature: devs.bob.signPayload({ postId: post._id, parentId: null, body: "Hello" }),
  });
  assert.equal(sender.sends.length, 1, "a root comment carries no covered trigger");
  const aliceComment = await mod.interactionService.comment({
    accessToken: tokens.alice,
    payload: { postId: post._id, parentId: null, body: "Root" },
    signature: devs.alice.signPayload({ postId: post._id, parentId: null, body: "Root" }),
  });
  await mod.interactionService.comment({
    accessToken: tokens.bob,
    payload: { postId: post._id, parentId: aliceComment.comment._id, body: "Real reply" },
    signature: devs.bob.signPayload({ postId: post._id, parentId: aliceComment.comment._id, body: "Real reply" }),
  });
  assert.equal(sender.sends.length, 2, "enabled pairs deliver on the SAME subscription");
  assert.equal(sender.sends[1].plaintext.type, "reply");
  assert.equal(sender.sends[1].subscription.identityId, ALICE);
});

test("ac-2: muted networks produce no send attempt", async () => {
  const sender = senderOf(201);
  const { mod, devs, tokens } = await pushFixture({ sender });
  await subscribe(mod, tokens.alice, "https://push.example.com/alice", "alice");
  const post = await mkPost(mod, tokens.alice, devs.alice, { type: "text", body: "Sunday" });
  await mod.pushService.updateSettings({ accessToken: tokens.alice, enabled: true, mutes: [FAMILY] });
  await mod.interactionService.react({ accessToken: tokens.bob, payload: { postId: post._id, emoji: "❤️" }, signature: devs.bob.signPayload({ postId: post._id, emoji: "❤️" }) });
  assert.equal(sender.sends.length, 0, "the muted origin stays silent");
  const refused = await mod.pushService
    .updateSettings({ accessToken: tokens.alice, enabled: true, mutes: ["net_stranger"] })
    .catch((error) => error);
  assert.equal(refused.code, "E_PUSH_MUTE_NOT_MEMBER", "mutes of networks without live membership are refused");
  await mod.pushService.updateSettings({ accessToken: tokens.alice, enabled: true, mutes: [] });
  await mod.interactionService.react({ accessToken: tokens.bob, payload: { postId: post._id, emoji: "🎉" }, signature: devs.bob.signPayload({ postId: post._id, emoji: "🎉" }) });
  assert.equal(sender.sends.length, 1, "clearing the mute restores delivery at the next send");
});

test("ac-2: a removed member is unreachable at the same write that revoked them", async () => {
  const sender = senderOf(201);
  const { mod, devs, tokens } = await pushFixture({ sender });
  await subscribe(mod, tokens.bob, "https://push.example.com/bob", "bob");
  const bobPost = await mkPost(mod, tokens.bob, devs.bob, { type: "text", body: "Before leaving" });
  await mod.membershipService.revokeMember({ networkId: FAMILY, did: BOB });
  // Alice reacts to bob's still-standing post — the trigger fires for bob:
  await mod.interactionService.react({
    accessToken: tokens.alice,
    payload: { postId: bobPost._id, emoji: "❤️" },
    signature: devs.alice.signPayload({ postId: bobPost._id, emoji: "❤️" }),
  });
  assert.equal(sender.sends.length, 0, "the revoked member resolves against nothing — no send attempt");
});

test("ac-2: new member joined notifies owner and delegates at the admission write", async () => {
  const sender = senderOf(201);
  const { mod, devs, tokens } = await pushFixture({ sender });
  await subscribe(mod, tokens.owner, "https://push.example.com/owner", "owner");
  await subscribe(mod, tokens.bob, "https://push.example.com/bob", "bob");
  const invite = await mod.inviteService.issue({ networkId: FAMILY });
  await mod.membershipService.admit({
    code: invite.token,
    identityAccessToken: "did:porch:test-pip",
    deviceId: devs.pip.deviceId,
    devicePublicKeyJwk: devs.pip.publicKeyJwk,
    signature: devs.pip.sign(`porchlight-join:${invite.token}`),
  });
  const joined = sender.sends.filter((s) => s.plaintext.type === "joined");
  assert.equal(joined.length, 1);
  assert.deepEqual(joined[0].plaintext, {
    type: "joined",
    postId: null,
    commentId: null,
    authorName: null,
    networkName: "Family",
    excerpt: null,
  });
  assert.equal(joined[0].subscription.identityId, OWNER, "the owner learns the join");
  assert.equal(sender.sends.some((s) => s.subscription.identityId === BOB), false, "plain members are not recipients");
});

test("ac-2: a device-link request notifies the origin's owner", async () => {
  const sender = senderOf(201);
  const { mod, tokens } = await pushFixture({ sender });
  await subscribe(mod, tokens.owner, "https://push.example.com/owner", "owner");
  await subscribe(mod, tokens.bob, "https://push.example.com/bob", "bob");
  const result = await mod.pushService.notifyDeviceLink({ did: BOB });
  assert.equal(result.sent, 1);
  const link = sender.sends.filter((s) => s.plaintext.type === "deviceLink");
  assert.equal(link.length, 1);
  assert.deepEqual(link[0].plaintext, {
    type: "deviceLink",
    postId: null,
    commentId: null,
    authorName: "Bob Mills",
    networkName: "Family",
    excerpt: null,
  });
  assert.equal(link[0].subscription.identityId, OWNER);
});

test("ac-2: group posts deliver only when the member toggled groupPost on", async () => {
  const sender = senderOf(201);
  const { mod, devs, tokens } = await pushFixture({ sender });
  await subscribe(mod, tokens.alice, "https://push.example.com/alice", "alice");
  await subscribe(mod, tokens.bob, "https://push.example.com/bob", "bob");
  const group = await mod.groupService.create({ networkId: FAMILY, name: "Picnic", members: [OWNER, ALICE, BOB], createdBy: OWNER });
  const post1 = await mkPost(mod, tokens.owner, devs.owner, { type: "text", groupId: group._id, body: "Picnic planning" });
  assert.equal(sender.sends.length, 0, "the member-controlled toggle ships default off");
  await mod.pushService.updateSettings({ accessToken: tokens.alice, enabled: true, events: { groupPost: true } });
  const post2 = await mkPost(mod, tokens.owner, devs.owner, { type: "text", groupId: group._id, body: "Potluck list" });
  const groupSends = sender.sends.filter((s) => s.plaintext.type === "groupPost");
  assert.equal(groupSends.length, 1);
  assert.deepEqual(groupSends[0].plaintext, {
    type: "groupPost",
    postId: post2._id,
    commentId: null,
    authorName: "Brian Rivers",
    networkName: "Family",
    excerpt: "Potluck list",
  });
  assert.equal(groupSends[0].subscription.identityId, ALICE, "only the toggled-on member receives");
  assert.ok(post1._id);
});

/* ---- ac-3: encrypted, content-only payloads ------------------------------- */

test("ac-3: the plaintext whitelist carries content only; unknown and forbidden fields never ride", () => {
  const plaintext = pushPlaintext({ type: "reply", postId: "p_1", commentId: "c_1", authorName: "Bob Mills", networkName: "Family", excerpt: "See you there", voteCount: 3, upvotes: 2, extra: "x" });
  assert.deepEqual(Object.keys(plaintext).sort(), ["authorName", "commentId", "excerpt", "networkName", "postId", "type"]);
  assert.deepEqual(plaintext, {
    type: "reply",
    postId: "p_1",
    commentId: "c_1",
    authorName: "Bob Mills",
    networkName: "Family",
    excerpt: "See you there",
  });
  const long = "x".repeat(300);
  assert.ok(pushExcerpt(long).length <= 161);
  assert.equal(pushExcerpt("  spaced  "), "spaced");
  assert.equal(pushExcerpt(null), null);
  assert.deepEqual(DEFAULT_EVENT_SWITCHES, { reply: true, reaction: true, mention: true, groupPost: false, joined: true, deviceLink: true });
});

test("ac-3: a real push decrypts with the subscription's own keys and carries content-only plaintext", { timeout: 15000 }, async (t) => {
  // The capture relay stands in for the vendor push relay: it records
  // exactly the bytes web-push would ship (encrypted with the
  // subscription's keys, VAPID-authenticated).
  const captured = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      captured.push({ headers: req.headers, body: Buffer.concat(chunks) });
      res.writeHead(201, { location: "https://push.example.com/" });
      res.end();
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const endpoint = `http://127.0.0.1:${server.address().port}/relays/relay-a/send`;
  t.after(() => server.close());
  // web-push speaks HTTPS; the local relay speaks plain HTTP on 127.0.0.1.
  // The swap only bypasses TLS — the full real sender path (compose →
  // encrypt → request details) runs against the capture.
  const realHttpsRequest = https.request;
  https.request = (options, callback) => {
    if (options && String(options.hostname || "").endsWith("127.0.0.1")) {
      return http.request({ ...options, protocol: "http:" }, callback);
    }
    return realHttpsRequest(options, callback);
  };
  t.after(() => {
    https.request = realHttpsRequest;
  });

  const { mod, devs, tokens } = await pushFixture(); // default sender = the real web-push client
  await mod.pushService.updateSettings({ accessToken: tokens.alice, enabled: true });
  // The member's device holds the private half (never shipped); the
  // subscription presents the public key material only.
  const client = createECDH("prime256v1");
  client.generateKeys();
  const clientPub = client.getPublicKey().toString("base64url");
  const auth = randomBytes(16).toString("base64url");
  await mod.pushService.registerSubscription({ accessToken: tokens.alice, endpoint, keys: { p256dh: clientPub, auth } });

  const post = await mkPost(mod, tokens.alice, devs.alice, { type: "text", body: "Lake morning" });
  await mod.interactionService.react({
    accessToken: tokens.bob,
    payload: { postId: post._id, emoji: "🌅" },
    signature: devs.bob.signPayload({ postId: post._id, emoji: "🌅" }),
  });

  assert.equal(captured.length, 1);
  const { headers, body } = captured[0];
  assert.equal(headers["content-encoding"], "aes128gcm");
  assert.ok(String(headers.authorization).startsWith("vapid "), "the send carries VAPID server authentication");
  // web-push's protocol default retention (the relay holds the ciphertext).
  assert.equal(headers.ttl, "2419200");

  // RFC 8291 §4 + RFC 8188 §2.2 with the DEVICE's private key — the vendor
  // relay holds none of this and ships only ciphertext it cannot read.
  // Chain (http_ece's aes128gcm): secret = HKDF(authSecret, ECDH, "WebPush:
  // info\0"+receiverPub+senderPub, 32); prk = HKDF-extract(recordSalt,
  // secret); key/nonce = HKDF-expand(prk, "Content-Encoding: <encoding>\0").
  const salt = body.subarray(0, 16);
  const idlen = body.readUInt8(20);
  const senderPub = body.subarray(21, 21 + idlen);
  const ciphertext = body.subarray(21 + idlen);

  const hkdfExpand = (prk, info, length) => {
    const blocks = [];
    let t = Buffer.alloc(0);
    let counter = 1;
    while (Buffer.concat(blocks).length < length) {
      t = createHmac("sha256", prk).update(Buffer.concat([t, info, Uint8Array.of(counter)])).digest();
      blocks.push(t);
      counter += 1;
    }
    return Buffer.concat(blocks).subarray(0, length);
  };
  const ek = createHmac("sha256", Buffer.from(auth, "base64url")).update(client.computeSecret(senderPub)).digest();
  const secret = hkdfExpand(
    ek,
    Buffer.concat([Buffer.from("WebPush: info\0"), Buffer.from(clientPub, "base64url"), senderPub]),
    32,
  );
  const prk = createHmac("sha256", salt).update(secret).digest();
  const cek = hkdfExpand(prk, Buffer.from("Content-Encoding: aes128gcm\0"), 16);
  const nonce = hkdfExpand(prk, Buffer.from("Content-Encoding: nonce\0"), 12);
  // Single record: counter 0 leaves the base nonce unchanged.
  const decipher = createDecipheriv("aes-128-gcm", cek, Buffer.from(nonce));
  decipher.setAuthTag(ciphertext.subarray(ciphertext.length - 16));
  const padded = Buffer.concat([decipher.update(ciphertext.subarray(0, ciphertext.length - 16)), decipher.final()]);
  let end = padded.length - 1;
  while (padded[end] === 0 && end > 0) {
    end -= 1;
  }
  assert.equal(padded[end], 2, "the aes128gcm padding delimiter");
  const plaintext = JSON.parse(Buffer.from(padded.subarray(0, end)).toString("utf8"));
  assert.deepEqual(plaintext, {
    type: "reaction",
    postId: post._id,
    commentId: null,
    authorName: "Bob Mills",
    networkName: "Family",
    excerpt: "Lake morning",
  });
});

/* ---- ac-4: revocation kill, lifecycle cleanup, zero phone-home ------------ */

test("ac-4: a 410 endpoint response expires the stored subscription server-side, log-only", async () => {
  const sender = senderOf(410);
  const logLines = [];
  const { mod, devs, tokens, subs } = await pushFixture({ sender, log: (line) => logLines.push(line) });
  await subscribe(mod, tokens.alice, "https://push.example.com/dying", "alice");
  const post = await mkPost(mod, tokens.alice, devs.alice, { type: "text", body: "Sunday" });
  await mod.interactionService.react({ accessToken: tokens.bob, payload: { postId: post._id, emoji: "❤️" }, signature: devs.bob.signPayload({ postId: post._id, emoji: "❤️" }) });
  const stored = await subs.find({});
  assert.equal(stored.length, 0, "the 410 expired the subscription");
  const expired = logLines.filter((line) => line.includes("push.subscription.expired"));
  assert.equal(expired.length, 1, "the expiry lands in the local structured log");
  assert.ok(expired[0].includes("410"));
  assert.ok(expired[0].includes(`"identityId":"${ALICE}"`));
  // No error fanout: the reaction write completes normally.
  const counted = await mod.interactionService.reactionsFor({ accessToken: tokens.alice, postId: post._id });
  assert.equal(counted.reactions.length, 1);
});

test("ac-4: transient failure takes one bounded retry then drop; a recovered retry delivers", async () => {
  const sender = senderOf(503, 503);
  const logLines = [];
  const { mod, devs, tokens, subs } = await pushFixture({ sender, log: (line) => logLines.push(line) });
  await subscribe(mod, tokens.alice, "https://push.example.com/flaky", "alice");
  const post = await mkPost(mod, tokens.alice, devs.alice, { type: "text", body: "Sunday" });
  await mod.interactionService.react({ accessToken: tokens.bob, payload: { postId: post._id, emoji: "❤️" }, signature: devs.bob.signPayload({ postId: post._id, emoji: "❤️" }) });
  assert.equal(sender.sends.length, 2, "exactly one bounded retry after the first failure");
  assert.equal(sender.sends[0].subscription._id, sender.sends[1].subscription._id, "the retry aims at the same subscription");
  assert.equal((await subs.find({})).length, 1, "a transient failure never expires the subscription");
  assert.ok(logLines.some((line) => line.includes("push.send.dropped")));

  // A transient failure that recovers on the one retry delivers.
  const recovering = senderOf(503, 201);
  const recoveringFx = await pushFixture({ sender: recovering });
  await subscribe(recoveringFx.mod, recoveringFx.tokens.alice, "https://push.example.com/recovering", "alice");
  const post2 = await mkPost(recoveringFx.mod, recoveringFx.tokens.alice, recoveringFx.devs.alice, { type: "text", body: "Sunday" });
  await recoveringFx.mod.interactionService.react({
    accessToken: recoveringFx.tokens.bob,
    payload: { postId: post2._id, emoji: "❤️" },
    signature: recoveringFx.devs.bob.signPayload({ postId: post2._id, emoji: "❤️" }),
  });
  assert.equal(recovering.sends.length, 2, "one failure + one retry");
  assert.equal((await recoveringFx.subs.find({})).length, 1, "the subscription survives the recovered retry");
});

test("ac-4: delivery outcomes land only in the local structured log — a sender crash never fans out", async () => {
  const crashy = async () => {
    throw new Error("tls hang");
  };
  const logLines = [];
  const { mod, devs, tokens } = await pushFixture({ sender: crashy, log: (line) => logLines.push(line) });
  await subscribe(mod, tokens.alice, "https://push.example.com/crashy", "alice");
  const post = await mkPost(mod, tokens.alice, devs.alice, { type: "text", body: "Sunday" });
  await mod.interactionService.react({
    accessToken: tokens.bob,
    payload: { postId: post._id, emoji: "❤️" },
    signature: devs.bob.signPayload({ postId: post._id, emoji: "❤️" }),
  });
  assert.ok(logLines.some((line) => line.includes("push.send.dropped")), "the outcome is a log line, locally");
  assert.ok(logLines.every((line) => line.includes('"kind":"push"')), "every delivery outcome rides the push log kind");
});

/* ---- ac-5: iOS gate honored, no workaround; the route serves the key ------ */

test("ac-5: the subscription route serves the VAPID public key; registration needs no capability gate", async () => {
  const { mod, vapidKeys, tokens } = await pushFixture();
  const { base, close } = await serve(mod);
  try {
    const vapid = await fetch(`${base}/push/vapid`);
    assert.equal(vapid.status, 200);
    const body = await vapid.json();
    assert.deepEqual(body, { publicKey: vapidKeys.publicKey, available: true });

    // No workaround, no capability sniffing: any browser that completes the
    // subscription handshake registers with endpoint + keys only (the
    // iOS 16.4+ gate is the browser's own; the server never fakes one past it).
    const registered = await fetch(`${base}/push/subscriptions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${tokens.bob}` },
      body: JSON.stringify({ endpoint: "https://push.example.com/any-class", keys: { p256dh: "B_c", auth: "A_c" } }),
    });
    assert.equal(registered.status, 200);
  } finally {
    close();
  }
});

test("ac-5: the settings routes read and update the hub-enforced member controls", async () => {
  const { mod, tokens } = await pushFixture();
  const { base, close } = await serve(mod);
  try {
    const fresh = await fetch(`${base}/push/settings`, { headers: { authorization: `Bearer ${tokens.alice}` } });
    const freshBody = await fresh.json();
    assert.deepEqual(freshBody.settings, {
      enabled: true,
      events: { reply: true, reaction: true, mention: true, groupPost: false, joined: true, deviceLink: true },
      mutes: [],
    });
    const updated = await fetch(`${base}/push/settings`, {
      method: "PUT",
      headers: { "content-type": "application/json", authorization: `Bearer ${tokens.alice}` },
      body: JSON.stringify({ enabled: true, events: { reply: false }, mutes: [FAMILY] }),
    });
    assert.equal(updated.status, 200);
    const reread = await (await fetch(`${base}/push/settings`, { headers: { authorization: `Bearer ${tokens.alice}` } })).json();
    assert.deepEqual(reread.settings.events.reply, false, "the per-event toggle persists for the hub to enforce");
    const refused = await fetch(`${base}/push/settings`, {
      method: "PUT",
      headers: { "content-type": "application/json", authorization: `Bearer ${tokens.alice}` },
      body: JSON.stringify({ enabled: true, mutes: ["net_stranger"] }),
    });
    assert.equal(refused.status, 403);
  } finally {
    close();
  }
});

test("ac-4: a member removed mid-life resolves against nothing on every later trigger", async () => {
  const sender = senderOf(201);
  const { mod, membership, subs, tokens } = await pushFixture({ sender });
  await mod.pushService.registerSubscription({ accessToken: tokens.alice, endpoint: "https://push.example.com/alice", keys: { p256dh: "B_l", auth: "A_l" } });
  await mod.pushService.updateSettings({ accessToken: tokens.alice, enabled: true });
  const result = await mod.pushService.notify({
    networkId: FAMILY,
    type: "reply",
    targetDids: [ALICE],
    postId: "p_late",
    commentId: "c_late",
    actorDid: BOB,
    excerpt: "late trigger",
  });
  assert.equal(result.sent, 1);
  await membership.revokeMember({ networkId: FAMILY, did: ALICE });
  const after = await mod.pushService.notify({
    networkId: FAMILY,
    type: "reply",
    targetDids: [ALICE],
    postId: "p_late",
    commentId: "c_late",
    actorDid: BOB,
    excerpt: "late trigger",
  });
  assert.equal(after.sent, 0, "deliverability died at the revocation write");
  const stored = await subs.find({});
  assert.equal(stored.length, 1, "the identity's subscription is NOT deleted: other networks' reach persists");
  assert.equal(sender.sends.length, 1);
});