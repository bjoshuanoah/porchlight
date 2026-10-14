import { createHash, randomBytes } from "node:crypto";
import { canonicalJson } from "@porchlight/shared";
import { verifyDeviceSignatureRaw } from "./auth.service.js";
import { treatAvatar, avatarRungSpecs } from "./avatar.treatment.js";

/**
 * Avatar service (PORCH-070, Porchlight Server TS 12): the member's profile
 * photo lives on the account record — one avatar per identity, rendering
 * across every network the member belongs to, never re-keyed by joins,
 * pairings, re-binds, or hub moves. The bytes ride a content-addressed blob
 * store (wired through the hub assembly to the media pipeline's store), to
 * be served by this module's rendition surface under the media pipeline's
 * immutable cache contract.
 *
 * Write flow — the Profile's confirm flow (ac-1/ac-5):
 * - ingest: uploaded bytes are treated hub-side (square crop → compressed
 *   rungs; devices never transcode) and held as a PENDING set with a
 *   one-time token; the member previews the exact face the hub will serve.
 * - commit: the pending set replaces the avatar whole; the prior set's blobs
 *   retire (replaced renditions become unreachable content, never a
 *   cache-poison risk). Authored content is never touched.
 * - clear: the record reverts to the no-avatar state; blobs retire.
 * - An abandoned pending (never confirmed) expires and sweeps lazily — no
 *   background machinery, no orphan accumulation.
 *
 * Device signatures verify against the SAME registered device key the
 * identity plane proved possession of at session open (the social plane's
 * write shape, resolved through the session's own device row).
 * Replace/clear retire blobs whole — including any pre-PORCH-070
 * owner-setup data-URL face, which migrates out of `profile` at first
 * commit (the stored avatar payload is the compact square set and nothing
 * else: the recorded exception to the post-media original-retention rule).
 */

/** One pre-confirm pending set per identity; expired pendings sweep lazily. */
export const PENDING_TTL_MS = 10 * 60 * 1000;

/** The rung kinds a serving request may address. */
export const AVATAR_KINDS = new Set(avatarRungSpecs().map((rung) => rung.kind));

function typedError(code, message, extra = {}) {
  const error = new Error(message);
  error.code = code;
  Object.assign(error, extra);
  return error;
}

/** Internal rung row (with byte-store internals) — never transported. */
function rungRow(treatedRung, sha256) {
  return {
    kind: treatedRung.kind,
    width: treatedRung.width,
    height: treatedRung.height,
    contentType: treatedRung.contentType,
    sha256,
    blobKey: sha256,
    bytes: treatedRung.bytes,
  };
}

/** The avatar meta clients see: per-rung square stamps, no byte internals. */
export function avatarMetas(avatar) {
  if (!avatar || !Array.isArray(avatar.renditions) || avatar.renditions.length === 0) return null;
  const metas = {};
  for (const rung of avatar.renditions) {
    metas[rung.kind] = {
      kind: rung.kind,
      width: rung.width,
      height: rung.height,
      contentType: rung.contentType,
      sha256: rung.sha256,
    };
  }
  return metas;
}

function isHex64(value) {
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}

function pendingExpired(pending, now = Date.now()) {
  return !pending?.expiresAt || new Date(pending.expiresAt).getTime() <= now;
}

export class AvatarService {
  /**
   * @param {object} deps
   * @param {import("@porchlight/shared").CollectionLike} deps.identities
   * @param {import("./auth.service.js").AuthService} deps.authService
   * @param {{ put: (key: string, bytes: Buffer) => Promise<unknown>,
   *           get: (key: string) => Promise<Buffer|null>,
   *           has: (key: string) => Promise<boolean>,
   *           delete: (key: string) => Promise<boolean> } | null} deps.blobs
   *   The content-addressed byte store (the hub assembly binds it to the
   *   media pipeline's store; tests bind a memory store). Null → every
   *   avatar surface refuses plainly: the hub stores no photo set without
   *   its byte store (never a silent no-op).
   * @param {(token: string|null) => Promise<{ did: string, [key: string]: unknown } | null>} [deps.verifyMemberToken]
   *   The SERVING perimeter: the hub runtime wires one verifier accepting a
   *   member token of this hub (identity-plane session token or a social
   *   membership token — a member of any network here may see faces).
   *   Default: identity-plane sessions only.
   */
  constructor({ identities, authService, blobs, verifyMemberToken = null }) {
    this.identities = identities;
    this.authService = authService;
    this.blobs = blobs;
    this.verifyMemberToken = verifyMemberToken ?? (async (token) =>
      token ? this.authService.verifyAccessToken(token) : null);
  }

