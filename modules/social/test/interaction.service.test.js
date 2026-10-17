import { test } from "node:test";
import assert from "node:assert/strict";
import { device, fixture } from "./helpers/content.fixture.js";
import { MAX_COMMENT_DEPTH } from "../src/services/interaction.service.js";
import { FeedService } from "../src/services/feed.service.js";
import { RankingService } from "../src/services/ranking.service.js";

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

/** The feed read over the content fixture: the same assembled path the card slice rides. */
async function ruledFeed(fx) {
  return new FeedService({
    posts: fx.collections.posts,
    derivedData: fx.collections.derivedData,
    groups: fx.collections.groups,
    membership: fx.membership,
    ranking: new RankingService(),
    media: fx.media,
    comments: fx.collections.comments,
    reactions: fx.collections.reactions,
  });
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

test("ac-3: the member can clear or swap a reaction, others render untouched", async () => {
  const { interactions, collections, dev, juneDev, familyToken, juneToken, post } = await contentFixture();

  const starPayload = { postId: post._id, emoji: "🌟" };
  const laughedPayload = { postId: post._id, emoji: "😂" };
  await interactions.react({ accessToken: familyToken, payload: starPayload, signature: dev.signPayload(starPayload) });
  const juneLaugh = { postId: post._id, emoji: "😂" };
  const juneRow = (await interactions.react({ accessToken: juneToken, payload: juneLaugh, signature: juneDev.signPayload(juneLaugh) })).reaction;

  // Clear: the member's own emoji goes; the other member's row stays.
  const cleared = await interactions.unreact({ accessToken: familyToken, payload: starPayload, signature: dev.signPayload(starPayload) });
  assert.equal(cleared.removed, true);
  const afterClear = await interactions.reactionsFor({ accessToken: familyToken, postId: post._id });
  // PORCH-091: the origin read carries reactor attribution; this fixture
  // wires no identity name resolver, so the row renders the nameless shape.
  assert.deepEqual(afterClear.reactions, [
    { _id: juneRow._id, memberDid: JUNE, emoji: "😂", createdAt: juneRow.createdAt, memberName: null, memberAvatar: null },
  ]);

  // Swap = remove one, add another: a distinct emoji is a fresh reaction.
  const swapOut = { ...laughedPayload };
  await interactions.react({ accessToken: familyToken, payload: swapOut, signature: dev.signPayload(swapOut) });
  const sunPayload = { postId: post._id, emoji: "☀️" };
  await interactions.react({ accessToken: familyToken, payload: sunPayload, signature: dev.signPayload(sunPayload) });
  const clearedLaugh = await interactions.unreact({ accessToken: familyToken, payload: swapOut, signature: dev.signPayload(swapOut) });
  assert.equal(clearedLaugh.removed, true);
  const afterSwap = (await interactions.reactionsFor({ accessToken: familyToken, postId: post._id })).reactions;
  assert.ok(afterSwap.some((row) => row.memberDid === SUSAN && row.emoji === "☀️"));
  assert.ok(!afterSwap.some((row) => row.memberDid === SUSAN && row.emoji === "😂"));

  // Clearing an emoji the member never reacted is a no-op, never an error.
  const absentPayload = { postId: post._id, emoji: "🦊" };
  const absent = await interactions.unreact({ accessToken: familyToken, payload: absentPayload, signature: dev.signPayload(absentPayload) });
  assert.deepEqual(absent, { removed: false, reaction: null });

  // The write is actor-signed and contained to the origin like every other.
  const forged = { postId: post._id, emoji: "🌻" };
  await assert.rejects(
    () => interactions.unreact({ accessToken: familyToken, payload: forged, signature: dev.signPayload(juneLaugh) }),
    (error) => error.code === "E_SIGNATURE_INVALID",
  );
  const otherPayload = { postId: "post_missing", emoji: "🌟" };
  await assert.rejects(
    () => interactions.unreact({ accessToken: familyToken, payload: otherPayload, signature: dev.signPayload(otherPayload) }),
    (error) => error.code === "E_POST_NOT_FOUND",
  );

  // Counters recount after removal: SUSAN's sun and JUNE's laugh remain.
  const stored = await collections.posts.findOne({ _id: post._id });
  assert.equal(stored.interactionCounters.reactionCount, 2);
});

test("PORCH-091 ac-1: the reaction read attributes reactors (name + avatar); ac-3: the event keeps member + emoji only", async () => {
  const avatarMetas = {
    [SUSAN]: {
      header: { kind: "header", width: 72, height: 72, contentType: "image/webp", sha256: "s".repeat(64) },
      chooser: { kind: "chooser", width: 144, height: 144, contentType: "image/webp", sha256: "S".repeat(64) },
    },
  };
  const names = { [SUSAN]: "Susan Hale" };

  const fx = fixture({
    networkIds: [FAMILY, OTHER],
    memberNames: async (dids) => dids.map((did) => ({ did, displayName: names[did] ?? null, avatar: avatarMetas[did] ?? null })),
  });
  const dev = device("dev_s");
  const juneDev = device("dev_j");
  const familyToken = (await fx.admit({ networkId: FAMILY, did: SUSAN, device: dev })).accessToken;
  const juneToken = (await fx.admit({ networkId: FAMILY, did: JUNE, device: juneDev })).accessToken;
  const postPayload = { type: "text", body: "chips" };
  const post = (await fx.posts.create({ accessToken: familyToken, payload: postPayload, signature: dev.signPayload(postPayload) })).post;

  // A live origin channel records what reaction.applied delivers.
  const seen = [];
  await fx.realtime.subscribe({ token: familyToken, networkId: FAMILY, channel: { id: "ch_s", emit: (envelope) => seen.push(envelope), close: () => {} } });

  // Same emoji, two members: one distinct reaction each — the rows the
  // per-member rule guarantees are exactly the distinct-people count.
  for (const [member, token] of [[SUSAN, familyToken], [JUNE, juneToken]]) {
    const payload = { postId: post._id, emoji: "🫶" };
    const written = (await fx.interactions.react({ accessToken: token, payload, signature: member === SUSAN ? dev.signPayload(payload) : juneDev.signPayload(payload) })).reaction;
    // The write response stays the bare member + emoji row: attribution is
    // read breadth, never wire-served on the write surface.
    assert.deepEqual(Object.keys(written).sort(), ["_id", "createdAt", "emoji", "memberDid"]);
  }

  const reads = (await fx.interactions.reactionsFor({ accessToken: juneToken, postId: post._id })).reactions;
  // Origin's served order (insertion order), one attributed row per reactor.
  assert.deepEqual(
    reads.map((row) => ({ memberDid: row.memberDid, memberName: row.memberName, memberAvatar: row.memberAvatar })),
    [
      { memberDid: SUSAN, memberName: "Susan Hale", memberAvatar: avatarMetas[SUSAN] },
      { memberDid: JUNE, memberName: null, memberAvatar: null },
    ],
    "a member the identity plane holds no row for renders the nameless fallback",
  );
  assert.deepEqual(Object.keys(reads[0]).sort(), ["_id", "createdAt", "emoji", "memberAvatar", "memberDid", "memberName"], "no count, roster, or aggregate field rides the read");
  const duplicate = { postId: post._id, emoji: "🫶" };
  await assert.rejects(
    () => fx.interactions.react({ accessToken: familyToken, payload: duplicate, signature: dev.signPayload(duplicate) }),
    (error) => error.code === "E_REACTION_EXISTS",
  );

  // Live envelope unchanged (ac-3): member + emoji as content only — no
  // name, no avatar, no count, no roster. One envelope per applied reaction.
  assert.deepEqual(seen.map((envelope) => envelope.type), ["reaction.applied", "reaction.applied"]);
  for (const envelope of seen) {
    assert.deepEqual(Object.keys(envelope.content).sort(), ["_id", "createdAt", "emoji", "memberDid"]);
  }
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

  const commentPayload = { postId: post._id, body: "nice", mentions: [SUSAN] };
  const commentView = (await interactions.comment({ accessToken: juneToken, payload: commentPayload, signature: juneDev.signPayload(commentPayload) })).comment;
  assert.deepEqual(
    Object.keys(commentView).sort(),
    ["_id", "authorAvatar", "authorDid", "authorName", "body", "createdAt", "mentionNames", "mentions", "parentId", "postId", "previewId", "reactionRows"],
    // PORCH-098: every served comment view carries its reaction rows (the
    // empty additive default) — the arriving reply renders as-given, the
    // same shape the REST slice row carries.
  );
  // Mention names resolve at read time alongside the author name
  // (PORCH-037): one name per mention, aligned by position (null here
  // because this fixture wires no name resolver). PORCH-070: the face
  // rides as `authorAvatar`, null where the identity plane carries none.
  assert.deepEqual(commentView.mentionNames, [null]);
  assert.equal(commentView.authorName, null);
  assert.equal(commentView.authorAvatar, null);

  const starPayload = { postId: post._id, emoji: "🌟" };
  const reacted = (await interactions.react({ accessToken: familyToken, payload: starPayload, signature: dev.signPayload(starPayload) })).reaction;
  assert.deepEqual(Object.keys(reacted).sort(), ["_id", "createdAt", "emoji", "memberDid"]);
});

test("ac-2: mention names render as the member's family-facing name, resolved at the origin (PORCH-037)", async () => {
  const NAMES = { [SUSAN]: "Susan Bell", [JUNE]: "June Bell", [MEG]: "Meg Rivers" };
  const fx = fixture({
    networkIds: [FAMILY, OTHER],
    memberNames: async (dids) => dids.map((did) => ({ did, displayName: NAMES[did] ?? null })),
  });
  const dev = device("dev_s");
  const juneDev = device("dev_j");
  const familyToken = (await fx.admit({ networkId: FAMILY, did: SUSAN, device: dev })).accessToken;
  const juneToken = (await fx.admit({ networkId: FAMILY, did: JUNE, device: juneDev })).accessToken;
  const postPayload = { type: "text", body: "root post" };
  const post = (await fx.posts.create({ accessToken: familyToken, payload: postPayload, signature: dev.signPayload(postPayload) })).post;

  const payload = { postId: post._id, body: `thanks @${NAMES[JUNE]}`, mentions: [JUNE] };
  const comment = (await fx.interactions.comment({ accessToken: juneToken, payload, signature: juneDev.signPayload(payload) })).comment;
  assert.deepEqual(comment.mentions, [JUNE]);
  assert.deepEqual(comment.mentionNames, ["June Bell"]);

  // The thread read names the mentioned member too — rendering surfaces
  // never resolve a mention id themselves.
  const thread = (await fx.interactions.commentThread({ accessToken: familyToken, postId: post._id })).comments;
  assert.deepEqual(thread.find((row) => row._id === comment._id).mentionNames, ["June Bell"]);
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

/** PORCH-085: the ruled read order (paired PRD 6ad13dde89855af1a3cc050b). */
test("PORCH-085 ac-1: the thread read serves the ruled order — threaded roots first, each group newest-first, the tree chronological", async () => {
  const { interactions, collections, familyToken, post } = await contentFixture();
  const at = (minute) => new Date(Date.parse("2026-10-14T10:00:00Z") + minute * 60_000).toISOString();
  const insert = (id, parentId, minute) =>
    collections.comments.insertOne({
      _id: id, postId: post._id, networkId: FAMILY, authorDid: JUNE,
      parentId, body: id, mentions: [], createdAt: at(minute),
    });

  // The directive's fixture: {A 10:00 childless, B 11:00 childless,
  // C 12:00 with replies, D 13:00 childless}.
  const roots = [
    ["A", null, 0], ["B", null, 60], ["D", null, 180],
  ];
  for (const [id, parentId, minute] of roots) await insert(id, parentId, minute);
  const threadRoot = ["C", null, 120];
  await insert(...threadRoot);
  for (let index = 0; index < 3; index += 1) await insert(`Cr${index}`, "C", 121 + index);

  const read = async () => (await interactions.commentThread({ accessToken: familyToken, postId: post._id })).comments;
  const order = async () => {
    const rows = await read();
    return rows.filter((row) => row.parentId == null).map((row) => row.body);
  };
  // Threaded roots rank ahead of childless roots; each group newest-first.
  // (The AC's literal 'D, C, B, A' enumeration contradicts the paired PRD's
  // ruling of record — threaded-first, then newest-first — and the merged
  // UI of record, whose ruledOrder makes this fixture render C, D, B, A.)
  assert.deepEqual(await order(), ["C", "D", "B", "A"]);
  // C's replies render oldest-first inside the tree, immediately after C.
  const rows = await read();
  assert.deepEqual(rows.map((row) => row.body).slice(1, 4), ["Cr0", "Cr1", "Cr2"]);
  // Deterministic read: two fetches return the identical order.
  assert.equal(JSON.stringify(await read()), JSON.stringify(rows));

  // A later childless arrival re-ranks within its group only (E 14:00).
  await insert("E", null, 240);
  assert.deepEqual(await order(), ["C", "E", "D", "B", "A"]);

  // An equal-createdAt tie resolves threaded-ahead deterministically.
  await insert("F", null, 240);
  await insert("Fchild", "F", 240);
  // F (14:00, threaded) leads the threaded group ahead of C, and E, D, B, A
  // keep the childless group newest-first.
  assert.deepEqual(await order(), ["F", "C", "E", "D", "B", "A"]);
});

test("PORCH-085 ac-2: the card slice serves the top four of the ruled sort plus the total-root count", async () => {
  const fx = await contentFixture();
  const feed = await ruledFeed(fx);
  const cardPayload = { type: "text", body: "ruled card" };
  const post = (await fx.posts.create({ accessToken: fx.familyToken, payload: cardPayload, signature: fx.dev.signPayload(cardPayload) })).post;
  const at = (minute) => new Date(Date.parse("2026-10-14T10:00:00Z") + minute * 60_000).toISOString();
  const insert = (id, parentId, minute, did = JUNE) =>
    fx.collections.comments.insertOne({ _id: id, postId: post._id, networkId: FAMILY, authorDid: did, parentId, body: id, mentions: [], createdAt: at(minute) });

  // Roots: X 10:00 threaded (two replies), Y 11:00, Z 12:00, W 13:00, V 14:00
  // childless — the ruled top four are X, V, W, Z; Y falls into the expander.
  await insert("X", null, 0);
  await insert("Xr1", "X", 5);
  await insert("Xr2", "X", 6);
  for (const [id, minute] of [["Y", 60], ["Z", 120], ["W", 180], ["V", 240]]) await insert(id, null, minute);

  const findView = async (body) => (await feed.timeline({ accessToken: fx.familyToken })).posts.find((row) => row.body === body);

  const view = await findView("ruled card");
  assert.deepEqual(
    view.replySlice.map((row) => row.body),
    ["X", "V", "W", "Z"],
    "the threaded root leads the slice; the childless set trails newest-first",
  );
  assert.deepEqual(view.replySlice.map((row) => row.responseCount), [2, 0, 0, 0]);
  assert.equal(view.replyTotal, 5, "the slice rides the total-root count; expander math stays total minus rendered");
});

test("PORCH-085 ac-3: containment precedes the sort; no vote-bearing field or engagement count rides any ordered read", async () => {
  const fx = await contentFixture();
  const feed = await ruledFeed(fx);
  // The in-origin rows the ordered reads must actually serve.
  await fx.collections.comments.insertOne({
    _id: "A", postId: fx.post._id, networkId: FAMILY, authorDid: JUNE,
    parentId: null, body: "A root", mentions: [], createdAt: "2026-10-14T10:00:00Z",
  });
  await fx.collections.comments.insertOne({
    _id: "Ar1", postId: fx.post._id, networkId: FAMILY, authorDid: SUSAN,
    parentId: "A", body: "A reply", mentions: [], createdAt: "2026-10-14T10:30:00Z",
  });
  // A foreign-origin root and reply on the SAME post never decorate this origin.
  await fx.collections.comments.insertOne({
    _id: "f_root", postId: fx.post._id, networkId: OTHER, authorDid: JUNE,
    parentId: null, body: "foreign root", mentions: [], createdAt: "2026-10-14T23:00:00Z",
  });
  await fx.collections.comments.insertOne({
    _id: "f_reply", postId: fx.post._id, networkId: OTHER, authorDid: JUNE,
    parentId: "A", body: "foreign reply", mentions: [], createdAt: "2026-10-14T23:30:00Z",
  });

  const rows = (await fx.interactions.commentThread({ accessToken: fx.familyToken, postId: fx.post._id })).comments;
  assert.deepEqual(rows.map((row) => row.body), ["A root", "A reply"], "only this origin's rows ride the ordered thread — never the newer foreign ones");
  assert.equal(rows.some((row) => String(row.body).includes("foreign")), false, "foreign-origin rows never enter the ordered thread");
  assert.equal(JSON.stringify(rows).includes("vote"), false, "no vote-bearing field rides any thread row");

  const view = (await feed.timeline({ accessToken: fx.familyToken })).posts.find((row) => row.body === "root post");
  assert.equal(JSON.stringify(view.replySlice).includes("foreign"), false, "the card slice never carries a foreign-origin row");
  assert.equal("voteRecords" in view, false, "rank inputs stay off the view");
  assert.equal("interactionCounters" in view, false);
  assert.equal(
    JSON.stringify(view.replySlice).split('"responseCount"').length - 1,
    view.replySlice.length,
    "responseCount is the only number a slice row carries",
  );
});

test("PORCH-098 ac-1: a comment reaction rides the signed path with the subject — comment and parent post are separate reactions", async () => {
  const audits = [];
  const base = fixture({ networkIds: [FAMILY, OTHER], audit: async (action, payload) => audits.push({ action, payload }) });
  const dev = device("dev_s");
  const juneDev = device("dev_j");
  const familyToken = (await base.admit({ networkId: FAMILY, did: SUSAN, device: dev })).accessToken;
  const juneToken = (await base.admit({ networkId: FAMILY, did: JUNE, device: juneDev })).accessToken;
  const post = (await base.posts.create({ accessToken: familyToken, payload: { type: "text", body: "root post" }, signature: dev.signPayload({ type: "text", body: "root post" }) })).post;
  const commentPayload = { postId: post._id, body: "a reply" };
  const comment = (await base.interactions.comment({ accessToken: juneToken, payload: commentPayload, signature: juneDev.signPayload(commentPayload) })).comment;
  const interactions = base.interactions;
  const collections = base.collections;

  // Susan reacts to the comment — picker and chip are the same add path.
  const subjectPayload = { postId: post._id, emoji: "🎉", subjectType: "comment", commentId: comment._id };
  const written = (await interactions.react({ accessToken: familyToken, payload: subjectPayload, signature: dev.signPayload(subjectPayload) })).reaction;
  assert.equal(written.emoji, "🎉");

  // The stored row carries the subject and stays member-signed + contained.
  const row = await collections.reactions.findOne({ _id: written._id });
  assert.equal(row.subjectType, "comment");
  assert.equal(row.commentId, comment._id);
  assert.equal(row.networkId, FAMILY);
  assert.equal(row.postId, post._id);
  assert.equal(row.deviceSignature, dev.signPayload(subjectPayload));

  // The same emoji on the comment AND its parent post: two separate
  // reactions (one row per member per emoji per SUBJECT).
  const postPayload = { postId: post._id, emoji: "🎉" };
  await interactions.react({ accessToken: familyToken, payload: postPayload, signature: dev.signPayload(postPayload) });
  assert.equal((await collections.reactions.find({ postId: post._id })).length, 2);

  // Duplicate same-member same-emoji same-subject stays the idempotent class.
  await assert.rejects(
    () => interactions.react({ accessToken: familyToken, payload: subjectPayload, signature: dev.signPayload(subjectPayload) }),
    (error) => error.code === "E_REACTION_EXISTS",
  );
  assert.equal((await collections.reactions.find({ postId: post._id })).length, 2);

  // Malformed subject declarations refuse with plain language, zero mutation.
  for (const broken of [
    { postId: post._id, emoji: "🫠", subjectType: "album" },
    { postId: post._id, emoji: "🫠", subjectType: "comment" },
    { postId: post._id, emoji: "🫠", commentId: comment._id },
  ]) {
    await assert.rejects(
      () => interactions.react({ accessToken: familyToken, payload: broken, signature: dev.signPayload(broken) }),
      (error) => error.code === "E_REACTION_SUBJECT_INVALID",
    );
  }
  assert.equal((await collections.reactions.find({ postId: post._id })).length, 2);

  // The comment's row never counts toward the post's rank-input counters.
  const stored = (await collections.posts.findOne({ _id: post._id })).interactionCounters;
  assert.deepEqual([stored.reactionCount, stored.commentCount], [1, 1], "only the post-subject row counts toward reactionCount");

  // Audited like post reactions, with the subject carried into the detail.
  const created = audits.find((entry) => entry.action === "reaction_create" && entry.payload.detail.subjectType === "comment");
  assert.equal(created.payload.detail.commentId, comment._id);
  assert.equal(created.payload.did, SUSAN);
});

test("PORCH-098 ac-1: a comment-subject leave clears only the member's own row on that comment", async () => {
  const { interactions, collections, dev, juneDev, megDev, familyToken, juneToken, megToken, post } = await contentFixture();
  const commentPayload = { postId: post._id, body: "reactor bait" };
  const comment = (await interactions.comment({ accessToken: juneToken, payload: commentPayload, signature: juneDev.signPayload(commentPayload) })).comment;

  // Three rows: Susan + Meg react to the comment; Susan also holds the
  // parent post with the same emoji.
  const megSubject = { postId: post._id, emoji: "🎈", subjectType: "comment", commentId: comment._id };
  await interactions.react({ accessToken: megToken, payload: megSubject, signature: megDev.signPayload(megSubject) });
  const susanSubject = { postId: post._id, emoji: "🎈", subjectType: "comment", commentId: comment._id };
  const susanRow = (await interactions.react({ accessToken: familyToken, payload: susanSubject, signature: dev.signPayload(susanSubject) })).reaction;
  const susanPost = { postId: post._id, emoji: "🎈" };
  const susanPostRow = (await interactions.react({ accessToken: familyToken, payload: susanPost, signature: dev.signPayload(susanPost) })).reaction;

  // Susan's chip leave on the comment removes only her own comment row.
  const removed = await interactions.unreact({ accessToken: familyToken, payload: susanSubject, signature: dev.signPayload(susanSubject) });
  assert.equal(removed.reaction._id, susanRow._id);
  const remaining = await collections.reactions.find({ postId: post._id });
  assert.equal(remaining.length, 2, "Meg's comment row and Susan's parent-post row survive the leave");
  assert.ok(remaining.some((row) => row._id === susanPostRow._id), "the parent-post row is a separate subject");

  // A chip already clear stays the no-op result, never an error.
  await interactions.react({ accessToken: familyToken, payload: susanSubject, signature: dev.signPayload(susanSubject) });
  const cleared = await interactions.unreact({ accessToken: familyToken, payload: susanSubject, signature: dev.signPayload(susanSubject) });
  assert.equal(cleared.removed, true);
  const again = await interactions.unreact({ accessToken: familyToken, payload: susanSubject, signature: dev.signPayload(susanSubject) });
  assert.deepEqual(again, { removed: false, reaction: null });

  // A comment row never joins the post's reaction endpoint read.
  const postRows = (await interactions.reactionsFor({ accessToken: familyToken, postId: post._id })).reactions;
  assert.deepEqual(postRows.map((row) => row._id), [susanPostRow._id], "reactionsFor is the post-subject read");
});

test("PORCH-098 ac-3: comment reads carry attributed reactor rows in origin order; the payload never carries a count or roster", async () => {
  const avatarMetas = {
    [SUSAN]: { header: { kind: "header", width: 72, height: 72, contentType: "image/webp", sha256: "s".repeat(64) } },
    [JUNE]: { header: { kind: "header", width: 72, height: 72, contentType: "image/webp", sha256: "j".repeat(64) } },
  };
  const names = { [SUSAN]: "Susan Hale", [JUNE]: "June River" };
  const fx = fixture({
    networkIds: [FAMILY, OTHER],
    memberNames: async (dids) => dids.map((did) => ({ did, displayName: names[did] ?? null, avatar: avatarMetas[did] ?? null })),
  });
  const dev = device("dev_s");
  const juneDev = device("dev_j");
  const familyToken = (await fx.admit({ networkId: FAMILY, did: SUSAN, device: dev })).accessToken;
  const juneToken = (await fx.admit({ networkId: FAMILY, did: JUNE, device: juneDev })).accessToken;
  const post = (await fx.posts.create({ accessToken: familyToken, payload: { type: "text", body: "thread home" }, signature: dev.signPayload({ type: "text", body: "thread home" }) })).post;
  const commentPayload = { postId: post._id, body: "the subject comment" };
  const comment = (await fx.interactions.comment({ accessToken: juneToken, payload: commentPayload, signature: juneDev.signPayload(commentPayload) })).comment;

  // Reacts ride the signed path in origin order: June then Susan.
  const subject = { postId: post._id, emoji: "👏", subjectType: "comment", commentId: comment._id };
  await fx.interactions.react({ accessToken: juneToken, payload: subject, signature: juneDev.signPayload(subject) });
  await fx.interactions.react({ accessToken: familyToken, payload: subject, signature: dev.signPayload(subject) });
  // A post-subject row on the SAME post never leaks onto the comment rows.
  const postRow = { postId: post._id, emoji: "👏" };
  await fx.interactions.react({ accessToken: juneToken, payload: postRow, signature: juneDev.signPayload(postRow) });

  const rows = (await fx.interactions.commentThread({ accessToken: familyToken, postId: post._id })).comments;
  const subjectRow = rows.find((row) => row._id === comment._id);
  assert.deepEqual(
    subjectRow.reactionRows.map((row) => ({ memberDid: row.memberDid, memberName: row.memberName })),
    [
      { memberDid: JUNE, memberName: "June River" },
      { memberDid: SUSAN, memberName: "Susan Hale" },
    ],
    "reaction rows ride the origin's served order with the reactor's display name",
  );
  assert.deepEqual(subjectRow.reactionRows.map((row) => row.memberAvatar), [avatarMetas[JUNE], avatarMetas[SUSAN]]);
  assert.deepEqual(
    Object.keys(subjectRow.reactionRows[0]).sort(),
    ["_id", "createdAt", "emoji", "memberAvatar", "memberDid", "memberName"],
    "attribution only — no count, roster, or aggregate field rides the read",
  );
  // A comment nobody reacted to carries the empty additive default.
  const rootSisterPayload = { postId: post._id, body: "unreacted" };
  const sister = (await fx.interactions.comment({ accessToken: juneToken, payload: rootSisterPayload, signature: juneDev.signPayload(rootSisterPayload) })).comment;
  const freshRows = (await fx.interactions.commentThread({ accessToken: familyToken, postId: post._id })).comments;
  assert.deepEqual(freshRows.find((row) => row._id === sister._id).reactionRows, []);

  // A foreign-origin row never decorates this origin's comments (the
  // origin-scoped read keeps it off every payload, live or replayed).
  await fx.collections.reactions.insertOne({
    _id: "rct_foreign", postId: post._id, networkId: OTHER, memberDid: JUNE,
    emoji: "🐍", subjectType: "comment", commentId: comment._id, createdAt: "2026-10-16T10:00:00Z",
  });
  const containedRows = (await fx.interactions.commentThread({ accessToken: familyToken, postId: post._id })).comments;
  assert.equal(JSON.stringify(containedRows).includes("🐍"), false, "foreign-origin reactor rows never decorate any payload");

  // Card slice: the commented card's slice row carries the same rows.
  const feed = await ruledFeed(fx);
  const view = (await feed.timeline({ accessToken: familyToken })).posts.find((row) => row.body === "thread home");
  assert.equal(view.reactionRows.length, 1, "comment-subject rows never decorate the post's chips");
  assert.deepEqual(
    view.replySlice.find((row) => row._id === comment._id).reactionRows.map((row) => row.memberName),
    ["June River", "Susan Hale"],
  );
  assert.equal(JSON.stringify(JSON.stringify(view)).includes("reactionCount"), false, "no aggregate count field exists anywhere on the card");
});

test("PORCH-098 ac-4: reaction.applied carries the subject reference on comment rows; envelopes stay content-only; catch-up replays idempotently", async () => {
  const { interactions, dev, juneDev, familyToken, juneToken, post, realtimePlane } = await contentFixture();

  const commentPayload = { postId: post._id, body: "event subject" };
  const comment = (await interactions.comment({ accessToken: juneToken, payload: commentPayload, signature: juneDev.signPayload(commentPayload) })).comment;

  // A post-subject reaction keeps the shipped content exactly.
  const postPayload = { postId: post._id, emoji: "🌟" };
  await interactions.react({ accessToken: familyToken, payload: postPayload, signature: dev.signPayload(postPayload) });
  // A comment-subject reaction adds the subject reference.
  const subjectPayload = { postId: post._id, emoji: "🌟", subjectType: "comment", commentId: comment._id };
  await interactions.react({ accessToken: familyToken, payload: subjectPayload, signature: dev.signPayload(subjectPayload) });

  const read = async () => (await realtimePlane.readSince(FAMILY, null)).events.filter((event) => event.type === "reaction.applied");
  const events = await read();
  assert.equal(events.length, 2);
  const postContent = events.find((event) => event.postId === post._id).content;
  assert.deepEqual(
    Object.keys(postContent).sort(),
    ["_id", "createdAt", "emoji", "memberDid"],
    "post-subject content stays key-stable: member + emoji only",
  );
  const commentContent = events.map((event) => event.content).at(-1);
  assert.deepEqual(Object.keys(commentContent).sort(), ["_id", "commentId", "createdAt", "emoji", "memberDid", "postId", "subjectType"]);
  assert.equal(commentContent.commentId, comment._id);
  assert.equal(commentContent.postId, null, "the subject reference carries the comment; no post id is duplicated into the content");
  assert.equal(commentContent.subjectType, "comment");
  const serialized = JSON.stringify(events.map((event) => event.content));
  for (const forbidden of ["reactionCount", "commentCount", "roster", "memberName", "memberAvatar"]) {
    assert.equal(serialized.includes(forbidden), false, `no count, roster, or aggregate field (${forbidden}) ever enters an envelope`);
  }

  // Catch-up replays are idempotent and content-only: the same replayed
  // envelopes, byte-for-byte, on every reconnect read.
  assert.deepEqual(await read(), await read());
});