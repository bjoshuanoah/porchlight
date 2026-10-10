import { test } from "node:test";
import assert from "node:assert/strict";
import { device, fixture } from "./helpers/content.fixture.js";
import { assembleSocialModule } from "../src/assemble.js";
import { classifyEmbed, findOembedEndpoint } from "../src/services/link-preview.service.js";

const SUSAN = "did:porchlight:susan";
const JUNE = "did:porchlight:june";
const FAMILY = "net_family";

/**
 * Link preview fixture (PORCH-052): the assembled social module (real
 * membership perimeter, quota ledger, media pipeline, feed assembly) on a
 * memory store, with an injectable hub-side fetch + DNS resolver.
 *
 * The fetch mock routes a small internet: {url → {status, contentType, body}}
 * plus redirect chains, and records every hub-side request so tests pin
 * the bounded-fetch + cache behavior (who was fetched, how often).
 */
function previewFixture({ maxRedirects = 3, maxMetadataBytes, resolveHost } = {}) {
  const fx = fixture();
  fx.collections.networks.updateOne({ _id: FAMILY }, { $set: { ownerDid: SUSAN } });
  const routes = new Map();
  const log = [];
  const fetchImpl = async (input, _init = {}) => {
    const url = String(input instanceof URL ? input : input?.url ?? input).replace(/\/$/, "");
    log.push(url);
    const entry = routes.get(url);
    const target = new URL(url);
    const follow = entry?.redirect ? new URL(entry.redirect, target).toString() : null;
    const status = entry?.status ?? (entry?.body != null ? 200 : (follow ? 302 : 404));
    if (follow && [301, 302, 303, 307, 308].includes(status)) {
      return { ok: false, status, headers: new Headers({ location: entry.redirect }), body: null };
    }
    if (status >= 300) return { ok: false, status, headers: new Headers(), body: null };
    const body = entry?.body ?? "";
    const payload = typeof body === "string" ? Buffer.from(body, "utf8") : body;
    return {
      ok: true,
      status: 200,
      headers: new Headers({ "content-type": entry?.contentType ?? "text/html", "content-length": String(payload.byteLength) }),
      body: { getReader: () => {
        let emitted = false;
        return { read: async () => (emitted ? { done: true, value: undefined } : ((emitted = true), { done: false, value: payload })), cancel: async () => {} };
      } },
    };
  };
  const mod = assembleSocialModule(fx.store, {
    verifyMemberIdToken: (token) => (token ? { did: token } : null),
    media: { diskProbe: async () => ({ totalBytes: 1_000_000, freeBytes: 900_000 }), chunkSize: 64 },
    previews: { fetch: fetchImpl, resolveHost: resolveHost ?? (async () => [{ address: "203.0.113.7" }]), timeoutMs: 50, maxRedirects, maxMetadataBytes, maxImageBytes: maxMetadataBytes },
  });
  const dev = device("dev_s");
  const juneDev = device("dev_j");
  return { ...fx, mod, ...mod, routes, log, dev, juneDev, fetchRoutes: routes };
}

/** Drive compose-time resolution device-signed (exactly like the client). */
async function resolve(previewService, token, dev, url) {
  const payload = { scope: "link-preview", url };
  return previewService.resolve({ accessToken: token, payload, signature: dev.signPayload(payload) });
}

