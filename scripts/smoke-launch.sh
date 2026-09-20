#!/usr/bin/env bash
# Does `npm start` actually put a window on screen?
#
# scripts/smoke-extensions.js builds its window directly, so it cannot catch a broken entry
# path — and one existed: `if (require.main === module) main()` is always false in Electron's
# main process, so the app started, opened nothing, and reported no error.
#
# This launches the app exactly as npm start does, then asks Chromium itself what it is
# rendering. It uses a throwaway profile, so a real Onshape session is untouched.
set -uo pipefail

cd "$(dirname "$0")/.."
source scripts/env-repair.sh

# A fresh port per run: a leftover instance holding a fixed port would answer for us, and
# the test would pass while proving nothing.
PORT=${SMOKE_PORT:-$((9300 + RANDOM % 500))}
PROFILE="$PWD/dist/smoke-launch/profile"
LOG="$PWD/dist/smoke-launch/electron.log"
mkdir -p "$PROFILE"
: > "$LOG"

if ss -ltn 2>/dev/null | grep -q ":$PORT "; then
  echo "FAIL: port $PORT is already in use; cannot trust this run" >&2
  exit 1
fi

# The Electron binary directly, not `npx electron`: killing npx leaves the real process
# orphaned, and successive runs then pile up.
ELECTRON_BIN=$(node -p "require('electron')")
"$ELECTRON_BIN" . --remote-debugging-port="$PORT" --user-data-dir="$PROFILE" >"$LOG" 2>&1 &
pid=$!
cleanup() {
  kill -TERM $pid 2>/dev/null
  for _ in $(seq 1 10); do sleep 1; ps -p $pid >/dev/null 2>&1 || return; done
  kill -9 $pid 2>/dev/null
}
trap cleanup EXIT

targets=''
for _ in $(seq 1 30); do
  sleep 1
  targets=$(curl -s --max-time 2 "http://127.0.0.1:$PORT/json/list" || true)
  [[ "$targets" == *toolbar.html* ]] && break
done

fail=0
check() { # description pattern
  if [[ "$targets" == *"$2"* ]]; then echo "PASS: $1"; else echo "FAIL: $1"; fail=1; fi
}
check "the toolbar view is rendering" "toolbar.html"
check "the popover view is rendering" "popover.html"
check "the content view loaded Onshape" "cad.onshape.com"

if [ "$fail" -ne 0 ]; then
  echo "--- targets seen ---"
  echo "${targets:-(no response from the debugger port — the app rendered nothing)}" | grep -o '"url": "[^"]*"' | sort -u
  echo "--- last log lines ---"
  tail -15 "$LOG"
  exit 1
fi
echo "LAUNCH SMOKE: PASS"
