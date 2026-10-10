import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { device, fixture, canonicalJson } from "./helpers/content.fixture.js";
import { assembleSocialModule } from "../src/assemble.js";
import {
  MESSAGES,
  DEFAULT_RENDITION_RUNGS,
  normalizeRenditionRungs,
  rungsForContentType,
} from "../src/services/media.service.js";
import { sha256Hex } from "../src/services/media.store.js";
import sharp from "sharp";
import ffmpegStatic from "ffmpeg-static";

const SUSAN = "did:porchlight:susan";
const JUNE = "did:porchlight:june";
const FAMILY = "net_family";
const OTHER = "net_other";

const CHUNK_SIZE = 16;

/**
 * Media fixture: the assembled social module (real wiring: membership
 * perimeter + quota + media pipeline) on a memory store, with a small
 * chunk size and an injectable disk probe. Returns the module's services
 * plus admission helpers that return real membership tokens.
 */
function mediaFixture({ diskProbe = async () => ({ totalBytes: 1_000_000, freeBytes: 900_000 }), chunkSize = CHUNK_SIZE } = {}) {
  const fx = fixture();
  // Owner-root rule (PORCH-015): the hub-owner identity founded this
  // network, so Susan's admission resolves the owner role — the console
  // surfaces below need a genuine owner token.
  fx.collections.networks.updateOne({ _id: FAMILY }, { $set: { ownerDid: SUSAN } });
  const mod = assembleSocialModule(fx.store, {
    verifyMemberIdToken: (token) => (token ? { did: token } : null),
    media: { chunkSize, diskProbe },
  });
  const dev = device("dev_s");
  const juneDev = device("dev_j");
  const otherDev = device("dev_o");
  return {
    ...fx,
    mod,
    media: mod.mediaService,
    blobs: mod.mediaService.blobs,
    collections: Object.assign(fx.collections, {
      media_uploads: fx.store.collection("media_uploads"),
      media_assets: fx.store.collection("media_assets"),
    }),
    dev,
    juneDev,
    otherDev,
  };
}

/** Admit a member and return everything the upload flows need. */
async function admitted(fx, { networkId, did, device: memberDevice }) {
  const { accessToken } = await fx.admit({ networkId, did, device: memberDevice });
  return { networkId, did, token: accessToken, dev: memberDevice };
}

const chunkSha = (chunk) => createHash("sha256").update(chunk).digest("hex");

/**
 * A realistic, decodable sample photo: smooth deterministic structure
 * (sine fields seeded per test) encoded JPEG — same shape family as the
 * family archive, deterministic bytes, well above the budget floors.
 */
export const sampleImageBytes = async ({ width = 480, height = 320, seed = 7 } = {}) => {
  const channels = 3;
  const raw = Buffer.alloc(width * height * channels);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const at = (y * width + x) * channels;
      raw[at] = 128 + 120 * Math.sin(x * seed * 0.011) * Math.cos(y * seed * 0.004);
      raw[at + 1] = 128 + 120 * Math.sin(y * seed * 0.009) * Math.cos(x * 0.002);
      raw[at + 2] = 128 + 120 * Math.sin((x + y) * seed * 0.006);
    }
  }
  return sharp(raw, { raw: { width, height, channels } }).jpeg({ quality: 85 }).toBuffer();
};

const runBin = (bin, args) => new Promise((resolve, reject) => execFile(bin, args, (error, stdout, stderr) => (error ? reject(Object.assign(error, { stderr })) : resolve(stdout))));

/**
 * A realistic, decodable sample video: ffmpeg renders a test clip (visual
 * pattern + audio) and returns the H.264/AAC MP4 bytes the ingest accepts.
 */
