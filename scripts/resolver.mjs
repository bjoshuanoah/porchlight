// ESM resolve hook: when a `.js` import is not found, fall back to the
// matching `.ts` source. Lets TypeScript sources use Node-native ESM
// `--experimental-strip-types` without a prebuild step. Register via
// `node --import ./scripts/register.mjs` (or --loader ./scripts/resolver.mjs).
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export async function resolve(specifier, context, nextResolve) {
  if (specifier.startsWith(".") && specifier.endsWith(".js")) {
    const base = specifier.slice(0, -3);
    const parentDir = dirname(fileURLToPath(context.parentURL));
    const candidate = join(parentDir, base + ".ts");
    if (existsSync(candidate)) {
      return nextResolve(pathToFileURL(candidate).href, context);
    }
  }
  return nextResolve(specifier, context);
}
