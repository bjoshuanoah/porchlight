import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import express from "express";
import sharp from "sharp";
import { fixture } from "./helpers/content.fixture.js";
import { createMemoryMediaStore } from "../src/services/media.store.js";
import { OgService } from "../src/services/og.service.js";
import { assembleSocialModule } from "../src/assemble.js";
import { createMemoryStore } from "@porchlight/shared";

/**
 * OG image generator (PORCH-079): server-composed, cached unfurl images for
 * shared post and invite links. The base artwork and the bundled face ride
 * the module's own assets; the overlay text renders as glyph outlines, so
 * the composition is deterministic and independent of host fonts.
 */

// Brian's safe area (task trail, Oct 15 2026).
const SAFE_AREA = { left: 500, top: 200, width: 1000, height: 650 };
const BASE_BYTES = await readFile(fileURLToPath(new URL("../assets/og/og-base.png", import.meta.url)));

/**
 * The region where a composed image differs from the base artwork: the
 * overlay's footprint. It must sit inside Brian's safe area and carry a
 * real glyph presence — this is the placement AND the perimeter evidence
 * (ac-1/2/5): nothing outside the safe area is ever inked.
 */
async function overlayFootprint(bytes) {
  const [base, out] = await Promise.all([
    sharp(BASE_BYTES).raw().toBuffer({ resolveWithObject: true }),
    sharp(bytes).removeAlpha().raw().toBuffer({ resolveWithObject: true }),
  ]);
  const { width, height } = base.info;
  let minX = width, minY = height, maxX = 0, maxY = 0, count = 0;
  for (let i = 0; i < width * height; i++) {
    const j = i * base.info.channels;
    // The metric is the summed RGB delta: the JPEG floor rides well under
    // 30, the white-on-dark glyph rows climb far above 150.
    const diff =
      Math.abs(base.data[j] - out.data[j]) +
      Math.abs(base.data[j + 1] - out.data[j + 1]) +
      Math.abs(base.data[j + 2] - out.data[j + 2]);
    if (diff > 60) {
      count++;
      const x = i % width, y = Math.floor(i / width);
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
  return { count, minX, minY, maxX, maxY };
}

function ogFixture({ networkName = "Oakmont", hubUrl = "https://porch.love" } = {}) {
  const fx = fixture();
  fx.collections.networks.insertOne({ _id: "net_og", name: networkName, hubUrl });
  fx.collections.invites.insertOne({
    _id: "inv_og1", token: "oginvite-token", networkId: "net_og", role: "member",
    maxUses: 1, useCount: 0, state: "active", hubUrl, createdAt: "2026-10-15T10:00:00.000Z", revokedAt: null,
  });
  // A post whose content is deliberately distinctive: the og surface must
  // never carry any of it (ac-5).
  fx.collections.posts.insertOne({
    _id: "post_og1", originNetworkId: "net_og", authorId: "did:porchlight:susan",
    type: "text", body: "SECRET-PICNIC-BODY-WORDS picnic at five",
    caption: "SECRET-CAPTION-WORDS", visibility: "members-only", mediaRefs: [],
    createdAt: "2026-10-15T09:00:00.000Z", lastActivityAt: null, previewId: null, displayHint: null,
  });
  const lines = [];
  const og = new OgService(
    { posts: fx.collections.posts, invites: fx.collections.invites, networks: fx.collections.networks, ogImages: fx.collections.ogImages, blobs: createMemoryMediaStore() },
    { log: (line) => lines.push(line) },
  );
  return { ...fx, og, lines };
}

test("ac-1: the invite link's OG image composes the base artwork with 'join the [name] network' inside the safe area", async () => {
  const fx = ogFixture();
  const { bytes, composed } = await fx.og.image({ kind: "invite", id: "oginvite-token" });
  assert.equal(composed, true);
  const meta = await sharp(bytes).metadata();
  assert.equal(meta.format, "jpeg");
  assert.equal(meta.width, 1731);
  assert.equal(meta.height, 909);
  const footprint = await overlayFootprint(bytes);
  assert.ok(footprint.count > 2000, `glyphs inked (${footprint.count} px)`);
  assert.ok(
    footprint.minX >= SAFE_AREA.left && footprint.maxX < SAFE_AREA.left + SAFE_AREA.width,
    `footprint x [${footprint.minX},${footprint.maxX}] inside the safe area`,
  );
  assert.ok(
    footprint.minY >= SAFE_AREA.top && footprint.maxY < SAFE_AREA.top + SAFE_AREA.height,
    `footprint y [${footprint.minY},${footprint.maxY}] inside the safe area`,
  );
  assert.match(fx.lines[0] ?? "", /og compose invite/, "the first compose logs");
});

test("ac-2: the post deep link's OG image composes 'view this post on the [name] network' inside the safe area", async () => {
  const fx = ogFixture();
  const { bytes, composed } = await fx.og.image({ kind: "post", id: "post_og1" });
  assert.equal(composed, true);
  const meta = await sharp(bytes).metadata();
  assert.equal(meta.format, "jpeg");
  assert.equal(meta.width, 1731);
  assert.equal(meta.height, 909);
  const footprint = await overlayFootprint(bytes);
  assert.ok(footprint.count > 2000);
  assert.ok(footprint.minX >= SAFE_AREA.left && footprint.maxX < SAFE_AREA.left + SAFE_AREA.width);
  assert.ok(footprint.minY >= SAFE_AREA.top && footprint.maxY < SAFE_AREA.top + SAFE_AREA.height);
});

test("ac-3: a repeated key serves from cache with no re-composite", async () => {
  const fx = ogFixture();
  const first = await fx.og.image({ kind: "invite", id: "oginvite-token" });
  assert.equal(first.composed, true);
  const second = await fx.og.image({ kind: "invite", id: "oginvite-token" });
  assert.equal(second.composed, false, "the second request serves from cache");
  assert.deepEqual(second.key, first.key);
  assert.equal(Buffer.compare(second.bytes, first.bytes), 0);
  // And the same for the post link.
  const firstPost = await fx.og.image({ kind: "post", id: "post_og1" });
  assert.equal(firstPost.composed, true);
  const secondPost = await fx.og.image({ kind: "post", id: "post_og1" });
  assert.equal(secondPost.composed, false);
});

test("ac-3: a network rename yields a new key — the next request composes fresh, never stale text", async () => {
  const fx = ogFixture();
  const first = await fx.og.image({ kind: "invite", id: "oginvite-token" });
  await fx.collections.networks.updateOne({ _id: "net_og" }, { $set: { name: "Oakmont Hills" } });
  const renamed = await fx.og.image({ kind: "invite", id: "oginvite-token" });
  assert.equal(renamed.composed, true, "the rename produced a new key and a re-composite");
  assert.notEqual(renamed.key, first.key);
  assert.notEqual(Buffer.compare(renamed.bytes, first.bytes), 0, "the new name renders different bytes");
  const third = await fx.og.image({ kind: "invite", id: "oginvite-token" });
  assert.equal(third.composed, false, "the renamed key is now cached");
});

test("ac-3: a post document write (lastActivityAt) yields a new key — edits never serve a stale key", async () => {
  const fx = ogFixture();
  const first = await fx.og.image({ kind: "post", id: "post_og1" });
  await fx.collections.posts.updateOne({ _id: "post_og1" }, { $set: { lastActivityAt: "2026-10-15T11:00:00.000Z" } });
  const after = await fx.og.image({ kind: "post", id: "post_og1" });
  assert.equal(after.composed, true, "the bumped content version produced a new key");
  assert.notEqual(after.key, first.key);
});

test("ac-3: the cache key carries (type, entityId, contentVersion, networkName) — sha over the inputs only", async () => {
  const fx = ogFixture();
  const inviteInputs = await fx.og.compositionInputs({ kind: "invite", id: "oginvite-token" });
  assert.equal(inviteInputs.networkName, "Oakmont");
  assert.equal(inviteInputs.contentVersion, "2026-10-15T10:00:00.000Z");
  const postInputs = await fx.og.compositionInputs({ kind: "post", id: "post_og1" });
  assert.equal(postInputs.contentVersion, "2026-10-15T09:00:00.000Z");
  for (const key of [fx.og.cacheKey({ kind: "invite", ...inviteInputs }), fx.og.cacheKey({ kind: "post", ...postInputs })]) {
    assert.match(key, /^[0-9a-f]{64}$/, "the key is opaque hex — no input rides the URL");
  }
});

test("ac-2: an unknown post or invite link refuses plainly (404 semantics), never composes", async () => {
  const fx = ogFixture();
  await assert.rejects(fx.og.image({ kind: "post", id: "post_nope" }), (error) => error.code === "E_OG_NOT_FOUND");
  await assert.rejects(fx.og.image({ kind: "invite", id: "no-such-token" }), (error) => error.code === "E_OG_NOT_FOUND");
  await assert.rejects(fx.og.image({ kind: "weird", id: "post_og1" }), (error) => error.code === "E_OG_NOT_FOUND");
});

test("ac-4: the tag set carries the og:title frame, the og:image route, and the canonical og:url", async () => {
  const fx = ogFixture();
  const postTags = await fx.og.tags({ kind: "post", id: "post_og1", origin: "https://live-tunnel.example" });
  assert.deepEqual(postTags, {
    title: "view this post on the Oakmont network",
    image: "https://porch.love/api/social/og/post/post_og1",
    url: "https://porch.love/posts/post_og1",
  });
  const inviteTags = await fx.og.tags({ kind: "invite", id: "oginvite-token" });
  assert.deepEqual(inviteTags, {
    title: "join the Oakmont network",
    image: "https://porch.love/api/social/og/invite/oginvite-token",
    url: "https://porch.love/join/oginvite-token",
  });
  // Unknown entities resolve null: the plain SPA document serves, no tags.
  assert.equal(await fx.og.tags({ kind: "post", id: "post_nope" }), null);
  assert.equal(await fx.og.tags({ kind: "invite", id: "no-such-token" }), null);
  // With no origin of record the tags still render, relative.
  await fx.collections.networks.updateOne({ _id: "net_og" }, { $set: { hubUrl: null } });
  const relativeTags = await fx.og.tags({ kind: "post", id: "post_og1" });
  assert.equal(relativeTags.image, "/api/social/og/post/post_og1");
});

test("ac-5: the unfurl surface is content-free — no post body, caption, or member identity appears", async () => {
  const fx = ogFixture();
  const { bytes } = await fx.og.image({ kind: "post", id: "post_og1" });
  const tagJson = (await fx.og.tags({ kind: "post", id: "post_og1", origin: "https://live-tunnel.example" }));
  const serialized = JSON.stringify(tagJson);
  for (const secretFragment of [
    "SECRET-PICNIC-BODY-WORDS", "SECRET-CAPTION-WORDS", "picnic at five", "did:porchlight:susan",
  ]) {
    assert.doesNotMatch(serialized, new RegExp(secretFragment.replace(/[-[\]/{}()*+?.\\^$|]/g, "\\$&")), "no content fragment in the og: tag set");
  }
  // The composed image is the base artwork inked ONLY inside the safe area
  // with the template frame (the overlay footprint evidence above): no
  // content, media, or member surface can exist in it. The frame text itself
  // is the fixed template + network name only.
  const footprint = await overlayFootprint(bytes);
  assert.ok(footprint.maxX < SAFE_AREA.left + SAFE_AREA.width && footprint.maxY < SAFE_AREA.top + SAFE_AREA.height);
});

test("the full compose-through-HTTP path: rows → compose → immutable headers", async () => {
  const store = createMemoryStore();
  const networks = store.collection("networks");
  const invites = store.collection("invites");
  networks.insertOne({ _id: "net_og", name: "Oakmont", hubUrl: "https://hub.test" });
  invites.insertOne({ _id: "inv_og2", token: "http-invite", networkId: "net_og", role: "member", maxUses: 1, useCount: 0, state: "active", hubUrl: "https://hub.test", createdAt: "2026-10-15T10:00:00.000Z", revokedAt: null });
  const mod = assembleSocialModule(store);
  const app = express();
  app.use("/api/social", mod.api);
  const server = app.listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const first = await fetch(`${base}/api/social/og/invite/http-invite`);
    assert.equal(first.status, 200);
    assert.match(first.headers.get("content-type") ?? "", /^image\/jpeg/);
    assert.equal(first.headers.get("cache-control"), "public, max-age=31536000, immutable");
    assert.match(first.headers.get("etag") ?? "", /^"[0-9a-f]{64}"$/, "the ETag is the opaque cache key of record");
    const bytes = Buffer.from(await first.arrayBuffer());
    const meta = await sharp(bytes).metadata();
    assert.equal(meta.width, 1731);
    assert.equal(meta.height, 909);
    // The repeat request rides the same cached bytes (no re-composite — the
    // service-level evidence above) and carries the identical key headers.
    const second = await fetch(`${base}/api/social/og/invite/http-invite`);
    assert.equal(second.headers.get("etag"), first.headers.get("etag"));
    assert.equal(Buffer.compare(Buffer.from(await second.arrayBuffer()), bytes), 0);
    // The tag resolution rides the same module surface.
    const tags = await mod.ogService.tags({ kind: "invite", id: "http-invite" });
    assert.equal(tags.image, "https://hub.test/api/social/og/invite/http-invite");
    // The image bytes decode and differ from the base only inside the safe area.
    const footprint = await overlayFootprint(bytes);
    assert.ok(footprint.minX >= SAFE_AREA.left && footprint.maxX < SAFE_AREA.left + SAFE_AREA.width);
    assert.ok(footprint.minY >= SAFE_AREA.top && footprint.maxY < SAFE_AREA.top + SAFE_AREA.height);
  } finally {
    server.close();
  }
});