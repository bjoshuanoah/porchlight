import { test } from "node:test";
import assert from "node:assert/strict";
import { createMemoryStore } from "@porchlight/shared";
import { NetworkService } from "../src/services/network.service.js";
import { InviteService } from "../src/services/invite.service.js";
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
function controller(ledger) {
  const db = createMemoryStore();
  return new SocialBootstrapController(
    new NetworkService(db.collection("networks")),
    new InviteService(db.collection("invites")),
    ledger,
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