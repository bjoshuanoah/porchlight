import { access, cp, rm } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const webDist = fileURLToPath(new URL("../../web/dist/", import.meta.url));
const serverWebDist = fileURLToPath(new URL("../dist/web/", import.meta.url));

// Fail the release build rather than publishing an API-only server.
await access(join(webDist, "index.html"));
await rm(serverWebDist, { recursive: true, force: true });
await cp(webDist, serverWebDist, { recursive: true });
