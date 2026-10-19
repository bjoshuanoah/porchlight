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
 * resolves through THE MASTER SWITCH FIRST (PORCH-063's opt-in default: a
 * row that does not exist, a freshly created row, and any enabled=false
 * row produce no send attempt and no Web Push composition — delivery is
 * impossible for a member who never enabled through the explicit UI flow),
 * then through LIVE membership (never a stored permission — a member
 * removed from a network is unreachable at the same write that revokes
 * them), through this member's remaining settings (per-event toggles,
 * per-network mutes — READ AT SEND TIME, never cached), down to their live
 * subscriptions. Registration gates on the same switch: an off-state
 * identity holds no subscription anywhere for any reason — the walked
 * enable flow is the only subscription-creating path, and flipping the
 * switch off expires the identity's stored subscriptions at that write.
 * Endpoint 404/410 classes expire the stored subscription
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
 * are on at birth (the launch event surface), and group posts ride the
 * same ON side: "Group notifications should be on by default" (Brian,
 * Oct 19, 2026, PORCH-108) — the member's first explicit OFF act writes
 * their switch, and their own switches override from the settings write.
 */
export const DEFAULT_EVENT_SWITCHES = Object.freeze({
  reply: true,
  reaction: true,
  mention: true,
  groupPost: true,
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
      // The relay's own reject reason rides the error body (Apple's class:
      // JSON {reason:"BadJwtToken"|"BadWebPushTopic"|…}); bounded, local-only
      // — it is the delivery discriminator on the drop line.
      return {
        statusCode: error?.statusCode ?? 0,
        body: error?.body != null ? String(error.body).slice(0, 256) : null,
      };
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
   * @param {import("@porchlight/shared").CollectionLike} [deps.groups]
   *   PORCH-088: the groups collection — every per-group preference entry the
   *   settings PUT carries is validated against the member's LIVE group
   *   membership (entries for groups the member no longer holds are refused).
   * @param {{ publicKey: string, privateKey: string, subject: string } | null} deps.vapid
   *   the hub's VAPID material, generated by the runtime setup at first run
   *   and held in hub server state (never committed); null disables sending.
   * @param {({ statusCode: number, body?: string | null }) => Promise<unknown>} [deps.sender]
   *   injectable send transport; defaults to the web-push Push API client.
   *   Relay rejects land in the result's optional body (bounded, local-only).
   * @param {((line: string) => void) | null} [deps.log]
   *   the local structured-log sink (delivery outcomes; never a network).
   */
  constructor({ subscriptions, settings, memberships, networks, membership, vapid, groups = null, sender = null, log = null }) {
    this.subscriptions = subscriptions;
    this.settings = settings;
    this.memberships = memberships;
    this.networks = networks;
    this.membership = membership;
    // PORCH-088: the groups collection — the per-group preference PUT
    // validates every entry against the member's LIVE group membership.
    this.groups = groups;
    this.vapid = vapid ?? null;
    this.sender = sender ?? createWebPushSender(this.vapid);
    this.log = log ?? null;
    this.models = socialModels;
  }

  /**
   * Shipped defaults (PORCH-063, Brian Oct 13, 2026): device notifications
   * are OPT-IN. A settings row that does not exist and a row freshly
   * created both resolve enabled=false — the master switch is off by
   * default, so delivery is impossible for any member who never enabled
   * through the explicit UI flow. The per-event switches keep their
   * shipped defaults, but they matter only once the member walks the
   * explicit enable flow. This default governs creation and unset
   * resolution only: no backfill ever flips an existing enabled row.
   * PORCH-088: the groups member starts empty — unset resolves ON for
   * every group (per-group preference law), no backfill write ever exists.
   */
  static defaultSettings(identityId) {
    return { _id: identityId, identityId, enabled: false, events: { ...DEFAULT_EVENT_SWITCHES }, mutes: [], groups: {}, updatedAt: null };
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
    // Registration rides the explicit off-to-on flow (PORCH-063): an
    // off-state identity — a row resolving enabled=false, including the
    // no-row default — holds no push subscription anywhere for any reason,
    // so registration is refused until the member walked the settings
    // screen's enable flow and persisted enabled=true through the route.
    const memberRow = await this.settings.findOne({ identityId: did });
    if ((memberRow ?? PushService.defaultSettings(did)).enabled !== true) {
      throw typedError("E_PUSH_NOT_ENABLED", "Turn on notifications first — the switch in your notification settings.");
    }
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
    const prior = await this.subscriptions.find({ endpoint });
    const priorSameIdentity = prior.find((row) => row.identityId === did) ?? null;
    if (prior.length) {
      // deleteMany, never deleteOne: legacy psb_ rows (pre-deterministic-id)
      // and any duplicate endpoint rows this race once produced both leave.
      await this.subscriptions.deleteMany({ endpoint });
    }
    if (deviceId) {
      for (const sameDevice of await this.subscriptions.find({ identityId: did, deviceId })) {
        await this.subscriptions.deleteOne({ _id: sameDevice._id });
      }
    }
    const row = {
      // The _id IS the endpoint: replace-never-duplicate holds against
      // concurrent registrations (two racing same-endpoint POSTs upsert to
      // one row — the live-hub defect observed Oct 15 as two rows 1ms
      // apart under the old find-then-insert). Mongo keys a unique index
      // on _id, so the upsert is the atomic race arbiter.
      _id: endpoint,
      identityId: did,
      endpoint,
      keys: { p256dh: keys.p256dh, auth: keys.auth },
      deviceId: deviceId ?? null,
      createdAt: priorSameIdentity ? priorSameIdentity.createdAt : now,
      lastSeen: now,
    };
    await this.subscriptions.updateOne({ _id: endpoint }, { $set: row, upsert: true });
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
    return { settings: { enabled: resolved.enabled, events: resolved.events, mutes: resolved.mutes, groups: resolved.groups ?? {} } };
  }

  /**
   * PORCH-088: the member's resolved per-group notification preference for
   * ONE group — the persisted row's entry read at read/send time, never
   * cached. Unset resolves ON ("on by default for now", Brian Oct 15 2026:
   * for groups that predate this ship and new groups alike); no backfill
   * write is ever needed — the member's first OFF act writes their entry.
   */
  async resolveGroupPreference({ did, groupId } = {}) {
    if (!did || !groupId) return true;
    const row = await this.settings.findOne({ identityId: did });
    const groups = row?.groups ?? {};
    return groups[groupId] !== false;
  }

  /**
   * PUT /push/settings — hub-enforced: the hub checks these on every send.
   * Mutes are networks the member (still) belongs to; a mute of a network
   * without a live membership is refused (plain reason). PORCH-088: the
   * row's groups member rides the same full-row-replace rules — one
   * preference per member per group (boolean map keyed by group id, true =
   * ON), and every entry is validated against the member's LIVE group
   * membership: an entry for a group the member no longer holds is refused
   * with a plain-language reason (no partial write).
   * @param {{ [groupId: string]: boolean } | null} [groupPreferences]
   *   PORCH-088: the per-group preference entries this write carries
   *   (the controller passes the PUT body's `groups` member). null rides
   *   the persisted entries unchanged; a map replaces them in full.
   */
  async updateSettings({ accessToken, enabled, events = {}, mutes = [], groupPreferences = null } = {}) {
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
    // PORCH-088: the groups entries — { groupId: boolean }. Strict shape
    // (object of booleans; no duplicate keys possible in JSON), then the
    // live-membership gate per entry. A full-row replace persists every
    // entry the member carries; removing a group's entry clears it.
    let groupEntries = {};
    if (groupPreferences !== null && groupPreferences !== undefined) {
      if (!groupPreferences || typeof groupPreferences !== "object" || Array.isArray(groupPreferences)) {
        throw typedError("E_PUSH_SETTINGS_INVALID", "Group notification switches are on or off, one per group.");
      }
      groupEntries = { ...groupPreferences };
      for (const [groupId, value] of Object.entries(groupEntries)) {
        if (typeof value !== "boolean") {
          throw typedError("E_PUSH_SETTINGS_INVALID", "Group notification switches are on or off, one per group.");
        }
        await this.#assertLiveGroup({ did, groupId });
      }
    }
    const now = new Date().toISOString();
    const existing = await this.settings.findOne({ identityId: did });
    const row = {
      _id: did,
      identityId: did,
      enabled,
      events: mergedEvents,
      mutes: muteList,
      // Full-row-replace rules: when the write carries no groups member,
      // the persisted entries ride unchanged (the settings screens write
      // whole rows; a groupPreferences==null PUT is the shipped row shape
      // untouched). When it carries them, they replace in full.
      groups: groupPreferences === null || groupPreferences === undefined ? (existing?.groups ?? {}) : groupEntries,
      updatedAt: now,
      createdAt: existing?.createdAt ?? now,
    };
    await this.settings.updateOne({ identityId: did }, { $set: { ...row }, upsert: true });
    // The opt-in contract's other half (PORCH-063): an off-state identity
    // holds no subscription anywhere for any reason — flipping the switch
    // off expires the open identity's stored subscriptions at the same
    // write, so delivery is impossible while off (log-only cleanup).
    if (enabled === false) {
      const expired = await this.subscriptions.deleteMany({ identityId: did });
      if (expired.deletedCount > 0) {
        this.#log({ event: "push.subscriptions.cleared", identityId: did, count: expired.deletedCount });
      }
    }
    return { settings: { enabled: row.enabled, events: row.events, mutes: row.mutes, groups: row.groups } };
  }

  /**
   * PORCH-088: the per-group preference PUT's live-membership gate — the
   * group must exist on one of the member's live networks and hold them on
   * its live roster; anything else refuses the WHOLE write (no partial
   * write, plain language).
   */
  async #assertLiveGroup({ did, groupId } = {}) {
    if (typeof groupId !== "string" || groupId.length === 0) {
      throw typedError("E_PUSH_SETTINGS_INVALID", "Group notification switches are on or off, one per group.");
    }
    const group = this.groups ? await this.groups.findOne({ _id: groupId }) : null;
    if (!group || !Array.isArray(group.members) || !group.members.includes(did)) {
      throw typedError("E_PUSH_GROUP_NOT_MEMBER", "You can only set notifications for a group you belong to.");
    }
    const live = await this.membership.activeMembership({ networkId: group.networkId, did });
    if (!live) {
      throw typedError("E_PUSH_GROUP_NOT_MEMBER", "You can only set notifications for a group you belong to.");
    }
  }

  /**
   * THE SEND PIPELINE (ac-2, ac-3, ac-4). One entry point for every push
   * trigger: target resolution runs the master switch (enforced first —
   * PORCH-063's opt-in default) → live membership → settings' remaining
   * gates (mutes, per-event toggles; read at send time, never cached) →
   * live subscriptions → Web Push send. Never throws: a push outcome is
   * never allowed to break the domain write that fired it (log-only).
   * PORCH-088, the per-group preference takes its ruled slot in the gate
   * order: global master switch; per-event toggle; PER-GROUP PREFERENCE;
   * network mute; live membership and live subscriptions. A group-OFF
   * entry suppresses that group's pushes only; a group-ON entry never
   * resurrects a paused network or a missing global permission (every
   * remaining gate still runs). Unset resolves ON — one preference per
   * member per group, read from the persisted settings row AT SEND TIME,
   * never cached or injected.
   */
  async notify({ networkId, type, targetDids = [], postId = null, commentId = null, actorDid = null, groupId = null, excerpt = null } = {}) {
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
        authorName = names.get(actorDid)?.name ?? null;
      }
      let sent = 0;
      let skipped = 0;
      for (const did of targets) {
        // THE MASTER SWITCH ENFORCES FIRST (PORCH-063): an enabled=false
        // row — no row (the default), a freshly created row, or a
        // pre-existing off row — produces no send attempt and no Web Push
        // composition for any event, regardless of per-event toggles,
        // per-network mutes, or live subscriptions. Settings are read at
        // send time (ac-2), never cached.
        const settings = (await this.settings.findOne({ identityId: did })) ?? PushService.defaultSettings(did);
        if (settings.enabled !== true) {
          skipped += 1;
          // Log-only observable skip: the enabled=false row (no row, fresh
          // row, or off row) is invisible state otherwise — the card can
          // read on elsewhere without this line, delivery is diagnosable.
          this.#log({ event: "push.send.skipped", reason: "switch_off", networkId, type, identityId: did });
          continue;
        }
        if (settings.events?.[type] !== true) {
          skipped += 1;
          this.#log({ event: "push.send.skipped", reason: "event_disabled", networkId, type, identityId: did });
          continue;
        }
        // PORCH-088: the PER-GROUP PREFERENCE in its ruled slot — read from
        // the persisted settings row AT SEND TIME, never cached or injected.
        // A group-OFF entry suppresses that group's pushes only; a group-ON
        // entry never resurrects a paused network or a missing global
        // permission (every remaining gate still runs). Unset resolves ON.
        if (type === "groupPost" && groupId && settings.groups?.[groupId] === false) {
          skipped += 1;
          this.#log({ event: "push.send.skipped", reason: "group_off", networkId, type, identityId: did, groupId });
          continue;
        }
        if (settings.mutes?.includes(networkId)) {
          skipped += 1;
          this.#log({ event: "push.send.skipped", reason: "network_muted", networkId, type, identityId: did });
          continue;
        }
        // Live membership at send time — never a stored permission. A
        // member removed from the network resolves against nothing here:
        // deliverability died at the same write that revoked them (ac-4).
        const live = await this.membership.activeMembership({ networkId, did });
        if (!live) {
          skipped += 1;
          this.#log({ event: "push.send.skipped", reason: "not_live_member", networkId, type, identityId: did });
          continue;
        }
        const plaintext = pushPlaintext({ type, postId, commentId, authorName, networkName, excerpt });
        const subs = await this.subscriptions.find({ identityId: did });
        if (!subs.length) {
          skipped += 1;
          // The compound silent state behind the Oct 15 live finding: an
          // enabled=true row with zero subscription rows (registration
          // never landed, or an earlier off-write/404/410 cleared the
          // rows). Without this line the hub logs nothing on any trigger —
          // the exact "cards on, no push lines" symptom. Log-only.
          this.#log({ event: "push.send.skipped", reason: "no_subscription", networkId, type, identityId: did });
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
    // The loop's LAST outcome feeds the drop line's status/reason pair.
    let result = null;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        result = await this.sender({ subscription, plaintext });
      } catch (error) {
        result = { statusCode: error?.statusCode ?? 0 };
      }
      const statusCode = result?.statusCode ?? 0;
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
          relayBody: result?.body ?? null,
        });
        return false;
      }
      // Transient: one bounded retry, then drop (outcomes stay local).
    }
    const statusCode = result?.statusCode ?? 0;
    this.#log({ event: "push.send.dropped", subscriptionId: subscription._id, identityId: subscription.identityId, statusCode, relayBody: result?.body ?? null });
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
    // sink — console.log by default, piped to logs/hub.log by the
    // supervisor. A boot that never injected a sink (the deployed hub)
    // follows the auth-failure capture's convention: the line lands on
    // stdout, never dropped. The push log is the delivery discriminator —
    // it must exist on every hub, wired or not.
    const line = JSON.stringify({ at: new Date().toISOString(), kind: "push", ...entry });
    if (this.log) this.log(line);
    else console.log(line);
  }
}

export default PushService;