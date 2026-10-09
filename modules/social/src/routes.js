import { Router } from "express";
import { FeedController } from "./controllers/feed.controller.js";
import { SocialBootstrapController } from "./controllers/social-bootstrap.controller.js";
import { NetworkService } from "./services/network.service.js";
import { InviteService } from "./services/invite.service.js";

/**
 * Social routes. Thin REST (and, later, MCP) surface that owns no domain
 * logic — delegates to the transport-specific controller, which calls the
 * service layer. The server injects the domain store (mongodb database
 * handle); the shared in-memory store is the dependency-free fallback for
 * embedded/test use.
 */
export function createSocialRouter({ store, ledger } = {}) {
  const db = store ?? { collection: () => ({}) };
  const networks = db.collection("networks");
  const invites = db.collection("invites");
  const bootstrap = new SocialBootstrapController(new NetworkService(networks), new InviteService(invites), ledger);
  const feed = new FeedController();
  const router = Router();
  router.post("/posts", feed.createPost);
  router.get("/network", bootstrap.get);
  router.post("/bootstrap/network", bootstrap.createNetwork);
  router.post("/bootstrap/invite", bootstrap.issueInvite);
  router.post("/bootstrap/invite/revoke", bootstrap.revokeInvite);
  return router;
}

export default createSocialRouter;