export const sampleVideoBytes = async ({ seconds = 1 } = {}) => {
  const dir = await mkdtemp(join(tmpdir(), "porchlight-video-"));
  const path = join(dir, "sample.mp4");
  try {
    await runBin(ffmpegStatic, [
      "-hide_banner", "-loglevel", "error", "-y",
      "-f", "lavfi", "-i", `testsrc2=size=1280x720:rate=24:duration=${seconds}`,
      "-f", "lavfi", "-i", `sine=frequency=600:duration=${seconds}`,
      "-map", "0:v", "-map", "1:a",
      "-c:v", "libx264", "-preset", "veryfast", "-crf", "30", "-pix_fmt", "yuv420p",
      "-c:a", "aac", "-b:a", "64k", "-shortest",
      path,
    ]);
    return await readFile(path);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
};

/** Drive a full upload: begin (device-signed) → chunks → complete (device-signed). */
async function upload(media, member, bytes, { contentType = "image/jpeg", beginOverrides = {}, commitOverrides = {} } = {}) {
  const declare = { scope: "media-upload", size: bytes.length, contentType, ...beginOverrides.payload };
  const begin = await media.beginUpload({
    accessToken: member.token,
    payload: beginOverrides.payload ?? { scope: "media-upload", size: bytes.length, contentType },
    signature: member.dev.signPayload(declare),
  });
  const chunkCount = Math.ceil(bytes.length / begin.chunkSize);
  for (let index = 0; index < chunkCount; index += 1) {
    const chunk = bytes.subarray(index * begin.chunkSize, (index + 1) * begin.chunkSize);
    await media.putChunk({
      accessToken: member.token,
      uploadId: begin.uploadId,
      index,
      bytes: chunk,
      chunkSha: beginOverrides.chunkShaByIndex?.[index] ?? chunkSha(chunk),
    });
  }
  const commitPayload = {
    scope: "media-commit",
    uploadId: begin.uploadId,
    sha256: beginOverrides.commitSha ?? sha256Hex(bytes),
    size: beginOverrides.commitSize ?? bytes.length,
    ...commitOverrides.payload,
  };
  const committed = await media.completeUpload({
    accessToken: member.token,
    uploadId: begin.uploadId,
    payload: { sha256: commitPayload.sha256, size: commitPayload.size },
    signature: member.dev.signPayload(commitPayload),
  });
  return { ...committed, uploadId: begin.uploadId };
}

/** Video uploads ride the same signed flow with a video content type. */
async function mediaVideoUpload(fx, member, bytes) {
  return upload(fx.media, member, bytes, { contentType: "video/mp4" });
}

/* ---- ac-1: originals immutable, resumable upload ----------------------- */

test("ac-1: originals stored once, immutable, at full original quality", async () => {
  const fx = mediaFixture();
  const susan = await admitted(fx, { networkId: FAMILY, did: SUSAN, device: fx.dev });
  const bytes = await sampleImageBytes();
  const committed = await upload(fx.media, susan, bytes);

  // Commit declaration echoes the original's full bytes and sha256 — the
  // browser uploaded raw chunks and never transcoded or pre-scaled.
  assert.equal(committed.bytes, bytes.length);
  assert.equal(committed.sha256, sha256Hex(bytes));
  assert.ok(committed.mediaId.startsWith("med_"));

  // The stored original is the exact uploaded bytes.
  const stored = await fx.collections.media_assets.findOne({ _id: committed.mediaId });
  assert.equal(stored.kind, "original");
  assert.equal(stored.immutable, true);
  assert.deepEqual(await fx.blobs.get(stored.blobKey), bytes);

  // Stored once, settled once: the committed upload cannot be re-committed.
  await assert.rejects(
    () =>
      fx.media.completeUpload({
        accessToken: susan.token,
        uploadId: committed.uploadId,
        payload: { sha256: committed.sha256, size: bytes.length },
        signature: susan.dev.signPayload({
          scope: "media-commit",
          uploadId: committed.uploadId,
          sha256: committed.sha256,
          size: bytes.length,
        }),
      }),
    (error) => error.code === "E_UPLOAD_CLOSED",
  );
});

test("ac-1: resumable chunked upload — status read, idempotent chunks, resume to commit", async () => {
  const fx = mediaFixture();
  const susan = await admitted(fx, { networkId: FAMILY, did: SUSAN, device: fx.dev });
  const bytes = await sampleImageBytes({ seed: 11 });
  const begin = await fx.media.beginUpload({
    accessToken: susan.token,
    payload: { scope: "media-upload", size: bytes.length, contentType: "image/jpeg" },
    signature: susan.dev.signPayload({ scope: "media-upload", size: bytes.length, contentType: "image/jpeg" }),
  });
  const chunkCount = Math.ceil(bytes.length / begin.chunkSize);
  assert.equal(begin.chunkSize, CHUNK_SIZE);
  assert.equal(begin.chunkCount, chunkCount);
  const chunkOf = (index) => bytes.subarray(index * CHUNK_SIZE, (index + 1) * CHUNK_SIZE);

  // Two chunks, then the connection drops.
  for (let index = 0; index < 2; index += 1) {
    await fx.media.putChunk({
      accessToken: susan.token,
      uploadId: begin.uploadId,
      index,
      bytes: chunkOf(index),
      chunkSha: chunkSha(chunkOf(index)),
    });
  }

  // The browser resumes, reads state, and re-PUTs the last partial chunk
  // idempotently — a repeat write replaces that blob, no corruption.
  const again = await fx.media.putChunk({
    accessToken: susan.token,
    uploadId: begin.uploadId,
    index: 1,
    bytes: chunkOf(1),
    chunkSha: chunkSha(chunkOf(1)),
  });
  assert.equal(again.received, 2);

  const status = await fx.media.uploadStatus({ accessToken: susan.token, uploadId: begin.uploadId });
  assert.deepEqual(status.receivedChunks, [0, 1]);
  assert.equal(status.state, "open");

  // Commit with chunks missing is refused — resume is the only path.
  await assert.rejects(
    () =>
      fx.media.completeUpload({
        accessToken: susan.token,
        uploadId: begin.uploadId,
        payload: { sha256: sha256Hex(bytes), size: bytes.length },
        signature: susan.dev.signPayload({
          scope: "media-commit",
          uploadId: begin.uploadId,
          sha256: sha256Hex(bytes),
          size: bytes.length,
        }),
      }),
    (error) => error.code === "E_UPLOAD_INCOMPLETE",
  );

  for (let index = 2; index < chunkCount; index += 1) {
    await fx.media.putChunk({
      accessToken: susan.token,
      uploadId: begin.uploadId,
      index,
      bytes: chunkOf(index),
      chunkSha: chunkSha(chunkOf(index)),
    });
  }
  const committed = await fx.media.completeUpload({
    accessToken: susan.token,
    uploadId: begin.uploadId,
    payload: { sha256: sha256Hex(bytes), size: bytes.length },
    signature: susan.dev.signPayload({
      scope: "media-commit",
      uploadId: begin.uploadId,
      sha256: sha256Hex(bytes),
      size: bytes.length,
    }),
  });
  assert.equal(committed.sha256, sha256Hex(bytes));
});

test("ac-1: server-side integrity — corrupt chunk, sha mismatch, size mismatch refused", async () => {
  const fx = mediaFixture();
  const susan = await admitted(fx, { networkId: FAMILY, did: SUSAN, device: fx.dev });
  const bytes = Buffer.from("0123456789abcdef0123456789abcdef", "utf8");
  const begin = await fx.media.beginUpload({
    accessToken: susan.token,
    payload: { scope: "media-upload", size: bytes.length, contentType: "image/jpeg" },
    signature: susan.dev.signPayload({ scope: "media-upload", size: bytes.length, contentType: "image/jpeg" }),
  });

  // Corrupt transport chunk: declared hash disagrees with the received bytes.
  await assert.rejects(
    () =>
      fx.media.putChunk({
        accessToken: susan.token,
        uploadId: begin.uploadId,
        index: 0,
        bytes: bytes.subarray(0, CHUNK_SIZE),
        chunkSha: "0".repeat(64),
      }),
    (error) => error.code === "E_CHUNK_CORRUPT",
  );

  await fx.media.putChunk({
    accessToken: susan.token,
    uploadId: begin.uploadId,
    index: 0,
    bytes: bytes.subarray(0, CHUNK_SIZE),
    chunkSha: chunkSha(bytes.subarray(0, CHUNK_SIZE)),
  });
  await fx.media.putChunk({
    accessToken: susan.token,
    uploadId: begin.uploadId,
    index: 1,
    bytes: bytes.subarray(CHUNK_SIZE),
    chunkSha: chunkSha(bytes.subarray(CHUNK_SIZE)),
  });

  const commitFor = (sha, size) =>
    fx.media.completeUpload({
      accessToken: susan.token,
      uploadId: begin.uploadId,
      payload: { sha256: sha, size },
      signature: susan.dev.signPayload({ scope: "media-commit", uploadId: begin.uploadId, sha256: sha, size }),
    });
  await assert.rejects(() => commitFor("a".repeat(64), bytes.length), (error) => error.code === "E_COMMIT_SHA_MISMATCH");
  await assert.rejects(
    () => commitFor(sha256Hex(bytes), bytes.length + 1),
    (error) => error.code === "E_COMMIT_SIZE_MISMATCH",
  );
});

test("ac-1: scheduled garbage collection aborts idle incomplete uploads, frees chunk blobs", async () => {
  const fx = mediaFixture();
  const susan = await admitted(fx, { networkId: FAMILY, did: SUSAN, device: fx.dev });
  const bytes = Buffer.from("0123456789abcdef0123456789abcdef", "utf8");
  const begin = await fx.media.beginUpload({
    accessToken: susan.token,
    payload: { scope: "media-upload", size: bytes.length, contentType: "image/jpeg" },
    signature: susan.dev.signPayload({ scope: "media-upload", size: bytes.length, contentType: "image/jpeg" }),
  });
  await fx.media.putChunk({
    accessToken: susan.token,
    uploadId: begin.uploadId,
    index: 0,
    bytes: bytes.subarray(0, CHUNK_SIZE),
    chunkSha: chunkSha(bytes.subarray(0, CHUNK_SIZE)),
  });

  const at = new Date();
  // Inside the TTL the upload survives.
  assert.deepEqual(
    await fx.media.gcIncompleteUploads({ now: () => at }),
    { abortedUploads: 0, chunkBlobsDeleted: 0, at: at.toISOString() },
  );
  // Past the TTL the upload aborts and its chunk blobs are collected.
  const later = new Date(at.getTime() + 25 * 60 * 60 * 1000);
  const result = await fx.media.gcIncompleteUploads({ now: () => later });
  assert.equal(result.abortedUploads, 1);
  assert.equal(result.chunkBlobsDeleted, 1);
  assert.equal(await fx.blobs.get(`${begin.uploadId}/0`), null);
  const record = await fx.collections.media_uploads.findOne({ _id: begin.uploadId });
  assert.equal(record.state, "aborted");
  // Idempotent: a second pass collects nothing.
  assert.equal((await fx.media.gcIncompleteUploads({ now: () => later })).abortedUploads, 0);
});

/* ---- ac-2: hub-generated renditions ------------------------------------ */

test("ac-2: the hub generates the rendition set on the server, idempotently, inside the budget", async () => {
  const fx = mediaFixture();
  const susan = await admitted(fx, { networkId: FAMILY, did: SUSAN, device: fx.dev });
  const bytes = await sampleImageBytes({ width: 1600, height: 1067, seed: 47 });
  const committed = await upload(fx.media, susan, bytes);

  // Feed thumb, detail, album — all generated at ingest, all on the hub
  // (the upload API accepted no scaled-down device bytes).
  assert.deepEqual(
    [...committed.renditions].sort(),
    ["album", "detail", "feed-thumb"],
  );
  const renditions = await fx.collections.media_assets.find({ networkId: FAMILY, originalId: committed.mediaId, kind: "rendition" });
  assert.deepEqual(
    renditions.map((row) => row.renditionKind).sort(),
    ["album", "detail", "feed-thumb"],
  );

  // Idempotent per media item: another pass generates nothing new.
  assert.deepEqual(await fx.media.generateRenditions(committed.mediaId), []);

  // The set's overhead lands inside the ≤2–4x budget.
  const overhead = renditions.reduce((total, row) => total + row.bytes, 0);
  assert.ok(overhead <= committed.bytes * 4, `renditions ${overhead} exceed 4x of ${committed.bytes}`);
  assert.ok(overhead <= committed.bytes * 2, `renditions ${overhead} exceed the tuned 2x target of ${committed.bytes}`);

  // Renditions count against the same quota ceiling (artifact ledger).
  const rows = await fx.collections.artifacts.find({ networkId: FAMILY });
  assert.equal(rows.filter((row) => row.kind === "rendition").length, 3);
  assert.ok(rows.reduce((total, row) => total + row.bytes, 0) > committed.bytes);
});

test("ac-2: renditions are browser-renderable pixels of the rung ladder (PORCH-044)", async () => {
  const fx = mediaFixture();
  const susan = await admitted(fx, { networkId: FAMILY, did: SUSAN, device: fx.dev });
  const bytes = await sampleImageBytes({ width: 1600, height: 1067, seed: 37 });
  const committed = await upload(fx.media, susan, bytes);

  // The stored original carries the hub-side probe's display dims.
  const original = (await fx.collections.media_assets.find({ _id: committed.mediaId }))[0];
  assert.equal(original.kind, "original");
  assert.equal(original.width, 1600);
  assert.equal(original.height, 1067);

  // Every image rung renders: WebP bytes with the rung's width (clamped to
  // the original), aspect-true (the rung never distorts).
  const rungs = rungsForContentType(DEFAULT_RENDITION_RUNGS, "image/jpeg");
  for (const [kind, targetWidth] of Object.entries(rungs)) {
    const rendition = await fx.media.serveRendition({ accessToken: susan.token, mediaId: committed.mediaId, renditionKind: kind });
    const shape = await sharp(rendition.bytes).metadata();
    assert.equal(shape.format, "webp");
    assert.ok(shape.width <= targetWidth, `rung ${kind} rendered wider than configured (${shape.width} > ${targetWidth})`);
    assert.ok(shape.width <= original.width, `rung ${kind} upscaled the original`);
    assert.ok(
      Math.abs(shape.width / shape.height - original.width / original.height) < 0.02,
      `rung ${kind} distorts the aspect ratio`,
    );
    assert.ok(rendition.width === shape.width && rendition.height === shape.height);
  }

  // The ladder is configuration of record: rungs documented (packages/shared
  // DEFAULT_CONFIG.media) and validated at the service boundary.
  assert.deepEqual(DEFAULT_RENDITION_RUNGS, { image: { "feed-thumb": 640, album: 1080, detail: 1600 }, video: { poster: 640, playable: 1280 } });
  await assert.rejects(async () => normalizeRenditionRungs({ image: { "feed-thumb": 100, mystery: 640 } }), (error) => error.code === "E_RENDITION_RUNG_INVALID");
  await assert.rejects(async () => normalizeRenditionRungs({ video: { playable: 0 } }), (error) => error.code === "E_RENDITION_RUNG_INVALID");
  // Audio carries no ladder rung at all.
  assert.deepEqual(rungsForContentType(DEFAULT_RENDITION_RUNGS, "audio/mpeg"), {});
});

test("ac-4: video posts carry the poster + playable rendition set (PORCH-044)", async () => {
  const fx = mediaFixture({ chunkSize: 1024 * 1024 });
  const susan = await admitted(fx, { networkId: FAMILY, did: SUSAN, device: fx.dev });
  const bytes = await sampleVideoBytes({ seconds: 1 });
  const committed = await mediaVideoUpload(fx, susan, bytes);

  // The set of record: a decodable poster frame (≤ poster rung, never the
  // original quality) plus a playable rendition (≤ playable rung).
  const assets = await fx.collections.media_assets.find({ networkId: FAMILY, originalId: committed.mediaId, kind: "rendition" });
  assert.deepEqual(assets.map((row) => row.renditionKind).sort(), ["playable", "poster"]);
  const poster = assets.find((row) => row.renditionKind === "poster");
  const playable = assets.find((row) => row.renditionKind === "playable");
  assert.equal(poster.contentType, "image/jpeg");
  assert.equal(playable.contentType, "video/mp4");
  assert.ok(poster.width <= 640, `poster rung rendered wider than configured (${poster.width})`);
  assert.ok(playable.width <= 1280 && playable.width <= 1280, "playable rung upscaled the original");

  // The served bytes decode: poster via sharp, playable as a parseable MP4.
  const posterBytes = await fx.media.serveRendition({ accessToken: susan.token, mediaId: committed.mediaId, renditionKind: "poster" });
  const posterShape = await sharp(posterBytes.bytes).metadata();
  assert.equal(posterShape.format, "jpeg");
  const original = (await fx.collections.media_assets.find({ _id: committed.mediaId }))[0];
  assert.equal(original.width, 1280);
  assert.equal(original.height, 720);
  assert.ok(original.durationSeconds > 0, "the video probe records the duration for the poster seek");

  // Original-quality playback remains the explicit archive action.
  const originalBytes = await fx.media.serveOriginal({ accessToken: susan.token, mediaId: committed.mediaId });
  assert.deepEqual(originalBytes.bytes, bytes);
});

/* ---- ac-3: rendition-default serving, explicit originals, export ------- */

test("ac-3: serving defaults to renditions; original retrieval is the explicit audited action", async () => {
  const fx = mediaFixture();
  const susan = await admitted(fx, { networkId: FAMILY, did: SUSAN, device: fx.dev });
  const june = await admitted(fx, { networkId: FAMILY, did: JUNE, device: fx.juneDev });
  const bytes = await sampleImageBytes({ seed: 13 });
  const committed = await upload(fx.media, susan, bytes);

  // Default serve path: the rendition, by kind.
  const thumb = await fx.media.serveRendition({ accessToken: june.token, mediaId: committed.mediaId, renditionKind: "feed-thumb" });
  assert.equal(thumb.renditionKind, "feed-thumb");
  const originalAsset = await fx.collections.media_assets.findOne({ _id: committed.mediaId });
  assert.notEqual(thumb.sha256, originalAsset.sha256);

  // Explicit original retrieval is a separate surface — and audited.
  const original = await fx.media.serveOriginal({ accessToken: june.token, mediaId: committed.mediaId });
  assert.equal(original.sha256, originalAsset.sha256);
  assert.deepEqual(original.bytes, bytes);
  const actions = await fx.audit.events.find({ networkId: FAMILY });
  assert.equal(actions.filter((row) => row.action === "original_download").length, 1);

  // Origin containment: the same DID on another network sees nothing.
  const otherSusan = await admitted(fx, { networkId: OTHER, did: SUSAN, device: fx.otherDev });
  await assert.rejects(
    () => fx.media.serveOriginal({ accessToken: otherSusan.token, mediaId: committed.mediaId }),
    (error) => error.code === "E_MEDIA_NOT_FOUND",
  );
  await assert.rejects(
    () => fx.media.serveRendition({ accessToken: undefined, mediaId: committed.mediaId, renditionKind: "feed-thumb" }),
    (error) => error.code === "E_MUST_SIGN_IN",
  );
});

test("ac-3: signed archive export streams the authored history with per-item signatures", async () => {
  const fx = mediaFixture();
  const susan = await admitted(fx, { networkId: FAMILY, did: SUSAN, device: fx.dev });
  const bytes = await sampleImageBytes({ seed: 17 });
  const committed = await upload(fx.media, susan, bytes);
  const payload = { type: "photo", mediaRefs: [committed.mediaId], caption: "the pier" };
  await fx.mod.postService.create({ accessToken: susan.token, payload, signature: susan.dev.signPayload(payload) });

  const chunks = [];
  for await (const chunk of fx.mod.exportService.streamMemberExport({
    accessToken: susan.token,
    signature: susan.dev.signPayload({ scope: "export", networkId: FAMILY }),
  })) {
    chunks.push(chunk);
  }
  const archive = Buffer.concat(chunks);

  // ZIP structure: stored local entries, EOCD trailer.
  assert.equal(archive.readUInt32LE(0), 0x04034b50);
  assert.equal(archive.readUInt32LE(archive.length - 22), 0x06054b50);

  const manifest = JSON.parse(parseZipEntry(archive, "manifest.json").toString("utf8"));
  assert.equal(manifest.format, "porchlight-export/1");
  assert.equal(manifest.exportedBy, SUSAN);
  assert.equal(manifest.networkId, FAMILY);
  assert.ok(manifest.requestSignature.length > 0);

  // Per-item signatures: the post item carries the authoring device signature.
  const storedPost = (await fx.collections.posts.find({ originNetworkId: FAMILY })).find((row) => row.mediaRefs?.includes(committed.mediaId));
  const postItem = manifest.items.find((item) => item.kind === "post");
  assert.equal(postItem.signature, storedPost.deviceSignature);
  assert.equal(postItem.sha256, sha256Hex(Buffer.from(canonicalJson(storedPost), "utf8")));
  const mediaOriginal = manifest.items.find((item) => item.kind === "media-original");
  assert.equal(mediaOriginal.sha256, sha256Hex(bytes));

  // The manifest checksum is present; the post archive entry carries the post.
  assert.equal(manifest.manifestChecksum.length, 64);
  assert.deepEqual(JSON.parse(parseZipEntry(archive, `posts/${storedPost._id}.json`).toString("utf8")).mediaRefs, [committed.mediaId]);
  assert.deepEqual(parseZipEntry(archive, `media/${committed.mediaId}`), bytes);
});

test("ac-3: export is signature-gated and origin-contained", async () => {
  const fx = mediaFixture();
  const susan = await admitted(fx, { networkId: FAMILY, did: SUSAN, device: fx.dev });

  // Unsigned export request is refused.
  await assert.rejects(
    () => fx.mod.exportService.streamMemberExport({ accessToken: susan.token, signature: null }).next(),
    (error) => error.code === "E_SIGNATURE_REQUIRED",
  );
  // A garbage membership token resolves nothing.
  const stranger = device("dev_x");
  await assert.rejects(
    async () => {
      for await (const chunk of fx.mod.exportService.streamMemberExport({
        accessToken: "not-a-token",
        signature: stranger.signPayload({ scope: "export", networkId: FAMILY }),
      })) {
        void chunk;
      }
    },
    (error) => error.code === "E_NOT_PERMITTED",
  );
});

/* ---- ac-4: quota admission, disk guard, retention sweep ----------------- */

test("ac-4: quota admission rejects over-ceiling uploads with clear client messaging", async () => {
  const fx = mediaFixture();
  const susan = await admitted(fx, { networkId: FAMILY, did: SUSAN, device: fx.dev });
  // Owner sets a 1 MiB ceiling; a 2 MiB declared upload is refused plainly.
  await fx.collections.networks.updateOne(
    { _id: FAMILY },
    { $set: { quota: { storageCeilingMb: 1, retentionDays: null } } },
  );
  const huge = { scope: "media-upload", size: 2 * 1024 * 1024, contentType: "image/jpeg" };
  await assert.rejects(
    () => fx.media.beginUpload({ accessToken: susan.token, payload: huge, signature: susan.dev.signPayload(huge) }),
    (error) => {
      assert.equal(error.code, "E_STORAGE_QUOTA_EXCEEDED");
      assert.equal(
        error.message,
        "This network is full: the owner has set a storage limit and it has been reached. Free up space or ask the owner to raise the limit.",
      );
      return true;
    },
  );
  // Nothing was admitted: no ledger rows, no upload sessions.
  assert.equal((await fx.collections.artifacts.find({ networkId: FAMILY })).length, 0);
});

test("ac-4: renditions and derived artifacts count against the same ceiling", async () => {
  const fx = mediaFixture();
  const susan = await admitted(fx, { networkId: FAMILY, did: SUSAN, device: fx.dev });
  await fx.collections.networks.updateOne(
    { _id: FAMILY },
    { $set: { quota: { storageCeilingMb: 1, retentionDays: null } } },
  );
  const bytes = await sampleImageBytes({ seed: 19 }); // a realistic original
  const committed = await upload(fx.media, susan, bytes);
  // Ledger rows: original + 3 renditions; used bytes exceed the original's.
  const rows = await fx.collections.artifacts.find({ networkId: FAMILY });
  assert.equal(rows.length, 4);
  const used = rows.reduce((total, row) => total + row.bytes, 0);
  assert.ok(used > committed.bytes, "renditions must count against the quota");
  const usage = await fx.mod.quotaService.usage({ networkId: FAMILY });
  assert.equal(usage.usedBytes, used);
});

test("ac-4: disk guard — soft threshold warns, hard stop halts new uploads, reads continue", async () => {
  let freeBytes = 200_000; // 80% used — under both thresholds
  const fx = mediaFixture({ diskProbe: async () => ({ totalBytes: 1_000_000, freeBytes }) });
  const susan = await admitted(fx, { networkId: FAMILY, did: SUSAN, device: fx.dev });

  // Below soft: clean status, no warning.
  let status = await fx.media.diskStatus();
  assert.equal(status.usedRatio, 0.8);
  assert.equal(status.warning, false);
  assert.equal(status.uploadsHalted, false);

  const bytes = await sampleImageBytes({ seed: 23 });
  const committed = await upload(fx.media, susan, bytes);

  // Soft band (90%–95% used): the owner console sees the warning; the
  // same pass still admits new uploads.
  freeBytes = 80_000; // 92% used
  status = await fx.media.diskStatus();
  assert.equal(status.warning, true);
  assert.equal(status.uploadsHalted, false);
  const softBand = await fx.media.beginUpload({
    accessToken: susan.token,
    payload: { scope: "media-upload", size: 8, contentType: "image/jpeg" },
    signature: susan.dev.signPayload({ scope: "media-upload", size: 8, contentType: "image/jpeg" }),
  });
  assert.ok(softBand.uploadId.startsWith("upl_"));

  // Hard stop (95%+ used): NEW uploads are rejected plain-language; the
  // committed media above STAYS readable at both thresholds.
  freeBytes = 40_000; // 96% used
  const hard = { scope: "media-upload", size: 8, contentType: "image/jpeg" };
  await assert.rejects(
    () => fx.media.beginUpload({ accessToken: susan.token, payload: hard, signature: susan.dev.signPayload(hard) }),
    (error) => {
      assert.equal(error.code, "E_DISK_HARD_STOP");
      assert.equal(error.message, MESSAGES.E_DISK_HARD_STOP);
      return true;
    },
  );
  status = await fx.media.diskStatus();
  assert.equal(status.uploadsHalted, true);
  const detail = await fx.media.serveRendition({ accessToken: susan.token, mediaId: committed.mediaId, renditionKind: "detail" });
  assert.equal(detail.renditionKind, "detail");
  const original = await fx.media.serveOriginal({ accessToken: susan.token, mediaId: committed.mediaId });
  assert.deepEqual(original.bytes, bytes);
});

test("ac-4: retention sweep — expired artifacts cascade media rows and blob bytes", async () => {
  const fx = mediaFixture();
  const susan = await admitted(fx, { networkId: FAMILY, did: SUSAN, device: fx.dev });
  // Owner set: 1-day retention window.
  await fx.collections.networks.updateOne(
    { _id: FAMILY },
    { $set: { quota: { storageCeilingMb: 1, retentionDays: 1 } } },
  );
  const bytes = await sampleImageBytes({ seed: 29 });
  const committed = await upload(fx.media, susan, bytes);
  const assets = await fx.collections.media_assets.find({ networkId: FAMILY });
  assert.equal(assets.length, 4); // original + 3 renditions

  // Past the window: ledger rows, media rows (original + rendition
  // cascade), and blob bytes all leave in the same pass.
  const later = new Date(Date.now() + 2 * 24 * 60 * 60 * 1000);
  const result = await fx.media.sweep({ networkId: FAMILY, now: () => later });
  assert.ok(result.swept >= 4, `expected the original and its renditions swept, got ${result.swept}`);
  assert.ok(result.assetRowsRemoved >= 1);
  const originalAsset = assets.find((row) => row._id === committed.mediaId);
  assert.equal(await fx.blobs.get(originalAsset.blobKey), null);
  assert.equal((await fx.collections.media_assets.find({ networkId: FAMILY })).length, 0);
  const usage = await fx.mod.quotaService.usage({ networkId: FAMILY });
  assert.ok(usage.usedBytes < committed.bytes * 5);
});

/* ---- HTTP transport: the browser-facing API surface --------------------- */

test("ac-1/ac-3: the media API surface serves the full browser flow end to end", async () => {
  const fx = mediaFixture();
  const susan = await admitted(fx, { networkId: FAMILY, did: SUSAN, device: fx.dev });
  const express = (await import("express")).default;
  const app = express();
  app.use(express.json());
  app.use("/api/social", fx.mod.api);
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  const base = `http://127.0.0.1:${server.address().port}/api/social`;

  try {
    const bytes = await sampleImageBytes({ seed: 31 });
    // POST /media/uploads — device-signed begin.
    const declare = { scope: "media-upload", size: bytes.length, contentType: "image/jpeg" };
    const beginResponse = await fetch(`${base}/media/uploads`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${susan.token}` },
      body: JSON.stringify({ payload: declare, signature: susan.dev.signPayload(declare) }),
    });
    assert.equal(beginResponse.status, 200);
    const begin = await beginResponse.json();

    // PUT chunks — raw bytes + per-chunk sha256 header.
    for (let index = 0; index < begin.chunkCount; index += 1) {
      const chunk = bytes.subarray(index * begin.chunkSize, (index + 1) * begin.chunkSize);
      const response = await fetch(`${base}/media/uploads/${begin.uploadId}/chunks/${index}`, {
        method: "PUT",
        headers: { authorization: `Bearer ${susan.token}`, "x-chunk-sha256": chunkSha(chunk) },
        body: chunk,
      });
      assert.equal(response.status, 200);
    }

    // POST complete — device-signed commit.
    const commit = { scope: "media-commit", uploadId: begin.uploadId, sha256: sha256Hex(bytes), size: bytes.length };
    const completeResponse = await fetch(`${base}/media/uploads/${begin.uploadId}/complete`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${susan.token}` },
      body: JSON.stringify({ payload: { sha256: commit.sha256, size: commit.size }, signature: susan.dev.signPayload(commit) }),
    });
    assert.equal(completeResponse.status, 200);
    const committed = await completeResponse.json();
    assert.equal(committed.sha256, sha256Hex(bytes));

    // GET rendition — the default serve path returns rendition bytes,
    // content-addressed + immutable (PORCH-044 ac-3): long-lived private
    // Cache-Control, a strong ETag riding the content address, and a
    // bodyless 304 for a browser's conditional revalidation.
    const renditionResponse = await fetch(`${base}/media/${committed.mediaId}/renditions/album`, {
      headers: { authorization: `Bearer ${susan.token}` },
    });
    assert.equal(renditionResponse.status, 200);
    assert.ok((await renditionResponse.arrayBuffer()).byteLength > 0);
    const renditionSha = renditionResponse.headers.get("x-porchlight-sha256");
    assert.equal(renditionResponse.headers.get("cache-control"), "private, max-age=31536000, immutable");
    assert.equal(renditionResponse.headers.get("etag"), `"${renditionSha}"`);

    // The wrong content address is not this rendition (content-addressed
    // URLs are load-bearing, not decorative).
    const mismatched = await fetch(`${base}/media/${committed.mediaId}/renditions/album?v=${"f".repeat(64)}`, {
      headers: { authorization: `Bearer ${susan.token}` },
    });
    assert.equal(mismatched.status, 404);
    assert.equal((await mismatched.json()).code, "E_RENDITION_NOT_FOUND");

    // A repeat fetch revalidating the same address: bodyless 304, no
    // network round trip of bytes.
    const conditional = await fetch(`${base}/media/${committed.mediaId}/renditions/album?v=${renditionSha}`, {
      headers: { authorization: `Bearer ${susan.token}`, "if-none-match": `"${renditionSha}"` },
    });
    assert.equal(conditional.status, 304);

    // GET original — the explicit archive action returns exact bytes and
    // is NEVER pre-cached (no-store).
    const originalResponse = await fetch(`${base}/media/${committed.mediaId}/original`, {
      headers: { authorization: `Bearer ${susan.token}` },
    });
    assert.equal(originalResponse.status, 200);
    assert.equal(originalResponse.headers.get("cache-control"), "no-store");
    assert.equal(originalResponse.headers.get("x-porchlight-sha256"), sha256Hex(bytes));
    assert.deepEqual(Buffer.from(await originalResponse.arrayBuffer()), bytes);

    // Disk-guard status rides the console surface — owner-only now
    // (PORCH-015): the founding owner's token passes, members' do not.
    const diskResponse = await fetch(`${base}/console/disk`, {
      headers: { authorization: `Bearer ${susan.token}` },
    });
    assert.equal(diskResponse.status, 200);
    const disk = await diskResponse.json();
    assert.equal(disk.available, true);
    assert.equal(disk.softThreshold.toFixed(2), "0.90");
    assert.equal(disk.hardThreshold.toFixed(2), "0.95");
  } finally {
    server.close();
  }
});

