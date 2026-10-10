import { test } from "node:test";
import assert from "node:assert/strict";
import { createMemoryStore } from "@porchlight/shared";
import { AuditService } from "../src/services/audit.service.js";

const NET = "net_family";

/** Seed `count` events whose createdAt run oldest → newest (ISO strings). */
async function seed(store, count, { seedBase = 1_000, net = NET } = {}) {
  const events = new AuditService(store.collection("audit_events"));
  const rows = [];
  for (let i = 0; i < count; i++) {
    const row = {
      _id: `aud_${seedBase}_${i}`,
      networkId: net,
      did: `did:porchlight:m${i}`,
      action: `login_${seedBase + i}`,
      detail: { sequence: i },
      createdAt: new Date(Date.parse("2026-10-10T00:00:00Z") + i * 1_000).toISOString(),
    };
    await store.collection("audit_events").insertOne(row);
    rows.push(row);
  }
  return { events, rows, store };
}

/* ---- ac-1: newest first --------------------------------------------------- */

test("audit read renders newest first, most recent event at the top", async () => {
  const store = createMemoryStore();
  const { events, rows } = await seed(store, 5);
  // Insertion order is oldest-first; the read must reverse it.
  const listed = (await events.list({ networkId: NET })).events;
  assert.deepEqual(listed.map((event) => event._id), rows.map((event) => event._id).reverse());
  assert.equal(listed[0].action, "login_1004");
  assert.equal(listed.at(-1).action, "login_1000");
});

test("audit read is deterministic on equal createdAt (stable reverse tiebreak)", async () => {
  const store = createMemoryStore();
  const events = new AuditService(store.collection("audit_events"));
  const stamp = "2026-10-10T00:00:05.000Z";
  const ids = [];
  for (let i = 0; i < 4; i++) {
    const row = {
      _id: `aud_${String(i).padStart(2, "0")}`,
      networkId: NET,
      did: null,
      action: `action_${i}`,
      detail: {},
      createdAt: stamp,
    };
    await store.collection("audit_events").insertOne(row);
    ids.push(row._id);
  }
  const a = (await events.list({ networkId: NET })).events.map((event) => event._id);
  const b = (await events.list({ networkId: NET })).events.map((event) => event._id);
  assert.deepEqual(a, [...ids].reverse());
  assert.deepEqual(a, b);
});

/* ---- ac-2: bounded pagination --------------------------------------------- */

test("audit read paginates: bounded page, offset windows, hasMore flags", async () => {
  const store = createMemoryStore();
  const { events, rows } = await seed(store, 12);
  const expected = rows.map((event) => event._id).reverse(); // newest-first ids

  const first = await events.list({ networkId: NET, limit: 5 });
  assert.deepEqual(first.events.map((event) => event._id), expected.slice(0, 5));
  assert.equal(first.total, 12);
  assert.equal(first.limit, 5);
  assert.equal(first.offset, 0);
  assert.equal(first.hasMore, true);

  const second = await events.list({ networkId: NET, limit: 5, offset: 5 });
  assert.deepEqual(second.events.map((event) => event._id), expected.slice(5, 10));
  assert.equal(second.hasMore, true);

  const tail = await events.list({ networkId: NET, limit: 5, offset: 10 });
  assert.deepEqual(tail.events.map((event) => event._id), expected.slice(10, 12));
  assert.equal(tail.hasMore, false);

  const beyond = await events.list({ networkId: NET, limit: 5, offset: 12 });
  assert.deepEqual(beyond.events, []);
  assert.equal(beyond.hasMore, false);
  // A page never returns the full unbounded set when a limit is requested.
  assert.equal((await events.list({ networkId: NET, limit: 3 })).events.length, 3);
});

test("audit read clamps the page: default 50, ceiling 200, junk offsets grounded at zero", async () => {
  const store = createMemoryStore();
  const events = new AuditService(store.collection("audit_events"));
  const rows = [];
  for (let i = 0; i < 3; i++) rows.push(await events.record({ networkId: NET, action: `a${i}` }));

  assert.equal((await events.list({ networkId: NET })).limit, 50);
  assert.equal((await events.list({ networkId: NET, limit: 9999 })).limit, 200);
  assert.equal((await events.list({ networkId: NET, limit: "junk" })).events.length, rows.length);
  assert.equal((await events.list({ networkId: NET, offset: "junk" })).offset, 0);
  assert.equal((await events.list({ networkId: NET, offset: -5 })).offset, 0);
  const zeroLimit = await events.list({ networkId: NET, limit: 0 });
  assert.equal(zeroLimit.limit, 50);
  assert.equal(zeroLimit.events.length, rows.length);
});

test("audit read is scoped to one network", async () => {
  const store = createMemoryStore();
  const { events, rows } = await seed(store, 6);
  await events.record({ networkId: "net_other", action: "login_elsewhere" });
  const listed = await events.list({ networkId: NET });
  assert.equal(listed.total, 6);
  assert.deepEqual(new Set(listed.events.map((event) => event._id)), new Set(rows.map((event) => event._id)));
});

/* ---- ac-4: prior events preserved ------------------------------------------ */

test("prior events read back unchanged under the new ordering and pagination", async () => {
  const store = createMemoryStore();
  const { events, rows } = await seed(store, 9);
  const first = await events.list({ networkId: NET, limit: 4 });
  const second = await events.list({ networkId: NET, limit: 4, offset: 4 });
  const third = await events.list({ networkId: NET, limit: 4, offset: 8 });
  const readBackBy = new Map([...first.events, ...second.events, ...third.events]
    .map((event) => [event._id, event]));
  const originalBy = new Map(rows.map((event) => [event._id, event]));
  assert.equal(readBackBy.size, rows.length);
  for (const [id, event] of originalBy) {
    assert.deepEqual(readBackBy.get(id), event, `${id} survives with its stored shape intact`);
  }
});