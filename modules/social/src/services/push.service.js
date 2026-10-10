import { randomUUID } from "node:crypto";
import webpush from "web-push";
import { socialModels } from "../models.js";
import { typedError } from "./post.service.js";

/**
 * Device notifications (PORCH-059; PRD/TS 10, filed Oct 10, 2026). Web Push
 * delivery over the standard Push API with VAPID server authentication:
 * the hub itself composes, encrypts (RFC 8291 aes128gcm with the
 * subscription's own keys), and sends — no external broker exists on the
 * sending side, so zero phone-home holds. The vendor push relay ships only
 * ciphertext (the same honest-contact class as the provider-embed iframe).
 *
 * Send pipeline: an event trigger (origin network, event type, targets)
 * resolves through LIVE membership (never a stored permission — a member
 * removed from a network is unreachable at the same write that revokes
 * them), through this member's settings (global switch, per-event toggles,
 * per-network mutes — READ AT SEND TIME, never cached), down to their live
 * subscriptions. Endpoint 404/410 classes expire the stored subscription
 * server-side (log-only); transient failures take one bounded retry then
 * drop. Delivery outcomes land only in the local structured log sink.
 *
 * Payload privacy is the vote-privacy contract extended to the push
 * channel: the plaintext carries content only — event type, post
 * reference, author display name, origin network name, and a short caption
 * or excerpt when the recipient authored the target content. No counts, no
 * vote records, no aggregates of any kind ship in any envelope.
 */

/** The closed push event vocabulary (ac-2's covered surfaces). */
export const PUSH_EVENT_TYPES = Object.freeze([
  "reply",
  "reaction",
  "mention",
  "groupPost",
  "joined",
  "deviceLink",
]);

/**
 * Shipped per-event defaults. Reply/reaction/mention/joined/device-link
 * are on at birth (the launch event surface); group posts are the
 * member-controlled toggle (default off), and the member's own switches
 * override from the settings write.
 */
export const DEFAULT_EVENT_SWITCHES = Object.freeze({
  reply: true,
  reaction: true,
  mention: true,
  groupPost: false,
  joined: true,
  deviceLink: true,
});

/** The plaintext whitelist (ac-3): anything else is stripped, never sent. */
const PLAINTEXT_FIELDS = Object.freeze(["type", "postId", "commentId", "authorName", "networkName", "excerpt"]);

/** Field names that must NEVER appear on a push plaintext (privacy audit). */
const FORBIDDEN_PAYLOAD_FIELDS = [
  "interactionCounters",
  "voteCount",
  "upvotes",
  "downvotes",
  "voteRatio",
  "ratio",
  "volume",
  "score",
  "rank",
  "reactionCount",
  "commentCount",
  "deviceSignature",
  "votes",
];

const EXCERPT_MAX_LENGTH = 160;

/** Short caption or excerpt: trimmed and bounded, content-only. */
export function pushExcerpt(text) {
  if (typeof text !== "string") return null;
  const trimmed = text.trim();
  if (!trimmed.length) return null;
  return trimmed.length > EXCERPT_MAX_LENGTH ? `${trimmed.slice(0, EXCERPT_MAX_LENGTH)}…` : trimmed;
}

/**
 * Shape one plaintext envelope against the whitelist and audit it against
 * the no-counts, no-vote-records, no-aggregates contract (ac-3).
 */
export function pushPlaintext({ type, postId = null, commentId = null, authorName = null, networkName = null, excerpt = null }) {
  const plaintext = {
    type: String(type),
    postId: postId ?? null,
    commentId: commentId ?? null,
    authorName: authorName ?? null,
    networkName: networkName ?? null,
    excerpt: pushExcerpt(excerpt),
  };
  assertPayloadPrivacy(plaintext);
  return plaintext;
}

function assertPayloadPrivacy(plaintext) {
  const keys = Object.keys(plaintext);
  const leaked = FORBIDDEN_PAYLOAD_FIELDS.filter((field) => keys.includes(field));
  if (leaked.length) {
    // The contract is structural: a forbidden field on a plaintext is a
    // developer error, thrown before any byte reaches the network.
    throw new Error(`Push plaintext privacy violation: forbidden fields ${leaked.join(", ")}`);
  }
  if (keys.some((key) => !PLAINTEXT_FIELDS.includes(key))) {
    throw new Error("Push plaintext carries a field outside the content-only whitelist.");
  }
}

/**
 * The default sender: web-push's Push API client with VAPID details and
 * the aes128gcm content encoding (RFC 8291 over the subscription's own
 * keys). The sender NEVER retries and NEVER throws for HTTP outcomes — it
 * resolves { statusCode } so the service owns the expiry/retry/drop policy.
 */
