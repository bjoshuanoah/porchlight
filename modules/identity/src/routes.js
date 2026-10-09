import { Router } from "express";
import { AuthController } from "./controllers/auth.controller.js";
import { IdentityBootstrapController } from "./controllers/identity-bootstrap.controller.js";
import { AccountService } from "./services/account.service.js";

/**
 * Identity routes. Thin REST (and, later, MCP) surface that owns no domain
 * logic — delegates to the transport-specific controller, which calls the
 * service layer. The server injects the domain store (mongodb database
 * handle); the shared in-memory store is the dependency-free fallback for
 * embedded/test use.
 */
export function createIdentityRouter({ store, ledger } = {}) {
  const accounts = (store ?? { collection: () => ({}) }).collection("accounts");
  const controller = new IdentityBootstrapController(new AccountService(accounts), ledger);
  const auth = new AuthController();
  const router = Router();
  router.post("/session", auth.createSession);
  router.get("/account", controller.get);
  router.post("/bootstrap/account", controller.createFirstAccount);
  router.post("/bootstrap/adopt", controller.adoptIdentity);
  return router;
}

export default createIdentityRouter;