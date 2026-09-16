#!/usr/bin/env bash
# Production setup: FreeBuff login → freebuff2api router on 127.0.0.1:8787
#
# Prerequisites: Node 20+, curl. Bun is required by freebuff2api
# (it uses Bun.serve) — this script installs it if missing.
set -euo pipefail

echo "── 1/4 Checking runtimes ──"
node --version
if ! command -v bun >/dev/null 2>&1; then
  echo "Installing bun (required by freebuff2api)..."
  curl -fsSL https://bun.sh/install | bash
  export BUN_INSTALL="$HOME/.bun"
  export PATH="$BUN_INSTALL/bin:$PATH"
fi
bun --version

echo "── 2/4 Installing freebuff CLI (for login) ──"
npm install -g freebuff
echo
echo "👉 Now run 'freebuff' and approve the browser login."
echo "   Press ENTER once you've logged in."
read -r _

echo "── 3/4 Extracting token ──"
./extract-freebuff-token.sh
echo
echo "👉 Export FREEBUFF_TOKEN as shown above, then press ENTER."
read -r _
if [ -z "${FREEBUFF_TOKEN:-}" ]; then
  echo "⚠️  FREEBUFF_TOKEN is not set in this shell. Export it before step 4."
  echo "   Example: export FREEBUFF_TOKEN=\"...\""
  exit 1
fi

echo "── 4/4 Starting freebuff2api (127.0.0.1:8787) ──"
echo "Config: ./router.config.json"
echo "Health: curl http://127.0.0.1:8787/health"
echo
bunx freebuff2api
