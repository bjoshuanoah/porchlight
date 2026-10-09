import { test } from "node:test";
import assert from "node:assert/strict";
import { device, fixture } from "./helpers/content.fixture.js";
import { MAX_COMMENT_DEPTH } from "../src/services/interaction.service.js";

const SUSAN = "did:porchlight:susan";
const JUNE = "did:porchlight:june";
const MEG = "did:porchlight:meg";
const FAMILY = "net_family";
const OTHER = "net_other";

async function contentFixture() {
  const fx = fixture({ networkIds: [FAMILY, OTHER] });
  const dev = device("dev_s");
  const juneDev = device("dev_j");
  const megDev = device("dev_m");
  const familyToken = (await fx.admit({ networkId: FAMILY, did: SUSAN, device: dev })).accessToken;
  const otherToken = (await fx.admit({ networkId: OTHER, did: SUSAN, device: dev })).accessToken;
  const juneToken = (await fx.admit({ networkId: FAMILY, did: JUNE, device: juneDev })).accessToken;
  const megToken = (await fx.admit({ networkId: FAMILY, did: MEG, device: megDev })).accessToken;

  const postPayload = { type: "text", body: "root post" };
  const post = (await fx.posts.create({ accessToken: familyToken, payload: postPayload, signature: dev.signPayload(postPayload) })).post;
  return { ...fx, dev, juneDev, megDev, familyToken, otherToken, juneToken, megToken, post };
}

test("ac-3: comments nest via parentId with the depth cap", async () => {
  const { interactions, collections, dev, juneDev, juneToken, familyToken, post } = await contentFixture();

  const rootPayload = { postId: post._id, body: "root comment" };
  const root = (await interactions.comment({ accessToken: familyToken, payload: rootPayload, signature: dev.signPayload(rootPayload) })).comment;
  assert.equal(root.parentId, null);

  const replyPayload = { postId: post._id, body: "reply", parentId: root._id };
  const reply = (await interactions.comment({ accessToken: juneToken, payload: replyPayload, signature: juneDev.signPayload(replyPayload) })).comment;
  assert.equal(reply.parentId, root._id);

  // Replies on replies nest until the depth cap: root + 8 reply levels.
  let deepest = reply;
  for (let level = 2; level <= MAX_COMMENT_DEPTH; level += 1) {
    const payload = { postId: post._id, body: `level ${level}`, parentId: deepest._id };
    deepest = (await interactions.comment({ accessToken: familyToken, payload, signature: dev.signPayload(payload) })).comment;
  }
  assert.equal((await collections.comments.find({ postId: post._id })).length, MAX_COMMENT_DEPTH + 1);

  const tooDeepPayload = { postId: post._id, body: "too deep", parentId: deepest._id };
  await assert.rejects(
    () =>
      interactions.comment({
        accessToken: juneToken,
        payload: tooDeepPayload,
        signature: juneDev.signPayload(tooDeepPayload),
      }),
    (error) => error.code === "E_REPLY_TOO_DEEP",
  );
  assert.equal((await collections.comments.find({ postId: post._id })).length, MAX_COMMENT_DEPTH + 1);
});

test("ac-3: @mentions validate against origin membership", async () => {
  const { interactions, collections, dev, familyToken, post } = await contentFixture();

  // Mentions of an active member pass and are deduplicated.
  const okPayload = { postId: post._id, body: "thanks", mentions: [JUNE, JUNE] };
  const comment = (await interactions.comment({ accessToken: familyToken, payload: okPayload, signature: dev.signPayload(okPayload) })).comment;
  assert.deepEqual(comment.mentions, [JUNE]);

  const strangerPayload = { postId: post._id, body: "hey", mentions: ["did:porchlight:stranger"] };
  await assert.rejects(
    () => interactions.comment({ accessToken: familyToken, payload: strangerPayload, signature: dev.signPayload(strangerPayload) }),
    (error) => error.code === "E_MENTION_NOT_MEMBER",
  );
  assert.equal((await collections.comments.find({ postId: post._id })).length, 1);
});

