import { fail } from "./errors.js";

/**
 * Device adapter seam (PORCH-137 TS 1, the engine's adapter principles:
 * replaceable plugins behind one seam). The home module owns the seam and
 * the command machinery; adapter implementations register by name at
 * assembly (Matter multi-admin is the first-class path, native vendor
 * adapters ride the same contract — nothing here is built to a specific
 * vendor fleet).
 *
 * Adapter contract (implementations must satisfy, contract-tested):
 *   name: string — must equal the device's adapter.name at resolution.
 *   commandsFor(capabilities) → [string] — the verbs this adapter serves
 *     for the device's capability list (e.g. ["turnOn", "turnOff"]).
 *   send({ device, command }) → { state, at? } — the resolved
 *     post-command state; read-back is the state of record. Throw on any
 *     failure (message becomes the plain-language reason).
 *   readState({ device }) → { state, at? } — hub-initiated read-back.
 *   onReport?(handler) — optional: the physical-state reporting path
 *     (someone flips a wall switch); the adapter calls handler with
 *     { deviceRef, state, source? } exactly once per real change.
 *
 * An unreachable adapter must fail FAST: the registry bounds every send
 * and read with a send-timeout race, so an unreachable device fails with
 * an explanation instead of a spinner to nowhere.
 */
export const DEVICE_COMMAND_TIMEOUT_MS = 10_000;

export class DeviceAdapterManager {
  constructor({ commandTimeoutMs = DEVICE_COMMAND_TIMEOUT_MS } = {}) {
    this.adapters = new Map();
    this.commandTimeoutMs = commandTimeoutMs;
    this.reportHandlers = new Set();
  }

  /** Register one adapter implementation by adapter name. */
  register(adapter) {
    if (!adapter || typeof adapter.name !== "string" || !adapter.name) {
      return fail("E_ADAPTER_INVALID", "A device adapter needs a name.");
    }
    if (typeof adapter.commandsFor !== "function" || typeof adapter.send !== "function" || typeof adapter.readState !== "function") {
      return fail("E_ADAPTER_INVALID", `Device adapter ${adapter.name} doesn't implement the adapter contract.`);
    }
    this.adapters.set(adapter.name, adapter);
    if (typeof adapter.onReport === "function") {
      adapter.onReport((event) => {
        for (const handler of this.reportHandlers) handler(event);
      });
    }
    return adapter;
  }

  /** The adapter bound to a device, or null — callers refuse plainly (E_NO_ADAPTER). */
  resolve(device) {
    const name = device?.adapter?.name;
    if (!name) return null;
    return this.adapters.get(name) ?? null;
  }

  /**
   * The verb list an adapter serves for a device's capabilities. Missing
   * adapter resolves to an empty list — the device cannot be commanded.
   */
  async commandsFor(device) {
    const adapter = this.resolve(device);
    if (!adapter) return [];
    const verbs = await adapter.commandsFor(device);
    return Array.isArray(verbs) ? verbs.filter((verb) => typeof verb === "string") : [];
  }

  /**
   * One bounded send: resolves { state, at } on confirmed read-back, fails
   * typed E_DEVICE_UNREACHABLE with the plain-language reason otherwise.
   */
  async send(device, command) {
    const adapter = this.resolve(device);
    if (!adapter) {
      return fail("E_DEVICE_UNREACHABLE", `No device adapter named "${name(device)}" is connected to this hub, so ${device.name} can't be reached.`);
    }
    const outcome = await bounded(
      Promise.resolve().then(() => adapter.send({ device, command })),
      this.commandTimeoutMs,
      `${device.name} didn't respond in time — the device may be asleep or offline.`,
    );
    return normalizeDeviceOutcome(outcome);
  }

  /** One bounded read-back: same contract as send. */
  async readState(device) {
    const adapter = this.resolve(device);
    if (!adapter) {
      return fail("E_DEVICE_UNREACHABLE", `No device adapter named "${name(device)}" is connected to this hub, so ${device.name} can't be read.`);
    }
    const outcome = await bounded(
      Promise.resolve().then(() => adapter.readState({ device })),
      this.commandTimeoutMs,
      `${device.name} didn't respond to a state read — the device may be asleep or offline.`,
    );
    return normalizeDeviceOutcome(outcome);
  }

  /** The physical-state reporting path: adapters push real changes here. */
  onReport(handler) {
    this.reportHandlers.add(handler);
  }
}

function normalizeDeviceOutcome(outcome) {
  if (!outcome || typeof outcome !== "object" || outcome.state === undefined) {
    return fail("E_DEVICE_UNREACHABLE", "The device confirmed the command but didn't report its resulting state — Porchlight won't assume the flip took hold.");
  }
  return { state: outcome.state, at: typeof outcome.at === "string" ? outcome.at : null };
}

async function bounded(promise, timeoutMs, timeoutMessage) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_resolve, reject) => {
        timer = setTimeout(() => {
          const error = new Error(timeoutMessage);
          error.code = "E_DEVICE_UNREACHABLE";
          reject(error);
        }, timeoutMs);
      }),
    ]);
  } catch (cause) {
    if (cause?.code) throw cause;
    const error = new Error(cause?.message || "The device didn't confirm its state.");
    error.code = "E_DEVICE_UNREACHABLE";
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

function name(device) {
  return String(device?.adapter?.name ?? "");
}