function createWebPushSender(vapid) {
  return async ({ subscription, plaintext }) => {
    try {
      const result = await webpush.sendNotification(
        { endpoint: subscription.endpoint, keys: subscription.keys },
        JSON.stringify(plaintext),
        {
          contentEncoding: "aes128gcm",
          vapidDetails: { subject: vapid.subject, publicKey: vapid.publicKey, privateKey: vapid.privateKey },
        },
      );
      return { statusCode: result?.statusCode ?? 0 };
    } catch (error) {
      return { statusCode: error?.statusCode ?? 0 };
    }
  };
}

/**
 * The identity-scoped push service (PORCH-059).
 */
export class PushService {
  /**
   * @param {object} deps
   * @param {import("@porchlight/shared").CollectionLike} deps.subscriptions
   *   the push_subscriptions collection (identity-scoped, per device).
   * @param {import("@porchlight/shared").CollectionLike} deps.settings
   *   the push_settings collection (one row per identity, read at send time).
   * @param {import("@porchlight/shared").CollectionLike} deps.memberships
   *   the live membership rows (owner/delegate role resolution for the
   *   joined and device-link event classes — read at send time).
   * @param {import("@porchlight/shared").CollectionLike} deps.networks
   * @param {import("./membership.service.js").MembershipService} deps.membership
   * @param {{ publicKey: string, privateKey: string, subject: string } | null} deps.vapid
   *   the hub's VAPID material, generated by the runtime setup at first run
   *   and held in hub server state (never committed); null disables sending.
   * @param {({ statusCode: number }) => Promise<unknown>} [deps.sender]
   *   injectable send transport; defaults to the web-push Push API client.
   * @param {((line: string) => void) | null} [deps.log]
   *   the local structured-log sink (delivery outcomes; never a network).
   */
  constructor({ subscriptions, settings, memberships, networks, membership, vapid, sender = null, log = null }) {
    this.subscriptions = subscriptions;
    this.settings = settings;
    this.memberships = memberships;
    this.networks = networks;
    this.membership = membership;
    this.vapid = vapid ?? null;
    this.sender = sender ?? createWebPushSender(this.vapid);
    this.log = log ?? null;
    this.models = socialModels;
  }

  /** Shipped defaults: everything on except the member-controlled group toggle. */
  static defaultSettings(identityId) {
    return { _id: identityId, identityId, enabled: true, events: { ...DEFAULT_EVENT_SWITCHES }, mutes: [], updatedAt: null };
  }

  /** GET /push/vapid — the subscription route serves the VAPID public key. */
  vapidKey() {
    if (!this.vapid) return { publicKey: null, available: false };
    return { publicKey: this.vapid.publicKey, available: true };
  }

  /**
   * Register one identity-scoped subscription (ac-1). Re-registration
   * replaces, never duplicates: the same endpoint re-registers in place
   * (createdAt preserved, lastSeen advanced), and a re-registered device
   * supersedes its older endpoint. No device/browser capability sniffing
   * ever happens server-side (ac-5: no iOS workaround — the gate is the
   * browser's, and the server accepts whatever a capable client presents).
   */
  async registerSubscription({ accessToken, endpoint, keys } = {}) {
    const perimeter = await this.#perimeter(accessToken);
    const did = perimeter.session.did;
    const deviceId = perimeter.session.deviceId ?? null;
    if (!endpoint || typeof endpoint !== "string") {
      throw typedError("E_PUSH_ENDPOINT_REQUIRED", "A push subscription needs its browser endpoint URL.");
    }
    if (!keys || !keys.p256dh || !keys.auth || typeof keys.p256dh !== "string" || typeof keys.auth !== "string") {
      throw typedError("E_PUSH_KEYS_REQUIRED", "A push subscription carries its own encryption keys.");
    }
    const now = new Date().toISOString();
    // Replace on BOTH supersession keys — same endpoint (the browser's own
    // re-registration, identity preserved → createdAt carries) and same
    // identity+device (the device's new endpoint).
    const existing = await this.subscriptions.findOne({ endpoint });
    if (existing) {
      await this.subscriptions.deleteOne({ _id: existing._id });
    }
    if (deviceId) {
      for (const sameDevice of await this.subscriptions.find({ identityId: did, deviceId })) {
        await this.subscriptions.deleteOne({ _id: sameDevice._id });
      }
    }
    const row = {
      _id: `psb_${randomUUID()}`,
      identityId: did,
      endpoint,
      keys: { p256dh: keys.p256dh, auth: keys.auth },
      deviceId: deviceId ?? null,
      createdAt: existing?.identityId === did ? existing.createdAt : now,
      lastSeen: now,
    };
    await this.subscriptions.insertOne(row);
    return { subscription: { _id: row._id, identityId: row.identityId, endpoint, createdAt: row.createdAt, lastSeen: row.lastSeen } };
  }

