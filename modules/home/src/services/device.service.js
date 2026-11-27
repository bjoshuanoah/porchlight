import { requireSignedSession, requireSession } from "../util/writes.js";
import { DeviceAdapterManager } from "./adapter.registry.js";
import { fail } from "./errors.js";
import { ACCESS_OWNER_ONLY, coversDevice } from "./scopes.js";

function isMembership(access) {
  return !access || access.accessClass === "owner-membership";
}

/**
 * Device service (PORCH-137 TS 1: the command path and state truth).
 * Porchlight's device service owns the adapter layer; read-back from the
 * device is the state of record. One code path serves every issuer — a
 * member's command on the dashboard, a scene's run, an automation's fired
 * action — so confirmed state, failure marking, and audit land identically
 * no matter who acted (ac-2). Optimistic flips are banned by construction:
 * lastKnownState only ever changes on adapter read-back.
 */
export const DEVICE_CAPABILITIES = ["switch", "light", "thermostat", "lock"];

export class DeviceService {
  /**
   * @param {import("@porchlight/shared").CollectionLike} devices
   * @param {import("./home.service.js").HomeService} homes
   * @param {import("./audit.service.js").HomeAuditService} audit
   * @param {DeviceAdapterManager} adapters
   * @param {{ verifySession, registeredDeviceKey }} identity
   * @param {() => string} [now]
   */
  constructor(devices, areas, homes, audit, adapters, { verifySession, registeredDeviceKey }, now = defaultNow) {
    this.devices = devices;
    this.areas = areas;
    this.homes = homes;
    this.audit = audit;
    this.adapters = adapters ?? new DeviceAdapterManager();
    this.verifySession = verifySession;
    this.registeredDeviceKey = registeredDeviceKey;
    this.now = now;
  }

  /**
   * POST /homes/:homeId/devices — register one device into one area.
   * Signed member write. The capability list drives the control surface.
   */
  async register({ accessToken, homeId, payload, signature } = {}) {
    const authorized = await this.homes.authorize({ accessToken, homeId });
    if (!isMembership(authorized.access)) {
      return fail("E_NOT_PERMITTED", ACCESS_OWNER_ONLY);
    }
    await requireSignedSession({
      accessToken, payload, signature,
      verifySession: this.verifySession,
      registeredDeviceKey: this.registeredDeviceKey,
    });
    const area = await this.#areaOf(homeId, payload?.areaId);
    const name = cleanDeviceName(payload?.name);
    const capabilities = cleanCapabilities(payload?.capabilities);
    const adapter = cleanAdapter(payload?.adapter);
    const device = {
      _id: `dev_${crypto.randomUUID()}`,
      homeId,
      areaId: area._id,
      name,
      capabilities,
      adapter,
      lastKnownState: null,
      stateConfirmedAt: null,
      lastCommandAt: null,
      lastCommandResult: null,
      unreachable: null,
      createdBy: authorized.did,
      createdAt: this.now(),
    };
    await this.devices.insertOne(device);
    return { device: this.view(device) };
  }

  /** PUT /devices/:deviceId — rename or move one device within its home. Signed member write. */
  async update({ accessToken, deviceId, payload, signature } = {}) {
    const device = await this.devices.findOne({ _id: deviceId });
    if (!device) return fail("E_DEVICE_NOT_FOUND", "That device isn't part of this home anymore.");
    const authorizedUpdate = await this.homes.authorize({ accessToken, homeId: device.homeId });
    if (!isMembership(authorizedUpdate.access)) {
      return fail("E_NOT_PERMITTED", ACCESS_OWNER_ONLY);
    }
    await requireSignedSession({
      accessToken, payload, signature,
      verifySession: this.verifySession,
      registeredDeviceKey: this.registeredDeviceKey,
    });
    const set = {};
    if (payload?.name !== undefined) set.name = cleanDeviceName(payload.name);
    if (payload?.areaId !== undefined) {
      const area = await this.#areaOf(device.homeId, payload.areaId);
      set.areaId = area._id;
    }
    if (Object.keys(set).length > 0) {
      const updated = await this.devices.updateOne({ _id: deviceId }, { $set: set });
      if (!updated) return fail("E_DEVICE_NOT_FOUND", "That device isn't part of this home anymore.");
    }
    return { device: this.view({ ...device, ...set }) };
  }

