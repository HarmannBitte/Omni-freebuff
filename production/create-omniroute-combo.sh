#!/usr/bin/env bash
# Wire freebuff2api into OmniRoute as the $0 fallback tier + create the
# "never-stop-coding" combo.
#
# Usage:
#   export OMNIROUTE_BASE_URL=http://127.0.0.1:20128
#   export OMNIROUTE_MANAGE_KEY="<key with manage scope>"
#   ./create-omniroute-combo.sh
#
# Prerequisites:
#   1. OmniRoute running  (npx omniroute  → dashboard on :20128)
#   2. freebuff2api running (see setup-freebuff2api.sh → :8787)
#   3. Your subscription providers connected (Dashboard → Providers):
#      Claude Code (cc/*), Codex (cx/*), Gemini CLI, etc.
set -euo pipefail

BASE="${OMNIROUTE_BASE_URL:-http://127.0.0.1:20128}"
MANAGE="${OMNIROUTE_MANAGE_KEY:-}"

if [ -z "$MANAGE" ]; then
  echo "❌ Set OMNIROUTE_MANAGE_KEY first (Dashboard → Endpoints → key with 'manage' scope)." >&2
  exit 1
fi

echo "── 0/4 Sanity checks ──"
curl -sf "$BASE/v1/models" -H "Authorization: Bearer $MANAGE" >/dev/null \
  && echo "✅ OmniRoute reachable at $BASE" \
  || { echo "❌ OmniRoute not reachable at $BASE"; exit 1; }
curl -sf http://127.0.0.1:8787/health >/dev/null \
  && echo "✅ freebuff2api reachable at 127.0.0.1:8787" \
  || { echo "❌ freebuff2api not reachable. Run production/setup-freebuff2api.sh first."; exit 1; }

echo
echo "── 1/4 Add freebuff2api as a custom OpenAI-compatible provider ──"
echo "   (Dashboard step — the local-provider connect payload is UI-driven)"
echo
echo "   1. Open  $BASE/dashboard  → Providers"
echo "   2. Pick any LOCAL OpenAI-compatible slot you are NOT otherwise using,"
echo "      e.g. 'llama.cpp' (alias: llamacpp). It accepts a custom base URL."
echo "   3. Set Base URL →  http://127.0.0.1:8787/v1"
echo "      API key     →  your ROUTER_KEY (or anything, e.g. sk-no-key-required,"
echo "                       if the router is open)"
echo "   4. Connect, then Available Models → 'Import from /models' (or Auto-Sync)."
echo "      You should see: deepseek-v4-flash, mimo, deepseek-v4-pro, minimax-m3…"
echo
echo "   👉 Press ENTER once the models are imported."
read -r _

echo
echo "── 2/4 Discovering imported freebuff models ──"
# List models and pick the ones served under the repurposed local slot.
# Try common local aliases in order; use the first that yields models.
CANDIDATE_PREFIXES="llamacpp lmstudio ollama ooba vllm"
FREEBBUFF_MODELS=""
SLOT=""
for p in $CANDIDATE_PREFIXES; do
  IDS="$(curl -s "$BASE/v1/models?prefix=alias" -H "Authorization: Bearer $MANAGE" \
    | python3 -c "
import json,sys
d=json.load(sys.stdin)
for m in d.get('data',[]):
    i=m.get('id','')
    if i.startswith('$p/'): print(i)
" 2>/dev/null)"
  if [ -n "$IDS" ]; then SLOT="$p"; FREEBBUFF_MODELS="$IDS"; break; fi
done

if [ -z "$FREEBBUFF_MODELS" ]; then
  echo "⚠️  No models found under local slots ($CANDIDATE_PREFIXES)."
  echo "   Did the import finish? You can re-run this script after importing."
  echo "   Continuing with subscription+cheap tiers only…"
else
  echo "✅ Using slot '$SLOT':"
  echo "$FREEBBUFF_MODELS" | sed 's/^/     - /'
fi

