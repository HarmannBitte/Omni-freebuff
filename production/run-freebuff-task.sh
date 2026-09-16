#!/usr/bin/env bash
# Headless FreeBuff CLI task runner — the attempt-4 recipe.
#
# Lesson learned (3 failed attempts, 2026-09-16): the TUI boots into a model
# picker and only joins the session ~55s in. Typing before the compose box
# is focused gets swallowed. So input is STAGED:
#   T+20s  Enter ......... confirm default model in picker
#   ~T+55s session joins (observed; nothing to do but wait)
#   T+75s  prompt + Enter  typed into the focused compose box
#   +30s×3 Enter ......... approve run-command / permission prompts
#   end    Ctrl-C twice .. clean exit ("press again to exit")
#
# Preflight aborts (exit 3, NO_BUDGET) when balance < cheapest session (5 FB),
# so this script can never surprise-spend. Postflight reports spend + files.
#
# Usage:
#   ./run-freebuff-task.sh "Create hello.mjs that prints X and run it" [workdir]
#
# Needs: freebuff binary on PATH or FREEBUFF_BIN set, credentials from
# `freebuff login`, python3 (pyte optional, for readable screen dumps).
set -euo pipefail

PROMPT_TEXT="${1:?Usage: $0 \"<task prompt>\" [workdir]}"
WORKDIR="${2:-$HOME/.fb-task}"
FREEBUFF_BIN="${FREEBUFF_BIN:-$(command -v freebuff || echo "$HOME/.fb-cli/node_modules/.bin/freebuff")}"
LOG="${LOG:-/tmp/fb-task.log}"

CRED="$HOME/.config/manicode/credentials.json"
[ -f "$CRED" ] || { echo "❌ No $CRED — run 'freebuff login' first." >&2; exit 1; }
[ -x "$FREEBUFF_BIN" ] || { echo "❌ freebuff binary not executable: $FREEBUFF_BIN" >&2; exit 1; }
TOKEN="$(python3 -c "import json; print(json.load(open('$CRED'))['default']['authToken'])")"

session_json() {
  curl -s --max-time 25 https://www.codebuff.com/api/v1/freebuff/session \
    -H "Authorization: Bearer $TOKEN"
}
spent_of() { echo "$1" | python3 -c "import json,sys; print(json.load(sys.stdin)['freebucks']['daily']['spent'])"; }
remaining_of() { echo "$1" | python3 -c "import json,sys; print(json.load(sys.stdin)['freebucks']['daily']['remaining'])"; }

echo "── preflight ──"
BEFORE_JSON="$(session_json)"
echo "spent/remaining: $(spent_of "$BEFORE_JSON")/$(remaining_of "$BEFORE_JSON")"
if [ "$(remaining_of "$BEFORE_JSON")" -lt 5 ]; then
  echo "❌ NO_BUDGET: <5 FB remaining, aborting (nothing spent)." >&2
  exit 3
fi

mkdir -p "$WORKDIR"
FIFO="$(mktemp -u /tmp/fb-task-in.XXXXXX)"; mkfifo "$FIFO"
( sleep 20;  printf '\n'
  sleep 55;  printf '%s\n' "$PROMPT_TEXT"
  for _ in 1 2 3; do sleep 30; printf '\n'; done
  printf '\x03'; sleep 2; printf '\x03'; sleep 2 ) > "$FIFO" 2>/dev/null &
WRITER_PID=$!

echo "── running (log: $LOG) ──"
timeout 220 script -qec "$FREEBUFF_BIN --cwd $WORKDIR" /dev/null < "$FIFO" > "$LOG" 2>&1
APP_EXIT=$?
kill "$WRITER_PID" 2>/dev/null || true; rm -f "$FIFO"
echo "app exit: $APP_EXIT"

echo "── postflight ──"
AFTER_JSON="$(session_json)"
echo "spent before/after: $(spent_of "$BEFORE_JSON")/$(spent_of "$AFTER_JSON")"
echo "--- new/changed files in $WORKDIR ---"
ls -lat "$WORKDIR" | head -n 12
echo "--- final screen ---"
if python3 -c "import pyte" 2>/dev/null; then
  python3 - "$LOG" <<'PY'
import pyte, re, sys
raw = open(sys.argv[1], 'rb').read().decode('utf-8', 'replace')
clean = re.sub(r'\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)', '', raw)
screen = pyte.Screen(160, 60); pyte.Stream(screen).feed(clean)
for line in screen.display:
    if line.strip(): print(line.rstrip()[:155])
PY
else
  echo "(install pyte for screen dumps: pip install pyte)"
  tail -c 1500 "$LOG"
fi
