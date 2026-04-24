/**
 * Cache-bust static built assets by build id in production.
 * Keeps local dev URLs stable and does not affect IndexedDB saves.
 */
export function withBuildCacheBust(url: string): string {
  if (!import.meta.env.PROD) {
    return url;
  }
  const sep = url.includes("?") ? "&" : "?";
  return `${url}${sep}v=${encodeURIComponent(__BUILD_ID__)}`;
}
