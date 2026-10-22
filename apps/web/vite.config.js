import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

const webRoot = fileURLToPath(new URL(".", import.meta.url));

// Update detection and refresh flow (PORCH-125, Brian, Oct 22, 2026): the
// build stamps ONE shell version per build — a build-epoch number — into
// both the app bundle (the shell's own marker, via the __PORCHLIGHT_BUILD__
// define) and dist/sw.js (the waiting-worker version check, replacing the
// placeholder in the copied worker). A newer hub build ships a newer stamp:
// the worker's versioned shell cache name is the version check, and the
// stamp comparison is the marker read at cold-open boot.
const shellStamp = String(Date.now());

/** Rewrites the shell-version placeholder in the built worker (copy-only file). */
function shellVersionStamp() {
  return {
    name: "porchlight-shell-version-stamp",
    apply: "build",
    async closeBundle() {
      const workerPath = join(webRoot, "dist", "sw.js");
      const script = await readFile(workerPath, "utf8");
      const stamped = script.replaceAll("__PORCHLIGHT_SHELL_VERSION__", shellStamp);
      if (stamped === script) throw new Error("dist/sw.js carries no shell-version placeholder — the stamp plugin found nothing to rewrite.");
      await writeFile(workerPath, stamped);
    },
  };
}

export default defineConfig({
  base: "/",
  define: { __PORCHLIGHT_BUILD__: JSON.stringify(shellStamp) },
  plugins: [shellVersionStamp()],
  build: {
    outDir: "dist",
    emptyOutDir: true,
    // unicode-emoji-json (the reaction picker's Unicode catalog, PORCH-036)
    // stays out of the eager vendor chunk: it rides the lazily imported
    // emoji-picker chunk and loads only when a member first opens a picker.
    rollupOptions: { output: { manualChunks: (id) => (id.includes("node_modules") && !id.includes("unicode-emoji-json")) ? "vendor" : undefined } },
  },
  server: { proxy: { "/api": "http://127.0.0.1:3000", "/bootstrap": "http://127.0.0.1:3000" } },
});