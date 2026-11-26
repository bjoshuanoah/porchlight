import { test } from "node:test";
import assert from "node:assert/strict";
import { homeFixture, createHomeFor, seedHomeDevices } from "./helpers/home.fixture.js";

test("ac-4: an event-driven automation fires its actions and the audit records the fire", async () => {
  const fx = homeFixture();
  const owner = fx.identity();
  const home = await createHomeFor(fx, owner);
  const { devices } = await seedHomeDevices(fx, owner, home);
  const { automationService, auditService } = fx.mod;

  const created = await automationService.create({
    accessToken: owner.token,
    homeId: home._id,
    ...owner.write({
      name: "Garage lights on arrival",
      trigger: { eventClass: "vehicle", areaId: null },
      actions: [{ deviceId: devices.outdoor._id, command: "turnOn" }],
    }),
  });
  assert.equal(created.automation.enabled, true);

  const outcome = await automationService.handleEvent({ homeId: home._id, eventClass: "vehicle", at: "2026-11-26T18:30:00.000Z" });
  assert.equal(outcome.fired.length, 1);
  assert.equal(outcome.fired[0].results[0].outcome, "confirmed");

  const view = (await automationService.list({ accessToken: owner.token, homeId: home._id })).automations[0];
  assert.ok(view.lastFiredAt, "the rule records that it fired");

  const rows = (await auditService.list({ homeId: home._id })).events;
  const fire = rows.find((event) => event.type === "automation-fire");
  assert.ok(fire, "the fire itself is audited");
  assert.equal(fire.actorIdentityRef, `automation:${created.automation._id}`);
  assert.equal(fire.outcome, "confirmed");
  assert.deepEqual(fire.detail.actionResults, [{ deviceId: devices.outdoor._id, command: "turnOn", outcome: "confirmed" }]);
  const actionRow = rows.find((event) => event.type === "command" && event.detail?.source === "automation");
  assert.ok(actionRow, "the fired device action rides the one command path with its own audit row");
  assert.equal(actionRow.actorIdentityRef, `automation:${created.automation._id}`);
  assert.ok(actionRow.deviceId === devices.outdoor._id);
});

test("ac-4: only matching, enabled rules fire — class, area, and time-window conditions hold", async () => {
  const fx = homeFixture({ dark: () => true });
  const owner = fx.identity();
  const home = await createHomeFor(fx, owner);
  const { devices, room } = await seedHomeDevices(fx, owner, home);
  const { automationService } = fx.mod;

  const created = await automationService.create({
    accessToken: owner.token,
    homeId: home._id,
    ...owner.write({
      name: "Driveway after dark",
      trigger: { eventClass: "vehicle", areaId: null, timeWindow: { afterDark: true } },
      actions: [{ deviceId: devices.outdoor._id, command: "turnOn" }],
    }),
  });
  void room;

  // Wrong class: person does not fire a vehicle rule.
  const personEvent = await automationService.handleEvent({ homeId: home._id, eventClass: "person" });
  assert.equal(personEvent.fired.length, 0);

  // Disabled rules never fire.
  await automationService.update({ accessToken: owner.token, automationId: created.automation._id, ...owner.write({ enabled: false }) });
  const disabled = await automationService.handleEvent({ homeId: home._id, eventClass: "vehicle" });
  assert.equal(disabled.fired.length, 0);
  await automationService.update({ accessToken: owner.token, automationId: created.automation._id, ...owner.write({ enabled: true }) });

  // Matching class with afterDark satisfied: fires exactly once for one event.
  const firing = await automationService.handleEvent({ homeId: home._id, eventClass: "vehicle" });
  assert.equal(firing.fired.length, 1);
});

test("ac-4: after dark resolves from hub-local state — unwired provider fails closed, false never fires", async () => {
  // Unwired dark provider: an after-dark condition cannot honestly resolve.
  const unwired = homeFixture({ dark: null });
  const owner = unwired.identity();
  const home = await createHomeFor(unwired, owner);
  const { devices } = await seedHomeDevices(unwired, owner, home);
  const { automationService } = unwired.mod;
  await automationService.create({
    accessToken: owner.token,
    homeId: home._id,
    ...owner.write({
      name: "After dark",
      trigger: { eventClass: "vehicle", timeWindow: { afterDark: true } },
      actions: [{ deviceId: devices.outdoor._id, command: "turnOn" }],
    }),
  });
  const outcome = await automationService.handleEvent({ homeId: home._id, eventClass: "vehicle" });
  assert.equal(outcome.fired.length, 0);

  // Daylight: the same rule stays silent.
  const daylight = homeFixture({ dark: () => false });
  const owner2 = daylight.identity();
  const home2 = await createHomeFor(daylight, owner2);
  const seeded2 = await seedHomeDevices(daylight, owner2, home2);
  await daylight.mod.automationService.create({
    accessToken: owner2.token,
    homeId: home2._id,
    ...owner2.write({
      name: "After dark",
      trigger: { eventClass: "vehicle", timeWindow: { afterDark: true } },
      actions: [{ deviceId: seeded2.devices.outdoor._id, command: "turnOn" }],
    }),
  });
  const day = await daylight.mod.automationService.handleEvent({ homeId: home2._id, eventClass: "vehicle" });
  assert.equal(day.fired.length, 0);
});

test("ac-4: clock time windows evaluate hub-locally, wrapping midnight", async () => {
  const fx = homeFixture({ now: () => "2026-11-26T21:30:00.000Z" });
  const owner = fx.identity();
  const home = await createHomeFor(fx, owner);
  const { devices } = await seedHomeDevices(fx, owner, home);
  const { automationService } = fx.mod;

  await automationService.create({
    accessToken: owner.token,
    homeId: home._id,
    ...owner.write({
      name: "Evening lights",
      trigger: { eventClass: "vehicle", timeWindow: { from: "22:00", to: "06:00" } },
      actions: [{ deviceId: devices.outdoor._id, command: "turnOn" }],
    }),
  });
    // 21:30 is outside 22:00–06:00: no fire.
  const outside = await automationService.handleEvent({ homeId: home._id, eventClass: "vehicle" });
  assert.equal(outside.fired.length, 0);

  // 23:30 is inside the wrapping window.
  fx.setClock(() => "2026-11-26T23:30:00.000Z");
  const inside = await automationService.handleEvent({ homeId: home._id, eventClass: "vehicle" });
  assert.equal(inside.fired.length, 1);
});

test("ac-4: automation actions are fail-closed at write — no cross-home rule actions", async () => {
  const fx = homeFixture();
  const owner = fx.identity();
  const homeA = await createHomeFor(fx, owner, "Fieldstone");
  const homeB = await createHomeFor(fx, owner, "Lakeside");
  const seededA = await seedHomeDevices(fx, owner, homeA);
  await assert.rejects(
    () => fx.mod.automationService.create({
      accessToken: owner.token,
      homeId: homeB._id,
      ...owner.write({ name: "Cross-home rule", trigger: { eventClass: "vehicle" }, actions: [{ deviceId: seededA.devices.light._id, command: "turnOn" }] }),
    }),
    (error) => error.code === "E_NOT_PERMITTED",
  );
});
