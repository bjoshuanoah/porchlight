import { test } from "node:test";
import assert from "node:assert/strict";
import { homeFixture, createHomeFor, seedHomeDevices } from "./helpers/home.fixture.js";

test("ac-3: rooms and outdoor areas render as one ordered grouping surface", async () => {
  const fx = homeFixture();
  const owner = fx.identity();
  const home = await createHomeFor(fx, owner);
  const { room, porch } = await seedHomeDevices(fx, owner, home);
  const { areaService } = fx.mod;

  const areas = await areaService.list({ accessToken: owner.token, homeId: home._id });
  assert.equal(areas.areas.length, 2);
  assert.deepEqual(areas.areas.map((area) => [area.name, area.kind]), [
    ["Living room", "room"],
    ["Porch", "outdoor"],
  ]);

  // Rename + reorder through the same collection — one grouping surface.
  await areaService.update({ accessToken: owner.token, areaId: room._id, ...owner.write({ name: "Great room", order: 5 }) });
  await areaService.update({ accessToken: owner.token, areaId: porch._id, ...owner.write({ order: 1 }) });
  const reordered = await areaService.list({ accessToken: owner.token, homeId: home._id });
  assert.deepEqual(reordered.areas.map((area) => area.name), ["Porch", "Great room"]);
});

test("ac-3: devices carry their current state; the grouping covers rooms and outdoor areas alike", async () => {
  const fx = homeFixture();
  const owner = fx.identity();
  const home = await createHomeFor(fx, owner);
  const { devices } = await seedHomeDevices(fx, owner, home);
  const { deviceService } = fx.mod;

  await deviceService.command({ accessToken: owner.token, homeId: home._id, deviceId: devices.light._id, ...owner.write({ command: "turnOn" }) });
  const list = await deviceService.list({ accessToken: owner.token, homeId: home._id });
  const lamps = list.devices.filter((device) => device.name === "Living lamp");
  assert.equal(lamps.length, 1);
  assert.deepEqual(lamps[0].lastKnownState, { on: true });
  assert.ok(lamps[0].stateConfirmedAt);
  assert.equal(lamps[0].homeId, home._id);
  // Outdoor devices are ordinary members of the same one-collection grouping.
  assert.ok(list.devices.some((device) => device.name === "Porch light"));
});

test("ac-3: a physical change at the switch reflects and lands an audit row marked physical", async () => {
  const fx = homeFixture();
  const owner = fx.identity();
  const home = await createHomeFor(fx, owner);
  const { devices } = await seedHomeDevices(fx, owner, home);
  const lamp = devices.light;

  // The adapter's physical-state reporting path (someone flips a wall switch).
  const reported = await fx.mod.deviceService.reportState({ deviceId: lamp._id, state: { on: true }, source: "physical", at: "2026-11-26T10:00:00.000Z" });
  assert.deepEqual(reported.device.lastKnownState, { on: true });
  assert.equal(reported.device.stateConfirmedAt, "2026-11-26T10:00:00.000Z");
  assert.equal(reported.device.lastCommandResult, null, "a physical flip is not a command outcome");

  const row = (await fx.mod.auditService.list({ homeId: home._id })).events.find((event) => event.type === "state-source-change");
  assert.ok(row);
  assert.equal(row.detail.source, "physical");
  assert.equal(row.deviceId, lamp._id);
  assert.equal(row.outcome, "confirmed");
});

test("ac-3: hub-side read-back refresh within the state-refresh window; stale read explains itself", async () => {
  const fx = homeFixture();
  const owner = fx.identity();
  const home = await createHomeFor(fx, owner);
  const { devices } = await seedHomeDevices(fx, owner, home);

  fx.adapter.state = { on: true };
  const fresh = await fx.mod.deviceService.readState({ accessToken: owner.token, homeId: home._id, deviceId: devices.light._id });
  assert.equal(fresh.read.outcome, "confirmed");
  assert.deepEqual(fresh.device.lastKnownState, { on: true });

  fx.adapter.online = false;
  fx.adapter.state = { on: false }; // the wall switch moved while offline
  const stale = await fx.mod.deviceService.readState({ accessToken: owner.token, homeId: home._id, deviceId: devices.light._id });
  assert.equal(stale.read.outcome, "failed");
  assert.ok(stale.read.reason);
  assert.equal(stale.device.stale, true, "the last-known state renders labeled stale when the device is unreachable");
  assert.deepEqual(stale.device.lastKnownState, { on: true }, "stale keeps the last-KNOWN state, not a hopeful one");
});

test("ac-3: an unreachable device's last-known state is served labeled stale with the failure reason", async () => {
  const fx = homeFixture();
  const owner = fx.identity();
  const home = await createHomeFor(fx, owner);
  const { devices } = await seedHomeDevices(fx, owner, home);
  await fx.mod.deviceService.command({ accessToken: owner.token, homeId: home._id, deviceId: devices.light._id, ...owner.write({ command: "turnOn" }) });
  fx.adapter.online = false;
  await fx.mod.deviceService.readState({ accessToken: owner.token, homeId: home._id, deviceId: devices.light._id }).catch(() => null);
  const list = await fx.mod.deviceService.list({ accessToken: owner.token, homeId: home._id });
  const lamp = list.devices.find((device) => device._id === devices.light._id);
  assert.equal(lamp.stale, true);
  assert.ok(lamp.staleReason);
  assert.deepEqual(lamp.lastKnownState, { on: true });
  assert.equal(lamp.lastCommandResult, "failed");
});
