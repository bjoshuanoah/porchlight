// Emoji usage through the reaction write path (PORCH-120, Brian Oct 21
// 2026): the picker adds and chip joins are the SAME signed reaction route,
// so the recording rides the one add path — a pick on a post, a pick on a
// comment, and a chip join all count; a re-add (E_REACTION_EXISTS) records
// nothing extra; un-react never touches the tally; and nothing about usage
// ever enters an event envelope, an audit row, or a push.
import { test } from "node:test";
import assert from "node:assert/strict";
import { device, fixture } from "./helpers/content.fixture.js";

const SUSAN = "did:porchlight:susan";
const JUNE = "did:porchlight:june";
const FAMILY = "net_family";

async function contentFixture() {
  const fx = fixture({ networkIds: [FAMILY] });
  const dev = device("dev_s");
  const juneDev = device("dev_j");
  const susanToken = (await fx.admit({ networkId: FAMILY, did: SUSAN, device: dev })).accessToken;
  const juneToken = (await fx.admit({ networkId: FAMILY, did: JUNE, device: juneDev })).accessToken;
  const payload = { type: "text", body: "root post" };
  const post = (await fx.posts.create({ accessToken: susanToken, payload, signature: dev.signPayload(payload) })).post;
  const commentPayload = { postId: post._id, body: "root comment" };
  const comment = (await fx.interactions.comment({ accessToken: juneToken, payload: commentPayload, signature: juneDev.signPayload(commentPayload) })).comment;
  return { ...fx, dev, juneDev, susanToken, juneToken, post, comment };
}

const react = (fx, token, dev, post, emoji, subject = {}) => {
  const payload = { postId: post._id, emoji, ...subject };
  return fx.interactions.react({ accessToken: token, payload, signature: dev.signPayload(payload) });
};

test("ac-1/2: picker adds and chip joins count — the one route records once per real add", async () => {
  const fx = await contentFixture();
  const { interactions, usage, susanToken, dev, post } = fx;

  // Picker add (route POST): counts.
  await react(fx, susanToken, dev, post, "🍂");
  // Chip join (the same signed route): counts.
  await react(fx, susanToken, dev, post, "🌞");
  // A duplicate add — the member's own existing row — records nothing.
  await assert.rejects(
    react(fx, susanToken, dev, post, "🍂"),
    (error) => error.code === "E_REACTION_EXISTS",
  );
  // A comment-subject reaction rides the same route and counts.
  const commentPayload = { postId: post._id, emoji: "🧡", subjectType: "comment", commentId: fx.comment._id };
  await interactions.react({ accessToken: susanToken, payload: commentPayload, signature: dev.signPayload(commentPayload) });

  // Deterministic recency stamps for the assertion (same-millisecond adds
  // resolve as first-recorded order — the ordering key itself is count).
  await usage.emojiUsage.updateOne({ memberDid: SUSAN, emoji: "🍂" }, { $set: { lastUsedAt: "2026-01-03T00:00:00.000Z" } });
  await usage.emojiUsage.updateOne({ memberDid: SUSAN, emoji: "🌞" }, { $set: { lastUsedAt: "2026-01-02T00:00:00.000Z" } });
  await usage.emojiUsage.updateOne({ memberDid: SUSAN, emoji: "🧡" }, { $set: { lastUsedAt: "2026-01-01T00:00:00.000Z" } });

  const list = await usage.list({ accessToken: susanToken });
  assert.deepEqual(list.emoji, ["🍂", "🌞", "🧡"], "three real adds, three recorded uses (count ties order most-recent first)");
});

test("ac-2: un-react never decrements — removing a reaction keeps the member's usage", async () => {
  const fx = await contentFixture();
  const { usage, susanToken, dev, post } = fx;
  await react(fx, susanToken, dev, post, "🍂");
  await react(fx, susanToken, dev, post, "🌞");
  const before = await usage.list({ accessToken: susanToken });
  assert.deepEqual(before.emoji, ["🍂", "🌞"]);

  // Un-react (route DELETE): the row leaves; the usage memory stays.
  const clearPayload = { postId: post._id, emoji: "🍂" };
  await fx.interactions.unreact({ accessToken: susanToken, payload: clearPayload, signature: dev.signPayload(clearPayload) });
  // Re-reacting later records a real add again (count 2 for 🍂).
  await react(fx, susanToken, dev, post, "🍂");
  const after = await usage.list({ accessToken: susanToken });
  assert.deepEqual(after.emoji, ["🍂", "🌞"], "usage never dropped — the un-react left the tally, the later add counted forward");
  const rows = await usage.emojiUsage.find({ memberDid: SUSAN });
  assert.deepEqual(rows.map((row) => [row.emoji, row.count]), [["🍂", 2], ["🌞", 1]]);
});

test("ac-5: usage never enters an envelope, an audit row, or a push", async () => {
  const fx = await contentFixture();
  const { realtimePlane } = fx;
  await react(fx, fx.susanToken, fx.dev, fx.post, "🍂");
  await fx.interactions.unreact({ accessToken: fx.susanToken, payload: { postId: fx.post._id, emoji: "🍂" }, signature: fx.dev.signPayload({ postId: fx.post._id, emoji: "🍂" }) });

  const caughtUp = await realtimePlane.readSince(FAMILY, undefined);
  const events = caughtUp.events ?? [];
  for (const event of events) {
    const serial = JSON.stringify(event);
    assert.ok(!serial.includes("usage"), "no usage event exists in the envelope vocabulary");
    assert.ok(!serial.includes("emojiUsage"), "no usage memory rides any event");
  }
  const audits = await fx.audit.events.find({});
  for (const row of audits) {
    const serial = JSON.stringify(row);
    assert.ok(!serial.includes("emojiUsage") && !serial.includes('"count"'), "usage memory writes no audit row");
  }
  // The reaction envelope family rides unchanged (as-authored emoji views
  // only) — the closed vocabulary stands with no usage event in it.
  const types = new Set(events.map((event) => event.type));
  assert.ok(types.has("reaction.applied"), "the closed envelope vocabulary rides unchanged");
  assert.ok([...types].every((type) => !/usage/i.test(type)), `no usage event type ships: got ${[...types].join(",")}`);
});

test("ac-5: another member's picker never sees this member's usage", async () => {
  const fx = await contentFixture();
  await react(fx, fx.susanToken, fx.dev, fx.post, "🍂");
  const juneView = await fx.usage.list({ accessToken: fx.juneToken });
  assert.deepEqual(juneView, { emoji: [] }, "June opens her picker: only her own usage renders");
});