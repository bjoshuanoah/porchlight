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
if (failures.length) {
  console.error(failures.join("\n"));
  process.exitCode = 1;
} else console.log("Porchlight member copy and route audit passed.");
