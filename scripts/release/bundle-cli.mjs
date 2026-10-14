#!/usr/bin/env node
// bundle-cli.mjs — build the SELF-CONTAINED porchlight install tarball for
// releases (PORCH-003 ac-1: `npm install -g porchlight` must be dependency-
// complete with zero manual steps).
//
// Why this exists: npm's `pack` does not include `bundleDependencies` of a
// package inside an npm workspaces tree, while a declared bundle list makes
// installers skip registry resolution — an unpacked bundle would install a
// porchlight whose hub child cannot even be spawned. This script constructs
// the tarball explicitly: the CLI package plus its complete runtime
// dependency closure (dev deps excluded), copied from the installed tree,
// nested layout preserved, then verified by a clean isolated install + run.
//
// Usage: node scripts/release/bundle-cli.mjs <version> --out <dir>   (deploy)
//        node scripts/release/bundle-cli.mjs --out <dir>             (local)

import { execFileSync } from "node:child_process";
import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";

const outFlag = process.argv.indexOf("--out");
const outDir = outFlag > -1 ? resolve(process.cwd(), process.argv[outFlag + 1]) : null;
const versionArg = process.argv[2] && !process.argv[2].startsWith("--") ? process.argv[2] : null;

if (!outDir) {
  process.stderr.write("usage: node scripts/release/bundle-cli.mjs [<version>] --out <release-assets-dir>\n");
  process.exit(1);
}

const repoRoot = resolve();
const cli = join(repoRoot, "packages", "cli");
const cliManifest = JSON.parse(readManifest(join(cli, "package.json")));

function readManifest(path) {
  return execFileSync(process.execPath, ["-e", `console.log(JSON.stringify(require(${JSON.stringify(path)})))`]).toString().trim();
}

function versionedManifest() {
  if (!versionArg) return cliManifest;
  return { ...cliManifest, version: versionArg };
}

/**
 * Runtime dependency closure of porchlight, relative to the root
 * node_modules (relative layout preserved so nested duplicate versions stay
 * resolvable exactly the way they were installed).
 */
function closureEntries() {
  const output = execFileSync("npm", ["ls", "--all", "--parseable", "--omit=dev", "-w", "porchlight"], {
    encoding: "utf8",
  });
  const marker = join(repoRoot, "node_modules");
  const entries = [];
  for (const line of output.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.length) continue;
    entries.push(relative(marker, trimmed));
  }
  return entries.filter((entry) => entry && !entry.startsWith(".."));
}

function copyClosure(stageNodeModules) {
  let copied = 0;
  const rels = [];
  for (const rel of closureEntries()) {
    // The tarball root IS porchlight; its workspace self-link must not be
    // nested inside itself (a self-reference makes npm resolve the root
    // package from the registry and 404).
    if (rel === "porchlight" || rel === join("porchlight", "")) continue;
    const source = join(repoRoot, "node_modules", rel);
    const target = join(stageNodeModules, rel);
    if (!existsSync(source)) continue;
    if (!statSync(source).isDirectory()) continue;
    mkdirSync(dirname(target), { recursive: true });
    // dereference: workspace deps are symlinks into the monorepo — their
    // real (versioned, built) content ships in the tarball.
    cpSync(source, target, { recursive: true, dereference: true });
    copied += 1;
    rels.push(rel);
  }
  return { copied, rels };
}

// ---- stage -----------------------------------------------------------------
const staging = mkdtempSync(join(tmpdir(), "porchlight-bundle-"));
const stageRoot = join(staging, "package");
mkdirSync(stageRoot, { recursive: true });

writeFileSync(join(stageRoot, "package.json"), JSON.stringify(versionedManifest(), null, 2) + "\n");
for (const entry of readdirSync(cli)) {
  if (entry === "bin" || entry === "src" || entry === "LICENSE") {
    cpSync(join(cli, entry), join(stageRoot, entry), { recursive: true });
  }
}
if (existsSync(join(repoRoot, "LICENSE"))) copyFileSync(join(repoRoot, "LICENSE"), join(stageRoot, "LICENSE"));