/* ---- PORCH-044 rendering, caching, and hydration -------------------------- */

test("PORCH-044: an undecodable upload is refused before anything is stored", async () => {
  const fx = mediaFixture();
  const susan = await admitted(fx, { networkId: FAMILY, did: SUSAN, device: fx.dev });
  const bytes = Buffer.from("this is not a pixel in any container", "utf8");
  await assert.rejects(
    () => upload(fx.media, susan, bytes),
    (error) => error.code === "E_MEDIA_UNDECODABLE",
  );
  // Nothing landed: no assets, no ledger rows, the upload stays open (the
  // member can retry a real file or abandon it to GC).
  assert.equal((await fx.collections.media_assets.find({ networkId: FAMILY })).length, 0);
  assert.equal((await fx.collections.artifacts.find({ networkId: FAMILY })).length, 0);
  const status = await fx.media.uploadStatus({ accessToken: susan.token, uploadId: (await fx.collections.media_uploads.find({ networkId: FAMILY }))[0]._id });
  assert.equal(status.state, "open");
});

test("PORCH-044: a pre-v2 rendition self-heals to the renderable format on read", async () => {
  const fx = mediaFixture();
  const susan = await admitted(fx, { networkId: FAMILY, did: SUSAN, device: fx.dev });
  const bytes = await sampleImageBytes({ seed: 41 });
  const committed = await upload(fx.media, susan, bytes);
  const before = (await fx.collections.media_assets.find({ networkId: FAMILY, originalId: committed.mediaId, kind: "rendition" }))
    .find((row) => row.renditionKind === "album");

  // Simulate the pre-PORCH-044 archive: the derivative format of record
  // behind this task (browser-unrenderable headers + sampled bytes).
  await fx.collections.media_assets.updateOne(
    { _id: before._id },
    { $set: { format: "porchlight-rendition/1", blobKey: before.blobKey } },
  );
  await fx.blobs.delete(before.blobKey);
  await fx.blobs.put(before.blobKey, Buffer.concat([Buffer.from(JSON.stringify({ format: "porchlight-rendition/1" }) + "\n"), Buffer.from(before.blobKey.slice(0, 8))]));

  // The read regenerates and then serves renderable bytes.
  const served = await fx.media.serveRendition({ accessToken: susan.token, mediaId: committed.mediaId, renditionKind: "album" });
  assert.equal((await sharp(served.bytes).metadata()).format, "webp");
  const healed = (await fx.collections.media_assets.find({ networkId: FAMILY, originalId: committed.mediaId, kind: "rendition" }))
    .find((row) => row.renditionKind === "album");
  assert.equal(healed.format, "porchlight-rendition/2");
  assert.ok(healed.width && healed.height);
});

