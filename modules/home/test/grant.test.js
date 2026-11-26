/**
 * Grant tests (PORCH-138, PRD 1 / TS 1 of the Porchlight Home initiative).
 * The grant-to-existing-identity flow (ac-1), the three V1 access classes
 * with the family grant's parent distributions (ac-5), and the property
 * audit trail's grant-side rows. Runs the REAL services over an in-memory
 * store with device-signed writes exercised literally.
 *
 * Family facts ride the fixture's identity-plane stand-in through exactly
 * the callbacks the hub wiring injects — the home module never imports
 * identity (the boundary check proves it).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { homeFixture, createHomeFor, seedHomeDevices } from "./helpers/home.fixture.js";
import { ACCESS_CLASSES, withinEnvelope } from "../src/services/scopes.js";

const CHECKOUT = "2030-01-01T10:00:00.000Z";

function grantBody(body) {
  return body;
}

test("ac-1: the owner grants an existing identity selected device/scene/area controls from the Access surface; the grant stores its scopes and expiry", async () => {
  const fx = homeFixture();
  const owner = fx.identity();
  const visitor = fx.identity("did:porch:visitor");
  fx.registerIdentityRow(visitor.did, "June River");
  const home = await createHomeFor(fx, owner, "Fieldstone");
  const { porch, devices } = await seedHomeDevices(fx, owner, home);
  const scene = (await fx.mod.sceneService.create({
    accessToken: owner.token,
    homeId: home._id,
    ...owner.write({ name: "Movie night", actions: [{ deviceId: devices.light._id, command: "turnOn" }] }),
  })).scene;

  const { grant } = await fx.mod.grantService.create({
    accessToken: owner.token,
    homeId: home._id,
    ...owner.write(grantBody({
      granteeDid: visitor.did,
      scopes: [
        { resourceType: "device", resourceRef: devices.light._id, verbs: ["view", "control"] },
        { resourceType: "scene", resourceRef: scene._id, verbs: ["control"] },
        { resourceType: "area", resourceRef: porch._id, verbs: ["view", "control"] },
      ],
      expiresAt: CHECKOUT,
    })),
  });
  assert.equal(grant.accessClass, ACCESS_CLASSES.INDIVIDUAL_GRANT);
  assert.equal(grant.granteeDid, visitor.did);
  assert.equal(grant.expiresAt, CHECKOUT);
  assert.deepEqual(grant.scopes.map((scope) => scope.resourceType).sort(), ["area", "device", "scene"]);
  assert.equal(grant.createdFor, "June River");
  // The grant doc of record carries what was granted — scopes + expiry.
  const stored = await fx.collection("grants").findOne({ _id: grant._id });
  assert.equal(stored.expiresAt, CHECKOUT);
  assert.equal(stored.createdBy, owner.did);

  // Refusals ride plain language: an unknown identity is never minted (no
  // new identity exists anywhere), and out-of-home resources fail closed.
  await assert.rejects(
    () => fx.mod.grantService.create({
      accessToken: owner.token,
      homeId: home._id,
      ...owner.write(grantBody({
        granteeDid: "did:porch:stranger",
        scopes: [{ resourceType: "device", resourceRef: devices.light._id, verbs: ["view"] }],
        expiresAt: CHECKOUT,
      })),
    }),
    (error) => error.code === "E_GRANTEE_UNKNOWN" && /ride the Porchlight identity/.test(error.message),
  );
  assert.equal(fx.listFamilyRows().length, 0);
  // A scope naming a resource outside THIS home fails closed.
  await assert.rejects(
    () => fx.mod.grantService.create({
      accessToken: owner.token,
      homeId: home._id,
      ...owner.write(grantBody({
        granteeDid: visitor.did,
        scopes: [{ resourceType: "area", resourceRef: "area_missing", verbs: ["view"] }],
        expiresAt: CHECKOUT,
      })),
    }),
    (error) => error.code === "E_VALIDATION" && /only name resources of the home/.test(error.message),
  );
});

test("ac-1: the grantee's existing identity sees exactly the granted controls on next read — nothing more", async () => {
  const fx = homeFixture();
  const owner = fx.identity();
  const visitor = fx.identity("did:porch:visitor");
  fx.registerIdentityRow(visitor.did);
  const home = await createHomeFor(fx, owner, "Fieldstone");
  const { porch, devices } = await seedHomeDevices(fx, owner, home);

  await fx.mod.grantService.create({
    accessToken: owner.token,
    homeId: home._id,
    ...owner.write(grantBody({
      granteeDid: visitor.did,
      scopes: [{ resourceType: "device", resourceRef: devices.light._id, verbs: ["view", "control"] }],
      expiresAt: CHECKOUT,
    })),
  });

  // The granted home appears in the visitor's one read of /homes — a visitor
  // opens Porchlight normally.
  const { homes } = await fx.mod.homeService.list({ accessToken: visitor.token });
  assert.deepEqual(homes.map((row) => row.name), ["Fieldstone"]);
  assert.equal(homes[0].access.accessClass, ACCESS_CLASSES.INDIVIDUAL_GRANT);

  // Device reads: exactly the granted slice (the living lamp and nothing
  // else); the grouping surface shows the area that carries it.
  const { devices: visibleDevices } = await fx.mod.deviceService.list({ accessToken: visitor.token, homeId: home._id });
  assert.deepEqual(visibleDevices.map((device) => device.name), ["Living lamp"]);
  const { areas } = await fx.mod.areaService.list({ accessToken: visitor.token, homeId: home._id });
  assert.deepEqual(areas.map((area) => area.name), ["Living room"]);
  const { devices: memberDevices } = await fx.mod.deviceService.list({ accessToken: owner.token, homeId: home._id });
  assert.equal(memberDevices.length, 2);

  // A granted device reads; an ungranted one refuses with plain language.
  await fx.mod.deviceService.get({ accessToken: visitor.token, homeId: home._id, deviceId: devices.light._id });
  await assert.rejects(
    () => fx.mod.deviceService.get({ accessToken: visitor.token, homeId: home._id, deviceId: devices.outdoor._id }),
    (error) => error.code === "E_NOT_PERMITTED" && /access you were granted/.test(error.message),
  );

  // Automation surfaces never ride a grant.
  const { automations } = await fx.mod.automationService.list({ accessToken: visitor.token, homeId: home._id });
  assert.deepEqual(automations, []);

  // Management surfaces refuse the visitor plainly.
  await assert.rejects(
    () => fx.mod.deviceService.register({
      accessToken: visitor.token,
      homeId: home._id,
      ...visitor.write({ name: "X", areaId: porch._id, capabilities: ["switch"], adapter: { name: "test" } }),
    }),
    (error) => error.code === "E_NOT_PERMITTED" && /belongs to the home's members/.test(error.message),
  );
});

test("ac-1: the property audit trail is a member surface through the REST transport — a visit grant's read refuses plainly", async () => {
  const fx = homeFixture();
  const owner = fx.identity();
  const visitor = fx.identity("did:porch:visitor");
  fx.registerIdentityRow(visitor.did);
  const home = await createHomeFor(fx, owner, "Fieldstone");
  await seedHomeDevices(fx, owner, home);
  await fx.mod.grantService.create({
    accessToken: owner.token,
    homeId: home._id,
    ...owner.write(grantBody({
      granteeDid: visitor.did,
      scopes: [{ resourceType: "device", resourceRef: (await fx.mod.deviceService.list({ accessToken: owner.token, homeId: home._id })).devices[0]._id, verbs: ["view"] }],
      expiresAt: CHECKOUT,
    })),
  });

  const ownerRead = await readControllerPage(fx.mod.controllers.home, owner.token, home._id);
  assert.ok(ownerRead.status === 200 || ownerRead.status === undefined); // member read passes
  const visitorRead = await readControllerPage(fx.mod.controllers.home, visitor.token, home._id);
  assert.equal(visitorRead.status, 403);
  assert.equal(visitorRead.body.code, "E_NOT_PERMITTED");
});

test("ac-1: a granted control exercises the confirmed-state command path; an ungranted one denies with a refused audit row", async () => {
  const fx = homeFixture();
  const owner = fx.identity();
  const visitor = fx.identity("did:porch:visitor");
  fx.registerIdentityRow(visitor.did);
  const home = await createHomeFor(fx, owner, "Fieldstone");
  const { porch, devices } = await seedHomeDevices(fx, owner, home);
  await fx.mod.grantService.create({
    accessToken: owner.token,
    homeId: home._id,
    ...owner.write(grantBody({
      granteeDid: visitor.did,
      scopes: [{ resourceType: "device", resourceRef: devices.light._id, verbs: ["view", "control"] }],
      expiresAt: CHECKOUT,
    })),
  });

  const confirmed = await fx.mod.deviceService.command({
    accessToken: visitor.token,
    homeId: home._id,
    deviceId: devices.light._id,
    ...visitor.write({ command: "turnOn" }),
  });
  assert.equal(confirmed.outcome, "confirmed");
  assert.equal(confirmed.device.lastKnownState.on, true); // read-back, never optimistic

  await assert.rejects(
    () => fx.mod.deviceService.command({
      accessToken: visitor.token,
      homeId: home._id,
      deviceId: devices.outdoor._id,
      ...visitor.write({ command: "turnOn" }),
    }),
    (error) => error.code === "E_NOT_PERMITTED",
  );
  // The denied command lands the audit row: who, which home, which device, outcome.
  const audit = await fx.mod.auditService.list({ homeId: home._id });
  const denied = audit.events.find(
    (event) => event.type === "command" && event.actorIdentityRef === visitor.did && event.deviceId === devices.outdoor._id,
  );
  assert.ok(denied);
  assert.equal(denied.outcome, "denied");

  // Area-scope coverage: granting the porch covers the porch light.
  await fx.mod.grantService.create({
    accessToken: owner.token,
    homeId: home._id,
    ...owner.write(grantBody({
      granteeDid: visitor.did,
      scopes: [{ resourceType: "area", resourceRef: porch._id, verbs: ["control"] }],
      expiresAt: CHECKOUT,
    })),
  });
  const second = await fx.mod.deviceService.command({
    accessToken: visitor.token,
    homeId: home._id,
    deviceId: devices.outdoor._id,
    ...visitor.write({ command: "turnOn" }),
  });
  assert.equal(second.outcome, "confirmed");
});

test("ac-1: expiry denies from the still-open session; revocation takes effect immediately, before the next command evaluates", async () => {
  const fx = homeFixture();
  const owner = fx.identity();
  const visitor = fx.identity("did:porch:visitor");
  fx.registerIdentityRow(visitor.did);
  const home = await createHomeFor(fx, owner, "Fieldstone");
  const { devices } = await seedHomeDevices(fx, owner, home);

  let clock = new Date("2029-12-31T00:00:00.000Z").toISOString();
  fx.setClock(() => clock);
  const { grant } = await fx.mod.grantService.create({
    accessToken: owner.token,
    homeId: home._id,
    ...owner.write(grantBody({
      granteeDid: visitor.did,
      scopes: [{ resourceType: "device", resourceRef: devices.light._id, verbs: ["view", "control"] }],
      expiresAt: CHECKOUT,
    })),
  });

  // Before checkout: the open dashboard still commands.
  const live = await fx.mod.deviceService.command({
    accessToken: visitor.token,
    homeId: home._id,
    deviceId: devices.light._id,
    ...visitor.write({ command: "turnOn" }),
  });
  assert.equal(live.outcome, "confirmed");

  // Past checkout: the SAME session's next read and command are denied —
  // enforcement re-evaluates state, no cached control pretends to work.
  clock = new Date(CHECKOUT).toISOString();
  const { homes } = await fx.mod.homeService.list({ accessToken: visitor.token });
  assert.deepEqual(homes, []);
  await assert.rejects(
    () => fx.mod.deviceService.command({
      accessToken: visitor.token,
      homeId: home._id,
      deviceId: devices.light._id,
      ...visitor.write({ command: "turnOff" }),
    }),
    (error) => error.code === "E_NOT_PERMITTED",
  );

  // Early revocation from an open session, mid-visit.
  clock = new Date("2029-12-31T12:00:00.000Z").toISOString();
  await fx.mod.grantService.revoke({
    accessToken: owner.token,
    grantId: grant._id,
    ...owner.write(grantBody({})),
  });
  await assert.rejects(
    () => fx.mod.deviceService.command({
      accessToken: visitor.token,
      homeId: home._id,
      deviceId: devices.light._id,
      ...visitor.write({ command: "turnOn" }),
    }),
    (error) => error.code === "E_NOT_PERMITTED",
  );
  await assert.rejects(
    () => fx.mod.grantService.revoke({
      accessToken: owner.token,
      grantId: grant._id,
      ...owner.write(grantBody({})),
    }),
    (error) => error.code === "E_GRANT_ALREADY_REVOKED",
  );

  // The trail records who granted, who revoked, and the denied commands.
  const audit = await fx.mod.auditService.list({ homeId: home._id });
  const types = audit.events.map((event) => event.type);
  assert.ok(types.includes("grant"));
  assert.ok(types.includes("revoke"));
  assert.ok(types.includes("command"));
  const grantRow = audit.events.find((event) => event.type === "grant");
  assert.equal(grantRow.actorIdentityRef, owner.did);
  assert.deepEqual(grantRow.detail.scopes, [{ resourceType: "device", resourceRef: devices.light._id, verbs: ["view", "control"] }]);
  assert.equal(grantRow.detail.expiresAt, CHECKOUT);
  const revokeRow = audit.events.find((event) => event.type === "revoke");
  assert.equal(revokeRow.actorIdentityRef, owner.did);
  assert.equal(revokeRow.detail.grantId, grant._id);
});

test("ac-5: membership wins the resolution — exactly one of the three classes applies, no fourth, no parallel path", async () => {
  const fx = homeFixture();
  const owner = fx.identity();
  const member = fx.identity("did:porch:member");
  const visitor = fx.identity("did:porch:visitor");
  fx.registerIdentityRow(member.did);
  fx.registerIdentityRow(visitor.did);
  const home = await createHomeFor(fx, owner, "Fieldstone");
  const { devices } = await seedHomeDevices(fx, owner, home);

  // The added member's membership is the owner-membership class even with a
  // redundant individual grant floating in the same home.
  await fx.collection("home_members").insertOne({
    _id: `hm_${crypto.randomUUID()}`,
    homeId: home._id,
    did: member.did,
    role: "member",
    addedBy: owner.did,
    createdAt: fx.now(),
  });
  await fx.mod.grantService.create({
    accessToken: owner.token,
    homeId: home._id,
    ...owner.write(grantBody({
      granteeDid: member.did,
      scopes: [{ resourceType: "device", resourceRef: devices.light._id, verbs: ["view"] }],
      expiresAt: CHECKOUT,
    })),
  });
  // The visitor holds exactly one live individual grant in this home.
  await fx.mod.grantService.create({
    accessToken: owner.token,
    homeId: home._id,
    ...owner.write(grantBody({
      granteeDid: visitor.did,
      scopes: [{ resourceType: "device", resourceRef: devices.outdoor._id, verbs: ["view", "control"] }],
      expiresAt: CHECKOUT,
    })),
  });
  const memberAccess = await fx.mod.homeService.authorizeMember({ did: member.did, homeId: home._id });
  assert.equal(memberAccess.access.accessClass, ACCESS_CLASSES.OWNERSHIP);
  assert.equal(memberAccess.access.scopes, null); // membership reads the full member surface
  assert.equal(memberAccess.role, "member");

  const visitorAccess = await fx.mod.homeService.authorizeMember({ did: visitor.did, homeId: home._id });
  assert.equal(visitorAccess.access.accessClass, ACCESS_CLASSES.INDIVIDUAL_GRANT);

  const ownerAccess = await fx.mod.homeService.authorizeMember({ did: owner.did, homeId: home._id });
  assert.equal(ownerAccess.access.accessClass, ACCESS_CLASSES.OWNERSHIP);
  assert.equal(ownerAccess.role, "owner");
});

test("ac-5: the family grant resolves the subset intersection — each member reaches exactly their parent distribution, never the envelope implicitly", async () => {
  const fx = homeFixture();
  const owner = fx.identity();
  fx.registerIdentityRow("did:porch:parent", "Sam Parent");
  fx.registerIdentityRow("did:porch:kid-a", "Kid A");
  fx.registerIdentityRow("did:porch:kid-b", "Kid B");
  const home = await createHomeFor(fx, owner, "Fieldstone");
  const { porch, devices } = await seedHomeDevices(fx, owner, home);

  // The host (the home's owner of record) grants the family an envelope over
  // the porch area + the living lamp device; the parents distribute
  // different scopes to two members.
  const family = fx.addFamily({
    _id: "fam_visit",
    name: "River",
    parentIdentityRefs: ["did:porch:parent"],
    memberIdentityRefs: ["did:porch:kid-a", "did:porch:kid-b"],
    createdBy: "did:porch:parent",
    createdAt: fx.now(),
  });
  const { grant } = await fx.mod.grantService.create({
    accessToken: owner.token,
    homeId: home._id,
    ...owner.write(grantBody({
      familyId: family._id,
      scopes: [
        { resourceType: "area", resourceRef: porch._id, verbs: ["view", "control"] },
        { resourceType: "device", resourceRef: devices.light._id, verbs: ["view", "control"] },
      ],
      expiresAt: CHECKOUT,
    })),
  });
  assert.equal(grant.accessClass, ACCESS_CLASSES.FAMILY_GRANT);
  assert.equal(grant.familyRef, family._id);

  const parentIdentity = fx.identity("did:porch:parent");
  const parentToken = parentIdentity.token;
  const parentWrite = parentIdentity.write;
  await fx.mod.grantService.distribute({
    accessToken: parentToken,
    grantId: grant._id,
    ...parentWrite(grantBody({
      memberIdentityRef: "did:porch:kid-a",
      scopes: [{ resourceType: "area", resourceRef: porch._id, verbs: ["control"] }],
    })),
  });

  // The parent's token resolves as a family grant for the member.
  const kidA = fx.identity("did:porch:kid-a");
  const kidAccess = await fx.mod.homeService.authorizeMember({ did: kidA.did, homeId: home._id });
  assert.equal(kidAccess.access.accessClass, ACCESS_CLASSES.FAMILY_GRANT);
  assert.deepEqual(kidAccess.access.scopes, [{ resourceType: "area", resourceRef: porch._id, verbs: ["control"] }]);

  // Exactly the distribution: the porch light commands, the living lamp —
  // inside the envelope but NOT in kid-a's distribution — denies.
  const porchCommand = await fx.mod.deviceService.command({
    accessToken: kidA.token,
    homeId: home._id,
    deviceId: devices.outdoor._id,
    ...kidA.write({ command: "turnOn" }),
  });
  assert.equal(porchCommand.outcome, "confirmed");
  await assert.rejects(
    () => fx.mod.deviceService.command({
      accessToken: kidA.token,
      homeId: home._id,
      deviceId: devices.light._id,
      ...kidA.write({ command: "turnOn" }),
    }),
    (error) => error.code === "E_NOT_PERMITTED" && /access you were granted/.test(error.message),
  );

  // A member WITHOUT a distribution reaches nothing: the envelope never
  // applies implicitly (fail closed).
  const kidB = fx.identity("did:porch:kid-b");
  await assert.rejects(
    () => fx.mod.homeService.authorizeMember({ did: kidB.did, homeId: home._id }),
    (error) => error.code === "E_NOT_PERMITTED",
  );

  // Only the family's parents distribute; a non-parent (even a member)
  // refuses plainly; an over-envelope distribution fails closed in plain
  // language; a non-member of the family refuses too.
  await assert.rejects(
    () => fx.mod.grantService.distribute({
      accessToken: kidA.token,
      grantId: grant._id,
      ...kidA.write(grantBody({ memberIdentityRef: "did:porch:kid-b", scopes: [] })),
    }),
    (error) => error.code === "E_NOT_PERMITTED",
  );
  await assert.rejects(
    () => fx.mod.grantService.distribute({
      accessToken: parentToken,
      grantId: grant._id,
      ...parentWrite(grantBody({
        memberIdentityRef: "did:porch:kid-b",
        scopes: [
          { resourceType: "area", resourceRef: porch._id, verbs: ["view", "control"] },
          { resourceType: "device", resourceRef: devices.outdoor._id, verbs: ["control"] },
        ],
      })),
    }),
    (error) => error.code === "E_ENVELOPE_EXCEEDED" && /beyond what the host granted/.test(error.message),
  );
  await assert.rejects(
    () => fx.mod.grantService.distribute({
      accessToken: parentToken,
      grantId: grant._id,
      ...parentWrite(grantBody({ memberIdentityRef: "did:porch:stranger", scopes: [] })),
    }),
    (error) => error.code === "E_FAMILY_MEMBER_UNKNOWN",
  );

  // The family-distribute audit row carries the ACTING PARENT as actor.
  const audit = await fx.mod.auditService.list({ homeId: home._id });
  const distributeRow = audit.events.find((event) => event.type === "family-distribute");
  assert.ok(distributeRow);
  assert.equal(distributeRow.actorIdentityRef, "did:porch:parent");
  assert.equal(distributeRow.detail.memberIdentityRef, "did:porch:kid-a");
  assert.equal(distributeRow.detail.familyRef, family._id);
  const grantRow = audit.events.find((event) => event.type === "grant");
  assert.equal(grantRow.actorIdentityRef, owner.did); // the host-envelope action
});

test("ac-5: checkout or early revocation kills every member's access from open sessions — including every distribution", async () => {
  const fx = homeFixture();
  const owner = fx.identity();
  fx.registerIdentityRow("did:porch:parent", "Sam Parent");
  fx.registerIdentityRow("did:porch:kid-a", "Kid A");
  const home = await createHomeFor(fx, owner, "Fieldstone");
  const { devices } = await seedHomeDevices(fx, owner, home);
  const family = fx.addFamily({
    _id: "fam_visit",
    name: "River",
    parentIdentityRefs: ["did:porch:parent"],
    memberIdentityRefs: ["did:porch:kid-a"],
    createdBy: "did:porch:parent",
    createdAt: fx.now(),
  });
  const parent = fx.identity("did:porch:parent");
  const kidA = fx.identity("did:porch:kid-a");
  const { grant } = await fx.mod.grantService.create({
    accessToken: owner.token,
    homeId: home._id,
    ...owner.write(grantBody({
      familyId: family._id,
      scopes: [{ resourceType: "device", resourceRef: devices.light._id, verbs: ["view", "control"] }],
      expiresAt: CHECKOUT,
    })),
  });
  await fx.mod.grantService.distribute({
    accessToken: parent.token,
    grantId: grant._id,
    ...parent.write(grantBody({
      memberIdentityRef: kidA.did,
      scopes: [{ resourceType: "device", resourceRef: devices.light._id, verbs: ["control"] }],
    })),
  });

  // Live: the member's granted control works through the distribution.
  const live = await fx.mod.deviceService.command({
    accessToken: kidA.token,
    homeId: home._id,
    deviceId: devices.light._id,
    ...kidA.write({ command: "turnOn" }),
  });
  assert.equal(live.outcome, "confirmed");

  // Early revocation: the WHOLE family dies — the member's next command from
  // the already-open session denies, and their /homes read shows nothing.
  await fx.mod.grantService.revoke({
    accessToken: owner.token,
    grantId: grant._id,
    ...owner.write(grantBody({})),
  });
  await assert.rejects(
    () => fx.mod.deviceService.command({
      accessToken: kidA.token,
      homeId: home._id,
      deviceId: devices.light._id,
      ...kidA.write({ command: "turnOff" }),
    }),
    (error) => error.code === "E_NOT_PERMITTED",
  );
  const { homes } = await fx.mod.homeService.list({ accessToken: kidA.token });
  assert.deepEqual(homes, []);

  // Late checkout by expiry behaves identically (fresher grant).
  const { grant: grant2 } = await fx.mod.grantService.create({
    accessToken: owner.token,
    homeId: home._id,
    ...owner.write(grantBody({
      familyId: family._id,
      scopes: [{ resourceType: "device", resourceRef: devices.light._id, verbs: ["view", "control"] }],
      expiresAt: "2030-01-01T23:00:00.000Z",
    })),
  });
  await fx.mod.grantService.distribute({
    accessToken: parent.token,
    grantId: grant2._id,
    ...parent.write(grantBody({
      memberIdentityRef: kidA.did,
      scopes: [{ resourceType: "device", resourceRef: devices.light._id, verbs: ["control"] }],
    })),
  });
  const clock = new Date("2030-01-01T23:00:00.001Z").toISOString();
  fx.setClock(() => clock);
  await assert.rejects(
    () => fx.mod.deviceService.command({
      accessToken: kidA.token,
      homeId: home._id,
      deviceId: devices.light._id,
      ...kidA.write({ command: "turnOn" }),
    }),
    (error) => error.code === "E_NOT_PERMITTED",
  );

  // The revoke row landed once per grant with the host as actor.
  const audit = await fx.mod.auditService.list({ homeId: home._id });
  const revokeRows = audit.events.filter((event) => event.type === "revoke");
  assert.equal(revokeRows.length, 1);
  assert.equal(revokeRows[0].actorIdentityRef, owner.did);
});

test("ac-5: the grant list is the owner's Access surface of record with live status", async () => {
  const fx = homeFixture();
  const owner = fx.identity();
  const visitor = fx.identity("did:porch:visitor");
  fx.registerIdentityRow(visitor.did);
  const home = await createHomeFor(fx, owner, "Fieldstone");
  const { devices } = await seedHomeDevices(fx, owner, home);
  const { grant } = await fx.mod.grantService.create({
    accessToken: owner.token,
    homeId: home._id,
    ...owner.write(grantBody({
      granteeDid: visitor.did,
      scopes: [{ resourceType: "device", resourceRef: devices.light._id, verbs: ["view"] }],
      expiresAt: CHECKOUT,
    })),
  });

  const { grants } = await fx.mod.grantService.list({ accessToken: owner.token, homeId: home._id });
  assert.equal(grants.length, 1);
  assert.equal(grants[0].status, "live");
  assert.equal(grants[0].grantId ?? grants[0]._id, grant._id);
  assert.equal(grants[0].createdFor, visitor.did.slice("did:porch:".length)); // fixture displayName default

  // Non-owners read nothing off the Access surface.
  const visitorToken = visitor.token;
  await assert.rejects(
    () => fx.mod.grantService.list({ accessToken: visitorToken, homeId: home._id }),
    (error) => error.code === "E_NOT_PERMITTED",
  );
});

test("ac-5: envelope-invariant helpers fail closed — withinEnvelope mirrors the write-path rule", async () => {
  const envelope = [{ resourceType: "device", resourceRef: "dev_1", verbs: ["view"] }];
  assert.equal(withinEnvelope(envelope, [{ resourceType: "device", resourceRef: "dev_1", verbs: ["view"] }]), true);
  assert.equal(withinEnvelope(envelope, [{ resourceType: "device", resourceRef: "dev_1", verbs: ["view", "control"] }]), false);
  assert.equal(withinEnvelope(envelope, [{ resourceType: "device", resourceRef: "dev_2", verbs: ["view"] }]), false);
});

/** Drive the controller's audit read the way the HTTP transport does. */
function readControllerPage(controller, token, homeId) {
  return new Promise((resolve, reject) => {
    const res = {
      statusCode: 200,
      status(code) {
        this.statusCode = code;
        return this;
      },
      json(payload) {
        resolve({ status: this.statusCode, body: payload });
      },
    };
    controller
      .auditList({ headers: { authorization: `Bearer ${token}` }, params: { homeId }, query: {} }, res)
      .catch(reject);
  });
}
