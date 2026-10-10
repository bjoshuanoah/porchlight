/**
 * Rendition storage budget measurement (PORCH-044 ac-5).
 *
 * Runs a representative upload set (12MP/1080p/portrait photos plus a 5s
 * 1080p clip and a 2s 4K clip — the resolution range of the family
 * archive) through the REAL media pipeline (sharp image rungs + ffmpeg
 * poster/playable) and prints the rendition/original overhead per item and
 * in total. Exits nonzero when the total overhead breaches the ≤4x budget.
 *
 * Usage: node scripts/rendition-budget.mjs
 */
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import sharp from "sharp";
import ffmpegStatic from "ffmpeg-static";
import { device, fixture } from "../modules/social/test/helpers/content.fixture.js";
import { assembleSocialModule } from "../modules/social/src/assemble.js";
import { sha256Hex } from "../modules/social/src/services/media.store.js";

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const chunkSha = (chunk) => createHash("sha256").update(chunk).digest("hex");
const runBin = (bin, args) =>
  new Promise((resolve, reject) => execFile(bin, args, (e, o) => (e ? reject(e) : resolve(o))));

// Photo-ish smooth structure at a given size (sine fields, deterministic).
const photo = async ({ width, height, seed }) => {
  const raw = Buffer.alloc(width * height * 3);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const at = (y * width + x) * 3;
      raw[at] = 128 + 120 * Math.sin(x * seed * 0.011) * Math.cos(y * seed * 0.004);
      raw[at + 1] = 128 + 120 * Math.sin(y * seed * 0.009) * Math.cos(x * 0.002);
      raw[at + 2] = 128 + 120 * Math.sin((x + y) * seed * 0.006);
    }
  }
  return sharp(raw, { raw: { width, height, channels: 3 } }).jpeg({ quality: 85 }).toBuffer();
};

const video = async ({ seconds, size = "1920x1080" }) => {
  const dir = await mkdtemp(join(tmpdir(), "budget-clip-"));
  const path = join(dir, "clip.mp4");
  try {
    await runBin(ffmpegStatic, [
      "-hide_banner", "-loglevel", "error", "-y",
      "-f", "lavfi", "-i", `testsrc2=size=${size}:rate=24:duration=${seconds}`,
      "-f", "lavfi", "-i", `sine=frequency=600:duration=${seconds}`,
      "-map", "0:v", "-map", "1:a",
      "-c:v", "libx264", "-preset", "veryfast", "-crf", "30", "-pix_fmt", "yuv420p",
      "-c:a", "aac", "-b:a", "64k", "-shortest", path,
    ]);
    return await readFile(path);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
};

const SET = [
  { name: "photo 12MP 4:3 (4032×3024)", make: () => photo({ width: 4032, height: 3024, seed: 5 }), type: "image/jpeg" },
  { name: "photo 16:9 1080p (1920×1080)", make: () => photo({ width: 1920, height: 1080, seed: 9 }), type: "image/jpeg" },
  { name: "photo portrait (3024×4032)", make: () => photo({ width: 3024, height: 4032, seed: 13 }), type: "image/jpeg" },
  { name: "video 5s 1080p", make: () => video({ seconds: 5 }), type: "video/mp4" },
  { name: "video 2s 4K", make: () => video({ seconds: 2, size: "3840x2160" }), type: "video/mp4" },
];

const fx = fixture();
fx.collections.networks.updateOne({ _id: "net_family" }, { $set: { ownerDid: "did:porchlight:susan" } });
const mod = assembleSocialModule(fx.store, {
  verifyMemberIdToken: (token) => (token ? { did: token } : null),
  media: { chunkSize: 8 * 1024 * 1024, diskProbe: async () => ({ totalBytes: 1e9, freeBytes: 9e8 }) },
});
const { accessToken, dev } = await (async () => {
  const memberDevice = device("dev_s");
  const admitted = await fx.admit({ networkId: "net_family", did: "did:porchlight:susan", device: memberDevice });
  return { accessToken: admitted.accessToken, dev: memberDevice };
})();

let originals = 0;
let renditions = 0;
const lines = [];
for (const entry of SET) {
  const bytes = await entry.make();
  const declare = { scope: "media-upload", size: bytes.length, contentType: entry.type };
  const begin = await mod.mediaService.beginUpload({ accessToken, payload: declare, signature: dev.signPayload(declare) });
  for (let index = 0; index < Math.ceil(bytes.length / begin.chunkSize); index++) {
    const chunk = bytes.subarray(index * begin.chunkSize, (index + 1) * begin.chunkSize);
    await mod.mediaService.putChunk({ accessToken, uploadId: begin.uploadId, index, bytes: chunk, chunkSha: chunkSha(chunk) });
  }
  const committed = await mod.mediaService.completeUpload({
    accessToken,
    uploadId: begin.uploadId,
    payload: { sha256: sha256Hex(bytes), size: bytes.length },
    signature: dev.signPayload({ scope: "media-commit", uploadId: begin.uploadId, sha256: sha256Hex(bytes), size: bytes.length }),
  });
  const renditionRows = await fx.store
    .collection("media_assets")
    .find({ networkId: "net_family", originalId: committed.mediaId, kind: "rendition" });
  const rel = renditionRows.reduce((total, row) => total + row.bytes, 0);
  originals += bytes.length;
  renditions += rel;
  lines.push(
    `${entry.name}: original ${(bytes.length / 1e6).toFixed(2)} MB, renditions ${renditionRows
      .map((row) => `${row.renditionKind}:${(row.bytes / 1e3).toFixed(0)}KB@${row.width ?? "?"}w`)
      .join(" ")} → ${(rel / bytes.length).toFixed(3)}x`,
  );
}
console.log(lines.join("\n"));
const overhead = renditions / originals;
console.log(
  `TOTAL — originals ${(originals / 1e6).toFixed(2)} MB, renditions ${(renditions / 1e6).toFixed(2)} MB, overhead ${overhead.toFixed(3)}x (budget ceiling 4x: ${overhead <= 4 ? "HOLDS" : "EXCEEDED"})`,
);
if (overhead > 4) process.exit(1);