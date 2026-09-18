#!/usr/bin/env bash
# Extract your FreeBuff API token after a normal `freebuff` login.
#
# Flow:
#   1. npm install -g freebuff
#   2. freebuff          # approve the device login in your browser at freebuff.com
#   3. ./extract-freebuff-token.sh   # prints the token + export line
#
# The token lives in ~/.config/manicode/credentials.json
# (JSON path: .default.authToken, fallback: .authToken)
set -euo pipefail

CRED="$HOME/.config/manicode/credentials.json"

if [ ! -f "$CRED" ]; then
  echo "❌ No credentials file at $CRED" >&2
  echo "   Run 'freebuff' once and approve the browser login first." >&2
  exit 1
fi

TOKEN="$(python3 -c "
import json,sys
d=json.load(open('$CRED'))
print(d.get('default',{}).get('authToken') or d.get('authToken') or '')
" 2>/dev/null || node -e "
const d=require('$CRED');
console.log((d.default&&d.default.authToken)||d.authToken||'');
")"

if [ -z "$TOKEN" ]; then
  echo "❌ Could not find authToken in $CRED" >&2
  exit 1
fi

MASKED="${TOKEN:0:4}…${TOKEN: -4}"
echo "✅ Found token ($MASKED), length ${#TOKEN}"
echo
echo "Add to your shell / .env:"
echo "  export FREEBUFF_TOKEN=\"$TOKEN\""
echo
echo "Multi-account concurrency (optional):"
echo "  export FREEBUFF_TOKEN=\"token_a,token_b,token_c\""
