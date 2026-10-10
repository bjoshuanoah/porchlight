/**
 * Codec-backed rendition encoder (PORCH-044, media pipeline TS 5: "every
 * lower-quality shareable version is generated on the hub server, never on
 * a device").
 *
 * The hub is the one party that decodes original media and produces the
 * rendition set; member devices never transcode. Two encoder families:
 *
 * - Images: sharp (libvips) resizes into the width-rung ladder and encodes
 *   WebP (broad browser support) with EXIF orientation baked in.
 * - Video: ffmpeg (npm-delivered ffmpeg-static binary, spawned as its own
 *   process — never linked) produces the video rendition set — a JPEG
 *   poster frame plus one playable H.264/AAC MP4 rendition; original-
 *   quality playback stays the explicit archive action.
 *
 * Determinism note: encoders are production codecs, not fixtures. Tests
 * verify decodability + dimensions + budget, never byte equality of
 * encoded output (codec output is version-stable, not byte-stable).
 */
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import ffmpegStatic from "ffmpeg-static";
import sharp from "sharp";
import { typedError } from "./media.service.js";

/** Rendition format of record: rendition asset rows carry `format` (v2). */
export const RENDITION_FORMAT_V2 = "porchlight-rendition/2";

const UNDECODABLE_MESSAGE = "The hub cannot decode this media.";

function undecodable(extra = {}) {
  return typedError("E_MEDIA_UNDECODABLE", UNDECODABLE_MESSAGE, { httpStatus: 415, ...extra });
}

/**
 * Run a codec binary with optional stdin input and collect buffer output.
 * stdin is CLOSED right after the input write (EOF finalizes the ffmpeg
 * read of a piped original); the bytes never touch server-local staging.
 */
