// Emoji usage memory (PORCH-120, Brian Oct 21 2026): the account-level
// Frequently Used record behind the picker's tab. The pure service surface:
// count-then-recency ordering, identity scoping, the wire law (emoji order
// only — no counts, ids, or timestamps), the served cap, and increment-on-
// add with un-react never decrementing (the reaction-path half is pinned
// in interaction.service.test.js and the route half in usage-router.test.js
// + the apps/server api contract).
import { test } from "node:test";
import assert from "node:assert/strict";
import { createMemoryStore } from "@porchlight/shared";
import { EmojiUsageService } from "../src/services/usage.service.js";

const VALID = { membership: { networkId: "net_family" }, session: { did: "did:porch:susan" } };

/** A membership plane scoping reads to the caller's own identity only. */
const membership = {
  verifyAccessToken: (token) => {
    if (token === "token-susan") return Promise.resolve(VALID);
    if (token === "token-june") return Promise.resolve({ membership: VALID.membership, session: { did: "did:porch:june" } });
    return Promise.resolve(null);
  },
};

async function service() {
  const store = createMemoryStore();
  return new EmojiUsageService({
    emojiUsage: store.collection("emoji_usage"),
    membership,
  });
}

async function record(service, did, emoji, times = 1) {
  for (let i = 0; i < times; i += 1) await service.record(did, emoji);
}

test("ac-1: usage orders most-used first, most recent beneath a tie", async () => {
  const usage = await service();
  const did = VALID.session.did;
  await record(usage, did, "🍂", 2);
  await record(usage, did, "🌞", 1);
  await record(usage, did, "🧡", 1);
  // Deterministic recency stamps for the tie: 🧡 lands latest.
  await usage.emojiUsage.updateOne(
    { memberDid: did, emoji: "🌞" },
    { $set: { lastUsedAt: "2026-01-01T00:00:00.000Z" } },
  );
  await usage.emojiUsage.updateOne(
    { memberDid: did, emoji: "🧡" },
    { $set: { lastUsedAt: "2027-01-01T00:00:00.000Z" } },
  );
  const list = await usage.list({ accessToken: "token-susan" });
  // 🍂 leads (2 adds); the single-add pair orders most-recent first.
  assert.deepEqual(list, { emoji: ["🍂", "🧡", "🌞"] });
});

test("ac-1: the served payload is the emoji order alone — no counts ride the wire", async () => {
  const usage = await service();
  await record(usage, VALID.session.did, "🍂", 3);
  const list = await usage.list({ accessToken: "token-susan" });
  assert.ok(Array.isArray(list.emoji), "the usage wire carries one emoji list");
  assert.equal(list.emoji.length, 1);
  assert.deepEqual(list.emoji, ["🍂"]);
  const keys = Object.keys(list);
  assert.deepEqual(keys.sort(), ["emoji"], `no count, tally, id, or timestamp fields ride the usage wire: got ${keys.join(",")}`);
});

test("ac-2/5: usage is identity-scoped — no cross-identity read exists", async () => {
  const usage = await service();
  await record(usage, VALID.session.did, "🍂", 2);
  // June's own record starts empty: Susan's usage never renders on her
  // surface, and her token only ever resolves her own list.
  const juneList = await usage.list({ accessToken: "token-june" });
  assert.deepEqual(juneList, { emoji: [] });
  // june records; the two members' lists stay independent.
  await record(usage, "did:porch:june", "🌞");
  assert.deepEqual((await usage.list({ accessToken: "token-susan" })).emoji, ["🍂"]);
  assert.deepEqual((await usage.list({ accessToken: "token-june" })).emoji, ["🌞"]);
  // The store rows key identity-globally (no network scoping): one row per
  // (memberDid, emoji), shared across the member's devices and origins.
  const rows = await usage.emojiUsage.find({ emoji: "🍂" });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].memberDid, VALID.session.did);
  assert.equal(rows[0].networkId, undefined, "the usage row carries no network scope (identity-global by build call)");
});

test("ac-2/5: an unverified token reads nothing — 401/403 surfaces, no data", async () => {
  const usage = await service();
  await record(usage, VALID.session.did, "🍂");
  await assert.rejects(
    usage.list({ accessToken: "" }),
    (error) => error.code === "E_MUST_SIGN_IN" && typeof error.message === "string",
  );
  await assert.rejects(
    usage.list({ accessToken: "token-stranger" }),
    (error) => error.code === "E_NOT_PERMITTED",
  );
});

test("ac-1: the served list caps at the build limit — the store keeps the history", async () => {
  const usage = await service();
  const did = VALID.session.did;
  // Thirty emoji the member used twice, ten used once: the cap serves the
  // 30 most-used (count descending); the ten stay stored, unserved.
  for (let i = 0; i < 30; i += 1) {
    await record(usage, did, `E${String(i).padStart(2, "0")}`, 2);
  }
  for (let i = 0; i < 10; i += 1) {
    await record(usage, did, `F${String(i).padStart(2, "0")}`, 1);
  }
  const rows = await usage.emojiUsage.find({});
  assert.equal(rows.length, 40, "the store keeps every recorded emoji — history, not just the served window");
  const list = await usage.list({ accessToken: "token-susan" });
  assert.equal(list.emoji.length, 30);
  const served = new Set(list.emoji);
  for (const emoji of ["E00", "E29"]) assert.ok(served.has(emoji), `the most-used tier serves: ${emoji}`);
  assert.equal(served.has("F00"), false, "the single-use tier falls beneath the cap");
});

test("record tolerates a degenerate call and stores nothing (defensive)", async () => {
  const usage = await service();
  await usage.record(VALID.session.did, "");
  await usage.record("", "🍂");
  await usage.record(VALID.session.did, null);
  await usage.record(VALID.session.did, undefined);
  const rows = await usage.emojiUsage.find({});
  assert.equal(rows.length, 0);
  assert.deepEqual(await usage.list({ accessToken: "token-susan" }), { emoji: [] });
});

test("usage memory never surfaces count rows from the store through any served shape", async () => {
  const usage = await service();
  await record(usage, VALID.session.did, "🍂", 5);
  const rows = await usage.emojiUsage.find({ memberDid: VALID.session.did });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].count, 5, "the internal tally exists (ordering key only)");
  const served = await usage.list({ accessToken: "token-susan" });
  const serial = JSON.stringify(served);
  assert.ok(!serial.includes("count"), "no count field rides the wire");
  assert.ok(!serial.includes("memberDid"), "no identity field rides the wire");
  assert.ok(!serial.includes("lastUsedAt"), "no timestamp rides the wire");
});