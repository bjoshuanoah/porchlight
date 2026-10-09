import { randomUUID } from "node:crypto";
import { TrustService } from "./trust.service.js";

function typedError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

/**
 * Migration service — the two-hub flow that moves a hosted identity between
 * hubs without ever touching the DID.
 *
 * Outgoing hub (`issueHandoff`): marks the identity "moved", re-points its DID
 * document's service entries to the new issuer, and signs a short-lived
 * did-doc-plane handoff attestation. From that point the hub stops asserting
 * home for the identity.
 *
 * Receiving hub (`receiveMigration`): verifies the handoff against the OLD
 * hub's did-doc-plane key set, then ingests the identity as a fresh row
 * (kind "migrated"), builds the DID document for the new hub, and re-creates
 * the device registrations — public key material only; device private keys
 * are device-bound and never travel (they ride re-binding, not carriage).
 * Re-receiving an already migrated DID is idempotent.
 */
export class MigrationService {
  /**
   * @param {object} deps
   * @param {import("@porchlight/shared").CollectionLike} deps.identities `identities`
   * @param {import("@porchlight/shared").CollectionLike} deps.didDocuments `did_documents`
   * @param {import("@porchlight/shared").CollectionLike} deps.deviceRegistrations `device_registrations`
   * @param {import("./signing.service.js").HubSigningService} deps.signing
   * @param {import("./did.service.js").DidService} deps.didService
   *        Received by injection — document building/re-pointing is slice-B
   *        surface; this service never constructs stores or keystores.
   * @param {() => string|null} deps.hubUrlFn this hub's URL provider.
   * @param {TrustService} [deps.trust] the hub's trust service (falls back to
   *        an internal handoff-only verifier against the shared signing keys).
   */
  constructor({ identities, didDocuments, deviceRegistrations, signing, didService, hubUrlFn, trust }) {
    this.identities = identities;
    this.didDocuments = didDocuments;
    this.deviceRegistrations = deviceRegistrations;
    this.signing = signing;
    this.didService = didService;
    this.hubUrlFn = hubUrlFn;
    this.trust = trust ?? new TrustService({ authCodes: null, sessions: null, signing, hubUrlFn });
  }

