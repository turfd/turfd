import { readFileSync } from "node:fs";
import path from "node:path";
import type { Plugin } from "vite";
import { defineConfig } from "vite";

const pkg = JSON.parse(
  readFileSync(path.resolve(__dirname, "package.json"), "utf-8"),
) as { version: string };

/** Unique per `vite build`; compared to `build.json` fetched with cache-bypass (stale-tab / CDN HTML cache). */
const buildId = `${pkg.version}-${Date.now()}`;

function emitBuildJsonPlugin(): Plugin {
  return {
    name: "stratum-emit-build-json",
    generateBundle() {
      const source = JSON.stringify({ buildId } satisfies { buildId: string });
      this.emitFile({
        type: "asset",
        fileName: "build.json",
        source,
      });
    },
  };
}

export default defineConfig({
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
    __BUILD_ID__: JSON.stringify(buildId),
  },
  plugins: [emitBuildJsonPlugin()],
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
