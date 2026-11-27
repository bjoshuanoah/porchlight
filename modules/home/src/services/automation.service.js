import { requireSignedSession, requireSession } from "../util/writes.js";
import { fail } from "./errors.js";
import { cleanName } from "./home.service.js";
import { validCommandShape } from "./device.service.js";
import { ACCESS_OWNER_ONLY } from "./scopes.js";

/**
 * Automation service (PORCH-137 TS 1). Event-driven rules in plain form —
 * trigger (event class + conditions), device actions. Evaluation is
 * event-driven (the injected event source), never polling. Time-window
 * conditions resolve from hub-local state: absolute clock windows always
 * evaluate locally; afterDark evaluates against the hub's local sunset
 * provider (computed locally — the WAN is never consulted; an unwired
 * provider means the condition cannot honestly resolve, so the rule does
 * not fire and the fire audit carries why).
 */
export class AutomationService {
  /**
   * @param {import("@porchlight/shared").CollectionLike} automations
   * @param {import("./home.service.js").HomeService} homes
   * @param {import("./device.service.js").DeviceService} devices
   * @param {import("./audit.service.js").HomeAuditService} audit
   * @param {{ verifySession, registeredDeviceKey, dark?: () => boolean | null }} identity
   * @param {() => string} [now]
   */
  constructor(automations, homes, devices, audit, { verifySession, registeredDeviceKey, dark = null }, now = defaultNow) {
    this.automations = automations;
    this.homes = homes;
    this.devices = devices;
    this.audit = audit;
    this.verifySession = verifySession;
    this.registeredDeviceKey = registeredDeviceKey;
    /** Hub-local after-dark resolution; null = provider unwired. */
    this.dark = typeof dark === "function" ? dark : null;
    this.now = now;
  }

  /** POST /homes/:homeId/automations — create one rule. Signed member write. */
  async create({ accessToken, homeId, payload, signature } = {}) {
    const authorizedCreate = await this.homes.authorize({ accessToken, homeId });
    if (authorizedCreate.access?.accessClass !== "owner-membership") {
      return fail("E_NOT_PERMITTED", ACCESS_OWNER_ONLY);
    }
    const did = authorizedCreate.did;
    await requireSignedSession({
      accessToken, payload, signature,
      verifySession: this.verifySession,
      registeredDeviceKey: this.registeredDeviceKey,
    });
    const name = cleanName(payload?.name);
    const trigger = cleanTrigger(payload?.trigger);
    const actions = await this.#cleanActions(homeId, payload?.actions);
    const automation = {
      _id: `auto_${crypto.randomUUID()}`,
      homeId,
      name,
      trigger,
      actions,
      enabled: payload?.enabled === false ? false : true,
      lastFiredAt: null,
      createdBy: did,
      deviceSignature: signature ?? null,
      createdAt: this.now(),
    };
    await this.automations.insertOne(automation);
    return { automation: this.view(automation) };
  }

  /** PUT /automations/:automationId — rename, re-trigger, re-action, enable/disable. Signed member write. */
  async update({ accessToken, automationId, payload, signature } = {}) {
    const automation = await this.automations.findOne({ _id: automationId });
    if (!automation) return fail("E_AUTOMATION_NOT_FOUND", "That automation isn't part of this home anymore.");
    const authorizedUpdate = await this.homes.authorize({ accessToken, homeId: automation.homeId });
    if (authorizedUpdate.access?.accessClass !== "owner-membership") {
      return fail("E_NOT_PERMITTED", ACCESS_OWNER_ONLY);
    }
    await requireSignedSession({
      accessToken, payload, signature,
      verifySession: this.verifySession,
      registeredDeviceKey: this.registeredDeviceKey,
    });
    const set = {};
    if (payload?.name !== undefined) set.name = cleanName(payload.name);
    if (payload?.trigger !== undefined) set.trigger = cleanTrigger(payload.trigger);
    if (payload?.actions !== undefined) set.actions = await this.#cleanActions(automation.homeId, payload.actions);
    if (payload?.enabled !== undefined) {
      if (typeof payload.enabled !== "boolean") {
        return fail("E_VALIDATION", "An automation runs or it doesn't — enabled is true or false.");
      }
      set.enabled = payload.enabled;
    }
    if (Object.keys(set).length > 0) {
      const updated = await this.automations.updateOne({ _id: automationId }, { $set: set });
      if (!updated) return fail("E_AUTOMATION_NOT_FOUND", "That automation isn't part of this home anymore.");
    }
    return { automation: this.view({ ...automation, ...set }) };
  }

