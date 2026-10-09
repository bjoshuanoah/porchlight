import { test } from "node:test";
import assert from "node:assert/strict";
import { createMemoryStore } from "@porchlight/shared";
import { NetworkService } from "../src/services/network.service.js";
import { InviteService } from "../src/services/invite.service.js";

function services() {
  const db = createMemoryStore();
  return {
    networks: new NetworkService(db.collection("networks")),
    invites: new InviteService(db.collection("invites")),
  };
}

test("network is created once; repeat calls return the same network", async () => {
  const { networks } = services();
  const first = await networks.createNetwork({ name: "Family", ownerAccountId: "acct_1" });
  assert.equal(first.created, true);
  assert.equal(first.network.name, "Family");

  const second = await networks.createNetwork({ name: "Other" });
  assert.equal(second.created, false);
  assert.equal(second.network._id, first.network._id);
});

test("network creation requires a name", async () => {
  const { networks } = services();
  await assert.rejects(() => networks.createNetwork({}), (error) => error.code === "E_NAME_REQUIRED");
});

test("invite is issued active and revoked instantly", async () => {
  const { invites } = services();
  const issued = await invites.issue({ networkId: "net_1", hubUrl: "https://hub.example" });
  assert.equal(issued.state, "active");
  assert.ok(issued.token.length > 10);
  assert.equal(issued.maxUses, 1);

  const revoked = await invites.revoke({ inviteId: issued._id });
  assert.equal(revoked.revoked, true);
  assert.ok(revoked.invite.revokedAt);

  const again = await invites.revoke({ inviteId: issued._id });
  assert.equal(again.revoked, false);
});

test("revocation of an unknown invite fails loudly", async () => {
  const { invites } = services();
  await assert.rejects(
    () => invites.revoke({ inviteId: "nope" }),
    (error) => error.code === "E_INVITE_NOT_FOUND",
  );
});