test("ac-1: a YouTube post resolves to the embed class deterministically, never fetched, never autoplay", async () => {
  const fx = previewFixture();
  const { accessToken } = await fx.admit({ networkId: FAMILY, did: SUSAN, device: fx.dev });
  const resolution = await resolve(fx.linkPreviewService, accessToken, fx.dev, "https://www.youtube.com/watch?v=bRk9XKQ9q0s");
  assert.equal(resolution.preview.kind, "embed");
  assert.equal(resolution.preview.provider, "youtube");
  assert.equal(resolution.preview.embedUrl, "https://www.youtube.com/embed/bRk9XKQ9q0s");
  // The static class resolves without any hub fetch at all.
  assert.deepEqual(fx.log, []);
  // No autoplay exists anywhere in the resolved preview shape.
  assert.equal(JSON.stringify(resolution.preview).includes("autoplay"), false);

  // The post attaches the reference and the timeline view carries it.
  const payload = { type: "text", body: "Look https://www.youtube.com/watch?v=bRk9XKQ9q0s", previewId: resolution.preview.id };
  const post = (await fx.postService.create({ accessToken, payload, signature: fx.dev.signPayload(payload) })).post;
  const { posts } = await fx.feedService.timeline({ accessToken });
  const view = posts.find((row) => row._id === post._id);
  assert.equal(view.preview.kind, "embed");
  assert.equal(view.preview.embedUrl, "https://www.youtube.com/embed/bRk9XKQ9q0s");
  // A reply carries its provider embed too (ac-1 covers post or reply):
  // the client resolves the replied URL device-signed (the action layer's
  // submitReply flow), then attaches the reference to the signed comment.
  const replyUrl = "https://open.spotify.com/track/4uLU6hMCjMI75M1A2tKUQC";
  const replyResolution = await resolve(fx.linkPreviewService, accessToken, fx.dev, replyUrl);
  const replyPayload = { postId: post._id, body: replyUrl, previewId: replyResolution.preview.id };
  const reply = (await fx.interactionService.comment({ accessToken, payload: replyPayload, signature: fx.dev.signPayload(replyPayload) })).comment;
  const replyView = (await fx.interactionService.commentThread({ accessToken, postId: post._id })).comments.find((row) => row._id === reply._id);
  assert.equal(replyView.preview.embedUrl, "https://open.spotify.com/embed/track/4uLU6hMCjMI75M1A2tKUQC");
});

test("ac-1: Apple Music and the oEmbed-discovered class resolve to provider embed URLs", async () => {
  const fx = previewFixture();
  const { accessToken } = await fx.admit({ networkId: FAMILY, did: SUSAN, device: fx.dev });
  const apple = await resolve(fx.linkPreviewService, accessToken, fx.dev, "https://music.apple.com/us/album/harvest/1109694959");
  assert.equal(apple.preview.kind, "embed");
  assert.equal(apple.preview.embedUrl, "https://embed.music.apple.com/us/album/harvest/1109694959");

  const page = "https://broadcast.example/episodes/42";
  fx.fetchRoutes.set(page, {
    contentType: "text/html",
    body: '<html><head><link rel="alternate" type="application/json+oembed" href="https://broadcast.example/episodes/42/oembed.json"></head><body>hi</body></html>',
  });
  fx.fetchRoutes.set(`${page}/oembed.json`, {
    contentType: "application/json",
    body: JSON.stringify({ html: '<iframe src="https://broadcast.example/episodes/42/embed" allowfullscreen></iframe>' }),
  });
  const discovered = await resolve(fx.linkPreviewService, accessToken, fx.dev, page);
  assert.equal(discovered.preview.kind, "embed");
  assert.equal(discovered.preview.provider, "oembed");
  assert.equal(discovered.preview.embedUrl, "https://broadcast.example/episodes/42/embed");
  // The discovery contact stays self-origin: only the page + its own
  // oEmbed doc were fetched.
  assert.deepEqual(fx.log, [page, `${page}/oembed.json`]);
});

test("ac-1: a hostile page's third-party oEmbed pointer is never followed", async () => {
  const fx = previewFixture();
  const { accessToken } = await fx.admit({ networkId: FAMILY, did: SUSAN, device: fx.dev });
  const page = "https://bait.example/now";
  fx.fetchRoutes.set(page, {
    contentType: "text/html",
    body: '<html><head><link rel="alternate" type="application/json+oembed" href="https://stranger.example/oembed"></head><body><meta property="og:image" content="https://bait.example/img.jpg"><meta property="og:title" content="Bait"></head></html>',
  });
  fx.fetchRoutes.set("https://bait.example/img.jpg", { contentType: "image/jpeg", body: await sampleJpeg() });
  const resolution = await resolve(fx.linkPreviewService, accessToken, fx.dev, page);
  // The foreign discovery pointer drops out; the page itself resolves to
  // its own card — no contact with stranger.example ever happens.
  assert.notEqual(resolution.preview.provider, "oembed");
  assert.ok(!fx.log.includes("https://stranger.example/oembed"));
});

