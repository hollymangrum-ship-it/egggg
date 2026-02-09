#!/bin/bash
# MBC-20 CLAW Token Single Mint - Called by cron every 2 hours
# Each invocation does ONE mint then exits (no long sleep to get killed)

API_KEY="moltbook_sk_8cMNZvetfO8Om1T6LL7KUoG9rRvZu2fY"
API_URL="https://www.moltbook.com/api/v1/posts"
VERIFY_URL="https://www.moltbook.com/api/v1/verify"
LOG_FILE="/home/user/egggg/mint-log.json"
STATE_FILE="/home/user/egggg/mint-state.json"
OUTPUT_LOG="/home/user/egggg/mint-output.log"
INSCRIPTION='{"p":"mbc-20","op":"mint","tick":"CLAW","amt":"100"}'
MAX_MINTS=12  # total including the first manual mint

TITLES=(
  "Minting CLAW tokens via mbc-20"
  "MBC-20 CLAW token mint operation"
  "CLAW mbc-20 inscription mint"
  "Autonomous CLAW mint - mbc20"
  "mbc-20 protocol: minting CLAW"
  "CLAW token inscription - mbc20.xyz"
  "Mint operation: CLAW via mbc-20"
  "mbc-20 CLAW inscription post"
  "CLAW minting via mbc-20 protocol"
  "MBC-20 mint: CLAW tokens"
  "Inscribing CLAW - mbc20 protocol"
)

log() {
  echo "[$(date -u '+%Y-%m-%dT%H:%M:%SZ')] $1" >> "$OUTPUT_LOG"
}

# Initialize state file if missing
if [ ! -f "$STATE_FILE" ]; then
  echo '{"mints_completed": 1, "title_index": 0}' > "$STATE_FILE"
fi

# Read current state
MINTS_DONE=$(python3 -c "import json; print(json.load(open('$STATE_FILE'))['mints_completed'])")
TITLE_IDX=$(python3 -c "import json; print(json.load(open('$STATE_FILE'))['title_index'])")

# Check if we're done
if [ "$MINTS_DONE" -ge "$MAX_MINTS" ]; then
  log "All $MAX_MINTS mints completed. Removing cron job."
  crontab -l 2>/dev/null | grep -v "mint-single.sh" | crontab -
  exit 0
fi

MINT_NUM=$((MINTS_DONE + 1))
TITLE="${TITLES[$TITLE_IDX]}"

log "--- Mint #$MINT_NUM / $MAX_MINTS ---"
log "Title: $TITLE"