test("PORCH-044: hydration self-heals a pre-format archive before the set of record reports", async () => {
  const fx = mediaFixture();
  const susan = await admitted(fx, { networkId: FAMILY, did: SUSAN, device: fx.dev });
  const bytes = await sampleImageBytes({ width: 1600, height: 1067, seed: 51 });
  const committed = await upload(fx.media, susan, bytes);
  await fx.mod.postService.create({
    accessToken: susan.token,
    payload: { type: "photo", mediaRefs: [committed.mediaId], caption: "the pier" },
    signature: susan.dev.signPayload({ type: "photo", mediaRefs: [committed.mediaId], caption: "the pier" }),
  });

  // Simulate the full pre-PORCH-044 archive: no media-geometry stamp on
  // the original, every rendition row at the byte-derivative format.
  await fx.collections.media_assets.updateOne(
    { _id: committed.mediaId },
    { $set: { width: undefined, height: undefined } },
  );
  for (const row of await fx.collections.media_assets.find({ networkId: FAMILY, originalId: committed.mediaId, kind: "rendition" })) {
    await fx.collections.media_assets.updateOne({ _id: row._id }, { $set: { format: "porchlight-rendition/1" } });
  }

  // A feed read upgrades the archive IN PLACE before hydrating: the
  // reported addresses are the stored ones (a stale content address would
  // make every surface's rendition URL 404 against the healed archive).
  const { posts } = await fx.mod.feedService.timeline({ accessToken: susan.token });
  const view = posts.find((row) => (row.mediaRefs ?? []).includes(committed.mediaId));
  const meta = view.mediaMeta[committed.mediaId];
  assert.ok(meta);
  const storedOriginal = await fx.collections.media_assets.findOne({ _id: committed.mediaId });
  assert.ok(storedOriginal.width && storedOriginal.height, "the read heal stamps the original's display dims");
  for (const rung of meta.renditions) {
    assert.ok(rung.width > 0 && rung.height > 0);
  }
  const rows = await fx.collections.media_assets.find({ networkId: FAMILY, originalId: committed.mediaId, kind: "rendition" });
  assert.ok(rows.length);
  for (const row of rows) {
    assert.equal(row.format, "porchlight-rendition/2");
    assert.ok(row.width && row.height);
  }
  const album = rows.find((row) => row.renditionKind === "album");
  const served = await fx.media.serveRendition({ accessToken: susan.token, mediaId: committed.mediaId, renditionKind: "album" });
  assert.equal(served.sha256, album.sha256, "the hydrated address answers at the content-addressed URL");

  // Idempotent per archive: a second feed read heals nothing.
  const shas = rows.map((row) => row.sha256).sort();
  await fx.mod.feedService.timeline({ accessToken: susan.token });
  const rowsAgain = await fx.collections.media_assets.find({ networkId: FAMILY, originalId: committed.mediaId, kind: "rendition" });
  assert.deepEqual(rowsAgain.map((row) => row.sha256).sort(), shas);
});