function runBin(bin, args, { timeoutMs, input = null } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { stdio: [input === null ? "ignore" : "pipe", "pipe", "pipe"] });
    const stdout = [];
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`codec binary timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => {
      // ffmpeg prints stream info on stderr; keep only the tail (a hostile
      // input cannot grow it unboundedly).
      stderr = (stderr + chunk.toString("utf8")).slice(-8000);
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      const out = Buffer.concat(stdout);
      if (code !== 0 && out.length === 0) {
        reject(Object.assign(new Error(`${bin} exited ${code}`), { stderr }));
        return;
      }
      resolve({ stdout: out, stderr, code });
    });
    if (input !== null) {
      child.stdin.end(input);
    }
  });
}

/**
 * Effective display dimensions of an image the way browsers see them: the
 * EXIF orientation is honored (flipped orientations swap width/height).
 */
export async function imageMetadata(originalBytes) {
  let meta;
  try {
    meta = await sharp(originalBytes, { pages: -1 }).metadata();
  } catch {
    throw undecodable();
  }
  if (!meta?.width || !meta?.height) {
    throw undecodable();
  }
  const swap = meta.orientation >= 5 && meta.orientation <= 8;
  return {
    width: swap ? meta.height : meta.width,
    height: swap ? meta.width : meta.height,
    animated: (meta.pages ?? 1) > 1,
    sourceFormat: meta.format ?? null,
  };
}

/*
 * Video operations need a SEEKABLE demuxer (mp4/webm/mov commonly carry
 * their index at the end of the stream — "partial file" errors on a pipe).
 * The original spools to a temp file for the encoder lifetime, deleted in
 * the finally — the only staging in the pipeline, encoder-local, never a
 * rendition or archive path.
 */
async function withVideoSpooled(originalBytes, work) {
  const dir = await mkdtemp(join(tmpdir(), "porchlight-video-"));
  const input = join(dir, "original");
  try {
    await writeFile(input, originalBytes);
    return await work(input, dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** Video metadata via the bundled ffmpeg: display dimensions + duration. */
export async function videoMetadata(originalBytes) {
  return withVideoSpooled(originalBytes, async (input) => {
    let stderr = "";
    try {
      const result = await runBin(ffmpegPath(), ["-hide_banner", "-i", input], { timeoutMs: 30_000 });
      stderr = result.stderr;
    } catch (error) {
      // ffmpeg exits nonzero for a probe with no output target; the
      // metadata itself lands on stderr. Hard failures fall through.
      stderr = error.stderr ?? "";
    }
    const videoStream = /Stream #\S+.*Video: .*?, (\d+)x(\d+)/.exec(stderr);
    if (!videoStream) {
      throw undecodable();
    }
    const duration = /Duration: (\d+):(\d+):(\d+\.?\d*)/.exec(stderr);
    return {
      width: Number(videoStream[1]),
      height: Number(videoStream[2]),
      durationSeconds: duration
        ? Number(duration[1]) * 3600 + Number(duration[2]) * 60 + Number(duration[3])
        : null,
      hasAudio: /Stream #\S+.*Audio: /.test(stderr),
    };
  });
}

/** ffmpeg binary path (ffmpeg-static's npm-delivered per-platform binary). */
function ffmpegPath() {
  return ffmpegStatic;
}

/**
 * One image rung of the ladder (TS 5 responsive rendition ladder). The
 * rung width is clamped to the original (never upscaled — a surface must
 * not fetch a rendition materially larger than it renders), rotation is
 * baked per EXIF, and the pixels encode WebP.
 */
export async function encodeImageRendition(originalBytes, targetWidth) {
  let meta;
  let rendered;
  try {
    meta = await sharp(originalBytes, { pages: -1 }).metadata();
    rendered = await sharp(originalBytes, { pages: -1 })
      .rotate()
      .resize({ width: Math.min(targetWidth, meta.width || targetWidth), withoutEnlargement: true })
      .webp({ quality: 80, effort: 4 })
      .toBuffer({ resolveWithObject: true });
  } catch (error) {
    throw undecodable({ cause: error });
  }
  return {
    bytes: rendered.data,
    width: rendered.info.width,
    height: rendered.info.height,
    contentType: "image/webp",
  };
}

function evenWidth(width, sourceWidth) {
  return Math.min(Math.max(2, width), sourceWidth) % 2 === 0
    ? Math.min(Math.max(2, width), sourceWidth)
    : Math.min(Math.max(2, width), sourceWidth) - 1;
}

/**
 * One playable video rendition (H.264/AAC MP4, faststart) scaled to the
 * rung width (clamped to the source, even dimensions) — the timeline's
 * inline playback quality. Audio streams ride along at 96k.
 */
export async function encodeVideoPlayable(originalBytes, source, targetWidth) {
  return withVideoSpooled(originalBytes, async (input, dir) => {
    const output = join(dir, "playable.mp4");
    await runBin(
      ffmpegPath(),
      [
        "-hide_banner", "-loglevel", "error", "-y",
        "-i", input,
        "-vf", `scale=${evenWidth(targetWidth, source.width)}:-2`,
        "-c:v", "libx264", "-crf", "28", "-preset", "veryfast", "-pix_fmt", "yuv420p",
        "-c:a", "aac", "-b:a", "96k",
        "-movflags", "+faststart",
        output,
      ],
      { timeoutMs: 600_000 },
    );
    const bytes = await readFile(output);
    if (bytes.length === 0) throw undecodable();
    // The rendition row carries the playable's own display dims (the
    // scaled stream, not the original) — the client's media width source.
    const meta = await videoMetadata(bytes);
    return {
      bytes,
      width: meta.width,
      height: meta.height,
      durationSeconds: meta.durationSeconds,
      contentType: "video/mp4",
    };
  });
}

/**
 * Poster frame (JPEG) for a video post, taken at ~10% into the clip (a
 * moment mid-action beats a black first frame) and scaled to the poster
 * rung width (never upscaled). A failed near-end seek retries from frame 0.
 */
export async function encodeVideoPoster(originalBytes, source, targetWidth) {
  const args = (input, output, seek) => [
    "-hide_banner", "-loglevel", "error", "-y",
    "-ss", seek, "-i", input,
    "-frames:v", "1",
    "-vf", `scale=${evenWidth(targetWidth, Math.max(2, source.width))}:-2`,
    "-q:v", "3", output,
  ];
  return withVideoSpooled(originalBytes, async (input, dir) => {
    const output = join(dir, "poster.jpg");
    const seekSeconds = source.durationSeconds ? String(Math.max(0.1, source.durationSeconds * 0.1)) : "0";
    try {
      await runBin(ffmpegPath(), args(input, output, seekSeconds), { timeoutMs: 120_000 });
    } catch {
      // A short clip can fail the near-end seek; retry from frame 0.
      await runBin(ffmpegPath(), args(input, output, "0"), { timeoutMs: 120_000 }).catch((error) => {
        error.httpStatus = 415;
        throw error;
      });
    }
    const bytes = await readFile(output);
    if (bytes.length === 0) throw undecodable();
    const shape = await sharp(bytes).metadata();
    return { bytes, width: shape.width, height: shape.height, contentType: "image/jpeg" };
  });
}