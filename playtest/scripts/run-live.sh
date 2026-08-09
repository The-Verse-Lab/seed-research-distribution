#!/usr/bin/env bash
# Live playtest runner — uses the real .env gateway config (DeepSeek etc).
# Usage: run-live.sh <worldDir> <scriptFile> [transcriptName] [extra env assignments...]
set -uo pipefail
cd "$(dirname "$0")/../.." || exit 1   # repo root

WORLD="${1:?world dir}"; SCRIPT="${2:?script file}"; NAME="${3:-$(basename "$SCRIPT" .txt)}"
shift 3 2>/dev/null || shift $#
DATA="/tmp/seed-pt-live-$$-$NAME"
TRANSCRIPT="playtest/transcripts/live-$NAME.txt"

mkdir -p "$(dirname "$TRANSCRIPT")"
cat "$SCRIPT" | env SEED_DATA_DIR="$DATA" "$@" bun src/cli/main.ts "$WORLD" 2>&1 | tee "$TRANSCRIPT"

echo "--- transcript: $TRANSCRIPT ---"
rm -rf "$DATA"
