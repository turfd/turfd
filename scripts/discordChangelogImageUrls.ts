/**
 * Discord changelog embed images — source of truth in git.
 *
 * - **headerImageUrl** — first embed: image only (banner).
 * - **mainEmbedImageUrl** — second embed (bottom): image only; PNG should contain the readable patch notes.
 * - **includeMarkdownWhenMainImageSet** — optional; set `true` to also send `[Summary]` / `[Changes]` as
 *   Discord markdown after the images. Default is two image embeds only.
 * - **footerImageUrl** — optional third image-only embed after the bottom graphic (usually empty).
 *
 * CI and the `/stratum/update` preview read only this file (no env overrides).
 */

export type DiscordChangelogImageUrlsCommitted = {
  headerImageUrl: string;
  mainEmbedImageUrl: string;
  footerImageUrl: string;
  /** Opt-in: also send markdown embeds after the image stack. */
  includeMarkdownWhenMainImageSet?: boolean;
};

export const DISCORD_CHANGELOG_IMAGE_URLS_COMMITTED: DiscordChangelogImageUrlsCommitted = {
  headerImageUrl: "https://i.imgur.com/VIbjjom.png",
  mainEmbedImageUrl: "https://i.imgur.com/S3afxkt.png",
  footerImageUrl: "",
};

/** Non-empty trimmed string, or `undefined` for the embed builder / webhook. */
export function trimImageUrl(committed: string): string | undefined {
  const t = committed.trim();
  return t.length > 0 ? t : undefined;
}