test("ac-2: a generic og:image page resolves to the compact card with hub-ingested media", async () => {
  const fx = previewFixture();
  const { accessToken } = await fx.admit({ networkId: FAMILY, did: SUSAN, device: fx.dev });
  const page = "https://recipes.example/lasagna";
  fx.fetchRoutes.set(page, {
    contentType: "text/html",
    body: '<html><head><meta property="og:title" content="Grandma&apos;s Lasagna"><meta property="og:site_name" content="Bell&apos;s Kitchen"><meta property="og:image" content="https://recipes.example/og/lasagna.jpg"></head></html>',
  });
  fx.fetchRoutes.set("https://recipes.example/og/lasagna.jpg", { contentType: "image/jpeg", body: await sampleJpeg() });
  const resolution = await resolve(fx.linkPreviewService, accessToken, fx.dev, page);
  assert.equal(resolution.preview.kind, "card");
  assert.equal(resolution.preview.title, "Grandma's Lasagna");
  assert.equal(resolution.preview.siteName, "Bell's Kitchen");

  const payload = { type: "text", body: `Look ${page}`, previewId: resolution.preview.id };
  const post = (await fx.postService.create({ accessToken, payload, signature: fx.dev.signPayload(payload) })).post;
  const { posts } = await fx.feedService.timeline({ accessToken });
  const view = posts.find((row) => row._id === post._id);
  const meta = view.preview.ogImage;
  assert.ok(meta.mediaId, "the card carries the media-pipeline og:image ref");
  assert.ok(meta.renditions.some((rung) => rung.kind === "feed-thumb" && rung.sha256), "the rendition ladder is the set of record");
  // The member browser never loads a third-party image: the view carries
  // only the hub's content-addressed media reference — no third-party URL
  // rides any og:image field.
  assert.equal(JSON.stringify(view.preview).includes("recipes.example/og"), false);
  // The same media serves through the pipeline's rendition path, inside
  // this origin only.
  const row = await fx.store.collection("media_assets").find({}).then((rows) => rows.find((asset) => asset._id === meta.mediaId));
  assert.equal(row.kind, "original");
  assert.equal(row.networkId, FAMILY);
  const served = await fx.mediaService.serveRendition({ accessToken, mediaId: meta.mediaId, renditionKind: "feed-thumb" });
  assert.ok(served.bytes.byteLength > 0);
  // Cross-origin serving is contained: another network's member resolves
  // nothing for this asset — origin containment governs previews exactly
  // as it governs content (PORCH-052 ac-4 / PORCH-052 card class).
  const foreignToken = (await fx.admit({ networkId: "net_other", did: JUNE, device: fx.juneDev })).accessToken;
  await assert.rejects(
    () => fx.mediaService.serveRendition({ accessToken: foreignToken, mediaId: meta.mediaId, renditionKind: "feed-thumb" }),
    (error) => error.code === "E_MEDIA_NOT_FOUND",
  );
});

