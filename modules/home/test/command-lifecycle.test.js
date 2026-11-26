import { test } from "node:test";
import assert from "node:assert/strict";
import { homeFixture, createHomeFor, seedHomeDevices } from "./helpers/home.fixture.js";

test("ac-2: a confirmed command arrives on device read-back and updates the device of record", async () => {
  const fx = homeFixture();
  const owner = fx.identity();
  const { deviceService, auditService } = fx.mod;
  const home = await createHomeFor(fx, owner);
  const { devices } = await seedHomeDevices(fx, owner, home);
  const lamp = devices.light;

  const result = await deviceService.command({
    accessToken: owner.token,
    homeId: home._id,
    deviceId: lamp._id,
    ...owner.write({ command: "turnOn" }),
  });
  assert.equal(result.outcome, "confirmed");
  // The state of record is the READ-BACK state, not the attempted intent.
  assert.deepEqual(result.device.lastKnownState, { on: true });
  assert.ok(result.device.stateConfirmedAt);
  assert.equal(result.device.lastCommandResult, "confirmed");
  assert.equal(result.device.stale, false);

  const stored = await fx.collection("devices").findOne({ _id: lamp._id });
  assert.deepEqual(stored.lastKnownState, { on: true });

  const auditRow = (await auditService.list({ homeId: home._id })).events;
  const commandRow = auditRow.find((event) => event.type === "command" && event.deviceId === lamp._id);
  assert.ok(commandRow);
  assert.equal(commandRow.outcome, "confirmed");
  assert.equal(commandRow.actorIdentityRef, owner.did);
  assert.ok(commandRow.deviceSignature, "member-issued commands carry their device signature");
});

