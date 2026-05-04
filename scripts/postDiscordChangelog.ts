/**
 * POST the latest git release notes to Discord (CI or local).
 * Requires DISCORD_WEBHOOK_URL_CHANGELOG. Skips when [Changes] is empty after trim.
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
  if (changesTrim.length === 0) {
    console.log("skip: empty [Changes] from git");
    process.exit(0);
  }

  const embeds = buildChangelogDiscordEmbeds({
    version: pkg.version,
    summaryPlain: summary,
    changesMd,
    headerImageUrl: envStr("DISCORD_CHANGELOG_HEADER_IMAGE_URL"),
    mainEmbedImageUrl: envStr("DISCORD_CHANGELOG_MAIN_EMBED_IMAGE_URL"),
    footerImageUrl: envStr("DISCORD_CHANGELOG_FOOTER_IMAGE_URL"),
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
