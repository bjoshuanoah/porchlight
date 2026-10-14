import { AuthService } from "./services/auth.service.js";
import { DeviceService } from "./services/device.service.js";
import { DidService } from "./services/did.service.js";
import { WebfingerService } from "./services/webfinger.service.js";
import { AccountService } from "./services/account.service.js";
import { AvatarService } from "./services/avatar.service.js";
import { TrustService } from "./services/trust.service.js";
import { MigrationService } from "./services/migration.service.js";
import { HubSigningService, sha256 } from "./services/signing.service.js";
import { AuthController } from "./controllers/auth.controller.js";
import { AccountController } from "./controllers/account.controller.js";
import { AvatarController } from "./controllers/avatar.controller.js";
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
 * @param {{ hubUrl?: () => string|null, ledger?: { record: (step: string, detail?: object) => Promise<void> }, adoptionEnabled?: boolean, log?: ((line: string) => void) | null, onDeviceLinkMinted?: (event: { did: string, grantId: string }) => unknown }} [options]
 *        `adoptionEnabled` (PORCH-026) re-enters second-hub identity
 *        adoption: flag-hidden by default (V1 build offers creation only).
 *        `log` (PORCH-019) is the auth-failure capture sink; defaults to
 *        console.log (the hub supervisor pipes it into logs/hub.log).
 *        `onDeviceLinkMinted` (PORCH-059) is the device-notifications
 *        observer the hub runtime wires to the social push pipeline.
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
    onDeviceLinkMinted: options.onDeviceLinkMinted ?? null,
    // PORCH-065: the hub runtime wires the self-reauth consume → address
    // re-point trigger here; absent (null) everywhere else.
    onDeviceLinkConsumed: options.onDeviceLinkConsumed ?? null,
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
  // PORCH-070: the member avatar plane — the byte store is wired by the hub
  // runtime to the media pipeline's content-addressed store (same root,
  // shared re-point); absent, every surface refuses plainly and nothing is
  // stored. SERVING accepts any member token of this hub through the wired
  // verifier (identity sessions always; social membership tokens late-bound
  // by the hub router, since social assembles after identity).
  const avatarOptions = options.avatar ?? {};
  const avatarService = new AvatarService({
    identities: collection("identities"),
    authService,
    blobs: avatarOptions.blobs ?? null,
    verifyMemberToken: avatarOptions.verifyMemberToken ?? null,
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
    auth: new AuthController(authService, didService, options.log ?? null),
    account: new AccountController(accountService, authService, ledger, options.log ?? null),
    avatar: new AvatarController(accountService, avatarService, options.log ?? null),
    device: new DeviceController(deviceService, authService, options.log ?? null),
    did: new DidController(didService),
    oidc: new OidcController(trustService, authService, options.log ?? null),
    migration: new MigrationController(migrationService, authService, options.log ?? null),
    wellKnown: new WellKnownController({ webfingerService, signing, hubUrlFn }),
  };

  return {
    signing,
    didService,
    accountService,
    avatarService,
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