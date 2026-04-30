#!/usr/bin/env bash
#
# Stratum release commit helper (macOS / bash).
# Alternative: with `npm run dev`, use http://localhost:5173/stratum/update (same commit layout).
#
# Flow:
#   1. Choose version bump (semver + alpha/beta/release lane).
#   2. Paste SUMMARY — short text for the main menu card (plain text in-game).
#   3. Paste FULL CHANGELOG — Markdown for the "Read more" modal.
#   4. Script combines them and inserts [Summary] / [Changes] tags so Vite + the
#      main menu can parse the commit (see scripts/readReleaseNotesFromGit.ts).
#   5. Subject line is ONLY the new version (e.g. 0.6.0-alpha.3).
#
# After confirming the preview, package.json is bumped, then git add -A and commit.
#
# Paste help: end each paste with a line containing EXACTLY this (nothing else):
#   ###STRATUM_END###
#
# Optional tag after push: git tag "v$(node -p \"require('./package.json').version\")" && git push origin --tags
#
set -euo pipefail

DELIM='###STRATUM_END###'

# Reads stdin until a line equals delimiter (delimiter line not included). Prints accumulated text.
read_paste_until() {
  local delim=$1
  local line
  local acc=
  while IFS= read -r line || [[ -n "$line" ]]; do
    line="${line%$'\r'}"
    if [[ "$line" == "$delim" ]]; then
      printf '%s' "$acc"
      return 0
    fi
    acc+="${line}"$'\n'
  done
  printf '%s' "$acc"
}

ROOT="$(git rev-parse --show-toplevel 2>/dev/null)" || {
  echo "Not inside a git repository."
  exit 1
}
cd "$ROOT"

CUR="$(node -e "console.log(JSON.parse(require('fs').readFileSync('package.json','utf8')).version)")"
echo "Current version: $CUR"
echo ""

echo "Bump (semver intent):"
select bump in "prerelease (same X.Y.Z line)" "patch" "minor" "major"; do
  case $REPLY in
    1) BUMP="prerelease" ;;
    2) BUMP="patch" ;;
    3) BUMP="minor" ;;
    4) BUMP="major" ;;
    *) echo "Invalid"; continue ;;
  esac
  break
done

echo ""
echo "Prerelease lane:"
select lane in "alpha" "beta" "release (stable, no -alpha/-beta)"; do
  case $REPLY in
    1) LANE="alpha" ;;
    2) LANE="beta" ;;
    3) LANE="release" ;;
    *) echo "Invalid"; continue ;;
  esac
  break
done

NEXT="$(node scripts/release-version.mjs "$CUR" "$BUMP" "$LANE")"
echo ""
echo "Next version will be: $NEXT"
read -r -p "Continue to release notes? [y/N] " ok
if [[ "$ok" != "y" && "$ok" != "Y" ]]; then
  echo "Aborted."
  exit 1
fi

echo ""
echo "═══════════════════════════════════════════════════════════════════"
echo "  STEP 1 OF 2 — SUMMARY (main menu What's New card)"
echo "═══════════════════════════════════════════════════════════════════"
echo "Short player-facing blurb (1–3 sentences). Plain text in the game — no Markdown here."
echo "Paste below, then on its own line type exactly:"
echo "  ${DELIM}"
echo ""
SUMMARY_RAW="$(read_paste_until "$DELIM")"
SUMMARY="$(printf '%s' "$SUMMARY_RAW" | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//')"

if [[ -z "${SUMMARY//[$' \t\r\n']/}" ]]; then
  echo "Error: summary is empty after trim."
  exit 1
fi

echo ""
echo "═══════════════════════════════════════════════════════════════════"
echo '  STEP 2 OF 2 — FULL CHANGELOG ("Read more" modal)'
echo "═══════════════════════════════════════════════════════════════════"
echo "Full notes: Markdown (headings, lists, tables, code fences, links, etc.)."
echo "Paste below, then on its own line type exactly:"
echo "  ${DELIM}"
echo ""
CHANGES_RAW="$(read_paste_until "$DELIM")"
CHANGES="$(printf '%s' "$CHANGES_RAW" | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//')"

if [[ -z "${CHANGES//[$' \t\r\n']/}" ]]; then
  echo 'Warning: changelog is empty. The in-game "Read more" modal will show the empty state.'
  read -r -p "Continue anyway? [y/N] " ok_empty
  if [[ "$ok_empty" != "y" && "$ok_empty" != "Y" ]]; then
    echo "Aborted."
    exit 1
  fi
fi

COMMIT_FILE="$(mktemp -t stratum-release-commit)"
cleanup() { rm -f "$COMMIT_FILE"; }
trap cleanup EXIT

# Commit format consumed by the game (Vite reads HEAD %B and parses these tags):
#   <version>
#
#   [Summary]
#   ...
#
#   [Changes]
#   ...
{
  printf '%s\n\n' "$NEXT"
  printf '[Summary]\n%s\n\n' "$SUMMARY"
  printf '[Changes]\n%s\n' "$CHANGES"
} >"$COMMIT_FILE"

echo ""
echo "────────────────────────── COMMIT PREVIEW ──────────────────────────"
echo "(Subject = first line.  Body = what Stratum parses for the menu + modal.)"
echo "────────────────────────────────────────────────────────────────────"
cat "$COMMIT_FILE"
echo "────────────────────────────────────────────────────────────────────"
read -r -p "Bump version to ${NEXT} and create this commit? [y/N] " ok_preview
if [[ "$ok_preview" != "y" && "$ok_preview" != "Y" ]]; then
  echo "Aborted (no files were modified)."
  exit 1
fi

npm version "$NEXT" --no-git-tag-version

echo ""
echo "About to stage ALL changes (git add -A) and commit:"
echo "  git commit -F <message above>"
read -r -p "Proceed? [y/N] " ok2
if [[ "$ok2" != "y" && "$ok2" != "Y" ]]; then
  echo "Aborted after version bump. Revert with: git checkout -- package.json package-lock.json"
  exit 1
fi

git add -A
git commit -F "$COMMIT_FILE"

echo ""
echo "Done. Version is now $NEXT; commit subject is the version; body includes [Summary] / [Changes] for the game."
echo "Push when ready: git push"
echo "Optional tag: git tag v$NEXT && git push origin v$NEXT"
