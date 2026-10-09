import { defineConfig } from "vite";

export default defineConfig({
  base: "/",
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
