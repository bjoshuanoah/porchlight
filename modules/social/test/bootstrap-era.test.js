import { test } from "node:test";
import assert from "node:assert/strict";
import { createMemoryStore } from "@porchlight/shared";
import { NetworkService } from "../src/services/network.service.js";
import { InviteService } from "../src/services/invite.service.js";
import { MembershipService } from "../src/services/membership.service.js";
import { SocialBootstrapController } from "../src/controllers/social-bootstrap.controller.js";
import { assembleSocialModule } from "../src/assemble.js";

const CLOSED = { error: "Bootstrap is closed; use the owner console.", code: "E_BOOTSTRAP_CLOSED" };

/** Capture-only response double for direct controller invocation. */
function mockRes() {
  return {
    statusCode: 200,
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.body = payload;
      return this;
    },
  };
}

/** Controller on a fresh in-memory store with the given ledger. */
function controller(ledger, mintOwnerDeviceLink = null) {
  const db = createMemoryStore();
  const invites = new InviteService(db.collection("invites"));
  const membership = new MembershipService({
    memberships: db.collection("memberships"),
    membershipSessions: db.collection("membership_sessions"),
    deviceKeys: db.collection("device_keys"),
    invites,
    networks: db.collection("networks"),
    audit: async () => {},
  });
  return new SocialBootstrapController(
    new NetworkService(db.collection("networks")),
    invites,
    membership,
    ledger,
    mintOwnerDeviceLink,
  );
}

const stepsOf = (statuses) => async () =>
  Object.fromEntries(Object.entries(statuses).map(([step, status]) => [step, { status }]));

/* ---- network-era gate ---------------------------------------------------- */

test("era gate: network creation is allowed while the network step is pending", async () => {
  const c = controller({ record: async () => {}, steps: stepsOf({ network: "pending", invite: "pending" }) });
  const res = mockRes();
  await c.createNetwork({ body: { name: "Family" } }, res);
  assert.equal(res.statusCode, 201);
  assert.equal(res.body.created, true);
});

test("era gate: network creation is 403 E_BOOTSTRAP_CLOSED once the step completes", async () => {
  const c = controller({ record: async () => {}, steps: stepsOf({ network: "complete", invite: "pending" }) });
  const res = mockRes();
  await c.createNetwork({ body: { name: "Family" } }, res);
  assert.equal(res.statusCode, 403);
  assert.deepEqual(res.body, CLOSED);
});

test("era gate: a failed network step keeps its era open for re-runs", async () => {
  const c = controller({ record: async () => {}, steps: stepsOf({ network: "failed", invite: "pending" }) });
  const res = mockRes();
  await c.createNetwork({ body: { name: "Family" } }, res);
  assert.equal(res.statusCode, 201);
  assert.equal(res.body.created, true);
});

/* ---- invite-era gate ----------------------------------------------------- */

test("era gate: invite issue is allowed while the invite step is pending", async () => {
  const c = controller({ record: async () => {}, steps: stepsOf({ network: "complete", invite: "pending" }) });
  await c.networks.createNetwork({ name: "Family" });
  const res = mockRes();
  await c.issueInvite({ body: { role: "member" } }, res);
  assert.equal(res.statusCode, 201);
  assert.ok(res.body.invite.token);

  const revokeRes = mockRes();
  await c.revokeInvite({ body: { inviteId: res.body.invite._id } }, revokeRes);
  assert.equal(revokeRes.statusCode, 200);
  assert.equal(revokeRes.body.revoked, true);
});

test("era gate: invite issue and revoke are 403 E_BOOTSTRAP_CLOSED once the step completes", async () => {
  const c = controller({ record: async () => {}, steps: stepsOf({ network: "complete", invite: "complete" }) });
  await c.networks.createNetwork({ name: "Family" });
  const issueRes = mockRes();
  await c.issueInvite({ body: {} }, issueRes);
  assert.equal(issueRes.statusCode, 403);
  assert.deepEqual(issueRes.body, CLOSED);

  const revokeRes = mockRes();
  await c.revokeInvite({ body: { inviteId: "inv_x" } }, revokeRes);
  assert.equal(revokeRes.statusCode, 403);
  assert.deepEqual(revokeRes.body, CLOSED);
});

