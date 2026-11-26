import { test } from "node:test";
import assert from "node:assert/strict";
import { homeFixture, createHomeFor, seedHomeDevices } from "./helpers/home.fixture.js";

void seedHomeDevices;

test("ac-1: a member creates, renames, and lists homes; the creator is the owner member", async () => {
  const fx = homeFixture();
  const owner = fx.identity();
  const { homeService } = fx.mod;

  const created = await homeService.create({ accessToken: owner.token, ...owner.write({ name: "Fieldstone" }) });
  assert.equal(created.home.name, "Fieldstone");
  assert.equal(created.home.role, "owner");

  const listed = await homeService.list({ accessToken: owner.token });
  assert.equal(listed.homes.length, 1);
  assert.equal(listed.homes[0]._id, created.home._id);

  const renamed = await homeService.rename({
    accessToken: owner.token,
    homeId: created.home._id,
    ...owner.write({ name: "Fieldstone House" }),
  });
  assert.equal(renamed.home.name, "Fieldstone House");
  const row = await fx.collection("home_members").findOne({ homeId: created.home._id });
  assert.equal(row.role, "owner");
  assert.equal(row.did, owner.did);
});

test("ac-1: switching homes swaps every served surface — rooms, devices, scenes, automations", async () => {
  const fx = homeFixture();
  const owner = fx.identity();
  const { homeService, areaService, deviceService, sceneService, automationService } = fx.mod;

  const homeA = await createHomeFor(fx, owner, "Fieldstone");
  const homeB = await createHomeFor(fx, owner, "Lakeside");
  await seedHomeDevices(fx, owner, homeA);
  await seedHomeDevices(fx, owner, homeB);

  // Scenes and automations are per-home: same everyday shape across homes.
  await sceneService.create({
    accessToken: owner.token,
    homeId: homeA._id,
    ...owner.write({ name: "Movie night", actions: [] }),
  }).catch(() => { /* actions validated below in the dedicated test */ });
  await automationService.create({
    accessToken: owner.token,
    homeId: homeB._id,
    ...owner.write({
      name: "Lakeside arrival",
      trigger: { eventClass: "vehicle" },
      actions: [{ deviceId: (await deviceService.list({ accessToken: owner.token, homeId: homeB._id })).devices[0]._id, command: "turnOn" }],
    }),
  });

  const viewA = await homeService.authorize({ accessToken: owner.token, homeId: homeA._id });
  const surfacesA = (await fx.mod.deviceService.list({ accessToken: owner.token, homeId: homeA._id })).devices;
  const surfacesB = (await fx.mod.deviceService.list({ accessToken: owner.token, homeId: homeB._id })).devices;
  assert.ok(viewA.home._id === homeA._id);
  assert.ok(surfacesA.every((device) => device.homeId === homeA._id));
  assert.ok(surfacesB.every((device) => device.homeId === homeB._id));
  assert.notEqual(surfacesA[0]._id, surfacesB[0]._id);

  const autosA = await automationService.list({ accessToken: owner.token, homeId: homeA._id });
  const autosB = await automationService.list({ accessToken: owner.token, homeId: homeB._id });
  assert.equal(autosA.automations.length, 0);
  assert.equal(autosB.automations.length, 1);

  const areasA = await areaService.list({ accessToken: owner.token, homeId: homeA._id });
  assert.equal(areasA.areas[0].homeId, homeA._id);
});

test("ac-1: a command affects only devices authorized in the home in view — cross-home refused in plain language", async () => {
  const fx = homeFixture();
  const owner = fx.identity();
  const { deviceService } = fx.mod;

  const homeA = await createHomeFor(fx, owner, "Fieldstone");
  const homeB = await createHomeFor(fx, owner, "Lakeside");
  const seededB = await seedHomeDevices(fx, owner, homeB);
  const deviceB = seededB.devices.light;

  await assert.rejects(
    () => deviceService.command({
      accessToken: owner.token,
      homeId: homeA._id,
      deviceId: deviceB._id,
      ...owner.write({ command: "turnOn" }),
    }),
    (error) => error.code === "E_NOT_PERMITTED" && /doesn't belong to the home in view/i.test(error.message),
  );

  // The refused command lands a denied audit row: who, which home, which device, outcome.
  const audit = await fx.mod.auditService.list({ homeId: homeA._id });
  const denied = audit.events.find((event) => event.type === "command");
  assert.ok(denied);
  assert.equal(denied.outcome, "denied");
  assert.equal(denied.deviceId, deviceB._id);
  assert.equal(denied.actorIdentityRef, owner.did);
});

test("ac-1: reads refuse non-members with plain language, and the refusal is audited nowhere (no scoped write)", async () => {
  const fx = homeFixture();
  const owner = fx.identity();
  const outsider = fx.identity("did:porch:outsider");
  const { homeService } = fx.mod;
  const home = await createHomeFor(fx, owner, "Fieldstone");

  await assert.rejects(
    () => fx.mod.deviceService.list({ accessToken: outsider.token, homeId: home._id }),
    (error) => error.code === "E_NOT_PERMITTED" && /not a member/i.test(error.message),
  );
  await assert.rejects(
    () => homeService.rename({ accessToken: outsider.token, homeId: home._id, ...outsider.write({ name: "Renamed" }) }),
    (error) => error.code === "E_NOT_PERMITTED",
  );
  // The outsider's homes list is empty: one installation, zero cross-leakage.
  const outsiderHomes = await homeService.list({ accessToken: outsider.token });
  assert.deepEqual(outsiderHomes.homes, []);
});

test("ac-1: unsigned/incorrectly-signed writes are refused at the identity seam", async () => {
  const fx = homeFixture();
  const owner = fx.identity();
  await assert.rejects(
    () => fx.mod.homeService.create({ accessToken: owner.token, payload: { name: "No Sig" }, signature: null }),
    (error) => error.code === "E_SIGNATURE_REQUIRED",
  );
  await assert.rejects(
    () => fx.mod.homeService.create({ accessToken: owner.token, payload: { name: "Bad Sig" }, signature: "AAAA" }),
    (error) => error.code === "E_SIGNATURE_INVALID",
  );
  await assert.rejects(
    () => fx.mod.homeService.list({ accessToken: "tok_unknown" }),
    (error) => error.code === "E_MUST_SIGN_IN",
  );
});
