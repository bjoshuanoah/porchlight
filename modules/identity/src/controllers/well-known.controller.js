/**
 * Well-known controller: transport only. Standards discovery surfaces of the
 * identity hub — WebFinger (handle plane), OIDC discovery, the member-auth
 * JWKS, and the did-doc-plane public keys used to verify migration handoffs.
 * Federation adapters do not exist in V1 (perimeter fence, ac-10): nothing
 * here admits inbound identity resolution, membership, or content.
 */
export class WellKnownController {
  /**
   * @param {{ webfingerService: import("../services/webfinger.service.js").WebfingerService,
   *             signing: import("../services/signing.service.js").HubSigningService,
   *             hubUrlFn: () => string|null }} deps
   */
  constructor({ webfingerService, signing, hubUrlFn }) {
    this.webfingerService = webfingerService;
    this.signing = signing;
    this.hubUrlFn = hubUrlFn;
  }

  /** GET /.well-known/webfinger?resource=acct:<handle> — resolution to the DID. */
  webfinger = async (req, res) => {
    const resource = req.query.resource;
    if (!resource) return res.status(400).json({ error: "resource required", code: "E_RESOURCE_REQUIRED" });
    const jrd = await this.webfingerService.query(String(resource));
    if (!jrd) return res.status(404).json({ error: "resource not found", code: "E_RESOURCE_NOT_FOUND" });
    res.type("application/jrd+json").json(jrd);
  };

  /** GET /.well-known/openid-configuration — issuer + jwks_uri discovery. */
  openidConfiguration = async (_req, res) => {
    const hubUrl = this.hubUrlFn();
    if (!hubUrl) return res.status(503).json({ error: "hub URL not yet captured (tunnel down)", code: "E_HUB_URL_UNKNOWN" });
    res.json({
      issuer: hubUrl,
      jwks_uri: `${hubUrl}/.well-known/jwks.json`,
      id_token_signing_alg_values_supported: ["EdDSA"],
      subject_types_supported: ["public"],
      response_modes_supported: ["query"],
      authorization_endpoint: `${hubUrl}/api/identity/oidc/authorize`,
      token_endpoint: `${hubUrl}/api/identity/oidc/token`,
      code_challenge_methods_supported: ["S256"],
    });
  };

  /** GET /.well-known/jwks.json — member-auth plane (kid-based rotation). */
  jwks = async (_req, res) => {
    res.json(await this.signing.jwks());
  };

  /** GET /.well-known/identity-keys.json — did-doc plane for handoff verification. */
  identityKeys = async (_req, res) => {
    res.json(await this.signing.didDocPublicKeys());
  };
}

export default WellKnownController;