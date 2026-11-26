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
    // Cover every import form: `import x from "..."` / `export ... from "..."`,
    // side-effect `import "..."` (no from clause), and dynamic `import("...")`.
    const re = /(?:from\s+|\bimport\s+|\bimport\(\s*)['"]([^'"]+)['"]/g;
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

// --- PORCH-132: HAL isolation (ac-2) --------------------------------------
//
// The platform HAL (packages/hal) is the thin native integration layer: OS
// frameworks (Vision, AVFoundation, CoreML, Metal, VideoToolbox, …) and
// native platform bindings are importable ONLY inside packages/hal. Every
// engine service stays pure TS/Node and asks the HAL contract what the host
// provides — that is what keeps the platform portable with Apple Silicon as
// the default-best target.
//
// Fails the build when any source outside packages/hal:
//   1. imports an Apple/Linux OS framework directly (Swift/ObjC import or a
//      framework token inside JS/TS),
//   2. imports a native platform-binding package (FFI/desktop hooks), or
//   3. contains OS-framework-capable source at all (Swift/Objective-C files
//      belong to the HAL's native components, e.g. swift/VisionHelper.swift).

const HAL_PACKAGE_DIR = join(repoRoot, "packages", "hal");

const OS_FRAMEWORK_IMPORT = /^\s*import\s+(AppKit|AVFoundation|AVKit|Cocoa|CoreAudio|AudioToolbox|CoreFoundation|CoreGraphics|CoreImage|CoreLocation|CoreML|CoreText|CoreVideo|CreateML|Foundation|ImageIO|IOKit|Metal|MetalKit|MetalPerformanceShaders|NaturalLanguage|OpenGL|QuartzCore|SceneKit|SwiftUI|UIKit|VideoToolbox|Vision)\b/m;

const NATIVE_BINDING_PACKAGES = ["fsevents", "koffi", "ffi-napi", "ref-napi", "node-objc"];

const HAL_SCAN_EXTS = /\.(js|mjs|cjs|ts|mts|cts|tsx|jsx|swift|m|mm|h|hpp|c|cpp)$/;

/** Every source file under the workspace trees, packages/hal excluded. */
function collectHalScanFiles() {
  const roots = ["apps", "modules", "packages"];
  const out = [];
  for (const rootName of roots) {
    const root = join(repoRoot, rootName);
    if (!existsSync(root)) continue;
    const stack = [root];
    while (stack.length) {
      const dir = stack.pop();
      if (dir === HAL_PACKAGE_DIR) continue; // the HAL itself owns OS frameworks
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (entry.name === "node_modules" || entry.name.startsWith(".") || entry.name === "dist") continue;
        const file = join(dir, entry.name);
        if (entry.isDirectory()) stack.push(file);
        else if (HAL_SCAN_EXTS.test(entry.name)) out.push(file);
      }
    }
  }
  return out;
}

const halScanErrors = [];
for (const file of collectHalScanFiles()) {
  const where = rel(file);
  // Rule 3: Swift/Objective-C is OS-framework-capable source by construction;
  // native components live in the HAL (packages/hal/swift/VisionHelper.swift).
  if (/\.(swift|m|mm)$/.test(file)) {
    halScanErrors.push(`${where}: native-component source may only live inside packages/hal`);
    continue;
  }
  const text = readFileSync(file, "utf8");
  // Rule 1: a direct OS-framework import.
  const m = text.match(OS_FRAMEWORK_IMPORT);
  if (m) halScanErrors.push(`${where}: OS-framework import "${m[1]}" — go through @porchlight/hal instead`);
  // Rule 2: a native platform-binding package import (import or require).
  const importLines = text
    .split("\n")
    .filter((l) => /^\s*import\b/.test(l) || /\brequire\s*\(/.test(l));
  const importSpecifiers = importLines.flatMap((l) =>
    [...l.matchAll(/["']([^"']+)["']/g)].map((m) => m[1]),
  );
  for (const spec of importSpecifiers) {
    const s = spec[1];
    const base = s.startsWith("@") ? s.split("/").slice(0, 2).join("/") : s.split("/")[0];
    if (NATIVE_BINDING_PACKAGES.includes(base)) {
      halScanErrors.push(`${where}: native platform binding "${base}" — go through @porchlight/hal instead`);
    }
  }
}
errors.push(...halScanErrors.map((e) => `hal isolation (PORCH-132 ac-2): ${e}`));

if (errors.length) {
  console.error("\nREPOSITORY BOUNDARY VIOLATION:\n");
  for (const e of errors) console.error("  \u2717 " + e);
  console.error(
    "\nidentity and social MUST own their models separately and never import each other's internals.",
  );
  if (halScanErrors.length) {
    console.error(
      "\nOS frameworks and native bindings are importable ONLY inside packages/hal (PORCH-132 ac-2).",
    );
  }
  process.exit(1);
}

console.log(
  "boundary check passed: no cross-module imports or shared models; HAL isolation clean (no OS-framework usage outside packages/hal)",
);
