#!/usr/bin/env bash
# End-to-end demo: mocks + mini-gateway + autonomous agent loop.
# No API keys, no network, no Bun needed — pure Node 20+.
set -euo pipefail
cd "$(dirname "$0")"

# Fresh run (comment out to test resume-from-state instead)
rm -rf workspace/out workspace/state.json workspace/PROGRESS.md
mkdir -p workspace/out

echo "── starting mock providers ──"
node mock-subscriptions.mjs > /tmp/demo-subs.log 2>&1 &
SUBS_PID=$!
node mock-freebuff2api.mjs > /tmp/demo-fb.log 2>&1 &
FB_PID=$!
node mini-gateway.mjs > /tmp/demo-gw.log 2>&1 &
GW_PID=$!
cleanup() { kill $SUBS_PID $FB_PID $GW_PID 2>/dev/null || true; }
trap cleanup EXIT

echo "── waiting for health ──"
for url in http://127.0.0.1:8891/health http://127.0.0.1:8892/health http://127.0.0.1:8787/health http://127.0.0.1:20128/health; do
  for i in $(seq 1 30); do curl -sf "$url" >/dev/null 2>&1 && break; sleep 0.3; done
  curl -sf "$url" >/dev/null && echo "  ✅ $url" || { echo "  ❌ $url FAILED"; exit 1; }
done

echo
echo "── combo chain ──"
curl -s http://127.0.0.1:20128/api/combos | python3 -c "
import json,sys; c=json.load(sys.stdin)['combos'][0]
print('combo:', c['name'], '| strategy:', c['strategy'])
[print(f\"  {i+1}. {m['model']} [{m['tier']}]\") for i,m in enumerate(c['models'])]"

echo
echo "── running autonomous agent loop ──"
node agent-loop.mjs

echo
echo "── result ──"
echo "--- workspace/PROGRESS.md ---"
cat workspace/PROGRESS.md
echo "--- files produced ---"
ls workspace/out/
