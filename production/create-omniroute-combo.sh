#!/usr/bin/env bash
# Wire freebuff2api into REAL OmniRoute + create the never-stop-coding combo.
#
# Verified against OmniRoute 3.7.9 (npm, live runtime test) + 3.8.x route
# sources and dashboard calls. Fully non-interactive and idempotent:
# re-running reuses the existing node/connection and rebuilds the combo.
#
# Usage:
#   export OMNIROUTE_BASE_URL=http://127.0.0.1:20128
#   export OMNIROUTE_MANAGE_KEY="<dashboard API key with the manage scope>"
#   export FREEBUFF2API_BASE_URL=http://127.0.0.1:8787   # optional
#   export ROUTER_KEY="<only if your freebuff2api requires auth>"  # optional
#   export SUB_MODELS="cc/model-a,cx/model-b"            # optional override
#   ./create-omniroute-combo.sh
#
# Prerequisites:
#   1. OmniRoute running (npm install -g omniroute → omniroute → :20128).
#      Needs Node 22.22+ or 24+ (Next.js 16; Node 20 breaks all API routes).
#   2. freebuff2api running (see setup-freebuff2api.sh → :8787).
#   3. Your subscription providers connected (Dashboard → Providers).
set -euo pipefail

BASE="${OMNIROUTE_BASE_URL:-http://127.0.0.1:20128}"
MANAGE="${OMNIROUTE_MANAGE_KEY:-}"
FB="${FREEBUFF2API_BASE_URL:-http://127.0.0.1:8787}"
APIKEY="${ROUTER_KEY:-sk-no-key-required}"
COMBO_NAME="never-stop-coding"
NODE_NAME="freebuff"
CONN_NAME="freebuff-conn"

if [ -z "$MANAGE" ]; then
  echo "❌ Set OMNIROUTE_MANAGE_KEY first (Dashboard → API Keys → key with 'manage' scope)." >&2
  exit 1
fi

AUTH=(-H "Authorization: Bearer $MANAGE")
api() { curl -sf --max-time 30 "$@" ; }

echo "── 0/6 Sanity checks ──"
api "$BASE/api/monitoring/health" >/dev/null \
  && echo "✅ OmniRoute reachable at $BASE" \
  || { echo "❌ OmniRoute not reachable at $BASE"; exit 1; }
api "$FB/health" >/dev/null \
  && echo "✅ freebuff2api reachable at $FB" \
  || { echo "❌ freebuff2api not reachable. Run production/setup-freebuff2api.sh first."; exit 1; }

echo
echo "── 1/6 Provider node (freebuff2api as OpenAI-compatible endpoint) ──"
NODE_ID="$(api "$BASE/api/provider-nodes" "${AUTH[@]}" | python3 -c "
import json,sys
for n in json.load(sys.stdin).get('nodes', []):
    if n.get('name') == '$NODE_NAME':
        print(n['id']); break
" 2>/dev/null || true)"
if [ -n "$NODE_ID" ]; then
  echo "✅ Reusing existing node '$NODE_NAME' ($NODE_ID)"
else
  NODE_ID="$(api -X POST "$BASE/api/provider-nodes" "${AUTH[@]}" \
    -H "Content-Type: application/json" \
    -d "{\"type\":\"openai-compatible\",\"name\":\"$NODE_NAME\",\"prefix\":\"fb\",\"apiType\":\"chat\",\"baseUrl\":\"$FB/v1\"}" \
    | python3 -c "import json,sys; print(json.load(sys.stdin)['node']['id'])")"
  echo "✅ Node created: $NODE_ID (baseUrl $FB/v1)"
fi

echo
echo "── 2/6 Provider connection (credential for the node) ──"
CONN_OK="$(api "$BASE/api/providers" "${AUTH[@]}" | python3 -c "
import json,sys
print('yes' if any(c.get('name') == '$CONN_NAME' for c in json.load(sys.stdin).get('connections', [])) else 'no')
" 2>/dev/null || echo unknown)"
if [ "$CONN_OK" = "yes" ]; then
  echo "✅ Reusing existing connection '$CONN_NAME'"
else
  api -X POST "$BASE/api/providers" "${AUTH[@]}" \
    -H "Content-Type: application/json" \
    -d "{\"provider\":\"$NODE_ID\",\"name\":\"$CONN_NAME\",\"url\":\"$FB/v1\",\"apiKey\":\"$APIKEY\",\"isActive\":true}" >/dev/null
  echo "✅ Connection '$CONN_NAME' created on node $NODE_ID"
fi