test("PORCH-044: a pre-format video archive generates its poster + playable set on member read", async () => {
  const fx = mediaFixture({ chunkSize: 1024 * 1024 });
  const susan = await admitted(fx, { networkId: FAMILY, did: SUSAN, device: fx.dev });
  const clip = await mediaVideoUpload(fx, susan, await sampleVideoBytes({ seconds: 1 }));

  // The pre-PORCH-044 vocabulary knew only the image rungs: rewrite the
  // video's rendition rows into that shape — derivative feed-thumb/detail
  // rows and NO poster or playable at all — so a member read of the
  // playable rendition must upgrade the archive, not fail
  // E_RENDITION_NOT_FOUND forever.
  await fx.collections.media_assets.updateOne(
    { _id: clip.mediaId },
    { $set: { width: undefined, height: undefined, durationSeconds: undefined } },
  );
  const ingestRows = await fx.collections.media_assets.find({ networkId: FAMILY, originalId: clip.mediaId, kind: "rendition" });
  assert.deepEqual(ingestRows.map((row) => row.renditionKind).sort(), ["playable", "poster"]);
  const posterRow = ingestRows.find((row) => row.renditionKind === "poster");
  const playableRow = ingestRows.find((row) => row.renditionKind === "playable");
  await fx.collections.media_assets.updateOne({ _id: posterRow._id }, { $set: { renditionKind: "feed-thumb", format: "porchlight-rendition/1" } });
  await fx.collections.media_assets.updateOne({ _id: playableRow._id }, { $set: { renditionKind: "detail", format: "porchlight-rendition/1" } });

  const served = await fx.media.serveRendition({ accessToken: susan.token, mediaId: clip.mediaId, renditionKind: "playable" });
  assert.ok(served.bytes.length > 0);
  assert.equal(served.contentType, "video/mp4");
  const rows = await fx.collections.media_assets.find({ networkId: FAMILY, originalId: clip.mediaId, kind: "rendition" });
  assert.deepEqual(rows.map((row) => row.renditionKind).sort(), ["playable", "poster"], "the old derivative rows are gone; the video set of record replaced them");
  for (const row of rows) assert.equal(row.format, "porchlight-rendition/2");

  const [hydrated] = await fx.media.withMediaMeta([{ mediaRefs: [clip.mediaId] }], FAMILY);
  const meta = hydrated.mediaMeta[clip.mediaId];
  assert.ok(meta.poster && meta.poster.width > 0);
  assert.equal(meta.renditions.length, 1);
  assert.equal(meta.renditions[0].kind, "playable");
  assert.ok(meta.width > 0 && meta.height > 0, "hydration carries the stamped display dims (layout reserve)");
  const stored = await fx.collections.media_assets.findOne({ _id: clip.mediaId });
  assert.ok(stored.width && stored.height && stored.durationSeconds);
});

