#!/usr/bin/env node
// Release verification for porchlight GitHub release artifacts (PORCH-002 ac-5).
//
// Every porchlight release ships:
//   *.tgz            — the npm-published tarballs (all MIT)
//   SHA256SUMS       — sha256 of every tarball
//   SHA256SUMS.bundle— Sigstore keyless signature of SHA256SUMS, created by the
//                      deploy workflow; the trust anchor is the Sigstore
//                      keyless identity pinned to bjoshuanoah/porchlight's
//                      .github/workflows/deploy.yml + the Rekor transparency
//                      log. No key lives in this repo; see
//                      docs/release-verification.md for instructions.
//
// Usage:
//   node scripts/release/verify-release.mjs --dir  <release-assets-dir>
//   node scripts/release/verify-release.mjs --tag  <vX.Y.Z> [--repo <owner/repo>]
//     (--tag downloads the release assets of that tag from GitHub)
//
// Any missing signature, checksum mismatch, uncovered asset, or cosign
// identity failure fails LOUDLY (non-zero exit, explicit stderr report). An
// unsigned or tampered artifact must never pass.

import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import assert from "node:assert/strict";

const OIDC_ISSUER = "https://token.actions.githubusercontent.com";
const IDENTITY_REGEXP = "^https://github\\.com/bjoshuanoah/porchlight/\\.github/workflows/deploy\\.yml@";
const DEFAULT_REPO = "bjoshuanoah/porchlight";

const args = process.argv.slice(2);
let dir = null;
let tag = null;
let repo = DEFAULT_REPO;
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--dir") dir = args[++i];
  else if (args[i] === "--tag") tag = args[++i];
  else if (args[i] === "--repo") repo = args[++i];
  else usageError(`unknown argument: ${args[i]}`);
}
if (dir === null && tag === null) usageError("exactly one of --dir <assets-dir> or --tag <vX.Y.Z> is required");
if (dir !== null && tag !== null) usageError("--dir and --tag are mutually exclusive");

function usageError(msg) {
  process.stderr.write(`✗ VERIFY FAILED: ${msg}\n`);
  process.stderr.write(
    "usage: node scripts/release/verify-release.mjs --dir <release-assets-dir>\n" +
      "       node scripts/release/verify-release.mjs --tag <vX.Y.Z> [--repo <owner/repo>]\n",
  );
  process.exit(1);
}

function fail(msg) {
  process.stderr.write(`\n✗ VERIFY FAILED: ${msg}\n`);
  process.stderr.write(
    `This release artifact set is NOT trustworthy. Do not install or run it.\n` +
      `Instructions: docs/release-verification.md in the porchlight repository.\n`,
  );
  process.exit(1);
}

