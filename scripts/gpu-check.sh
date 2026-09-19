#!/usr/bin/env bash
# Milestone 1 acceptance gate: a positive run plus a mandatory negative control.
# Without the negative control the gate can silently rot into a no-op.
set -uo pipefail

cd "$(dirname "$0")/.."

source scripts/env-repair.sh

echo "=== positive run (expect PASS) ==="
GPU_CHECK_TAG=hardware npx electron scripts/gpu-check.js >/tmp/gpu-check-pos.log 2>/tmp/gpu-check-pos.err
pos=$?
tail -5 /tmp/gpu-check-pos.log

echo
echo "=== negative control: --disable-gpu (expect FAIL) ==="
GPU_CHECK_TAG=disabled-gpu npx electron scripts/gpu-check.js --disable-gpu >/tmp/gpu-check-neg.log 2>/tmp/gpu-check-neg.err
neg=$?
tail -5 /tmp/gpu-check-neg.log

echo
for f in /tmp/gpu-check-pos.err /tmp/gpu-check-neg.err; do
  if grep -qiE 'GPU process (has crashed|exited unexpectedly|failed to initialize)' "$f"; then
    echo "WARNING: GPU process instability in $f" >&2
    grep -iE 'GPU process (has crashed|exited unexpectedly|failed to initialize)' "$f" >&2
  fi
done
if grep -qiE 'swiftshader|llvmpipe' /tmp/gpu-check-pos.log; then
  echo "FAIL: software renderer mentioned in the positive run" >&2
  exit 1
fi

echo "positive run exit=$pos (want 0), negative control exit=$neg (want non-zero)"
if [ "$pos" -eq 0 ] && [ "$neg" -ne 0 ]; then
  echo "GATE: PASS — hardware WebGL confirmed, and the gate proves it can still fail."
  exit 0
fi
echo "GATE: FAIL" >&2
exit 1
