import { Router } from "express";
import { AuthController } from "./controllers/auth.controller.js";

/**
 * Identity routes. Thin REST (and, later, MCP) surface that owns no domain
 * logic — delegates to the transport-specific controller, which calls the
 * service layer.
 */
export function createIdentityRouter() {
  const router = Router();
  const controller = new AuthController();
  router.post("/session", controller.createSession);
  return router;
}

export default createIdentityRouter;