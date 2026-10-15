import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CONFIG, normalizeConfig, createMemoryStore } from "@porchlight/shared";
import type { PorchlightConfig, StoreLike } from "@porchlight/shared";
import { BootstrapService } from "../src/services/bootstrap.service.js";
import { createServer } from "../src/router.js";
import type { Probe } from "../src/dependencies.js";

/**
 * OG shared-route HTML (PORCH-079 ac-4): the shareable client routes — post
 * deep links and join links — serve the SPA document with the og: metas the
 * unauthenticated unfetchers (iMessage, Slack, chat clients) read. The tag
 * set is content-free and resolves from the path alone: a credentialed
 * member's request carries the identical HTML, because no personalized
 * variant exists. Every non-shared client route keeps the plain document.
 */

const OK_PROBES: { mongo: Probe; redis: Probe } = { mongo: async () => "ok", redis: async () => "ok" };

function mutableConfig(): PorchlightConfig {
  return normalizeConfig(JSON.parse(JSON.stringify(DEFAULT_CONFIG)) as PorchlightConfig);
}

/** An HTML-unsafe fixture name proves the tags escape, never leak markup. */
const NETWORK_NAME = 'Oakmont & "Co"';

function ogHub(): Promise<{ base: string; cleanup: () => Promise<void> }> {
  return (async () => {
    const webRoot = await mkdtemp(join(tmpdir(), "porchlight-og-"));
    await mkdir(join(webRoot, "assets"));
    await writeFile(join(webRoot, "index.html"), "<!doctype html><html><head><title>Porchlight</title></head><body>Porchlight bundled SPA</body></html>");
    const store = createMemoryStore() as StoreLike;
    await store.collection("networks").insertOne({ _id: "net_og", name: NETWORK_NAME, hubUrl: "https://porch.love" });
    await store.collection("invites").insertOne({
      _id: "inv_og", token: "og-join-token", networkId: "net_og", role: "member",
      maxUses: 1, useCount: 0, state: "active", hubUrl: "https://porch.love", createdAt: "2026-10-15T10:00:00.000Z", revokedAt: null,
    });
    await store.collection("posts").insertOne({
      _id: "post_og1", originNetworkId: "net_og", authorId: "did:porchlight:susan", type: "text",
      body: "SECRET-PICNIC-BODY-WORDS picnic at five", visibility: "members-only",
      mediaRefs: [], createdAt: "2026-10-15T09:00:00.000Z", lastActivityAt: null, previewId: null, displayHint: null,
    });
    const config = mutableConfig();
    const bootstrap = new BootstrapService(store, config, "/tmp/porchlight-079-contract-home");
    const { promise: port, resolve: resolvePort } = Promise.withResolvers<number>();
    const app = createServer({ store, readiness: OK_PROBES, config, bootstrap, hubUrl: () => null, log: null, webRoot });
    const listener = app.listen(0, () => {
      const address = listener.address();
      resolvePort(typeof address === "object" && address ? address.port : 0);
    });
    const hubPort = await port;
    return {
      base: `http://127.0.0.1:${hubPort}`,
      cleanup: async () => {
        listener.closeIdleConnections();
        listener.close();
        await rm(webRoot, { recursive: true, force: true });
      },
    };
  })();
}

test("ac-4: a post deep link serves og:title/og:image/og:url — content-free, escaped", async (t) => {
  const hub = await ogHub();
  t.after(hub.cleanup);

  const response = await fetch(`${hub.base}/posts/post_og1`);
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/html/i);
  const html = await response.text();
  // The title is the fixed template frame with the network name; the
  // fixture name's markup came through escaped, never as tags.
  assert.ok(html.includes('<meta property="og:title" content="view this post on the Oakmont &amp; &quot;Co&quot; network" />'));
  assert.ok(html.includes('<meta property="og:image" content="https://porch.love/api/social/og/post/post_og1" />'));
  assert.ok(html.includes('<meta property="og:url" content="https://porch.love/posts/post_og1" />'));
  assert.ok(html.indexOf("og:title") > -1 && html.indexOf("og:title") < html.indexOf("og:image") && html.indexOf("og:image") < html.indexOf("og:url"), "the three metas sit coherently in the head");
  // The unfurl surface carries none of the post's content (ac-5 rides the
  // same document here).
  assert.ok(!html.includes("SECRET-PICNIC-BODY-WORDS"), "no post body in the served HTML");
  assert.ok(!html.includes("did:porchlight:susan"), "no member identity in the served HTML");
  // Tag-bearing HTML is not cacheable — a rename must never linger here.
  assert.equal(response.headers.get("cache-control"), "no-store");
});

test("ac-4: the join link serves its own frame on the same contract", async (t) => {
  const hub = await ogHub();
  t.after(hub.cleanup);

  const response = await fetch(`${hub.base}/join/og-join-token`);
  assert.equal(response.status, 200);
  const html = await response.text();
  assert.ok(html.includes('<meta property="og:title" content="join the Oakmont &amp; &quot;Co&quot; network" />'));
  assert.ok(html.includes('<meta property="og:image" content="https://porch.love/api/social/og/invite/og-join-token" />'));
  assert.ok(html.includes('<meta property="og:url" content="https://porch.love/join/og-join-token" />'));
});

test("ac-4: a credentialed member request serves the identical HTML — no personalized variant exists", async (t) => {
  const hub = await ogHub();
  t.after(hub.cleanup);

  const anonymous = await fetch(`${hub.base}/posts/post_og1`);
  const anonymousHtml = await anonymous.text();
  const member = await fetch(`${hub.base}/posts/post_og1`, { headers: { authorization: "Bearer some-member-token" } });
  assert.equal(await member.text(), anonymousHtml, "identical served bytes with credentials");
});

test("every other client route keeps the plain SPA document", async (t) => {
  const hub = await ogHub();
  t.after(hub.cleanup);

  for (const path of ["/", "/timeline", "/groups/family/posts/first", "/posts/post_og1/extra", "/posts/", "/posts", "/join/og-join-token/extra"]) {
    const response = await fetch(`${hub.base}${path}`);
    assert.equal(response.status, 200, path);
    const html = await response.text();
    assert.ok(!html.includes('property="og:'), `${path} carries no og: block`);
  }

  // An unknown entity never renders tags: the plain document serves, so a
  // hostile or truncated link leaks nothing.
  const unknown = await fetch(`${hub.base}/posts/post_nope`);
  assert.equal(unknown.status, 200);
  assert.ok(!(await unknown.text()).includes('property="og:'), "the unknown post serves the plain document");
});