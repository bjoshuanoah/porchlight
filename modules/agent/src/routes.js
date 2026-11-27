import { Router } from "express";

/**
 * Agent routes. Thin REST surface that owns no domain logic — the server
 * (or the test assembly) injects the fully assembled controllers. The
 * module rides the hub's /api/agent prefix.
 *
 * Governance paths (profiles, assignments, provenance, the family
 * organizer's permitted-profile write) carry the hub-admin gate in their
 * services; the parental paths carry the family-facts parent check.
 *
 * @param {{
 *   governance: import("./controllers/governance.controller.js").GovernanceController,
 *   member: import("./controllers/member.controller.js").MemberController,
 * }} controllers
 */
export function createAgentRouter({ governance, member }) {
  const router = Router();

  // Profiles: admin definitions and the availability flip (audited).
  router.post("/profiles", governance.createProfile);
  router.get("/profiles", governance.listProfiles);
  router.put("/profiles/:profileId/availability", governance.setAvailability);

  // Assignments: type defaults, member-specific overrides, revocation, and
  // the explicit unassigned state for a queried type.
  router.post("/assignments", governance.assign);
  router.delete("/assignments/:assignmentId", governance.revokeAssignment);
  router.get("/assignments", governance.listAssignments);

  // Provenance: the admin-visible trail (which model answered, under which
  // profile, at which time — plus degradations).
  router.get("/provenance", governance.provenanceList);

  // The family organizer's narrowing surface (PORCH-150 renders it; the
  // enforcement of every narrowing runs here, in the assignment path).
  router.post("/families/:familyId/members/:memberId/permitted-profiles", governance.parentalSet);
  router.get("/families/:familyId/members/:memberId/permitted-profiles", governance.parentalGet);

  // Migration (PORCH-151): the explicit per-member import of a nanobot-class
  // export artifact, and the per-member migration state the admin surface
  // renders. Admin-only in the service; the artifact is the only input.
  router.post("/migrations", governance.importMember);
  router.get("/migrations", governance.migrationStatus);

  // The member surface: the running model read, the selectable list, and the
  // self-selection attempt. Withheld profiles are invisible throughout.
  router.get("/me/model", member.myModel);
  router.get("/me/profiles", member.mySelectableProfiles);
  router.post("/me/model", member.myModelSet);

  return router;
}

export default createAgentRouter;
