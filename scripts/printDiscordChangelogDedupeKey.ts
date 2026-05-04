/**
 * Print a stable dedupe key for Discord changelog posts (GitHub Actions cache).
 * Usage: npx tsx scripts/printDiscordChangelogDedupeKey.ts [repoRoot]
 * Prints hex sha256 to stdout (single line).
 */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

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

const root = repoRootFromArgs();
const pkg = JSON.parse(
  readFileSync(path.join(root, "package.json"), "utf-8"),
) as { version: string };
const { summary, changesMd } = readReleaseNotesFromGit(root);
const sumN = normalizeReleaseTypography(summary.trim());
const chN = normalizeReleaseTypography(changesMd.trim());
const buster = (process.env.DISCORD_CHANGELOG_DEDUPE_BUSTER ?? "").trim();
const h = createHash("sha256")
  .update(`${pkg.version}\n${sumN}\n${chN}\n${buster}`, "utf8")
  .digest("hex");
process.stdout.write(`${h}\n`);
