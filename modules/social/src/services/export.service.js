import { canonicalJson } from "./membership.service.js";
import { sha256Hex } from "./media.store.js";
import { typedError } from "./media.service.js";

/**
 * Signed archive export builder (PORCH-008, media pipeline TS 5 + the
 * sovereignty contract's guaranteed-export clause, PRD 2). Streams a
 * member's complete authored history at the origin as a signed, open
 * archive:
 *
 * - ZIP format (stored entries, no compression) assembled and streamed
 *   entry-by-entry through an async generator — the controller pipes the
 *   generator straight to the response, so export never stages an archive
 *   server-locally.
 * - Per-item signatures: each item records the deviceSignature of the
 *   authoring write (posts/comments/reactions are actor-signed at write
 *   time), verifiable against the enrolled device key that authored it.
 * - manifest checksum: the manifest carries the sha256 over the item
 *   list (canonical JSON), binding every item's bytes and signature set.
 * - Signed request: the export itself must be a device-signed member
 *   write ({scope:"export"}); the manifest records the requesting DID and
 *   that request signature.
 *
 * Vote records are excluded by the vote-privacy contract (Feed Ranking
 * Contract: votes are consumed only by the ranking module; an export that
 * published votes would breach the visibility ruling, Brian Oct 8 2026).
 */
export class ExportService {
  /**
   * @param {object} deps
   * @param {import("@porchlight/shared").CollectionLike} deps.posts
   * @param {import("@porchlight/shared").CollectionLike} deps.comments
   * @param {import("@porchlight/shared").CollectionLike} deps.reactions
   * @param {import("@porchlight/shared").CollectionLike} deps.assets
   * @param {{ get: (key: string) => Promise<Buffer | null> }} deps.blobs
   * @param {import("./membership.service.js").MembershipService} deps.membership
   * @param {(action: string, payload?: object) => Promise<void>} [deps.audit]
   */
  constructor({ posts, comments, reactions, assets, blobs, membership, audit }) {
    this.posts = posts;
    this.comments = comments;
    this.reactions = reactions;
    this.assets = assets;
    this.blobs = blobs;
    this.membership = membership;
    this.audit = audit ?? (async () => {});
  }

  /**
   * The export stream (ac-3): an async generator of ZIP chunks for the
   * requesting member's authored history at their token's origin. The
   * request must be device-signed like every other content write.
   */
  async *streamMemberExport({ accessToken, signature } = {}) {
    if (!accessToken) {
      throw typedError("E_MUST_SIGN_IN", MESSAGES.E_MUST_SIGN_IN);
    }
    if (!signature) {
      throw typedError("E_SIGNATURE_REQUIRED", MESSAGES.E_SIGNATURE_REQUIRED);
    }
    const perimeter = await this.membership.verifyAccessToken(accessToken);
    if (!perimeter) {
      throw typedError("E_NOT_PERMITTED", MESSAGES.E_NOT_PERMITTED);
    }
    const did = perimeter.session.did;
    const networkId = perimeter.membership.networkId;
    await this.membership.verifyMemberWrite({
      networkId,
      did,
      deviceId: perimeter.session.deviceId,
      payload: { scope: "export", networkId },
      signature,
    });

    const items = [];

    const authoredPosts = await this.posts.find({ originNetworkId: networkId, authorId: did });
    const authoredComments = await this.comments.find({ networkId, authorDid: did });
    const authoredReactions = await this.reactions.find({ networkId, memberDid: did });

    // Content entries first; the manifest (last entry) binds them all. Each
    // entry is yielded immediately after its bytes are read — nothing is
    // staged on the server's disk, and only one entry is held in memory.
    const zip = createZipWriter();
    for (const post of authoredPosts) {
      const { entryBytes, item } = jsonItem(`posts/${post._id}.json`, "post", post);
      items.push(item);
      yield zip.entry({ path: `posts/${post._id}.json`, bytes: entryBytes });
    }
    for (const comment of authoredComments) {
      const { entryBytes, item } = jsonItem(`comments/${comment._id}.json`, "comment", comment);
      items.push(item);
      yield zip.entry({ path: `comments/${comment._id}.json`, bytes: entryBytes });
    }
    for (const reaction of authoredReactions) {
      const { entryBytes, item } = jsonItem(`reactions/${reaction._id}.json`, "reaction", reaction);
      items.push(item);
      yield zip.entry({ path: `reactions/${reaction._id}.json`, bytes: entryBytes });
    }

    // Original media bytes: the archival record at full original quality.
    const authoredMedia = await this.assets.find({ networkId, did, kind: "original" });
    for (const asset of authoredMedia) {
      const bytes = await this.blobs.get(asset.blobKey);
      if (bytes === null) {
        throw typedError("E_EXPORT_MEDIA_MISSING", MESSAGES.E_EXPORT_MEDIA_MISSING, { mediaId: asset._id });
      }
      const { entryBytes, item } = mediaItem(`media/${asset._id}`, asset, bytes);
      items.push(item);
      yield zip.entry({ path: `media/${asset._id}`, bytes: entryBytes });
    }

    const manifestChecksum = sha256Hex(canonicalJson(items));
    const manifest = {
      format: "porchlight-export/1",
      exportedBy: did,
      networkId,
      createdAt: new Date().toISOString(),
      requestSignature: signature,
      manifestChecksum,
      items,
    };
    const manifestBytes = Buffer.from(canonicalJson(manifest), "utf8");

    yield zip.entry({ path: "manifest.json", bytes: manifestBytes });
    yield zip.finish();

    await this.audit("export_stream", { networkId, did, detail: { items: items.length, manifestChecksum } });
  }

