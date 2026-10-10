import dns from "node:dns/promises";
import { sha256Hex, mediaGeometry, typedError } from "./media.service.js";
import { RENDITION_FORMAT_V2 } from "./rendition.encoder.js";
import { socialModels } from "../models.js";

/**
 * Link previews (PORCH-052, Link Previews pair PRD 6ac9d5e689855af1a3b4de54
 * / TS 6ac9d5e689855af1a3b4de53): the hub is the only party that ever
 * contacts third parties for preview metadata or preview assets — member
 * devices never fetch third-party metadata, so member IPs never reach
 * providers for previews (privacy posture, paired PRD).
 *
 * Two render classes of record:
 * - Media providers (embed class): YouTube, Spotify, Apple Music, the
 *   oEmbed class. The provider's embed URL is resolved deterministically
 *   from the pasted URL (watch → /embed, open.spotify → embed), with the
 *   oEmbed-discovered provider endpoints as the fallback class: a page
 *   advertising `application/json+oembed` from its own origin resolves to
 *   its provider embed URL through that discovery document (bounded).
 * - Generic pages (card class): og:image + title + site name. og:image
 *   bytes ingest through the media pipeline (identical path to member
 *   uploads: content-addressed originals, rendition ladder, hub-origin
 *   serving with the long-lived cache) — the member browser never loads a
 *   third-party preview image directly.
 *
 * Fetch bounds (composes-time only): limited redirects, response size
 * cap, content-type allowlist, timeout, private-origin refusal. Any
 * unfetchable, private, or hostile URL degrades to a plain link and never
 * blocks submit (ac-3).
 *
 * The URL-level metadata cache is per hub (quantity-only, no engagement
 * data); og:image assets dedupe per origin (origin-contained serving) and
 * bytewise through the content-addressed blob store globally.
 */

const MAX_CACHE_ROWS = 2000;
const METADATA_CONTENT_TYPES = new Set(["text/html", "application/xhtml+xml"]);
/** The allowlist of record for preview images (type allowlist, ac-3). */
const IMAGE_CONTENT_TYPES = new Set(["image/jpeg", "image/png", "image/webp", "image/gif", "image/avif"]);
/** oEmbed discovery documents: JSON and the JSON+XML oEmbed suffix forms. */
const OEMBED_CONTENT_TYPES = new Set([
  "application/json",
  "text/json",
  "application/json+oembed",
  "text/json+oembed",
  "text/xml+oembed",
]);
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", "#39": "'" };

export class LinkPreviewService {
  /**
   * @param {object} deps
   * @param {import("@porchlight/shared").CollectionLike} deps.previews
   *   `link_previews` — the per-attach reference rows.
   * @param {import("@porchlight/shared").CollectionLike} deps.cache
   *   `link_preview_cache` — the URL-level metadata cache.
   * @param {import("@porchlight/shared").CollectionLike} deps.assets
   *   `media_assets` — the media pipeline's asset rows (og:image originals
   *   + renditions are rows here; cascade and hydration read this).
   * @param {import("@porchlight/shared").CollectionLike} deps.artifacts
   *   The quota artifact ledger.
   * @param {import("./membership.service.js").MembershipService} deps.membership
   * @param {import("./media.service.js").MediaService} deps.media
   * @param {import("./quota.service.js").QuotaService} deps.quota
   * @param {{ get?: (url: string, init?: object) => Promise<Response>, resolveHost?: (host: string) => Promise<Array<{address: string}>>, timeoutMs?: number, maxRedirects?: number, maxMetadataBytes?: number, maxImageBytes?: number }} [options]
   *   Injectable fetch + DNS resolver + fetch bounds (tests inject;
   *   production defaults to global fetch + node:dns).
   */
  constructor({ previews, cache, assets, artifacts, membership, media, quota, audit, realtime }, options = {}) {
    this.previews = previews;
    this.cache = cache;
    this.assets = assets;
    this.artifacts = artifacts;
    this.membership = membership;
    this.media = media;
    this.quota = quota;
    this.realtime = realtime ?? null;
    this.audit = audit ?? (async () => {});
    this.models = socialModels;
    this.fetch = options.fetch ?? ((url, init) => fetch(url, init));
    this.resolveHost = options.resolveHost ?? ((host) => dns.lookup(host, { all: true }));
    this.timeoutMs = options.timeoutMs ?? 8000;
    this.maxRedirects = options.maxRedirects ?? 3;
    this.maxMetadataBytes = options.maxMetadataBytes ?? 512 * 1024;
    this.maxImageBytes = options.maxImageBytes ?? 8 * 1024 * 1024;
  }

