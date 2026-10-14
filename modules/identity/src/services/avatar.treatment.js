import sharp from "sharp";

/**
 * Avatar ingest treatment (PORCH-070, Porchlight Server TS 12: "Ingest
 * treatment: square and compressed", Brian Oct 14, 2026). Hub-side,
 * deterministic, once per avatar write:
 *
 * - Square crop FIRST, then compression — in that order. No manual crop
 *   step is ever asked of the member in V1 (no face-detection cropping:
 *   deterministic center-weighted anchor).
 * - The stored set is the compressed square rung ladder and NOTHING else —
 *   the uploaded rectangular bytes are treatment input only (recorded
 *   exception to the post-media original-retention rule; avatars are
 *   identity-surface material).
 * - Rungs are avatar-class weight (KB scale, total set well under 1 MB)
 *   and sized to the surfaces that render them, above the 2px device-dpr
 *   line: header 36px CSS faces (timeline/reply headers, directory rows)
 *   → 72px rung; the WhoIsHere chooser and the Profile preview's larger
 *   face (72px CSS) → 144px rung.
 * - Every rung stamps width == height (square geometry stamps, zero-reflow
 *   layout per the media-geometry contract).
 */

/** Exif orientation is honored by baking the rotation before cropping. */
export function avatarRungSpecs() {
  return [
    { kind: "header", width: 72, height: 72 },
    { kind: "chooser", width: 144, height: 144 },
  ];
}

/** [Assumed: 5 MB per-file cap, confirm at build — TS 12.] */
export const AVATAR_MAX_UPLOAD_BYTES = 5 * 1024 * 1024;

/** The ingest MIME allowlist: images the hub can actually decode + treat. */
export const AVATAR_MIME_TYPES = Object.freeze(
  new Set([
    "image/jpeg",
    "image/png",
    "image/webp",
    "image/gif",
    "image/avif",
    "image/heic",
    "image/heif",
    "image/tiff",
  ]),
);

/** WebP quality of the stored rungs (avatar-class, KB-scale output). */
const QUALITY = 80;

/**
 * The declared MIME type of an upload is claimed, not proven — sniff the
 * bytes so an unsupported file (a renamed PDF) refuses with its own named
 * state rather than an undecodable error.
 * Returns the sniffed type string or null when nothing matches.
 */
export function sniffImageType(bytes) {
  if (!bytes || bytes.length < 12) return null;
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return "image/png";
  if (bytes.subarray(0, 4).toString("ascii") === "RIFF" && bytes.subarray(8, 12).toString("ascii") === "WEBP") return "image/webp";
  if (bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46) return "image/gif";
  if (bytes.subarray(4, 8).toString("ascii") === "ftyp") {
    const brand = bytes.subarray(8, 12).toString("ascii");
    if (brand.startsWith("avif")) return "image/avif";
    if (brand.startsWith("heic") || brand.startsWith("mif1") || brand.startsWith("msf1")) return "image/heic";
    return null;
  }
  if ((bytes[0] === 0x49 && bytes[1] === 0x49) || (bytes[0] === 0x4d && bytes[1] === 0x4d)) return "image/tiff";
  return null;
}

function undecodable(cause) {
  const error = new Error("The hub couldn't read that image — nothing was stored. Try the photo again, or a JPEG/PNG/WebP copy.");
  error.code = "E_AVATAR_UNDECODABLE";
  error.cause = cause;
  return error;
}

/**
 * Treat one uploaded image into the avatar rung set. Every refusal is a
 * typed error with its plain-language copy (ac: never a silent no-op);
 * nothing is stored by this function — the service owns writing.
 *
 * @param {Buffer} bytes the uploaded rectangular image
 * @param {string} contentType the upload's declared MIME type
 * @returns {Promise<Array<{kind:string,width:number,height:number,contentType:string,bytes:Buffer}>>}
 */
export async function treatAvatar(bytes, contentType) {
  if (typeof contentType !== "string" || !AVATAR_MIME_TYPES.has(contentType.split(";")[0].trim().toLowerCase())) {
    throw typed("E_AVATAR_UNSUPPORTED_TYPE", "That file isn't a photo type the hub can use. Photos arrive as JPEG, PNG, WebP, GIF, AVIF, or HEIC.");
  }
  if (Buffer.byteLength(bytes) > AVATAR_MAX_UPLOAD_BYTES) {
    throw typed("E_AVATAR_TOO_LARGE", "That photo is larger than 5 MB. Try a smaller copy — every face is stored as a small square.");
  }
  const sniffed = sniffImageType(bytes);
  if (sniffed === null) {
    throw typed("E_AVATAR_UNSUPPORTED_TYPE", "That file isn't a photo type the hub can use. Photos arrive as JPEG, PNG, WebP, GIF, AVIF, or HEIC.");
  }
  // Bake EXIF orientation first, so the crop reads the pixels the family
  // sees (flipped orientations must not square-crop the wrong frame).
  let normalized;
  try {
    normalized = await sharp(bytes).rotate().toBuffer();
  } catch (cause) {
    throw undecodable(cause);
  }
  let meta;
  try {
    meta = await sharp(normalized).metadata();
  } catch (cause) {
    throw undecodable(cause);
  }
  if (!meta.width || !meta.height) {
    throw undecodable(new Error("no pixel dimensions"));
  }
  // Deterministic center-weighted square crop (1:1) on the source frame.
  const side = Math.min(meta.width, meta.height);
  const left = Math.floor((meta.width - side) / 2);
  const top = Math.floor((meta.height - side) / 2);
  // Compression comes after the crop, per rung, in KB scale.
  const rungs = [];
  for (const rung of avatarRungSpecs()) {
    let output;
    try {
      output = await sharp(normalized)
        .extract({ left, top, width: side, height: side })
        .resize(rung.width, rung.height, { fit: "cover" })
        .webp({ quality: QUALITY })
        .toBuffer();
    } catch (cause) {
      throw undecodable(cause);
    }
    rungs.push({
      kind: rung.kind,
      width: rung.width,
      height: rung.height,
      contentType: "image/webp",
      bytes: output,
    });
  }
  return rungs;
}

function typed(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

export default treatAvatar;