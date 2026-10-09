import test from "node:test";
import assert from "node:assert/strict";
import { createCustody } from "../src/session-sync.js";
import { connectionsStorageKey, renewSlotKey, saveConnections } from "../src/store.js";

// Minimal localStorage stand-in with the ability to raise "storage" events
// like a sibling tab's write would (the writer tab never gets the event).
function fakeStorage() {
  const map = new Map();
  return {
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => map.set(key, String(value)),
    removeItem: (key) => map.delete(key),
    publishTo: (custody, origin) => {
      const key = connectionsStorageKey(origin);
      custody.notify({ key, newValue: map.get(key) ?? null });
    },
  };
}

const HUB = "https://hub.example";
const did = "did:porchlight:brian";

function connectionWith(token, identityToken) {
  return {
    url: HUB,
    identity: { id: did, name: "Brian" },
    deviceId: "dev_1",
    token,
    identityToken,
    refreshToken: "refresh-1",
  };
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test("a sibling tab adopts the published token set within one request cycle (ac-1 path)", async () => {
  const shared = fakeStorage();
  const published = {
    url: HUB,
    identity: { id: did, name: "Brian" },
    deviceId: "dev_1",
    token: "membership-2",
    identityToken: "identity-2",
    refreshToken: "refresh-2",
    renewedAt: Date.now(),
  };
  saveConnections(shared, HUB, [published]);

  const sibling = createCustody({ storage: shared, origin: HUB, publishWaitMs: 50 });
  const stale = connectionWith("membership-1", "identity-1");
  // Publication arrives (storage event) exactly as the request 401s — the
  // worst in-flight case. Recovery must adopt the sibling's copy, not renew.
  shared.publishTo(sibling, HUB);
  const replacement = await sibling.recover({ connection: stale, error: { status: 401, code: "E_SESSION_REQUIRED" } });
  assert.ok(replacement, "published tokens must be adopted");
  assert.equal(replacement.token, "membership-2");
  assert.equal(replacement.identityToken, "identity-2");
});

test("recovery keeps the plane the failed request presented", async () => {
  const shared = fakeStorage();
  saveConnections(shared, HUB, [{
    url: HUB,
    identity: { id: did, name: "Brian" },
    deviceId: "dev_1",
    token: "membership-2",
    identityToken: "identity-2",
    renewedAt: Date.now(),
  }]);
  const sibling = createCustody({ storage: shared, origin: HUB, publishWaitMs: 50 });
  shared.publishTo(sibling, HUB);
  // The identity/devices poll presents the identity token as Bearer.
  const identityPlane = await sibling.recover({
    connection: { ...connectionWith("identity-1", "identity-1") },
    error: { status: 401 },
  });
  assert.equal(identityPlane.token, "identity-2");
  const membershipPlane = await sibling.recover({
    connection: { ...connectionWith("membership-1", "identity-1") },
    error: { status: 401 },
  });
  assert.equal(membershipPlane.token, "membership-2");
});

test("a dead token with no publication re-credentials and adopts the result", async () => {
  const shared = fakeStorage();
  const stale = connectionWith("membership-dead", "identity-dead");
  saveConnections(shared, HUB, [stale]);
  let renewals = 0;
  const custody = createCustody({ storage: shared, origin: HUB, publishWaitMs: 50 });
  custody.setRenew(async () => {
    renewals += 1;
    // The app's renew persists through saveConnections and stamps renewedAt.
    saveConnections(shared, HUB, [{
      ...stale,
      identityToken: "identity-2",
      token: "membership-2",
      refreshToken: "refresh-2",
      renewedAt: Date.now(),
    }]);
    return true;
  });
  const replacement = await custody.recover({ connection: stale, error: { status: 401 } });
  assert.equal(renewals, 1);
  assert.ok(replacement);
  assert.equal(replacement.token, "membership-2");
  // The renewal slot is released, so a later renewal can acquire it.
  assert.equal(shared.getItem(renewSlotKey(HUB)), null);
});

test("a renewal already in flight in this tab is joined, never duplicated", async () => {
  const shared = fakeStorage();
  const stale = connectionWith("membership-dead", "identity-dead");
  saveConnections(shared, HUB, [stale]);
  let started = 0;
  let releaseRenewal;
  const renewalsReady = new Promise((resolve) => { releaseRenewal = resolve; });
  const custody = createCustody({ storage: shared, origin: HUB, publishWaitMs: 50 });
  custody.setRenew(async () => {
    started += 1;
    await renewalsReady;
    saveConnections(shared, HUB, [{ ...stale, token: "membership-2", renewedAt: Date.now() }]);
    return true;
  });
  const first = custody.recover({ connection: stale, error: { status: 401 } });
  // Second 401 rides the same in-flight renewal instead of superseding it.
  const second = custody.recover({ connection: stale, error: { status: 401 } });
  await wait(10);
  releaseRenewal();
  const [one, two] = await Promise.all([first, second]);
  assert.equal(started, 1);
  assert.equal(one.token, "membership-2");
  assert.equal(two.token, "membership-2");
});

test("when another tab holds the fresh renewal slot, recovery waits for its publication", async () => {
  const shared = fakeStorage();
  const stale = connectionWith("membership-dead", "identity-dead");
  saveConnections(shared, HUB, [stale]);
  // Foreign tab took the slot and is renewing.
  shared.setItem(renewSlotKey(HUB), JSON.stringify({ owner: "other-tab", at: Date.now() }));
  let renewed = 0;
  const custody = createCustody({ storage: shared, origin: HUB, publishWaitMs: 5_000 });
  custody.setRenew(async () => { renewed += 1; return true; });
  const pending = custody.recover({ connection: stale, error: { status: 401 } });
  const race = Promise.race([
    pending.then((value) => ["resolved", value]),
    wait(50).then(() => ["still-waiting"]),
  ]);
  // Sibling publishes mid-wait; adoption beats both the slot and the timeout.
  setTimeout(() => {
    saveConnections(shared, HUB, [{ ...stale, token: "membership-2", renewedAt: Date.now() }]);
    shared.publishTo(custody, HUB);
  }, 10);
  const outcome = await race;
  assert.equal(outcome[0], "resolved", "publication adopted before the wait window ended");
  const replacement = await pending;
  assert.equal(replacement.token, "membership-2");
  assert.equal(renewed, 0, "a renewal was unnecessary: the other tab's slot was warm");
});

test("no publication and no renewal leaves the original 401 in place", async () => {
  const shared = fakeStorage();
  const stale = connectionWith("membership-dead", "identity-dead");
  saveConnections(shared, HUB, [stale]);
  const custody = createCustody({ storage: shared, origin: HUB, publishWaitMs: 20 });
  custody.setRenew(async () => { throw new Error("hub unreachable"); });
  const replacement = await custody.recover({ connection: stale, error: { status: 401 } });
  assert.equal(replacement, null);
});

test("recovery publishes adopted tokens into the app state hook, so no poll 401s twice", async () => {
  const shared = fakeStorage();
  const stale = connectionWith("membership-dead", "identity-dead");
  saveConnections(shared, HUB, [stale]);
  let adoptionEvents = 0;
  const custody = createCustody({ storage: shared, origin: HUB, publishWaitMs: 50 });
  custody.setOnAdopt(() => { adoptionEvents += 1; });
  custody.setRenew(async () => {
    saveConnections(shared, HUB, [{ ...stale, token: "membership-2", renewedAt: Date.now() }]);
    return true;
  });
  const replacement = await custody.recover({ connection: stale, error: { status: 401 } });
  assert.ok(replacement);
  assert.equal(adoptionEvents, 1, "adoption must flow to app state at recovery time");
  // A renewal through custody publishes too (gate interval path).
  adoptionEvents = 0;
  await custody.renew();
  assert.equal(adoptionEvents, 1, "a tab-initiated renewal re-publishes its own tokens");
});

test("non-401 failures never consult custody", async () => {
  const shared = fakeStorage();
  const custody = createCustody({ storage: shared, origin: HUB, publishWaitMs: 20 });
  const replacement = await custody.recover({ connection: connectionWith("t", "u"), error: { status: 403 } });
  assert.equal(replacement, null);
});