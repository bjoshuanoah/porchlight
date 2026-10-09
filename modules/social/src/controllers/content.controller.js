/**
 * Content controller (PORCH-006). Transport-specific only: extracts the
 * Bearer membership token and the signed payload from HTTP, delegates the
 * domain to the services, and maps typed errors to plain-language HTTP.
 * Routes and controllers must not perform domain operations.
 *
 * Origin scoping note: every surface here is token-derived. The membership
 * token carries exactly one network scope; the services make that scope the
 * only origin a request can touch, so no route path carries the origin and
 * no endpoint accepts an interaction across origins.
 */
export class ContentController {
  /**
   * @param {object} deps
   * @param {import("../services/post.service.js").PostService} deps.posts
   * @param {import("../services/interaction.service.js").InteractionService} deps.interactions
   * @param {import("../services/notification.service.js").NotificationService} deps.notifications
   */
  constructor({ posts, interactions, notifications }) {
    this.posts = posts;
    this.interactions = interactions;
    this.notifications = notifications;
  }

  /** POST /posts — signed post creation (ac-1; cross-post via crossPostRef, ac-2). */
  createPost = async (req, res) => {
    const { payload, signature } = req.body ?? {};
    return this.#delegate(res, () => this.posts.create({ accessToken: this.bearer(req), payload, signature }));
  };

  /** GET /posts — the origin network's timeline read (members only). */
  listPosts = async (req, res) => {
    return this.#delegate(res, () => this.posts.list({ accessToken: this.bearer(req) }));
  };

  /** GET /posts/:postId — member post view (no rank inputs, no vote data). */
  getPost = async (req, res) => {
    return this.#delegate(res, () =>
      this.posts.get({ accessToken: this.bearer(req), postId: req.params?.postId }),
    );
  };

  /** POST /posts/:postId/comments — signed comment (ac-3). */
  comment = async (req, res) => {
    const { payload, signature } = req.body ?? {};
    return this.#delegate(res, () =>
      this.interactions.comment({ accessToken: this.bearer(req), payload, signature }),
    );
  };

  /** GET /posts/:postId/comments — member thread read. */
  listComments = async (req, res) => {
    return this.#delegate(res, () =>
      this.interactions.commentThread({ accessToken: this.bearer(req), postId: req.params?.postId }),
    );
  };

  /** POST /posts/:postId/reactions — signed open-vocabulary reaction (ac-4). */
  react = async (req, res) => {
    const { payload, signature } = req.body ?? {};
    return this.#delegate(res, () =>
      this.interactions.react({ accessToken: this.bearer(req), payload, signature }),
    );
  };

  /** GET /posts/:postId/reactions — as-authored emoji values. */
  listReactions = async (req, res) => {
    return this.#delegate(res, () =>
      this.interactions.reactionsFor({ accessToken: this.bearer(req), postId: req.params?.postId }),
    );
  };

  /** POST /posts/:postId/votes — signed changeable private vote (ac-4). */
  vote = async (req, res) => {
    const { payload, signature } = req.body ?? {};
    return this.#delegate(res, () =>
      this.interactions.vote({ accessToken: this.bearer(req), payload, signature }),
    );
  };

  /** DELETE /posts/:postId — author-signed post deletion with cascade (ac-5). */
  deletePost = async (req, res) => {
    return this.#delegate(res, () =>
      this.posts.deletePost({
        accessToken: this.bearer(req),
        postId: req.params?.postId,
        signature: req.body?.signature,
      }),
    );
  };

  /** DELETE /me/content — the member's signed deletion sweep at the origin (ac-5). */
  sweepMemberContent = async (req, res) => {
    return this.#delegate(res, () =>
      this.posts.memberContentSweep({ accessToken: this.bearer(req), signature: req.body?.signature }),
    );
  };

  /** GET /notifications — the member's content-free inbox (ac-3). */
  inbox = async (req, res) => {
    return this.#delegate(res, () => this.notifications.inbox({ accessToken: this.bearer(req) }));
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

  /**
   * Member-facing error mapping: typed errors carry plain-language
   * messages; unknown codes never leak raw internals.
   */
  memberError(res, error) {
    const statusByCode = {
      E_MUST_SIGN_IN: 401,
      E_NOT_PERMITTED: 403,
      E_SIGNATURE_REQUIRED: 403,
      E_SIGNATURE_INVALID: 403,
      E_DEVICE_NOT_ENROLLED: 403,
      E_DEVICE_REQUIRED: 400,
      E_NOT_A_MEMBER: 403,
      E_POST_NOT_FOUND: 404,
      E_TYPE_REQUIRED: 400,
      E_BODY_REQUIRED: 400,
      E_MEDIA_REQUIRED: 400,
      E_COMMENT_BODY_REQUIRED: 400,
      E_PARENT_UNKNOWN: 400,
      E_REPLY_TOO_DEEP: 400,
      E_MENTION_INVALID: 400,
      E_MENTION_NOT_MEMBER: 400,
      E_EMOJI_REQUIRED: 400,
      E_REACTION_EXISTS: 409,
      E_INVALID_VOTE: 400,
      E_GROUP_UNKNOWN: 404,
      E_GROUP_NOT_MEMBER: 403,
    };
    const status = statusByCode[error.code] ?? 500;
    const message =
      status === 500
        ? "Something went wrong on the hub. Try again, or contact the network owner."
        : error.message;
    res.status(status).json({ error: message, code: error.code ?? "E_INTERNAL" });
  }
}

export default ContentController;