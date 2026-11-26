import { delegate } from "./transport.js";

/**
 * Event controller (PORCH-139). Transport-specific: extracts the Bearer
 * token and params, delegates to the event service, and maps typed errors.
 * No domain operations live here (routes stay thin, services own models).
 */
export class EventController {
  /**
   * @param {import("../services/event.service.js").EventService} service
   * @param {(token: string | null) => Promise<{ did } | null>} resolveSession
   *     The identity plane's verifier (wired by assembly from the hub's
   *     injected verifySession) — the actor on a flag write.
   */
  constructor(service, resolveSession = null) {
    this.service = service;
    this.resolveSession = resolveSession ?? (async () => null);
  }

  bearer(req) {
    const header = req.headers?.authorization ?? "";
    return header.startsWith("Bearer ") ? header.slice(7) : null;
  }

  /** GET /homes/:homeId/events — the alert surface of record (bounded page). */
  async list(req, res) {
    return delegate(res, () => this.service.list({
      accessToken: this.bearer(req), homeId: req.params?.homeId, limit: req.query?.limit, offset: req.query?.offset,
    }));
  }

  /** GET /events/:eventId — the alert opens its event and evidence. */
  async get(req, res) {
    return delegate(res, () => this.service.get({ accessToken: this.bearer(req), eventId: req.params?.eventId }));
  }

  /** POST /events/:eventId/flag — the user marks an incorrect event. */
  async flag(req, res) {
    const session = await this.resolveSession(this.bearer(req));
    return delegate(res, () => this.service.flag({
      accessToken: this.bearer(req), eventId: req.params?.eventId, did: session?.did ?? null,
    }));
  }
}

export default EventController;
