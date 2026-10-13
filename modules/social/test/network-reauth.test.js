// Co-located unit tests for the PORCH-065 network-half self-reference: the
// network row's hubUrl state field (a self-reference of record written by
// the address re-point, preferred first for link minting in the front door).
import { test } from "node:test";
import assert from "node:assert/strict";
import { createMemoryStore } from "@porchlight/shared";
import { NetworkService } from "../src/services/network.service.js";

function fixture() {
  const store = createMemoryStore();
  const networks = new NetworkService(store.collection("networks"));
  return { networks };
}

test("recordHubUrl writes the network row's hubUrl self-reference", async () => {
  const { networks } = fixture();
  await networks.createNetwork({ name: "Brian's Family", ownerDid: "did:porch:owner" });
  const updated = await networks.recordHubUrl("https://new.porch.love");
  assert.equal(updated.hubUrl, "https://new.porch.love");
  const read = await networks.get();
  assert.equal(read.hubUrl, "https://new.porch.love");
});

test("recordHubUrl is idempotent on the same URL and never invents a network", async () => {
  const { networks } = fixture();
  await networks.createNetwork({ name: "Brian's Family", ownerDid: "did:porch:owner" });
  await networks.recordHubUrl("https://new.porch.love");
  const again = await networks.recordHubUrl("https://new.porch.love");
  assert.equal(again.hubUrl, "https://new.porch.love");
  await assert.rejects(
    () => new NetworkService(createMemoryStore().collection("networks")).recordHubUrl("https://x.y"),
    (error) => error.code === "E_NETWORK_NOT_FOUND",
  );
});