  #assertStore() {
    if (!this.blobs) {
      throw typedError("E_AVATAR_UNAVAILABLE", "The hub's media storage isn't available, so photos can't be stored right now.");
    }
  }

  /** Resolve the session (did + device) bound to this Bearer token. */
  async #verifiedOwnSession({ accessToken, did }) {
    if (!accessToken) {
      throw typedError("E_SESSION_REQUIRED", "Open your session before changing your photo.");
    }
    const session = await this.authService.verifyAccessTokenWithDevice(accessToken);
    if (!session) {
      throw typedError("E_SESSION_REQUIRED", "Open your session before changing your photo.");
    }
    const own = did ?? session.did;
    if (own !== session.did) {
      throw typedError("E_FORBIDDEN", "Photos are written only to your own identity.");
    }
    return { ...session, did: own };
  }

  /**
   * The device-signed payload discipline: the signature verifies over the
   * canonical JSON of the payload, against the session's registered device.
   */
  async #verifyDeviceSignature({ did, deviceId, payload, signature }) {
    if (!payload || typeof payload !== "object") {
      throw typedError("E_AVATAR_DECLARATION_INVALID", "The photo is missing its signed declaration. Try again.");
    }
    if (typeof signature !== "string" || signature.length === 0) {
      throw typedError("E_SIGNATURE_REQUIRED", "Confirm the change from your own device.");
    }
    const registration = await this.authService.activeDeviceRegistration(did, deviceId);
    if (!registration) {
      throw typedError("E_DEVICE_REQUIRED", "This device isn't one your identity is bound to. Make a pairing code from your Profile.");
    }
    const ok = verifyDeviceSignatureRaw({
      publicKeyJwk: registration.publicKeyJwk,
      message: canonicalJson(payload),
      signature,
    });
    if (!ok) {
      throw typedError("E_SIGNATURE_INVALID", "The photo's signature didn't check out. Try again from your own device.");
    }
  }

  async #readIdentity(did) {
    const row = await this.identities.findOne({ did });
    if (!row) throw typedError("E_IDENTITY_NOT_FOUND", `No identity ${did} is hosted here.`);
    return row;
  }

  /** Retire a rung set's blobs; `keep` blobs a concurrent set still uses. */
  async #retireRungs(renditions, keep = new Set()) {
    if (!this.blobs || !Array.isArray(renditions)) return;
    for (const rung of renditions) {
      if (rung?.blobKey && !keep.has(rung.blobKey)) await this.blobs.delete(rung.blobKey);
    }
  }

  async #sweepExpiredPending(row) {
    const pending = row?.avatar?.pending;
    if (!pending || !pendingExpired(pending)) return;
    await this.#retireRungs(pending.renditions);
    await this.identities.updateOne(
      { did: row.did },
      { $set: { avatar: { ...row.avatar, pending: null } } },
    );
  }

  /** The pending write: one slot per identity; the replaced slot's bytes retire. */
  async #writePending(did, pending) {
    const row = await this.identities.findOne({ did });
    if (!row) throw typedError("E_IDENTITY_NOT_FOUND", `No identity ${did} is hosted here.`);
    await this.#retireRungs(row?.avatar?.pending?.renditions, new Set(pending.renditions.map((rung) => rung.blobKey)));
    await this.identities.updateOne(
      { did },
      { $set: { avatar: { ...(row.avatar ?? {}), pending } } },
    );
  }

  /**
   * Ingest (the confirm flow's first half): treat the upload hub-side and
   * hold it as the identity's pending set. Any previous unconfirmed pending
   * retires ITS bytes first; the committed avatar is untouched — a retake
   * never changes the face the family already saw until confirm.
   *
   * @param {{ did: string, bytes: Buffer, payload: {scope: string, action: "ingest", size: number, sha256: string, contentType: string}, signature: string, accessToken: string }} args
   * @returns {Promise<{pending: {token: string, expiresAt: string, renditions: object|null}}>}
   */
  async ingest({ did, bytes, payload, signature, accessToken }) {
    const session = await this.#verifiedOwnSession({ accessToken, did });
    await this.#verifyDeviceSignature({ did: session.did, deviceId: session.deviceId, payload, signature });
    this.#assertStore();
    if (payload.action !== "ingest") {
      throw typedError("E_AVATAR_DECLARATION_INVALID", "The photo declaration doesn't match this request. Try again.");
    }
    // Name the unsupported type BEFORE a byte-accounting refusal: a PDF
    // (or any non-image) refuses as what it is, never as a mismatch.
    if (typeof payload.contentType !== "string" || !/^image\//.test(payload.contentType.split(";")[0].trim().toLowerCase())) {
      throw typedError("E_AVATAR_UNSUPPORTED_TYPE", "That file isn't a photo type the hub can use. Photos arrive as JPEG, PNG, WebP, GIF, AVIF, or HEIC.");
    }
    const size = Buffer.byteLength(bytes ?? Buffer.alloc(0));
    if (!Number.isInteger(payload.size) || payload.size !== size || size === 0) {
      throw typedError("E_AVATAR_DECLARATION_INVALID", "The photo bytes don't match the declaration. Choose the file again.");
    }
    if (!isHex64(payload.sha256)) {
      throw typedError("E_AVATAR_DECLARATION_INVALID", "The photo declaration is missing its fingerprint. Choose the file again.");
    }
    if (payload.sha256 !== createHash("sha256").update(bytes).digest("hex")) {
      throw typedError("E_AVATAR_SHA_MISMATCH", "The uploaded photo didn't arrive intact — its fingerprint doesn't match. Nothing was stored.");
    }
    const row = await this.#readIdentity(session.did);
    await this.#sweepExpiredPending(row);

    const treated = await treatAvatar(bytes, payload.contentType);
    const stored = [];
    for (const rung of treated) {
      const sha256 = createHash("sha256").update(rung.bytes).digest("hex");
      await this.blobs.put(sha256, rung.bytes);
      stored.push(rungRow(rung, sha256));
    }

    // Same-face refusal before any accounting: every committed rung equals
    // a stored one means the photo already IS the face.
    const committedShas = new Set((row.avatar?.renditions ?? []).map((rung) => rung.sha256));
    if (stored.length > 0 && stored.every((rung) => committedShas.has(rung.sha256))) {
      await this.#retireRungs(stored);
      throw typedError("E_AVATAR_SAME_PHOTO", "That's already your photo. Nothing changed.");
    }

    const token = randomBytes(24).toString("base64url");
    const expiresAt = new Date(Date.now() + PENDING_TTL_MS).toISOString();
    const pending = {
      token,
      renditions: stored,
      originalSha256: payload.sha256,
      createdAt: new Date().toISOString(),
      expiresAt,
    };
    await this.#writePending(session.did, pending);
    return { pending: { token, expiresAt, renditions: avatarMetas({ renditions: stored }) } };
  }

  /**
   * Commit (the confirm flow's second half, ac-1): the pending set becomes
   * the avatar; the prior committed set retires whole (shared blob keys —
   * a same-content replace — never deleted twice). The pre-PORCH-070
   * owner-setup data-URL face migrates out of `profile` here: the stored
   * avatar payload is the compact square set and nothing else.
   *
   * @param {{ did: string, token: string, payload: {scope: string, action: "commit", token: string}, signature: string, accessToken: string }} args
   */
  async commit({ did, token, payload, signature, accessToken }) {
    const session = await this.#verifiedOwnSession({ accessToken, did });
    const own = session.did;
    await this.#verifyDeviceSignature({ did: own, deviceId: session.deviceId, payload, signature });
    if (payload.action !== "commit") {
      throw typedError("E_AVATAR_DECLARATION_INVALID", "The photo confirmation doesn't match this request. Try again.");
    }
    this.#assertStore();
    const row = await this.#readIdentity(own);
    await this.#sweepExpiredPending(row);
    const pending = row.avatar?.pending;
    if (!pending || !token || token !== pending.token) {
      throw typedError(
        "E_AVATAR_PENDING_INVALID",
        "That photo confirmation isn't current. Pick your photo once more and confirm it.",
      );
    }
    const prior = row.avatar?.renditions ?? [];
    await this.identities.updateOne(
      { did: own },
      { $set: { avatar: { renditions: pending.renditions, updatedAt: new Date().toISOString(), pending: null } } },
    );
    await this.#retireRungs(prior, new Set(pending.renditions.map((rung) => rung.blobKey)));
    // The owner-setup data-URL face was this same slot's pre-PORCH-070
    // storage; once the treated set exists, the compact square set is all
    // the hub keeps.
    const profile = row.profile ?? null;
    if (profile && Object.prototype.hasOwnProperty.call(profile, "avatar")) {
      const { avatar: _legacyAvatar, ...rest } = profile;
      await this.identities.updateOne({ did: own }, { $set: { profile: rest } });
    }
    const updated = await this.#readIdentity(own);
    return { account: { did: own, displayName: updated.displayName }, avatar: avatarMetas(updated.avatar) };
  }

  /**
   * Clear (ac-1: replacing with no file): the record reverts to the
   * no-avatar state and every rendition retires. Authored content is never
   * touched by the avatar path — this service holds no posts handle at all.
   *
   * @param {{ did: string, payload: {scope: string, action: "clear"}, signature: string, accessToken: string }} args
   */
  async clear({ did, payload, signature, accessToken }) {
    const session = await this.#verifiedOwnSession({ accessToken, did });
    const own = session.did;
    await this.#verifyDeviceSignature({ did: own, deviceId: session.deviceId, payload, signature });
    if (payload.action !== "clear") {
      throw typedError("E_AVATAR_DECLARATION_INVALID", "The photo request doesn't match this action. Try again.");
    }
    const row = await this.#readIdentity(own);
    await this.#sweepExpiredPending(row);
    const hadRungs = [...(row.avatar?.renditions ?? []), ...(row.avatar?.pending?.renditions ?? [])];
    await this.identities.updateOne({ did: own }, { $set: { avatar: null } });
    await this.#retireRungs(hadRungs);
    const profile = row.profile ?? null;
    if (profile && Object.prototype.hasOwnProperty.call(profile, "avatar")) {
      const { avatar: _legacyAvatar, ...rest } = profile;
      await this.identities.updateOne({ did: own }, { $set: { profile: rest } });
    }
    return { account: { did: own }, avatar: null, removedRungs: hadRungs.length };
  }

  /**
   * Serving (ac-2: every surface's face). Committed rungs serve to ANY
   * member token of this hub, content-addressed and immutable; the pending
   * preview serves ONLY to the identity's own session carrying the pending
   * token (a face nobody confirmed yet is nobody's face to see).
   *
   * @param {{ accessToken: string|null, did: string, kind: string, version: string|null, pendingToken: string|null }} args
   * @returns {Promise<{bytes: Buffer, contentType: string, sha256: string, kind: string, width: number, height: number, pending: boolean}>}
   */
  async serveRung({ accessToken, did, kind, version, pendingToken }) {
    if (!accessToken) {
      throw typedError("E_SESSION_REQUIRED", "Sign in to see the family's faces.");
    }
    const viewer = await this.verifyMemberToken(accessToken);
    if (!viewer) {
      throw typedError("E_SESSION_REQUIRED", "Sign in to see the family's faces.");
    }
    this.#assertStore();
    if (!AVATAR_KINDS.has(kind)) {
      throw typedError("E_RENDITION_KIND_UNKNOWN", "No such face size exists.");
    }
    if (!did || typeof did !== "string") {
      throw typedError("E_AVATAR_NOT_FOUND", "That member's face isn't on this hub.");
    }
    const row = await this.identities.findOne({ did });
    if (!row) throw typedError("E_AVATAR_NOT_FOUND", "That member's face isn't on this hub.");

    if (pendingToken) {
      const pending = row.avatar?.pending;
      if (!pending || pendingToken !== pending.token || pendingExpired(pending)) {
        throw typedError("E_AVATAR_PENDING_NOT_FOUND", "That photo preview isn't current. Pick your photo once more.");
      }
      if (viewer.did !== did) {
        throw typedError("E_FORBIDDEN", "Photo previews show to their own member only.");
      }
      const rung = pending.renditions?.find((some) => some.kind === kind);
      if (!rung || !this.#versionMatches(version, rung)) {
        throw typedError("E_RENDITION_NOT_FOUND", "That face isn't available.");
      }
      const bytes = await this.#bytes(rung);
      return { bytes, ...this.#serve(rung), pending: true };
    }

    const rung = row.avatar?.renditions?.find((some) => some.kind === kind);
    if (!rung || !this.#versionMatches(version, rung)) {
      throw typedError("E_RENDITION_NOT_FOUND", "That face isn't available.");
    }
    const bytes = await this.#bytes(rung);
    return { bytes, ...this.#serve(rung), pending: false };
  }

  #versionMatches(version, rung) {
    return version == null || version === rung.sha256;
  }

  #serve(rung) {
    return {
      contentType: rung.contentType,
      sha256: rung.sha256,
      kind: rung.kind,
      width: rung.width,
      height: rung.height,
    };
  }

  async #bytes(rung) {
    const bytes = await this.blobs.get(rung.blobKey);
    if (bytes === null) {
      throw typedError("E_BLOB_MISSING", "That face's stored copy is missing. Re-add the photo from the Profile.");
    }
    return bytes;
  }

  /**
   * The deletion cascade (PRD 12 / ac: cascade e2e): the member purge calls
   * this once with the purged DID; the avatar field and the whole rendition
   * set retire with the account record. Idempotent: an identity with no
   * avatar (or one already retired) sweeps nothing and answers removed: 0.
   *
   * @param {string} did
   * @returns {Promise<{removed: number}>}
   */
  async retireFor(did) {
    const row = await this.identities.findOne({ did });
    if (!row || !row.avatar) return { removed: 0 };
    const rungs = [...(row.avatar.renditions ?? []), ...(row.avatar.pending?.renditions ?? [])];
    await this.identities.updateOne({ did }, { $set: { avatar: null } });
    await this.#retireRungs(rungs);
    return { removed: rungs.length };
  }
}

export default AvatarService;