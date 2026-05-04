/// <reference types="vite/client" />

declare const __APP_VERSION__: string;
declare const __BUILD_ID__: string;
/** Parsed from HEAD commit body at `vite build` (`[Summary]` / `[Changes]`). */
declare const __RELEASE_SUMMARY__: string;
declare const __RELEASE_CHANGES_MD__: string;
/** Settings → Debug (profiler) when `DEV_MODE=TRUE` in env at build time (see `vite.config.ts`). */
declare const __DEV_MODE__: boolean;

interface ImportMetaEnv {
  readonly VITE_SUPABASE_URL?: string;
  readonly VITE_SUPABASE_ANON_KEY?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
