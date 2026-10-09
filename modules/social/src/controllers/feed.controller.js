/**
 * Feed controller (PORCH-007). Transport-specific only: extracts the Bearer
 * membership token and the query string, delegates the domain to the feed
 * service, and maps typed errors to plain-language HTTP. Routes and
 * controllers must not perform domain operations.
 *
 * No route here (or anywhere on the social surface) accepts or returns
 * hidden-list state (ac-4: client-local by contract) or any vote record,
 * count, or ratio (ac-3: vote privacy by contract).
 */
export class FeedController {
  /**
   * @param {object} deps
   * @param {import("../services/feed.service.js").FeedService} deps.feed
   */
  constructor({ feed }) {
    this.feed = feed;
  }

  /** GET /timeline — base timeline: origin posts, newest first by latest activity (ac-1). */
  timeline = async (req, res) => {
    return this.#delegate(res, () => this.feed.timeline({ accessToken: this.bearer(req) }));
  };

  /** GET /timeline/groups/:groupId — origin-filtered group timeline (ac-1). */
  groupTimeline = async (req, res) => {
    return this.#delegate(res, () =>
      this.feed.groupTimeline({ accessToken: this.bearer(req), groupId: req.params?.groupId }),
    );
  };

  /** GET /ranked — prominence order from the fixed published formula (ac-2). */
  ranked = async (req, res) => {
    return this.#delegate(res, () => this.feed.ranked({ accessToken: this.bearer(req) }));
  };

  /** GET /search?q= — plain-text search over captions, tags, album names (ac-5). */
  search = async (req, res) => {
    return this.#delegate(res, () => this.feed.search({ accessToken: this.bearer(req), query: req.query?.q }));
  };

  bearer(req) {
    const header = req.headers?.authorization ?? "";
    return header.startsWith("Bearer ") ? header.slice(7) : null;
  }

  async #delegate(res, work) {
    try {
      const result = await work();
      return res.status(200).json(result ?? { ok: true });
    } catch (error) {
      return this.memberError(res, error);
    }
  }

  /** Member-facing error mapping: same codes and shape as the content surface. */
  memberError(res, error) {
    const statusByCode = {
      E_MUST_SIGN_IN: 401,
      E_NOT_PERMITTED: 403,
      E_GROUP_UNKNOWN: 404,
      E_SEARCH_QUERY_REQUIRED: 400,
    };
    const status = statusByCode[error.code] ?? 500;
    const message =
      status === 500
        ? "Something went wrong on the hub. Try again, or contact the network owner."
        : error.message;
    res.status(status).json({ error: message, code: error.code ?? "E_INTERNAL" });
  }
}

export default FeedController;