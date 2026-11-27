import { delegate } from "./transport.js";

/**
 * Home controller (PORCH-137). Transport-specific: extracts the Bearer
 * identity token and the signed payload from HTTP, delegates the domain to
 * the services, and maps typed errors to plain-language HTTP. No domain
 * operations live here (routes stay thin, services own the models).
 */
export class HomeController {
  constructor({ homes, areas, audit, grants }) {
    this.homes = homes;
    this.areas = areas;
    this.audit = audit;
    this.grants = grants ?? null;
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
    return delegate(res, () => this.homes.surfaces({ accessToken: this.bearer(req), homeId: req.params?.homeId }));
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

  async authoredAudit({ req, homeId, limit, offset }) {
    const authorized = await this.homes.authorize({ accessToken: this.bearer(req), homeId });
    // The property audit trail is a member surface — it names every actor
    // of the home, a thing a visit grant never rides (grants carry granted
    // controls only).
    if (authorized.access?.accessClass !== "owner-membership") {
      const error = new Error("The activity trail belongs to this home's members — a visit grant carries only its granted controls.");
      error.code = "E_NOT_PERMITTED";
      throw error;
    }
    return this.audit.list({ homeId, limit, offset });
  }

  /** POST /homes/:homeId/grants — the owner grants (signed write). */
  createGrant = async (req, res) => {
    const { payload, signature } = req.body ?? {};
    return delegate(res, () => this.grants.create({ accessToken: this.bearer(req), homeId: req.params?.homeId, payload, signature }));
  };

  /** GET /homes/:homeId/grants — the owner's Access surface of record. */
  listGrants = async (req, res) => {
    return delegate(res, () => this.grants.list({ accessToken: this.bearer(req), homeId: req.params?.homeId }));
  };

  /** POST /grants/:grantId/revoke — the owner ends the visit. */
  revokeGrant = async (req, res) => {
    const { payload, signature } = req.body ?? {};
    return delegate(res, () => this.grants.revoke({ accessToken: this.bearer(req), grantId: req.params?.grantId, payload, signature }));
  };

  /** POST /grants/:grantId/distributions — the acting parent distributes. */
  distributeGrant = async (req, res) => {
    const { payload, signature } = req.body ?? {};
    return delegate(res, () => this.grants.distribute({ accessToken: this.bearer(req), grantId: req.params?.grantId, payload, signature }));
  };
}

export default HomeController;
