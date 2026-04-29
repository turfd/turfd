#!/usr/bin/env bash
# Double-click this file in Finder — macOS runs .command scripts in Terminal.
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
bash "$SCRIPT_DIR/crossover-quit-notify.sh"
echo
read -r -p "Press Enter to close this window..."