test("ac-3: the URL-level cache reuses metadata — repeat shares refetch nothing", async () => {
  const fx = previewFixture();
  const { accessToken } = await fx.admit({ networkId: FAMILY, did: SUSAN, device: fx.dev });
  const page = "https://news.example/story";
  fx.fetchRoutes.set(page, { contentType: "text/html", body: "<html><meta property=\"og:title\" content=\"A story\"><meta property=\"og:image\" content=\"https://news.example/og.jpg\"></html>" });
  fx.fetchRoutes.set("https://news.example/og.jpg", { contentType: "image/png", body: await samplePng() });
  const first = await resolve(fx.linkPreviewService, accessToken, fx.dev, page);
  const second = await resolve(fx.linkPreviewService, accessToken, fx.dev, page);
  assert.equal(first.preview.kind, "card");
  assert.equal(second.preview.kind, "card");
  assert.equal(fx.log.filter((url) => url === page).length, 1, "the page was fetched once for the whole hub");
  assert.equal(fx.log.filter((url) => url === "https://news.example/og.jpg").length, 1, "the og:image was fetched once");
  // The bytes dedupe through the content-addressed store: one cache row
  // maps the origin to one og:image original.
  assert.equal(first.preview.id !== second.preview.id, true, "each attach carries its own reference row");
  const cacheRow = await fx.store.collection("link_preview_cache").find({}).then((cache) => cache.find((row) => row.url === page));
  assert.equal(Object.keys(cacheRow.ogAssets).join(","), FAMILY);
});

test("ac-3: bounded fetch — private, hostile, unfetchable, oversized, wrong-type, too-many-redirect URLs degrade to plain links and never block submit", async () => {
  const fx = previewFixture({ maxRedirects: 2 });
  const { accessToken } = await fx.admit({ networkId: FAMILY, did: SUSAN, device: fx.dev });

  fx.fetchRoutes.set("https://down.example/500", { status: 500 });
  fx.fetchRoutes.set("https://api.example/json", { contentType: "application/json", body: "{}" });
  // Private address literals and hostnames.
  for (const bad of ["http://127.0.0.1/admin", "http://localhost/", "http://10.1.2.3/", "http://192.168.0.5/", "ftp://files.example/doc"]) {
    assert.deepEqual(await resolve(fx.linkPreviewService, accessToken, fx.dev, bad), { kind: "plain" }, bad);
    assert.deepEqual(fx.log, [], `nothing was fetched across a private boundary (${bad})`);
  }
  // A public hostname resolving into a private range (SSRF dodge).
  fx.routes.clear();
  const fx2 = previewFixture({ resolveHost: async () => [{ address: "10.0.0.7" }] });
  const { accessToken: token2 } = await fx2.admit({ networkId: FAMILY, did: SUSAN, device: fx2.dev });
  assert.deepEqual(await resolve(fx2.linkPreviewService, token2, fx2.dev, "https://dodge.example/page"), { kind: "plain" });

  // Unfetchable (server error) and missing.
  assert.deepEqual(await resolve(fx.linkPreviewService, accessToken, fx.dev, "https://down.example/404"), { kind: "plain" });
  assert.deepEqual(await resolve(fx.linkPreviewService, accessToken, fx.dev, "https://down.example/500"), { kind: "plain" });
  // Content-type outside the allowlist.
  assert.deepEqual(await resolve(fx.linkPreviewService, accessToken, fx.dev, "https://api.example/json"), { kind: "plain" });
  // Oversized metadata response.
  const big = "https://big.example/page";
  fx.fetchRoutes.set(big, { contentType: "text/html", body: "x".repeat(700 * 1024) });
  assert.deepEqual(await resolve(fx.linkPreviewService, accessToken, fx.dev, big), { kind: "plain" });
  // Redirect longer than the bound.
  fx.fetchRoutes.set("https://loops.example/one", { redirect: "https://loops.example/two" });
  fx.fetchRoutes.set("https://loops.example/two", { redirect: "https://loops.example/three" });
  fx.fetchRoutes.set("https://loops.example/three", { redirect: "https://loops.example/four" });
  assert.deepEqual(await resolve(fx.linkPreviewService, accessToken, fx.dev, "https://loops.example/one"), { kind: "plain" });

  // Submit is never blocked: every degraded URL still composes fine.
  const payload = { type: "text", body: "Read http://down.example/404 — will be back", previewId: null };
  const post = (await fx.postService.create({ accessToken, payload, signature: fx.dev.signPayload(payload) })).post;
  assert.equal(post.previewId, null);
  // A stale or foreign preview reference also degrades, never throws.
  const stalePayload = { type: "text", body: "gone", previewId: "lnk_never_existed" };
  const stalePost = (await fx.postService.create({ accessToken, payload: stalePayload, signature: fx.dev.signPayload(stalePayload) })).post;
  assert.equal(stalePost.previewId, null);
});