  /**
   * Compose-time resolution (ac-3): the hub resolves one pasted URL with
   * bounded fetch. Returns the preview record to attach (`preview`) or the
   * plain-link degrade (`{ kind: "plain" }`) — resolution never throws for
   * anything about the URL itself, only for an unauthenticated caller.
   */
  async resolve({ accessToken, payload, signature } = {}) {
    const session = await this.#requireSession(accessToken);
    const url = typeof payload?.url === "string" ? payload.url : "";
    if (!url) {
      throw typedError("E_PREVIEW_URL_REQUIRED", PREVIEW_MESSAGES.E_PREVIEW_URL_REQUIRED);
    }
    // The signed payload verifies exactly as received (canonical JSON —
    // key order does not matter), before anything resolves or ingests.
    await this.#verifyWrite({ session, payload, signature });
    const parsed = this.#safeUrl(url);
    if (!parsed || (await this.#isPrivateHost(parsed))) {
      // Unfetchable/private/hostile degrade (ac-3): a plain link, submit
      // unblocked. No metadata is ever fetched across a private boundary.
      return { kind: "plain" };
    }

    const cacheId = `lpc_${sha256Hex(parsed.href)}`;
    const hit = await this.cache.findOne({ _id: cacheId });
    if (hit) {
      const record = await this.#recordFromCache(hit, parsed, session.networkId);
      if (record) {
        await this.cache.updateOne({ _id: cacheId }, { $set: { lastUsedAt: new Date().toISOString() } });
        return { preview: this.previewView(record) };
      }
    }
    const resolved = await this.#resolveUncached(parsed, session.networkId);
    if (!resolved) return { kind: "plain" };
    const row = await this.#cacheUpsert(cacheId, parsed.href, resolved, session.networkId);
    const record = await this.#recordFromCache(row, parsed, session.networkId);
    await this.audit("link_preview_resolve", {
      networkId: session.networkId,
      detail: { cacheId, kind: record?.kind ?? "plain" },
    });
    return record ? { preview: this.previewView(record) } : { kind: "plain" };
  }

  /**
   * Attach validation: a post or reply carries one preview reference — it
   * must exist and live at the origin network (containment). An invalid
   * reference degrades to no preview (never blocks submit); the caller
   * stores the returned id (or null).
   */
  async assertAttachable({ networkId, previewId } = {}) {
    if (!previewId || typeof previewId !== "string") return null;
    const row = await this.previews.findOne({ _id: previewId });
    if (!row || row.networkId !== String(networkId)) return null;
    return row;
  }

  /** The served preview view (no counts, no engagement data — content only). */
  previewView(row) {
    if (!row) return null;
    return {
      id: row._id,
      url: row.url,
      kind: row.kind,
      provider: row.provider ?? null,
      embedUrl: row.embedUrl ?? null,
      title: row.title ?? null,
      siteName: row.siteName ?? null,
      fetchedAt: row.fetchedAt ?? null,
    };
  }

  /**
   * Hydration (read time): every post view (and every reply inside its
   * reply slice) that carries previewId receives `preview` — metadata plus
   * the og:image geometry stamp + rendition set of record, identical to the
   * mediaMeta contract, so the client reserves the card frame before a byte
   * loads and builds the srcset from the hub's own origin only.
   */
  async withViews(views, networkId) {
    const ids = new Set();
    for (const view of views) {
      if (view?.previewId) ids.add(view.previewId);
      for (const reply of view?.replySlice ?? []) {
        if (reply?.previewId) ids.add(reply.previewId);
      }
    }
    if (ids.size === 0) return views;
    const rows = (await this.previews.find({ networkId })).filter((row) => ids.has(row._id));
    const byId = new Map();
    for (const row of rows) {
      const meta = row.ogImageMediaId ? await this.#ogImageMeta(row.ogImageMediaId, networkId) : null;
      byId.set(row._id, { ...this.previewView(row), ogImage: meta });
    }
    const attach = (row) => (row?.previewId && byId.has(row.previewId) ? { ...row, preview: byId.get(row.previewId) } : row);
    const hydrated = views.map(attach);
    for (const view of hydrated) {
      if (Array.isArray(view?.replySlice) && view.replySlice.length > 0) {
        view.replySlice = view.replySlice.map(attach);
      }
    }
    return hydrated;
  }

  /**
   * Deletion cascade (TS: ingested og:image artifacts die with the parent
   * content): snapshot parts for the preview reference rows, their
   * og:image asset rows (+ renditions), and the artifact ledger rows keyed
   * to them. The caller folds the parts into its transactional snapshot
   * and then deletes the freed blobs (best-emptied after the write; each
   * blob deletion re-checks that no surviving asset still holds the key,
   * because the content-addressed bytes may be shared across origins).
   */
  async cascadeRows({ networkId, previewIds = [] }) {
    const ids = new Set((previewIds ?? []).filter((id) => typeof id === "string" && id));
    if (ids.size === 0) return { parts: [], blobKeys: [] };
    const recordRows = (await this.previews.find({ networkId })).filter((row) => ids.has(row._id));
    // og:image assets only die with the LAST reference: any surviving
    // record row (this origin) still holding the media id keeps its asset
    // (and the shared bytes) alive; the cascade removes only what dies.
    const surviving = new Set(
      (await this.previews.find({ networkId }))
        .filter((row) => !ids.has(row._id) && row.ogImageMediaId)
        .map((row) => row.ogImageMediaId),
    );
    const mediaIds = [...new Set(recordRows.map((row) => row.ogImageMediaId).filter(Boolean))].filter((id) => !surviving.has(id));
    const assetRows = (await this.assets.find({ networkId })).filter((asset) =>
      mediaIds.includes(asset._id) || (asset.kind === "rendition" && mediaIds.includes(asset.originalId)),
    );
    const artifactRows = (await this.artifacts.find({ networkId })).filter(
      (row) => assetRows.some((asset) => asset._id === row.sourceId) || mediaIds.includes(row.sourceId),
    );
    const blobKeys = [...new Set(assetRows.map((asset) => asset.blobKey))];
    return {
      parts: [
        { collection: this.previews, rows: recordRows },
        { collection: this.assets, rows: assetRows },
        { collection: this.artifacts, rows: artifactRows },
      ],
      blobKeys,
    };
  }

  /**
   * Blob release after the transactional delete: only when no surviving
   * asset row (this origin or any other) still holds the key — the
   * content-addressed store dedupes identical og:image bytes across
   * origins, so the key dies with the last reference (deletion cascade).
   */
  async releaseBlobs(blobKeys) {
    for (const key of blobKeys ?? []) {
      const survivors = await this.assets.find({ blobKey: key });
      if (survivors.length === 0) await this.media.blobs.delete(key);
    }
  }

  /* Internals */

  async #resolveUncached(url, networkId) {
    const embed = classifyEmbed(url);
    if (embed) {
      // Deterministic provider resolution: no hub fetch at all for the
      // static class — the oEmbed-class providers' embed URLs are pure
      // functions of the pasted URL.
      return { kind: "embed", provider: embed.provider, embedUrl: embed.embedUrl, title: null, siteName: null };
    }
    const page = await this.#fetchCapped(url.href, this.maxMetadataBytes, METADATA_CONTENT_TYPES, { accept: "text/html" }).catch(() => null);
    if (!page) return null;
    const meta = parseMetadata(page.body.toString("utf8"));
    const discovered = await this.#resolveOembed(page.finalUrl, meta.oembedEndpoint);
    if (discovered) {
      // oEmbed-discovered provider class: the page's own-origin oEmbed
      // document names the embed URL (paired PRD: the oEmbed class).
      return { kind: "embed", provider: "oembed", embedUrl: discovered, title: meta.title, siteName: meta.siteName };
    }
    // A card of record carries the og:image — the media that makes the
    // compact card a family moment. Without an ingested og:image (missing,
    // unfetchable, hostile, oversized) the URL degrades to a plain link,
    // exactly like an unfetchable page: never a text-only half card.
    const ogImageMediaId = await this.#ingestOgImage(page.finalUrl, meta.image, networkId);
    if (!ogImageMediaId) return null;
    return { kind: "card", provider: null, embedUrl: null, title: meta.title, siteName: meta.siteName, ogImageMediaId };
  }

