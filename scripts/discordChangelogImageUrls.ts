/**
 * Discord changelog embed images — source of truth in git.
 *
 * - **headerImageUrl** — first embed: image only (banner).
 * - **mainEmbedImageUrl** — second embed: image only; use a graphic that contains the full patch notes.
 *   When this is non-empty, Discord embeds omit markdown descriptions (graphic is the body).
 * - **footerImageUrl** — optional third image-only embed after the main graphic.
 *
 * CI and the `/stratum/update` preview read only this file (no env overrides).
 */

export const DISCORD_CHANGELOG_IMAGE_URLS_COMMITTED = {
  headerImageUrl: "https://i.imgur.com/VIbjjom.png",
  mainEmbedImageUrl: "https://i.imgur.com/S3afxkt.png",
  footerImageUrl: "",
};

/** Non-empty trimmed string, or `undefined` for the embed builder / webhook. */
export function trimImageUrl(committed: string): string | undefined {
  const t = committed.trim();
  return t.length > 0 ? t : undefined;
}
