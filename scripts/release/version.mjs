#!/usr/bin/env node
// version.mjs — release version step (PORCH-002 ac-2).
//
// Sets the release version across the root and every workspace package.json
// AND syncs package-lock.json — with zero network access.
//
// Why not `npm version --workspaces`: before the first publish, the workspace
// packages are not on the npm registry, and npm's version command re-resolves
// workspace dependency specs from the registry — it 404s on
// `@porchlight/identity@0.1.0` and aborts the deploy.
//
// Usage: node scripts/release/version.mjs <semver>   (e.g. 0.1.0, 0.1.0-dryrun.1)

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import process from "node:process";

const newVersion = process.argv[2];
if (!newVersion || !/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(newVersion)) {
  process.stderr.write(`usage: node scripts/release/version.mjs <semver> (got: ${newVersion})\n`);
  process.exit(1);
}

const lock = JSON.parse(readFileSync("package-lock.json", "utf8"));

// Workspace entries in the lock have no `resolved`/`link`; anything else is a registry package.
const workspaceDirs = Object.entries(lock.packages)
  .filter(([_key, entry]) => entry.link === undefined && entry.resolved === undefined && entry.name !== undefined)
  .map(([key]) => (key === "" ? "." : key));
if (workspaceDirs.length < 2) {
  process.stderr.write(`no workspace entries found in package-lock.json — aborting\n`);
  process.exit(1);
}

const manifests = [];
for (const dir of workspaceDirs) {
  const file = join(dir, "package.json");
  const pkg = JSON.parse(readFileSync(file, "utf8"));
  manifests.push({ dir, file, pkg, old: pkg.version });
}
const oldByName = new Map(manifests.map((m) => [m.pkg.name, m.old]));

const changed = [];
for (const { dir, file, pkg, old } of manifests) {
  pkg.version = newVersion;
  // Keep workspace dependency specs aligned with the release: any
  // `@porchlight/*` spec pinned to the package's previous version moves to
  // the new version (all workspace packages version together).
  for (const section of ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"]) {
    const deps = pkg[section];
    if (!deps) continue;
    for (const [k, v] of Object.entries(deps)) {
      if (oldByName.get(k) === v) deps[k] = newVersion;
    }
  }
  writeFileSync(file, JSON.stringify(pkg, null, 2) + "\n");
  changed.push({ name: pkg.name, dir, old, newVersion });
}

// Sync the lockfile: workspace entries get the new version; workspace-spec
// references in any `dependencies`/`devDependencies` object are rewritten.
for (const [, entry] of Object.entries(lock.packages)) {
  if (entry.version !== undefined && entry.name !== undefined && oldByName.has(entry.name)) {
    entry.version = newVersion;
  }
  for (const section of ["dependencies", "devDependencies", "optionalDependencies"]) {
    const deps = entry[section];
    if (!deps) continue;
    for (const [k, v] of Object.entries(deps)) {
      if (oldByName.get(k) === v) deps[k] = newVersion;
    }
  }
}
writeFileSync("package-lock.json", JSON.stringify({ ...lock, version: newVersion }, null, 2) + "\n");

for (const c of changed) {
  process.stdout.write(`versioned ${c.name} (${c.dir}): ${c.old} -> ${newVersion}\n`);
}
process.stdout.write(`package-lock.json synced to ${newVersion}\n`);