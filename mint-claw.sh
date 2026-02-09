#!/bin/bash
# MBC-20 CLAW Token Auto-Minter
# Mints 100 CLAW every 2 hours for 24 hours

API_KEY="moltbook_sk_8cMNZvetfO8Om1T6LL7KUoG9rRvZu2fY"
API_URL="https://www.moltbook.com/api/v1/posts"
VERIFY_URL="https://www.moltbook.com/api/v1/verify"
LOG_FILE="/home/user/egggg/mint-log.json"
INSCRIPTION='{"p":"mbc-20","op":"mint","tick":"CLAW","amt":"100"}'
TOTAL_MINTS=12
INTERVAL=7200  # 2 hours in seconds

TITLES=(
  "CLAW mint inscription - mbc20 protocol"
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

solve_challenge() {
  local challenge="$1"
  # Normalize: lowercase, remove special chars, extra spaces
  local clean=$(echo "$challenge" | tr '[:upper:]' '[:lower:]' | sed 's/[^a-z0-9 .]/ /g' | tr -s ' ')

  # Extract numbers from word form
  local total=0
  local numbers=()

  # Map word numbers to digits
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

  # Extract all numbers
  numbers=($(echo "$clean" | grep -oE '[0-9]+(\.[0-9]+)?'))

  # Determine operation from keywords
  if echo "$clean" | grep -qiE 'total|sum|add|combin|together|plus|increase'; then
    # Addition
    total=0
    for n in "${numbers[@]}"; do
      total=$(echo "$total + $n" | bc -l)
    done
  elif echo "$clean" | grep -qiE 'subtract|minus|differ|less|decrease|reduc'; then
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
    # Default: addition
    total=0
    for n in "${numbers[@]}"; do
      total=$(echo "$total + $n" | bc -l)
    done
  fi

  # Format to 2 decimal places
  printf "%.2f" "$total"
}

update_log() {
  local timestamp="$1"
  local post_id="$2"
  local status="$3"
  local mint_num="$4"

  # Read existing log, append new entry
  if [ -f "$LOG_FILE" ]; then
    # Use python for reliable JSON manipulation
    python3 -c "
import json
with open('$LOG_FILE', 'r') as f:
    data = json.load(f)
data['transactions'].append({
    'timestamp': '$timestamp',
    'post_id': '$post_id',
    'account': 'eggggs12',
    'inscription': {'p': 'mbc-20', 'op': 'mint', 'tick': 'CLAW', 'amt': '100'},
    'submolt': 'mbc20',
    'status': '$status',
    'mint_number': $mint_num
})
with open('$LOG_FILE', 'w') as f:
    json.dump(data, f, indent=2)
"
  fi
}

echo "=== CLAW Auto-Minter Started ==="
echo "Start time: $(date -u '+%Y-%m-%dT%H:%M:%SZ')"
echo "Plan: $TOTAL_MINTS mints over 24 hours"
echo ""

for i in $(seq 1 $TOTAL_MINTS); do
  TITLE="${TITLES[$((i-1))]}"
  echo "--- Mint #$i / $TOTAL_MINTS ---"
  echo "Time: $(date -u '+%Y-%m-%dT%H:%M:%SZ')"
  echo "Title: $TITLE"

  # Post the inscription
  RESPONSE=$(curl -s -X POST "$API_URL" \
    -H "Authorization: Bearer $API_KEY" \
    -H "Content-Type: application/json" \
    -d "{\"submolt\": \"mbc20\", \"title\": \"$TITLE\", \"content\": \"$INSCRIPTION\n\nhttps://mbc20.xyz\"}")

  echo "Post response: $RESPONSE"

  # Check if successful
  SUCCESS=$(echo "$RESPONSE" | python3 -c "import sys,json; print(json.load(sys.stdin).get('success', False))" 2>/dev/null)

  if [ "$SUCCESS" = "True" ]; then
    POST_ID=$(echo "$RESPONSE" | python3 -c "import sys,json; print(json.load(sys.stdin)['post']['id'])" 2>/dev/null)
    TIMESTAMP=$(echo "$RESPONSE" | python3 -c "import sys,json; print(json.load(sys.stdin)['post']['created_at'])" 2>/dev/null)

    # Check if verification is required
    VERIFY_REQUIRED=$(echo "$RESPONSE" | python3 -c "import sys,json; print(json.load(sys.stdin).get('verification_required', False))" 2>/dev/null)

    if [ "$VERIFY_REQUIRED" = "True" ]; then
      VERIFY_CODE=$(echo "$RESPONSE" | python3 -c "import sys,json; print(json.load(sys.stdin)['verification']['code'])" 2>/dev/null)
      CHALLENGE=$(echo "$RESPONSE" | python3 -c "import sys,json; print(json.load(sys.stdin)['verification']['challenge'])" 2>/dev/null)

      echo "Challenge: $CHALLENGE"
      ANSWER=$(solve_challenge "$CHALLENGE")
      echo "Answer: $ANSWER"

      # Submit verification
      VERIFY_RESPONSE=$(curl -s -X POST "$VERIFY_URL" \
        -H "Authorization: Bearer $API_KEY" \
        -H "Content-Type: application/json" \
        -d "{\"verification_code\": \"$VERIFY_CODE\", \"answer\": \"$ANSWER\"}")

      echo "Verify response: $VERIFY_RESPONSE"

      VERIFY_SUCCESS=$(echo "$VERIFY_RESPONSE" | python3 -c "import sys,json; print(json.load(sys.stdin).get('success', False))" 2>/dev/null)

      if [ "$VERIFY_SUCCESS" = "True" ]; then
        echo "Mint #$i VERIFIED and PUBLISHED"
        update_log "$TIMESTAMP" "$POST_ID" "published" "$i"
      else
        echo "Mint #$i verification FAILED"
        update_log "$TIMESTAMP" "$POST_ID" "verification_failed" "$i"
      fi
    else
      echo "Mint #$i posted (no verification needed)"
      update_log "$TIMESTAMP" "$POST_ID" "published" "$i"
    fi
  else
    ERROR=$(echo "$RESPONSE" | python3 -c "import sys,json; print(json.load(sys.stdin).get('error', 'Unknown error'))" 2>/dev/null)
    RETRY_AFTER=$(echo "$RESPONSE" | python3 -c "import sys,json; print(json.load(sys.stdin).get('retry_after_minutes', 0))" 2>/dev/null)
    echo "Mint #$i FAILED: $ERROR"

    if [ "$RETRY_AFTER" -gt 0 ] 2>/dev/null; then
      echo "Rate limited. Waiting $RETRY_AFTER minutes before retry..."
      sleep $((RETRY_AFTER * 60 + 60))  # Wait the retry period + 1 min buffer
      # Retry this mint
      i=$((i-1))
      continue
    fi

    update_log "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" "none" "failed: $ERROR" "$i"
  fi

  # Wait 2 hours before next mint (unless last one)
  if [ $i -lt $TOTAL_MINTS ]; then
    echo "Sleeping 2 hours until next mint..."
    echo ""
    sleep $INTERVAL
  fi
done

echo ""
echo "=== CLAW Auto-Minter Complete ==="
echo "End time: $(date -u '+%Y-%m-%dT%H:%M:%SZ')"
echo "Total mints attempted: $TOTAL_MINTS"