test("PORCH-044: every feed surface hydrates mediaMeta — the rendition set of record", async () => {
  const fx = mediaFixture({ chunkSize: 1024 * 1024 });
  const susan = await admitted(fx, { networkId: FAMILY, did: SUSAN, device: fx.dev });
  const june = await admitted(fx, { networkId: FAMILY, did: JUNE, device: fx.juneDev });
  const bytes = await sampleImageBytes({ seed: 43 });
  const video = await sampleVideoBytes({ seconds: 1 });
  const photo = await upload(fx.media, susan, bytes);
  const clip = await mediaVideoUpload(fx, susan, video);
  const photoPayload = { type: "photo", mediaRefs: [photo.mediaId], caption: "the pier" };
  const videoPayload = { type: "video", mediaRefs: [clip.mediaId], caption: "the ferry" };
  await fx.mod.postService.create({ accessToken: susan.token, payload: photoPayload, signature: susan.dev.signPayload(photoPayload) });
  await fx.mod.postService.create({ accessToken: susan.token, payload: videoPayload, signature: susan.dev.signPayload(videoPayload) });

  for (const surface of [
    fx.mod.feedService.timeline({ accessToken: june.token }),
    fx.mod.feedService.ranked({ accessToken: june.token }),
    fx.mod.feedService.search({ accessToken: june.token, query: "pier" }),
    fx.mod.postService.get({ accessToken: june.token, postId: (await fx.collections.posts.find({ originNetworkId: FAMILY }))[0]._id }),
  ]) {
    const result = await surface;
    const views = result.posts ?? [result.post];
    for (const view of views) {
      if ((view.mediaRefs ?? []).length === 0) continue;
      for (const id of view.mediaRefs) {
        const meta = view.mediaMeta?.[id];
        assert.ok(meta, `surface carries hydrated mediaMeta for ${id}`);
        assert.ok(meta.contentType.startsWith("image/") || meta.contentType.startsWith("video/"));
        assert.ok(meta.renditions.length > 0, "the rendition set of record rides the view");
        for (const rung of meta.renditions) {
          assert.match(rung.sha256, /^[a-f0-9]{64}$/);
          assert.ok(rung.width > 0 && rung.height > 0);
        }
        if (meta.poster) {
          assert.equal(meta.poster.kind, "poster");
          assert.match(meta.poster.sha256, /^[a-f0-9]{64}$/);
        }
      }
    }
  }
});