  /**
   * POST /devices/:deviceId/command — the member's command. Hub-side
   * enforcement: the caller must be a member of the device's home, and a
   * command that names a home other than the device's own is refused with
   * plain language (denied audit row). Confirmed ONLY on adapter read-back.
   * The signed session resolves the did; the verdicts stay in the actor
   * seam (one code path for member, scene, automation, and agent issuers).
   */
  async command({ accessToken, homeId = null, deviceId, payload, signature } = {}) {
    const { did, deviceSignature } = await requireSignedSession({
      accessToken, payload, signature,
      verifySession: this.verifySession,
      registeredDeviceKey: this.registeredDeviceKey,
    });
    return this.commandForActor({
      did, homeId, deviceId,
      command: payload?.command ?? null,
      deviceSignature,
      source: "member",
      detail: {},
    });
  }

  /**
   * The command path with the acting identity already resolved. The agent
   * tool registry (PORCH-149) rides this exact seam — the SAME
   * authorizeMember verdicts and grant-control coverage the member's UI
   * command applies, the single dispatch the audit family of record
   * carries, and `detail` carrying the issuer attribution (source, agent
   * tool). A refusal (deny or device-not-found) lands its denied audit row
   * with the same attribution, exactly like the UI session path.
   */
  async commandForActor({
    did, homeId = null, deviceId, command = null, deviceSignature = null,
    source = "agent", detail = {},
  } = {}) {
    try {
      const deviceDoc = await this.#deviceOfMember(homeId, deviceId);
      const scopedHomeId = deviceDoc.homeId;
      const authorized = await this.homes.authorizeMember({ did, homeId: scopedHomeId });
      // Hub-side grant enforcement on the command path: a visit grantee's
      // command must be covered by a control scope (device or its area), so
      // revocation or expiry denies the very next command from an open
      // session (PORCH-138 ac-1/ac-5).
      if (!isMembership(authorized.access) && !coversDevice(authorized.access.scopes, deviceDoc, "control")) {
        return fail("E_NOT_PERMITTED", "That control isn't part of the access you were granted for this home.");
      }
      if (!command) return fail("E_COMMAND_UNKNOWN", "Tell Porchlight which command to send — lights read on/off, for example.");
      return await this.#dispatch({
        device: deviceDoc,
        command,
        actorIdentityRef: did,
        detail: { ...detail, command, source },
        _source: source,
        deviceSignature,
      });
    } catch (cause) {
      if (cause?.code === "E_NOT_PERMITTED" || cause?.code === "E_DEVICE_NOT_FOUND") {
        // Hub-side scope refusal, audited as denied: who, which home, which device, outcome.
        await this.audit.record({
          type: "command",
          homeId: homeId ?? (deviceId ? `device:${deviceId}` : "unknown"),
          deviceId,
          actorIdentityRef: did,
          deviceSignature: deviceSignature ?? null,
          detail: { ...detail, command: command ?? null, source, reason: cause.message },
          outcome: "denied",
        });
      }
      throw cause;
    }
  }

  /**
   * GET /homes/:homeId/devices/:deviceId/state — hub-initiated read-back
   * of one device's state. The read-back refreshes lastKnownState/
   * stateConfirmedAt (a state-source-change row, source read-back); an
   * unreachable device answers its last-known state labeled stale with the
   * reason — never a broken surface.
   */
  async readState({ accessToken, homeId, deviceId } = {}) {
    const authorized = await this.homes.authorize({ accessToken, homeId });
    const device = await this.#deviceOfMember(homeId, deviceId);
    if (!isMembership(authorized.access) && !coversDevice(authorized.access.scopes, device, "view")) {
      return fail("E_NOT_PERMITTED", "That control isn't part of the access you were granted for this home.");
    }
    try {
      const { state, at } = await this.adapters.readState(device);
      const updated = await this.#confirmState(device, state, { at, source: "read-back" });
      await this.audit.record({
        type: "state-source-change",
        homeId,
        deviceId,
        actorIdentityRef: null,
        detail: { source: "read-back", state },
        outcome: "confirmed",
      });
      return { device: this.view(updated), read: { outcome: "confirmed" } };
    } catch (cause) {
      const reason = cause?.message ?? "The device didn't report its state.";
      const current = await this.#markUnreachable(device, reason);
      await this.audit.record({
        type: "state-source-change",
        homeId,
        deviceId,
        actorIdentityRef: null,
        detail: { source: "read-back", reason },
        outcome: "failed",
      });
      return { device: this.view(current), read: { outcome: "failed", reason } };
    }
  }

  /**
   * The physical-state reporting path (ambient changes through the
   * adapter's state reporting): someone flips a wall switch. Updates the
   * device of record and lands a state-source-change audit row marked
   * physical, so the audit trail distinguishes "changed by command" from
   * "changed at the switch".
   */
  async reportState({ deviceId, state, source = "physical", at = null } = {}) {
    const device = await this.devices.findOne({ _id: deviceId });
    if (!device) return fail("E_DEVICE_NOT_FOUND", "That device isn't part of this home anymore.");
    if (!state || typeof state !== "object") {
      return fail("E_VALIDATION", "A state report needs the device's state.");
    }
    const updated = await this.#confirmState(device, state, { at, source });
    await this.audit.record({
      type: "state-source-change",
      homeId: device.homeId,
      deviceId,
      actorIdentityRef: null,
      detail: { source, state },
      outcome: "confirmed",
    });
    return { device: this.view(updated) };
  }

  /**
   * GET /homes/:homeId/devices — the home's device list (the family app
   * groups by area client-side; one collection serves rooms + outdoor).
   * A visit grant sees exactly the devices its view scopes cover — nothing
   * else renders (PORCH-138 ac-1).
   */
  /**
   * GET /homes/:homeId/devices — the device read of record. The session
   * path resolves the did; the verdicts stay in the actor seam.
   */
  async list({ accessToken, homeId } = {}) {
    const { did } = await requireSession({ accessToken, verifySession: this.homes.verifySession });
    return this.listForActor({ did, homeId });
  }

  /**
   * GET /homes/:homeId/devices, session-free (the did already resolved).
   * The same authorizeMember verdicts, the same grant-scope filter — the
   * actor seams never widen a member's view (PORCH-149's tool registry
   * consumes this via the injected home tool surface).
   */
  async listForActor({ did, homeId } = {}) {
    const authorized = await this.homes.authorizeMember({ did, homeId });
    const rows = await this.devices.find({ homeId });
    const scopes = authorized.access?.scopes ?? null;
    const visible = scopes ? rows.filter((device) => coversDevice(scopes, device, "view")) : rows;
    return { devices: visible.sort(byName).map((device) => this.view(device)) };
  }

  /** One device of a home the caller belongs to. */
  async get({ accessToken, homeId, deviceId } = {}) {
    const authorized = await this.homes.authorize({ accessToken, homeId });
    const device = await this.#deviceOfMember(homeId, deviceId);
    if (!isMembership(authorized.access) && !coversDevice(authorized.access.scopes, device, "view")) {
      return fail("E_NOT_PERMITTED", "That control isn't part of the access you were granted for this home.");
    }
    return { device: this.view(device) };
  }

  /**
   * The rule-execution path (scenes and automations): same dispatch, the
   * acting party recorded as the actor ref (a member DID for scenes, an
   * automation ref for rule fires). Devices are validated into the home at
   * write time, so a rule can never reach across homes.
   */
  async runForActor({ homeId, deviceId, command, actorIdentityRef, detail }) {
    const device = await this.devices.findOne({ _id: deviceId });
    if (!device || device.homeId !== homeId) {
      return fail("E_DEVICE_NOT_FOUND", "That device isn't part of this home anymore.");
    }
    return this.#dispatch({
      device,
      command,
      actorIdentityRef,
      detail,
      _source: detail?.source,
      deviceSignature: null,
    });
  }

  view(device) {
    return {
      _id: device._id,
      homeId: device.homeId,
      areaId: device.areaId,
      name: device.name,
      capabilities: device.capabilities,
      adapter: device.adapter,
      lastKnownState: device.lastKnownState ?? null,
      stateConfirmedAt: device.stateConfirmedAt ?? null,
      lastCommandAt: device.lastCommandAt ?? null,
      lastCommandResult: device.lastCommandResult ?? null,
      /** Stale labeling: last-known state with the failure reason, distinct from confirmed. */
      stale: device.unreachable != null,
      staleReason: device.unreachable?.reason ?? null,
      createdAt: device.createdAt,
    };
  }

  /** THE single command path (member, scene, automation alike). */
  async #dispatch({ device, command, actorIdentityRef, detail, deviceSignature, _source }) {
    const verbs = await this.adapters.commandsFor(device);
    const commandValid = validCommandShape(command);
    if (!verbs.includes(command)) {
      await this.audit.record({
        type: "command",
        homeId: device.homeId,
        deviceId: device._id,
        actorIdentityRef: actorIdentityRef ?? null,
        deviceSignature: deviceSignature ?? null,
        detail: { ...detail, command, reason: "refused before any device contact" },
        outcome: commandValid ? "failed" : "denied",
      });
      if (this.adapters.resolve(device) == null) {
        return fail("E_NO_ADAPTER", `No device adapter named "${stringName(device)}" is connected to this hub, so ${device.name} can't be reached yet.`);
      }
      if (!validCommandShape(command)) {
        return fail("E_COMMAND_UNKNOWN", `Porchlight doesn't know the command "${stringSafe(command)}" for ${device.name}.`);
      }
      return fail("E_COMMAND_UNKNOWN", `${device.name} can't do "${stringSafe(command)}" — its capabilities are ${(device.capabilities ?? []).join(", ") || "not registered"}.`);
    }
    try {
      const { state, at } = await this.adapters.send(device, command);
      const updated = await this.#confirmState(device, state, { at, source: "command" });
      await this.audit.record({
        type: "command",
        homeId: device.homeId,
        deviceId: device._id,
        actorIdentityRef: actorIdentityRef ?? null,
        deviceSignature: deviceSignature ?? null,
        detail: { ...detail, command, outcome: "confirmed" },
        outcome: "confirmed",
      });
      return { outcome: "confirmed", device: this.view(updated) };
    } catch (cause) {
      const reason = cause?.message ?? "The device didn't confirm the command.";
      const current = await this.#markUnreachable(device, reason);
      await this.audit.record({
        type: "command",
        homeId: device.homeId,
        deviceId: device._id,
        actorIdentityRef: actorIdentityRef ?? null,
        deviceSignature: deviceSignature ?? null,
        detail: { ...detail, command, reason },
        outcome: "failed",
      });
      const error = new Error(`${device.name} couldn't be reached: ${reason}`);
      error.code = "E_DEVICE_UNREACHABLE";
      error.device = this.view(current);
      throw error;
    }
  }

  /** Read-back confirmed: the ONLY allowed writer of lastKnownState. */
  async #confirmState(device, state, { at = null, source = "command" }) {
    const set = {
      lastKnownState: state,
      stateConfirmedAt: at ?? this.now(),
      unreachable: null,
    };
    if (source === "command") {
      set.lastCommandAt = this.now();
      set.lastCommandResult = "confirmed";
    }
    const updated = await this.devices.updateOne({ _id: device._id }, { $set: set });
    return updated === false ? device : { ...device, ...set };
  }

  async #markUnreachable(device, reason) {
    const set = {
      lastCommandAt: this.now(),
      lastCommandResult: "failed",
      unreachable: { at: this.now(), reason },
    };
    const updated = await this.devices.updateOne({ _id: device._id }, { $set: set });
    return updated === false ? device : { ...device, ...set };
  }

  /** The device in scope — an explicit home mismatch is a plain-language refusal. */
  async #deviceOfMember(homeId, deviceId) {
    const device = await this.devices.findOne({ _id: deviceId });
    if (!device) {
      return fail("E_DEVICE_NOT_FOUND", "That device isn't part of this home anymore.");
    }
    if (homeId && device.homeId !== homeId) {
      return fail("E_NOT_PERMITTED", "That device doesn't belong to the home in view, so the command was refused.");
    }
    return device;
  }

  async #areaOf(homeId, areaId) {
    if (!areaId) return fail("E_VALIDATION", "Pick which room or outdoor area the device belongs to.");
    const area = await this.areas.findOne({ _id: areaId, homeId });
    if (!area) {
      return fail("E_AREA_NOT_FOUND", "That area isn't part of this home's surfaces.");
    }
    return area;
  }
}

