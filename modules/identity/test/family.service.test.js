/**
 * Family service tests (PORCH-138). The identity-plane family organizer:
 * a parent creates the family and designates its parents; parents are the
 * governing authority of the members (membership mutations are parent-only
 * writes); parents and members stay disjoint; a family keeps at least one
 * parent; the cross-module fact surfaces (familyById, familiesForMember)
 * answer what the access model's family grants consume.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createMemoryStore } from "@porchlight/shared";
import { FamilyService } from "../src/services/family.service.js";

function fixture() {
  const store = createMemoryStore();
  const families = store.collection("families");
  const identities = store.collection("identities");
  const now = () => "2026-11-26T12:00:00.000Z";
  const service = new FamilyService(families, { identities }, now);
  return { service, families, identities };
}

async function seedIdentity(service, did) {
  // Families are relations between EXISTING identities — the tests seed the
  // identity rows the way the identity plane's account service would.
  return service.identities.insertOne({
    _id: `ident_${did.slice(-6)}`,
    did,
    actorType: "human",
    displayName: did.replace("did:porch:", ""),
    createdAt: "2026-11-26T00:00:00.000Z",
  });
}

async function seededFixture(dids) {
  const fx = fixture();
  for (const did of dids) await seedIdentity(fx, did);
  return fx;
}

test("ac-5: a parent creates the family and is the parent of record; every ref is validated against an existing identity", async () => {
  const { service } = await seededFixture(["did:porch:parent", "did:porch:kid"]);
  const { family } = await service.create({
    actorDid: "did:porch:parent",
    name: "River",
    memberIdentityRefs: ["did:porch:kid"],
  });
  assert.equal(family.name, "River");
  assert.deepEqual(family.parentIdentityRefs, ["did:porch:parent"]);
  assert.deepEqual(family.memberIdentityRefs, ["did:porch:kid"]);
  assert.equal(family.createdBy, "did:porch:parent");

  // An identity that doesn't exist is refused — families never mint one.
  await assert.rejects(
    () => service.create({ actorDid: "did:porch:ghost", name: "Ghost" }),
    (error) => error.code === "E_IDENTITY_NOT_FOUND",
  );
  await assert.rejects(
    () => service.create({ actorDid: "did:porch:parent", name: "River 2", memberIdentityRefs: ["did:porch:ghost"] }),
    (error) => error.code === "E_IDENTITY_NOT_FOUND",
  );
});

test("ac-5: parents govern membership — a member (even one acting for themselves) never mutates the family", async () => {
  const { service } = await seededFixture(["did:porch:parent", "did:porch:kid", "did:porch:ally"]);
  const { family } = await service.create({
    actorDid: "did:porch:parent",
    name: "River",
    memberIdentityRefs: ["did:porch:kid"],
  });
  // A parent adds a member.
  const updated = await service.addMember({ actorDid: "did:porch:parent", familyId: family._id, did: "did:porch:ally" });
  assert.deepEqual(updated.family.memberIdentityRefs, ["did:porch:kid", "did:porch:ally"]);
  // A member is refused plainly.
  await assert.rejects(
    () => service.addMember({ actorDid: "did:porch:kid", familyId: family._id, did: "did:porch:ally" }),
    (error) => error.code === "E_FORBIDDEN" && /parents govern/.test(error.message),
  );
});

test("ac-5: designating a parent grows the governing authority; roles stay disjoint; a family keeps at least one parent", async () => {
  const { service } = await seededFixture(["did:porch:parent", "did:porch:kid", "did:porch:second"]);
  const { family } = await service.create({
    actorDid: "did:porch:parent",
    name: "River",
    memberIdentityRefs: ["did:porch:kid", "did:porch:second"],
  });
  // A promoted member leaves the governed list.
  const { family: promoted } = await service.addParent({ actorDid: "did:porch:parent", familyId: family._id, did: "did:porch:second" });
  assert.deepEqual(promoted.parentIdentityRefs, ["did:porch:parent", "did:porch:second"]);
  assert.deepEqual(promoted.memberIdentityRefs, ["did:porch:kid"]);

  // One role per person per family.
  await assert.rejects(
    () => service.addParent({ actorDid: "did:porch:parent", familyId: family._id, did: "did:porch:parent" }),
    (error) => error.code === "E_ALREADY_IN_ROLE",
  );
  await assert.rejects(
    () => service.addMember({ actorDid: "did:porch:parent", familyId: family._id, did: "did:porch:parent" }),
    (error) => error.code === "E_ALREADY_IN_ROLE",
  );
  // Creation refuses the overlap too.
  await assert.rejects(
    () => service.create({
      actorDid: "did:porch:parent",
      name: "Overlap",
      parentIdentityRefs: ["did:porch:second"],
      memberIdentityRefs: ["did:porch:second"],
    }),
    (error) => error.code === "E_FAMILY_ROLE_OVERLAP",
  );
  // With two parents, one may step down; the last parent cannot.
  const { family: stepped } = await service.removeParent({ actorDid: "did:porch:parent", familyId: family._id, did: "did:porch:second" });
  assert.deepEqual(stepped.parentIdentityRefs, ["did:porch:parent"]);
  await assert.rejects(
    () => service.removeParent({ actorDid: "did:porch:parent", familyId: family._id, did: "did:porch:parent" }),
    (error) => error.code === "E_LAST_PARENT",
  );
});

test("ac-5: the fact resolution surfaces answer exactly what the family-grant chain consumes", async () => {
  const { service } = await seededFixture(["did:porch:parent", "did:porch:kid", "did:porch:outside"]);
  const { family } = await service.create({
    actorDid: "did:porch:parent",
    name: "River",
    memberIdentityRefs: ["did:porch:kid"],
  });
  // familyById resolves the familyRef of a family grant.
  assert.equal((await service.familyById(family._id)).name, "River");
  assert.equal(await service.familyById("fam_missing"), null);
  // familiesForMember: the governed members only — a parent of the family
  // is not implicitly a member (the envelope never applies implicitly).
  assert.deepEqual((await service.familiesForMember("did:porch:kid")).map((row) => row._id), [family._id]);
  assert.deepEqual(await service.familiesForMember("did:porch:parent"), []);
  assert.deepEqual(await service.familiesForMember("did:porch:outside"), []);
});

test("ac-5: the organizer read shows the caller's families — governed or governing", async () => {
  const { service } = await seededFixture(["did:porch:parent", "did:porch:kid", "did:porch:other"]);
  const { family } = await service.create({
    actorDid: "did:porch:parent",
    name: "River",
    memberIdentityRefs: ["did:porch:kid"],
  });
  const parentList = await service.list({ actorDid: "did:porch:parent" });
  assert.deepEqual(parentList.families.map((row) => row._id), [family._id]);
  const kidList = await service.list({ actorDid: "did:porch:kid" });
  assert.deepEqual(kidList.families.map((row) => row._id), [family._id]);
  const otherList = await service.list({ actorDid: "did:porch:other" });
  assert.deepEqual(otherList.families, []);
});
