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
  server: { proxy: { "/api": "http://127.0.0.1:3000" } },
});
