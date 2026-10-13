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
  readlinkSync,
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
  }
  return copied;
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

const bundledCount = copyClosure(join(stageRoot, "node_modules"));
// The porchlight runtime closure is ~150 packages; a tiny count means the
// tree was never installed — refuse rather than publish a broken installer.
if (bundledCount < 10) {
  process.stderr.write(
    `porchlight bundle: dependency closure implausibly small (${bundledCount}) — run npm ci first\n`,
  );
  process.exit(1);
}
process.stdout.write(`bundled ${bundledCount} runtime packages\n`);

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
rmSync(verifyPrefix, { recursive: true, force: true });
process.stdout.write(`wrote ${tarballPath} (verified: installs clean and runs)\n`);