  async list({ accessToken, homeId } = {}) {
    const { did } = await requireSession({ accessToken, verifySession: this.homes.verifySession });
    return this.listForActor({ did, homeId });
  }

  /**
   * GET /homes/:homeId/automations, session-free. Automations are
   * member-management surfaces, never a grant scope: a visitor's view
   * carries no rules at all (PORCH-138 TS 1 scope list) — the same verdict
   * here, resolved against the did.
   */
  async listForActor({ did, homeId } = {}) {
    const authorized = await this.homes.authorizeMember({ did, homeId });
    const rows = await this.automations.find({ homeId });
    // Automations are member-management surfaces, never a grant scope: a
    // visitor's view carries no rules at all (PORCH-138 TS 1 scope list).
    const visible = authorized.access?.accessClass === "owner-membership" ? rows : [];
    return { automations: visible.sort(byCreatedAt).map((row) => this.view(row)) };
  }

  /**
   * The event-driven evaluation entry: apps/server (or a test) feeds every
   * engine/hub event on the bus here. Only enabled rules of the event's
   * home evaluate; conditions fail closed; every fire — and every action
   * the fire ran — lands in the audit trail (ac-4).
   *
   * Event shape: { homeId, eventClass, areaId?, at? } (engine detection
   * class vocabulary: vehicle, person, animal, ...).
   */
  async handleEvent(event = {}) {
    if (!event?.homeId || typeof event.eventClass !== "string") {
      return { fired: [] };
    }
    const rows = await this.automations.find({ homeId: event.homeId, enabled: true });
    const fired = [];
    for (const automation of rows.sort(byCreatedAt)) {
      const verdict = this.#conditionsMet(automation, event);
      if (!verdict.met) continue;
      const results = await this.#runActions(automation);
      await this.automations.updateOne({ _id: automation._id }, { $set: { lastFiredAt: this.now() } });
      const anyConfirmed = results.some((result) => result.outcome === "confirmed");
      await this.audit.record({
        type: "automation-fire",
        homeId: automation.homeId,
        actorIdentityRef: `automation:${automation._id}`,
        deviceId: null,
        detail: {
          automationId: automation._id,
          name: automation.name,
          eventClass: event.eventClass,
          conditionNote: verdict.note ?? null,
          actionResults: results,
        },
        outcome: anyConfirmed ? "confirmed" : "failed",
      });
      fired.push({ automation: this.view({ ...automation, lastFiredAt: this.now() }), results });
    }
    return { fired };
  }

