import path from "node:path";
import { defineConfig } from "vite";

export default defineConfig({
  base: "/stratum/",
  // Same origin every dev session so IndexedDB ("stratum" worlds) stays on one database.
  // If 5173 is in use, fail fast instead of binding 5174+ (different origin = empty saves).
  server: {
    port: 5173,
    strictPort: true,
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "src"),
    },
  },
});
