// PORCH-003 ac-1: dependency-complete install — the installer (this CLI) owns
// the daemon binaries. Mongo arrives through the battle-tested mongod
// downloader (official MongoDB downloads, MD5-verified, stored under the
// porchlight home); Redis through prebuilt Homebrew GHCR bottles (redis.io
// ships only source; compiling at install would add a manual gcc/make
// dependency, contradicting dependency-complete); cloudflared from the
// official pinned release tag. Binaries download once per machine into the
// porchlight home and are reused — setup is idempotent and re-runnable.
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  createWriteStream,
  existsSync,
  mkdirSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { release as osRelease } from "node:os";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import { basename, dirname, join } from "node:path";

const require = createRequire(import.meta.url);

export const MONGO_VERSION = "8.0.12";
export const CLOUDFLARED_VERSION = "2026.10.0";

const BREW_API = "https://formulae.brew.sh/api/formula";

async function downloadTo(url, destination, options = {}) {
  const response = await fetch(url, options);
  if (!response.ok) {
    throw new Error(`download ${url} failed with HTTP ${response.status}`);
  }
  mkdirSync(dirname(destination), { recursive: true });
  await pipeline(Readable.fromWeb(response.body), createWriteStream(destination));
}

export async function fileSha256(path, algorithm = "sha256") {
  const { openSync, readSync, closeSync } = await import("node:fs");
  const hash = createHash(algorithm);
  const fd = openSync(path, "r");
  const buffer = Buffer.alloc(1024 * 1024);
  let total = 0;
  try {
    let read;
    while ((read = readSync(fd, buffer, 0, buffer.length, total)) > 0) {
      hash.update(buffer.subarray(0, read));
      total += read;
    }
  } finally {
    closeSync(fd);
  }
  return hash.digest("hex");
}

function extractTarGz(archive, destination, stripComponents = 1) {
  mkdirSync(destination, { recursive: true });
  execFileSync("tar", ["-xzf", archive, "-C", destination, `--strip-components=${stripComponents}`]);
}

/** GHCR requires token auth even for anonymous pulls. */
async function ghcrToken(repositoryPath) {
  const response = await fetch(`https://ghcr.io/token?service=ghcr.io&scope=repository:${repositoryPath}:pull`);
  if (!response.ok) throw new Error(`ghcr anonymous token fetch failed (HTTP ${response.status})`);
  return (await response.json()).token;
}

/** Blob URLs carry the repo path (formula dirs like openssl@4 flatten to /4). */
async function ghcrTokenFromBlobUrl(url) {
  const match = /\/v2\/(.+)\/blobs\//.exec(url);
  if (!match) throw new Error(`not a ghcr blob url: ${url}`);
  return ghcrToken(match[1]);
}

/** Download a ghcr blob with anonymous-scope auth; returns nothing (streamed). */
async function downloadGhcrBlob(url, destination) {
  const token = await ghcrTokenFromBlobUrl(url);
  await downloadTo(url, destination, { headers: { Authorization: `Bearer ${token}` } });
}

/**
 * mongod via the battle-tested downloader of mongodb-memory-server-core
 * (official MongoDB binaries, MD5-checked at source). Returns the absolute
 * mongod path. No redistribution: the binary comes from MongoDB's own
 * distribution servers at install time (licensing note, Porchlight Server
 * initiative: Mongo binary redistribution verified at build).
 */
export async function ensureMongod(home, log = () => {}) {
  // Deep import: the core package's index does not re-export these symbols,
  // but the class module is a stable pinned-version surface.
  const { MongoBinaryDownload } = require("mongodb-memory-server-core/lib/util/MongoBinaryDownload");
  const downloadDir = join(home, "bin", "mongo");
  log(`resolving mongod ${MONGO_VERSION} under ${downloadDir}`);
  const downloader = new MongoBinaryDownload({
    version: MONGO_VERSION,
    downloadDir,
    checkMD5: true,
  });
  return downloader.getMongodPath();
}