echo
echo "── 3/6 FreeBuff model targets (cheapest-first) ──"
# OmniRoute combo targets for node models use "<nodeId>/<upstreamModelId>".
# (The 'fb/' prefix is display-only.) Freebucks/hr, charged once per session:
#   5: glm-5.3-flash, kimi-k3-eco · 10: mimo, solar-pro4
#  15: deepseek-v4-flash, muse-spark · 20: luna · 50: gemini-3.8-flash
FB_TARGETS="$(api "$FB/v1/models" | python3 -c "
import json, sys
ids = [m['id'] for m in json.load(sys.stdin).get('data', [])]
price = [('glm-5.3-flash',0),('kimi-k3-eco',1),('mimo',2),('solar',3),
         ('deepseek-v4-flash',4),('muse-spark',5),('luna',6),('gemini',7)]
def rank(i):
    l = i.lower()
    for pat, r in price:
        if pat in l: return r
    return 8
for i in sorted(ids, key=rank):
    print('$NODE_ID/' + i)
")"
echo "$FB_TARGETS" | sed 's/^/     - /'

echo
echo "── 4/6 Creating combo '$COMBO_NAME' (strategy: priority) ──"
WANT_SUBS="${SUB_MODELS:-cc/claude-opus-4-6,cc/claude-sonnet-4-5-20250929,cx/gpt-5.2-codex,glm/glm-4.7,minimax/MiniMax-M2.1}"
CATALOG="$(api "$BASE/v1/models" "${AUTH[@]}" || echo '{"data":[]}')"
# NOTE: node models never appear in /v1/models (only combos + managed-provider
# models do) — so subscription ids are filtered against the catalog, while
# FreeBuff targets (built in step 3) are always kept.
MODELS_JSON="$(python3 - "$CATALOG" "$WANT_SUBS" "$FB_TARGETS" <<'PY'
import json, sys
ids = {m.get('id') for m in json.loads(sys.argv[1]).get('data', [])}
out = []
for w in sys.argv[2].split(','):
    w = w.strip()
    if not w:
        continue
    if w in ids:
        out.append(w)
    else:
        print(f"  ⏭️  skipping {w} (not in catalog — connect that provider to enable it)", file=sys.stderr)
for t in sys.argv[3].splitlines():
    if t.strip():
        out.append(t.strip())
print(json.dumps(out))
PY
)"
echo "Combo chain:"
echo "$MODELS_JSON" | python3 -c "import json,sys; [print('     %d. %s'%(i+1,m)) for i,m in enumerate(json.load(sys.stdin))]"
EXISTING_ID="$(api "$BASE/api/combos" "${AUTH[@]}" | python3 -c "
import json,sys
for c in json.load(sys.stdin).get('combos', []):
    if c.get('name') == '$COMBO_NAME':
        print(c['id']); break
" 2>/dev/null || true)"
if [ -n "$EXISTING_ID" ]; then
  api -X DELETE "$BASE/api/combos/$EXISTING_ID" "${AUTH[@]}" >/dev/null \
    && echo "   (replaced existing combo $EXISTING_ID)"
fi
api -X POST "$BASE/api/combos" "${AUTH[@]}" \
  -H "Content-Type: application/json" \
  -d "$(python3 -c "import json,sys; print(json.dumps({'name':'$COMBO_NAME','strategy':'priority','models':json.loads(sys.argv[1]),'config':{}}))" "$MODELS_JSON")" >/dev/null
echo "✅ Combo '$COMBO_NAME' created (priority failover, top to bottom)"

echo
echo "── 5/6 Minting API key for the agent loop ──"
CHAT_KEY="$(api -X POST "$BASE/api/keys" "${AUTH[@]}" \
  -H "Content-Type: application/json" \
  -d '{"name":"autonomous-agent-loop"}' \
  | python3 -c "import json,sys; print(json.load(sys.stdin).get('key',''))" 2>/dev/null || true)"
if [ -n "$CHAT_KEY" ]; then
  echo "✅ Add to .env:"
  echo "   OMNIROUTE_CHAT_KEY=\"$CHAT_KEY\""
  echo "   AGENT_MODEL=\"$COMBO_NAME\""
else
  echo "⚠️  Key minting failed — mint one in Dashboard → API Keys and retry."
fi

echo
echo "── 6/6 Smoke test ──"
api -X POST "$BASE/v1/chat/completions" \
  -H "Authorization: Bearer ${CHAT_KEY:-$MANAGE}" \
  -H "Content-Type: application/json" \
  -d "{\"model\":\"$COMBO_NAME\",\"messages\":[{\"role\":\"user\",\"content\":\"Reply with exactly: ROUTE_OK\"}],\"max_tokens\":16,\"stream\":false}" \
  | head -c 500; echo
echo
echo "Done. Point your agent loop at:"
echo "  Base URL: $BASE/v1   Model: $COMBO_NAME"