  /** File name the controller offers the browser (download naming). */
  static archiveName(networkId, at = new Date()) {
    return `porchlight-export-${networkId}-${at.toISOString().replace(/[:.]/g, "-")}.zip`;
  }
}

const MESSAGES = {
  E_MUST_SIGN_IN: "Sign in to your membership before exporting.",
  E_NOT_PERMITTED: "This action is not available to you in this network.",
  E_SIGNATURE_REQUIRED: "An export must be signed by your device key.",
  E_EXPORT_MEDIA_MISSING: "An authored original's stored bytes are unreadable.",
};

/* ---- entry helpers ------------------------------------------------------ */

function jsonItem(path, kind, document) {
  const bytes = Buffer.from(canonicalJson(document), "utf8");
  return {
    entryBytes: bytes,
    item: {
      path,
      kind,
      sha256: sha256Hex(bytes),
      signature: document.deviceSignature ?? null,
      bytes: bytes.length,
    },
  };
}

function mediaItem(path, asset, bytes) {
  return {
    entryBytes: bytes,
    item: {
      path,
      kind: "media-original",
      sha256: sha256Hex(bytes),
      signature: asset.deviceSignature ?? asset.sha256,
      signatureMessage: {
        scope: "media-commit",
        uploadId: asset.uploadId ?? null,
        sha256: asset.sha256,
        size: asset.bytes,
      },
      contentType: asset.contentType,
      bytes: bytes.length,
    },
  };
}

/* ---- ZIP (stored entries) writer --------------------------------------- */

/*
 * A minimal, deterministic ZIP writer: stored (method 0) entries, a fixed
 * DOS timestamp so identical exports produce identical bytes up to the
 * manifest timestamps, and no ZIP64 (exports are streamed; each entry is
 * bounded by the blob store). Local headers and data are yielded per
 * entry; central directory + EOCD are one trailing chunk.
 */

const FIXED_DOS_TIME = dosTime(new Date("2026-01-01T00:00:00Z"));

/**
 * Incremental ZIP writer: `entry({path, bytes})` emits one local-header +
 * data chunk and tracks its offset; `finish()` emits the central
 * directory + EOCD trailing chunk. Stored entries only, fixed DOS
 * timestamp for byte-determinism, no ZIP64 (entries are blob-bounded).
 */
export function createZipWriter() {
  const central = [];
  let offset = 0;
  return {
    entry({ path, bytes }) {
      const name = Buffer.from(path, "utf8");
      const crc = crc32(bytes);
      const localHeader = Buffer.alloc(30);
      localHeader.writeUInt32LE(0x04034b50, 0); // local file header signature
      localHeader.writeUInt16LE(20, 4); // version needed
      localHeader.writeUInt16LE(0, 6); // flags
      localHeader.writeUInt16LE(0, 8); // method: stored
      localHeader.writeUInt16LE(FIXED_DOS_TIME.time, 10);
      localHeader.writeUInt16LE(FIXED_DOS_TIME.date, 12);
      localHeader.writeUInt32LE(crc, 14);
      localHeader.writeUInt32LE(bytes.length, 18); // compressed size
      localHeader.writeUInt32LE(bytes.length, 22); // uncompressed size
      localHeader.writeUInt16LE(name.length, 26);
      localHeader.writeUInt16LE(0, 28); // no extra field
      central.push({ name, crc, size: bytes.length, offset });
      offset += 30 + name.length + bytes.length;
      return Buffer.concat([localHeader, name, bytes]);
    },
    finish() {
      const parts = [];
      let centralSize = 0;
      for (const row of central) {
        const header = Buffer.alloc(46);
        header.writeUInt32LE(0x02014b50, 0); // central directory signature
        header.writeUInt16LE(20, 4); // version made by
        header.writeUInt16LE(20, 6); // version needed
        header.writeUInt16LE(0, 8); // flags
        header.writeUInt16LE(0, 10); // method: stored
        header.writeUInt16LE(FIXED_DOS_TIME.time, 12);
        header.writeUInt16LE(FIXED_DOS_TIME.date, 14);
        header.writeUInt32LE(row.crc, 16);
        header.writeUInt32LE(row.size, 20);
        header.writeUInt32LE(row.size, 24);
        header.writeUInt16LE(row.name.length, 28);
        header.writeUInt32LE(row.offset, 42); // local header offset
        parts.push(header, row.name);
        centralSize += header.length + row.name.length;
      }
      const eocd = Buffer.alloc(22);
      eocd.writeUInt32LE(0x06054b50, 0); // end of central directory signature
      eocd.writeUInt16LE(central.length, 8);
      eocd.writeUInt16LE(central.length, 10);
      eocd.writeUInt32LE(centralSize, 12);
      eocd.writeUInt32LE(offset, 16); // central directory offset
      parts.push(eocd);
      return Buffer.concat(parts);
    },
  };
}

function crc32(buffer) {
  let crc = 0xffffffff;
  for (let i = 0; i < buffer.length; i += 1) {
    crc = (crc >>> 8) ^ CRC_TABLE[(crc ^ buffer[i]) & 0xff];
  }
  return (crc ^ 0xffffffff) >>> 0;
}

const CRC_TABLE = buildCrcTable();
function buildCrcTable() {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let value = n;
    for (let k = 0; k < 8; k += 1) {
      value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    table[n] = value;
  }
  return table;
}

function dosTime(date) {
  const time = (date.getUTCHours() << 11) | (date.getUTCMinutes() << 5) | Math.floor(date.getUTCSeconds() / 2);
  const year = date.getUTCFullYear() - 1980;
  const dayDate = (year << 9) | ((date.getUTCMonth() + 1) << 5) | date.getUTCDate();
  return { time, date: dayDate };
}

export default ExportService;