/* ---- fail-closed defaults ------------------------------------------------- */

test("era gate: CLOSED by default when the ledger does not report steps", async () => {
  const defaultLedger = controller({ record: async () => {} });
  const res = mockRes();
  await defaultLedger.createNetwork({ body: { name: "Family" } }, res);
  assert.equal(res.statusCode, 403);
  assert.deepEqual(res.body, CLOSED);

  const noLedger = controller(null);
  const noLedgerRes = mockRes();
  await noLedger.createNetwork({ body: { name: "Family" } }, noLedgerRes);
  assert.equal(noLedgerRes.statusCode, 403);
  assert.deepEqual(noLedgerRes.body, CLOSED);
});

test("era gate: a throwing steps() closes the era", async () => {
  const c = controller({
    record: async () => {},
    steps: async () => {
      throw new Error("ledger unavailable");
    },
  });
  const res = mockRes();
  await c.createNetwork({ body: { name: "Family" } }, res);
  assert.equal(res.statusCode, 403);
  assert.deepEqual(res.body, CLOSED);
});

test("era gate: an unusable steps payload (null) closes the era; a missing row stays open", async () => {
  const nullSteps = controller({ record: async () => {}, steps: async () => null });
  const res = mockRes();
  await nullSteps.createNetwork({ body: { name: "Family" } }, res);
  assert.equal(res.statusCode, 403);
  assert.deepEqual(res.body, CLOSED);

  // An absent step row is an unattempted step — its era is open.
  const missingRow = controller({ record: async () => {}, steps: async () => ({ account: { status: "pending" } }) });
  const openRes = mockRes();
  await missingRow.createNetwork({ body: { name: "Family" } }, openRes);
  assert.equal(openRes.statusCode, 201);
});

/* ---- assembled-module wiring --------------------------------------------- */

test("assembled module: ledger.steps rides options.ledger; absent → fail-closed", async () => {
  const plain = assembleSocialModule(createMemoryStore(), {
    verifyMemberIdToken: (token) => (token ? { did: token } : null),
  });
  const closed = mockRes();
  await plain.controllers.bootstrap.createNetwork({ body: { name: "Family" } }, closed);
  assert.equal(closed.statusCode, 403);
  assert.deepEqual(closed.body, CLOSED);

  const db = createMemoryStore();
  const gated = assembleSocialModule(db, {
    verifyMemberIdToken: (token) => (token ? { did: token } : null),
    ledger: {
      record: async () => {},
      steps: async () => ({ network: { status: "pending" }, invite: { status: "pending" } }),
    },
  });
  const open = mockRes();
  await gated.controllers.bootstrap.createNetwork(
    { body: { name: "Family", ownerDid: "did:porchlight:owner" } },
    open,
  );
  assert.equal(open.statusCode, 201);
  // The CLI's ownerDid reaches the network row (founder-owner rule key).
  assert.equal(open.body.network.ownerDid, "did:porchlight:owner");
  const noAccountsRow = mockRes();
  await gated.controllers.bootstrap.createNetwork({ body: { name: "Second" } }, noAccountsRow);
  assert.equal(noAccountsRow.statusCode, 200); // idempotent re-run inside the open era
  assert.equal(noAccountsRow.body.created, false);
});
/* ---- owner-bind handoff (PORCH-031) -------------------------------------- */

