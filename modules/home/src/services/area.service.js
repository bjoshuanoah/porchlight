import { requireSignedSession } from "../util/writes.js";
import { cleanName } from "./home.service.js";

/**
 * Area service (PORCH-137 TS 1). Rooms and outdoor areas are one
 * collection so the family app renders one grouping surface: indoor rooms
 * and outdoor areas (driveway, walkway, porch class) group the home's
 * devices, each rendering with its order in the home's surfaces.
 */
export class AreaService {
  /**
   * @param {import("@porchlight/shared").CollectionLike} areas
   * @param {import("./home.service.js").HomeService} homes
   * @param {() => string} [now]
   */
  constructor(areas, homes, now = defaultNow) {
    this.areas = areas;
    this.homes = homes;
    this.now = now;
  }

  /** POST /homes/:homeId/areas — one new room or outdoor area. Signed member write. */
  async create({ accessToken, homeId, payload, signature } = {}) {
    await this.homes.authorize({ accessToken, homeId });
    await requireSignedSession({
      accessToken, payload, signature,
      verifySession: this.homes.verifySession,
      registeredDeviceKey: this.homes.registeredDeviceKey,
    });
    const name = cleanName(payload?.name);
    const kind = payload?.kind === "outdoor" ? "outdoor" : "room";
    const area = {
      _id: `area_${crypto.randomUUID()}`,
      homeId,
      kind,
      name,
      order: Number.isInteger(payload?.order) ? payload.order : await this.#nextOrder(homeId),
      createdAt: this.now(),
    };
    await this.areas.insertOne(area);
    return { area: this.areaView(area) };
  }

  /** PUT /areas/:areaId — rename or reorder one area of a home you belong to. Signed member write. */
  async update({ accessToken, areaId, payload, signature } = {}) {
    const area = await this.areas.findOne({ _id: areaId });
    if (!area) {
      return fail("E_AREA_NOT_FOUND", "That area isn't part of this home's surfaces anymore.");
    }
    await this.homes.authorize({ accessToken, homeId: area.homeId });
    await requireSignedSession({
      accessToken, payload, signature,
      verifySession: this.homes.verifySession,
      registeredDeviceKey: this.homes.registeredDeviceKey,
    });
    const set = {};
    if (payload?.name !== undefined) set.name = cleanName(payload.name);
    if (payload?.order !== undefined) {
      if (!Number.isInteger(payload.order)) {
        return fail("E_VALIDATION", "An area's order has to be a whole number.");
      }
      set.order = payload.order;
    }
    if (Object.keys(set).length > 0) {
      const updated = await this.areas.updateOne({ _id: areaId }, { $set: set });
      if (!updated) return fail("E_AREA_NOT_FOUND", "That area isn't part of this home's surfaces anymore.");
    }
    return { area: this.areaView({ ...area, ...set }) };
  }

  /** GET /homes/:homeId/areas — the home's grouping surface, order ascending. */
  async list({ accessToken, homeId } = {}) {
    await this.homes.authorize({ accessToken, homeId });
    const rows = await this.areas.find({ homeId });
    return {
      areas: rows
        .sort((a, b) => (a.order - b.order) || String(a.name).localeCompare(String(b.name)))
        .map((area) => this.areaView(area)),
    };
  }

  areaView(area) {
    return {
      _id: area._id,
      homeId: area.homeId,
      kind: area.kind,
      name: area.name,
      order: area.order,
      createdAt: area.createdAt,
    };
  }

  async #nextOrder(homeId) {
    const rows = await this.areas.find({ homeId });
    return rows.reduce((max, area) => Math.max(max, Number(area.order) || 0), 0) + 1;
  }
}

function fail(code, message) {
  const error = new Error(message);
  error.code = code;
  throw error;
}

function defaultNow() {
  return new Date().toISOString();
}

export default AreaService;
