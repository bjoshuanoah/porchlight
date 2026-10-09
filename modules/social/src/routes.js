import { Router } from "express";

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
 * }} controllers
 */
export function createSocialRouter(controllers) {
  const router = Router();
  const { bootstrap, content, feed, membership, console: ownerConsole } = controllers;

  // Bootstrap-era network + invite surface (PORCH-003 contract; unchanged).
  router.get("/network", bootstrap.get);
  router.post("/bootstrap/network", bootstrap.createNetwork);
  router.post("/bootstrap/invite", bootstrap.issueInvite);
  router.post("/bootstrap/invite/revoke", bootstrap.revokeInvite);

  // Join-link perimeter: public verification + admission (PORCH-005 ac-1/2).
  router.get("/join/verify", membership.verify);
  router.post("/join/admit", membership.admit);
  router.post("/session/refresh", membership.refresh);

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

  // Feed assembly (PORCH-007): base timeline, group timelines, and the
  // ranked section — all token-scoped to exactly one origin network. The
  // ranked order comes from the ranking module (the fixed published
  // formula); no surface returns vote counts, ratios, or per-member votes,
  // and no surface reads or writes hidden-list state (client-local).
  router.get("/timeline", feed.timeline);
  router.get("/timeline/groups/:groupId", feed.groupTimeline);
  router.get("/ranked", feed.ranked);
  router.get("/search", feed.search);

  // Owner console server behaviors (PORCH-005 ac-1/3/4) + group containers.
  router.get("/console/ranking", ownerConsole.getRanking);
  router.get("/console/invites", ownerConsole.listInvites);
  router.post("/console/invites", ownerConsole.issueInvite);
  router.post("/console/invites/revoke", ownerConsole.revokeInvite);
  router.get("/console/members", ownerConsole.listMembers);
  router.post("/console/members/revoke", ownerConsole.revokeMember);
  router.get("/console/limits", ownerConsole.getLimits);
  router.put("/console/limits", ownerConsole.setLimits);
  router.get("/console/audit", ownerConsole.listAudit);
  router.post("/console/retention/sweep", ownerConsole.sweepRetention);
  router.post("/console/groups", ownerConsole.createGroup);
  router.get("/console/groups", ownerConsole.listGroups);

  return router;
}

export default createSocialRouter;