const closure = copyClosure(join(stageRoot, "node_modules"));
const bundledCount = closure.copied;
// The porchlight runtime closure is ~150 packages; a tiny count means the
// tree was never installed — refuse rather than publish a broken installer.
if (bundledCount < 10) {
  process.stderr.write(
    `porchlight bundle: dependency closure implausibly small (${bundledCount}) — run npm ci first\n`,
  );
  process.exit(1);
}
process.stdout.write(`bundled ${bundledCount} runtime packages\n`);

// ---- sharp platform completion (PORCH-067) ---------------------------------
// npm resolves only the platform-matching optional dependencies of sharp on
// the packer runner (the v0.1.1 cut packed the linux trees only — a macOS or
// Windows hub starts fine but image media operations fail with a platform
// error). The bundled closure must carry a platform-complete sharp set: the
// platform binary AND its libvips tree for each supported OS, fetched by
// exact version from the registry at pack time so the tarball never depends
// on the packer runner's OS (PORCH-067 ac-1). Supported-OS set of record:
// darwin arm64/x64, linux x64 glibc + musl, win32 x64. sharp-wasm32 rides
// the closure's own optional resolution (v0.1.1 carried it, no size delta);
// the remaining sharp optional arches (linux-arm/arm64/ppc64/riscv64/s390x,
// win32-arm64/ia32, freebsd, webcontainers) stay outside the supported set.
// Per-platform requirement: the sharp binary, plus its libvips tree where
// sharp splits it out. win32 embeds libvips statically inside
// @img/sharp-win32-x64 (no separate @img/sharp-libvips-win32-* package
// exists); darwin/linux/musl carry the split trees.
const SHARP_PLATFORM_SET = [
  ["darwin-arm64", true],
  ["darwin-x64", true],
  ["linux-x64", true],
  ["linuxmusl-x64", true],
  ["win32-x64", false],
].map(([platform, splitVips]) => ({
  platform,
  packages: splitVips ? [`@img/sharp-${platform}`, `@img/sharp-libvips-${platform}`] : [`@img/sharp-${platform}`],
}));

const stageNodeModules = join(stageRoot, "node_modules");
let sharpPackageJsonPath = null;
for (const rel of closure.rels) {
  if (rel.split(/[/\\]/).pop() !== "sharp") continue;
  const candidate = join(stageNodeModules, rel, "package.json");
  if (!existsSync(candidate)) continue;
  if (JSON.parse(readFileSync(candidate, "utf8")).name === "sharp") {
    sharpPackageJsonPath = candidate;
    break;
  }
}
if (!sharpPackageJsonPath) {
  process.stderr.write(
    "porchlight bundle: sharp is not part of the runtime closure — the hub media pipeline " +
      "(rendition ladder, link-preview ingest) cannot work post-install; refusing to pack an image-blind installer (PORCH-067)\n",
  );
  rmSync(staging, { recursive: true, force: true });
  process.exit(1);
}

const sharpManifest = JSON.parse(readFileSync(sharpPackageJsonPath, "utf8"));
const missing = [];
for (const { packages } of SHARP_PLATFORM_SET) {
  for (const pkg of packages) {
    const declared = sharpManifest.optionalDependencies?.[pkg];
    if (!declared) {
      process.stderr.write(`porchlight bundle: sharp ${sharpManifest.version} does not declare optional dependency ${pkg} — the platform set of record drifted from the bundled sharp release\n`);
      rmSync(staging, { recursive: true, force: true });
      process.exit(1);
    }
    if (!existsSync(join(stageNodeModules, pkg))) missing.push([pkg, declared]);
  }
}