/* ---- PORCH-049 ac-1: the media-geometry stamp ---------------------------- */

test("PORCH-049 ac-1: every payload states the media geometry — display dims, computed aspect, durationMs for video", async () => {
  const fx = mediaFixture({ chunkSize: 1024 * 1024 });
  const susan = await admitted(fx, { networkId: FAMILY, did: SUSAN, device: fx.dev });
  const june = await admitted(fx, { networkId: FAMILY, did: JUNE, device: fx.juneDev });
  const bytes = await sampleImageBytes({ width: 1600, height: 1067, seed: 47 });
  const video = await sampleVideoBytes({ seconds: 1 });
  const photo = await upload(fx.media, susan, bytes);
  const clip = await mediaVideoUpload(fx, susan, video);
  const photoPayload = { type: "photo", mediaRefs: [photo.mediaId], caption: "the pier" };
  const videoPayload = { type: "video", mediaRefs: [clip.mediaId], caption: "the ferry" };
  const photoPost = (await fx.mod.postService.create({ accessToken: susan.token, payload: photoPayload, signature: susan.dev.signPayload(photoPayload) })).post;
  const videoPost = (await fx.mod.postService.create({ accessToken: susan.token, payload: videoPayload, signature: susan.dev.signPayload(videoPayload) })).post;

  // Groups ride the same hydrate path (ac-1 names groups among the surfaces).
  const group = await fx.mod.groupService.create({ networkId: FAMILY, name: "Picnic crew", members: [susan.did, june.did], createdBy: susan.did });
  const groupPayload = { ...photoPayload, groupId: group._id, caption: "the group pier" };
  await fx.mod.postService.create({ accessToken: susan.token, payload: groupPayload, signature: susan.dev.signPayload(groupPayload) });
  await fx.mod.albumService.addItem({ accessToken: susan.token, name: "Lake Album", postId: photoPost._id, signature: susan.dev.signPayload({ kind: "album.add", networkId: FAMILY, postId: photoPost._id, album: "Lake Album" }) });

  const expectedImageAspect = 1600 / 1067;
  for (const surface of [
    fx.mod.feedService.timeline({ accessToken: june.token }),
    fx.mod.feedService.groupTimeline({ accessToken: june.token, groupId: group._id }),
    fx.mod.feedService.ranked({ accessToken: june.token }),
    fx.mod.postService.get({ accessToken: june.token, postId: videoPost._id }),
  ]) {
    const result = await surface;
    const views = result.posts ?? [result.post];
    for (const view of views) {
      for (const id of view.mediaRefs ?? []) {
        const meta = view.mediaMeta?.[id];
        assert.ok(meta, `every surface carries mediaMeta for ${id}`);
        if (meta.contentType.startsWith("video/")) {
          assert.ok(Math.abs(meta.aspect - 1280 / 720) < 0.001, "video aspect computed from display dims");
          assert.ok(meta.durationMs >= 900 && meta.durationMs <= 1500, `video durationMs stamped (${meta.durationMs})`);
        } else {
          assert.ok(Math.abs(meta.aspect - expectedImageAspect) < 0.001, "image aspect computed from display dims");
          assert.equal(meta.durationMs, null, "images carry no duration");
        }
        assert.ok(meta.width > 0 && meta.height > 0);
      }
    }
  }

  // The album media list states the same stamp per entry.
  const listing = await fx.mod.albumService.listMedia({ accessToken: june.token, name: "Lake Album" });
  const entry = listing.media[0];
  assert.ok(Math.abs(entry.aspect - expectedImageAspect) < 0.001);
  assert.equal(entry.width, 1600);
  assert.equal(entry.height, 1067);
  assert.equal(entry.durationMs, null);
});