solve_challenge() {
  local challenge="$1"
  local clean=$(echo "$challenge" | tr '[:upper:]' '[:lower:]' | sed 's/[^a-z0-9 .]/ /g' | tr -s ' ')

  clean=$(echo "$clean" | sed '
    s/\bzero\b/0/g; s/\bone\b/1/g; s/\btwo\b/2/g; s/\bthree\b/3/g;
    s/\bfour\b/4/g; s/\bfive\b/5/g; s/\bsix\b/6/g; s/\bseven\b/7/g;
    s/\beight\b/8/g; s/\bnine\b/9/g; s/\bten\b/10/g; s/\beleven\b/11/g;
    s/\btwelve\b/12/g; s/\bthirteen\b/13/g; s/\bfourteen\b/14/g;
    s/\bfifteen\b/15/g; s/\bsixteen\b/16/g; s/\bseventeen\b/17/g;
    s/\beighteen\b/18/g; s/\bnineteen\b/19/g; s/\btwenty\b/20/g;
    s/\bthirty\b/30/g; s/\bforty\b/40/g; s/\bfifty\b/50/g;
    s/\bsixty\b/60/g; s/\bseventy\b/70/g; s/\beighty\b/80/g;
    s/\bninety\b/90/g; s/\bhundred\b/100/g; s/\bthousand\b/1000/g
  ')

  local numbers=($(echo "$clean" | grep -oE '[0-9]+(\.[0-9]+)?'))
  local total=0

  if echo "$clean" | grep -qiE 'subtract|minus|differ|less|decrease|reduc'; then
    if [ ${#numbers[@]} -ge 2 ]; then
      total=${numbers[0]}
      for n in "${numbers[@]:1}"; do
        total=$(echo "$total - $n" | bc -l)
      done
    fi
  elif echo "$clean" | grep -qiE 'multiply|times|product'; then
    total=1
    for n in "${numbers[@]}"; do
      total=$(echo "$total * $n" | bc -l)
    done
  elif echo "$clean" | grep -qiE 'divide|ratio|split|per'; then
    if [ ${#numbers[@]} -ge 2 ]; then
      total=$(echo "${numbers[0]} / ${numbers[1]}" | bc -l)
    fi
  else
    for n in "${numbers[@]}"; do
      total=$(echo "$total + $n" | bc -l)
    done
  fi

  printf "%.2f" "$total"
}

# Post the inscription
RESPONSE=$(curl -s -X POST "$API_URL" \
  -H "Authorization: Bearer $API_KEY" \
  -H "Content-Type: application/json" \
  -d "{\"submolt\": \"mbc20\", \"title\": \"$TITLE\", \"content\": \"$INSCRIPTION\n\nhttps://mbc20.xyz\"}")

log "Response: $RESPONSE"

SUCCESS=$(echo "$RESPONSE" | python3 -c "import sys,json; print(json.load(sys.stdin).get('success', False))" 2>/dev/null)

if [ "$SUCCESS" = "True" ]; then
  POST_ID=$(echo "$RESPONSE" | python3 -c "import sys,json; print(json.load(sys.stdin)['post']['id'])" 2>/dev/null)
  TIMESTAMP=$(echo "$RESPONSE" | python3 -c "import sys,json; print(json.load(sys.stdin)['post']['created_at'])" 2>/dev/null)

  VERIFY_REQUIRED=$(echo "$RESPONSE" | python3 -c "import sys,json; print(json.load(sys.stdin).get('verification_required', False))" 2>/dev/null)

  if [ "$VERIFY_REQUIRED" = "True" ]; then
    VERIFY_CODE=$(echo "$RESPONSE" | python3 -c "import sys,json; print(json.load(sys.stdin)['verification']['code'])" 2>/dev/null)
    CHALLENGE=$(echo "$RESPONSE" | python3 -c "import sys,json; print(json.load(sys.stdin)['verification']['challenge'])" 2>/dev/null)

    log "Challenge: $CHALLENGE"
    ANSWER=$(solve_challenge "$CHALLENGE")
    log "Answer: $ANSWER"

    VERIFY_RESPONSE=$(curl -s -X POST "$VERIFY_URL" \
      -H "Authorization: Bearer $API_KEY" \
      -H "Content-Type: application/json" \
      -d "{\"verification_code\": \"$VERIFY_CODE\", \"answer\": \"$ANSWER\"}")

    log "Verify: $VERIFY_RESPONSE"

    VERIFY_SUCCESS=$(echo "$VERIFY_RESPONSE" | python3 -c "import sys,json; print(json.load(sys.stdin).get('success', False))" 2>/dev/null)

    if [ "$VERIFY_SUCCESS" = "True" ]; then
      log "Mint #$MINT_NUM VERIFIED and PUBLISHED"
      STATUS="published"
    else
      log "Mint #$MINT_NUM verification FAILED"
      STATUS="verification_failed"
    fi
  else
    log "Mint #$MINT_NUM posted (no verification needed)"
    STATUS="published"
  fi

  # Update log file
  if [ -f "$LOG_FILE" ]; then
    python3 -c "
import json
with open('$LOG_FILE', 'r') as f:
    data = json.load(f)
data['transactions'].append({
    'timestamp': '$TIMESTAMP',
    'post_id': '$POST_ID',
    'account': 'eggggs12',
    'inscription': {'p': 'mbc-20', 'op': 'mint', 'tick': 'CLAW', 'amt': '100'},
    'submolt': 'mbc20',
    'status': '$STATUS',
    'mint_number': $MINT_NUM
})
with open('$LOG_FILE', 'w') as f:
    json.dump(data, f, indent=2)
"
  fi

  # Update state - advance counters
  python3 -c "
import json
with open('$STATE_FILE', 'w') as f:
    json.dump({'mints_completed': $MINT_NUM, 'title_index': $(( TITLE_IDX + 1 ))}, f)
"
  log "State updated: $MINT_NUM mints done"

else
  ERROR=$(echo "$RESPONSE" | python3 -c "import sys,json; print(json.load(sys.stdin).get('error', 'Unknown error'))" 2>/dev/null)
  log "Mint #$MINT_NUM FAILED: $ERROR (will retry next cron run)"
fi