function sha256File(file) {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

function checkSumsAndAssets(assetDir) {
  const entries = readdirSync(assetDir);
  const sumsName = entries.find((e) => e === "SHA256SUMS");
  if (!sumsName) fail("SHA256SUMS is missing — the artifact set cannot be verified (unsigned or corrupt release).");

  const bundleName = entries.find((e) => e === "SHA256SUMS.bundle" || e === "SHA256SUMS.sig");
  if (!bundleName) {
    fail(
      "UNSIGNED ARTIFACTS: no SHA256SUMS signature (SHA256SUMS.bundle) next to SHA256SUMS. " +
        "Unsigned porchlight releases are rejected loudly.",
    );
  }

  // Parse SHA256SUMS: "<sha256>  <name>" lines (sha256sum/shasum -a 256 format).
  // Names are normalized (a leading "./" from `shasum -a 256 -- ./*` is stripped).
  const sums = new Map();
  for (const line of readFileSync(join(assetDir, sumsName), "utf8").split("\n")) {
    if (line.trim() === "") continue;
    const m = /^([0-9a-f]{64})\s{2}(\S+)$/.exec(line);
    if (!m) fail(`malformed SHA256SUMS line: "${line}"`);
    const name = m[2].replace(/^\.\//, "");
    if (sums.has(name)) fail(`duplicate SHA256SUMS entry for ${name}`);
    sums.set(name, m[1]);
  }
  if (sums.size === 0) fail("SHA256SUMS is empty");

  // Every non-SUMS asset must be covered by an entry; every entry must have its file.
  const covered = new Set([...sums.keys()]);
  for (const entry of entries) {
    if (entry === sumsName || entry === bundleName) continue;
    if (!covered.has(entry)) fail(`release asset "${entry}" is not covered by SHA256SUMS (no checksum entry)`);
  }

  const verified = [];
  for (const [name, expected] of sums) {
    const file = join(assetDir, name);
    let actual;
    try {
      actual = sha256File(file);
    } catch {
      fail(`SHA256SUMS lists "${name}" but the artifact is missing from the release`);
    }
    if (actual !== expected) {
      fail(`checksum mismatch for "${name}": expected ${expected}, got ${actual} — artifact is tampered or corrupt`);
    }
    verified.push(name);
  }
  return { bundleName, verified };
}

function cosignVerify(assetDir, bundleName) {
  const probe = spawnSync("cosign", ["version"], { encoding: "utf8" });
  if (probe.error || probe.status !== 0) {
    fail(
      "cosign is not installed or not usable on PATH. Install it first: " +
        "brew install cosign (macOS) / curl + install per https://docs.sigstore.dev — see docs/release-verification.md.",
    );
  }
  const res = spawnSync(
    "cosign",
    [
      "verify-blob",
      join(assetDir, "SHA256SUMS"),
      "--bundle",
      join(assetDir, bundleName),
      "--certificate-oidc-issuer",
      OIDC_ISSUER,
      "--certificate-identity-regexp",
      IDENTITY_REGEXP,
    ],
    { encoding: "utf8" },
  );
  if (res.error || res.status !== 0) {
    fail(
      `signature verification FAILED (cosign exit ${res.status}).\n` +
        `cosign stderr/stdout:\n${(res.stderr || "") + (res.stdout || "")}`,
    );
  }
  return (res.stdout || "").trim();
}

if (tag !== null) {
  // Download the release assets for the tag into a temp dir, then verify --dir.
  dir = join(tmpdir(), `porchlight-verify-${tag}-${process.pid}`);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });

  const api = `https://api.github.com/repos/${repo}/releases/tags/${tag}`;
  const res = await fetch(api, {
    headers: { accept: "application/vnd.github+json", "user-agent": "porchlight-release-verifier" },
  });
  if (!res.ok) {
    fail(`GitHub release ${tag} not found under ${repo} (HTTP ${res.status}). ` + `Only published (non-draft) releases are verifiable anonymously.`);
  }
  const release = await res.json();
  assert.equal(Array.isArray(release.assets), true, "release assets array");
  if (release.assets.length === 0) fail(`release ${tag} carries no assets`);
  for (const asset of release.assets) {
    const dest = join(dir, asset.name);
    const r = await fetch(asset.browser_download_url, { headers: { "user-agent": "porchlight-release-verifier" } });
    if (!r.ok) fail(`failed to download asset ${asset.name} (HTTP ${r.status})`);
    writeFileSync(dest, Buffer.from(await r.arrayBuffer()));
  }
  process.stdout.write(`Downloaded ${release.assets.length} assets for ${repo} release ${tag}\n`);
}

process.stdout.write(`Verifying ${dir} …\n`);
const { bundleName, verified } = checkSumsAndAssets(dir);
process.stdout.write(`Checksums verified: ${verified.length} artifacts match SHA256SUMS.\n`);
const attestations = cosignVerify(dir, bundleName);
process.stdout.write("Signature verified (Sigstore keyless):\n");
process.stdout.write(`  identity regexp: ${IDENTITY_REGEXP}\n`);
process.stdout.write(`  issuer:          ${OIDC_ISSUER}\n`);
if (attestations.trim()) process.stdout.write(`  cosign:\n${attestations}\n`);
process.stdout.write("\n✓ VERIFIED — release artifact set is intact and signed.\n");