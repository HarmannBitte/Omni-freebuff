#!/usr/bin/env bash
# Zero-spend budget probe: daily Freebucks, free windows, premium pools.
# Reads the token from the CLI credentials (written by `freebuff login`).
# Safe to run anytime — GET status never admits a session.
set -euo pipefail

CRED="$HOME/.config/manicode/credentials.json"
[ -f "$CRED" ] || { echo "❌ No $CRED — run 'freebuff login' first." >&2; exit 1; }
TOKEN="$(python3 -c "import json; print(json.load(open('$CRED'))['default']['authToken'])")"

curl -s --max-time 25 https://www.codebuff.com/api/v1/freebuff/session \
  -H "Authorization: Bearer $TOKEN" | python3 -c "
import json,sys
d=json.load(sys.stdin)
fb=d.get('freebucks',{}); day=fb.get('daily',{})
print(f\"session: {d.get('status')} | tier: {d.get('accessTier')}\")
print(f\"Freebucks: spent={day.get('spent')} remaining={day.get('remaining')}/{day.get('limit')} reset={day.get('resetAt')}\")
print('prices (FB/hr): ' + ', '.join(f\"{k.split('/')[-1]}={v}\" for k,v in (fb.get('prices') or {}).items()))
fw=d.get('freeWindows') or {}
print(f\"free windows: day {fw.get('dayUsed')}/{fw.get('dayLimit')}, week {fw.get('weekUsed')}/{fw.get('weekLimit')}\")
for m,v in (d.get('rateLimitsByModel') or {}).items():
    print(f\"  premium {m}: {v.get('recentCount')}/{v.get('limit')} used\")
"
