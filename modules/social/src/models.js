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
      /** Media references owned by this post alone (media pipeline PORCH-008).
       *  Each ref's served payload carries the media-geometry stamp — display
       *  width, height, computed aspect ratio, durationMs for video — so
       *  clients reserve the final frame before any byte loads (PORCH-049). */
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
      /** Link-preview reference (PORCH-052): one removable reference for the
       *  URL this post carries, resolved hub-side at compose time. Null when
       *  the post carries no URL or its URL degraded to a plain link. */
      previewId: { type: ["string", "null"] },
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
      /** Link-preview reference (PORCH-052): hub-side resolved at compose
       *  time for a reply carrying a URL; null otherwise. */
      previewId: { type: ["string", "null"] },
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
   * Group (PORCH-006, groups ruling Brian Oct 8 2026; creation + membership
   * management amended Oct 14 2026): a container inside a network with its
   * own timeline in the feed layer. Every network member can create a
   * group, and the creating member manages its membership (the earlier
   * owner-or-delegate management wording is superseded). Group membership
   * is a subset of that network's membership. A post belongs to at most one
   * network and at most one group; no cross-network groups in V1.
   */
  group: {
    type: "object",
    required: ["_id", "networkId", "name", "members", "createdAt"],
    properties: {
      _id: { type: "string" },
      networkId: { type: "string" },
      name: { type: "string" },
      /** The creating member (origin-network member DID); null on legacy rows. */
      createdBy: { type: ["string", "null"] },
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
   * Media upload session (PORCH-008 ac-1). One resumable chunked upload:
   * the perimeter-scoped member, the declared bytes, the received chunk
   * indexes, and the lifecycle state (open → committed | aborted). Chunk
   * blobs live outside the store in the content-addressed blob layer,
   * keyed `upl_<uploadId>/<index>`.
   */
  mediaUpload: {
    type: "object",
    required: ["_id", "networkId", "did", "size", "chunkSize", "state", "createdAt"],
    properties: {
      _id: { type: "string" },
      networkId: { type: "string" },
      did: { type: "string" },
      deviceId: { type: "string" },
      size: { type: "integer" },
      contentType: { type: "string" },
      chunkSize: { type: "integer" },
      chunkCount: { type: "integer" },
      receivedChunks: { type: "array" },
      state: { type: "string", enum: ["open", "committed", "aborted"] },
      mediaId: { type: ["string", "null"] },
      createdAt: { type: "string" },
      lastActivityAt: { type: "string" },
    },
  },
  /**
   * Media asset (PORCH-008, PORCH-044). Either the immutable original (the
   * archival record, full original quality) or a hub-generated rendition
   * derived from it (renditionKind: feed-thumb | album | detail image
   * rungs; poster | playable for video). blobKey is the sha256 content
   * address — originals are immutable by construction and renditions are
   * derived artifacts of their original. width/height are the hub-side
   * probe's effective display dims (EXIF-rotated; null for audio);
   * durationSeconds rides video originals (the poster seek). format stamps
   * the rendition derivation of record — rendition rows at an older format
   * are regenerated (the pre-PORCH-044 byte-derivative set was not
   * browser-renderable).
   */
  mediaAsset: {
    type: "object",
    required: ["_id", "networkId", "did", "kind", "blobKey", "sha256", "bytes", "immutable", "createdAt"],
    properties: {
      _id: { type: "string" },
      networkId: { type: "string" },
      did: { type: "string" },
      kind: { type: "string", enum: ["original", "rendition"] },
      renditionKind: { type: ["string", "null"] },
      format: { type: ["string", "null"] },
      originalId: { type: ["string", "null"] },
      contentType: { type: "string" },
      blobKey: { type: "string" },
      sha256: { type: "string" },
      bytes: { type: "integer" },
      width: { type: ["integer", "null"] },
      height: { type: ["integer", "null"] },
      durationSeconds: { type: ["number", "null"] },
      immutable: { type: "boolean" },
      deviceSignature: { type: ["string", "null"] },
      uploadId: { type: ["string", "null"] },
      createdAt: { type: "string" },
    },
  },
  /**
   * Link-preview reference (PORCH-052): the removable per-attach record a
   * post or reply carries for one pasted URL. Metadata resolution is
   * hub-side at compose time; the record carries the shared cache's
   * metadata by value so a cascade removes exactly this attach's data
   * without ever touching the URL-level cache row.
   */
  linkPreview: {
    type: "object",
    required: ["_id", "networkId", "url", "kind", "fetchedAt"],
    properties: {
      _id: { type: "string" },
      networkId: { type: "string" },
      /** The resolved URL as pasted (post-process, one origin of record). */
      url: { type: "string" },
      /** embed | card — the two render classes of record; a resolution
       *  failure never produces a record (the URL rides the text as a plain
       *  link and submit is never blocked). */
      kind: { type: "string", enum: ["embed", "card"] },
      /** oEmbed-class provider identity; null for generic pages. */
      provider: { type: ["string", "null"] },
      /** The provider embed URL for kind=embed; null for kind=card. */
      embedUrl: { type: ["string", "null"] },
      title: { type: ["string", "null"] },
      siteName: { type: ["string", "null"] },
      /** The og:image's media-pipeline original (content-addressed, hub-
       *  generated renditions, hub-origin serving); null for embeds and
       *  imageless cards. */
      ogImageMediaId: { type: ["string", "null"] },
      /** The cache row this resolution reused/upserted. */
      cacheId: { type: "string" },
      fetchedAt: { type: "string" },
      createdAt: { type: "string" },
    },
  },
  /**
   * URL-level metadata cache (PORCH-052, quantity-only): one hub-wide row
   * per URL — repeat shares reuse the cached metadata with zero refetches,
   * and og:image ingest dedupes per origin through `ogAssets` (the media
   * pipeline's content-addressed bytes dedupe globally across origins).
   * No engagement data ever rides this cache.
   */
  linkPreviewCache: {
    type: "object",
    required: ["_id", "url", "kind", "fetchedAt"],
    properties: {
      /** Deterministic: `lpc_<sha256(url)>` — one row per URL. */
      _id: { type: "string" },
      url: { type: "string" },
      kind: { type: "string", enum: ["embed", "card"] },
      provider: { type: ["string", "null"] },
      embedUrl: { type: ["string", "null"] },
      title: { type: ["string", "null"] },
      siteName: { type: ["string", "null"] },
      /** Origins whose og:image bytes were ingested (content-addressed
       *  original ids per network, for origin-contained serving). */
      ogAssets: { type: "object" },
      fetchedAt: { type: "string" },
      lastUsedAt: { type: "string" },
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
  /**
   * Push subscription (PORCH-059): identity-scoped, per device. The
   * subscription binds to the identity the session speaks for, so a shared
   * tablet carries one subscription per member (the shared-device rulings).
   * The endpoint is the opaque browser-issued push URL; `keys` carries the
   * subscription's own encryption keys, so the vendor relay ships only
   * ciphertext it cannot read. No membership scope is stored as a
   * permission here: target resolution reads live membership at send time.
   */
  pushSubscription: {
    type: "object",
    required: ["_id", "identityId", "endpoint", "keys", "createdAt", "lastSeen"],
    properties: {
      _id: { type: "string" },
      /** The identity (did) the session spoke for at registration time. */
      identityId: { type: "string" },
      /** Opaque browser-issued push URL (the vendor relay endpoint). */
      endpoint: { type: "string" },
      /** RFC 8291 client key material; the server holds the public halves. */
      keys: {
        type: "object",
        required: ["p256dh", "auth"],
        properties: {
          p256dh: { type: "string" },
          auth: { type: "string" },
        },
      },
      /** The session's device, for per-device re-registration replacement. */
      deviceId: { type: ["string", "null"] },
      createdAt: { type: "string" },
      lastSeen: { type: "string" },
    },
  },
  /**
   * Push settings (PORCH-059): hub-enforced member controls read at send
   * time, never cached — one global switch, a toggle per event type, a
   * mute per network. The send pipeline consults this row on every send;
   * no permission decision is ever cached.
   */
  pushSettings: {
    type: "object",
    required: ["_id", "identityId", "enabled", "events", "mutes", "updatedAt"],
    properties: {
      _id: { type: "string" },
      identityId: { type: "string" },
      /** The global switch: false silences every push for the member. */
      enabled: { type: "boolean" },
      /** Per-event toggles; missing keys resolve to the shipped defaults. */
      events: {
        type: "object",
        properties: {
          reply: { type: "boolean" },
          reaction: { type: "boolean" },
          mention: { type: "boolean" },
          groupPost: { type: "boolean" },
          joined: { type: "boolean" },
          deviceLink: { type: "boolean" },
        },
      },
      /** Per-network mutes: origin network ids the member pushed a stop to. */
      mutes: { type: "array", items: { type: "string" } },
      updatedAt: { type: "string" },
    },
  },
};

export default socialModels;
