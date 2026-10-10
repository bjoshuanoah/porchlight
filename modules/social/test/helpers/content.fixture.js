import { generateKeyPairSync, sign as cryptoSign } from "node:crypto";
import { createMemoryStore } from "@porchlight/shared";
import { InviteService } from "../../src/services/invite.service.js";
import { MembershipService } from "../../src/services/membership.service.js";
import { QuotaService } from "../../src/services/quota.service.js";
import { MediaService } from "../../src/services/media.service.js";
import { createMemoryMediaStore } from "../../src/services/media.store.js";
import { PostService } from "../../src/services/post.service.js";
import { NotificationService } from "../../src/services/notification.service.js";
import { PushService } from "../../src/services/push.service.js";
import { InteractionService } from "../../src/services/interaction.service.js";
import { GroupService } from "../../src/services/group.service.js";
import { RealtimeService, createMemoryEventPlane } from "../../src/services/realtime.service.js";
import { canonicalJson } from "../../src/services/membership.service.js";

export { canonicalJson };

/** A fresh member device: real Ed25519 keypair + base64url signer. */
export function device(deviceId) {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  return {
    deviceId,
    publicKeyJwk: publicKey.export({ format: "jwk" }),
    sign: (message) => cryptoSign(null, Buffer.from(message, "utf8"), privateKey).toString("base64url"),
    signPayload: (payload) => cryptoSign(null, Buffer.from(canonicalJson(payload), "utf8"), privateKey).toString("base64url"),
  };
}

/**
 * Content-engine fixture: memory store + two origin networks + the full
 * post/interaction/notification/group path wired per the contract, with
 * admit helpers that return real membership tokens.
 */
export function fixture({ networkIds = ["net_family", "net_other"], audit = async () => {}, memberNames = null, pushVapid = null, pushSender = null } = {}) {
  const store = createMemoryStore();
  const collections = {
    networks: store.collection("networks"),
    invites: store.collection("invites"),
    memberships: store.collection("memberships"),
    membershipSessions: store.collection("membership_sessions"),
    deviceKeys: store.collection("device_keys"),
    artifacts: store.collection("artifacts"),
    auditEvents: store.collection("audit_events"),
    posts: store.collection("posts"),
    comments: store.collection("comments"),
    reactions: store.collection("reactions"),
    votes: store.collection("votes"),
    notifications: store.collection("notifications"),
    derivedData: store.collection("derived_data"),
    groups: store.collection("groups"),
    pushSubscriptions: store.collection("push_subscriptions"),
    pushSettings: store.collection("push_settings"),
  };

  const invites = new InviteService(collections.invites);
  // PORCH-047: the fixture mirrors the module assembly — the real-time
  // service rides the same memory event plane, and the revocation kill
  // goes through the same hook (late-bound; membership assembles first).
  // PORCH-059: the push surface wires the same way — onJoined rides in the
  // same admission write, and the groupPost/reaction triggers ride their
  // write services.
  let realtime = null;
  let push = null;
  const membership = new MembershipService({
    memberships: collections.memberships,
    membershipSessions: collections.membershipSessions,
    deviceKeys: collections.deviceKeys,
    invites,
    verifyMemberIdToken: (token) => (token ? { did: token } : null),
    memberNames,
    networks: collections.networks,
    onRevoked: (event) => realtime?.killMembership(event.membershipId),
    onJoined: (event) => push?.notifyNewMember(event),
    audit,
  });
  const quota = new QuotaService({ artifacts: collections.artifacts, networks: collections.networks, audit });
  // The media pipeline rides every content surface (PORCH-044): post views
  // hydrate mediaMeta through the real pipeline, so the fixture's member
  // views match the shape the assembled module serves.
  const media = new MediaService({
    uploads: store.collection("media_uploads"),
    assets: store.collection("media_assets"),
    artifacts: collections.artifacts,
    membership,
    quota,
    blobs: createMemoryMediaStore(),
    audit,
  });
  const groups = new GroupService({ groups: collections.groups, memberships: collections.memberships });
  push = new PushService({
    subscriptions: collections.pushSubscriptions,
    settings: collections.pushSettings,
    memberships: collections.memberships,
    networks: collections.networks,
    membership,
    vapid: pushVapid,
    sender: pushSender,
  });
  const notifications = new NotificationService({ notifications: collections.notifications, membership, push });
  const plane = createMemoryEventPlane();
  realtime = new RealtimeService({ membership, plane });
  const posts = new PostService({
    posts: collections.posts,
    comments: collections.comments,
    reactions: collections.reactions,
    votes: collections.votes,
    notifications: collections.notifications,
    derivedData: collections.derivedData,
    artifacts: collections.artifacts,
    groups: collections.groups,
    membership,
    media,
    audit,
    realtime,
    push,
  });
  const interactions = new InteractionService({
    posts: collections.posts,
    comments: collections.comments,
    reactions: collections.reactions,
    votes: collections.votes,
    membership,
    notifications,
    audit,
    realtime,
    push,
  });

  for (const networkId of networkIds) {
    collections.networks.insertOne({
      _id: networkId,
      name: networkId === "net_family" ? "Family" : "Other Family",
      ownerAccountId: null,
      quota: { storageCeilingMb: null, retentionDays: null },
      createdAt: "2026-10-08T00:00:00.000Z",
    });
  }

  /** Admit a DID with a device to a network; returns its membership token. */
  const admit = async ({ networkId, did, device: memberDevice }) => {
    const invite = await invites.issue({ networkId });
    const admitted = await membership.admit({
      code: invite.token,
      identityAccessToken: did,
      deviceId: memberDevice.deviceId,
      devicePublicKeyJwk: memberDevice.publicKeyJwk,
      signature: memberDevice.sign(`porchlight-join:${invite.token}`),
    });
    return admitted;
  };

  return { store, collections, invites, membership, quota, groups, notifications, posts, interactions, media, realtime, realtimePlane: plane, push, audit: { events: collections.auditEvents }, admit, device };
}