test("ac-2 deletion cascade: a post delete carries its preview records, og:image assets, renditions, ledger rows, and bytes away", async () => {
  const fx = previewFixture();
  const { accessToken } = await fx.admit({ networkId: FAMILY, did: SUSAN, device: fx.dev });

  // Post 1: og:image card. Post 2: same URL shared again (its own record
  // and reference; the same content-addressed bytes).
  const page = "https://garden.example/tulips";
  fx.fetchRoutes.set(page, { contentType: "text/html", body: '<html><meta property="og:title" content="Tulips"><meta property="og:image" content="https://garden.example/og.jpg"></html>' });
  fx.fetchRoutes.set("https://garden.example/og.jpg", { contentType: "image/png", body: await samplePng() });
  const first = await resolve(fx.linkPreviewService, accessToken, fx.dev, page);
  const second = await resolve(fx.linkPreviewService, accessToken, fx.dev, page);
  const p1Payload = { type: "text", body: `one ${page}`, previewId: first.preview.id };
  const p2Payload = { type: "text", body: `two ${page}`, previewId: second.preview.id };
  const postOne = (await fx.postService.create({ accessToken, payload: p1Payload, signature: fx.dev.signPayload(p1Payload) })).post;
  const postTwo = (await fx.postService.create({ accessToken, payload: p2Payload, signature: fx.dev.signPayload(p2Payload) })).post;
  
  // A reply with its own distinct preview dies with its parent post too.
  const replyPage = "https://notes.example/page";
  fx.fetchRoutes.set(replyPage, { contentType: "text/html", body: '<html><meta property="og:image" content="https://notes.example/og.jpg"><meta property="og:title" content="Notes"></html>' });
  fx.fetchRoutes.set("https://notes.example/og.jpg", { contentType: "image/png", body: await samplePng() });
  const replyPreview = await resolve(fx.linkPreviewService, accessToken, fx.dev, replyPage);
  const replyPayload = { postId: postOne._id, body: `also ${replyPage}`, previewId: replyPreview.preview.id };
  const reply = (await fx.interactionService.comment({ accessToken, payload: replyPayload, signature: fx.dev.signPayload(replyPayload) })).comment;
  assert.ok(reply.previewId);
  // The reference rows of record, captured BEFORE any cascade: each points
  // at its origin's ingested og:image (one shared original per URL).
  const previews = (await fx.store.collection("link_previews").find({})).reduce((map, row) => map.set(row._id, row), new Map());
  assert.ok(previews.get(reply.previewId).ogImageMediaId, "the reply's record references its ingested og:image");
  const replyMediaId = previews.get(reply.previewId).ogImageMediaId;
  const replyBlobKey = (await fx.store.collection("media_assets").find({})).find((row) => row._id === replyMediaId)?.blobKey;
  assert.ok(replyBlobKey, "the reply's og:image original held content-addressed bytes");

  await fx.postService.deletePost({
    accessToken,
    postId: postOne._id,
    signature: fx.dev.signPayload({ kind: "delete", postId: postOne._id, networkId: FAMILY }),
  });

  const rows = (name) => fx.store.collection(name).find({});
  // The deleted post's record and its reply's record are gone; post two's
  // reference survives because its own record row still points at it.
  const previewIds = (await rows("link_previews")).map((row) => row._id);
  assert.equal(previewIds.includes(first.preview.id), false);
  assert.equal(previewIds.includes(replyPreview.preview.id), false);
  assert.equal(previewIds.includes(second.preview.id), true);

  // og:image assets only die with the LAST reference — the surviving
  // record still hydrates its ingested og:image.
  const secondView = (await fx.postService.get({ accessToken, postId: postTwo._id })).post;
  assert.ok(secondView.preview.ogImage.mediaId, "the surviving reference still hydrates its ingested og:image");

  // The reply's og:image died fully: no asset, no rendition, no ledger row,
  // no bytes.
  assert.equal((await rows("media_assets")).some((row) => row._id === replyMediaId || row.originalId === replyMediaId), false);
  assert.equal((await rows("artifacts")).some((row) => row.sourceId === replyMediaId), false);
  assert.equal(await fx.mediaService.blobs.get(replyBlobKey), null, "the og:image bytes died with the parent content");

  // Cascading the second post removes the last reference: the og:image
  // asset, renditions, ledger, and the shared bytes all go.
  await fx.postService.deletePost({
    accessToken,
    postId: postTwo._id,
    signature: fx.dev.signPayload({ kind: "delete", postId: postTwo._id, networkId: FAMILY }),
  });
  const gardenMediaId = previews.get(second.preview.id).ogImageMediaId;
  const rowsAfter = (await rows("media_assets")).filter((row) => row._id === gardenMediaId || row.originalId === gardenMediaId);
  assert.equal(rowsAfter.length, 0);
  assert.equal((await rows("artifacts")).some((row) => row.sourceId === gardenMediaId), false);
  // The URL-level cache never dies with content — the hub keeps reusing it.
  assert.ok(await fx.store.collection("link_preview_cache").find({}).then((c) => c.some((row) => row.url === page)));
  // A third share of the same URL re-ingests bytes (the cache metadata is
  // reusable, the assets are gone) — the blob store dedupes the new bytes.
  const third = await resolve(fx.linkPreviewService, accessToken, fx.dev, page);
  const thirdRecord = (await rows("link_previews")).find((row) => row._id === third.preview.id);
  const thirdMediaId = thirdRecord?.ogImageMediaId;
  assert.ok(thirdMediaId, "the third share re-ingests the og:image through the media pipeline");
  const thirdBlobKey = (await rows("media_assets")).find((row) => row._id === thirdMediaId)?.blobKey;
  assert.ok(thirdBlobKey && (await fx.mediaService.blobs.get(thirdBlobKey)) !== null, "the bytes are storeable again");
});

