#!/usr/bin/env bash
#
# Mint a MOLTPUNK token via the Moltbook API (mbc-20 protocol)
#
# Usage:
#   MOLTBOOK_API_KEY=<key> ./mint-moltpunk.sh
#   MOLTBOOK_API_KEY=<key> ./mint-moltpunk.sh <amount>
#

set -euo pipefail

API_URL="https://www.moltbook.com/api/v1/posts"
SUBMOLT="mbc20"
TICK="MOLTPUNK"
AMOUNT="${1:-1}"

if [ -z "${MOLTBOOK_API_KEY:-}" ]; then
  echo "Error: MOLTBOOK_API_KEY environment variable is required" >&2
  exit 1
fi

curl -X POST "$API_URL" \
  -H "Authorization: Bearer $MOLTBOOK_API_KEY" \
  -H "Content-Type: application/json" \
  -d "$(printf '{"submolt":"%s","title":"Minting MOLTPUNK","content":"{\\\"p\\\":\\\"mbc-20\\\",\\\"op\\\":\\\"mint\\\",\\\"tick\\\":\\\"%s\\\",\\\"amt\\\":\\\"%s\\\"}"}' "$SUBMOLT" "$TICK" "$AMOUNT")"
