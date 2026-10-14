#!/usr/bin/env node
// media-smoke.mjs — PORCH-067 ac-2: prove an installed porchlight tree
// completes a hub media operation on the OS it runs on. sharp resolves its
// native binding per OS at runtime (@img/sharp-<os>-<arch> plus the libvips
// tree it loads); a platform-incomplete closure installs fine everywhere and
// fails only at media time — so the evidence of record is a real encode
// through the hub's own rendition encoder, not a version print or a file
// existence check.
//
// Usage: node scripts/release/media-smoke.mjs --pkg <porchlight-package-dir>
//        node scripts/release/media-smoke.mjs              (resolves the
//        globally installed porchlight via `npm root -g`)
//
// The smoke drives scripts' code path from the INSTALLED tree:
//   node_modules/@porchlight/social/src/services/rendition.encoder.js —
//   the same service every hub media op routes through — exercising
//   imageMetadata() and encodeImageRendition() (rotate → resize → webp,
//   the encodeImageRung class) and asserting real rendered geometry.

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { deflateSync } from "node:zlib";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const args = process.argv.slice(2);
let pkgFlag = null;
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--pkg") pkgFlag = args[i + 1];
}

function fail(message) {
  process.stderr.write(`media smoke FAILED (${process.platform}/${process.arch}): ${message}\n`);
  process.exit(1);
}

function dieOnError(error) {
  if (error) fail(error.message ?? String(error));
}

let porchlightRoot = pkgFlag ?? null;
if (porchlightRoot === null) {
  const globalRoot = execFileSync("npm", ["root", "-g"], { encoding: "utf8" }).trim();
  porchlightRoot = join(globalRoot, "porchlight");
}
const encoderPath = join(
  porchlightRoot,
  "node_modules",
  "@porchlight",
  "social",
  "src",
  "services",
  "rendition.encoder.js",
);
let encoder;
try {
  readFileSync(encoderPath);
} catch {
  fail(`hub rendition encoder not found in the installed tree at ${encoderPath}`);
}
try {
  encoder = await import(pathToFileURL(encoderPath).href);
} catch (error) {
  dieOnError(error);
}

// Deterministic 320x240 PNG (RGBA) written with plain deflate — no image
// dependency is needed to build the fixture, so the ONLY sharp work in the
// run is the hub media operation itself.
function crc32(buffer) {
  let table = crc32.table;
  if (!table) {
    table = crc32.table = new Uint32Array(256).map((_, n) => {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      return c >>> 0;
    });
  }
  let crc = 0xffffffff;
  for (const byte of buffer) crc = table[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const head = Buffer.alloc(4);
  head.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([head, body, crc]);
}

function solidPng(width, height) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type RGBA
  // Vertical+horizontal gradient: a uniform fill would compress a resized
  // webp down to tens of bytes, making the payload assertion meaningless.
  const stride = width * 4 + 1;
  const rows = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) {
    rows[y * stride] = 0; // no filter
    for (let x = 0; x < width; x++) {
      const offset = y * stride + 1 + x * 4;
      rows[offset] = Math.round(30 + (200 * y) / height); // r
      rows[offset + 1] = Math.round(90 + (120 * x) / width); // g
      rows[offset + 2] = 60; // b
      rows[offset + 3] = 255; // a
    }
  }
  return Buffer.concat([
    Buffer.from("89504e470d0a1a0a", "hex"),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(rows, { level: 6 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

const originalBytes = solidPng(320, 240);
const failOnSharpError = (label, error) =>
  fail(
    `${label}: ${error.message}` +
      (error.message?.match(/platform|binding|@img|libvips|Could not load/i)
        ? " — the sharp platform closure for this OS is incomplete in the installed tree"
        : ""),
  );

let meta;
try {
  meta = await encoder.imageMetadata(originalBytes);
} catch (error) {
  failOnSharpError("imageMetadata", error);
}
if (meta.width !== 320 || meta.height !== 240) {
  fail(`image metadata mismatch: expected 320x240, got ${meta.width}x${meta.height}`);
}

const rungs = [96, 512]; // ladder: clamped rung + full-width rung (320)
const thumbnails = [];
for (const targetWidth of rungs) {
  let rendition;
  try {
    rendition = await encoder.encodeImageRendition(originalBytes, targetWidth);
  } catch (error) {
    failOnSharpError(`encodeImageRendition(${targetWidth})`, error);
  }
  if (rendition.contentType !== "image/webp") fail(`rung ${targetWidth}: unexpected content type ${rendition.contentType}`);
  if (rendition.width > Math.min(targetWidth, 320)) fail(`rung ${targetWidth}: width ${rendition.width} exceeds the clamped rung`);
  if (rendition.height < 1 || rendition.bytes.length < 50) fail(`rung ${targetWidth}: implausible payload (${rendition.bytes.length} bytes)`);
  thumbnails.push(`${rendition.width}x${rendition.height}`);
}

// The sharp version + vips build prove WHICH platform binary ran.
let sharpVersionInfo = "unavailable";
try {
  const { createRequire } = await import("node:module");
  const sharpRequire = createRequire(join(porchlightRoot, "media-smoke-probe.cjs"));
  const sharp = sharpRequire("sharp");
  sharpVersionInfo = `sharp ${sharp.versions.sharp} / libvips ${sharp.versions.vips}`;
} catch (error) {
  failOnSharpError("sharp load", error);
}

process.stdout.write(
  `media smoke OK (${process.platform}/${process.arch}, ${sharpVersionInfo}): ` +
    `metadata 320x240 → webp rungs ${thumbnails.join(", ")}, encoder: ${encoderPath}\n`,
);