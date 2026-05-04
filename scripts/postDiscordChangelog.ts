/**
 * POST the latest git release notes to Discord (CI or local).
 * Requires DISCORD_WEBHOOK_URL_CHANGELOG. Skips when git has no release-note text and `mainEmbedImageUrl` is unset.
 *
 * Usage: npx tsx scripts/postDiscordChangelog.ts [repoRoot]
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  buildChangelogDiscordEmbeds,
  parseDiscordEmbedColor,
} from "./discordChangelogEmbeds";
import {
  DISCORD_CHANGELOG_IMAGE_URLS_COMMITTED,
  trimImageUrl,
} from "./discordChangelogImageUrls";
import { readReleaseNotesFromGit } from "./readReleaseNotesFromGit";
import { normalizeReleaseTypography } from "./releaseTypography";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function repoRootFromArgs(): string {
  const a = process.argv[2];
  if (a !== undefined && a.trim().length > 0) {
    return path.resolve(a);
  }
  return path.resolve(__dirname, "..");
}

function envStr(k: string): string | undefined {
  const v = process.env[k];
  if (v === undefined || v.trim().length === 0) {
    return undefined;
  }
  return v.trim();
}

async function main(): Promise<void> {
  const webhook = envStr("DISCORD_WEBHOOK_URL_CHANGELOG");
  if (webhook === undefined) {
    console.log("skip: DISCORD_WEBHOOK_URL_CHANGELOG is unset");
    process.exit(0);
  }

  const root = repoRootFromArgs();
  const pkg = JSON.parse(
    readFileSync(path.join(root, "package.json"), "utf-8"),
  ) as { version: string };
  const { summary, changesMd } = readReleaseNotesFromGit(root);
  const changesTrim = normalizeReleaseTypography(changesMd).trim();
  const summaryTrim = normalizeReleaseTypography(summary).trim();

  const img = DISCORD_CHANGELOG_IMAGE_URLS_COMMITTED;
  const mainImg = trimImageUrl(img.mainEmbedImageUrl);
  const hasImageOnlyBody = mainImg !== undefined;
  const hasGitText = summaryTrim.length > 0 || changesTrim.length > 0;
  if (!hasGitText && !hasImageOnlyBody) {
    console.log(
      "skip: no release-note text from git (walk failed or no [Summary] block) and mainEmbedImageUrl is unset",
    );
    process.exit(0);
  }

  const embeds = buildChangelogDiscordEmbeds({
    version: pkg.version,
    summaryPlain: summary,
    changesMd,
    headerImageUrl: trimImageUrl(img.headerImageUrl),
    mainEmbedImageUrl: mainImg,
    footerImageUrl: trimImageUrl(img.footerImageUrl),
    includeMarkdownWhenMainImageSet: img.includeMarkdownWhenMainImageSet,
    embedColor: parseDiscordEmbedColor(process.env.DISCORD_CHANGELOG_EMBED_COLOR),
  });

  const body = JSON.stringify({
    content: null,
    embeds,
    attachments: [],
  });

  const res = await fetch(webhook, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "User-Agent": "Stratum-changelog-script/1.0",
    },
    body,
  });

  if (!res.ok) {
    const t = await res.text().catch(() => "");
    throw new Error(
      `Discord webhook failed: ${res.status} ${res.statusText}${t ? ` — ${t.slice(0, 500)}` : ""}`,
    );
  }
  console.log("Discord changelog posted.");
}

void main().catch((e) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
});