test("ac-3: mention notifications fire with content-free payloads", async () => {
  const { interactions, notifications, collections, dev, familyToken, juneToken, post } = await contentFixture();

  const mentionPayload = { postId: post._id, body: "thinking of you", mentions: [JUNE] };
  await interactions.comment({ accessToken: familyToken, payload: mentionPayload, signature: dev.signPayload(mentionPayload) });

  const juneInbox = (await notifications.inbox({ accessToken: juneToken })).notifications;
  assert.ok(juneInbox.some((row) => row.type === "mention" && row.actorDid === SUSAN));
  for (const row of await collections.notifications.find({ networkId: FAMILY })) {
    // Content-free by contract: ids, type, actor, timestamps — no bodies.
    assert.deepEqual(
      Object.keys(row).sort(),
      ["_id", "actorDid", "commentId", "createdAt", "memberId", "networkId", "postId", "type"],
    );
  }
});

test("ac-3: reply notifications reach the parent author, content-free", async () => {
  const { interactions, collections, dev, juneDev, familyToken, juneToken, post } = await contentFixture();

  const mentionPayload = { postId: post._id, body: "root", mentions: [JUNE] };
  const root = (await interactions.comment({ accessToken: familyToken, payload: mentionPayload, signature: dev.signPayload(mentionPayload) })).comment;
  const replyPayload = { postId: post._id, body: "replying", parentId: root._id };
  await interactions.comment({ accessToken: juneToken, payload: replyPayload, signature: juneDev.signPayload(replyPayload) });

  const susanInbox = await collections.notifications.find({ memberId: SUSAN, networkId: FAMILY });
  assert.deepEqual(susanInbox.map((row) => row.type), ["reply"]);
  const juneRows = await collections.notifications.find({ memberId: JUNE, networkId: FAMILY });
  assert.deepEqual(juneRows.map((row) => row.type), ["mention"]);
});

test("ac-4: reactions accept any emoji the member prefers (open vocabulary)", async () => {
  const { interactions, dev, juneDev, familyToken, juneToken, post } = await contentFixture();

  const heartPayload = { postId: post._id, emoji: "🫶🏾" };
  const reacted = (await interactions.react({ accessToken: familyToken, payload: heartPayload, signature: dev.signPayload(heartPayload) })).reaction;
  assert.equal(reacted.emoji, "🫶🏾"); // stored as-authored, rendered as given

  // A different emoji from the same member is a distinct reaction.
  const laughPayload = { postId: post._id, emoji: "😂" };
  const secondReaction = (await interactions.react({ accessToken: familyToken, payload: laughPayload, signature: dev.signPayload(laughPayload) })).reaction;
  assert.equal(secondReaction.emoji, "😂");

  // A duplicate emoji by the same member is refused.
  await assert.rejects(
    () => interactions.react({ accessToken: familyToken, payload: laughPayload, signature: dev.signPayload(laughPayload) }),
    (error) => error.code === "E_REACTION_EXISTS",
  );

  // The same emoji from a DIFFERENT member is its own reaction.
  const junePayload = { postId: post._id, emoji: "😂" };
  const juneReaction = (await interactions.react({ accessToken: juneToken, payload: junePayload, signature: juneDev.signPayload(junePayload) })).reaction;
  assert.equal(juneReaction.emoji, "😂");
});

