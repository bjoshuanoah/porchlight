import { delegate } from "./transport.js";

/**
 * Home controller (PORCH-137). Transport-specific: extracts the Bearer
 * identity token and the signed payload from HTTP, delegates the domain to
 * the services, and maps typed errors to plain-language HTTP. No domain
 * operations live here (routes stay thin, services own the models).
 */
export class HomeController {
  constructor({ homes, areas, audit, deviceService, sceneService, automationService }) {
    this.homes = homes;
    this.areas = areas;
    this.audit = audit;
    this.deviceService = deviceService ?? null;
    this.sceneService = sceneService ?? null;
    this.automationService = automationService ?? null;
  }

  bearer(req) {
    const header = req.headers?.authorization ?? "";
    return header.startsWith("Bearer ") ? header.slice(7) : null;
  }

  /** POST /homes — create one home (signed member write). */
  create = async (req, res) => {
    const { payload, signature } = req.body ?? {};
    return delegate(res, () => this.homes.create({ accessToken: this.bearer(req), payload, signature }));
  };

  /** GET /homes — the caller's homes. */
  list = async (req, res) => {
    return delegate(res, () => this.homes.list({ accessToken: this.bearer(req) }));
  };

  /**
   * GET /homes/:homeId — everything the home in view serves: home, areas,
   * devices, scenes, automations. Switching homes swaps exactly this
   * payload; every read is member-scoped hub-side.
   */
  get = async (req, res) => {
    return delegate(res, () => this.surfaces({ req, homeId: req.params?.homeId }));
  };

  /** PUT /homes/:homeId — rename (owner only). */
  rename = async (req, res) => {
    const { payload, signature } = req.body ?? {};
    return delegate(res, () => this.homes.rename({ accessToken: this.bearer(req), homeId: req.params?.homeId, payload, signature }));
  };

  /** GET /homes/:homeId/audit — the property audit trail page. */
  auditList = async (req, res) => {
    return delegate(res, () => this.authoredAudit({ req, homeId: req.params?.homeId, limit: req.query?.limit, offset: req.query?.offset }));
  };

  /** POST /homes/:homeId/areas — one room or outdoor area. */
  createArea = async (req, res) => {
    const { payload, signature } = req.body ?? {};
    return delegate(res, () => this.areas.create({ accessToken: this.bearer(req), homeId: req.params?.homeId, payload, signature }));
  };

  /** PUT /areas/:areaId — rename/reorder. */
  updateArea = async (req, res) => {
    const { payload, signature } = req.body ?? {};
    return delegate(res, () => this.areas.update({ accessToken: this.bearer(req), areaId: req.params?.areaId, payload, signature }));
  };

  /** GET /homes/:homeId/areas — the grouping surface. */
  listAreas = async (req, res) => {
    return delegate(res, () => this.areas.list({ accessToken: this.bearer(req), homeId: req.params?.homeId }));
  };

  async surfaces({ req, homeId }) {
    const { did, home, role } = await this.homes.authorize({ accessToken: this.bearer(req), homeId });
    const [areaList, deviceList, sceneList, automationList] = await Promise.all([
      this.areas.list({ accessToken: this.bearer(req), homeId }),
      this.deviceService?.list({ accessToken: this.bearer(req), homeId }) ?? { devices: [] },
      this.sceneService?.list({ accessToken: this.bearer(req), homeId }) ?? { scenes: [] },
      this.automationService?.list({ accessToken: this.bearer(req), homeId }) ?? { automations: [] },
    ]);
    return {
      home: { ...this.homes.homeView(home, role), viewerDid: did },
      areas: areaList.areas,
      devices: deviceList.devices,
      scenes: sceneList.scenes,
      automations: automationList.automations,
    };
  }

  async authoredAudit({ req, homeId, limit, offset }) {
    await this.homes.authorize({ accessToken: this.bearer(req), homeId });
    return this.audit.list({ homeId, limit, offset });
  }
}

export default HomeController;
