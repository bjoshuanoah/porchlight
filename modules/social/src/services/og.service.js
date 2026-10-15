import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import opentype from "opentype.js";
import sharp from "sharp";
import { sha256Hex } from "./media.store.js";
import { typedError } from "./media.service.js";

/**
 * OG image composer (PORCH-079). The hub composes entity unfurl images on
 * request and caches them, riding the media stack (platform-complete sharp,
 * PORCH-067). The unfurl surface carries ONLY Brian's fixed template frames
 * plus the network name — never post content, media, or member names (the
 * perimeter, ac-5).
 *
 * Composition is fully deterministic per hub OS class:
 *  - the base artwork (Brian's Twilight Glow asset, 1731x909) and the
 *    overlay face (Roboto Medium, Apache 2.0 — see assets/og/NOTICE.md) are
 *    BUNDLED with the module;
 *  - text is rasterized as VECTOR GLYPH PATHS (opentype.js over the bundled
 *    TTF, composited as SVG paths through sharp/librsvg). No host fontconfig
 *    is consulted anywhere in the chain — sharp's pango fontfile path is
 *    fontconfig-gated and host-dependent (proven on a fontconfig-less macOS
 *    during the build: every face renders in one machine fallback), so the
 *    glyph-outline route takes the whole silent-wrong-font failure class off
 *    the table. The same bytes compose on every hub.
 *
 * Cache (ac-3): one entry per composed key
 *   key = sha256(kind | entityId | contentVersion | networkName)
 * held as an `og_images` mapping row {inputKey → blobKey}; the bytes live in
 * the pipeline's content-addressed blob store under their own sha256 (the
 * store's key regime), riding the configured media root. The overlay's only
 * mutable inputs are the network name and the entity's content version, so
 * the key resolves stale-on-edit deterministically — a network rename or a
 * post document write yields a NEW key and the next request composes (and
 * caches) fresh; the stale artifact is simply never requested again.
 * Composed images serve immutable (the rendered-media cache contract: their
 * ETag is the key, and a key's bytes are fixed).
 *
 * Content version of record: the post's own document-write stamp
 * (lastActivityAt ?? createdAt — the one field every post write path bumps
 * or sets); invites are immutable documents, so their createdAt is theirs.
 * The rendered URL carries the sha256, never the inputs.
 */

// Brian's safe area (task trail, Oct 15 2026): the deliberate off-center
// panel the template frames render into, centered text. The 16px horizontal
// inset keeps the inked (and antialiased) rows clear of the panel edge.
const SAFE_AREA = { left: 500, top: 200, width: 1000, height: 650 };
const SAFETY_INSET = 16;
const TARGET_FONT_SIZE = 96;

export class OgService {
  constructor(deps, options = {}) {
    this.posts = deps.posts;
    this.invites = deps.invites;
    this.networks = deps.networks;
    this.blobs = deps.blobs;
    // The og cache's mapping rows (ac-3): inputKey → content-addressed blob.
    this.ogImages = deps.ogImages ?? null;
    if (!this.ogImages) {
      // A missing mapping collection is a wiring error — fail loudly here,
      // never at first image time.
      throw new Error("OgService requires the ogImages collection");
    }
    this.log = options.log ?? null;
    this.basePath = options.basePath ?? fileURLToPath(new URL("../../assets/og/og-base.png", import.meta.url));
    this.fontPath = options.fontPath ?? fileURLToPath(new URL("../../assets/og/Roboto-Medium.ttf", import.meta.url));
    this.#basePromise = null;
    this.#fontPromise = null;
  }

  #basePromise;
  #fontPromise;

  /** Brian's base asset — read once per process, immutable thereafter. */
  async baseBytes() {
    this.#basePromise ??= readFile(this.basePath);
    return this.#basePromise;
  }

