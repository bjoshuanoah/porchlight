/**
 * Push controller (PORCH-059). Transport-specific only: extracts the
 * Bearer membership token and the subscription document from HTTP,
 * delegates the domain to PushService, and maps typed errors to
 * plain-language HTTP. Routes and controllers must not perform domain
 * operations.
 */
export class PushController {
  /**
   * @param {object} deps
   * @param {import("../services/push.service.js").PushService} deps.push
   */
  constructor({ push }) {
    this.push = push;
  }

  /** GET /push/vapid — the subscription route serves the VAPID public key (ac-5). */
  vapid = async (req, res) => {
    return this.#delegate(res, async () => this.push.vapidKey());
  };

  /** POST /push/subscriptions — identity-scoped registration (ac-1). */
  register = async (req, res) => {
    const { endpoint, keys } = req.body ?? {};
    return this.#delegate(res, () => this.push.registerSubscription({ accessToken: this.bearer(req), endpoint, keys }));
  };

  /** DELETE /push/subscriptions — identity-scoped removal. */
  unregister = async (req, res) => {
    return this.#delegate(res, () => this.push.unregisterSubscription({ accessToken: this.bearer(req), endpoint: req.body?.endpoint }));
  };

  /** GET /push/settings — the member's own controls. */
  getSettings = async (req, res) => {
    return this.#delegate(res, () => this.push.memberSettings({ accessToken: this.bearer(req) }));
  };

  /** PUT /push/settings — the member's own controls (hub-enforced at send). */
  updateSettings = async (req, res) => {
    const body = req.body ?? {};
    return this.#delegate(res, () =>
      this.push.updateSettings({
        accessToken: this.bearer(req),
        enabled: body.enabled,
        events: body.events,
        mutes: body.mutes,
      }),
    );
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
      return this.pushError(res, error);
    }
  }

  /**
   * Member-facing error mapping: typed errors carry plain-language
   * messages; unknown codes never leak raw internals.
   */
  pushError(res, error) {
    const statusByCode = {
      E_MUST_SIGN_IN: 401,
      E_NOT_PERMITTED: 403,
      E_PUSH_ENDPOINT_REQUIRED: 400,
      E_PUSH_KEYS_REQUIRED: 400,
      E_PUSH_SETTINGS_INVALID: 400,
      E_PUSH_MUTE_NOT_MEMBER: 403,
    };
    const status = statusByCode[error?.code] ?? 500;
    if (status === 500) {
      return res.status(500).json({ error: "Something went wrong on the hub. Please try again." });
    }
    return res.status(status).json({ error: error?.message ?? "Something went wrong on the hub.", code: error?.code });
  }
}

export default PushController;