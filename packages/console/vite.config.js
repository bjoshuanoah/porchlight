import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

const consoleRoot = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig({
  base: "/",
  root: consoleRoot,
  publicDir: false,
  build: {
    outDir: "dist",
    emptyOutDir: true,
    // MUI + react ride one vendor chunk so app code stays the small chunk.
    rollupOptions: {
      output: { manualChunks: (id) => (id.includes("node_modules") ? "vendor" : undefined) },
    },
  },
  server: {
    // Same-origin engine paths: /api proxies to the config plane, and the
    // engine seams (/live streams, /service + /storage health rows) need
    // the same treatment in dev; production serves the SPA from the engine
    // itself, so nothing here ships.
    proxy: {
      "/api": "http://127.0.0.1:3000",
      "/live": "http://127.0.0.1:3000",
      "/cameras": "http://127.0.0.1:3000",
      "/service": "http://127.0.0.1:3000",
      "/storage": "http://127.0.0.1:3000",
    },
  },
});
