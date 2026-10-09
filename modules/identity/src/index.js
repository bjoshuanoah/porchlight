/**
 * Identity domain — published entry. Social references identity by
 * identifier (the DID) through this surface only: the routers, the trust
 * services cross-hub verification, and the module factory. Internal model
 * files are never imported across the module boundary.
 */
export { createIdentityRouter, createWellKnownRouter } from "./routes.js";
export { assembleIdentityModule } from "./assemble.js";
export { TrustService } from "./services/trust.service.js";