test("ac-2: an unreachable device fails fast, keeps last-known state labeled stale, and never flips optimistically", async () => {
  const fx = homeFixture({ commandTimeoutMs: 300 });
  const owner = fx.identity();
  const home = await createHomeFor(fx, owner);
  const { devices } = await seedHomeDevices(fx, owner, home);
  const lamp = devices.light;

  // Confirmed baseline first: the state of record is known-good.
  await fx.mod.deviceService.command({ accessToken: owner.token, homeId: home._id, deviceId: lamp._id, ...owner.write({ command: "turnOn" }) });

  fx.adapter.online = false;
  await assert.rejects(
    () => fx.mod.deviceService.command({
      accessToken: owner.token,
      homeId: home._id,
      deviceId: lamp._id,
      ...owner.write({ command: "turnOff" }),
    }),
    (error) => {
      assert.equal(error.code, "E_DEVICE_UNREACHABLE");
      assert.ok(/couldn't be reached/i.test(error.message));
      assert.equal(error.device.stale, true);
      assert.ok(error.device.staleReason?.length > 0);
      assert.deepEqual(error.device.lastKnownState, { on: true }, "no optimistic flip: last-known state survives");
      return true;
    },
  );

  const stored = await fx.collection("devices").findOne({ _id: lamp._id });
  assert.deepEqual(stored.lastKnownState, { on: true }, "the device row keeps the read-back state, never the intent");
  assert.equal(stored.lastCommandResult, "failed");
  assert.ok(stored.unreachable.reason.length > 0);

  const auditRow = (await fx.mod.auditService.list({ homeId: home._id })).events;
  const failed = auditRow.find((event) => event.type === "command" && event.outcome === "failed");
  assert.ok(failed);
  assert.equal(failed.deviceId, lamp._id);
  assert.equal(failed.actorIdentityRef, owner.did);
});

test("ac-2: a hanging adapter is bounded — no spinner to nowhere", async () => {
  const fx = homeFixture({ commandTimeoutMs: 120 });
  const owner = fx.identity();
  const home = await createHomeFor(fx, owner);
  const { devices } = await seedHomeDevices(fx, owner, home);
  fx.adapter.online = true;
  fx.adapter.send = async () => new Promise(() => {});
  await assert.rejects(
    () => fx.mod.deviceService.command({ accessToken: owner.token, homeId: home._id, deviceId: devices.light._id, ...owner.write({ command: "turnOn" }) }),
    (error) => error.code === "E_DEVICE_UNREACHABLE" && /didn't respond in time/.test(error.message),
  );
});

test("ac-2: unknown commands and un-adaptered devices refuse with plain language", async () => {
  const fx = homeFixture();
  const owner = fx.identity();
  const home = await createHomeFor(fx, owner);
  const { devices } = await seedHomeDevices(fx, owner, home);
  await assert.rejects(
    () => fx.mod.deviceService.command({ accessToken: owner.token, homeId: home._id, deviceId: devices.light._id, ...owner.write({ command: "discoMode" }) }),
    (error) => error.code === "E_COMMAND_UNKNOWN",
  );
  // A device whose adapter never connected refuses honestly — no silent no-op.
  const ghost = (await fx.mod.deviceService.register({
    accessToken: owner.token,
    homeId: home._id,
    ...owner.write({
      name: "Ghost bulb",
      areaId: (await fx.mod.areaService.list({ accessToken: owner.token, homeId: home._id })).areas[0]._id,
      capabilities: ["light"],
      adapter: { name: "ghost", binding: "none" },
    }),
  })).device;
  await assert.rejects(
    () => fx.mod.deviceService.command({ accessToken: owner.token, homeId: home._id, deviceId: ghost._id, ...owner.write({ command: "turnOn" }) }),
    (error) => error.code === "E_NO_ADAPTER" && /ghost/i.test(error.message),
  );
});

test("ac-2: a scene run rides the one confirmed-state command path — per-action outcomes, runner attributed", async () => {
  const fx = homeFixture();
  const owner = fx.identity();
  const home = await createHomeFor(fx, owner);
  const seeded = await seedHomeDevices(fx, owner, home);
  const { sceneService } = fx.mod;
  const created = await sceneService.create({
    accessToken: owner.token,
    homeId: home._id,
    ...owner.write({
      name: "Arrive home",
      actions: [
        { deviceId: seeded.devices.light._id, command: "turnOn" },
        { deviceId: seeded.devices.outdoor._id, command: "turnOn" },
      ],
    }),
  });
  assert.equal(created.scene.name, "Arrive home");

  // The one adapter confirms the FIRST send and goes unreachable after —
  // per-action honesty without a second adapter.
  const originalSend = fx.adapter.send.bind(fx.adapter);
  let sends = 0;
  fx.adapter.send = async (args) => {
    sends += 1;
    if (sends > 1) fx.adapter.online = false;
    return originalSend(args);
  };
  const run = await sceneService.run({ accessToken: owner.token, sceneId: created.scene._id });
  assert.equal(run.results.length, 2);
  assert.equal(run.results[0].outcome, "confirmed");
  assert.equal(run.results[1].outcome, "failed");
  assert.ok(run.results[1].reason);

  // Every executed action lands its own audit row with the runner as actor.
  const rows = (await fx.mod.auditService.list({ homeId: home._id })).events.filter((event) => event.type === "command" && event.detail?.source === "scene");
  const actors = new Set(rows.map((event) => event.actorIdentityRef));
  assert.ok(actors.has(owner.did));
  assert.equal(rows.length, 2);
});

test("ac-2: scene writes are fail-closed — no action may reach a device outside the home", async () => {
  const fx = homeFixture();
  const owner = fx.identity();
  const homeA = await createHomeFor(fx, owner, "Fieldstone");
  const homeB = await createHomeFor(fx, owner, "Lakeside");
  const seededA = await seedHomeDevices(fx, owner, homeA);
  await assert.rejects(
    () => fx.mod.sceneService.create({
      accessToken: owner.token,
      homeId: homeB._id,
      ...owner.write({ name: "Cross-home", actions: [{ deviceId: seededA.devices.light._id, command: "turnOn" }] }),
    }),
    (error) => error.code === "E_NOT_PERMITTED",
  );
});
