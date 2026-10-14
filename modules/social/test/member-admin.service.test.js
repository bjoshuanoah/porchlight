import { test } from "node:test";
import assert from "node:assert/strict";
import { createMemoryStore } from "@porchlight/shared";
import { MemberAdminService } from "../src/services/member-admin.service.js";

const OWNER = "did:porchlight:owner";
const MEMBER = "did:porchlight:june";
const FAMILY = "net_family";

/**
 * Member-admin fixture (PORCH-070): the service stands alone with the
 * cascade's collaborators recorded — sweep, media sweep, avatar retire —
 * so each purge test asserts the call ORDER (media store sweep first, the
 * avatar retire second) and what the member_purge audit detail records.
 */
function purgeFixture({ purgeAvatar = null } = {}) {
  const db = createMemoryStore();
  const calls = [];
  const audits = [];
  const service = new MemberAdminService({
    memberships: db.collection("memberships"),
    membership: {
      activeMembership: async ({ did }) => (did === OWNER ? { did: OWNER, role: "owner" } : null),
      revokeMember: async () => {
        calls.push({ step: "revoke" });
        return { revoked: true };
      },
      view: (membership) => membership,
    },
    postsService: {
      sweepContentOf: async ({ did }) => {
        calls.push({ step: "sweep", did });
        return { sweptPosts: 3 };
      },
    },
    media: {
      deleteMemberMedia: async ({ did }) => {
        calls.push({ step: "media", did });
        return { assetRowsRemoved: 2 };
      },
    },
    memberNames: async (dids) => dids.map((row) => ({ did: row, displayName: row === MEMBER ? "June River" : null })),
    purgeAvatar: purgeAvatar
      ? async (did) => {
          calls.push({ step: "avatar", did });
          return purgeAvatar(did);
        }
      : null,
    audit: async (action, payload) => {
      calls.push({ step: "audit", action });
      audits.push({ action, payload });
    },
  });
  return { db, service, calls, audits };
}

/** One admitted member row with the purge target's shape. */
function admittedMember(db, did) {
  db.collection("memberships").insertOne({
    _id: "mem_1", networkId: FAMILY, did, role: "member", state: "active",
    admittedAt: "2026-10-14T10:00:00.000Z", revokedAt: null,
  });
}

const purgeArgs = (confirmName) => ({
  networkId: FAMILY,
  memberId: "mem_1",
  confirmName,
  actor: { session: { did: OWNER } },
});

test("the purge cascade retires the avatar set after the media sweep and records it", async () => {
  const { db, service, calls, audits } = purgeFixture({ purgeAvatar: async () => ({ removed: 4 }) });
  admittedMember(db, MEMBER);

  const result = await service.purgeMember(purgeArgs("June River"));

  assert.equal(result.purged, true);
  // Cascade order: revocation, authored content, media store bytes, THEN
  // the avatar rendition set (the face goes with the account record).
  assert.deepEqual(calls.map((call) => call.step), ["revoke", "sweep", "media", "avatar", "audit"]);
  assert.deepEqual(calls.find((call) => call.step === "avatar"), { step: "avatar", did: MEMBER });
  // The audit line names the retired face alongside the purge counts.
  assert.equal(audits.length, 1);
  assert.equal(audits[0].action, "member_purge");
  assert.equal(audits[0].payload.detail.avatarRetired, true);
  assert.equal(audits[0].payload.detail.mediaRemoved, 2);
  assert.equal(audits[0].payload.detail.postsSwept, 3);
});

test("a failing avatar hook never aborts the purge — avatarRetired: false records it", async () => {
  const { db, service, calls, audits } = purgeFixture({ purgeAvatar: async () => { throw new Error("identity plane unavailable"); } });
  admittedMember(db, MEMBER);

  const result = await service.purgeMember(purgeArgs("June River"));

  assert.equal(result.purged, true);
  // The hook's failure is absorbed, not propagated: the audit line records
  // the missed retire, and the sweep + media bytes still left with the
  // member exactly as an unwired hook would leave them.
  assert.equal(audits[0].payload.detail.avatarRetired, false);
  assert.deepEqual(calls.map((call) => call.step), ["revoke", "sweep", "media", "avatar", "audit"]);
  assert.deepEqual(
    Object.keys(audits[0].payload.detail).sort(),
    ["avatarRetired", "mediaRemoved", "memberId", "postsSwept", "targetDid"],
  );
});

test("the purge without the avatar hook wired keeps the cascade working", async () => {
  const { db, service, calls, audits } = purgeFixture();
  admittedMember(db, MEMBER);

  const result = await service.purgeMember(purgeArgs("June River"));

  assert.equal(result.purged, true);
  // No avatar plane wired: no hook call — nothing swallowed, `avatarRetired:
  // false` by absence — and every other cascade step intact.
  assert.equal(calls.find((call) => call.step === "avatar"), undefined);
  assert.equal(audits[0].payload.detail.avatarRetired, false);
  assert.deepEqual(calls.map((call) => call.step), ["revoke", "sweep", "media", "audit"]);
});