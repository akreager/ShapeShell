#!/usr/bin/env bash
# Runs an Electron script from the repo with the environment repairs npm start applies.
set -euo pipefail

cd "$(dirname "$0")/.."
source scripts/env-repair.sh

exec npx electron "$@"
