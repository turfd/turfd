#!/bin/bash
# Double-click in Finder (macOS) to run the release helper in Terminal.
# Step 1: paste summary, end with a line that is exactly ###STRATUM_END###
# Step 2: paste full changelog (Markdown), end with the same line.
# The script adds [Summary] / [Changes] and commits so the game can read HEAD.
cd "$(dirname "$0")" || exit 1
exec bash scripts/release-commit.sh
