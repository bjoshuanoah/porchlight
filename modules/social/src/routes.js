import { Router } from "express";
import { FeedController } from "./controllers/feed.controller.js";

/**
 * Social routes. Thin REST (and, later, MCP) surface that owns no domain
 * logic — delegates to the transport-specific controller, which calls the
 * service layer.
 */
export function createSocialRouter() {
  const router = Router();
  const controller = new FeedController();
  router.post("/posts", controller.createPost);
  return router;
}

export default createSocialRouter;