  /** Unregister the member's own subscription: identity-scoped removal. */
  async unregisterSubscription({ accessToken, endpoint } = {}) {
    const did = await this.#requireIdentity(accessToken);
    if (!endpoint || typeof endpoint !== "string") {
      throw typedError("E_PUSH_ENDPOINT_REQUIRED", "A push subscription needs its browser endpoint URL.");
    }
    const existing = await this.subscriptions.findOne({ endpoint, identityId: did });
    if (!existing) return { removed: false };
    await this.subscriptions.deleteOne({ _id: existing._id });
    return { removed: true };
  }

  /** GET /push/settings — the member's own controls (defaults when unset). */
  async memberSettings({ accessToken } = {}) {
    const did = await this.#requireIdentity(accessToken);
    const row = await this.settings.findOne({ identityId: did });
    const resolved = row ?? PushService.defaultSettings(did);
    return { settings: { enabled: resolved.enabled, events: resolved.events, mutes: resolved.mutes } };
  }

  /**
   * PUT /push/settings — hub-enforced: the hub checks these on every send.
   * Mutes are networks the member (still) belongs to; a mute of a network
   * without a live membership is refused (plain reason).
   */
  async updateSettings({ accessToken, enabled, events = {}, mutes = [] } = {}) {
    const did = await this.#requireIdentity(accessToken);
    if (typeof enabled !== "boolean") {
      throw typedError("E_PUSH_SETTINGS_INVALID", "The notification switch is on or off.");
    }
    const mergedEvents = { ...DEFAULT_EVENT_SWITCHES };
    if (events && typeof events === "object" && !Array.isArray(events)) {
      for (const [key, value] of Object.entries(events)) {
        if (PUSH_EVENT_TYPES.includes(key)) mergedEvents[key] = value === true;
      }
    }
    const muteList = Array.isArray(mutes) ? [...new Set(mutes.map(String))] : [];
    for (const networkId of muteList) {
      const live = await this.membership.activeMembership({ networkId, did });
      if (!live) {
        throw typedError("E_PUSH_MUTE_NOT_MEMBER", "You can only mute a network you belong to.");
      }
    }
    const now = new Date().toISOString();
    const existing = await this.settings.findOne({ identityId: did });
    const row = { _id: did, identityId: did, enabled, events: mergedEvents, mutes: muteList, updatedAt: now, createdAt: existing?.createdAt ?? now };
    await this.settings.updateOne({ identityId: did }, { $set: { ...row }, upsert: true });
    return { settings: { enabled: row.enabled, events: row.events, mutes: row.mutes } };
  }

  /**
   * THE SEND PIPELINE (ac-2, ac-3, ac-4). One entry point for every push
   * trigger: target resolution runs live membership → settings (read at
   * send time, never cached) → live subscriptions → Web Push send. Never
   * throws: a push outcome is never allowed to break the domain write that
   * fired it (log-only).
   */
  async notify({ networkId, type, targetDids = [], postId = null, commentId = null, actorDid = null, excerpt = null } = {}) {
    try {
      if (!PUSH_EVENT_TYPES.includes(type)) {
        throw new Error(`Unknown push event type "${type}" (the push vocabulary is closed)`);
      }
      // The event surface is per-origin: only recipients of THIS network's
      // events are ever resolved below (origin containment carries).
      const targets = [...new Set(targetDids ?? [])].filter((did) => did && String(did) !== String(actorDid ?? ""));
      const vapid = this.vapid;
      if (!targets.length) return { sent: 0, skipped: 0 };
      if (!vapid) {
        this.#log({ event: "push.send.skipped", reason: "vapid_absent", networkId, type });
        return { sent: 0, skipped: targets.length };
      }
      // Content-only composition (ac-3): author display name + origin
      // network name + the bounded excerpt when the recipient authored the
      // target. No counts, no vote records, no aggregates exist here.
      const networkName = (await this.networks.findOne({ _id: networkId }))?.name ?? null;
      let authorName = null;
      if (actorDid) {
        const names = await this.membership.attributionNames({ networkId, dids: [actorDid] });
        authorName = names.get(actorDid) ?? null;
      }
      let sent = 0;
      let skipped = 0;
      for (const did of targets) {
        // Live membership at send time — never a stored permission. A
        // member removed from the network resolves against nothing here:
        // deliverability died at the same write that revoked them (ac-4).
        const live = await this.membership.activeMembership({ networkId, did });
        if (!live) {
          skipped += 1;
          this.#log({ event: "push.send.skipped", reason: "not_live_member", networkId, type, identityId: did });
          continue;
        }
        // Settings at send time (ac-2): they are read here, on every send.
        const settings = (await this.settings.findOne({ identityId: did })) ?? PushService.defaultSettings(did);
        if (settings.enabled !== true) {
          skipped += 1;
          continue;
        }
        if (settings.mutes?.includes(networkId)) {
          skipped += 1;
          continue;
        }
        if (settings.events?.[type] !== true) {
          skipped += 1;
          continue;
        }
        const plaintext = pushPlaintext({ type, postId, commentId, authorName, networkName, excerpt });
        const subs = await this.subscriptions.find({ identityId: did });
        if (!subs.length) {
          skipped += 1;
          continue;
        }
        for (const subscription of subs) {
          const delivered = await this.#sendOne(subscription, plaintext);
          if (delivered) sent += 1;
        }
      }
      return { sent, skipped };
    } catch (error) {
      // Zero error fanout: a push failure is a local log line, never a
      // broken member write and never an outward report.
      this.#log({ event: "push.dispatch.failed", networkId, type, error: error?.message ?? String(error) });
      return { sent: 0, skipped: 0, failed: true };
    }
  }