test("PORCH-049 ac-1: a ref without a readable archive states null geometry — legacy surfaces fall back intrinsically", async () => {
  const fx = mediaFixture({ chunkSize: 1024 * 1024 });
  const susan = await admitted(fx, { networkId: FAMILY, did: SUSAN, device: fx.dev });
  const payload = { type: "photo", mediaRefs: ["med_ghost"], caption: "no archive row" };
  await fx.mod.postService.create({ accessToken: susan.token, payload, signature: susan.dev.signPayload(payload) });
  const [view] = await fx.mod.feedService.timeline({ accessToken: susan.token }).then((result) => result.posts);
  const meta = view.mediaMeta["med_ghost"];
  assert.ok(meta);
  assert.equal(meta.width, null);
  assert.equal(meta.height, null);
  assert.equal(meta.aspect, null);
  assert.equal(meta.durationMs, null);
});

/* ---- helpers ------------------------------------------------------------- */

/** Parse one stored ZIP entry out of the streamed archive bytes. */
function parseZipEntry(archive, path) {
  let offset = 0;
  while (offset + 30 <= archive.length) {
    if (archive.readUInt32LE(offset) !== 0x04034b50) break;
    const nameLength = archive.readUInt16LE(offset + 26);
    const size = archive.readUInt32LE(offset + 18);
    const name = archive.subarray(offset + 30, offset + 30 + nameLength).toString("utf8");
    const data = archive.subarray(offset + 30 + nameLength, offset + 30 + nameLength + size);
    if (name === path) return data;
    offset += 30 + nameLength + size;
  }
  throw new Error(`zip entry not found: ${path}`);
}