  /**
   * The oEmbed class discovery: the page's own-origin oEmbed document only
   * (never a third-party endpoint smuggled through a hostile page's
   * discovery element), fetched under the same bounds; the embed URL comes
   * from the document's html iframe payload or its own src field.
   */
  async #resolveOembed(pageUrl, endpoint) {
    const page = this.#safeUrl(pageUrl);
    const target = this.#safeUrl(endpoint ?? "", pageUrl);
    if (!endpoint || !page || !target || target.hostname !== page.hostname) return null;
    const doc = await this.#fetchCapped(target, this.maxMetadataBytes, OEMBED_CONTENT_TYPES, { accept: "application/json" }).then(
      (row) => {
        try {
          return JSON.parse(row.body.toString("utf8"));
        } catch {
          return null;
        }
      },
      () => null,
    );
    if (!doc) return null;
    const src = typeof doc?.html === "string" ? /<iframe\b[^>]*\bsrc\s*=\s*["']([^"']+)["']/i.exec(doc.html) : null;
    const embedUrl = src?.[1] ? decodeEntities(src[1]) : typeof doc?.src === "string" ? doc.src : null;
    return embedUrl || null;
  }

  /** og:image ingest through the media pipeline (identical path to uploads). */
  async #ingestOgImage(baseUrl, imageHref, networkId) {
    if (!imageHref) return null;
    const imageUrl = this.#safeUrl(String(imageHref), baseUrl);
    if (!imageUrl || (await this.#isPrivateHost(imageUrl))) return null;
    const fetched = await this.#fetchCapped(imageUrl.href, this.maxImageBytes, IMAGE_CONTENT_TYPES, { accept: "image/*" }).catch(() => null);
    if (!fetched) return null;
    const mediaId = await this.media.ingestExternalImage({ networkId, bytes: fetched.body, contentType: fetched.contentType });
    return mediaId ?? null;
  }

  /**
   * One cached row's attach record for one origin: kind/embed class from
   * the cache; og:image per origin (the cache stores origin → media id;
   * a lost asset row re-ingests below).
   */
  async #recordFromCache(hit, url, networkId) {
    const ogImageMediaId = hit.ogAssets?.[String(networkId)] ?? null;
    if (hit.kind === "card") {
      if (!ogImageMediaId) return null;
      // A cascade may have already retired this origin's og:image asset;
      // a dead reference re-resolves rather than serving a cardless half.
      const asset = await this.assets.findOne({ _id: ogImageMediaId, networkId: String(networkId), kind: "original" });
      if (!asset) return null;
    }
    const record = {
      _id: `lnk_${crypto.randomUUID()}`,
      networkId: String(networkId),
      url: url.href,
      kind: hit.kind,
      provider: hit.provider ?? null,
      embedUrl: hit.embedUrl ?? null,
      title: hit.title ?? null,
      siteName: hit.siteName ?? null,
      ogImageMediaId,
      cacheId: hit._id,
      fetchedAt: hit.fetchedAt,
      createdAt: new Date().toISOString(),
    };
    await this.previews.insertOne(record);
    return record;
  }

  async #cacheUpsert(cacheId, href, resolved, networkId) {
    const now = new Date().toISOString();
    const existing = await this.cache.findOne({ _id: cacheId });
    const ogAssets =
      resolved.kind === "card" && resolved.ogImageMediaId
        ? { ...(existing?.ogAssets ?? {}), [String(networkId)]: resolved.ogImageMediaId }
        : (existing?.ogAssets ?? {});
    const row = {
      _id: cacheId,
      url: href,
      kind: resolved.kind,
      provider: resolved.provider ?? null,
      embedUrl: resolved.embedUrl ?? null,
      title: resolved.title ?? null,
      siteName: resolved.siteName ?? null,
      ogAssets,
      fetchedAt: existing?.fetchedAt ?? now,
      lastUsedAt: now,
    };
    if (existing) await this.cache.updateOne({ _id: cacheId }, { $set: row });
    else {
      await this.cache.insertOne(row);
      await this.#trimCache();
    }
    return row;
  }

  /** Quantity-only bound on the cache: the oldest rows yield beyond the cap. */
  async #trimCache() {
    const rows = await this.cache.find({});
    if (rows.length <= MAX_CACHE_ROWS) return;
    const ordered = rows.sort((a, b) => String(a.lastUsedAt ?? a.fetchedAt) < String(b.lastUsedAt ?? b.fetchedAt) ? -1 : 1);
    for (const row of ordered.slice(0, rows.length - MAX_CACHE_ROWS)) {
      await this.cache.deleteOne({ _id: row._id });
    }
  }

  async #ogImageMeta(mediaId, networkId) {
    const original = (await this.assets.find({ networkId })).find((row) => row._id === mediaId && row.kind === "original");
    if (!original) return null;
    const renditionRows = (await this.assets.find({ networkId, originalId: mediaId, kind: "rendition" })).filter(
      (row) => row.format === RENDITION_FORMAT_V2,
    );
    const renditions = renditionRows
      .map((row) => ({ kind: row.renditionKind, sha256: row.sha256, width: row.width ?? null, height: row.height ?? null, bytes: row.bytes }))
      .sort((a, b) => (a.width ?? 0) - (b.width ?? 0));
    return {
      mediaId,
      contentType: original.contentType,
      ...mediaGeometry(original),
      durationMs: null,
      poster: null,
      renditions,
    };
  }

  #safeUrl(raw, base = undefined) {
    let url = null;
    try {
      url = new URL(raw, base);
    } catch {
      return null;
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    if (!url.hostname) return null;
    return url;
  }

  /**
   * Private/hostile refusal (ac-3): non-public hostnames and private
   * addresses never resolve. The lookup check catches the classic SSRF
   * dodge — a public hostname resolving into a private range.
   */
  async #isPrivateHost(url) {
    const host = url.hostname.toLowerCase();
    if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".home.arpa")) return true;
    const literal = /^((?:\d{1,3}\.){3}\d{1,3})$/.exec(host);
    if (literal ? isPrivateIpv4(literal[1]) : false) return true;
    if (host.includes(":")) {
      const bare = host.replace(/^\[|\]$/g, "");
      if (bare === "::1" || /^f[cd]/i.test(bare) || bare === "fe80:0:0:0:0:0:0:0" || /^fe80/i.test(bare)) return true;
    }
    try {
      const addresses = (await this.resolveHost(host)) ?? [];
      for (const entry of addresses) {
        if (isPrivateIpv4(entry.address) || isPrivateIpv6(entry.address)) return true;
      }
    } catch {
      // An unresolvable host is an unfetchable host: degrade silently.
      return true;
    }
    return false;
  }

  /**
   * Bounded GET: manual redirect loop (cap of record), per-hop timeout,
   * content-size cap (header + streamed read), content-type allowlist.
   * Any violation raises for the caller to catch and degrade on.
   */
  async #fetchCapped(href, maxBytes, allowlist, headers = {}) {
    let current = new URL(href);
    for (let hop = 0; hop <= this.maxRedirects; hop += 1) {
      if (await this.#isPrivateHost(current)) throw typedError("E_PREVIEW_HOST_PRIVATE", PREVIEW_MESSAGES.E_PREVIEW_HOST_PRIVATE);
      const signal = AbortSignal.timeout(this.timeoutMs);
      const response = await this.fetch(current, { signal, redirect: "manual", headers: { ...(await this.#authlessHeaders(headers)) } });
      if (REDIRECT_STATUSES.has(response.status)) {
        const location = response.headers.get("location");
        if (!location) throw typedError("E_PREVIEW_FETCH_FAILED", PREVIEW_MESSAGES.E_PREVIEW_FETCH_FAILED);
        current = this.#safeUrl(location, current) ?? current;
        continue;
      }
      if (!response.ok) throw typedError("E_PREVIEW_FETCH_FAILED", PREVIEW_MESSAGES.E_PREVIEW_FETCH_FAILED, { status: response.status });
      const contentType = String(response.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
      if (!allowlist.has(contentType)) throw typedError("E_PREVIEW_CONTENT_TYPE", PREVIEW_MESSAGES.E_PREVIEW_CONTENT_TYPE, { contentType });
      const declared = Number(response.headers.get("content-length") ?? 0);
      if (declared > maxBytes) throw typedError("E_PREVIEW_TOO_LARGE", PREVIEW_MESSAGES.E_PREVIEW_TOO_LARGE);
      const body = await readCapped(response, maxBytes, signal);
      return { body, contentType, finalUrl: current };
    }
    throw typedError("E_PREVIEW_REDIRECTS", PREVIEW_MESSAGES.E_PREVIEW_REDIRECTS);
  }

  /** Browser-identical request headers: no hub credentials ever ride out. */
  #authlessHeaders(headers) {
    return Promise.resolve({ ...headers, "user-agent": "porchlight-hub/1.0" });
  }

  async #requireSession(accessToken) {
    if (!accessToken) {
      throw typedError("E_MUST_SIGN_IN", PREVIEW_MESSAGES.E_MUST_SIGN_IN);
    }
    const perimeter = await this.membership.verifyAccessToken(accessToken, { surface: "link-preview" });
    if (!perimeter) {
      throw typedError("E_NOT_PERMITTED", PREVIEW_MESSAGES.E_NOT_PERMITTED);
    }
    return {
      did: perimeter.session.did,
      deviceId: perimeter.session.deviceId,
      networkId: perimeter.membership.networkId,
    };
  }

  /** The compose-time resolve is a device-signed write (it may ingest). */
  async #verifyWrite({ session, payload, signature }) {
    await this.membership.verifyMemberWrite({
      networkId: session.networkId,
      did: session.did,
      deviceId: session.deviceId,
      payload,
      signature,
    });
  }
}

/* ---- module-level deterministic helpers (unit-pinned) ---- */

/**
 * The static oEmbed-class provider map: the known media providers resolve
 * their embed URL deterministically from the pasted URL — three providers
 * of record in the ruling (YouTube, Spotify, Apple Music) plus the generic
 * music.apple storefront shape. Returns null for anything else (the
 * generic-page path decides after a bounded fetch).
 */
export function classifyEmbed(url) {
  const host = url.hostname.toLowerCase().replace(/^(www|m)\./, "");
  const path = url.pathname;
  if (host === "youtube.com" || host === "m.youtube.com" || host === "music.youtube.com") {
    if (path === "/watch") {
      const id = url.searchParams.get("v");
      if (id) return { provider: "youtube", embedUrl: `https://www.youtube.com/embed/${encodeURIComponent(id)}` };
    }
    const shortsOrEmbed = /^\/(?:shorts|embed|live)\/([^/?#]+)/.exec(path);
    if (shortsOrEmbed) return { provider: "youtube", embedUrl: `https://www.youtube.com/embed/${encodeURIComponent(shortsOrEmbed[1])}` };
    return null;
  }
  if (host === "youtu.be") {
    const id = /^\/([^/?#]+)/.exec(path);
    if (id) return { provider: "youtube", embedUrl: `https://www.youtube.com/embed/${encodeURIComponent(id[1])}` };
    return null;
  }
  if (host === "spotify.com" || host === "open.spotify.com") {
    const target = /^\/(?:intl-[a-z-]+\/)?(track|album|playlist|episode|show)\/([^/?#]+)/.exec(path);
    if (target) return { provider: "spotify", embedUrl: `https://open.spotify.com/embed/${target[1]}/${target[2]}` };
    return null;
  }
  if (host === "music.apple.com" && path.length > 1) {
    // Apple Music album/track pages embed at embed.music.apple.com with the
    // storefront path intact.
    return { provider: "apple_music", embedUrl: `https://embed.music.apple.com${path}${url.search}` };
  }
  return null;
}

/**
 * Deterministic HTML metadata extraction: og:, twitter:, and <title>
 * fallbacks; self-origin JSON oEmbed discovery (the oEmbed class). Returns
 * { title, siteName, image, embedUrl, oembedProvider } with entities
 * decoded; every field may be null.
 */
export function parseMetadata(html) {
  const metas = String(html ?? "").match(/<meta\b[^>]*>/gi) ?? [];
  const pick = (key) => {
    for (const tag of metas) {
      const identity = new RegExp(`(?:property|name|itemprop)\\s*=\\s*["']${key}["']`, "i").exec(tag);
      if (!identity) continue;
      const content = /content\s*=\s*["']([^"']*)["']/i.exec(tag);
      if (content?.[1]) return decodeEntities(content[1]).trim() || null;
    }
    return null;
  };
  const title = pick("og:title") ?? pick("twitter:title") ?? (/<title\b[^>]*>([^<]*)<\/title>/i.exec(html)?.[1] ? decodeEntities(/<title\b[^>]*>([^<]*)<\/title>/i.exec(html)[1]).trim() || null : null);
  const siteName = pick("og:site_name") ?? pick("twitter:site");
  const image = pick("og:image") ?? pick("og:image:url") ?? pick("twitter:image");
  const oembedEndpoint = findOembedEndpoint(html);
  return { title, siteName, image, oembedEndpoint };
}

/**
 * oEmbed class discovery (TS: "the oEmbed class"): returns the page's
 * advertised oEmbed JSON endpoint href, or null. The caller fetches that
 * SELF-ORIGIN document under the same bounds and extracts the provider
 * embed URL from its html iframe payload — the discovery element itself
 * is never the embed URL.
 */
export function findOembedEndpoint(html) {
  const link = /<link\b[^>]*>/gi;
  let tag;
  while ((tag = link.exec(String(html ?? "")) ?? null) !== null) {
    const text = tag[0];
    const rel = /rel\s*=\s*["'][^"']*(?:alternate|oembed)[^"']*["']/i.exec(text);
    if (!rel) continue;
    const type = /type\s*=\s*["']([^"']*)["']/i.exec(text);
    if (type && !/application\/(json|xml)\+oembed/i.test(type[1])) continue;
    const href = /href\s*=\s*["']([^"']*)["']/i.exec(text);
    if (!href?.[1]) continue;
    const decoded = decodeEntities(href[1]).trim();
    return decoded || null;
  }
  return null;
}

export function decodeEntities(value) {
  return String(value ?? "").replace(/&(amp|lt|gt|quot|apos|nbsp|#39);/gi, (match, entity) => {
    const key = entity.toLowerCase();
    return key === "#39" ? ENTITIES["#39"] : ENTITIES[key] ?? match;
  });
}

/* Private-address classes (bounded refusals, ac-3). */
export function isPrivateIpv4(address) {
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(String(address ?? ""));
  if (!match) return false;
  const [a, b] = [Number(match[1]), Number(match[2])];
  if ([a, b, Number(match[3]), Number(match[4])].some((octet) => octet > 255)) return true;
  if (a === 0 || a === 10 || a === 127) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  return false;
}

export function isPrivateIpv6(address) {
  const bare = String(address ?? "").toLowerCase();
  if (bare === "::" || bare === "::1") return true;
  if (/^f[cd]/.test(bare)) return true; // fc00::/7 unique-local
  if (/^fe[89ab]/.test(bare)) return true; // fe80::/10 link-local
  if (/^::ffff:(?:\d{1,3}\.){3}\d{1,3}$/.test(bare)) return isPrivateIpv4(bare.split(":").pop());
  return false;
}

/** Read a response body into memory under an explicit byte cap. */
async function readCapped(response, maxBytes, signal) {
  if (!response.body) throw typedError("E_PREVIEW_FETCH_FAILED", PREVIEW_MESSAGES.E_PREVIEW_FETCH_FAILED);
  const reader = response.body.getReader();
  const chunks = [];
  let received = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      received += value.byteLength;
      if (received > maxBytes) {
        throw typedError("E_PREVIEW_TOO_LARGE", PREVIEW_MESSAGES.E_PREVIEW_TOO_LARGE, { received });
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    if (!signal?.aborted) reader.cancel().catch(() => {});
  }
  return Buffer.concat(chunks);
}

export const PREVIEW_MESSAGES = {
  E_MUST_SIGN_IN: "Sign in to your membership before attaching a link preview.",
  E_NOT_PERMITTED: "This action is not available to you in this network.",
  E_PREVIEW_URL_REQUIRED: "A link preview needs a URL to resolve.",
  E_PREVIEW_FETCH_FAILED: "The hub could not fetch that link.",
  E_PREVIEW_CONTENT_TYPE: "That link's response type is not previewable.",
  E_PREVIEW_TOO_LARGE: "That link's response exceeds the hub's fetch bounds.",
  E_PREVIEW_REDIRECTS: "That link redirects more than the hub's fetch bounds allow.",
  E_PREVIEW_HOST_PRIVATE: "That link points at a private address and is not previewable.",
};

export default LinkPreviewService;