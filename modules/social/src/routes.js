import express, { Router } from "express";

/**
 * Social routes. Thin REST surface that owns no domain logic — the server
 * (or assembleSocialModule in tests) injects the fully assembled
 * controllers. Route → controller → service → model lives self-contained
 * under the /api/social prefix.
 *
 * @param {{
 *   bootstrap: import("./controllers/social-bootstrap.controller.js").SocialBootstrapController,
 *   content: import("./controllers/content.controller.js").ContentController,
 *   feed: import("./controllers/feed.controller.js").FeedController,
 *   membership: import("./controllers/membership.controller.js").MembershipController,
   *   console: import("./controllers/console.controller.js").ConsoleController,
   *   groups: import("./controllers/groups.controller.js").GroupsController,
   *   media: import("./controllers/media.controller.js").MediaController,
   *   albums: import("./controllers/album.controller.js").AlbumController,
   *   og: import("./controllers/og.controller.js").OgController,
   *   originals: import("./controllers/bulk-original.controller.js").BulkOriginalController,
   * }} controllers
 */
export function createSocialRouter(controllers) {
  const router = Router();
  const { bootstrap, content, feed, membership, console: ownerConsole, media, albums, groups, push, og, originals } = controllers;

  // Bootstrap-era network + invite surface (PORCH-003 contract; unchanged).
  router.get("/network", bootstrap.get);
  router.post("/bootstrap/network", bootstrap.createNetwork);
  router.post("/bootstrap/invite", bootstrap.issueInvite);
  router.post("/bootstrap/invite/revoke", bootstrap.revokeInvite);

  // Join-link perimeter: public verification + admission (PORCH-005 ac-1/2).
  router.get("/join/verify", membership.verify);
  router.post("/join/admit", membership.admit);
  router.post("/session/refresh", membership.refresh);
  router.post("/session/restore", membership.restore);

  // OG unfurl images (PORCH-079): server-composed, cached template frames
  // for shared post and invite links. Publicly fetchable by design — the
  // unfurl surface carries only the fixed template frame and the network
  // name, never post content, media, or member names (the perimeter, ac-5),
  // so unauthenticated unfetchers (iMessage, Slack) fetch these.
  router.get("/og/invite/:token", og.inviteImage);
  router.get("/og/post/:postId", og.postImage);

  // Content engine (PORCH-006): every surface token-scoped to exactly one
  // origin network; writes are actor-signed. No route carries the origin,
  // and no route accepts an interaction across origins.
  router.post("/posts", content.createPost);
  router.get("/posts", content.listPosts);
  router.get("/posts/:postId", content.getPost);
  router.post("/posts/:postId/comments", content.comment);
  router.get("/posts/:postId/comments", content.listComments);
  router.post("/posts/:postId/reactions", content.react);
  router.get("/posts/:postId/reactions", content.listReactions);
  router.delete("/posts/:postId/reactions", content.unreact);
  router.post("/posts/:postId/votes", content.vote);
  // Un-vote clear ride (PORCH-113, Oct 20, 2026): clicking a held vote again
  // resolves this signed clear write — the member's own vote row leaves.
  router.delete("/posts/:postId/votes", content.unvote);
  router.delete("/posts/:postId", content.deletePost);
  // Lifecycle edits (PORCH-093): the author's silent text/caption edit on
  // the post and the author's text edit on a comment; media changes are
  // refused with the delete-and-repost direction.
  router.put("/posts/:postId", content.editPost);
  router.put("/posts/:postId/comments/:commentId", content.editComment);
  // Lifecycle comment delete (PORCH-093 ac-1): author or network owner;
  // one atomic operation tombstones the root and cascades its reply tree.
  router.delete("/posts/:postId/comments/:commentId", content.deleteComment);
  // Bulk original download (PORCH-083): the post's photo set as one
  // streaming zip on the audited original path.
  router.get("/posts/:postId/media/originals.zip", originals.post);
  router.delete("/me/content", content.sweepMemberContent);
  router.get("/notifications", content.inbox);
  // Real-time catch-up (PORCH-047): the returning device's REST fallback —
  // the replayed per-origin delta since its own cursor, stale-flagged when
  // the gap predates the replay window.
  router.get("/events", content.catchUp);
  router.get("/mentions/candidates", content.mentionCandidates);

  // Feed assembly (PORCH-007): base timeline, group timelines, and the
  // ranked section — all token-scoped to exactly one origin network. The
  // ranked order comes from the ranking module (the fixed published
  // formula); no surface returns vote counts, ratios, or per-member votes,
  // and no surface reads or writes hidden-list state (client-local).
  router.get("/timeline", feed.timeline);
  router.get("/timeline/groups/:groupId", feed.groupTimeline);
  router.get("/ranked", feed.ranked);
  router.get("/search", feed.search);

  // Link previews (PORCH-052): compose-time hub-side resolution of one
  // pasted URL — bounded fetch, degrade-to-plain-link on any failure, and
  // the two render classes (provider embed | og:image card). Member
  // devices never fetch third-party metadata or preview bytes; the og:image
  // original + renditions serve from the media pipeline's hub origin.
  router.post("/previews/resolve", content.resolvePreview);

  // Media pipeline (PORCH-008): resumable chunked ingest of immutable
  // originals, hub-generated renditions, rendition-default serving with
  // explicit original retrieval, and the signed export stream. Every
  // surface is token-scoped to exactly one origin network; the state-
  // changing writes (begin, complete, export) are device-signed.
  router.post("/media/uploads", media.beginUpload);
  router.get("/media/uploads/:uploadId", media.uploadStatus);
  router.put(
    "/media/uploads/:uploadId/chunks/:index",
    express.raw({ type: () => true, limit: "8mb" }),
    media.putChunk,
  );
  router.post("/media/uploads/:uploadId/complete", media.completeUpload);
  router.get("/media/:mediaId/renditions/:kind", media.serveRendition);
  router.get("/media/:mediaId/original", media.serveOriginal);
  router.get("/media/export", media.exportArchive);

  // Albums (PORCH-013): manual, deterministic organization. Membership rows
  // are derived-artifact-class records keyed to the original post (deletion-
  // cascade bound); the album surface serves renditions by default with
  // original-quality retrieval as the explicit member action. Every surface
  // is token-scoped to exactly one origin network; writes are device-signed.
  router.get("/albums", albums.listAlbums);
  router.get("/albums/:name", albums.getAlbum);
  router.post("/albums/:name/items", albums.addItem);
  router.delete("/albums/:name/items/:postId", albums.removeItem);
  router.delete("/albums/:name", albums.deleteAlbum);
  router.get("/albums/:name/media", albums.mediaList);
  router.get("/albums/:name/media/:mediaId/renditions/:kind", albums.serveRendition);
  router.get("/albums/:name/media/:mediaId/original", albums.serveOriginal);
  // Bulk original download (PORCH-083): the album's media set as one
  // streaming zip, album containment and visibility riding the album surface.
  router.get("/albums/:name/media/originals.zip", originals.album);

  // Device notifications (PORCH-059): Web Push transport — the subscription
  // route serves the VAPID public key, registration binds identity-scoped
  // subscriptions (re-registration replaces, never duplicates), and the
  // member's settings carry the hub-enforced gates (global switch, per-event
  // toggles, per-network mutes) the send pipeline reads at send time.
  router.get("/push/vapid", push.vapid);
  router.post("/push/subscriptions", push.register);
  router.delete("/push/subscriptions", push.unregister);
  router.get("/push/settings", push.getSettings);
  router.put("/push/settings", push.updateSettings);

  // Owner console server behaviors (PORCH-005 ac-1/3/4) + group containers.
  router.get("/console/ranking", ownerConsole.getRanking);
  router.get("/console/disk", ownerConsole.diskStatus);
  // Media storage location (PORCH-054): the owner's media-root setting —
  // current root + readiness state, and the edit action whose failing
  // path is refused with the check's reason named (no automatic migration).
  router.get("/console/media-root", ownerConsole.getMediaRoot);
  router.put("/console/media-root", ownerConsole.setMediaRoot);
  router.post("/console/media/gc", ownerConsole.gcUploads);
  router.get("/console/invites", ownerConsole.listInvites);
  router.post("/console/invites", ownerConsole.issueInvite);
  router.post("/console/invites/revoke", ownerConsole.revokeInvite);
  router.get("/console/members", ownerConsole.listMembers);
  router.post("/console/members/revoke", ownerConsole.revokeMember);
  // Member administration (PORCH-053): the promote/demote ladder change
  // (owner-only) and the permanent member deletion — the owner-only
  // destructive cascade behind the typed member-name confirmation.
  router.patch("/console/members/role", ownerConsole.setMemberRole);
  router.delete("/console/members/:memberId", ownerConsole.purgeMember);
  router.get("/console/limits", ownerConsole.getLimits);
  router.put("/console/limits", ownerConsole.setLimits);
  router.get("/console/audit", ownerConsole.listAudit);
  router.get("/console/system", ownerConsole.systemStatus);
  // Update surface (PORCH-040): owner-initiated release check (GET) and the
  // single apply-and-restart action (POST). Both owner surfaces — this one
  // and `porchlight update` — ride the hub's ONE shared update service.
  router.get("/console/update", ownerConsole.updateStatus);
  router.post("/console/update", ownerConsole.applyUpdate);
  router.post("/console/retention/sweep", ownerConsole.sweepRetention);
  // Content lifecycle (PORCH-093): the owner-console tombstone RESTORE
  // write of record (the console's tombstone list surface itself rides the
  // deferred console work; when Brian wakes it, the surface rides this).
  router.post("/console/tombstones/:tombstoneId/restore", ownerConsole.restoreTombstone);
  router.post("/console/groups", ownerConsole.createGroup);
  router.get("/console/groups", ownerConsole.listGroups);

  // Group containers, member plane (PORCH-030): the groups index and detail
  // are readable by every member; creation is open to every network member
  // (groups amendment Oct 14 2026 — no owner or delegate elevation); the
  // group's creator (or the network owner) manages its membership from the
  // group's Members view. Every surface is token-scoped to exactly one
  // origin network; the subset rule (group membership ⊂ network membership)
  // is enforced in the group service, so origin containment is unchanged.
  router.get("/groups", groups.list);
  router.get("/groups/:groupId", groups.detail);
  router.post("/groups", groups.create);
  router.post("/groups/:groupId/members", groups.addMembers);
  // Visibility change (PORCH-068 ac-1): the managing member flips a group
  // between private and public; the gate decisions everywhere downstream
  // resolve the group's CURRENT visibility at every read/delivery.
  router.post("/groups/:groupId/visibility", groups.updateVisibility);
  // Membership lifecycle (PORCH-068, Brian's Oct 14 rulings): self-serve
  // join on a public group (no authorization step, delivery turns on
  // immediately); removal by the managing member writes the blocked entry
  // atomically; unblocking lifts it — all member plane, no console surface.
  router.post("/groups/:groupId/join", groups.join);
  router.post("/groups/:groupId/members/remove", groups.removeMember);
  router.post("/groups/:groupId/unblock", groups.unblock);
  // Group settings (PORCH-088, Oct 15 2026 rulings): the menu's server
  // surface — the managing member's (or the network owner's) presentation
  // writes and the moderation act, every write in the write path's
  // authority gate; the group face's rendition serving rides the media
  // pipeline's content-addressed blob store, long-lived cache.
  router.post(
    "/groups/:groupId/avatar",
    // The 6 MB transport belt tightens the byte route; the member-avatar
    // treatment is the cap's enforcement point and refuses over-cap
    // uploads with its named plain language BEFORE anything is stored.
    express.raw({ type: (req) => typeof req?.headers?.["content-type"] === "string" && req.headers["content-type"].startsWith("image/"), limit: "6mb" }),
    groups.setAvatar,
  );
  router.patch("/groups/:groupId/color", groups.setColor);
  router.delete("/groups/:groupId/posts/:postId", groups.removePost);
  router.get("/groups/:groupId/avatar/:kind", groups.serveAvatarRung);

  return router;
}

export default createSocialRouter;