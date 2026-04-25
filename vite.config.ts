import { readFileSync } from "node:fs";
import path from "node:path";
import { parse as parseJsonc } from "jsonc-parser";
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

/**
 * Core mod packs keep hand-authored JSON with comments/trailing commas.
 * Normalize these files to strict JSON before Vite's JSON plugin runs.
 */
function modPackJsoncPlugin(): Plugin {
  return {
    name: "stratum-mod-pack-jsonc",
    enforce: "pre",
    transform(code, id) {
      const cleanId = id.split("?", 1)[0] ?? id;
      if (!cleanId.endsWith(".json")) {
        return null;
      }
      const norm = cleanId.replaceAll("\\", "/");
      if (!norm.includes("/public/assets/mods/")) {
        return null;
      }
      const parsed = parseJsonc(code);
      if (parsed === undefined) {
        this.error(`Failed to parse JSONC: ${cleanId}`);
      }
      return {
        code: JSON.stringify(parsed),
        map: null,
      };
    },
  };
}

export default defineConfig({
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
    __BUILD_ID__: JSON.stringify(buildId),
  },
  plugins: [modPackJsoncPlugin(), emitBuildJsonPlugin()],
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
