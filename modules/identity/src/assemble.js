import { AuthService } from "./services/auth.service.js";
import { DeviceService } from "./services/device.service.js";
import { DidService } from "./services/did.service.js";
import { WebfingerService } from "./services/webfinger.service.js";
import { AccountService } from "./services/account.service.js";
import { TrustService } from "./services/trust.service.js";
import { MigrationService } from "./services/migration.service.js";
import { HubSigningService, sha256 } from "./services/signing.service.js";
import { AuthController } from "./controllers/auth.controller.js";
import { AccountController } from "./controllers/account.controller.js";
import { DeviceController } from "./controllers/device.controller.js";
import { DidController } from "./controllers/did.controller.js";
import { OidcController } from "./controllers/oidc.controller.js";
import { MigrationController } from "./controllers/migration.controller.js";
import { WellKnownController } from "./controllers/well-known.controller.js";
import { createIdentityRouter, createWellKnownRouter } from "./routes.js";

/**
 * Identity module assembly. Builds the full route → controller → service →
 * model path from an injected domain store (+ optional hub-URL provider):
 * the identity module owns every identity collection; social references
 * identity by DID only and never imports this file's internals.
 *
 * @param {import("@porchlight/shared").StoreLike} store
 * @param {{ hubUrl?: () => string|null, ledger?: { record: (step: string, detail?: object) => Promise<void> }, adoptionEnabled?: boolean }} [options]
 *        `adoptionEnabled` (PORCH-026) re-enters second-hub identity
 *        adoption: flag-hidden by default (V1 build offers creation only).
 */
export function assembleIdentityModule(store, options = {}) {
  const hubUrlFn = options.hubUrl ?? (() => null);
  const ledger = options.ledger ?? { record: async () => {} };
  const collection = store.collection.bind(store);
  const signing = new HubSigningService(collection("issuer_keys"));
  const didService = new DidService({ identities: collection("identities"), didDocuments: collection("did_documents"), signing });
  const deviceService = new DeviceService({
    deviceRegistrations: collection("device_registrations"),
    pairingCodes: collection("pairing_codes"),
    deviceLinks: collection("device_links"),
    sessions: collection("sessions"),
    hash: sha256,
  });
  const authService = new AuthService({
    challenges: collection("challenges"),
    sessions: collection("sessions"),
    deviceRegistrations: collection("device_registrations"),
    hash: sha256,
  });
  const webfingerService = new WebfingerService({ didService, hubUrlFn });
  const accountService = new AccountService({
    identities: collection("identities"),
    didService,
    deviceRegistrations: collection("device_registrations"),
    adoptionEnabled: options.adoptionEnabled === true,
  });
  const trustService = new TrustService({
    authCodes: collection("auth_codes"),
    sessions: collection("sessions"),
    signing,
    hubUrlFn,
  });
  const migrationService = new MigrationService({
    identities: collection("identities"),
    didDocuments: collection("did_documents"),
    deviceRegistrations: collection("device_registrations"),
    signing,
    didService,
    hubUrlFn,
  });

  const controllers = {
    auth: new AuthController(authService, didService),
    account: new AccountController(accountService, authService, ledger),
    device: new DeviceController(deviceService, authService),
    did: new DidController(didService),
    oidc: new OidcController(trustService, authService),
    migration: new MigrationController(migrationService, authService),
    wellKnown: new WellKnownController({ webfingerService, signing, hubUrlFn }),
  };

  return {
    signing,
    didService,
    accountService,
    authService,
    deviceService,
    webfingerService,
    trustService,
    migrationService,
    controllers,
    api: createIdentityRouter(controllers),
    wellKnown: createWellKnownRouter(controllers.wellKnown),
  };
}

export default assembleIdentityModule;