/** The wired area collection — assembled at the module layer (kept beside homes). */

function cleanDeviceName(value) {
  const name = typeof value === "string" ? value.trim() : "";
  if (!name) return fail("E_NAME_REQUIRED", "Give the device a name — any household label works.");
  if (name.length > 120) return fail("E_NAME_TOO_LONG", "That name is too long — 120 characters or fewer, please.");
  return name;
}

function cleanCapabilities(value) {
  const caps = Array.isArray(value) ? value.filter((cap) => DEVICE_CAPABILITIES.includes(cap)) : [];
  if (caps.length === 0) {
    return fail("E_VALIDATION", `Register what the device can do — any of: ${DEVICE_CAPABILITIES.join(", ")}.`);
  }
  return caps;
}

function cleanAdapter(value) {
  const name = typeof value?.name === "string" ? value.name.trim() : "";
  if (!name) {
    return fail("E_VALIDATION", "A device needs its adapter binding — the Matter node id or native adapter reference.");
  }
  const adapter = { name };
  if (value.binding !== undefined) adapter.binding = value.binding ?? null;
  return adapter;
}

export function validCommandShape(command) {
  return typeof command === "string" && command.length > 0 && command.length <= 64;
}

function byName(a, b) {
  return String(a.name).localeCompare(String(b.name));
}

function stringName(device) {
  return String(device?.adapter?.name ?? "");
}

function stringSafe(value) {
  return String(value ?? "").slice(0, 64);
}

function defaultNow() {
  return new Date().toISOString();
}

export default DeviceService;
