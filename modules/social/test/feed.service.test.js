import { test } from "node:test";
import assert from "node:assert/strict";
import { FeedService } from "../src/services/feed.service.js";

test("FeedService.createPost builds a post", () => {
  const feed = new FeedService();
  const post = feed.createPost({ userId: "user_1", body: "hello" });
  assert.equal(post.userId, "user_1");
  assert.equal(post.body, "hello");
});

test("FeedService.summarize renders the post", () => {
  const feed = new FeedService();
  assert.equal(feed.summarize({ userId: "u", body: "hi" }), "u: hi");
});
