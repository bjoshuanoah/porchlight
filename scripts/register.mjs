// Self-registering ESM resolver for Node's --experimental-strip-types.
// Usage: node --import ./scripts/register.mjs --test apps/server/test/api-contract.test.ts
import { register } from "node:module";

register("./resolver.mjs", import.meta.url);