  /** The bundled Roboto Medium face, parsed once per process. */
  async font() {
    this.#fontPromise ??= readFile(this.fontPath).then((bytes) => opentype.parse(
      bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
    ));
    return this.#fontPromise;
  }

  /**
   * Cache key of record (ac-3): sha256 over kind, entity id, the entity's
   * content version, and the network name — the ONLY inputs the rendered
   * overlay depends on. Hex, so the blob store's safe charset takes it.
   */
  cacheKey({ kind, entityId, contentVersion, networkName }) {
    return createHash("sha256").update(`${kind}|${entityId}|${contentVersion}|${networkName}`).digest("hex");
  }

  /**
   * Resolve the composition inputs for one entity. Entity read is scoped to
   * exactly the fields the frame needs (origin network + content version) —
   * the composer never touches caption, body, media refs, or member names.
   * Existing invite rows resolve in ANY lifecycle state (unused/used/
   * revoked): the frame is content-free, and the states never enter it.
   */
  async compositionInputs({ kind, id }) {
    if (kind === "invite") {
      const invite = await this.invites.findOne({ token: String(id) });
      if (!invite) throw typedError("E_OG_NOT_FOUND", "no unfurl image for this link");
      const network = await this.networks.findOne({ _id: String(invite.networkId) });
      if (!network?.name) throw typedError("E_OG_NOT_FOUND", "no unfurl image for this link");
      return {
        entityId: String(id),
        networkName: String(network.name),
        contentVersion: String(invite.createdAt ?? ""),
        hubUrl: typeof network.hubUrl === "string" ? network.hubUrl : null,
      };
    }
    const post = await this.posts.findOne({ _id: String(id) });
    if (!post) throw typedError("E_OG_NOT_FOUND", "no unfurl image for this link");
    const network = await this.networks.findOne({ _id: String(post.originNetworkId) });
    if (!network?.name) throw typedError("E_OG_NOT_FOUND", "no unfurl image for this link");
    return {
      entityId: String(id),
      networkName: String(network.name),
      // The document-write stamp of record: every post write path sets or
      // bumps this field (create, interactions) — an edit yields a new key.
      contentVersion: String(post.lastActivityAt ?? post.createdAt ?? ""),
      hubUrl: typeof network.hubUrl === "string" ? network.hubUrl : null,
    };
  }

  /**
   * One single-line template frame, rasterized as glyph outlines and
   * centered inside Brian's safe area. A frame wider than the safe area
   * scales down to fit (deterministic fit-to-width); one shorter stays at
   * the target size.
   */
  async frameSvg({ frameText }) {
    const font = await this.font();
    // Natural metrics at the target size, then a deterministic fit-to-width:
    // a frame wider than the safe area scales down, a shorter one stays.
    const probe = font.getPath(frameText, 0, 0, TARGET_FONT_SIZE, { kerning: true });
    const natural = probe.getBoundingBox();
    const naturalWidth = natural.x2 - natural.x1;
    const usableWidth = SAFE_AREA.width - SAFETY_INSET * 2;
    const scale = Math.min(1, usableWidth / naturalWidth);
    // Baseline placement centers the inked rows (y1 top, y2 bottom) inside
    // the safe area's vertical band.
    const baselineY = SAFE_AREA.top + (SAFE_AREA.height - (natural.y2 - natural.y1) * scale) / 2 - natural.y1 * scale;
    const path = font.getPath(
      frameText,
      SAFE_AREA.left + SAFETY_INSET + (usableWidth - naturalWidth * scale) / 2,
      baselineY,
      TARGET_FONT_SIZE * scale,
      { kerning: true },
    );
    return Buffer.from(
      `<svg xmlns="http://www.w3.org/2000/svg" width="1731" height="909">` +
        `<path d="${path.toPathData(3)}" fill="#FFFFFF"/>` +
      `</svg>`,
    );
  }

  /**
   * Compose one OG image and serve it through the blob cache. The returned
   * `composed` flag is the cache evidence: false = served from cache, no
   * re-composite ran (ac-3).
   */
  async image({ kind, id }) {
    const normalizedKind = kind === "invite" || kind === "post" ? kind : null;
    if (!normalizedKind) throw typedError("E_OG_NOT_FOUND", "no unfurl image for this link");
    const inputs = await this.compositionInputs({ kind: normalizedKind, id });
    const inputKey = this.cacheKey({ kind: normalizedKind, entityId: inputs.entityId, contentVersion: inputs.contentVersion, networkName: inputs.networkName });
    // The cache mapping row (ac-3): one composed artifact per input key — a
    // hit serves the stored blob with no re-composite; a miss composes and
    // stores. A vanished blob (a swept og artifact) composes again: the bytes
    // are deterministic, so the artifact is rebuilt identically.
    const cached = await this.ogImages.findOne({ _id: inputKey });
    if (cached) {
      const bytes = await this.blobs.get(cached.blobKey);
      if (bytes) return { bytes, key: inputKey, composed: false };
    }
    const frameText = normalizedKind === "invite"
      ? `join the ${inputs.networkName} network`
      : `view this post on the ${inputs.networkName} network`;
    const svg = await this.frameSvg({ frameText });
    const bytes = await sharp(await this.baseBytes()).composite([{ input: svg }]).jpeg({ quality: 90, chromaSubsampling: "4:4:4" }).toBuffer();
    // The bytes store under their own content-addressed hash (the media
    // store's key regime); the mapping row carries inputKey → blobKey.
    const blobKey = sha256Hex(bytes);
    await this.blobs.put(blobKey, bytes).catch((error) => {
      // A refused og artifact write (a paused media volume) is still
      // servable this once — the state is named, never silent; the dangling
      // mapping row self-heals on the next miss.
      this.log?.(`og cache write refused (${error?.code ?? "unknown"}): the image serves this time, uncached`);
      return null;
    });
    await this.ogImages.updateOne({ _id: inputKey }, { $set: { blobKey, kind: normalizedKind, createdAt: new Date().toISOString() }, upsert: true });
    this.log?.(`og compose ${normalizedKind} key=${inputKey} bytes=${bytes.length}`);
    return { bytes, key: inputKey, composed: true };
  }

  /**
   * The og: tag set for one shared link (ac-4): the fixed template frame as
   * title, the composed image route, and the canonical link itself. Every
   * field is content-free (ac-5): template text, network name, opaque entity
   * id, and the hub origin only. Unknown entity → null: the caller serves
   * the plain SPA document, never a personalized or content-bearing variant.
   */
  async tags({ kind, id, origin = null }) {
    const normalizedKind = kind === "invite" || kind === "post" ? kind : null;
    if (!normalizedKind) return null;
    const path = normalizedKind === "invite" ? `/join/${encodeURIComponent(String(id))}` : `/posts/${encodeURIComponent(String(id))}`;
    try {
      const inputs = await this.compositionInputs({ kind: normalizedKind, id });
      // Origin of record precedence: the network row's re-pointed hub URL
      // (PORCH-065 self-reference state), then the caller's live origin, then
      // relative — the tags always render, never dropped on a degraded origin.
      const joined = inputs.hubUrl ?? origin ?? null;
      const base = joined ? String(joined).replace(/\/+$/, "") : null;
      const frameText = normalizedKind === "invite"
        ? `join the ${inputs.networkName} network`
        : `view this post on the ${inputs.networkName} network`;
      return {
        title: frameText,
        image: base !== null ? `${base}/api/social/og/${normalizedKind}/${encodeURIComponent(String(id))}` : `/api/social/og/${normalizedKind}/${encodeURIComponent(String(id))}`,
        url: base !== null ? `${base}${path}` : path,
      };
    } catch (error) {
      // A miss is diagnosable in the local log (unknown entity is the normal
      // case; the log names anything else), never a silent empty surface.
      this.log?.(`og tags miss ${normalizedKind} ${String(id).slice(0, 24)}: ${error?.code ?? error?.message ?? "unknown"}`);
      return null;
    }
  }
}

export default OgService;