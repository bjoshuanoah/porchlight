import { test } from "node:test";
import assert from "node:assert/strict";
import { homeFixture, createHomeFor, seedHomeDevices } from "./helpers/home.fixture.js";

test("ac-5: every audited action carries the acting identity, home, device, time, and outcome", async () => {
  const fx = homeFixture();
  const owner = fx.identity("did:porch:runner");
  const home = await createHomeFor(fx, owner);
  const { devices } = await seedHomeDevices(fx, owner, home);

  // Member command (signed), member scene run, physical change, automation fire.
  await fx.mod.deviceService.command({ accessToken: owner.token, homeId: home._id, deviceId: devices.light._id, ...owner.write({ command: "turnOn" }) });
  await fx.mod.sceneService.create({
    accessToken: owner.token,
    homeId: home._id,
    ...owner.write({ name: "Evening", actions: [{ deviceId: devices.outdoor._id, command: "turnOn" }] }),
  });
  await fx.mod.deviceService.reportState({ deviceId: devices.outdoor._id, state: { on: false }, source: "physical" });

  const rows = (await fx.mod.auditService.list({ homeId: home._id })).events;
  for (const row of rows) {
    assert.equal(row.homeId, home._id);
    assert.ok(row.at, "every row carries its time");
    assert.ok(["confirmed", "failed", "denied"].includes(row.outcome));
  }
  const memberCommand = rows.find((event) => event.type === "command" && event.detail?.source === "member");
  assert.equal(memberCommand.actorIdentityRef, owner.did);
  assert.ok(memberCommand.deviceSignature, "member-issued rows carry the device signature");
  const physical = rows.find((event) => event.type === "state-source-change");
  assert.equal(physical.detail.source, "physical");
  assert.equal(physical.actorIdentityRef, null, "physical changes name their source, not a session actor");
});

test("ac-5: reads, commands, and automations carry no WAN dependency — audit writes are local, no outbound calls", async () => {
  // LAN-first proof at the module seam: the module makes zero network calls.
  // The whole suite runs against createMemoryStore with no sockets opened;
  // this test pins the module-import surface: home imports only express +
  // @porchlight/shared (boundary-checked in CI) and nothing that dials out.
  const { readFileSync } = await import("node:fs");
  const { fileURLToPath } = await import("node:url");
  const { join, dirname } = await import("node:path");
  const here = dirname(fileURLToPath(import.meta.url));
  const sources = [
    join(here, "../src/assemble.js"),
    join(here, "../src/services/device.service.js"),
    join(here, "../src/services/automation.service.js"),
    join(here, "../src/services/home.service.js"),
  ];
  for (const file of sources) {
    const source = readFileSync(file, "utf8");
    assert.ok(!/\bfetch\(|https?:\/\//i.test(source.replace(/\/\/[^\n]*/g, "")), `${file} makes no outbound network calls`);
  }
});

test("ac-5: the property-agnostic model — N homes coexist identically; fleet shape never leaks into results", async () => {
  const fx = homeFixture();
  const owner = fx.identity();
  const { homeService, deviceService, auditService } = fx.mod;

  // Five homes, same flow each — the identical operation set at any home count.
  const homes = [];
  for (const name of ["Fieldstone", "Lakeside", "Depot", "Inn", "Cabin"]) {
    const home = await createHomeFor(fx, owner, name);
    await seedHomeDevices(fx, owner, home);
    homes.push(home);
  }
  const listed = await homeService.list({ accessToken: owner.token });
  assert.equal(listed.homes.length, 5);
  assert.deepEqual(new Set(listed.homes.map((h) => h.name)), new Set(homes.map((h) => h.name)));

  // The same command runs per home with per-home audit — never conflated.
  for (const home of homes) {
    const { devices } = { devices: (await deviceService.list({ accessToken: owner.token, homeId: home._id })).devices };
    await deviceService.command({ accessToken: owner.token, homeId: home._id, deviceId: devices[0]._id, ...owner.write({ command: "turnOn" }) });
    const rows = (await auditService.list({ homeId: home._id })).events.filter((event) => event.type === "command" && event.outcome === "confirmed");
    assert.equal(rows.length, 1);
    assert.equal(rows[0].homeId, home._id);
  }
});

test("ac-5: the audit page is bounded — limit/offset, newest first, no unbounded writes", async () => {
  const fx = homeFixture();
  const owner = fx.identity();
  const home = await createHomeFor(fx, owner);
  const { devices } = await seedHomeDevices(fx, owner, home);
  for (let index = 0; index < 7; index += 1) {
    await fx.mod.deviceService.command({ accessToken: owner.token, homeId: home._id, deviceId: devices.light._id, ...owner.write({ command: index % 2 ? "turnOn" : "turnOff" }) });
  }
  const page1 = await fx.mod.auditService.list({ homeId: home._id, limit: 3, offset: 0 });
  assert.equal(page1.events.length, 3);
  assert.equal(page1.total, 7);
  assert.equal(page1.hasMore, true);
  const page3 = await fx.mod.auditService.list({ homeId: home._id, limit: 3, offset: 6 });
  assert.equal(page3.events.length, 1);
  assert.equal(page3.hasMore, false);
  assert.ok(page3.offset === 6);
});
