import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "espree";

const webRoot = fileURLToPath(new URL("../", import.meta.url));
const forbiddenCopy = /\b(?:password|email|log[ -]?in|sign[ -]?in|passkey|key|did|crypto|recover)\b/i;
const forbiddenRoutes = /\b(?:password|email)\b/i;
const source = await readFile(join(webRoot, "src/identity.jsx"), "utf8");
const tree = parse(source, { ecmaVersion: "latest", sourceType: "module", ecmaFeatures: { jsx: true }, loc: true });
const failures = [];
function visit(node) {
  if (!node || typeof node !== "object") return;
  if (node.type === "JSXText" && forbiddenCopy.test(node.value)) failures.push(`identity.jsx:${node.loc.start.line}: member text`);
  if (node.type === "Literal" && typeof node.value === "string" && forbiddenCopy.test(node.value)) {
    // AST literals used solely as data keys/technical identifiers are not copy.
    if (/\s/.test(node.value) || /^(?:password|email|key|did|crypto|recover)$/i.test(node.value)) {
      failures.push(`identity.jsx:${node.loc.start.line}: member-facing string`);
    }
  }
  for (const value of Object.values(node)) {
    if (Array.isArray(value)) value.forEach(visit);
    else if (value && typeof value === "object" && typeof value.type === "string") visit(value);
  }
}
visit(tree);
for (const name of await readdir(join(webRoot, "src"))) {
  if (!/\.(?:js|jsx)$/.test(name)) continue;
  const text = await readFile(join(webRoot, "src", name), "utf8");
  if (forbiddenRoutes.test(text)) failures.push(`src/${name}: forbidden route or source text`);
}
if (process.argv.includes("--bundle")) {
  // The app chunk carries every member-facing string and route; vendor chunks
  // hold library internals (MUI input-type maps) that never render as routes.
  const assets = join(webRoot, "dist/assets");
  for (const name of await readdir(assets)) {
    if (!name.endsWith(".js") || name.startsWith("vendor-")) continue;
    const text = await readFile(join(assets, name), "utf8");
    if (forbiddenRoutes.test(text)) failures.push(`dist/assets/${name}: forbidden bundle text`);
  }
}
// (failures from the copy/route pass and the brand pass report together below.)

// Brand audit (PORCH-032): the SPA carries the new lamp mark everywhere a
// browser or home screen renders it, and no stale brand survives anywhere
// in the source tree.
const publicDir = join(webRoot, "public");
const assets = {
  "icon-16.png": [16, 16],
  "icon-32.png": [32, 32],
  "icon-48.png": [48, 48],
  "icon-192.png": [192, 192],
  "icon-512.png": [512, 512],
  "maskable-192.png": [192, 192],
  "maskable-512.png": [512, 512],
  "apple-touch-icon.png": [180, 180],
  "lamp-mark.png": [112, 106],
};
for (const [name, [width, height]] of Object.entries(assets)) {
  const path = join(publicDir, name);
  try {
    const png = await readFile(path);
    // PNG IHDR: width at byte 16, height at byte 20, both big-endian.
    const actual = [png.readUInt32BE(16), png.readUInt32BE(20)];
    if (actual[0] !== width || actual[1] !== height) failures.push(`public/${name}: is ${actual[0]}x${actual[1]}, expected ${width}x${height}`);
  } catch {
    failures.push(`public/${name}: missing brand asset`);
  }
}

const indexHtml = await readFile(join(webRoot, "index.html"), "utf8");
const expectedLinks = [
  [/"\/icon-16\.png"/, 'sizes="16x16"'],
  [/"\/icon-32\.png"/, 'sizes="32x32"'],
  [/"\/icon-48\.png"/, 'sizes="48x48"'],
  [/"\/apple-touch-icon\.png"/, 'sizes="180x180"'],
  [/"\/manifest\.webmanifest"/, 'rel="manifest"'],
];
for (const [asset, attribute] of expectedLinks) {
  const line = indexHtml.split("\n").find((line) => asset.test(line));
  if (!line || !line.includes(attribute)) failures.push(`index.html: no ${attribute} declaration for ${asset.source.slice(1)}`);
}

try {
  const manifest = JSON.parse(await readFile(join(publicDir, "manifest.webmanifest"), "utf8"));
  const purposes = manifest.icons ?? [];
  const missing = [
    ["any", "192x192"], ["any", "512x512"], ["maskable", "192x192"], ["maskable", "512x512"],
  ].filter(([purpose, size]) => !purposes.some((icon) => (icon.purpose ?? "any").split(/\s+/).includes(purpose) && icon.sizes === size));
  for (const [purpose, size] of missing) failures.push(`manifest.webmanifest: no ${purpose} icon at ${size}`);
} catch (cause) {
  failures.push(`manifest.webmanifest: unreadable (${cause.message})`);
}

const staleBrand = /\u2600|favicon\.ico/; // the retired sun glyph and dead default references
for (const name of await readdir(join(webRoot, "src"))) {
  if (!/\.(?:js|jsx)$/.test(name)) continue;
  const text = await readFile(join(webRoot, "src", name), "utf8");
  if (staleBrand.test(text)) failures.push(`src/${name}: stale brand reference (retired mark or dead favicon default)`);
}

if (failures.length) {
  console.error(failures.join("\n"));
  process.exitCode = 1;
} else console.log("Porchlight member copy, route, and brand audit passed.");