test("a bound founder leaves bootstrap with a single-use owner-bind grant", async () => {
  const mints = [];
  const c = controller(
    { record: async () => {}, steps: stepsOf({ network: "pending", invite: "pending" }) },
    async (did) => {
      mints.push(did);
      return { grantId: "dl_1", token: "bind-tok-1", expiresAt: "2026-10-15T00:00:00.000Z" };
    },
  );
  const res = mockRes();
  await c.createNetwork({ body: { name: "Family", ownerDid: "did:porchlight:owner" } }, res);
  assert.equal(res.statusCode, 201);
  assert.deepEqual(mints, ["did:porchlight:owner"], "the grant targets exactly the bound founder identity");
  assert.deepEqual(res.body.ownerBind, { did: "did:porchlight:owner", grantId: "dl_1", token: "bind-tok-1", expiresAt: "2026-10-15T00:00:00.000Z" });
  assert.equal(res.body.membership.did, "did:porchlight:owner");
});

test("no owner-bind grant without a bound founder (ownerDid is the only key)", async () => {
  const mints = [];
  const c = controller(
    { record: async () => {}, steps: stepsOf({ network: "pending", invite: "pending" }) },
    async (did) => {
      mints.push(did);
      return { grantId: "dl_x", token: "bind-tok-x", expiresAt: "2026-10-15T00:00:00.000Z" };
    },
  );
  const noOwner = mockRes();
  await c.createNetwork({ body: { name: "Family" } }, noOwner);
  assert.equal(noOwner.statusCode, 201);
  assert.equal(noOwner.body.ownerBind, undefined);
  assert.deepEqual(mints, []);

  // A DID that is not the network row's ownerDid binds nothing and mints nothing.
  const c2 = controller(
    { record: async () => {}, steps: stepsOf({ network: "pending", invite: "pending" }) },
    async (did) => {
      mints.push(did);
      return { grantId: "dl_y", token: "bind-tok-y", expiresAt: "2026-10-15T00:00:00.000Z" };
    },
  );
  await c2.createNetwork({ body: { name: "Family", ownerDid: "did:porchlight:owner" } }, mockRes());
  const other = mockRes();
  await c2.createNetwork({ body: { name: "Family Two", ownerDid: "did:porchlight:stranger" } }, other);
  assert.equal(other.statusCode, 200, "the network write is idempotent; the existing network returns");
  assert.equal(other.body.membership, undefined, "no founder bound, no membership in the response");
  assert.deepEqual(mints, ["did:porchlight:owner"]);
});

test("identity serving off (no callback) keeps the ownerBind shape out of the response", async () => {
  const c = controller({ record: async () => {}, steps: stepsOf({ network: "pending", invite: "pending" }) });
  const res = mockRes();
  await c.createNetwork({ body: { name: "Family", ownerDid: "did:porchlight:owner" } }, res);
  assert.equal(res.statusCode, 201);
  assert.equal(res.body.ownerBind, undefined);
  assert.equal(res.body.membership.role, "owner");
});

test("an owner-bind mint failure fails the step BEFORE the ledger records it, so the era stays open", async () => {
  let recorded = 0;
  let fail = true;
  const c = controller(
    {
      record: async () => {
        recorded += 1;
      },
      steps: stepsOf({ network: "pending", invite: "pending" }),
    },
    async () => {
      if (fail) throw new Error("identity store unreachable");
      return { grantId: "dl_ok", token: "bind-tok-ok", expiresAt: "2026-10-15T00:00:00.000Z" };
    },
  );
  await assert.rejects(
    () => c.createNetwork({ body: { name: "Family", ownerDid: "did:porchlight:owner" } }, mockRes()),
    /identity store unreachable/,
  );
  assert.equal(recorded, 0, "the network step must stay unrecorded so a re-run resumes it");
  // The retry mints and then records (the re-run re-presents the owner DID,
  // exactly how the CLI resolves it on resume).
  fail = false;
  const retry = mockRes();
  await c.createNetwork({ body: { name: "Family", ownerDid: "did:porchlight:owner" } }, retry);
  assert.equal(retry.statusCode, 200, "the network write itself is idempotent on resume");
  assert.equal(retry.body.ownerBind.token, "bind-tok-ok");
  assert.equal(recorded, 1);
});