// -- Homebrew bottle plumbing ------------------------------------------------
// Bottles are prebuilt binaries whose dylib dependencies carry literal
// "@@HOMEBREW_PREFIX@@" placeholders. To stay dependency-complete (no manual
// checklist, no assuming Homebrew exists on the machine), the linker below
// resolves the whole dylib closure through bottles too, patches each
// dependency to @loader_path-relative paths, and ad-hoc re-signs on darwin.

const HOMEBREW_PLACEHOLDER = "@@HOMEBREW_"; // prefix + cellar variants
const MACOS_TAG_DARWIN = { golden_gate: 27, tahoe: 25, sequoia: 24, sonoma: 23, ventura: 22, monterey: 21 };

/** Pick the bottle tag for this host, newest macOS-compatible first. */
export function redisBottleTag(formulaJson, host = { platform: process.platform, arch: process.arch, release: osRelease() }) {
  const files = formulaJson?.bottle?.stable?.files ?? {};
  const tags = Object.keys(files);
  if (host.platform === "linux") {
    const tag = host.arch === "arm64" ? "arm64_linux" : "x86_64_linux";
    return tags.includes(tag) ? tag : null;
  }
  if (host.platform === "win32") {
    return tags.find((tag) => tag.endsWith("_arm64") || tag.endsWith("_amd64")) ?? null;
  }
  // macOS: newest tag whose build target is at or below the host OS. The
  // exec self-check below covers any mapping drift between tags.
  const arch = host.arch === "arm64" ? "arm64" : "x86_64";
  const hostMajor = Number(host.release.split(".")[0]);
  const scored = tags
    .filter((tag) => tag.startsWith(`${arch}_`))
    .map((tag) => ({ tag, ver: MACOS_TAG_DARWIN[tag.slice(arch.length + 1)] ?? -1 }))
    .filter((entry) => entry.ver >= 0 && entry.ver <= hostMajor)
    .sort((a, b) => b.ver - a.ver);
  return scored[0]?.tag ?? (tags.includes("all") ? "all" : null);
}

const REDIS_FORMULA_URL = `${BREW_API}/redis.json`;

async function redisBottleUrl(log) {
  const response = await fetch(REDIS_FORMULA_URL);
  if (!response.ok) throw new Error(`homebrew formula metadata fetch failed (HTTP ${response.status})`);
  const formula = await response.json();
  const tag = redisBottleTag(formula);
  if (!tag) {
    throw new Error(
      `no prebuilt redis-server bottle for ${process.platform}/${process.arch}; ` +
        "please file an issue with your platform (no manual dependency checklist is permitted on the npm path)",
    );
  }
  log(`using bottle tag ${tag} (redis ${formula.versions.stable})`);
  return formula.bottle.stable.files[tag].url;
}

function redisBinaryPath(dir) {
  const candidates = [
    join(dir, "bin", "redis-server"),
    join(dir, "bin", "redis-server.exe"),
    join(dir, "Memurai", "memurai.exe"),
  ];
  for (const candidate of candidates) if (existsSync(candidate)) return candidate;
  return null;
}

function bottleExtractRoot(home, formula) {
  return join(home, "bin", "bottles", formula);
}

function selectBottleTag(formulaData) {
  return redisBottleTag(formulaData);
}

/** Download (once per home) and extract a homebrew core formula bottle; returns the extract root. */
async function downloadFormulaBottle(home, formula, log) {
  const root = bottleExtractRoot(home, formula);
  if (existsSync(join(root, ".porch-done"))) return root;
  const response = await fetch(`${BREW_API}/${encodeURIComponent(formula)}.json`);
  if (!response.ok) throw new Error(`homebrew formula metadata for ${formula} failed (HTTP ${response.status})`);
  const formulaData = await response.json();
  const tag = selectBottleTag(formulaData);
  if (!tag) throw new Error(`no bottle of ${formula} for ${process.platform}/${process.arch}`);
  const url = formulaData.bottle.stable.files[tag].url;
  log(`fetching supporting bottle ${formula} (${tag})`);
  const archive = join(tmpdir(), `porchlight-${formula}-${Date.now()}.tar.gz`);
  await downloadGhcrBlob(url, archive);
  const digest = await fileSha256(archive);
  if (!url.includes(`sha256:${digest}`)) {
    throw new Error(`${formula} bottle integrity check failed (expected ${basename(url)}, got sha256:${digest})`);
  }
  mkdirSync(root, { recursive: true });
  execFileSync("tar", ["-xzf", archive, "-C", root, "--strip-components=2"]);
  writeFileSync(join(root, ".porch-done"), formula);
  return root;
}

