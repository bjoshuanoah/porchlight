import { requireSignedSession, requireSession } from "../util/writes.js";
import { cleanName } from "./home.service.js";
import { ACCESS_OWNER_ONLY, visibleAreaIds } from "./scopes.js";

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
   * @param {{ devices?: import("@porchlight/shared").CollectionLike }} [deps]
   *   The home's device collection, for view-scope filtering of the grouping
   *   surface (PORCH-138): a granted device's area renders even when the
   *   grant doesn't name the area itself.
   */
  constructor(areas, homes, now = defaultNow, { devices = null } = {}) {
    this.areas = areas;
    this.homes = homes;
    this.devices = devices;
    this.now = now;
  }

  /** POST /homes/:homeId/areas — one new room or outdoor area. Signed member write. */
  async create({ accessToken, homeId, payload, signature } = {}) {
    const authorized = await this.homes.authorize({ accessToken, homeId });
    if (authorized.access?.accessClass !== "owner-membership") {
      return fail("E_NOT_PERMITTED", ACCESS_OWNER_ONLY);
    }
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
    const authorizedUpdate = await this.homes.authorize({ accessToken, homeId: area.homeId });
    if (authorizedUpdate.access?.accessClass !== "owner-membership") {
      return fail("E_NOT_PERMITTED", ACCESS_OWNER_ONLY);
    }
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

  /**
   * GET /homes/:homeId/areas — the home's grouping surface, order ascending.
   * A visit grant sees only the areas its view covers (named by an area
   * scope, or an area carrying a granted device's scope) — the grouping
   * surface shows a visitor exactly their granted slice of the home.
   */
  async list({ accessToken, homeId } = {}) {
    const { did } = await requireSession({ accessToken, verifySession: this.homes.verifySession });
    return this.listForActor({ did, homeId });
  }

  /**
   * GET /homes/:homeId/areas, session-free — the same authorizeMember
   * verdicts, the same view-scope filter (a visit grant sees only the
   * areas its view covers).
   */
  async listForActor({ did, homeId } = {}) {
    const authorized = await this.homes.authorizeMember({ did, homeId });
    const rows = await this.areas.find({ homeId });
    const scopes = authorized.access?.scopes ?? null;
    let visible = rows;
    if (scopes) {
      const deviceRows = this.devices ? await this.devices.find({ homeId }) : [];
      const ids = visibleAreaIds(scopes, deviceRows);
      visible = rows.filter((area) => ids.has(area._id));
    }
    return {
      areas: visible
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
