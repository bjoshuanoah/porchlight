import { defineConfig } from "vite";

export default defineConfig({
  base: "/",
  build: {
    outDir: "dist",
    emptyOutDir: true,
    rollupOptions: { output: { manualChunks: (id) => id.includes("node_modules") ? "vendor" : undefined } },
  },
  server: { proxy: { "/api": "http://127.0.0.1:3000", "/bootstrap": "http://127.0.0.1:3000" } },
});
