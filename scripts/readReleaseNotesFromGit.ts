/**
 * Parse release notes from `git log -1` for embedding at Vite build time.
 *
 * Commit message shape (from `scripts/release-commit.sh`):
 *   Subject: <version only>, e.g. `0.6.0-alpha.3`
 *   Body:
 *     [Summary]
 *     Short text for the main menu card (plain in UI).
 *
 *     [Changes]
 *     Full changelog — GFM Markdown for the modal (trusted / maintainer-only).
 */

import { execSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";

function parseCommitBody(fullMessage: string): {
  summary: string;
  changesMd: string;
} {
  const s = fullMessage.replace(/\r\n/g, "\n");
  const sumTag = "[Summary]";
  const chTag = "[Changes]";
  const iSum = s.indexOf(sumTag);
  const iCh = s.indexOf(chTag);
  if (iSum === -1 || iCh === -1 || iCh <= iSum) {
    return { summary: "", changesMd: "" };
  }
  const summary = s.slice(iSum + sumTag.length, iCh).trim();
  const changesMd = s.slice(iCh + chTag.length).trim();
  return { summary, changesMd };
}

export function readReleaseNotesFromGit(repoRoot: string): {
  summary: string;
  changesMd: string;
} {
  const gitDir = path.join(repoRoot, ".git");
  if (!existsSync(gitDir)) {
    return { summary: "", changesMd: "" };
  }
  let msg = "";
  try {
    msg = execSync("git log -1 --format=%B", {
      cwd: repoRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch {
    return { summary: "", changesMd: "" };
  }
  return parseCommitBody(msg);
}
