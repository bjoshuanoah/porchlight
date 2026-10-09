import { test } from "node:test";
import assert from "node:assert/strict";
import { createMemoryStore } from "@porchlight/shared";
import { AccountService } from "../src/services/account.service.js";

function service() {
  const db = createMemoryStore();
  return { db, accountService: new AccountService(db.collection("accounts")) };
}

test("first account is created once; repeat calls return the same account", async () => {
  const { accountService } = service();
  const first = await accountService.createFirstAccount({ displayName: "Brian", email: "b@example.com" });
  assert.equal(first.created, true);
  assert.equal(first.account.displayName, "Brian");
  assert.equal(first.account.kind, "owner");

  const second = await accountService.createFirstAccount({ displayName: "Other" });
  assert.equal(second.created, false);
  assert.equal(second.account._id, first.account._id);
});

test("hasAccount reflects account existence", async () => {
  const { accountService } = service();
  assert.equal(await accountService.hasAccount(), false);
  await accountService.createFirstAccount({});
  assert.equal(await accountService.hasAccount(), true);
});

test("adoption is refused once an owner account exists", async () => {
  const { accountService } = service();
  await accountService.createFirstAccount({});
  await assert.rejects(
    () => accountService.adoptIdentity({ sourceHubUrl: "https://other.hub", externalIdentityId: "id_1" }),
    (error) => error.code === "E_OWNER_ACCOUNT_EXISTS",
  );
});

test("adoption creates an adopted account with source linkage", async () => {
  const { accountService } = service();
  const result = await accountService.adoptIdentity({
    sourceHubUrl: "https://other.hub.example",
    externalIdentityId: "ident_77",
    displayName: "Adopted Owner",
  });
  assert.equal(result.adopted, true);
  assert.equal(result.account.kind, "adopted");
  assert.equal(result.account.adoptedIdentity.sourceHubUrl, "https://other.hub.example");
  assert.equal(result.account.adoptedIdentity.externalId, "ident_77");

  const again = await accountService.adoptIdentity({
    sourceHubUrl: "https://other.hub.example",
    externalIdentityId: "ident_77",
  });
  assert.equal(again.adopted, false);
  assert.equal(again.alreadyAdopted, true);
});

test("adoption requires sourceHubUrl and externalIdentityId", async () => {
  const { accountService } = service();
  await assert.rejects(
    () => accountService.adoptIdentity({ sourceHubUrl: "https://other.hub.example" }),
    (error) => error.code === "E_ADOPTION_FIELDS_REQUIRED",
  );
});