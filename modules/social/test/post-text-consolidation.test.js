// The post-text consolidation (PORCH-157, Brian Nov 26 2026: "get rid of
// caption; the post text is the post text"). One text value per post, end
// to end: the document, the create write, timeline and detail reads, the
// post.created / post.updated envelopes, search, and the notification
// excerpt. The network sweep proves zero caption-bearing keys; the retired
// keys are refused loudly on the write paths.
import { test } from "node:test";
import assert from "node:assert/strict";
import { device, fixture } from "./helpers/content.fixture.js";

const SUSAN = "did:porchlight:susan";
const JUNE = "did:porchlight:june";
const FAMILY = "net_family";

/** Susan + June on the family network, committed origin media staged. */
async function consolidationFixture() {
  const fx = fixture();
  for (const [id, ct] of [["med_p1", "image/jpeg"], ["med_v1", "video/mp4"]]) {
    fx.store.collection("media_assets").insertOne({ _id: id, networkId: FAMILY, kind: "original", contentType: ct, immutable: true, sha256: `seed_${id}`, bytes: 1, blobKey: `seed_${id}`, width: null, height: null, durationSeconds: null, createdAt: "2026-11-01T00:00:00.000Z" });
  }
  const dev = device("dev_s");
  const juneDev = device("dev_j");
  const token = (await fx.admit({ networkId: FAMILY, did: SUSAN, device: dev })).accessToken;
  const juneToken = (await fx.admit({ networkId: FAMILY, did: JUNE, device: juneDev })).accessToken;
  // Excerpt capture: every push send records the trigger's excerpt value.
  const excerpts = [];
  const notify = fx.push.notify.bind(fx.push);
  fx.push.notify = async (trigger) => {
    excerpts.push(trigger);
    return notify(trigger);
  };
  return { ...fx, dev, juneDev, token, juneToken, excerpts };
}

/** The stored document carries no legacy text key and the one text value. */
async function storedPost(fx, postId) {
  const row = await fx.collections.posts.findOne({ _id: postId });
  assert.equal("caption" in row, false, "no caption key on the document");
  assert.equal("body" in row, false, "no body key on the document");
  return row;
}

test("ac-1: every create shape lands one text value on the document and the returned view — no caption-bearing key", async () => {
  const fx = await consolidationFixture();

  const textPayload = { type: "text", text: "picnic at noon" };
  const textPost = (await fx.posts.create({ accessToken: fx.token, payload: textPayload, signature: fx.dev.signPayload(textPayload) })).post;
  const photoPayload = { type: "photo", mediaRefs: ["med_p1"], text: "the pier at dusk" };
  const photoPost = (await fx.posts.create({ accessToken: fx.token, payload: photoPayload, signature: fx.dev.signPayload(photoPayload) })).post;
  const mixedPayload = { type: "photo", mediaRefs: ["med_p1", "med_v1"], text: "the whole day" };
  const mixedPost = (await fx.posts.create({ accessToken: fx.token, payload: mixedPayload, signature: fx.dev.signPayload(mixedPayload) })).post;

  for (const [post, expected] of [
    [textPost, "picnic at noon"],
    [photoPost, "the pier at dusk"],
    [mixedPost, "the whole day"],
  ]) {
    assert.equal(post.text, expected);
    const view = JSON.stringify(post);
    assert.match(view, new RegExp(`"text":"${expected.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"`), "the returned view carries the one text value");
    for (const legacy of ["caption", "body"]) {
      assert.equal(new RegExp(`"${legacy}":`).test(view), false, `no ${legacy} key on the returned view`);
    }
    await storedPost(fx, post._id).then((row) => assert.equal(row.text, expected));
  }
});

