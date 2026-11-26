import { requireSignedSession } from "../util/writes.js";
import { fail } from "./errors.js";
import { cleanName } from "./home.service.js";
import { validCommandShape } from "./device.service.js";

/**
 * Scene service (PORCH-137 TS 1). One home, one ordered action list.
 * Running a scene executes each action through the confirmed-state command
 * path (single code path in DeviceService), so every executed action lands
 * its own audit row with the running member as actor and its own outcome;
 * the run answers per-action results — a scene run is never all-or-nothing.
 */
export class SceneService {
  /**
   * @param {import("@porchlight/shared").CollectionLike} scenes
   * @param {import("./home.service.js").HomeService} homes
   * @param {import("./device.service.js").DeviceService} devices
   * @param {() => string} [now]
   */
  constructor(scenes, homes, devices, now = defaultNow) {
    this.scenes = scenes;
    this.homes = homes;
    this.devices = devices;
    this.now = now;
  }

  /** POST /homes/:homeId/scenes — create one scene. Signed member write. */
  async create({ accessToken, homeId, payload, signature } = {}) {
    const { did } = await this.homes.authorize({ accessToken, homeId });
    await requireSignedSession({
      accessToken, payload, signature,
      verifySession: this.homes.verifySession,
      registeredDeviceKey: this.homes.registeredDeviceKey,
    });
    const name = cleanName(payload?.name);
    const actions = await this.#cleanActions(homeId, payload?.actions);
    const scene = {
      _id: `scene_${crypto.randomUUID()}`,
      homeId,
      name,
      actions,
      createdBy: did,
      deviceSignature: signature ?? null,
      createdAt: this.now(),
    };
    await this.scenes.insertOne(scene);
    return { scene: this.view(scene) };
  }

  async list({ accessToken, homeId } = {}) {
    await this.homes.authorize({ accessToken, homeId });
    const rows = await this.scenes.find({ homeId });
    return { scenes: rows.sort(byCreatedAt).map((scene) => this.view(scene)) };
  }

  /**
   * POST /scenes/:sceneId/run — run the scene from a home the caller
   * belongs to; per-action results with plain-language reasons.
   */
  async run({ accessToken, sceneId } = {}) {
    const scene = await this.scenes.findOne({ _id: sceneId });
    if (!scene) return fail("E_SCENE_NOT_FOUND", "That scene isn't part of this home anymore.");
    const { did } = await this.homes.authorize({ accessToken, homeId: scene.homeId });
    const results = [];
    for (const action of scene.actions ?? []) {
      const { outcome, reason } = await this.#runAction(scene, action, did);
      results.push({ deviceId: action.deviceId, command: action.command, outcome, ...(reason ? { reason } : {}) });
    }
    return { scene: this.view(scene), outcome: results.some((result) => result.outcome === "confirmed") ? "confirmed" : "failed", results };
  }

  async #runAction(scene, action, runnerDid) {
    try {
      const dispatched = await this.devices.runForActor({
        homeId: scene.homeId,
        deviceId: action.deviceId,
        command: action.command,
        actorIdentityRef: runnerDid,
        detail: { source: "scene", sceneId: scene._id, sceneName: scene.name },
      });
      return { outcome: dispatched?.outcome ?? "confirmed" };
    } catch (cause) {
      if (cause?.code === "E_NOT_PERMITTED" || cause?.code === "E_DEVICE_NOT_FOUND") {
        // Fail closed at run time too: a device vanished or moved homes
        // after the scene was written.
        return { outcome: "failed", reason: cause.message };
      }
      return { outcome: "failed", reason: cause?.message ?? "The device didn't confirm the action." };
    }
  }

  /**
   * Scene actions are validated fail-closed at write time: devices must
   * exist in the SAME home with a known command shape — a scene can never
   * reach across homes.
   */
  async #cleanActions(homeId, rawActions) {
    const rows = Array.isArray(rawActions) ? rawActions : null;
    if (!rows?.length) {
      return fail("E_VALIDATION", "A scene needs at least one device action.");
    }
    const actions = [];
    for (const row of rows) {
      const deviceId = typeof row?.deviceId === "string" ? row.deviceId : null;
      const command = row?.command;
      if (!deviceId || !validCommandShape(command)) {
        return fail("E_VALIDATION", "Every scene action needs a device and its command.");
      }
      const device = await this.devices.devices.findOne({ _id: deviceId });
      if (!device || device.homeId !== homeId) {
        return fail("E_NOT_PERMITTED", "A scene action reaches a device outside the home in view — that was refused.");
      }
      actions.push({ deviceId, command });
    }
    return actions;
  }

  view(scene) {
    return {
      _id: scene._id,
      homeId: scene.homeId,
      name: scene.name,
      actions: scene.actions,
      createdBy: scene.createdBy,
      createdAt: scene.createdAt,
    };
  }
}

function byCreatedAt(a, b) {
  return String(a.createdAt).localeCompare(String(b.createdAt));
}

function defaultNow() {
  return new Date().toISOString();
}

export default SceneService;
