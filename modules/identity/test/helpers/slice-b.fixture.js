import { createMemoryStore } from "@porchlight/shared";
import { HubSigningService } from "../../src/services/signing.service.js";
import { newEd25519Jwks } from "../../src/util/jwt.js";
import { DidService } from "../../src/services/did.service.js";
import { WebfingerService } from "../../src/services/webfinger.service.js";
import { AccountService } from "../../src/services/account.service.js";

export const HUB_URL = "https://hub.example";

/**
 * A one-hub Slice-B fixture: memory store + operator keystore + services
 * wired per the contract. `options` overrides any AccountService dep
 * (`transport`, `hubUrlFn`).
 */
export function fixture({ transport = null, hubUrlFn = () => HUB_URL } = {}) {
  const store = createMemoryStore();
  const identities = store.collection("identities");
  const didDocuments = store.collection("did_documents");
  const deviceRegistrations = store.collection("device_registrations");
  const signing = new HubSigningService(store.collection("issuer_keys"));
  const didService = new DidService({ identities, didDocuments, signing });
  const webfingerService = new WebfingerService({ didService, hubUrlFn });
  const accountService = new AccountService({
    identities,
    didService,
    deviceRegistrations,
    transport,
    hubUrlFn,
  });
  return { store, identities, didDocuments, deviceRegistrations, signing, didService, webfingerService, accountService };
}

/** A device descriptor whose key is a fresh PUBLIC Ed25519 OKP JWK (no `d`). */
export function okpDevice({ deviceId = "device_1", label = null } = {}) {
  const { publicKeyJwk } = newEd25519Jwks();
  return { deviceId, label, publicKeyJwk };
}