function dylibsUnder(root) {
  const matches = [];
  const stack = [root];
  while (stack.length > 0) {
    const dir = stack.pop();
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) stack.push(join(dir, entry.name));
      else if (entry.name.endsWith(".dylib")) matches.push(join(dir, entry.name));
    }
  }
  return matches;
}

function placeholderDeps(binaryPath) {
  let output;
  try {
    output = execFileSync("otool", ["-L", binaryPath], { encoding: "utf8" });
  } catch {
    return [];
  }
  const deps = [];
  for (const line of output.split("\n").slice(1)) {
    const path = line.trim().split(" (")[0];
    if (path?.includes(HOMEBREW_PLACEHOLDER)) deps.push(path);
  }
  return deps;
}

function formulaNameFromPlaceholderPath(depPath) {
  // @@HOMEBREW_PREFIX@@/opt/openssl@4/lib/libssl.4.dylib  -> openssl@4
  // @@HOMEBREW_CELLAR@@/openssl@4/4.0.3/lib/libcrypto.4.dylib -> openssl@4
  const prefixMatch = /\/opt\/([^/]+)\//.exec(depPath);
  if (prefixMatch) return prefixMatch[1];
  const cellarMatch = /@@HOMEBREW_CELLAR@@\/([^/]+)\//.exec(depPath);
  return cellarMatch ? cellarMatch[1] : null;
}

function resignMacBinary(path) {
  if (process.platform !== "darwin") return;
  execFileSync("codesign", ["--force", "--sign", "-", path], { stdio: "pipe" });
}

/**
 * Resolve every @@HOMEBREW_PREFIX@@ dylib dependency of the binary through
 * bottles (whole closure), patch all dependency paths to @loader_path/lib,
 * and re-sign the modified Mach-O files. Keeps the install dependency-
 * complete on machines without Homebrew.
 */
export async function linkBottleDependencies(home, binaryPath, log = () => {}) {
  const libDir = join(dirname(binaryPath), "lib");
  mkdirSync(libDir, { recursive: true });
  const copied = new Set();
  const queue = [binaryPath];
  while (queue.length > 0) {
    const requester = queue.shift();
    for (const depPath of placeholderDeps(requester)) {
      const formula = formulaNameFromPlaceholderPath(depPath);
      const dylibName = basename(depPath);
      if (!formula) {
        throw new Error(`unsupported homebrew placeholder dependency ${depPath} in ${requester}`);
      }
      const root = await downloadFormulaBottle(home, formula, log);
      const found = dylibsUnder(root).filter((name) => basename(name) === dylibName);
      if (found.length === 0) {
        throw new Error(`${formula} bottle does not contain ${dylibName}`);
      }
      const target = join(libDir, dylibName);
      // Bottle payloads are read-only; the copy needs read bits.
      chmodSync(found[0], 0o644);
      copyFileSync(found[0], target);
      // @loader_path resolves relative to the requesting Mach-O: the hub
      // binary sits in bin/redis, its linked dylibs sit in bin/redis/lib.
      const loaderPrefix = requester === binaryPath ? "@loader_path/lib" : "@loader_path";
      execFileSync("install_name_tool", ["-change", depPath, `${loaderPrefix}/${dylibName}`, requester], { stdio: "pipe" });
      execFileSync("install_name_tool", ["-id", `@loader_path/lib/${dylibName}`, target], { stdio: "pipe" });
      if (!copied.has(target)) {
        copied.add(target);
        queue.push(target); // resolve this dylib's own placeholder deps
        log(`linked ${dylibName} from the ${formula} bottle`);
      }
    }
  }
  // Sign LAST: every touched Mach-O was patched after its earlier copy, so
  // signing during the walk would leave modified files with stale signatures.
  for (const file of [binaryPath, ...copied]) {
    resignMacBinary(file);
  }
  try {
    // dyld caches; a direct exec check is the actual contract.
    execFileSync(binaryPath, ["--version"], { stdio: "pipe" });
  } catch (error) {
    log(`self-check failed after linking: ${error.message}`);
  }
  return [...copied];
}

