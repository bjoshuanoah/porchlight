import { socialModels } from "../models.js";

function typedError(code, message, extra = {}) {
  const error = new Error(message);
  error.code = code;
  Object.assign(error, extra);
  return error;
}

/**
 * Member admin service (PORCH-053). The owner console's destructive member
 * action: the permanent deletion that runs the sovereignty deletion-cascade
 * contract at the origin network. Removal (keep content) stays on the
 * membership service; this service exists because the purge needs the post
 * sweep, the media pipeline's store side, and the typed-confirmation
 * precondition in one business-logic home — controllers only translate.
 */
export class MemberAdminService {
  /**
   * @param {object} deps
   * @param {import("@porchlight/shared").CollectionLike} deps.memberships
   * @param {import("./membership.service.js").MembershipService} deps.membership
   *   revocation, sessions, realtime kill, device-key enrollment cascade,
   *   the final-owner invariant, and the membership view.
   * @param {import("./post.service.js").PostService} deps.postsService
   *   the transactional authored-content sweep (posts, comments, reactions,
   *   votes, notifications, derived artifacts, previews).
   * @param {import("./media.service.js").MediaService} deps.media
   *   the media store side of the purge (authored originals, their
   *   rendition ladder, ledger rows, open uploads).
   * @param {(dids: string[]) => Promise<Array<{did: string, displayName: string | null}>>} [deps.memberNames]
   *   identity-plane name resolver — the typed confirmation names the
   *   member the way the family sees them. Null on assemblies that don't
   *   wire it: the confirmation then takes the raw DID.
   * @param {(action: string, payload?: object) => Promise<void>} deps.audit
   */
  constructor({ memberships, membership, postsService, media, memberNames, audit }) {
    this.memberships = memberships;
    this.membership = membership;
    this.postsService = postsService;
    this.media = media;
    this.memberNames = memberNames ?? null;
    this.audit = audit ?? (async () => {});
    this.models = socialModels;
  }

  /**
   * The confirmation key for a member: the family-facing display name when
   * the identity plane resolves one, otherwise the raw DID. The typed
   * confirmation must match THIS — the destructive path is never single-tap
   * and never confirmable by an arbitrary guess that happens to pass a
   * length check.
   */
  async confirmationKey({ did } = {}) {
    if (!did) return null;
    const rows = this.memberNames ? await this.memberNames([did]) : [];
    return rows?.find((row) => row.did === did)?.displayName?.trim() || String(did);
  }

  /**
   * Permanent member deletion (ac-4). Owner-only (re-checked here in the
   * write path against the actor's LIVE membership), confirmed by typing
   * the member's name, then: revocation (sessions die, realtime closes,
   * device enrollments cascade — no resurrection), the transactional
   * authored-content sweep at this origin (authored originals: posts and
   * comments; and every reaction, vote, notification, and derived-artifact
   * row keyed to them), and the media store purge (authored asset originals,
   * their renditions, ledger rows, chunk bytes). The final-owner invariant
   * rides revokeMember: the last owner is un-deletable.
   *
   * Retry-safe: a member already revoked (a purge that failed midway, or a
   * plain removal) re-enters at the content sweep — the rows that remain
   * still leave.
   *
   * @param {{ networkId: string, memberId: string, confirmName: string, actor: object }} args
   */
  async purgeMember({ networkId, memberId, confirmName, actor } = {}) {
    const membership = await this.memberships.findOne({ _id: memberId });
    if (!membership || membership.networkId !== networkId) {
      throw typedError("E_MEMBER_NOT_FOUND", "No such member on this network.");
    }
    const actorDid = actor?.session?.did ?? actor?.membership?.did;
    const actorMembership = await this.membership.activeMembership({ networkId, did: actorDid });
    if (!actorMembership || actorMembership.role !== "owner") {
      throw typedError("E_FORBIDDEN", "Permanent deletion belongs to the network owner.");
    }
    const expected = await this.confirmationKey({ did: membership.did });
    const typed = typeof confirmName === "string" ? confirmName.trim() : "";
    if (!expected || typed.toLowerCase() !== expected.toLowerCase()) {
      throw typedError(
        "E_CONFIRM_NAME",
        `Type this member's name exactly — ${expected} — to confirm the deletion.`,
      );
    }

    const actorPerimeter = { session: { did: actorMembership.did } };
    if (membership.state === "active") {
      await this.membership.revokeMember({ networkId, memberId, actor: actorPerimeter });
    }
    const swept = await this.postsService.sweepContentOf({
      networkId,
      did: membership.did,
      actorDid: actorMembership.did,
      action: "member_purge",
    });
    const media = this.media ? await this.media.deleteMemberMedia({ networkId, did: membership.did }) : null;
    await this.audit("member_purge", {
      networkId,
      did: actorMembership.did,
      detail: { memberId: membership._id, targetDid: membership.did, postsSwept: swept.sweptPosts, mediaRemoved: media?.assetRowsRemoved ?? 0 },
    });
    return { purged: true, memberId: membership._id, membership: this.membership.view({ ...membership, state: "revoked" }), sweptPosts: swept.sweptPosts };
  }
}

export default MemberAdminService;