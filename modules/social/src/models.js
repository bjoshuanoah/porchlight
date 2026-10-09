/**
 * Social-owned models. These types are owned by the social domain only.
 * identity MUST NOT import this file; identity and social share zero models.
 */
export const socialModels = {
  /**
   * Post (PORCH-006, Schemas amended Oct 8 2026). Exactly one origin network
   * per post; cross-posting makes independent documents with no linkage
   * beyond an optional client-side display hint. Authorship is actor-signed:
   * the Ed25519 device signature is verified at admission time against the
   * per-network device-key enrollment and stored on the document.
   * interactionCounters carry vote aggregates for the ranking formula only
   * (feed-ranking contract) and are never exposed for display.
   */
  post: {
    type: "object",
    required: ["_id", "originNetworkId", "authorId", "type", "createdAt"],
    properties: {
      _id: { type: "string" },
      /** The ONE origin network; content never migrates (content model). */
      originNetworkId: { type: "string" },
      /** Identity reference (member DID). */
      authorId: { type: "string" },
      /** Post types ruled Oct 8 2026: text | photo | video | audio. */
      type: { type: "string", enum: ["text", "photo", "video", "audio"] },
      /** Optional within-origin group container (membership ⊂ network). */
      groupId: { type: ["string", "null"] },
      /** Ed25519 device signature over the canonical write payload. */
      deviceSignature: { type: "string" },
      /** Media references owned by this post alone (media pipeline PORCH-008). */
      mediaRefs: { type: "array", items: { type: "string" } },
      caption: { type: ["string", "null"] },
      /** Text body for type=text posts. */
      body: { type: ["string", "null"] },
      /** Members-only in V1 (visibility ruling). */
      visibility: { type: "string", enum: ["members-only"] },
      /** Client-side display hint ONLY; no domain logic reads it. */
      displayHint: { type: ["object", "null"] },
      interactionCounters: {
        type: "object",
        required: ["upVolume", "downVolume", "voteVolume", "voteRatio", "commentCount", "reactionCount"],
        properties: {
          upVolume: { type: "integer" },
          downVolume: { type: "integer" },
          voteVolume: { type: "integer" },
          voteRatio: { type: "number" },
          commentCount: { type: "integer" },
          reactionCount: { type: "integer" },
        },
      },
      createdAt: { type: "string" },
      /**
       * Latest-activity timestamp (PORCH-007 timeline ordering): bumped by
       * every interaction write; the base timeline's reverse-chron key.
       * `lastActivityAt ?? createdAt` — null until the first interaction.
       */
      lastActivityAt: { type: ["string", "null"] },
    },
  },
  /**
   * Comment (PORCH-006): parentId null = root, otherwise the parent comment
   * on the SAME post (nested replies, depth cap 8). Mentions are validated
   * against origin membership at write time. Every write actor-signed.
   */
  comment: {
    type: "object",
    required: ["_id", "postId", "networkId", "authorDid", "parentId", "body", "createdAt"],
    properties: {
      _id: { type: "string" },
      postId: { type: "string" },
      /** Must equal the post's origin network — origin containment. */
      networkId: { type: "string" },
      authorDid: { type: "string" },
      parentId: { type: ["string", "null"] },
      body: { type: "string" },
      mentions: { type: "array", items: { type: "string" } },
      deviceSignature: { type: "string" },
      createdAt: { type: "string" },
    },
  },
  /**
   * Reaction (PORCH-006, open-vocabulary ruling Brian Oct 8 2026): emoji is
   * stored as-authored and rendered by clients as given. No hub-defined
   * emoji set, no owner-managed emoji assets, no reaction-to-asset id
   * references exist. Validation prevents cross-origin writes and nothing
   * else.
   */
  reaction: {
    type: "object",
    required: ["_id", "postId", "networkId", "memberDid", "emoji", "deviceSignature", "createdAt"],
    properties: {
      _id: { type: "string" },
      postId: { type: "string" },
      networkId: { type: "string" },
      memberDid: { type: "string" },
      /** Any member-provided emoji, stored verbatim. */
      emoji: { type: "string" },
      deviceSignature: { type: "string" },
      createdAt: { type: "string" },
    },
  },
  /**
   * Vote (PORCH-006, vote privacy contract): one effective vote per member
   * per post (changeable), stored signed per member, consumed only by the
   * ranking module. No endpoint ever returns vote records or counts for
   * display; the read surfaces strip them.
   */
  vote: {
    type: "object",
    required: ["_id", "postId", "networkId", "memberDid", "value", "deviceSignature", "createdAt"],
    properties: {
      _id: { type: "string" },
      postId: { type: "string" },
      networkId: { type: "string" },
      memberDid: { type: "string" },
      /** up | down. */
      value: { type: "string", enum: ["up", "down"] },
      deviceSignature: { type: "string" },
      /** Updated when the vote changes (signature re-verified each write). */
      changedAt: { type: ["string", "null"] },
      createdAt: { type: "string" },
    },
  },
  /**
   * Notification (PORCH-006, @mentions/nested replies). Content-free by
   * contract: ids and type only — never a comment body or post caption.
   * Transport lives in client delivery; members poll their own inbox.
   */
  notification: {
    type: "object",
    required: ["_id", "networkId", "memberId", "type", "postId", "createdAt"],
    properties: {
      _id: { type: "string" },
      networkId: { type: "string" },
      /** Recipient (member DID). */
      memberId: { type: "string" },
      /** mention | reply. */
      type: { type: "string", enum: ["mention", "reply"] },
      postId: { type: "string" },
      commentId: { type: ["string", "null"] },
      /** Author of the triggering interaction (DID). */
      actorDid: { type: ["string", "null"] },
      createdAt: { type: "string" },
    },
  },
  /**
   * Group (PORCH-006, groups ruling Brian Oct 8 2026): a container inside a
   * network with its own timeline in the feed layer. Group membership is a
   * subset of that network's membership, managed by the owner or a
   * delegate. A post belongs to at most one network and at most one group;
   * no cross-network groups in V1.
   */
  group: {
    type: "object",
    required: ["_id", "networkId", "name", "members", "createdAt"],
    properties: {
      _id: { type: "string" },
      networkId: { type: "string" },
      name: { type: "string" },
      /** Subset of the network's active membership (member DIDs). */
      members: { type: "array", items: { type: "string" } },
      createdAt: { type: "string" },
    },
  },
  /**
   * Derived-artifact-class records keyed to their original (PORCH-006
   * cascade scope): rendition keys, manual people tags, album memberships.
   * One artifact class from V1; the deletion cascade removes them with the
   * keyed original in the same transactional write.
   */
  derivedData: {
    type: "object",
    required: ["_id", "networkId", "postId", "class", "createdAt"],
    properties: {
      _id: { type: "string" },
      networkId: { type: "string" },
      postId: { type: "string" },
      /** rendition | tag | album_membership. */
      class: { type: "string" },
      /**
       * Member-authored value for manual-organization rows (PORCH-007
       * search): a people-tag value or an album name. Null for renditions.
       * Stored verbatim; the plain-text search index reads it.
       */
      value: { type: ["string", "null"] },
      createdAt: { type: "string" },
    },
  },
  /**
   * Network document (PORCH-003 bootstrap). One origin network per content
   * per the content model; created by the owner during bootstrap. Quota
   * limits are owner-set per network (quantity-only limits rule): null =
   * unset and reported, never silently defaulted.
   */
  network: {
    type: "object",
    required: ["_id", "name", "ownerAccountId"],
    properties: {
      _id: { type: "string" },
      name: { type: "string" },
      ownerAccountId: { type: "string" },
      createdAt: { type: "string" },
      quota: {
        type: "object",
        properties: {
          storageCeilingMb: { type: ["integer", "null"] },
          retentionDays: { type: ["integer", "null"] },
        },
      },
    },
  },
  /**
   * Join-link invite (quantity-only rule: lifecycle state is owner-visible
   * and instantly revocable). Owned exclusively by social. Owner-visible
   * status is derived at read: state "revoked" → revoked; useCount < maxUses
   * → unused; otherwise used. The code rides the join URL the invite
   * service hands back (URL + embedded code).
   */
  invite: {
    type: "object",
    required: ["_id", "token", "networkId", "state"],
    properties: {
      _id: { type: "string" },
      token: { type: "string" },
      networkId: { type: "string" },
      role: { type: "string" },
      maxUses: { type: "integer" },
      useCount: { type: "integer" },
      state: { type: "string", enum: ["active", "revoked"] },
      hubUrl: { type: ["string", "null"] },
      createdAt: { type: "string" },
      revokedAt: { type: ["string", "null"] },
    },
  },
  /**
   * Membership record (PORCH-005). The perimeter itself: access to a
   * network's content comes from holding an approved membership here. One
   * active membership per (did, networkId); roles are owner/delegate/member.
   */
  membership: {
    type: "object",
    required: ["_id", "networkId", "did", "role", "state"],
    properties: {
      _id: { type: "string" },
      networkId: { type: "string" },
      did: { type: "string" },
      role: { type: "string", enum: ["owner", "delegate", "member"] },
      state: { type: "string", enum: ["active", "revoked"] },
      admittedViaInviteId: { type: ["string", "null"] },
      admittedAt: { type: "string" },
      revokedAt: { type: ["string", "null"] },
    },
  },
  /**
   * Membership session (PORCH-005): the admission-issued session whose
   * access token is the membership token scoped to exactly one network.
   * Tokens are stored sha256-hashed only; plaintext is handed back once.
   */
  membershipSession: {
    type: "object",
    required: ["_id", "membershipId", "networkId", "did", "status", "accessExpiresAt"],
    properties: {
      _id: { type: "string" },
      membershipId: { type: "string" },
      networkId: { type: "string" },
      did: { type: "string" },
      accessTokenHash: { type: "string" },
      refreshTokenHash: { type: "string" },
      accessExpiresAt: { type: "string" },
      refreshExpiresAt: { type: "string" },
      status: { type: "string", enum: ["active", "revoked"] },
      createdAt: { type: "string" },
    },
  },
  /**
   * Device key enrollment (PORCH-005). Social keeps its own per-network copy
   * of the member device's Ed25519 PUBLIC key, enrolled at admission where
   * possession is proven by signature. Every social-domain write is verified
   * against this enrollment; private key material never travels to the hub.
   */
  deviceKey: {
    type: "object",
    required: ["_id", "networkId", "did", "deviceId", "publicKeyJwk"],
    properties: {
      _id: { type: "string" },
      networkId: { type: "string" },
      did: { type: "string" },
      deviceId: { type: "string" },
      publicKeyJwk: { type: "object" },
      enrolledAt: { type: "string" },
    },
  },
  /**
   * Quota artifact ledger (PORCH-005, day-one quota primitive). Storage
   * usage per network is the sum of original + rendition artifact rows;
   * retention windows expire rows so the retention sweep can remove them.
   * Content/media modules record artifacts through the quota service.
   */
  artifact: {
    type: "object",
    required: ["_id", "networkId", "kind", "bytes", "createdAt"],
    properties: {
      _id: { type: "string" },
      networkId: { type: "string" },
      kind: { type: "string", enum: ["original", "rendition"] },
      bytes: { type: "integer" },
      sourceId: { type: "string" },
      createdAt: { type: "string" },
      expiresAt: { type: ["string", "null"] },
    },
  },
  /**
   * Member action audit (PORCH-005 ac-4). Member actions are auditable
   * events visible in the owner console: logins (admissions), uploads
   * (artifact records), deletions (retention sweep), revocations.
   */
  auditEvent: {
    type: "object",
    required: ["_id", "networkId", "action", "createdAt"],
    properties: {
      _id: { type: "string" },
      networkId: { type: "string" },
      did: { type: ["string", "null"] },
      action: { type: "string" },
      detail: { type: "object" },
      createdAt: { type: "string" },
    },
  },
};

export default socialModels;
