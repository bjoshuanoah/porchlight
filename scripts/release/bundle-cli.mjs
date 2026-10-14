#!/usr/bin/env node
// bundle-cli.mjs — build the SELF-CONTAINED porchlight install tarball for
// releases (PORCH-003 ac-1: `nm install -g porchlight` must be dependency-
// complete with zero manual steps) — packed BY NPM, from the repository
// checkout (PORCH-071).
//
// Why a bundling stage still exists: npm's pack does not resolve the
// `bundleDependencies` of a workspace package from the root node_modules (the
// closure trees sit one level up, outside the packed workspace), while a
// declared bundle list makes installers skip registry resolution — an
// unpacked bundle would install a porchlight whose hub child cannot even be
// spawned. The stage therefore pre-stages the runtime closure (the
// bundledDependencies: ffi-class binaries, sharp platform trees, ffprobe)
// under the workspace package directory itself (packages/cli/node_modules),
// declares the cross-platform sharp optional trees on the staged sharp
// manifest so npm's own packing resolves and carries them (arborist only
// packs optional trees that the packed manifest declares), and packs with
// `npm pack -w packages/cli` — the registry manifest, README and LICENSE ride
// npm's native packing (PORCH-071 ac-1: npm receives a payload packed from
// the repository checkout, not a separately assembled tree; the retired
// route — hand `tar` of a detached staging tree, published from that
// staging dir — must not come back).
//
// The packer mutates the checkout while it runs and restores it afterwards:
// the staged closure, the staged README/LICENSE copies and the staged sharp
// manifest all live under packages/cli, which is gitignored for node_modules
// and restored for the two manifest-side files.
//
// Usage: node scripts/release/bundle-cli.mjs --out <release-assets-dir>
//        (deploy + local — the tarball version is the repo manifest version;
//         the cut's committed package.json version is authoritative,
//         PORCH-071 ac-2)

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
const positional = process.argv.slice(2).filter((a) => a !== "--out" && a !== outDir && !a.startsWith("-"));
if (!outDir || positional.length > 0) {
  process.stderr.write("usage: node scripts/release/bundle-cli.mjs --out <release-assets-dir>\n");
  process.exit(1);
}

// The npm registry rejects any tarball containing a symlink (E415 — hit by
// the first v0.1.1 run, PORCH-062); the packed bytes must also stay under
// the registry publish cap (413 observed at 186.1 MB; the last passing
// registry copy sat at 168.2 MB — the cap gate keeps a margin, PORCH-067).
const PACK_SIZE_CAP_MB = 168;

// ---- sharp platform completion (PORCH-067) ---------------------------------
// (platform set of record consumed both by the staging fetch below and by
// the post-pack gates; see the header note on why the fetch exists.)
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

const repoRoot = resolve();
const cli = join(repoRoot, "packages", "cli");
const cliNodeModules = join(cli, "node_modules");
const cliManifestPath = join(cli, "package.json");
const cliManifest = JSON.parse(readManifest(cliManifestPath));

function readManifest(path) {
  return execFileSync(process.execPath, ["-e", `console.log(JSON.stringify(require(${JSON.stringify(path)})))`]).toString().trim();
}

