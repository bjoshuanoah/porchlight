import { typedError } from "./post.service.js";

/**
 * Emoji usage memory (PORCH-120, Brian Oct 21 2026): the per-identity
 * Frequently Used record behind the picker's account-level tab. The usage
 * memory lives on the hub at the identity level, so the member's devices
 * share one list and the tab follows the member, not the hardware — the
 * per-device fallback is not needed server-side.
 *
 * Recorded usage is the member's own record (privacy is the boundary):
 * it never renders on another member's surface, never enters an event
 * envelope, never appears in the owner console, and never feeds an
 * aggregate. The count is an internal ordering key only — no count field
 * ever rides the usage wire; the served shape is a plain emoji list in
 * most-first order, because order is the only expression of frequency.
 *
 * Increment-on-add only (build call recorded on the task trail): every
 * recorded reaction add — a picker add and a chip join are the same signed
 * route — increments the tally; clearing a reaction (un-react) never
 * decrements it; no backfill ever exists.
 */
export class EmojiUsageService {
  /**
   * @param {object} deps
   * @param {import("@porchlight/shared").CollectionLike} deps.emojiUsage
   *   The usage rows — one per (memberDid, emoji).
   * @param {import("./membership.service.js").MembershipService} deps.membership
   *   The membership plane, scoping the read to the caller's own list.
   * @param {number} [deps.limit]
   *   The served list size (build call: 30 — a comfortable grid page;
   *   the full history stays in the store, only this many lead the tab).
   */
  constructor({ emojiUsage, membership, limit = 30 }) {
    this.emojiUsage = emojiUsage;
    this.membership = membership;
    this.limit = limit;
    this.prefix = "eus_";
  }

  /**
   * Record one usage add. Called by the reaction write path after the
   * row actually lands (a duplicate/failed add leaves the tally alone),
   * so the tab counts real reacts and nothing else. Best-effort by
   * contract: a usage failure never fails the member's reaction — the
   * write is a preference record, not a content write.
   */
  async record(memberDid, emoji) {
    if (!memberDid || typeof emoji !== "string" || emoji.length === 0) return;
    const now = new Date().toISOString();
    try {
      const existing = await this.emojiUsage.findOne({ memberDid, emoji });
      if (existing) {
        await this.emojiUsage.updateOne(
          { _id: existing._id },
          { $set: { count: (existing.count ?? 0) + 1, lastUsedAt: now } },
        );
        return;
      }
      await this.emojiUsage.insertOne({
        _id: `${this.prefix}${crypto.randomUUID()}`,
        memberDid,
        emoji,
        count: 1,
        lastUsedAt: now,
        createdAt: now,
      });
    } catch {
      // Usage memory never touches the reaction write's outcome.
    }
  }

  /**
   * The caller's own account-level usage, most-used first (count desc,
   * then most recent first beneath a tie). Identity-scoped by contract:
   * the token resolves the only identity this read can ever touch — there
   * is no path that reads another member's usage. The served payload is
   * the emoji list alone: no counts, no ids, no timestamps ride the wire.
   */
  async list({ accessToken } = {}) {
    if (!accessToken) {
      throw typedError("E_MUST_SIGN_IN", "Sign in to your membership to see your frequently used emoji.");
    }
    const perimeter = await this.membership.verifyAccessToken(accessToken, { surface: "emoji-usage" });
    if (!perimeter) {
      throw typedError("E_NOT_PERMITTED", "This action is not available to you in this network.");
    }
    const rows = await this.emojiUsage.find({ memberDid: perimeter.session.did });
    const ordered = rows
      .sort((a, b) => ((b.count ?? 0) - (a.count ?? 0)) || String(b.lastUsedAt ?? "").localeCompare(String(a.lastUsedAt ?? "")))
      .slice(0, this.limit);
    return { emoji: ordered.map((row) => row.emoji) };
  }
}