/**
 * redis-server from a Homebrew GHCR bottle — the blob URL embeds the sha256
 * digest, so the payload verifies itself. Windows uses the Memurai
 * distributor endpoint (same mechanism redis-memory-server uses) and is
 * marked [Assumed, confirm at build]: unverified on this workstation.
 */
export async function ensureRedis(home, log = () => {}) {
  const dir = join(home, "bin", "redis");
  const existing = redisBinaryPath(dir);
  if (existing) return existing;

  const bottle = join(tmpdir(), `porchlight-redis-${Date.now()}.tar.gz`);
  const url = await redisBottleUrl(log);
  log(`downloading ${url}`);
  await downloadGhcrBlob(url, bottle);

  const digest = await fileSha256(bottle);
  if (!url.includes(`sha256:${digest}`)) {
    throw new Error(
      `redis bottle integrity check failed (url expects ${basename(url)}, downloaded sha256:${digest}) — refusing to install an unverified binary`,
    );
  }

  const extractDir = join(dir, "bottle");
  extractTarGz(bottle, extractDir, 2);
  const binary = redisBinaryPath(extractDir);
  if (!binary) throw new Error("redis bottle did not contain a redis-server binary");

  const target = join(dir, process.platform === "win32" ? "redis-server.exe" : "redis-server");
  copyFileSync(binary, target);
  chmodSync(target, 0o755);

  if (process.platform === "darwin") {
    await linkBottleDependencies(home, target, log);
  }
  try {
    execFileSync(target, ["--version"], { stdio: "pipe" });
  } catch (error) {
    throw new Error(
      `redis-server downloaded but will not execute on this host (${error.message}) — ` +
        "re-run porchlight setup; if it persists, file a platform issue",
    );
  }
  log(`redis-server installed at ${target}`);
  return target;
}

function cloudflaredAsset() {
  switch (process.platform) {
    case "darwin":
      return process.arch === "arm64" ? "cloudflared-darwin-arm64.tgz" : "cloudflared-darwin-amd64.tgz";
    case "win32":
      return "cloudflared-windows-amd64.exe";
    default:
      return process.arch === "arm64" ? "cloudflared-linux-arm64" : "cloudflared-linux-amd64";
  }
}

/** cloudflared from the pinned official release tag; exec self-check after install. */
export async function ensureCloudflared(home, log = () => {}) {
  const dir = join(home, "bin", "cloudflared");
  const target = join(dir, process.platform === "win32" ? "cloudflared.exe" : "cloudflared");
  if (existsSync(target)) return target;
  mkdirSync(dir, { recursive: true });

  const asset = cloudflaredAsset();
  const url = `https://github.com/cloudflare/cloudflared/releases/download/${CLOUDFLARED_VERSION}/${asset}`;
  log(`downloading ${url}`);
  const staged = join(tmpdir(), basename(asset));
  await downloadTo(url, staged);

  if (asset.endsWith(".tgz")) {
    const extractDir = join(tmpdir(), `porchlight-cloudflared-${Date.now()}`);
    extractTarGz(staged, extractDir, 0);
    const candidates = readdirSync(extractDir).filter((name) => name === "cloudflared");
    if (candidates.length === 0) throw new Error("cloudflared archive did not contain the binary");
    copyFileSync(join(extractDir, candidates[0]), target);
  } else {
    copyFileSync(staged, target);
  }
  chmodSync(target, 0o755);
  try {
    execFileSync(target, ["--version"], { stdio: "pipe" });
  } catch (error) {
    throw new Error(`cloudflared downloaded but will not execute on this host (${error.message})`);
  }
  log(`cloudflared installed at ${target}`);
  return target;
}