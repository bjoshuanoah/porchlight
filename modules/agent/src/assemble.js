import { ProfileService } from "./services/profiles.service.js";
import { AssignmentService } from "./services/assignments.service.js";
import { ResolutionService } from "./services/resolution.service.js";
import { ProvenanceService } from "./services/provenance.service.js";
import { AgentAuditService } from "./services/audit.service.js";
import { GovernanceController } from "./controllers/governance.controller.js";
import { MemberController } from "./controllers/member.controller.js";
import { createAgentRouter } from "./routes.js";
import { createProfileInferenceProvider, AGENT_TYPE_HOUSEHOLD_MEMBER } from "./inference/profile-provider.js";

/**
 * Agent module assembly (PORCH-148). Builds the full route → controller →
 * service → model path from an injected domain store — the same pure-DI
 * shape the other modules assemble with. The agent domain owns every agent
 * collection; identity is referenced only through the injected callbacks
 * (the module imports no identity source — CI-enforced by the boundary
 * check), and the profile-routed inference rides @porchlight/agent-runtime's
 * composition seam 1 exactly.
 *
 * @param {import("@porchlight/shared").StoreLike} store
 * @param {{
 *   verifySession: (token: string | null) => Promise<{ did: string, deviceId?: string } | null>,
 *     The identity-plane access-token verifier (assembled into every module
 *     the same way — the device-bound identity plane is the only auth
 *     surface).
 *   adminFacts?: {
 *     isAdmin: (did: string) => Promise<boolean> | boolean,
 *       The hub-admin fact of record (who defines profiles, assigns them,
 *       and flips availability). Unwired → the admin operations fail closed.
 *   },
 *   familyFacts?: {
 *     familiesForMember: (did: string) => Promise<Array<{ _id: string, name?: string, parentIdentityRefs: string[], memberIdentityRefs: string[] }>>,
 *       The identity-plane family facts the parental narrowing resolves
 *       against (consumed via identity services, never a model import).
 *   },
 *   onProfileChange?: (event: object) => void,
 *     The live-apply change seam: every profile/assignment/narrowing write
 *     publishes here (the wiring onto the hub's realtime transport rides
 *     the consuming surface). Live-apply itself is inherent — inference
 *     re-resolves the profile on every call, no restart.
 *   agentTypeFor?: (memberId: string) => string | Promise<string>,
 *     The member's agent type resolver; default AGENT_TYPE_HOUSEHOLD_MEMBER.
 *   now?: () => string,
 * }} [options]
 */
export function assembleAgentModule(store, options = {}) {
  const now = options.now ?? (() => new Date().toISOString());
  const collection = store.collection.bind(store);
  const inferenceProfiles = collection("inference_profiles");
  const profileAssignments = collection("profile_assignments");
  const memberProfilePermissive = collection("member_profile_permissive");
  const inferenceProvenance = collection("inference_provenance");
  const agentAudit = collection("agent_audit");

  const audit = new AgentAuditService(agentAudit, now);
  const publishChange = typeof options.onProfileChange === "function" ? options.onProfileChange : null;
  const profiles = new ProfileService(inferenceProfiles, audit, { publishChange }, now);
  const isAdmin = options.adminFacts?.isAdmin ?? (() => false);
  const assignments = new AssignmentService(
    profileAssignments,
    memberProfilePermissive,
    profiles,
    audit,
    {
      isAdmin,
      familiesForMember: options.familyFacts?.familiesForMember ?? null,
      publishChange,
    },
    now,
  );
  const resolution = new ResolutionService(profileAssignments, memberProfilePermissive, profiles, isAdmin, now);
  const provenance = new ProvenanceService(inferenceProvenance, now);
  const agentTypeFor = options.agentTypeFor ?? null;

  const controllers = {
    governance: new GovernanceController({ profiles, assignments, provenance, verifySession: options.verifySession }),
    member: new MemberController({ profiles, assignments, resolution, provenance, verifySession: options.verifySession }),
  };

  return {
    api: createAgentRouter(controllers),
    controllers,
    profileService: profiles,
    assignmentService: assignments,
    resolutionService: resolution,
    provenanceService: provenance,
    auditService: audit,
    /** The profile-routed inference seam consumer (composition seam 1). */
    createProfileInference: ({ providers, log = null } = {}) =>
      createProfileInferenceProvider({
        resolve: (input) => resolution.resolve({ ...input, agentType: input.agentType ?? (agentTypeFor ? agentTypeFor(input.memberId) : null) }),
        providers,
        provenance,
        profiles,
        agentTypeFor,
        log,
        now,
      }),
    agentType: AGENT_TYPE_HOUSEHOLD_MEMBER,
  };
}

export default assembleAgentModule;
