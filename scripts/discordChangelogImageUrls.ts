/**
 * Discord changelog embed images — source of truth in git.
 *
 * - **headerImageUrl** — first embed: image only (banner).
 * - **mainEmbedImageUrl** — second embed (bottom): large image; `[Summary]` / `[Changes]` are sent as
 *   Discord markdown on the **same** embed (`description` under the image) unless **`omitTextOnMainImageEmbed`**.
 * - **footerImageUrl** — optional third image-only embed after the bottom card (usually empty).
 *
 * CI and the `/stratum/update` preview read only this file (no env overrides).
 */

export type DiscordChangelogImageUrlsCommitted = {
  headerImageUrl: string;
  mainEmbedImageUrl: string;
  footerImageUrl: string;
  /** If true, bottom embed is image-only (no `title` / `description`). */
  omitTextOnMainImageEmbed?: boolean;
};

export const DISCORD_CHANGELOG_IMAGE_URLS_COMMITTED: DiscordChangelogImageUrlsCommitted = {
  headerImageUrl: "https://i.imgur.com/BFlIcA9.png",
  mainEmbedImageUrl: "https://i.imgur.com/S3afxkt.png",
  footerImageUrl: "",
};

/** Non-empty trimmed string, or `undefined` for the embed builder / webhook. */
export function trimImageUrl(committed: string): string | undefined {
  const t = committed.trim();
  return t.length > 0 ? t : undefined;
}