if (missing.length > 0) {
  process.stdout.write(
    `sharp platform completion: fetching ${missing.length} platform tree(s) the packer OS (${process.platform}/${process.arch}) never installs — ` +
      missing.map(([pkg]) => pkg).join(", ") + "\n",
  );
  for (const [pkg, version] of missing) {
    const fetchDir = mkdtempSync(join(tmpdir(), "porchlight-platform-"));
    const packDir = join(fetchDir, "pack");
    const extractDir = join(fetchDir, "extract");
    mkdirSync(packDir, { recursive: true });
    mkdirSync(extractDir, { recursive: true });
    const packed = execFileSync("npm", ["pack", `${pkg}@${version}`, "--pack-destination", packDir], {
      cwd: repoRoot,
      encoding: "utf8",
    });
    const tarball = join(packDir, packed.trim().split("\n").pop());
    execFileSync("tar", ["xzf", tarball, "-C", extractDir]);
    const fetched = JSON.parse(readFileSync(join(extractDir, "package", "package.json"), "utf8"));
    if (fetched.name !== pkg || fetched.version !== version) {
      process.stderr.write(`porchlight bundle: registry served ${fetched.name}@${fetched.version} for ${pkg}@${version} — refusing a mismatched platform tree\n`);
      rmSync(staging, { recursive: true, force: true });
      process.exit(1);
    }
    // Place by content, never by link: registry tarballs are plain trees, the
    // link-hygiene pass below still gates everything that ships.
    const manifestTarget = join(stageNodeModules, pkg);
    renameSync(join(extractDir, "package"), manifestTarget);
    const treeBytes = treeSize(manifestTarget);
    process.stdout.write(`  + ${pkg}@${fetched.version} (${(treeBytes / (1024 * 1024)).toFixed(1)} MB unpacked)\n`);
    rmSync(fetchDir, { recursive: true, force: true });
  }
}

// GATE — closure must carry every platform binary AND libvips tree of the
// supported set with real content (a missing or empty tree = media ops that
// fail post-install on that OS).
for (const { packages } of SHARP_PLATFORM_SET) {
  for (const pkg of packages) {
    const dir = join(stageNodeModules, pkg);
    if (!existsSync(dir)) {
      process.stderr.write(`porchlight bundle: platform closure incomplete — ${pkg} missing from the staged tree\n`);
      rmSync(staging, { recursive: true, force: true });
      process.exit(1);
    }
  }
}
process.stdout.write("sharp platform closure complete: " + SHARP_PLATFORM_SET.map((p) => p.platform).join(", ") + "\n");

function treeSize(dir) {
  let total = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    total += entry.isDirectory() ? treeSize(path) : statSync(path).size;
  }
  return total;
}

// ---- link hygiene ----------------------------------------------------------
// The npm registry rejects any tarball containing a symlink
// (E415 "Symbolic link is not allowed" — hit by the first v0.1.1 run,
// PORCH-062). The installed tree legitimately carries npm's .bin symlink
// entries (incl. nested node_modules), and cpSync's dereference may leave
// nested links standing. Resolve every remaining link in the stage to its
// target content (drop links that dangle), then GATE: a link surviving in
// the stage fails loudly instead of shipping a tarball the registry will
// refuse.
function flattenNestedLinks(dir) {
  let flattened = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isSymbolicLink()) {
      const linkTarget = resolve(dirname(path), readlinkSync(path));
      rmSync(path, { force: true, recursive: true });
      if (existsSync(linkTarget)) {
        cpSync(linkTarget, path, { recursive: true, dereference: true, force: true });
      }
      flattened += 1;
    } else if (entry.isDirectory()) {
      flattened += flattenNestedLinks(path);
    }
  }
  return flattened;
}

function findLinks(dir, links = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isSymbolicLink()) links.push(path);
    else if (entry.isDirectory()) findLinks(path, links);
  }
  return links;
}

// ---- pack ------------------------------------------------------------------
// Flatten until stable: replacing one link's content can surface further
// links in the copied target (cpSync dereference does not flatten nested
// links reliably — verified on the .bin tree). Cap the passes defensively.
let flattened = 0;
for (let pass = 0; pass < 10; pass++) {
  const linksThisPass = flattenNestedLinks(stageRoot);
  if (linksThisPass === 0) break;
  flattened += linksThisPass;
}
if (flattened > 0) process.stdout.write(`flattened ${flattened} nested symlink entr${flattened === 1 ? "y" : "ies"} in the stage\n`);
const linksLeft = findLinks(stageRoot);
if (linksLeft.length > 0) {
  // The registry E415s any symlink in the tarball; a link surviving the
  // flatten pass (e.g. a recursive/cyclic edge) must fail loudly here.
  process.stderr.write(
    `porchlight bundle: ${linksLeft.length} symlink(s) survived flattening — refusing to pack a tarball the npm registry will reject:\n` +
      linksLeft.map((l) => `  ${l} -> ${readlinkSync(l)}`).join("\n") +
      "\n",
  );
  rmSync(staging, { recursive: true, force: true });
  process.exit(1);
}

