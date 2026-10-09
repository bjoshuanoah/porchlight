import { test } from "node:test";
import assert from "node:assert/strict";
import { fixture, HUB_URL } from "./helpers/slice-b.fixture.js";

test("acct:<handle>@<host> resolves to the DID with self + issuer links", async () => {
  const { didService, webfingerService } = fixture();
  const identity = await didService.createIdentity({ actorType: "human", displayName: "Susan" });
  await didService.setHandle({ did: identity.did, handle: "susan" });

  const result = await webfingerService.query(`acct:susan@${new URL(HUB_URL).host}`);
  assert.equal(result.subject, `acct:susan@${new URL(HUB_URL).host}`);
  assert.equal(result.links.length, 2);
  assert.deepEqual(result.links[0], {
    rel: "self",
    type: "application/did+json",
    href: identity.did,
  });
  assert.deepEqual(result.links[1], {
    rel: "http://openid.net/specs/connect/1.0/issuer",
    href: HUB_URL,
  });
});

test("bare acct:<handle> normalizes to acct:<handle>@<hub host> and resolves identically", async () => {
  const { didService, webfingerService } = fixture();
  const identity = await didService.createIdentity({ actorType: "human", displayName: "Susan" });
  await didService.setHandle({ did: identity.did, handle: "susan" });

  const result = await webfingerService.query("acct:susan");
  assert.equal(result.subject, "acct:susan@hub.example");
  assert.equal(result.links[0].href, identity.did);
});

test("handle reassignment keeps the DID: query follows the current handle point (ac-10)", async () => {
  const { didService, webfingerService } = fixture();
  const identity = await didService.createIdentity({ actorType: "human", displayName: "Susan" });
  await didService.setHandle({ did: identity.did, handle: "susan" });
  const before = await webfingerService.query("acct:susan");
  assert.equal(before.links[0].href, identity.did);

  await didService.setHandle({ did: identity.did, handle: "susan-after-move" });
  const after = await webfingerService.query("acct:susan-after-move");
  assert.equal(after.links[0].href, identity.did, "DID stable after reassignment");
  assert.equal(await webfingerService.query("acct:susan"), null, "old handle releases");
});

test("unknown handle resolves to null (caller maps 404)", async () => {
  const { didService, webfingerService } = fixture();
  const identity = await didService.createIdentity({ actorType: "human", displayName: "Susan" });
  await didService.setHandle({ did: identity.did, handle: "susan" });
  assert.equal(await webfingerService.query("acct:nobody"), null);
  assert.equal(await webfingerService.query("acct:nobody@hub.example"), null);
});

test("a missing or empty resource throws E_RESOURCE_REQUIRED", async () => {
  const { webfingerService } = fixture();
  await assert.rejects(() => webfingerService.query(undefined), {
    code: "E_RESOURCE_REQUIRED",
  });
  await assert.rejects(() => webfingerService.query(null), { code: "E_RESOURCE_REQUIRED" });
  await assert.rejects(() => webfingerService.query(""), { code: "E_RESOURCE_REQUIRED" });
  await assert.rejects(() => webfingerService.query("   "), { code: "E_RESOURCE_REQUIRED" });
});

test("non-acct resources and acct: forms without a local part resolve to null", async () => {
  const { didService, webfingerService } = fixture();
  const identity = await didService.createIdentity({ actorType: "human", displayName: "Susan" });
  await didService.setHandle({ did: identity.did, handle: "susan" });
  assert.equal(await webfingerService.query("https://hub.example/susan"), null);
  assert.equal(await webfingerService.query("acct:@hub.example"), null);
});

test("an identity with no handle set does not resolve, even with an exact DID query shape", async () => {
  const { didService, webfingerService } = fixture();
  await didService.createIdentity({ actorType: "human", displayName: "Susan" });
  assert.equal(await webfingerService.query("acct:susan"), null);
});