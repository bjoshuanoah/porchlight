import { generateKeyPairSync, sign as nodeSign } from "node:crypto";
import { createMemoryStore, canonicalJson } from "@porchlight/shared";
import { assembleHomeModule } from "../../src/assemble.js";
import { DeviceAdapterManager } from "../../src/services/adapter.registry.js";

/**
 * Home test fixture: the REAL home module services over an in-memory store,
 * with a real Ed25519 device-key enrollment per identity (device-signed
 * writes are exercised literally) and one contract-test device adapter
 * whose reachability/state the tests control.
 */
export function homeFixture({ commandTimeoutMs = 10_000, dark = null, now } = {}) {
  const store = createMemoryStore();
  const sessions = new Map(); // token -> { did, deviceId }
  const deviceKeys = new Map(); // `${did}:${deviceId}` -> publicKeyJwk

  const adapters = new DeviceAdapterManager({ commandTimeoutMs });
  // PORCH-138: an in-hub identity plane stand-in — every minted identity
  // resolves (grants ride existing identities, never new ones), no family
  // exists until the test adds one (identity-plane behavior exercised
  // through exactly the callbacks the hub wiring uses).
  const identityRows = new Map(); // did -> { did, displayName }
  const familyRows = new Map(); // familyId -> family document
  const testAdapter = {
    name: "test",
    state: { on: false },
    online: true,
    commandsFor: () => ["turnOn", "turnOff"],
    send: async ({ device: _device, command }) => {
      if (!testAdapter.online) {
        const error = new Error("The device is not responding.");
        error.code = "E_DEVICE_UNREACHABLE";
        throw error;
      }
      testAdapter.state = { on: command === "turnOn" };
      return { state: { ...testAdapter.state } };
    },
    readState: async () => {
      if (!testAdapter.online) {
        const error = new Error("The device is not responding.");
        error.code = "E_DEVICE_UNREACHABLE";
        throw error;
      }
      return { state: { ...testAdapter.state } };
    },
  };
  adapters.register(testAdapter);

  let clockFn = now ?? null;
  const clock = () => (clockFn ? clockFn() : new Date().toISOString());
  const mod = assembleHomeModule(store, {
    verifySession: (token) => Promise.resolve(sessions.get(String(token ?? "")) ?? null),
    registeredDeviceKey: (did, deviceId) => Promise.resolve(deviceKeys.get(`${did}:${deviceId}`)
      ? { publicKeyJwk: deviceKeys.get(`${did}:${deviceId}`) }
      : null),
    adapters,
    dark: dark === undefined ? null : dark,
    identityFacts: {
      resolveIdentity: (did) => Promise.resolve(identityRows.get(String(did ?? "")) ?? null),
      familyById: (familyId) => Promise.resolve(familyRows.get(String(familyId ?? "")) ?? null),
      familiesForMember: (did) => Promise.resolve(
        [...familyRows.values()].filter((family) => (family.memberIdentityRefs ?? []).includes(did)),
      ),
    },
    now: clock,
  });

  const fx = {
    mod,
    store,
    adapter: testAdapter,
    adapterManager: adapters,
    now: clock,
    /** Register a grantee's EXISTING identity (grants ride existing identities). */
    registerIdentityRow: (did, displayName = did.slice("did:porch:".length)) => {
      identityRows.set(did, { did, displayName });
    },
    /** Insert an identity-plane family document (the family organizer's rows). */
    addFamily: (family) => {
      familyRows.set(family._id, family);
      return family;
    },
    listFamilyRows: () => [...familyRows.values()],
    /** Rebind the module clock (services hold `clock`, not a copied value). */
    setClock: (fn) => {
      clockFn = fn;
    },
    collection: store.collection.bind(store),
    /** Mint one device-bound identity: a real signed session + enrolled key. */
    identity(did = "did:porch:test-owner") {
      const deviceId = `dev_${crypto.randomUUID().slice(0, 8)}`;
      const { publicKey, privateKey } = generateKeyPairSync("ed25519");
      const publicKeyJwk = { ...publicKey.export({ format: "jwk" }) };
      const token = `tok_${crypto.randomUUID()}`;
      sessions.set(token, { did, deviceId, sessionId: `ses_${crypto.randomUUID().slice(0, 8)}` });
      deviceKeys.set(`${did}:${deviceId}`, publicKeyJwk);
      return {
        did,
        deviceId,
        token,
        /** Real device signature over canonicalJson(payload). */
        sign: (payload) => nodeSign(
          null,
          Buffer.from(canonicalJson(payload), "utf8"),
          privateKey,
        ).toString("base64url"),
        /** A signed write body for the REST/service shape. */
        write: (payload) => ({ payload, signature: nodeSign(null, Buffer.from(canonicalJson(payload), "utf8"), privateKey).toString("base64url") }),
      };
    },
  };
  return fx;
}

/** Create a home as an identity; returns the home view. */
export async function createHomeFor(fx, owner, name = "Fieldstone") {
  const { home } = await fx.mod.homeService.create({ accessToken: owner.token, ...owner.write({ name }) });
  return home;
}

/** Create one room + one outdoor area + one device bound to the test adapter. */
export async function seedHomeDevices(fx, owner, home) {
  const areasMod = fx.mod.areaService;
  const devicesMod = fx.mod.deviceService;
  const room = (await areasMod.create({ accessToken: owner.token, homeId: home._id, ...owner.write({ name: "Living room", kind: "room" }) })).area;
  const porch = (await areasMod.create({ accessToken: owner.token, homeId: home._id, ...owner.write({ name: "Porch", kind: "outdoor" }) })).area;
  const light = (await devicesMod.register({
    accessToken: owner.token,
    homeId: home._id,
    ...owner.write({
      name: "Living lamp",
      areaId: room._id,
      capabilities: ["switch", "light"],
      adapter: { name: "test", binding: "matter-node-1" },
    }),
  })).device;
  const outdoor = (await devicesMod.register({
    accessToken: owner.token,
    homeId: home._id,
    ...owner.write({
      name: "Porch light",
      areaId: porch._id,
      capabilities: ["switch"],
      adapter: { name: "test", binding: "matter-node-2" },
    }),
  })).device;
  return { room, porch, devices: { light, outdoor } };
}
