import express, { Router } from "express";
import { AVATAR_MAX_UPLOAD_BYTES } from "./services/avatar.treatment.js";

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

  // Presentation plane: handle reassignment + profile fields — session-bound
  // to the did (a member reassigns/writes only their own identity)
  router.post("/handle", (req, res) => void controllers.account.setHandle(req, res));
  router.post("/account/profile", (req, res) => void controllers.account.recordProfile(req, res));

  // Member avatar (PORCH-070): the one Profile photo surface. The member's
  // own account read (GET /accounts/me) carries the avatar's per-rung
  // stamps; the write accepts the raw image upload (byte body, its signed
  // declaration in headers), the confirm commit, and the no-file clear
  // (device-signed JSON bodies) — all session-bound to the presenting did.
  router.get("/accounts/me", (req, res) => void controllers.account.me(req, res));
  router.post(
    "/accounts/me/avatar",
    // Over-cap uploads refuse with the named plain language BEFORE the
    // bytes buffer (Content-Length gate; body-parser's own limit below is
    // the belt for a lying length).
    (req, res, next) => {
      const length = Number(req.headers["content-length"] ?? 0);
      if (length > AVATAR_MAX_UPLOAD_BYTES) {
        return res.status(413).json({
          error: "That photo is larger than 5 MB. Try a smaller copy — every face is stored as a small square.",
          code: "E_AVATAR_TOO_LARGE",
        });
      }
      next();
    },
    // image/* bodies ride raw (route-level cap well above the 5 MB ingest
    // gate); JSON commit/clear bodies were parsed by the hub's global
    // express.json.
    express.raw({ type: (req) => typeof req?.headers?.["content-type"] === "string" && req.headers["content-type"].startsWith("image/"), limit: "12mb" }),
    (req, res) => void controllers.avatar.post(req, res),
  );

  // Avatar rendition serving (PORCH-070): the face bytes ride the same
  // contract the media pipeline's renditions serve — content-addressed
  // (`?v=<sha256>`), immutable Cache-Control, square geometry stamps. The
  // pending (pre-confirm) preview rides the same surface, owner-only. This
  // is the identity-surface rendition serving: no original exists to
  // serve (no rectangular retention), so nothing outside the rendition
  // surface is added.
  router.get("/avatars/:did/renditions/:kind", (req, res) => void controllers.avatar.serveRendition(req, res));

  // Canonical layer: DID document serving (cross-hub resolution)
  router.get("/did/:did", (req, res) => void controllers.did.getDocument(req, res));

  // Device continuity: registrations, pairing, owner-routed links, revocation
  router.get("/devices", (req, res) => void controllers.device.listRegistrations(req, res));
  router.post("/pairing-code", (req, res) => void controllers.device.mintPairingCode(req, res));
  router.post("/pair", (req, res) => void controllers.device.consumePairingCode(req, res));
  router.post("/device-link", (req, res) => void controllers.device.mintDeviceLink(req, res));
  router.post("/device-link/consume", (req, res) => void controllers.device.consumeDeviceLink(req, res));
  router.post("/devices/revoke", (req, res) => void controllers.device.revokeRegistration(req, res));

  // Cross-hub verification (OIDC shape): code path with nonce + PKCE —
  // session-bound to the did (a member authorizes only their own identity)
  router.post("/oidc/authorize", (req, res) => void controllers.oidc.authorize(req, res));
  router.post("/oidc/token", (req, res) => void controllers.oidc.token(req, res));

  // Identity mobility: session-bound handoff issuance, receiving-hub ingest
  // (the signed handoff token is the receiving hub's proof)
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