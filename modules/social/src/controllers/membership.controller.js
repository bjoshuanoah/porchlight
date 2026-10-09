/**
 * Membership controller. Transport-specific: translates the join-link and
 * session surfaces between HTTP and the MembershipService; no domain logic.
 * Member-facing failures are plain-language (invite service owns the text).
 */
export class MembershipController {
  /**
   * @param {import("../services/membership.service.js").MembershipService} membership
   * @param {import("../services/network.service.js").NetworkService} networks
   */
  constructor(membership, networks) {
    this.membership = membership;
    this.networks = networks;
  }

  /**
   * GET /join/verify?code=… — the public verification endpoint the client
   * front door targets before pairing completes (reachable hub, valid
   * invite). Plain-language on every failure path.
   */
  verify = async (req, res) => {
    const result = await this.membership.verifyJoinLink(req.query?.code ?? null);
    if (!result.valid) {
      return res.status(200).json({ valid: false, code: result.code, message: result.message });
    }
    const network = await this.networks.get();
    res.json({
      valid: true,
      network: network ? { _id: network._id, name: network.name } : null,
      role: result.invite.role,
      joinUrl: result.invite.joinUrl ?? `/join/${result.invite.token}`,
    });
  };

  /**
   * POST /join/admit — server URL + invite code + identity-signed device.
   * Issues the membership token scoped to the invited network only.
   */
  admit = async (req, res) => {
    const {
      code,
      identityAccessToken,
      deviceId,
      devicePublicKeyJwk,
      signature,
    } = req.body ?? {};
    try {
      const admitted = await this.membership.admit({ code, identityAccessToken, deviceId, devicePublicKeyJwk, signature });
      return res.status(201).json(admitted);
    } catch (error) {
      return this.memberError(res, error);
    }
  };

  /** POST /session/refresh — rotate the access token off the refresh token. */
  refresh = async (req, res) => {
    try {
      const result = await this.membership.refresh({ refreshToken: req.body?.refreshToken });
      return res.json(result);
    } catch (error) {
      return this.memberError(res, error);
    }
  };

  /**
   * Member-facing error mapping: typed errors carry plain-language messages;
   * unknown codes become generic member text (never raw internals).
   */
  memberError(res, error) {
    const statusByCode = {
      E_MUST_SIGN_IN: 401,
      E_SESSION_REQUIRED: 401,
      E_SIGNATURE_REQUIRED: 403,
      E_SIGNATURE_INVALID: 403,
      E_PRIVATE_KEY_REJECTED: 403,
      E_KEY_TYPE_REJECTED: 403,
      E_KEY_REQUIRED: 403,
      E_DEVICE_NOT_ENROLLED: 403,
      E_NOT_A_MEMBER: 403,
      E_INVITE_REVOKED: 403,
      E_INVITE_EXHAUSTED: 410,
      E_INVITE_NOT_FOUND: 404,
      E_INVITE_REQUIRED: 400,
      E_DEVICE_REQUIRED: 400,
      E_NETWORK_REQUIRED: 409,
      E_NETWORK_NOT_FOUND: 404,
    };
    const status = statusByCode[error.code] ?? 500;
    const message =
      status === 500
        ? "Something went wrong on the hub. Try again, or contact the network owner."
        : error.message;
    res.status(status).json({ error: message, code: error.code ?? "E_INTERNAL" });
  }
}

export default MembershipController;