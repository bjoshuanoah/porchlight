import { NetworkService } from "./services/network.service.js";
import { InviteService } from "./services/invite.service.js";
import { MembershipService } from "./services/membership.service.js";
import { QuotaService } from "./services/quota.service.js";
import { AuditService } from "./services/audit.service.js";
import { SocialBootstrapController } from "./controllers/social-bootstrap.controller.js";
import { FeedController } from "./controllers/feed.controller.js";
import { MembershipController } from "./controllers/membership.controller.js";
import { ConsoleController } from "./controllers/console.controller.js";
import { createSocialRouter } from "./routes.js";

/**
 * Social module assembly. Builds the full route → controller → service →
 * model path from an injected domain store — the same pure-DI shape
 * assembleIdentityModule uses. The social domain owns every social
 * collection; identity is referenced only by DID through the injected
 * verifier callback (`options.verifyMemberIdToken`, wired by apps/server
 * from the identity module's session lookup — social imports no identity
 * source, CI-enforced).
 *
 * @param {import("@porchlight/shared").StoreLike} store
 * @param {{
 *   hubUrl?: () => string | null,
 *   ledger?: { record: (step: string, detail?: object) => Promise<void> },
 *   verifyMemberIdToken?: (idToken: string | null) => Promise<{ did: string } | null>,
 * }} [options]
 */
export function assembleSocialModule(store, options = {}) {
  const ledger = options.ledger ?? { record: async () => {} };
  const collection = store.collection.bind(store);
  const networks = collection("networks");
  const invites = collection("invites");
  const memberships = collection("memberships");
  const membershipSessions = collection("membership_sessions");
  const deviceKeys = collection("device_keys");
  const artifacts = collection("artifacts");
  const auditEvents = collection("audit_events");

  const auditService = new AuditService(auditEvents, ledger);
  const audit = auditService.recorderFor(null);
  const networkService = new NetworkService(networks);
  const inviteService = new InviteService(invites);
  const membershipService = new MembershipService({
    memberships,
    membershipSessions,
    deviceKeys,
    invites: inviteService,
    verifyMemberIdToken: options.verifyMemberIdToken ?? (async () => null),
    networks,
    audit,
  });
  const quotaService = new QuotaService({ artifacts, networks, audit });

  const controllers = {
    bootstrap: new SocialBootstrapController(networkService, inviteService, ledger),
    feed: new FeedController(),
    membership: new MembershipController(membershipService, networkService),
    console: new ConsoleController({
      networks: networkService,
      invites: inviteService,
      membership: membershipService,
      quota: quotaService,
      audit: auditService,
    }),
  };

  return {
    networkService,
    inviteService,
    membershipService,
    quotaService,
    auditService,
    controllers,
    api: createSocialRouter(controllers),
  };
}

export default assembleSocialModule;