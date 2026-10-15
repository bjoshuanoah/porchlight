/**
 * Identity domain — published entry. Social references identity by
 * identifier (the DID) through this surface only: the routers, the trust
 * services cross-hub verification, and the module factory. Internal model
 * files are never imported across the module boundary.
 */
export { createIdentityRouter, createWellKnownRouter } from "./routes.js";
export { assembleIdentityModule } from "./assemble.js";
export { TrustService } from "./services/trust.service.js";
/**
 * The member-avatar ingest treatment (PORCH-070), re-exported for the
 * group-avatar write (PORCH-088): the group surface rides the SAME
 * deterministic treatment (square crop then compression, geometry stamps,
 * no rectangular original retained) — the hub assembly wires it into the
 * social module's group service as an injected callback, so the module
 * boundary (no identity internals imported by social, CI-enforced) holds.
 */
export { treatAvatar, AVATAR_MAX_UPLOAD_BYTES } from "./services/avatar.treatment.js";