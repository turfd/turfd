import { readFileSync } from "node:fs";
import path from "node:path";
import { parse as parseJsonc } from "jsonc-parser";
import type { Plugin } from "vite";
import { defineConfig, loadEnv } from "vite";
import { repoHasGit, updateToolDevPlugin } from "./tools/release/updateToolDevPlugin";
import {
  DISCORD_CHANGELOG_IMAGE_URLS_COMMITTED,
  trimImageUrl,
} from "./scripts/discordChangelogImageUrls";
import { readReleaseNotesFromGit } from "./scripts/readReleaseNotesFromGit";

const pkg = JSON.parse(
  readFileSync(path.resolve(__dirname, "package.json"), "utf-8"),
) as { version: string };

const { summary: releaseSummary, changesMd: releaseChangesMd } =
  readReleaseNotesFromGit(__dirname);

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

function devModeFromEnv(env: Record<string, string>): boolean {
  const v = (env.DEV_MODE ?? "").trim().toUpperCase();
  return v === "TRUE" || v === "1" || v === "YES";
}

export default defineConfig(({ mode }) => {
  const root = __dirname;
  const env = loadEnv(mode, root, "");
  const devPlugins: Plugin[] = [];
  if (repoHasGit(root)) {
    const img = DISCORD_CHANGELOG_IMAGE_URLS_COMMITTED;
    devPlugins.push(
      updateToolDevPlugin({
        toolToken: env.STRATUM_UPDATE_TOOL_TOKEN,
        discordChangelogHeaderImageUrl: trimImageUrl(img.headerImageUrl),
        discordChangelogMainEmbedImageUrl: trimImageUrl(img.mainEmbedImageUrl),
        discordChangelogFooterImageUrl: trimImageUrl(img.footerImageUrl),
        discordChangelogEmbedColor: env.DISCORD_CHANGELOG_EMBED_COLOR,
      }),
    );
  }
  return {
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
    __BUILD_ID__: JSON.stringify(buildId),
    __RELEASE_SUMMARY__: JSON.stringify(releaseSummary),
    __RELEASE_CHANGES_MD__: JSON.stringify(releaseChangesMd),
    __DEV_MODE__: JSON.stringify(devModeFromEnv(env)),
  },
  plugins: [...devPlugins, modPackJsoncPlugin(), emitBuildJsonPlugin()],
  base: "/stratum/",
  // Console spam guard: keep source maps off so browsers/extensions don't try to
  // fetch original `.ts` sources in runtime environments that don't serve them.
  esbuild: {
    sourcemap: false,
  },
  css: {
    devSourcemap: false,
  },
  optimizeDeps: {
    esbuildOptions: {
      sourcemap: false,
    },
  },
  build: {
    sourcemap: false,
  },
  // Same origin every dev session so IndexedDB ("stratum" worlds) stays on one database.
  // If 5173 is in use, fail fast instead of binding 5174+ (different origin = empty saves).
  server: {
    port: 5173,
    strictPort: true,
    // Dev-only: avoid HTTP caching of transformed modules / `.vite/deps` so a tab does not keep
    // import URLs from before `optimizeDeps` re-ran (browser sees 504 Outdated Optimize Dep →
    // "Failed to fetch dynamically imported module" for e.g. Pixi WebGL chunks).
    headers: { "Cache-Control": "no-store" },
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "src"),
    },
  },
};
});
