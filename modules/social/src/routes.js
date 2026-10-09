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
   * }} controllers
 */
export function createSocialRouter(controllers) {
  const router = Router();
  const { bootstrap, content, feed, membership, console: ownerConsole, media, albums, groups } = controllers;

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
  router.post("/posts/:postId/votes", content.vote);
  router.delete("/posts/:postId", content.deletePost);
  router.delete("/me/content", content.sweepMemberContent);
  router.get("/notifications", content.inbox);
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

  // Owner console server behaviors (PORCH-005 ac-1/3/4) + group containers.
  router.get("/console/ranking", ownerConsole.getRanking);
  router.get("/console/disk", ownerConsole.diskStatus);
  router.post("/console/media/gc", ownerConsole.gcUploads);
  router.get("/console/invites", ownerConsole.listInvites);
  router.post("/console/invites", ownerConsole.issueInvite);
  router.post("/console/invites/revoke", ownerConsole.revokeInvite);
  router.get("/console/members", ownerConsole.listMembers);
  router.post("/console/members/revoke", ownerConsole.revokeMember);
  router.get("/console/limits", ownerConsole.getLimits);
  router.put("/console/limits", ownerConsole.setLimits);
  router.get("/console/audit", ownerConsole.listAudit);
  router.get("/console/system", ownerConsole.systemStatus);
  router.post("/console/retention/sweep", ownerConsole.sweepRetention);
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

  return router;
}

export default createSocialRouter;