const version = cliManifest.version;
if (!/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(version)) {
  process.stderr.write(
    `porchlight bundle: packages/cli/package.json carries version "${version}" — the committed repo manifest is authoritative and semver-checked; bump package.json to the cut version before packing (PORCH-071 ac-2)\n`,
  );
  process.exit(1);
}
if (!existsSync(join(repoRoot, "node_modules"))) {
  process.stderr.write("porchlight bundle: run from the repository root with the tree installed (npm ci) — scripts/release/bundle-cli.mjs\n");
  process.exit(1);
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

// ---- stage under the repo's package directory ------------------------------
// The stage mutates the checkout and every mutation is undone before this
// script exits (the tarball and its gates read from outDir afterwards).
const restoreJobs = [];

// Snapshot of the staged closure tops, filled during staging and consumed by
// the post-pack completeness gate.
const stagedTops = new Set();

function restore() {
  for (const job of [...restoreJobs].reverse()) {
    try {
      job();
    } catch (error) {
      process.stderr.write(`porchlight bundle: restore step failed (${error.message}) — fix the checkout manually if needed\n`);
    }
  }
  restoreJobs.length = 0;
}

function packFailure(message) {
  process.stderr.write(`porchlight bundle: ${message}\n`);
  restore();
  process.exit(1);
}

if (existsSync(cliNodeModules)) {
  // A pre-existing workspace-local node_modules is unusual; keep it intact.
  renameSync(cliNodeModules, `${cliNodeModules}.bundle-backup-${process.pid}`);
  restoreJobs.push(() => {
    rmSync(cliNodeModules, { recursive: true, force: true });
    renameSync(`${cliNodeModules}.bundle-backup-${process.pid}`, cliNodeModules);
  });
} else {
  restoreJobs.push(() => rmSync(cliNodeModules, { recursive: true, force: true }));
}
mkdirSync(cliNodeModules, { recursive: true });

try {
let copied = 0;
for (const rel of closureEntries()) {
  // The tarball root IS porchlight; its workspace self-link must not be
  // nested inside itself (a self-reference makes npm resolve the root
  // package from the registry and 404).
  if (rel === "porchlight" || rel === join("porchlight", "")) continue;
  const source = join(repoRoot, "node_modules", rel);
  const target = join(cliNodeModules, rel);
  if (!existsSync(source)) continue;
  if (!statSync(source).isDirectory()) continue;
  mkdirSync(dirname(target), { recursive: true });
  if (existsSync(target)) continue;
  // dereference: workspace deps are symlinks into the monorepo — their
  // real (versioned, built) content ships in the tarball.
  cpSync(source, target, { recursive: true, dereference: true });
  copied += 1;
}
// The porchlight runtime closure is ~150 packages; a tiny count means the
// tree was never installed — refuse rather than publish a broken installer.
if (copied < 10) {
  packFailure(`dependency closure implausibly small (${copied}) — run npm ci first`);
}
process.stdout.write(`bundled ${copied} runtime packages (staged under ${relative(repoRoot, cliNodeModules)})\n`);

// arborist packs optional trees that the packed manifest declares; the set
// of record above drives both the fetch and every gate.
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

// sharp sits top-level in the closure (its own staged tree shadows the root
// node_modules copy once staged — a live npm ls at this point resolves it
// under packages/cli, so the search reads the staged tree directly).
let sharpManifestPath = null;
const sharpCandidate = join(cliNodeModules, "sharp", "package.json");
if (existsSync(sharpCandidate) && JSON.parse(readFileSync(sharpCandidate, "utf8")).name === "sharp") {
  sharpManifestPath = sharpCandidate;
}
if (!sharpManifestPath) {
  packFailure("sharp did not resolve into the staged closure — the installed tree is incomplete; run npm ci");
}

const declared = JSON.parse(readFileSync(sharpManifestPath, "utf8")).optionalDependencies ?? {};
const fetched = [];
for (const { packages } of SHARP_PLATFORM_SET) {
  for (const pkg of packages) {
    if (existsSync(join(cliNodeModules, pkg))) continue;
    const spec = declared[pkg];
    if (!spec) {
      packFailure(`sharp cannot carry ${pkg} — its manifest declares no optionalDependency for it`);
    }
    const fetchDir = mkdtempSync(join(tmpdir(), "porchlight-platform-"));
    const packDir = join(fetchDir, "pack");
    const extractDir = join(fetchDir, "extract");
    mkdirSync(packDir, { recursive: true });
    mkdirSync(extractDir, { recursive: true });
    const packedName = execFileSync("npm", ["pack", `${pkg}@${spec}`, "--pack-destination", packDir], {
      cwd: repoRoot,
      encoding: "utf8",
    });
    const tarball = join(packDir, packedName.trim().split("\n").pop());
    execFileSync("tar", ["xzf", tarball, "-C", extractDir]);
    const fetchedManifest = JSON.parse(readFileSync(join(extractDir, "package", "package.json"), "utf8"));
    if (fetchedManifest.name !== pkg || fetchedManifest.version !== spec) {
      packFailure(`registry served ${fetchedManifest.name}@${fetchedManifest.version} for ${pkg}@${spec} — refusing a mismatched platform tree`);
    }
    // Place by content, never by link: registry tarballs are plain trees, the
    // link-hygiene pass below still gates everything that ships.
    renameSync(join(extractDir, "package"), join(cliNodeModules, pkg));
    const treeBytes = treeSize(join(cliNodeModules, pkg));
    process.stdout.write(`  + ${pkg}@${fetchedManifest.version} (${(treeBytes / (1024 * 1024)).toFixed(1)} MB unpacked)\n`);
    rmSync(fetchDir, { recursive: true, force: true });
    fetched.push(pkg);
  }
}
if (fetched.length > 0) {
  process.stdout.write(
    `sharp platform completion: fetched ${fetched.length} platform tree(s) the packer OS (${process.platform}/${process.arch}) never installs — ` +
      fetched.join(", ") + "\n",
  );
}
// sharp-wasm32 ships without an optionalDependency declaration on sharp's
// own manifest (the lock resolves it through the wasm tree chain) — declare
// it on the staged sharp manifest so npm's packing can resolve it (only
// manifest-visible optional trees are packed; arborist drops the rest).
const sharpManifest = JSON.parse(readFileSync(sharpManifestPath, "utf8"));
if (existsSync(join(cliNodeModules, "@img/sharp-wasm32")) && !sharpManifest.optionalDependencies["@img/sharp-wasm32"]) {
  sharpManifest.optionalDependencies["@img/sharp-wasm32"] = sharpManifest.version;
  writeManifest(sharpManifestPath, sharpManifest);
  fetched.push("@img/sharp-wasm32");
  process.stdout.write(`  + @img/sharp-wasm32@${sharpManifest.version} (declared on the staged sharp manifest)\n`);
}

function writeManifest(path, manifest) {
  // The staged sharp manifest sits inside a vendored dependency tree; 2-space
  // rewrite matches what npm publishes and keeps the diff noise flat.
  writeFileSync(path, JSON.stringify(manifest, null, 2) + "\n");
}

// GATE — closure must carry every platform binary AND libvips tree of the
// supported set with real content (a missing or empty tree = media ops that
// fail post-install on that OS).
for (const { packages } of SHARP_PLATFORM_SET) {
  for (const pkg of packages) {
    const dir = join(cliNodeModules, pkg);
    if (!existsSync(dir)) {
      packFailure(`platform closure incomplete — ${pkg} missing from the staged tree`);
    }
  }
}
process.stdout.write("sharp platform closure complete: " + SHARP_PLATFORM_SET.map((p) => p.platform).join(", ") + "\n");

// ---- prune: drop binaries outside the supported set of record (PORCH-067 ac-3) ----
// The registry publish cap killed the first v0.2.0 pack (npm 413 Payload Too
// Large at 186.1 MB; v0.1.1's 168.2 MB registry copy passed — the effective
// PUT ceiling sits between). ffprobe-static ships a binary zoo inside the
// npm package; the ia32 trees (linux/ia32, win32/ia32) are dead weight no
// supported hub ever executes — the supported set of record is the same set
// the sharp closure carries: darwin arm64/x64, linux x64, win32 x64. The
// prune is explicit and named: only packages enumerated here are touched,
// never the closure generally.
const SUPPORTED_BINARY_PLATFORMS = {
  darwin: ["arm64", "x64"],
  linux: ["x64"],
  win32: ["x64"],
};

function pruneBinaryZoo(base) {
  if (!existsSync(base)) return 0;
  let prunedBytes = 0;
  for (const pkgOrOs of readdirSync(base, { withFileTypes: true })) {
    const path = join(base, pkgOrOs.name);
    if (pkgOrOs.isDirectory() && existsSync(join(path, "package.json"))) {
      // The package root itself: recurse into its bin/ trees.
      prunedBytes += pruneBinaryZoo(join(path, "bin"));
      continue;
    }
    if (pkgOrOs.isDirectory() && SUPPORTED_BINARY_PLATFORMS[pkgOrOs.name]) {
      // os level: prune arch subdirs outside the supported set.
      for (const arch of readdirSync(path, { withFileTypes: true })) {
        if (!SUPPORTED_BINARY_PLATFORMS[pkgOrOs.name].includes(arch.name)) {
          prunedBytes += treeSize(join(path, arch.name));
          rmSync(join(path, arch.name), { recursive: true, force: true });
        }
      }
      continue;
    }
  }
  return prunedBytes;
}

const ffprobePrunedBytes = pruneBinaryZoo(join(cliNodeModules, "ffprobe-static", "bin"));
if (ffprobePrunedBytes > 0) {
  process.stdout.write(`pruned ${(ffprobePrunedBytes / (1024 * 1024)).toFixed(1)} MB of out-of-support-set binaries from ffprobe-static\n`);
}

function treeSize(dir) {
  let total = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    total += entry.isDirectory() ? treeSize(path) : statSync(path).size;
  }
  return total;
}

// ---- README / LICENSE staging ----------------------------------------------
// The registry page renders the tarball's README (PORCH-071 ac-3): stage the
// repo README.md and LICENSE under the package directory so npm's own
// packing carries them. Pre-existing copies are restored after the pack —
// the repo copies are the record, the staged copies ride the tarball only.
for (const file of ["README.md", "LICENSE"]) {
  const repoFile = join(repoRoot, file);
  const packageFile = join(cli, file);
  if (existsSync(packageFile)) {
    const preExisting = readFileSync(packageFile, "utf8");
    restoreJobs.push(() => writeFileSync(packageFile, preExisting));
  } else {
    restoreJobs.push(() => rmSync(packageFile, { force: true }));
  }
  if (existsSync(repoFile)) copyFileSync(repoFile, packageFile);
}

// ---- link hygiene ----------------------------------------------------------
// The npm registry rejects any tarball containing a symlink
// (E415 "Symbolic link is not allowed" — hit by the first v0.1.1 run,
// PORCH-062). The installed tree legitimately carries npm's .bin symlink
// entries (incl. nested node_modules), and the dereference copy may leave
// nested links standing. Resolve every remaining link to its target content
// (drop links that dangle), then GATE: a link surviving fails loudly instead
// of packing a tarball the registry will refuse.
function flattenNestedLinks(dir) {
  let flattened = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isSymbolicLink()) {
      const linkTarget = resolve(dirname(path), readlinkSync(path));
      rmSync(path, { force: true });
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

// tarball-level link gate: the packed tar is scanned for symlink entries
// below — that gate is the authoritative one (it sees the exact bytes).

let flattened = 0;
for (let pass = 0; pass < 10; pass++) {
  const linksThisPass = flattenNestedLinks(cliNodeModules);
  if (linksThisPass === 0) break;
  flattened += linksThisPass;
}
if (flattened > 0) process.stdout.write(`flattened ${flattened} nested symlink entr${flattened === 1 ? "y" : "ies"} in the staged closure\n`);

// Snapshot the staged closure tops for the post-pack completeness gate (the
// stage is restored right after the pack).
for (const entry of readdirSync(cliNodeModules, { withFileTypes: true })) {
  if (!entry.isDirectory()) continue;
  if (entry.name.startsWith("@")) {
    for (const scopeEntry of readdirSync(join(cliNodeModules, entry.name), { withFileTypes: true })) {
      stagedTops.add(`${entry.name}/${scopeEntry.name}`);
    }
  } else {
    stagedTops.add(entry.name);
  }
}

// ---- pack: npm's own packing of the built package directory -----------------
execFileSync("npm", ["pack", "-w", "packages/cli", "--pack-destination", outDir], {
  cwd: repoRoot,
  stdio: ["ignore", "inherit", "inherit"],
});
restore();
} catch (error) {
  restore();
  process.stderr.write(`porchlight bundle: staging or pack step failed: ${error.message}\n`);
  process.exit(1);
}

const tarballPath = join(outDir, `porchlight-${version}.tgz`);
if (!existsSync(tarballPath)) {
  process.stderr.write(`porchlight bundle: npm pack produced no porchlight-${version}.tgz in ${outDir} — check the pack output above\n`);
  process.exit(1);
}
const packedBytes = statSync(tarballPath).size;
const packedMB = packedBytes / (1024 * 1024);

function tarballFailure(message) {
  process.stderr.write(`porchlight bundle: ${message}\n`);
  process.exit(1);
}

// ---- gates on the packed tarball (porch-062 lesson: prove the tarball) ------
const tarNames = execFileSync("tar", ["tzf", tarballPath], { encoding: "utf8" }).split("\n").filter(Boolean);
const tarDetail = execFileSync("tar", ["tvzf", tarballPath], { encoding: "utf8" }).split("\n");
const symlinks = tarDetail.filter((line) => line.startsWith("l")).map((line) => line.slice(7));
if (symlinks.length > 0) {
  tarballFailure(
    `${symlinks.length} symlink(s) in the packed tarball — the npm registry rejects symlinks (E415):\n  ` +
      symlinks.join("\n  "),
  );
}

const packageFiles = new Set(tarNames.map((name) => name.replace(/^package\//, "")));
const expectPresent = ["README.md", "LICENSE", "bin/porchlight.mjs", "package.json", "src/"];
for (const expected of expectPresent) {
  const hit = expected.endsWith("/") ? [...packageFiles].some((name) => name.startsWith(expected)) : packageFiles.has(expected);
  if (!hit) tarballFailure(`packed tarball misses ${expected} — the registry manifest would not carry it`);
}
process.stdout.write("tarball surface gate: README.md, LICENSE, bin/, package.json, src/ all present\n");

const packedTops = new Set(
  [...packageFiles]
    .filter((name) => name.startsWith("node_modules/"))
    .map((name) => {
      const parts = name.split("/");
      return parts[1].startsWith("@") ? `${parts[1]}/${parts[2] ?? ""}` : parts[1];
    }),
);
const missingTops = [...stagedTops].filter((top) => !packedTops.has(top));
if (missingTops.length > 0) {
  tarballFailure(
    `${missingTops.length} staged closure tree(s) were NOT packed: ${missingTops.slice(0, 12).join(", ")}` +
      (missingTops.length > 12 ? ` … (+${missingTops.length - 12})` : "") +
      " — npm's packing must carry every staged top (each bundled/optional entry must be an edge of the packed manifest)",
  );
}
const rogueTops = [...packedTops].filter((top) => !stagedTops.has(top));
if (rogueTops.length > 0) {
  tarballFailure(`unexpected trees in the packed tarball (not staged): ${rogueTops.slice(0, 12).join(", ")}`);
}
for (const { packages } of SHARP_PLATFORM_SET) {
  for (const pkg of packages) {
    if (!packedTops.has(pkg)) tarballFailure(`packed tarball misses the platform tree ${pkg} — platform closure incomplete`);
  }
}
process.stdout.write(
  `closure gate: ${packedTops.size} dependency trees packed, sharp platform set of record complete\n`,
);

if (packedMB > PACK_SIZE_CAP_MB) {
  tarballFailure(
    `packed tarball is ${packedMB.toFixed(1)} MB — above the ${PACK_SIZE_CAP_MB} MB cap gate (registry 413 observed at 186.1 MB, last passing copy at 168.2 MB; PORCH-067 ac-3). Prune the payload or shrink the closure before any cut.`,
  );
}

// ---- verify: clean isolated install + run, zero registry resolution --------
const verifyPrefix = mkdtempSync(join(tmpdir(), "porchlight-verify-"));
function verifyFailure(message) {
  process.stderr.write(`porchlight bundle verification failed: ${message}\n`);
  rmSync(verifyPrefix, { recursive: true, force: true });
  process.exit(1);
}
execFileSync("npm", ["install", "-g", tarballPath, `--prefix=${join(verifyPrefix, "n")}`], {
  encoding: "utf8",
  stdio: ["ignore", "pipe", "inherit"],
});
const binPath = join(verifyPrefix, "n", "lib", "node_modules", "porchlight", "bin", "porchlight.mjs");
const printed = execFileSync(process.execPath, [binPath, "--version"], { encoding: "utf8" });
if (!printed.includes(`porchlight v${version}`)) {
  verifyFailure(`unexpected --version output: ${printed}`);
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
      verifyFailure(`${pkg} survived install with no native binary`);
    }
  }
}
if (pruned.length > 0) {
  verifyFailure(
    `npm install pruned the bundled platform trees (${pruned.join(", ")}) — ` +
      "the platform closure must be manifest-visible (optionalDependencies on the staged sharp manifest), not merely staged (PORCH-067)",
  );
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
process.stdout.write(`wrote ${tarballPath} (${packedMB.toFixed(1)} MB packed) (verified: installs clean and runs)\n`);