test("ac-1: a create write still carrying the retired caption/body keys is refused loudly, writing nothing", async () => {
  const fx = await consolidationFixture();

  const legacyCaption = { type: "photo", mediaRefs: ["med_p1"], caption: "stale shape" };
  await assert.rejects(
    () => fx.posts.create({ accessToken: fx.token, payload: legacyCaption, signature: fx.dev.signPayload(legacyCaption) }),
    (error) => error.code === "E_LEGACY_TEXT_KEY",
  );
  const legacyBody = { type: "text", body: "stale shape" };
  await assert.rejects(
    () => fx.posts.create({ accessToken: fx.token, payload: legacyBody, signature: fx.dev.signPayload(legacyBody) }),
    (error) => error.code === "E_LEGACY_TEXT_KEY",
  );
  assert.equal((await fx.collections.posts.find({ originNetworkId: FAMILY })).length, 0, "a refused shape creates nothing");
});

test("ac-2: the timeline, detail, and event envelopes carry exactly one text value — the sweep proves zero caption-bearing keys", async () => {
  const fx = await consolidationFixture();

  const photoPayload = { type: "photo", mediaRefs: ["med_p1"], text: "the birthday shot" };
  const created = (await fx.posts.create({ accessToken: fx.token, payload: photoPayload, signature: fx.dev.signPayload(photoPayload) })).post;

  // The events: post.created rode the same decorated view the timeline
  // read carries — one text value, no legacy key anywhere in the envelope.
  const events = (await fx.realtimePlane.readSince(FAMILY, null)).events;
  const createdEvent = events.find((event) => event.type === "post.created" && event.postId === created._id);
  assert.ok(createdEvent);
  const sweep = JSON.stringify({ timeline: (await fx.posts.list({ accessToken: fx.token })).posts, detail: (await fx.posts.get({ accessToken: fx.token, postId: created._id })).post, events });
  for (const legacy of ["caption", "body"]) {
    assert.equal(sweep.includes(`"${legacy}"`), false, `zero ${legacy}-bearing keys across reads and envelopes`);
  }
  assert.ok(sweep.includes("the birthday shot"), "the one text value rides the served payloads");
});

test("ac-3: the edit changes the one text field in place, refuses legacy keys, and search plus the reaction excerpt read the one value", async () => {
  const fx = await consolidationFixture();

  const payload = { type: "photo", mediaRefs: ["med_p1"], text: "sunset by the pier" };
  const post = (await fx.posts.create({ accessToken: fx.token, payload, signature: fx.dev.signPayload(payload) })).post;

  // The reaction excerpt reads the one text value.
  const reactPayload = { postId: post._id, emoji: "❤️" };
  await fx.interactions.react({ accessToken: fx.juneToken, payload: reactPayload, signature: fx.juneDev.signPayload(reactPayload) });
  const reactionExcerpt = fx.excerpts.find((row) => row.type === "reaction");
  assert.equal(reactionExcerpt.excerpt, "sunset by the pier");

  // Search matches the one text value on a media-shaped post. The content
  // fixture carries no feed assembly: the search surface itself is swept
  // in feed.service.test.js (updated for the one field) — here the edit
  // and stored-shape checks ride the post path.


  // The edit changes the one text field in place.
  const editPayload = { text: "sunset by the south pier" };
  const edited = await fx.posts.editPost({
    accessToken: fx.token,
    postId: post._id,
    payload: editPayload,
    signature: fx.dev.signPayload({ kind: "post-edit", postId: post._id, networkId: FAMILY, text: editPayload.text }),
  });
  assert.equal(edited.post.text, "sunset by the south pier");
  assert.equal("caption" in edited.post, false);
  await storedPost(fx, post._id).then((row) => assert.equal(row.text, "sunset by the south pier"));

  // A legacy caption key on the edit write is refused loudly: the edit
  // never accepts a separate caption; nothing was written.
  const stalePayload = { kind: "post-edit", postId: post._id, networkId: FAMILY, caption: "the old field" };
  await assert.rejects(
    () => fx.posts.editPost({ accessToken: fx.token, postId: post._id, payload: { caption: "the old field" }, signature: fx.dev.signPayload(stalePayload) }),
    (error) => error.code === "E_EDIT_LEGACY_TEXT_KEY",
  );
  await storedPost(fx, post._id).then((row) => assert.equal(row.text, "sunset by the south pier", "the refused edit wrote nothing"));
});
