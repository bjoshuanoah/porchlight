// Update-surface helpers (PORCH-040): the console's card model renders
// exactly what the owner-initiated check reported, and the post-apply wait
// awaits a real signal (a healthy restarted hub) rather than a guessed
// duration. No network, no real hub.
import { test } from "node:test";
import assert from "node:assert/strict";
import { updateCardModel, waitUntilHubHealthy } from "../src/update.js";

test("the card reflects an available newer release — current and latest, one owner action follows", () => {
  const card = updateCardModel({ current: "1.2.3", latest: "2.0.0", updateAvailable: true });
  assert.equal(card.state, "newer");
  assert.deepEqual(card.lines, ["Current release: v1.2.3", "Newer release available: v2.0.0."]);
  assert.equal(card.applyTo, "2.0.0");
});

test("the card states already-latest as a version statement only", () => {
  const card = updateCardModel({ current: "2.0.0", latest: "2.0.0", updateAvailable: false });
  assert.equal(card.state, "latest");
  assert.deepEqual(card.lines, ["Current release: v2.0.0", "porchlight v2.0.0 is the latest release."]);
  assert.equal(card.applyTo, undefined);
});

test("the card turns an unreachable registry into plain language — nothing was fetched or changed", () => {
  const card = updateCardModel({
    current: "1.2.3",
    latest: null,
    updateAvailable: false,
    note: "the npm registry could not be reached",
  });
  assert.equal(card.state, "unavailable");
  assert.match(card.note, /could not be reached/);
  assert.deepEqual(card.lines, ["Current release: v1.2.3"]);
});

test("the card degrades plainly when the surface is absent", () => {
  assert.deepEqual(updateCardModel(null), { state: "unavailable", lines: [] });
});

test("the post-apply wait returns on the first healthy restarted hub — not on a timer", async () => {
  let calls = 0;
  const ok = await waitUntilHubHealthy("https://hub.test", {
    timeoutMs: 1_000,
    delayMs: 0,
    fetchFn: async () => {
      calls += 1;
      if (calls < 3) throw new Error("still restarting");
      return {
        ok: true,
        json: async () => ({ service: "porchlight-server" }),
      };
    },
    delay: async () => {},
  });
  assert.equal(ok, true);
  assert.equal(calls, 3);
});

test("the wait names a hub that never came back, in plain language, after the wait budget", async () => {
  let probes = 0;
  await assert.rejects(
    waitUntilHubHealthy("https://hub.test", {
      timeoutMs: 0,
      delayMs: 0,
      fetchFn: async () => {
        probes += 1;
        throw new Error("still restarting");
      },
      delay: async () => {},
    }),
    /has not come back healthy/,
  );
  assert.equal(probes, 1);
});

test("a listening but non-porchlight answer does not end the wait", async () => {
  let calls = 0;
  await assert.rejects(
    waitUntilHubHealthy("https://hub.test", {
      timeoutMs: 0,
      delayMs: 0,
      fetchFn: async () => {
        calls += 1;
        return { ok: true, json: async () => ({ service: "someone-else" }) };
      },
      delay: async () => {},
    }),
    /has not come back healthy/,
  );
  assert.equal(calls, 1);
});