test("ac-4: votes are one effective signed vote per member per post, changeable", async () => {
  const { interactions, collections, dev, juneDev, familyToken, juneToken, post } = await contentFixture();

  const upPayload = { postId: post._id, value: "up" };
  await interactions.vote({ accessToken: juneToken, payload: upPayload, signature: juneDev.signPayload(upPayload) });
  let stored = await collections.votes.find({ postId: post._id });
  assert.equal(stored.length, 1);
  assert.equal(stored[0].value, "up");
  assert.equal(stored[0].memberDid, JUNE);
  assert.equal(stored[0].deviceSignature, juneDev.signPayload(upPayload));

  // Changing the vote flips the single effective vote (re-signed).
  const downPayload = { postId: post._id, value: "down" };
  await interactions.vote({ accessToken: juneToken, payload: downPayload, signature: juneDev.signPayload(downPayload) });
  stored = await collections.votes.find({ postId: post._id });
  assert.equal(stored.length, 1);
  assert.equal(stored[0].value, "down");
  assert.notEqual(stored[0].changedAt, null);

  // Re-stating the same value changes nothing.
  await interactions.vote({ accessToken: juneToken, payload: downPayload, signature: juneDev.signPayload(downPayload) });
  assert.equal((await collections.votes.find({ postId: post._id })).length, 1);

  // One effective vote each: Susan's up vote lives alongside June's.
  const susanVote = { postId: post._id, value: "up" };
  await interactions.vote({ accessToken: familyToken, payload: susanVote, signature: dev.signPayload(susanVote) });
  const all = await collections.votes.find({ postId: post._id });
  assert.equal(all.length, 2);
  assert.deepEqual(all.map((row) => row.value).sort(), ["down", "up"]);

  // Rank-input counters reflect volume and ratio (2 votes, 1 up).
  const rankInputs = (await collections.posts.findOne({ _id: post._id })).interactionCounters;
  assert.deepEqual(rankInputs, {
    upVolume: 1, downVolume: 1, voteVolume: 2, voteRatio: 0.5, commentCount: 0, reactionCount: 0,
  });

  const bogusVote = { postId: post._id, value: "sideways" };
  await assert.rejects(
    () => interactions.vote({ accessToken: familyToken, payload: bogusVote, signature: dev.signPayload(bogusVote) }),
    (error) => error.code === "E_INVALID_VOTE",
  );
});

test("ac-4: interactions are origin-contained — no cross-origin write or read anywhere", async () => {
  const { interactions, posts, dev, otherToken, post } = await contentFixture();

  // The family post is unaddressable under the other network's token.
  const foreignPayload = { postId: post._id, body: "from outside" };
  await assert.rejects(
    () => interactions.comment({ accessToken: otherToken, payload: foreignPayload, signature: dev.signPayload(foreignPayload) }),
    (error) => error.code === "E_POST_NOT_FOUND",
  );
  await assert.rejects(
    () => interactions.react({ accessToken: otherToken, payload: { postId: post._id, emoji: "👍" }, signature: "sig" }),
    (error) => error.code === "E_POST_NOT_FOUND",
  );
  await assert.rejects(
    () => interactions.vote({ accessToken: otherToken, payload: { postId: post._id, value: "up" }, signature: "sig" }),
    (error) => error.code === "E_POST_NOT_FOUND",
  );
  await assert.rejects(
    () => interactions.commentThread({ accessToken: otherToken, postId: post._id }),
    (error) => error.code === "E_POST_NOT_FOUND",
  );
  await assert.rejects(
    () => posts.get({ accessToken: otherToken, postId: post._id }),
    (error) => error.code === "E_POST_NOT_FOUND",
  );
});

test("ac-4: interaction views carry no vote material", async () => {
  const { interactions, dev, juneDev, familyToken, juneToken, post } = await contentFixture();

  const commentPayload = { postId: post._id, body: "nice" };
  const commentView = (await interactions.comment({ accessToken: juneToken, payload: commentPayload, signature: juneDev.signPayload(commentPayload) })).comment;
  assert.deepEqual(Object.keys(commentView).sort(), ["_id", "authorDid", "body", "createdAt", "mentions", "parentId", "postId"]);

  const starPayload = { postId: post._id, emoji: "🌟" };
  const reacted = (await interactions.react({ accessToken: familyToken, payload: starPayload, signature: dev.signPayload(starPayload) })).reaction;
  assert.deepEqual(Object.keys(reacted).sort(), ["_id", "createdAt", "emoji", "memberDid"]);
});

test("ac-4: interaction writes are actor-signed — a tampered comment does not verify", async () => {
  const { interactions, dev, familyToken, post } = await contentFixture();

  const signed = { postId: post._id, body: "real" };
  const tampered = { postId: post._id, body: "tampered" };
  await assert.rejects(
    () => interactions.comment({ accessToken: familyToken, payload: tampered, signature: dev.signPayload(signed) }),
    (error) => error.code === "E_SIGNATURE_INVALID",
  );

  const ok = { postId: post._id, body: "ok" };
  const comment = (await interactions.comment({ accessToken: familyToken, payload: ok, signature: dev.signPayload(ok) })).comment;
  assert.equal("deviceSignature" in comment, false); // member views strip transport detail
});