test("helper contracts: the deterministic classifier and segmenter hold", () => {
  assert.deepEqual(classifyEmbed(new URL("https://youtu.be/abc123")), { provider: "youtube", embedUrl: "https://www.youtube.com/embed/abc123" });
  assert.deepEqual(classifyEmbed(new URL("https://open.spotify.com/intl-de/track/4uLU6hMCjMI75M1A2tKUQC")), { provider: "spotify", embedUrl: "https://open.spotify.com/embed/track/4uLU6hMCjMI75M1A2tKUQC" });
  assert.equal(classifyEmbed(new URL("https://spotify.com/embed/track/9")), null);
  assert.equal(classifyEmbed(new URL("https://example.com/watch?v=9")), null);
  assert.equal(findOembedEndpoint('<link rel="alternate" type="application/json+oembed" href="/x.json">'), "/x.json");
  assert.equal(findOembedEndpoint("<p>no oembed here</p>"), null);
});

/* Real-coded sample og Images: deterministic, decodable, tiny — and
   DISTINCT per call (identical bytes would legitimately share the
   content-addressed blob across URLs, which the cascade must honor). */
import sharp from "sharp";
let sampleCounter = 0;
async function sampleJpeg() {
  const fill = 90 + (sampleCounter += 1) * 7;
  const raw = Buffer.alloc(96 * 96 * 3, fill);
  for (let i = 1; i < raw.length; i += 3) raw[i] = 200;
  return sharp(raw, { raw: { width: 96, height: 96, channels: 3 } }).jpeg().toBuffer();
}
async function samplePng() {
  const fill = 40 + (sampleCounter += 3) * 11;
  const raw = Buffer.alloc(64 * 64 * 4, fill);
  return sharp(raw, { raw: { width: 64, height: 64, channels: 4 } }).png().toBuffer();
}