  #thisIssuer() {
    const issuer = this.hubUrlFn?.() ?? null;
    if (!issuer) {
      throw typedError("E_HUB_URL_REQUIRED", "hub URL provider returned no issuer; migration needs both hubs' issuers");
    }
    return issuer;
  }

  /**
   * Hand off this hub's hosted identity to the new issuer: mark the copy
   * "moved" with migratedToIssuer set, re-point the DID document's service
   * entries to the new hub, and sign the handoff token (did-doc plane, short
   * TTL). The DID itself is unchanged — it never changes anywhere.
   * → { handoffToken, did, newIssuer, oldIssuer }.
   */
  async issueHandoff({ did, newIssuer } = {}) {
    if (!did || !newIssuer) {
      throw typedError("E_MIGRATION_FIELDS_REQUIRED", "did and newIssuer are required to issue a handoff");
    }
    const identity = await this.identities.findOne({ did });
    if (!identity) throw typedError("E_IDENTITY_NOT_FOUND", `no hosted identity for did "${did}"`);

    const oldIssuer = this.#thisIssuer();
    // The hub stops asserting home: the identity copy is marked moved.
    await this.identities.updateOne(
      { did },
      { $set: { homingStatus: "moved", migratedToIssuer: String(newIssuer) } },
    );
    // DID document services re-point to the new hub; DID and verification
    // method stay identical.
    await this.didService.repointDocument(did, { hubUrlFn: () => String(newIssuer), homingStatus: "moved" });

    const handoffToken = await this.signing.signHandoffToken({ did, oldIssuer, newIssuer: String(newIssuer) });
    return { handoffToken, did, newIssuer: String(newIssuer), oldIssuer };
  }

  /**
   * Ingest a migrated identity: verify the handoff against the OLD hub's
   * did-doc-plane keys, require the attested did/oldIssuer to match this call,
   * then create the identity row (kind "migrated", homingStatus "home"), build
   * the DID document for THIS hub, and re-create the device registrations from
   * the envelope — public rows only; any private key material in a public JWK
   * fails closed. Idempotent: a DID already migrated here returns the existing
   * row with { adopted: "existing" }.
   * → { adopted: "migrated" | "existing", did, identity }.
   */
  async receiveMigration({ handoffToken, did, envelope, oldIssuer, transport, now = () => new Date() } = {}) {
    if (!handoffToken || !did || !envelope || !oldIssuer) {
      throw typedError("E_MIGRATION_FIELDS_REQUIRED", "handoffToken, did, envelope and oldIssuer are required to receive a migration");
    }
    // 1) Verify against the OLD hub's did-doc-plane keys (pinned issuer).
    const { payload } = await this.trust.verifyHandoff(handoffToken, { oldIssuer, transport });
    if (payload.did !== did || payload.oldIssuer !== oldIssuer) {
      throw typedError("E_HANDOFF_MISMATCH", "handoff attestation does not match the did/oldIssuer pair being migrated");
    }

    // Idempotent re-receive: the DID already lives here.
    const existing = await this.identities.findOne({ did });
    if (existing) {
      return { adopted: "existing", did, identity: existing };
    }

    // 2) Validate the whole envelope BEFORE anything is ingested (public rows
    // only; private key material is device-bound and never migrates).
    const registrations = Array.isArray(envelope.deviceRegistrations) ? envelope.deviceRegistrations : [];
    for (const incoming of registrations) {
      const publicKeyJwk = incoming?.publicKeyJwk;
      if (!publicKeyJwk || typeof publicKeyJwk !== "object" || Array.isArray(publicKeyJwk)) {
        throw typedError("E_KEY_TYPE_REJECTED", "migration device row is missing a publicKeyJwk object");
      }
      if ("d" in publicKeyJwk) {
        throw typedError("E_PRIVATE_KEY_REJECTED", "a device public JWK carrying a private field cannot migrate");
      }
    }

    // 3) Ingest identity row (new hub record, DID never changes anywhere).
    // Membership references the networks hold ({identityRef, ...} opaque to
    // the identity domain) ride the envelope untouched; networks re-resolve
    // them on next verification — they are never interpreted or re-homed.
    const nowDate = now();
    const createdAt = nowDate.toISOString();
    const membershipReferences = Array.isArray(envelope.membershipReferences) ? envelope.membershipReferences : [];
    const identity = {
      _id: `ident_${randomUUID()}`,
      did,
      actorType: envelope.actorType ?? "human",
      displayName: envelope.displayName ?? did,
      email: envelope.email ?? null,
      handle: envelope.handle ?? null,
      profile: envelope.profile && typeof envelope.profile === "object" ? { ...envelope.profile } : {},
      homingStatus: "home",
      migratedToIssuer: null,
      kind: "migrated",
      createdAt,
    };
    if (membershipReferences.length > 0) {
      // Opaque, identity-agnostic reference data — the social domain's own
      // records live at their networks; the identity hub only carries them
      // through the move uninterpreted.
      identity.membershipReferences = membershipReferences.map((reference) =>
        reference && typeof reference === "object" ? { ...reference } : reference,
      );
    }
    await this.identities.insertOne(identity);

    // DID document for the new hub: same DID, this hub's service endpoints.
    await this.didService.putDocument(did, { hubUrlFn: this.hubUrlFn, homingStatus: "home" });

    // Re-create device registrations — PUBLIC records only (validated above;
    // private halves are device-bound and never migrate).
    for (const incoming of registrations) {
      await this.deviceRegistrations.insertOne({
        _id: `reg_${randomUUID()}`,
        did,
        deviceId: String(incoming.deviceId),
        label: incoming.label ?? null,
        publicKeyJwk: { ...incoming.publicKeyJwk },
        createdBy: incoming.createdBy ?? "migrated",
        status: incoming.status === "revoked" ? "revoked" : "active",
        revokedAt: incoming.revokedAt ?? null,
        createdAt,
      });
    }
    return { adopted: "migrated", did, identity, membershipReferences };
  }
}

export default MigrationService;