echo
echo "── 3/4 Creating combo 'never-stop-coding' (strategy: priority) ──"
# Tier order = failover order. OmniRoute fails over on transient errors
# (429 rate-limit incl. 5h subscription caps, timeouts, 5xx).
# NOTE: adjust the subscription/cheap model ids to what YOU connected.
# This script keeps only ids that actually exist in your catalog.
WANT_ORDER=(
  "cc/claude-opus-4-6"
  "cc/claude-sonnet-4-5-20250929"
  "cx/gpt-5.2-codex"
  "glm/glm-4.7"
  "minimax/MiniMax-M2.1"
)
if [ -n "$FREEBBUFF_MODELS" ]; then
  # Cheapest-first so the 100 Freebucks/day stretch furthest.
  # Prices observed 2026-09-16 (FB/hr, charged once per session start):
  #   5: glm-5.3-flash, kimi-k3-eco · 10: mimo, solar-pro4
  #  15: deepseek-v4-flash, muse-spark · 20: luna · 50: gemini-3.8-flash
  while read -r m; do [ -n "$m" ] && WANT_ORDER+=("$m"); done <<EOF
$(for pat in "glm-5.3-flash" "kimi-k3-eco" "mimo" "solar" "deepseek-v4-flash" "muse-spark" "luna" "gemini"; do echo "$FREEBBUFF_MODELS" | grep -i "$pat" || true; done)
$(echo "$FREEBBUFF_MODELS" | grep -i -v -E "glm-5.3-flash|kimi-k3-eco|mimo|solar|deepseek-v4-flash|muse-spark|luna|gemini" || true)
EOF
fi

CATALOG="$(curl -s "$BASE/v1/models?prefix=alias" -H "Authorization: Bearer $MANAGE")"
MODELS_JSON="$(python3 - "$CATALOG" "${WANT_ORDER[@]}" <<'PY'
import json,sys
catalog=json.loads(sys.argv[1])
ids={m.get('id') for m in catalog.get('data',[])}
out=[]
for w in sys.argv[2:]:
    if w in ids: out.append({"model": w})
    else: print(f"  ⏭️  skipping {w} (not in catalog — connect that provider to enable it)", file=sys.stderr)
print(json.dumps(out))
PY
)"
echo "Combo chain:"
echo "$MODELS_JSON" | python3 -c "import json,sys; [print('     %d. %s'%(i+1,m['model'])) for i,m in enumerate(json.load(sys.stdin))]"

COMBO_RESP="$(curl -s -X POST "$BASE/api/combos" \
  -H "Authorization: Bearer $MANAGE" \
  -H "Content-Type: application/json" \
  -d "$(python3 -c "import json,sys; print(json.dumps({'name':'never-stop-coding','strategy':'priority','models':json.loads(sys.argv[1])}))" "$MODELS_JSON")")"
echo "API response: $COMBO_RESP" | head -c 600; echo

echo
echo "── 4/4 Minting chat-scoped key for the agent loop ──"
KEY_RESP="$(curl -s -X POST "$BASE/api/keys" \
  -H "Authorization: Bearer $MANAGE" \
  -H "Content-Type: application/json" \
  -d '{"name":"autonomous-agent-loop","scopes":["chat"]}')"
echo "$KEY_RESP" | head -c 600; echo
CHAT_KEY="$(echo "$KEY_RESP" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('key') or d.get('apiKey') or d.get('token') or '')" 2>/dev/null || true)"
if [ -n "$CHAT_KEY" ]; then
  echo
  echo "✅ Add to .env:"
  echo "   OMNIROUTE_CHAT_KEY=\"$CHAT_KEY\""
  echo "   AGENT_MODEL=\"never-stop-coding\""
fi

echo
echo "── Smoke test ──"
curl -s "$BASE/v1/chat/completions" \
  -H "Authorization: Bearer ${CHAT_KEY:-$MANAGE}" \
  -H "Content-Type: application/json" \
  -d '{"model":"never-stop-coding","messages":[{"role":"user","content":"Reply with exactly: ROUTE_OK"}],"max_tokens":16}' \
  | head -c 800; echo
echo
echo "Done. Point your agent loop at:"
echo "  Base URL: $BASE/v1   Model: never-stop-coding"