const tarballName = `porchlight-${versionedManifest().version}.tgz`;
const tarballPath = join(outDir, tarballName);
mkdirSync(outDir, { recursive: true });
execFileSync("tar", ["czf", tarballPath, "-C", staging, "package"]);
const packedBytes = statSync(tarballPath).size;
rmSync(staging, { recursive: true, force: true });

// ---- verify: clean isolated install + run, zero registry resolution --------
const verifyPrefix = mkdtempSync(join(tmpdir(), "porchlight-verify-"));
execFileSync("npm", ["install", "-g", tarballPath, `--prefix=${join(verifyPrefix, "n")}`], {
  encoding: "utf8",
});
const binPath = join(verifyPrefix, "n", "lib", "node_modules", "porchlight", "bin", "porchlight.mjs");
const printed = execFileSync(process.execPath, [binPath, "--version"], { encoding: "utf8" });
if (!printed.includes(`porchlight v${versionedManifest().version}`)) {
  process.stderr.write(`porchlight bundle verification failed: unexpected --version output: ${printed}\n`);
  rmSync(verifyPrefix, { recursive: true, force: true });
  process.exit(1);
}
// Reify survival gate (PORCH-067): installing the tarball reifies the tree
// against the manifest and may prune trees it considers extraneous — a
// platform set that merely exists in the stage but dies at install ships a
// hub whose media ops fail on that OS. Every supported tree must survive the
// clean install, and each platform binding must carry a native binary.
const installedImgRoot = join(verifyPrefix, "n", "lib", "node_modules", "porchlight", "node_modules", "@img");
const pruned = [];
for (const platform of SHARP_PLATFORM_SET) {
  for (const pkg of platform.packages) {
    const dir = join(installedImgRoot, pkg.split("/")[1]);
    if (!existsSync(dir)) {
      pruned.push(pkg);
      continue;
    }
    const binding = findNativeBinding(dir);
    if (!binding) {
      process.stderr.write(`porchlight bundle verification failed: ${pkg} survived install with no native binary\n`);
      rmSync(verifyPrefix, { recursive: true, force: true });
      process.exit(1);
    }
  }
}
if (pruned.length > 0) {
  process.stderr.write(
    `porchlight bundle verification failed: npm install pruned the bundled platform trees (${pruned.join(", ")}) — ` +
      `the platform closure must be manifest-visible (optionalDependencies on the staged manifest), not merely staged (PORCH-067)\n`,
  );
  rmSync(verifyPrefix, { recursive: true, force: true });
  process.exit(1);
}
process.stdout.write(`platform closure survived clean install: ${installedImgRoot}\n`);

function findNativeBinding(dir) {
  // libvips trees ship versioned shared libraries (libvips-cpp.so.8.18.7
  // class), not a .node binding — match the versioned-suffix forms too.
  const nativeLib = /\.(node|dylib|dll)(\.[\d.]+)?$|\.so(\.[\d.]+)?$/;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      const found = findNativeBinding(path);
      if (found) return found;
    }
    if (nativeLib.test(entry.name)) return path;
  }
  return null;
}

// PORCH-067: the bundled sharp must be runnable — the verifying machine
// loads its platform binary and completes a real hub media operation
// (imageMetadata + encodeImageRung, rotate → resize → webp) through the
// hub's own rendition encoder from the installed tree.
const smoke = execFileSync(
  process.execPath,
  [
    join(repoRoot, "scripts", "release", "media-smoke.mjs"),
    "--pkg",
    join(verifyPrefix, "n", "lib", "node_modules", "porchlight"),
  ],
  { encoding: "utf8" },
);
process.stdout.write(`platform smoke: ${smoke.trim()}\n`);
rmSync(verifyPrefix, { recursive: true, force: true });
process.stdout.write(`wrote ${tarballPath} (${(packedBytes / (1024 * 1024)).toFixed(1)} MB packed) (verified: installs clean and runs)\n`);