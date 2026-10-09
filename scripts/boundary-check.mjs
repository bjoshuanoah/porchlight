// Module boundary enforcement (PORCH-001 AC-3).
//
// Fails the build (exit code 1) when:
//   1. a module reaches into another module's source tree (a cross-module
//      import, resolved from the importing file's own path).
//   2. a module reaches into another module's models (imports another
//      module's `models.js`).
//   3. a model is shared between the identity and social domains.
//
// Runs with Node's standard library only; no external runtime required.
import { readFileSync, readdirSync, existsSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, "..");

const MODULES = ["identity", "social"];

/** Resolve a relative import specifier from the importing file's directory.
 *  Checks the specifier as written first (the target's real extension may be
 *  .js even though the importer is .ts), then falls back to a .ts sibling. */
function resolveRelative(specifier, fromDir) {
  if (!specifier.startsWith(".")) return null;
  const candidates = [specifier, specifier.replace(/\.js$/, ".ts")];
  for (const c of candidates) {
    const resolved = resolve(fromDir, c);
    if (existsSync(resolved)) return resolved;
  }
  return null;
}

/** Recursively gather every .js/.ts file under a module's source tree,
 *  returning [{ file, dir }] so import specifiers can be resolved in context. */
function collectModuleContexts(moduleDir) {
  const target = join(repoRoot, "modules", moduleDir);
  const out = [];
  if (!existsSync(target)) return out;
  const stack = [target];
  while (stack.length) {
    const dir = stack.pop();
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
      const file = join(dir, entry.name);
      if (entry.isDirectory()) stack.push(file);
      else if (/\.(js|ts)$/.test(entry.name)) out.push({ file, dir });
    }
  }
  return out;
}

function rel(p) {
  return p.startsWith(repoRoot) ? p.slice(repoRoot.length + 1) : p;
}

function resolveToFile(resolved) {
  let current = resolved;
  while (existsSync(current) && statSync(current).isDirectory()) {
    current = join(current, "index.ts");
  }
  return current;
}

const errors = [];
for (const moduleDir of MODULES) {
  for (const { file, dir } of collectModuleContexts(moduleDir)) {
    const source = readFileSync(file, "utf8");
    const re = /from\s+['"]([^'"]+)['"]/g;
    let match;
    while ((match = re.exec(source))) {
      const specifier = match[1];

      if (specifier.startsWith(".")) {
        const resolved = resolveRelative(specifier, dir);
        if (resolved) {
          const target = resolveToFile(resolved);
          for (const other of MODULES) {
            if (other === moduleDir) continue;
            if (target.includes(`/modules/${other}/`)) {
              errors.push(
                `${moduleDir}: cross-module import "${specifier}" from ${rel(file)} (reach into ${other})`,
              );
            }
          }
        }
        continue;
      }

      // Bare package specifier. Only @porchlight/shared is a permitted
      // cross-module import; importing another @porchlight/<module> name
      // (internal path) is a cross-module import.
      if (specifier.startsWith("@porchlight/")) {
        const seg = specifier.split("/").filter(Boolean);
        if (
          seg[0] === "@porchlight" &&
          MODULES.includes(seg[1]) &&
          seg[1] !== "shared"
        ) {
          errors.push(
            `${moduleDir}: cross-module import "${specifier}" (reach into ${seg[1]})`,
          );
        }
        continue;
      }
    }
  }
}

// Cross-module model sharing: a model object name defined in both modules.
const identityText = readFileSync(
  join(repoRoot, "modules/identity/src/models.js"),
  "utf8",
);
const socialText = readFileSync(
  join(repoRoot, "modules/social/src/models.js"),
  "utf8",
);
for (const decl of socialText.match(/export const (\w+)/g) || []) {
  const name = decl.replace("export const ", "");
  if (new RegExp(`export const ${name}`).test(identityText)) {
    errors.push(`shared model "${name}" appears in both identity and social`);
  }
}

if (errors.length) {
  console.error("\nMODULE BOUNDARY VIOLATION:\n");
  for (const e of errors) console.error("  \u2717 " + e);
  console.error(
    "\nidentity and social MUST own their models separately and never import each other's internals.",
  );
  process.exit(1);
}

console.log("boundary check passed: no cross-module imports or shared models");