  #conditionsMet(automation, event) {
    const trigger = automation.trigger ?? {};
    if (trigger.eventClass !== event.eventClass) return { met: false };
    if (trigger.areaId && trigger.areaId !== event.areaId) return { met: false };
    const window = trigger.timeWindow ?? null;
    if (!window) return { met: true };
    const now = this.now();
    if (window.afterDark === true) {
      if (!this.dark) {
        // Fail closed, and say why in the fire audit when a later trigger
        // fires on other grounds: the dark state simply cannot resolve.
        return { met: false };
      }
      const dark = this.dark({ at: now });
      if (dark !== true) return { met: false, note: dark === false ? "not after dark" : "dark state unavailable" };
    }
    const active = clockWindow(now, window);
    if (window.from && window.to && active === null) {
      return fail("E_VALIDATION", `Automation "${automation.name}" has a time window that can't be read (from/to use HH:mm).`);
    }
    if (active === false) return { met: false, note: "outside its time window" };
    return { met: true };
  }

  async #runActions(automation) {
    const results = [];
    for (const action of automation.actions ?? []) {
      try {
        await this.devices.runForActor({
          homeId: automation.homeId,
          deviceId: action.deviceId,
          command: action.command,
          actorIdentityRef: `automation:${automation._id}`,
          detail: { source: "automation", automationId: automation._id, automationName: automation.name },
        });
        results.push({ deviceId: action.deviceId, command: action.command, outcome: "confirmed" });
      } catch (cause) {
        results.push({
          deviceId: action.deviceId,
          command: action.command,
          outcome: "failed",
          reason: cause?.message ?? "The device didn't confirm the action.",
        });
      }
    }
    return results;
  }

  view(automation) {
    return {
      _id: automation._id,
      homeId: automation.homeId,
      name: automation.name,
      trigger: automation.trigger,
      actions: automation.actions,
      enabled: automation.enabled,
      lastFiredAt: automation.lastFiredAt ?? null,
      createdBy: automation.createdBy,
      createdAt: automation.createdAt,
    };
  }

  /**
   * Automation actions are validated fail-closed at write time: devices
   * must exist in the SAME home with a known command shape.
   */
  async #cleanActions(homeId, rawActions) {
    const rows = Array.isArray(rawActions) ? rawActions : null;
    if (!rows?.length) {
      return fail("E_VALIDATION", "An automation needs at least one device action.");
    }
    const actions = [];
    for (const row of rows) {
      const deviceId = typeof row?.deviceId === "string" ? row.deviceId : null;
      const command = row?.command;
      if (!deviceId || !validCommandShape(command)) {
        return fail("E_VALIDATION", "Every automation action needs a device and its command.");
      }
      const device = await this.devices.devices.findOne({ _id: deviceId });
      if (!device || device.homeId !== homeId) {
        return fail("E_NOT_PERMITTED", "An automation action reaches a device outside the home in view — that was refused.");
      }
      actions.push({ deviceId, command });
    }
    return actions;
  }
}

/** Validate the plain-form trigger: event class plus honest conditions. */
function cleanTrigger(trigger) {
  const eventClass = typeof trigger?.eventClass === "string" ? trigger.eventClass.trim() : "";
  if (!eventClass || eventClass.length > 64) {
    return fail("E_VALIDATION", "An automation needs the event class it listens for (a vehicle entering, a person arriving...).");
  }
  const cleaned = { eventClass };
  if (typeof trigger.areaId === "string" && trigger.areaId) cleaned.areaId = trigger.areaId;
  const window = trigger.timeWindow ?? null;
  if (window && typeof window === "object") {
    const clean = {};
    if (window.afterDark === true) clean.afterDark = true;
    if (typeof window.from === "string" && window.from) {
      if (!HH_MM.test(window.from)) return fail("E_VALIDATION", "A time window's from uses HH:mm (hub-local clock).");
      clean.from = window.from;
    }
    if (typeof window.to === "string" && window.to) {
      if (!HH_MM.test(window.to)) return fail("E_VALIDATION", "A time window's to uses HH:mm (hub-local clock).");
      clean.to = window.to;
    }
    if (Object.keys(clean).length > 0) cleaned.timeWindow = clean;
  }
  return cleaned;
}

const HH_MM = /^([01]\d|2[0-3]):[0-5]\d$/;

/**
 * Hub-local clock window check. Returns true/false, or null when the
 * window is malformed (validation refuses those at write time; historical
 * rows fail closed).
 */
export function clockWindow(isoAt, window) {
  if (!window?.from || !window?.to) return true;
  const minutes = isoMinutes(isoAt);
  if (minutes == null) return null;
  const from = toMinutes(window.from);
  const to = toMinutes(window.to);
  return from <= to
    ? minutes >= from && minutes < to
    : minutes >= from || minutes < to; // windows may wrap midnight
}

function isoMinutes(iso) {
  // Deterministic: the window evaluates against the event timestamp's own
  // (ISO/UTC) clock, not the runtime host's timezone.
  const match = /T(\d{2}):(\d{2})/.exec(String(iso ?? ""));
  if (!match) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (!Number.isFinite(hours) || !Number.isFinite(minutes) || hours > 23 || minutes > 59) return null;
  return hours * 60 + minutes;
}

function toMinutes(hhmm) {
  const [hours, minutes] = String(hhmm).split(":").map(Number);
  return hours * 60 + minutes;
}

function byCreatedAt(a, b) {
  return String(a.createdAt).localeCompare(String(b.createdAt));
}

function defaultNow() {
  return new Date().toISOString();
}

export default AutomationService;