  /**
   * NEW MEMBER JOINED (ac-2): the owner and delegates learn a network
   * gained a member at the admission write itself. Targets resolve from
   * live membership at send time; the acting member never receives their
   * own join.
   */
  async notifyNewMember({ networkId, did } = {}) {
    if (!networkId || !did) return { sent: 0, skipped: 0 };
    const roleRows = await this.memberships.find({ networkId, state: "active" });
    const watchers = roleRows
      .filter((row) => row.role === "owner" || row.role === "delegate")
      .map((row) => row.did);
    return this.notify({
      networkId,
      type: "joined",
      targetDids: watchers,
      actorDid: did,
      postId: null,
      commentId: null,
      excerpt: null,
    });
  }

  /**
   * DEVICE-LINK REQUEST (ac-2, owner recipients): a continuity link minted
   * for a member notifies the owner(s) of every network that member is
   * alive on. The minting actor's own networks resolve the same way.
   */
  async notifyDeviceLink({ did } = {}) {
    if (!did) return { sent: 0, skipped: 0 };
    const alive = await this.memberships.find({ did, state: "active" });
    const networkIds = [...new Set(alive.map((row) => row.networkId))];
    let sent = 0;
    for (const networkId of networkIds) {
      const roleRows = await this.memberships.find({ networkId, state: "active" });
      const owners = roleRows.filter((row) => row.role === "owner").map((row) => row.did);
      const { sent: add } = await this.notify({
        networkId,
        type: "deviceLink",
        targetDids: owners,
        actorDid: did,
        postId: null,
        commentId: null,
        excerpt: null,
      });
      sent += add;
    }
    return { sent, skipped: 0 };
  }

  /**
   * One subscription, one send with the 404/410 + bounded-retry policy
   * (ac-4): 404/410 classes expire the subscription server-side (deleted
   * from the store, log-only); any other failure retries exactly once,
   * then drops. Delivery outcomes land only in the local structured log.
   */
  async #sendOne(subscription, plaintext) {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      let statusCode = 0;
      try {
        ({ statusCode } = await this.sender({ subscription, plaintext }));
      } catch (error) {
        statusCode = error?.statusCode ?? 0;
      }
      if (statusCode >= 200 && statusCode < 300) {
        this.#log({ event: "push.send.ok", subscriptionId: subscription._id, identityId: subscription.identityId, attempt });
        return true;
      }
      if (statusCode === 404 || statusCode === 410) {
        // Endpoint gone (re-auth superseded, browser cleared the grant):
        // expire the stored subscription server-side, log-only, no error
        // fanout (ac-4).
        await this.subscriptions.deleteOne({ _id: subscription._id });
        this.#log({
          event: "push.subscription.expired",
          subscriptionId: subscription._id,
          identityId: subscription.identityId,
          statusCode,
        });
        return false;
      }
      // Transient: one bounded retry, then drop (outcomes stay local).
    }
    this.#log({ event: "push.send.dropped", subscriptionId: subscription._id, identityId: subscription.identityId });
    return false;
  }

  async #requireIdentity(accessToken) {
    return (await this.#perimeter(accessToken)).session.did;
  }

  async #perimeter(accessToken) {
    if (!accessToken) {
      throw typedError("E_MUST_SIGN_IN", "Sign in to your membership first.");
    }
    const perimeter = await this.membership.verifyAccessToken(accessToken, { surface: "push" });
    if (!perimeter) {
      throw typedError("E_NOT_PERMITTED", "This action is not available to you in this network.");
    }
    return perimeter;
  }

  #log(entry) {
    // Local structured logs (zero external telemetry): the hub's shared
    // sink — console.log by default, piped to logs/hub.log by the supervisor.
    this.log?.(JSON.stringify({ at: new Date().toISOString(), kind: "push", ...entry }));
  }
}

export default PushService;