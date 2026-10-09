import { test } from "node:test";
import assert from "node:assert/strict";
import { device, fixture } from "./helpers/content.fixture.js";

const SUSAN = "did:porchlight:susan";
const JUNE = "did:porchlight:june";
const MEG = "did:porchlight:meg";
const FAMILY = "net_family";
const OTHER = "net_other";

/** The exact content-free row contract: event + origin + ids, nothing else. */
const CONTENT_FREE_KEYS = ["_id", "networkId", "memberId", "type", "postId", "commentId", "actorDid", "createdAt"].sort();

async function notificationFixture() {
  const fx = fixture({ networkIds: [FAMILY, OTHER] });
  const dev = device("dev_s");
  const juneDev = device("dev_j");
  const megDev = device("dev_m");
  const familyToken = (await fx.admit({ networkId: FAMILY, did: SUSAN, device: dev })).accessToken;
  const juneToken = (await fx.admit({ networkId: FAMILY, did: JUNE, device: juneDev })).accessToken;
  const otherToken = (await fx.admit({ networkId: OTHER, did: MEG, device: megDev })).accessToken;
  const juneOtherToken = (await fx.admit({ networkId: OTHER, did: JUNE, device: juneDev })).accessToken;
  const postPayload = { type: "text", body: "curated-caption-sunrise-archival" };
  const post = (await fx.posts.create({ accessToken: familyToken, payload: postPayload, signature: dev.signPayload(postPayload) })).post;
  return { ...fx, dev, juneDev, megDev, familyToken, juneToken, otherToken, juneOtherToken, post };
}

test("ac-1: mention and reply push payloads carry zero member content", async () => {
  const { interactions, notifications, collections, dev, juneDev, familyToken, juneToken, post } =
    await notificationFixture();

  const SECRET_BODY = "zebra-pockets-secret-phrase";
  const mentionPayload = { postId: post._id, body: SECRET_BODY, mentions: [JUNE] };
  const root = (await interactions.comment({ accessToken: familyToken, payload: mentionPayload, signature: dev.signPayload(mentionPayload) })).comment;
  const replyPayload = { postId: post._id, body: "silver-lantern-reply", parentId: root._id };
  await interactions.comment({ accessToken: juneToken, payload: replyPayload, signature: juneDev.signPayload(replyPayload) });

  // Rows: a mention to JUNE, a reply to SUSAN — never a self-notification.
  const rows = await collections.notifications.find({ networkId: FAMILY });
  assert.equal(rows.length, 2);
  assert.ok(rows.some((row) => row.type === "mention" && row.memberId === JUNE));
  assert.ok(rows.some((row) => row.type === "reply" && row.memberId === SUSAN));
  assert.ok(!rows.some((row) => row.memberId === SUSAN && row.type === "mention"));

  // Zero-leak guarantee: every composed payload, serialized whole, carries
  // event + origin only — none of the authored content strings appear
  // anywhere in the transport, and every row holds exactly the allowlisted
  // content-free keys.
  for (const row of rows) {
    assert.deepEqual(Object.keys(row).sort(), CONTENT_FREE_KEYS);
  }
  const serialized = JSON.stringify(rows);
  assert.equal(serialized.includes("zebra-pockets-secret-phrase"), false);
  assert.equal(serialized.includes("silver-lantern-reply"), false);
  assert.equal(serialized.includes("curated-caption-sunrise-archival"), false);

  // The member-facing inbox projection holds the same zero-leak property.
  const inbox = (await notifications.inbox({ accessToken: juneToken })).notifications;
  assert.equal(inbox.length >= 1, true);
  assert.equal(JSON.stringify(inbox).includes("zebra-pockets-secret-phrase"), false);
  for (const row of inbox) {
    assert.deepEqual(Object.keys(row).sort(), ["_id", "type", "postId", "commentId", "actorDid", "createdAt"].sort());
  }
});

test("ac-2: non-member targeting is refused at composition", async () => {
  const { notifications, collections } = await notificationFixture();

  // A total stranger: no membership anywhere.
  await assert.rejects(
    () => notifications.record({ networkId: FAMILY, memberId: "did:porchlight:stranger", type: "mention", postId: "post_x" }),
    (error) => error.code === "E_NOTIFICATION_NOT_MEMBER",
  );

  // A member of ANOTHER origin: not targetable on this origin's network.
  const meg = await collections.memberships.findOne({ networkId: OTHER, did: MEG });
  assert.ok(meg);
  await assert.rejects(
    () => notifications.record({ networkId: FAMILY, memberId: MEG, type: "mention", postId: "post_x" }),
    (error) => error.code === "E_NOTIFICATION_NOT_MEMBER",
  );

  // Refused composition never lands a row.
  assert.equal((await collections.notifications.find({})).length, 0);
});

test("ac-2: cross-origin reply triggers are refused at composition", async () => {
  const { notifications, collections } = await notificationFixture();

  await assert.rejects(
    () =>
      notifications.forComment({
        comment: { _id: "cmt_x", postId: "post_x", networkId: FAMILY, authorDid: SUSAN },
        parent: { _id: "cmt_origin", postId: "post_x", networkId: OTHER, authorDid: JUNE },
        mentions: [],
      }),
    (error) => error.code === "E_NOTIFICATION_CROSS_ORIGIN",
  );
  assert.equal((await collections.notifications.find({})).length, 0);
});

test("ac-2: mention autocomplete lists same-origin members, never other networks", async () => {
  const { membership, notifications, collections, familyToken, juneOtherToken } = await notificationFixture();

  const familyCandidates = (await notifications.mentionCandidates({ accessToken: familyToken })).candidates;
  assert.deepEqual(familyCandidates.map((row) => row.did), [JUNE]); // MEG is other-origin only; SUSAN is the queryer

  const otherCandidates = (await notifications.mentionCandidates({ accessToken: juneOtherToken })).candidates;
  assert.deepEqual(otherCandidates.map((row) => row.did), [MEG]);

  // Query filter narrows the origin roster, still origin-only.
  const filtered = (await notifications.mentionCandidates({ accessToken: familyToken, q: "jun" })).candidates;
  assert.deepEqual(filtered.map((row) => row.did), [JUNE]);

  // Revoked origin membership drops out of the roster.
  const juneRow = await collections.memberships.findOne({ networkId: FAMILY, did: JUNE });
  await membership.revokeMember({ memberId: juneRow._id });
  const afterRevoke = (await notifications.mentionCandidates({ accessToken: familyToken })).candidates;
  assert.deepEqual(afterRevoke.map((row) => row.did), []);

  // Tokenless and cross-perimeter calls are refused outright.
  await assert.rejects(
    () => notifications.mentionCandidates({}),
    (error) => error.code === "E_MUST_SIGN_IN",
  );
  await assert.rejects(
    () => notifications.mentionCandidates({ accessToken: "not-a-token" }),
    (error) => error.code === "E_NOT_PERMITTED",
  );
});