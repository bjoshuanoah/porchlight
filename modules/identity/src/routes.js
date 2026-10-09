import { Router } from "express";

/**
 * Identity module routes. Thin REST surface — controllers translate between
 * HTTP and the services; routes and controllers perform no domain logic.
 *
 * createIdentityRouter(controllers) takes the assembled controllers (see
 * assemble.js); createWellKnownRouter mounts the hub-level standards
 * discovery surfaces (WebFinger, OIDC discovery, JWKS, identity-plane keys)
 * at the domain's documented root paths.
 */

/** Member/API surface of the identity domain (mounted under /api/identity). */
export function createIdentityRouter(controllers) {
  const router = Router();

  // Session / device-key auth (challenge-signature proofs → tokens)
  router.post("/session/challenge", (req, res) => void controllers.auth.createChallenge(req, res));
  router.post("/session", (req, res) => void controllers.auth.createSession(req, res));
  router.post("/session/refresh", (req, res) => void controllers.auth.refresh(req, res));

  // Bootstrap: first account (mints DID + binds device key) and adoption
  router.get("/account", (req, res) => void controllers.account.get(req, res));
  router.post("/bootstrap/account", (req, res) => void controllers.account.createFirstAccount(req, res));
  router.post("/bootstrap/adopt", (req, res) => void controllers.account.adoptIdentity(req, res));

  // Presentation plane: handle reassignment + profile fields
  router.post("/handle", (req, res) => void controllers.account.setHandle(req, res));
  router.post("/account/profile", (req, res) => void controllers.account.recordProfile(req, res));

  // Canonical layer: DID document serving (cross-hub resolution)
  router.get("/did/:did", (req, res) => void controllers.did.getDocument(req, res));

  // Device continuity: registrations, pairing, owner-routed links, revocation
  router.get("/devices", (req, res) => void controllers.device.listRegistrations(req, res));
  router.post("/pairing-code", (req, res) => void controllers.device.mintPairingCode(req, res));
  router.post("/pair", (req, res) => void controllers.device.consumePairingCode(req, res));
  router.post("/device-link", (req, res) => void controllers.device.mintDeviceLink(req, res));
  router.post("/device-link/consume", (req, res) => void controllers.device.consumeDeviceLink(req, res));
  router.post("/devices/revoke", (req, res) => void controllers.device.revokeRegistration(req, res));

  // Cross-hub verification (OIDC shape): code path with nonce + PKCE
  router.post("/oidc/authorize", (req, res) => void controllers.oidc.authorize(req, res));
  router.post("/oidc/token", (req, res) => void controllers.oidc.token(req, res));

  // Identity mobility: operator handoff, receiving-hub ingest
  router.post("/migration/handoff", (req, res) => void controllers.migration.issueHandoff(req, res));
  router.post("/migration/receive", (req, res) => void controllers.migration.receiveMigration(req, res));

  return router;
}

/** Hub-level standards discovery surfaces (mounted at root by the server). */
export function createWellKnownRouter(wellKnownController) {
  const router = Router();
  router.get("/.well-known/webfinger", (req, res) => void wellKnownController.webfinger(req, res));
  router.get("/.well-known/openid-configuration", (req, res) => void wellKnownController.openidConfiguration(req, res));
  router.get("/.well-known/jwks.json", (req, res) => void wellKnownController.jwks(req, res));
  router.get("/.well-known/identity-keys.json", (req, res) => void wellKnownController.identityKeys(req, res));
  return router;
}

export default createIdentityRouter;